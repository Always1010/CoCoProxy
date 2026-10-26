import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, unlink } from 'node:fs/promises';
import { posix } from 'node:path';
import { assertDeploymentExecutable, assertDeploymentLifecycle, assertDeploymentStopped, assertPrivateDeploymentFile,
  assertRootPath, deploymentPathInfo, deploymentProcessIdentity, parseDeploymentLock, readRegularDeploymentFile,
  runDeploymentTool, writeAtomicDeploymentFile, type DeploymentLock } from '../deployment/install.ts';
import { deploymentOwnerGone, loadInstalledDeployment } from '../deployment/maintenance.ts';
import { createAdminCredential, parseAdminCredential } from '../management/auth.ts';
import { verifyManagedWeb } from './https.ts';

export type SetupLifecycleAction = 'initialize' | 'start-management' | 'enable-persistence' | 'pause-maintenance' | 'stop-maintenance' | 'resume-persistence';
export type SetupLifecycleOptions = { input: string; action: SetupLifecycleAction; apply?: boolean; reviewedPlanSha256?: string;
  adminInput?: string; routerDisabled?: boolean; terminalPathVerified?: boolean };
export class SetupLifecycleError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.name = 'SetupLifecycleError'; this.code = code; }
}
const STORE = '/var/lib/cocoproxy-deployment', LOCK = STORE + '/install.lock', JOURNAL = STORE + '/lifecycle.json';
const HASH = /^[a-f0-9]{64}$/, UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const actions: SetupLifecycleAction[] = ['initialize', 'start-management', 'enable-persistence', 'pause-maintenance', 'stop-maintenance', 'resume-persistence'];
const digest = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
function need(value: unknown, code: string): asserts value { if (!value) throw new SetupLifecycleError(code); }
export type LifecycleStep = { id: string; kind: 'command' | 'credential' | 'verify-stopped'; binary?: string; args?: string[] };
export type LifecycleContext = { runtime: { nodePath: string; systemctlPath: string; sourceDirectory: string; stateDirectory: string; settingsPath: string };
  serviceUser: string; gateway: boolean; managedWeb: boolean; credentialExists: boolean; networkReceipt: 'absent' | 'complete' | 'removed';
  lifecycle: { enabled: boolean; paused: boolean } };

/** Fixed operations only. Router/terminal flags record operator evidence, not a network probe. */
export function planSetupLifecycle(options: Pick<SetupLifecycleOptions, 'action' | 'routerDisabled' | 'terminalPathVerified'>, context: LifecycleContext): LifecycleStep[] {
  need(actions.includes(options.action), 'SETUP_LIFECYCLE_ACTION_INVALID');
  const steps: LifecycleStep[] = [];
  const command = (id: string, binary: string, args: string[]) => steps.push({ id, kind: 'command', binary, args });
  const systemctl = (id: string, verb: string, units: string[]) => command(id, context.runtime.systemctlPath, [verb, ...units]);
  const runtime = (verb: string) => command(verb, '/usr/sbin/runuser', ['-u', context.serviceUser, '--', context.runtime.nodePath,
    '--experimental-strip-types', context.runtime.sourceDirectory + '/apps/cli/main.ts', verb,
    '--state-dir', context.runtime.stateDirectory, '--runtime-settings', context.runtime.settingsPath]);
  const management = ['cocoproxy-management.service', ...(context.managedWeb ? ['cocoproxy-web.service'] : [])];
  if (options.action === 'initialize') {
    if (!context.credentialExists) steps.push({ id: 'create-credential', kind: 'credential' });
  } else if (options.action === 'start-management') {
    need(!context.lifecycle.enabled || context.lifecycle.paused, 'SETUP_LIFECYCLE_PAUSE_REQUIRED');
    need(context.credentialExists, 'SETUP_ADMIN_INITIALIZATION_REQUIRED');
    systemctl('start-management', 'start', management);
  } else if (options.action === 'enable-persistence' || options.action === 'resume-persistence') {
    need(options.terminalPathVerified === true, 'SETUP_TERMINAL_PATH_CONFIRMATION_REQUIRED');
    need(context.credentialExists, 'SETUP_ADMIN_INITIALIZATION_REQUIRED');
    if (options.action === 'resume-persistence') need(context.lifecycle.enabled, 'SETUP_LIFECYCLE_NOT_ENABLED');
    if (context.gateway) systemctl('start-early-guard', 'start', ['cocoproxy-gateway-guard.service']);
    systemctl('enable-management', 'enable', [...(context.gateway ? ['cocoproxy-gateway-guard.service'] : []), ...management]);
    systemctl('start-management', 'start', management);
    runtime(options.action === 'enable-persistence' ? 'runtime-enable' : 'runtime-resume');
  } else {
    runtime('runtime-pause');
    if (options.action === 'stop-maintenance') {
      need(!context.gateway || options.routerDisabled === true, 'SETUP_ROUTER_DISABLED_CONFIRMATION_REQUIRED');
      const stopped = [...(context.managedWeb ? ['cocoproxy-web.service'] : []), 'cocoproxy-management.service', 'cocoproxy-mihomo.service',
        ...(context.gateway ? ['cocoproxy-gateway-network.service', 'cocoproxy-gateway-guard.service'] : [])];
      systemctl('stop-services', 'stop', stopped);
      // Network oneshot has no Install section. Disable only units with enable intent.
      systemctl('disable-services', 'disable', [...management, 'cocoproxy-mihomo.service', ...(context.gateway ? ['cocoproxy-gateway-guard.service'] : [])]);
      steps.push({ id: 'verify-stopped', kind: 'verify-stopped' });
      if (context.gateway && context.networkReceipt === 'complete') command('remove-owned-network', '/usr/bin/python3', ['-I',
        context.runtime.sourceDirectory + '/apps/gateway/network.py', 'remove', '--settings', posix.dirname(context.runtime.settingsPath) + '/gateway-network.json']);
    }
  }
  return steps;
}

/** Intent is persisted before each external action; failed actions never become completed steps. */
export async function executeSetupLifecycleSteps(steps: readonly LifecycleStep[], dependencies: {
  before(step: LifecycleStep): Promise<void>; execute(step: LifecycleStep): Promise<void>; after(step: LifecycleStep): Promise<void>;
}) {
  for (const step of steps) { await dependencies.before(step); await dependencies.execute(step); await dependencies.after(step); }
}

type Journal = { schemaVersion: 1; id: string; baseSha256: string; action: SetupLifecycleAction; status: 'pending' | 'complete';
  completed: string[]; pendingStep: string | null; credentialSha256?: string };
const actionSteps: Record<SetupLifecycleAction, readonly string[]> = {
  initialize: ['create-credential'], 'start-management': ['start-management'],
  'enable-persistence': ['start-early-guard', 'enable-management', 'start-management', 'runtime-enable'],
  'resume-persistence': ['start-early-guard', 'enable-management', 'start-management', 'runtime-resume'],
  'pause-maintenance': ['runtime-pause'],
  'stop-maintenance': ['runtime-pause', 'stop-services', 'disable-services', 'verify-stopped', 'remove-owned-network'],
};
function parseJournal(value: unknown): Journal {
  const j = value as Journal;
  need(j && typeof j === 'object' && !Array.isArray(j) && j.schemaVersion === 1 && UUID.test(j.id) && HASH.test(j.baseSha256) &&
    Object.keys(j).every(key => ['schemaVersion', 'id', 'baseSha256', 'action', 'status', 'completed', 'pendingStep', 'credentialSha256'].includes(key)) &&
    actions.includes(j.action) && ['pending', 'complete'].includes(j.status) && Array.isArray(j.completed) && j.completed.length <= 16 &&
    new Set(j.completed).size === j.completed.length && j.completed.every(step => actionSteps[j.action].includes(step)) &&
    (j.pendingStep === null || actionSteps[j.action].includes(j.pendingStep)) &&
    (j.credentialSha256 === undefined || HASH.test(j.credentialSha256)), 'SETUP_LIFECYCLE_JOURNAL_INVALID');
  return j;
}
async function readPrivateRoot(path: string, limit: number) {
  await assertRootPath(path); await assertPrivateDeploymentFile(path, 0);
  return readRegularDeploymentFile(path, limit);
}
async function writeExclusive(path: string, bytes: string, uid = 0) {
  const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(bytes); await handle.chown(uid, 0); await handle.chmod(0o600); await handle.sync(); }
  finally { await handle.close(); }
  const parent = await open(posix.dirname(path), constants.O_RDONLY | constants.O_DIRECTORY);
  try { await parent.sync(); } finally { await parent.close(); }
}
async function serviceState(path: string, uid: number, limit = 65536) {
  await assertRootPath(posix.dirname(posix.dirname(path)));
  const directory = await lstat(posix.dirname(path));
  need(directory.isDirectory() && !directory.isSymbolicLink() && directory.uid === uid && (directory.mode & 0o7777) === 0o700,
    'SETUP_LIFECYCLE_STATE_UNTRUSTED');
  await assertPrivateDeploymentFile(path, uid);
  return readRegularDeploymentFile(path, limit);
}
export function assertSetupLifecycleUnit(output: string, unit: string): void {
  const lines = output.trim().split('\n'), fields = ['LoadState', 'FragmentPath', 'DropInPaths', 'NeedDaemonReload', 'Job', 'ActiveState'];
  const properties = Object.fromEntries(lines.map(line => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)]; }));
  need(lines.length === fields.length && Object.keys(properties).length === fields.length && fields.every(field => Object.hasOwn(properties, field)) &&
    properties.LoadState === 'loaded' && properties.FragmentPath === '/etc/systemd/system/' + unit && !properties.DropInPaths && properties.NeedDaemonReload === 'no' &&
    ['', '0'].includes(properties.Job) && ['active', 'inactive', 'failed'].includes(properties.ActiveState), 'SETUP_LIFECYCLE_UNIT_CONFLICT');
}
async function unitPreflight(systemctl: string, units: string[]) {
  for (const unit of units) {
    const output = await runDeploymentTool(systemctl, ['show', unit, '--property=LoadState,FragmentPath,DropInPaths,NeedDaemonReload,Job,ActiveState']);
    assertSetupLifecycleUnit(output, unit);
    for (const path of ['/etc/systemd/system/' + unit + '.d', '/run/systemd/system/' + unit, '/run/systemd/system/' + unit + '.d']) {
      need(!(await deploymentPathInfo(path)), 'SETUP_LIFECYCLE_UNIT_CONFLICT');
    }
  }
}

export async function runSetupLifecycle(options: SetupLifecycleOptions) {
  need(actions.includes(options.action), 'SETUP_LIFECYCLE_ACTION_INVALID');
  const installed = await loadInstalledDeployment(options.input), { input, receipt } = installed;
  const uid = input.runtime.serviceUid;
  need(options.adminInput === undefined || options.action === 'initialize', 'SETUP_LIFECYCLE_ADMIN_INPUT_INITIALIZE_ONLY');
  const adminBytes = options.adminInput ? await readPrivateRoot(options.adminInput, 16384) : null;
  const baseSha256 = digest(JSON.stringify({ input: digest(installed.inputBytes), receipt: digest(installed.receiptBytes), action: options.action,
    routerDisabled: options.routerDisabled === true, terminalPathVerified: options.terminalPathVerified === true,
    adminInput: adminBytes ? digest(adminBytes) : null }));
  const journalBytes = await deploymentPathInfo(JOURNAL) ? await readPrivateRoot(JOURNAL, 16384) : null;
  const previous = journalBytes ? parseJournal(JSON.parse(journalBytes.toString())) : null;
  const lockBytes = await deploymentPathInfo(LOCK) ? await readPrivateRoot(LOCK, 4096) : null;
  const oldOwner = lockBytes ? parseDeploymentLock(JSON.parse(lockBytes.toString())) : null;
  const continuing = previous?.status === 'pending' || Boolean(previous?.status === 'complete' && oldOwner);
  if (continuing) {
    need(previous!.baseSha256 === baseSha256 && previous!.action === options.action && oldOwner?.id === previous!.id &&
      deploymentOwnerGone(oldOwner, await deploymentProcessIdentity(oldOwner.pid)), 'SETUP_LIFECYCLE_PENDING_REQUIRES_REVIEW');
  } else need(!oldOwner, 'SETUP_LIFECYCLE_DEPLOYMENT_LOCKED');
  need(!(await deploymentPathInfo(STORE + '/recovery.lock')) && !(await deploymentPathInfo(STORE + '/lifecycle-claim.lock')),
    'SETUP_LIFECYCLE_DEPLOYMENT_LOCKED');
  const credentialExists = Boolean(await deploymentPathInfo(input.management.credentialPath));
  await assertRootPath(posix.dirname(input.management.credentialPath));
  let credentialSha256: string | null = null;
  if (credentialExists) {
    await assertPrivateDeploymentFile(input.management.credentialPath, uid);
    const bytes = await readRegularDeploymentFile(input.management.credentialPath, 16384);
    parseAdminCredential(JSON.parse(bytes.toString())); credentialSha256 = digest(bytes);
    if (continuing && options.action === 'initialize') need(credentialSha256 === previous!.credentialSha256, 'SETUP_LIFECYCLE_CREDENTIAL_CHANGED');
  } else if (options.action === 'initialize') {
    need(adminBytes, 'SETUP_ADMIN_INPUT_REQUIRED');
    // Validate the login document before acquiring locks; derived bytes are never written by preview.
    await createAdminCredential(JSON.parse(adminBytes.toString()));
  }
  let lifecycle = { schemaVersion: 1, enabled: false, paused: false };
  const lifecyclePath = input.runtime.stateDirectory + '/lifecycle.json';
  await assertDeploymentLifecycle(input.runtime.stateDirectory, uid, true);
  if (await deploymentPathInfo(lifecyclePath)) lifecycle = JSON.parse((await serviceState(lifecyclePath, uid, 4096)).toString());
  let networkReceipt: LifecycleContext['networkReceipt'] = 'absent';
  if (input.runtime.automaticGateway && ['stop-maintenance', 'enable-persistence', 'resume-persistence'].includes(options.action)) {
    const path = '/var/lib/cocoproxy-gateway-network/network-receipt.json';
    if (await deploymentPathInfo(path)) {
      const record = JSON.parse((await readPrivateRoot(path, 128 * 1024)).toString());
      need(record.schemaVersion === 1 && ['complete', 'removed'].includes(record.status), 'SETUP_NETWORK_RECEIPT_REQUIRES_REVIEW');
      networkReceipt = record.status;
    }
  }
  const context: LifecycleContext = { runtime: input.runtime, serviceUser: input.management.serviceUser,
    gateway: Boolean(input.runtime.automaticGateway), managedWeb: Boolean(input.web), credentialExists, networkReceipt, lifecycle };
  // Re-observe and replay fixed idempotent steps after an interruption. A prior
  // completed marker is never evidence that services remained stopped afterwards.
  const steps = planSetupLifecycle(options, context);
  const units = receipt.files.filter(file => file.path.startsWith('/etc/systemd/system/') && file.path.endsWith('.service')).map(file => posix.basename(file.path));
  await unitPreflight(input.runtime.systemctlPath, units);
  if (steps.some(step => step.binary === '/usr/sbin/runuser')) await assertDeploymentExecutable('/usr/sbin/runuser');
  if (steps.some(step => step.binary === '/usr/bin/python3')) await assertDeploymentExecutable('/usr/bin/python3');
  if (input.web && ['start-management', 'enable-persistence', 'resume-persistence'].includes(options.action)) await verifyManagedWeb({ web: input.web,
    gatewayIPv4: input.runtime.automaticGateway.gatewayIPv4, origin: input.management.origin, listenPort: input.management.listenPort, serviceUid: uid });
  const reviewedPlanSha256 = digest(JSON.stringify({ baseSha256, journal: journalBytes ? digest(journalBytes) : null,
    lock: lockBytes ? digest(lockBytes) : null, credentialSha256, lifecycle, networkReceipt, steps }));
  const result = { action: options.action, apply: Boolean(options.apply), reviewedPlanSha256, continuing: Boolean(continuing),
    steps: steps.map(step => step.id), routerChanged: false, terminalPathEvidence: options.terminalPathVerified === true ? 'operator-confirmed' : 'not-confirmed',
    credential: options.action === 'initialize' ? credentialExists ? 'already-initialized' : options.apply ? 'created' : 'create-without-overwrite' : 'preserved', servicesAssessed: units,
    state: 'preserved-in-place', automaticProgramRollback: false };
  if (!options.apply) return result;
  need(options.reviewedPlanSha256 === reviewedPlanSha256, 'SETUP_LIFECYCLE_PLAN_REVIEW_REQUIRED');
  if (!steps.length && !continuing) return result;
  const identity = await deploymentProcessIdentity(process.pid);
  need(identity.startTime, 'SETUP_LIFECYCLE_PROCESS_IDENTITY_REQUIRED');
  const id = continuing ? previous!.id : randomUUID();
  const owner: DeploymentLock = { schemaVersion: 1, id, pid: process.pid, bootId: identity.bootId, startTime: identity.startTime };
  if (continuing) {
    const claim = STORE + '/lifecycle-claim.lock';
    await writeExclusive(claim, JSON.stringify(owner) + '\n');
    need((await readPrivateRoot(JOURNAL, 16384)).equals(journalBytes!) && (await readPrivateRoot(LOCK, 4096)).equals(lockBytes!), 'SETUP_LIFECYCLE_EVIDENCE_CHANGED');
    need(deploymentOwnerGone(oldOwner!, await deploymentProcessIdentity(oldOwner!.pid)), 'SETUP_LIFECYCLE_OWNER_ALIVE');
    await writeAtomicDeploymentFile(LOCK, JSON.stringify(owner) + '\n', 0o600);
    await unlink(claim);
  } else await writeExclusive(LOCK, JSON.stringify(owner) + '\n');
  const journal: Journal = continuing ? { ...previous!, status: 'pending' } : { schemaVersion: 1, id, baseSha256, action: options.action, status: 'pending', completed: [], pendingStep: null };
  const save = () => writeAtomicDeploymentFile(JOURNAL, JSON.stringify(journal) + '\n', 0o600);
  // From this point any failure retains a recognized pending journal and lock for explicit review.
  await save();
  const current = await loadInstalledDeployment(options.input);
  need(current.inputBytes.equals(installed.inputBytes) && current.receiptBytes.equals(installed.receiptBytes), 'SETUP_LIFECYCLE_EVIDENCE_CHANGED');
  need(!(await deploymentPathInfo(STORE + '/recovery.lock')), 'SETUP_LIFECYCLE_DEPLOYMENT_LOCKED');
  if (adminBytes) need((await readPrivateRoot(options.adminInput!, 16384)).equals(adminBytes), 'SETUP_LIFECYCLE_EVIDENCE_CHANGED');
  if (credentialSha256 !== null) {
    await assertPrivateDeploymentFile(input.management.credentialPath, uid);
    need(digest(await readRegularDeploymentFile(input.management.credentialPath, 16384)) === credentialSha256, 'SETUP_LIFECYCLE_CREDENTIAL_CHANGED');
  }
  if (options.action === 'start-management') await assertDeploymentLifecycle(input.runtime.stateDirectory, uid);
  await unitPreflight(input.runtime.systemctlPath, units);
  await executeSetupLifecycleSteps(steps, {
    before: async step => { journal.pendingStep = step.id; await save(); },
    execute: async step => {
      if (step.kind === 'credential') {
        need(!(await deploymentPathInfo(input.management.credentialPath)), 'SETUP_LIFECYCLE_CREDENTIAL_EXISTS');
        const credential = await createAdminCredential(JSON.parse(adminBytes!.toString()));
        const bytes = JSON.stringify(credential) + '\n';
        journal.credentialSha256 = digest(bytes); await save();
        await writeExclusive(input.management.credentialPath, bytes, uid);
      } else if (step.kind === 'verify-stopped') {
        await assertDeploymentStopped(input.runtime.systemctlPath, units);
        for (const unit of units) need(['', '0'].includes((await runDeploymentTool(input.runtime.systemctlPath,
          ['show', unit, '--property=Job', '--value'])).trim()), 'SETUP_LIFECYCLE_UNIT_BUSY');
        await assertDeploymentLifecycle(input.runtime.stateDirectory, uid);
        if (context.gateway) {
          const path = '/var/lib/cocoproxy-gateway-network/network-receipt.json';
          const observed = await deploymentPathInfo(path) ? JSON.parse((await readPrivateRoot(path, 128 * 1024)).toString()).status : 'absent';
          need(observed === networkReceipt, 'SETUP_NETWORK_RECEIPT_CHANGED');
        }
      } else await runDeploymentTool(step.binary!, step.args!, 90000);
    },
    after: async step => { if (!journal.completed.includes(step.id)) journal.completed.push(step.id); journal.pendingStep = null; await save(); },
  });
  if (['enable-persistence', 'resume-persistence', 'pause-maintenance', 'stop-maintenance'].includes(options.action)) {
    const observed = JSON.parse((await serviceState(lifecyclePath, uid, 4096)).toString());
    need(observed.schemaVersion === 1 && observed.paused === ['pause-maintenance', 'stop-maintenance'].includes(options.action) &&
      (options.action === 'pause-maintenance' || options.action === 'stop-maintenance' || observed.enabled === true), 'SETUP_LIFECYCLE_INTENT_NOT_CONFIRMED');
  }
  journal.status = 'complete'; await save();
  need(parseDeploymentLock(JSON.parse((await readPrivateRoot(LOCK, 4096)).toString())).id === id, 'SETUP_LIFECYCLE_EVIDENCE_CHANGED');
  await unlink(LOCK);
  return result;
}
