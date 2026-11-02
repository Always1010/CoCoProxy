import { createHash, randomUUID } from 'node:crypto';
import { lstat, unlink } from 'node:fs/promises';
import { platform } from 'node:os';
import { posix } from 'node:path';
import { pathToFileURL } from 'node:url';
import { InstallError, validateReceipt, compatibleOwnedFiles, releaseTarget, verifyRelease, verifyRuntimeRelease,
  assertRootPath, assertPrivateDeploymentFile, assertOwnedDeploymentFiles, assertDeploymentStopped,
  assertDeploymentLifecycle, assertDeploymentNetworkClear, assertDeploymentAccount, assertDeploymentExecutable,
  readRegularDeploymentFile, deploymentPathInfo, deploymentProcessIdentity, parseDeploymentLock,
  writeAtomicDeploymentFile, writeExclusiveDeploymentFile, runDeploymentTool, deploymentStateHost,
  assertReleasePaths, type Receipt, type Owned, type DeploymentLock } from './install.ts';
import { deploymentOwnerGone } from './maintenance.ts';
import type { DeploymentPlan } from './plan.ts';

const STORE = '/var/lib/cocoproxy-deployment';
const RECEIPT = STORE + '/receipt.json';
const LOCK = STORE + '/install.lock';
const RECOVERY = STORE + '/recovery.lock';
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
function require(value: unknown, code: string): asserts value { if (!value) throw new InstallError(code); }
export interface RollbackContext {
  previousInput: unknown; previousReceipt: Receipt; manifestSha256: string; preserveRuntime?: boolean;
}
type Prepared = { plan: DeploymentPlan; input: any; usageCompatibility: 'supported' | 'degraded-schema' };

/** Dependencies are injectable for synthetic transaction tests; native callers still require Linux root. */
export interface DeploymentRollbackHost {
  readReceipt(): Promise<{ bytes: Buffer; receipt: Receipt }>;
  lock(): Promise<{ bytes: Buffer; value: DeploymentLock } | null>;
  ownerGone(lock: DeploymentLock): Promise<boolean>;
  prepare(context: RollbackContext, current: Receipt): Promise<Prepared>;
  quiescent(prepared: Prepared, current: Receipt, preserveRuntime: boolean, afterReload?: boolean): Promise<void>;
  exists(path: string): Promise<boolean>;
  owned(files: Owned[]): Promise<void>;
  claim(current: Receipt, existing: { bytes: Buffer; value: DeploymentLock } | null): Promise<Buffer>;
  write(path: string, bytes: string, mode: number, uid?: number): Promise<void>;
  remove(path: string): Promise<void>;
  reload(systemctl: string): Promise<void>;
}

/** A stale installer receipt may contain old/new file mixtures, but never arbitrary drift. */
export async function assertRollbackFiles(previous: Receipt, current: Receipt, host: Pick<DeploymentRollbackHost, 'exists' | 'owned'>) {
  require(compatibleOwnedFiles(previous.files, current.files, true), 'INSTALL_ROLLBACK_FILE_SET_CHANGED');
  for (const file of current.files) {
    const old = previous.files.find(item => item.path === file.path);
    if (!await host.exists(file.path)) {
      require(!old, 'INSTALL_ROLLBACK_OWNED_FILE_MISSING');
      continue;
    }
    try { await host.owned([file]); }
    catch {
      require(old, 'INSTALL_ROLLBACK_OWNED_FILE_CHANGED');
      try { await host.owned([old]); }
      catch { throw new InstallError('INSTALL_ROLLBACK_OWNED_FILE_CHANGED'); }
    }
  }
}

async function verifiedRelease(receipt: Receipt) {
  await assertRootPath(receipt.release);
  await assertRootPath(receipt.release + '/manifest.json');
  const release = await verifyRelease(receipt.release, receipt.manifestSha256);
  await assertReleasePaths(receipt.release, release.files);
  await verifyRuntimeRelease(receipt);
  return release;
}

async function prepareNative(context: RollbackContext, current: Receipt): Promise<Prepared> {
  const previous = context.previousReceipt;
  const release = await verifiedRelease(previous);
  if (current.manifestSha256 !== previous.manifestSha256) await verifiedRelease(current);
  const oldModule = (name: string) => import(pathToFileURL(previous.release + '/source/packages/deployment/' + name + '.ts').href);
  const renderer = await oldModule('plan');
  const plan: DeploymentPlan = renderer.renderDeploymentPlan(context.previousInput);
  const input = context.previousInput as any;
  require(releaseTarget(input, previous.manifestSha256) === previous.release && input.runtime.serviceUid === previous.serviceUid &&
    input.runtime.stateDirectory === previous.stateDirectory && input.management.credentialPath === previous.credentialPath &&
    posix.dirname(input.runtime.sourceDirectory) === posix.join(posix.dirname(previous.release), previous.runtimeManifestSha256 ?? previous.manifestSha256) &&
    plan.files.length === previous.files.length && plan.files.every(file => previous.files.some(old => old.path === file.path &&
      old.mode === file.mode && old.owner === file.owner && old.sensitive === file.sensitive && old.sha256 === digest(file.content))),
  'INSTALL_ROLLBACK_PREVIOUS_PLAN_MISMATCH');
  await assertDeploymentExecutable(input.runtime.nodePath); await assertDeploymentExecutable(input.runtime.systemctlPath);
  await assertDeploymentAccount(input.management.serviceUser, previous.serviceUid);
  await assertRootPath(posix.dirname(previous.credentialPath));
  await assertPrivateDeploymentFile(previous.credentialPath, previous.serviceUid);
  const credential = JSON.parse((await readRegularDeploymentFile(previous.credentialPath, 16384)).toString());
  const host = deploymentStateHost(previous.stateDirectory, previous.serviceUid);
  const readers = await oldModule('upgrade-assessment');
  const inspected = await readers.inspectStateCompatibility(host, release.compatibility);
  const nonUsage = inspected.findings.filter((item: any) => item.store !== 'usage');
  require(nonUsage.every((item: any) => item.contentCompatibility.status === 'supported'), 'INSTALL_ROLLBACK_STATE_INCOMPATIBLE');
  const transaction = inspected.observations.find((item: any) => item.store === 'transaction')?.value;
  const selection = inspected.observations.find((item: any) => item.store === 'selection')?.value;
  require(transaction ? transaction.pending === null && transaction.fault === null &&
    (transaction.active === null ? !selection : selection?.generation === transaction.active) : !selection,
  'INSTALL_ROLLBACK_RUNTIME_RECOVERY_REQUIRED');
  const usage = inspected.findings.find((item: any) => item.store === 'usage');
  let usageCompatibility: Prepared['usageCompatibility'] = 'supported';
  if (usage?.contentCompatibility.status !== 'supported') {
    // The new integrity reader must positively recognize the retained database. Never downgrade or copy it.
    const observed = await host.usage!();
    require(usage?.contentCompatibility.code === 'DEPLOYMENT_STATE_VERSION_UNSUPPORTED' && observed?.integrity === 'ok',
      'INSTALL_ROLLBACK_USAGE_UNVERIFIED');
    usageCompatibility = 'degraded-schema';
  }
  const runtime = JSON.parse(plan.files.find(file => file.path === input.runtime.settingsPath)!.content);
  const management = JSON.parse(plan.files.find(file => file.path === input.management.settingsPath)!.content);
  const assessment = await readers.createUpgradeAssessment({ targetDeclaration: release.compatibility,
    currentRuntime: runtime, targetRuntime: runtime, currentManagement: management, targetManagement: management,
    credential, credentialObserved: true, networkReceipt: { observation: 'absent' } }, host, inspected);
  require(assessment.assessments.historyCandidates.status === 'supported' && assessment.assessments.configuration.status === 'supported' &&
    assessment.assessments.identity.status === 'supported', 'INSTALL_ROLLBACK_STATE_INCOMPATIBLE');
  return { plan, input, usageCompatibility };
}

function nativeHost(): DeploymentRollbackHost {
  return {
    readReceipt: async () => {
      await assertRootPath(STORE);
      require(((await lstat(STORE)).mode & 0o7777) === 0o700, 'INSTALL_RECEIPT_DIRECTORY_PRIVATE_REQUIRED');
      await assertPrivateDeploymentFile(RECEIPT, 0);
      const bytes = await readRegularDeploymentFile(RECEIPT, 128 * 1024);
      return { bytes, receipt: validateReceipt(JSON.parse(bytes.toString())) };
    },
    lock: async () => {
      if (!await deploymentPathInfo(LOCK)) return null;
      await assertPrivateDeploymentFile(LOCK, 0);
      const bytes = await readRegularDeploymentFile(LOCK, 4096);
      return { bytes, value: parseDeploymentLock(JSON.parse(bytes.toString())) };
    },
    ownerGone: async lock => deploymentOwnerGone(lock, await deploymentProcessIdentity(lock.pid)),
    prepare: prepareNative,
    quiescent: async (prepared, current, preserveRuntime, afterReload = false) => {
      await assertDeploymentLifecycle(current.stateDirectory, current.serviceUid, preserveRuntime);
      const units = ['cocoproxy-management.service'];
      if (!preserveRuntime) {
        units.push('cocoproxy-mihomo.service');
        if (prepared.input.runtime.automaticGateway) units.push('cocoproxy-gateway-network.service', 'cocoproxy-gateway-guard.service');
      }
      if (current.files.some(file => file.path === '/etc/systemd/system/cocoproxy-web.service')) units.push('cocoproxy-web.service');
      await assertDeploymentStopped(prepared.input.runtime.systemctlPath, units, !afterReload);
      if (!preserveRuntime) await assertDeploymentNetworkClear(prepared.input);
    },
    exists: async path => Boolean(await deploymentPathInfo(path)), owned: assertOwnedDeploymentFiles,
    claim: async (current, existing) => {
      require(!await deploymentPathInfo(RECOVERY), 'INSTALL_RECOVERY_PREVIOUS_ATTEMPT_INCOMPLETE');
      const identity = await deploymentProcessIdentity(process.pid);
      require(identity.startTime !== null, 'INSTALL_PROCESS_IDENTITY_UNAVAILABLE');
      const owner = { schemaVersion: 1, id: randomUUID(), pid: process.pid, bootId: identity.bootId, startTime: identity.startTime };
      await writeExclusiveDeploymentFile(RECOVERY, JSON.stringify({ ...owner, action: 'rollback', manifestSha256: current.manifestSha256 }) + '\n', 0o600);
      if (existing) return existing.bytes;
      const bytes = Buffer.from(JSON.stringify(owner) + '\n');
      await writeExclusiveDeploymentFile(LOCK, bytes, 0o600);
      return bytes;
    },
    write: writeAtomicDeploymentFile, remove: unlink,
    reload: async systemctl => { await runDeploymentTool(systemctl, ['daemon-reload']); },
  };
}

/** Restore only this failed upgrade's program files; private data and credentials remain in place. */
export async function rollbackDeployment(context: RollbackContext, options: { host?: DeploymentRollbackHost } = {}) {
  if (!options.host) require(platform() === 'linux' && process.getuid?.() === 0, 'INSTALL_LINUX_ROOT_REQUIRED');
  require(context && Object.keys(context).every(key => ['previousInput', 'previousReceipt', 'manifestSha256', 'preserveRuntime'].includes(key)) &&
    /^[a-f0-9]{64}$/.test(context.manifestSha256) && (context.preserveRuntime === undefined || typeof context.preserveRuntime === 'boolean'),
  'INSTALL_ROLLBACK_CONTEXT_INVALID');
  const previous = validateReceipt(context.previousReceipt);
  require(previous.status === 'complete' && previous.manifestSha256 !== context.manifestSha256, 'INSTALL_ROLLBACK_PREVIOUS_RECEIPT_INVALID');
  const host = options.host ?? nativeHost(), observed = await host.readReceipt(), current = observed.receipt;
  const unchanged = JSON.stringify(current) === JSON.stringify(previous);
  require(unchanged || ['pending', 'complete'].includes(current.status) && current.manifestSha256 === context.manifestSha256 &&
    current.release === posix.join(posix.dirname(previous.release), context.manifestSha256) && current.transaction?.operation === 'upgrade' &&
    current.serviceUid === previous.serviceUid && current.stateDirectory === previous.stateDirectory && current.credentialPath === previous.credentialPath,
  'INSTALL_ROLLBACK_RECEIPT_CHANGED');
  if (context.preserveRuntime && !unchanged) require(current.runtimeManifestSha256 === (previous.runtimeManifestSha256 ?? previous.manifestSha256) &&
    previous.files.every(file => file.path === '/etc/systemd/system/cocoproxy-management.service' || current.files.some(next =>
      JSON.stringify(next) === JSON.stringify(file))), 'INSTALL_ROLLBACK_RUNTIME_CHANGED');
  const lock = await host.lock();
  if (lock) require(!unchanged && current.transaction?.id === lock.value.id && await host.ownerGone(lock.value), 'INSTALL_ROLLBACK_LOCK_UNVERIFIED');
  const prepared = await host.prepare(context, current);
  await host.quiescent(prepared, current, Boolean(context.preserveRuntime));
  await assertRollbackFiles(previous, current, host);
  const claimedLock = await host.claim(current, lock);
  // From here every failure deliberately retains both installation/recovery locks as evidence.
  require((await host.readReceipt()).bytes.equals(observed.bytes) && (await host.lock())?.bytes.equals(claimedLock), 'INSTALL_ROLLBACK_EVIDENCE_CHANGED');
  await host.quiescent(prepared, current, Boolean(context.preserveRuntime));
  await assertRollbackFiles(previous, current, host);
  for (const file of prepared.plan.files) {
    try { await host.owned([previous.files.find(old => old.path === file.path)!]); }
    catch {
      await host.owned([current.files.find(next => next.path === file.path)!]);
      await host.write(file.path, file.content, parseInt(file.mode, 8), file.owner === 'root' ? 0 : file.owner);
    }
  }
  for (const file of current.files.filter(file => !previous.files.some(old => old.path === file.path))) {
    if (await host.exists(file.path)) { await host.owned([file]); await host.remove(file.path); }
  }
  await host.owned(previous.files);
  await host.reload(prepared.input.runtime.systemctlPath);
  await host.quiescent(prepared, previous, Boolean(context.preserveRuntime), true);
  require((await host.readReceipt()).bytes.equals(observed.bytes) && (await host.lock())?.bytes.equals(claimedLock), 'INSTALL_ROLLBACK_EVIDENCE_CHANGED');
  await host.write(RECEIPT, JSON.stringify(previous) + '\n', 0o600);
  require((await host.lock())?.bytes.equals(claimedLock), 'INSTALL_ROLLBACK_EVIDENCE_CHANGED');
  await host.remove(LOCK);
  await host.remove(RECOVERY);
  return { restored: true, manifestSha256: previous.manifestSha256, usageCompatibility: prepared.usageCompatibility,
    services: context.preserveRuntime ? 'runtime-preserved' : 'remain-stopped' };
}
