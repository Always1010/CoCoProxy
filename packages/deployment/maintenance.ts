import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, unlink } from 'node:fs/promises';
import { platform } from 'node:os';
import { posix } from 'node:path';
import { assertDeploymentAccount, assertDeploymentExecutable, assertDeploymentStopped, assertDeploymentLifecycle, assertOwnedDeploymentFiles,
  assertPrivateDeploymentFile, assertRootPath, deploymentPathInfo, deploymentProcessIdentity, InstallError,
  parseDeploymentLock, readRegularDeploymentFile, runDeploymentTool, validateReceipt, verifyRelease,
  writeAtomicDeploymentFile, releaseTarget, type DeploymentLock, type Receipt } from './install.ts';
import { renderDeploymentPlan } from './plan.ts';

const STORE = '/var/lib/cocoproxy-deployment';
const RECEIPT = STORE + '/receipt.json';
const LOCK = STORE + '/install.lock';
const baseUnits = ['cocoproxy-mihomo.service', 'cocoproxy-management.service', 'cocoproxy-gateway-network.service', 'cocoproxy-gateway-guard.service'];
const digest = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
function require(value: unknown, code: string): asserts value { if (!value) throw new InstallError(code); }
function rootHost() { require(platform() === 'linux' && process.getuid?.() === 0, 'INSTALL_LINUX_ROOT_REQUIRED'); }
function errorCode(error: unknown) { return error instanceof InstallError ? error.code : 'INSTALL_INSPECTION_UNAVAILABLE'; }

async function readReceipt() {
  await assertRootPath(STORE);
  require((await lstat(STORE)).isDirectory() && ((await lstat(STORE)).mode & 0o7777) === 0o700,
    'INSTALL_RECEIPT_DIRECTORY_PRIVATE_REQUIRED');
  await assertPrivateDeploymentFile(RECEIPT, 0);
  const bytes = await readRegularDeploymentFile(RECEIPT, 128 * 1024);
  return { bytes, receipt: validateReceipt(JSON.parse(bytes.toString())) };
}
async function readLock() {
  await assertPrivateDeploymentFile(LOCK, 0);
  const bytes = await readRegularDeploymentFile(LOCK, 4096);
  return { bytes, lock: parseDeploymentLock(JSON.parse(bytes.toString())) };
}
export function deploymentOwnerGone(lock: DeploymentLock, observed: { bootId: string; startTime: string | null }): boolean {
  return lock.bootId !== observed.bootId || observed.startTime === null || lock.startTime !== observed.startTime;
}
async function releaseEvidence(receipt: Receipt) {
  await assertRootPath(receipt.release);
  await assertRootPath(receipt.release + '/manifest.json');
  const release = await verifyRelease(receipt.release, receipt.manifestSha256);
  for (const entry of release.files) {
    const path = receipt.release + '/' + entry.path;
    await assertRootPath(path);
    require(((await lstat(path)).mode & 0o7777) === parseInt(entry.mode, 8), 'INSTALL_RELEASE_PERMISSIONS_CHANGED');
  }
}
/** Shared lifecycle proof. Private input is returned only to trusted in-process callers. */
export async function loadInstalledDeployment(inputPath: string) {
  rootHost();
  await assertRootPath(inputPath); await assertPrivateDeploymentFile(inputPath, 0);
  const inputBytes = await readRegularDeploymentFile(inputPath, 128 * 1024);
  const input = JSON.parse(inputBytes.toString());
  const plan = renderDeploymentPlan(input), previous = await readReceipt();
  require(previous.receipt.status === 'complete' && previous.receipt.serviceUid === input.runtime.serviceUid &&
    previous.receipt.stateDirectory === input.runtime.stateDirectory && previous.receipt.credentialPath === input.management.credentialPath &&
    previous.receipt.release === releaseTarget(input, previous.receipt.manifestSha256) && previous.receipt.files.length === plan.files.length &&
    plan.files.every(file => previous.receipt.files.some(old => old.path === file.path && old.mode === file.mode &&
      old.owner === file.owner && old.sensitive === file.sensitive && old.sha256 === digest(file.content))), 'INSTALL_RECEIPT_MISMATCH_OR_INCOMPLETE');
  await assertOwnedDeploymentFiles(previous.receipt.files);
  await releaseEvidence(previous.receipt);
  await assertDeploymentExecutable(input.runtime.nodePath); await assertDeploymentExecutable(input.runtime.systemctlPath);
  await assertDeploymentAccount(input.management.serviceUser, input.runtime.serviceUid);
  return { input, inputBytes, plan, receipt: previous.receipt, receiptBytes: previous.bytes };
}

/** No service operation, lock removal, file writes, or credential contents. */
export async function inspectDeployment() {
  rootHost();
  if (!(await deploymentPathInfo(STORE))) return { installed: false, readOnly: true, findings: [] };
  let receipt: Receipt;
  try { receipt = (await readReceipt()).receipt; }
  catch (error) { return { installed: 'unknown', readOnly: true, findings: [errorCode(error)],
    receipt: 'missing-or-untrusted', recovery: 'manual-review-required', automaticProgramRollback: false }; }
  const files = [];
  for (const file of receipt.files) {
    let status = 'matches-receipt';
    let checks: { regularFile: boolean; ownerMatches: boolean; modeMatches: boolean; contentMatches: boolean | null } | undefined;
    try {
      if (receipt.status === 'uninstalled' && !file.sensitive) {
        status = await deploymentPathInfo(file.path) ? 'unexpected-after-uninstall' : 'removed-as-recorded';
      } else {
        await assertRootPath(posix.dirname(file.path));
        const stat = await deploymentPathInfo(file.path);
        if (!stat) status = 'missing';
        else {
          const regularFile = stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1;
          checks = { regularFile, ownerMatches: stat.uid === (file.owner === 'root' ? 0 : file.owner),
            modeMatches: (stat.mode & 0o7777) === parseInt(file.mode, 8), contentMatches: regularFile ?
              digest(await readRegularDeploymentFile(file.path)) === file.sha256 : null };
          if (Object.values(checks).some(check => check !== true)) status = 'changed';
        }
      }
    }
    catch (error) { status = !(await deploymentPathInfo(file.path)) ? 'missing' : errorCode(error); }
    files.push({ path: file.path, sensitive: file.sensitive, status, ...(checks ? { checks } : {}),
      intendedAction: receipt.transaction?.operation === 'uninstall' ? file.sensitive ? 'preserve' : 'remove' : receipt.transaction ? 'write' : 'unknown-legacy' });
  }
  let release = 'matches-receipt';
  try { await releaseEvidence(receipt); } catch (error) { release = errorCode(error); }
  let lifecycleJournal: { status: string; action?: string; id?: string } | undefined;
  if (await deploymentPathInfo(STORE + '/lifecycle.json')) {
    try {
      await assertPrivateDeploymentFile(STORE + '/lifecycle.json', 0);
      const j = JSON.parse((await readRegularDeploymentFile(STORE + '/lifecycle.json', 16384)).toString());
      require(j.schemaVersion === 1 && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(j.id) &&
        ['pending', 'complete'].includes(j.status) && ['initialize', 'start-management', 'enable-persistence', 'pause-maintenance', 'stop-maintenance', 'resume-persistence'].includes(j.action),
      'INSTALL_LIFECYCLE_JOURNAL_INVALID');
      lifecycleJournal = { status: j.status, action: j.action, id: j.id };
    } catch (error) { lifecycleJournal = { status: errorCode(error) }; }
  }
  let lock: { present: boolean; owner?: 'gone' | 'alive'; status?: string } = { present: false };
  if (await deploymentPathInfo(LOCK)) {
    lock = { present: true };
    try {
      const parsed = await readLock();
      lock.owner = deploymentOwnerGone(parsed.lock, await deploymentProcessIdentity(parsed.lock.pid)) ? 'gone' : 'alive';
      lock.status = receipt.transaction?.id === parsed.lock.id ? 'matches-receipt' : lifecycleJournal?.id === parsed.lock.id ?
        'matches-lifecycle-journal' : 'INSTALL_LOCK_RECEIPT_MISMATCH';
    } catch (error) { lock.status = errorCode(error); }
  }
  const temporaryFiles: string[] = [];
  for (const directory of new Set([STORE, ...receipt.files.map(file => posix.dirname(file.path))])) {
    try {
      await assertRootPath(directory);
      for (const name of await readdir(directory)) if (/^\.cocoproxy-install-[a-f0-9-]{36}$/.test(name)) temporaryFiles.push(directory + '/' + name);
    } catch { /* File evidence above carries failures; never follow untrusted directories. */ }
  }
  return { installed: true, readOnly: true, receipt: { status: receipt.status, manifestSha256: receipt.manifestSha256,
    operation: receipt.transaction?.operation ?? 'unknown-legacy' }, files, release, lock,
    ...(lifecycleJournal ? { lifecycleJournal: { status: lifecycleJournal.status, action: lifecycleJournal.action } } : {}),
    recoveryLock: { present: Boolean(await deploymentPathInfo(STORE + '/recovery.lock')) }, temporaryFiles,
    recovery: 'Only an abandoned transaction with every intended byte already installed can be finalized; partial writes and legacy locks require manual review.',
    preservedState: true, automaticProgramRollback: false };
}

export function assertFinalizableReceipt(receipt: Receipt, lock: DeploymentLock): void {
  require(receipt.transaction?.id === lock.id && ['install', 'upgrade'].includes(receipt.transaction.operation) &&
    ['pending', 'complete'].includes(receipt.status), 'INSTALL_RECOVERY_NOT_FINALIZABLE');
}

/** The same credential evidence is required before review and after taking the recovery lock. */
type RecoveryCredentialEvidence = { status: 'preserved' | 'initialization-required'; sha256: string | null };
export async function assessRecoveryCredential(receipt: Receipt, host = {
  info: deploymentPathInfo, rootPath: assertRootPath, privateFile: assertPrivateDeploymentFile, read: readRegularDeploymentFile,
}, reviewed?: RecoveryCredentialEvidence): Promise<RecoveryCredentialEvidence> {
  await host.rootPath(posix.dirname(receipt.credentialPath));
  const present = Boolean(await host.info(receipt.credentialPath));
  let evidence: RecoveryCredentialEvidence;
  if (!present) {
    require(receipt.transaction?.operation === 'install', 'INSTALL_RECOVERY_CREDENTIAL_REQUIRED');
    evidence = { status: 'initialization-required', sha256: null };
  } else {
    await host.privateFile(receipt.credentialPath, receipt.serviceUid);
    evidence = { status: 'preserved', sha256: digest(await host.read(receipt.credentialPath, 16384)) };
  }
  if (reviewed) require(evidence.status === reviewed.status && evidence.sha256 === reviewed.sha256, 'INSTALL_RECOVERY_EVIDENCE_CHANGED');
  return evidence;
}

/** Finish an already copied deployment. Never retry writes, delete releases, or restore state. */
export async function recoverDeployment(options: { apply?: boolean; reviewedRecoverySha256?: string } = {}) {
  rootHost();
  require(!(await deploymentPathInfo(STORE + '/recovery.lock')), 'INSTALL_RECOVERY_PREVIOUS_ATTEMPT_INCOMPLETE');
  const previous = await readReceipt(), owner = await readLock();
  const units = [...baseUnits, ...(previous.receipt.files.some(file => file.path === '/etc/systemd/system/cocoproxy-web.service') ? ['cocoproxy-web.service'] : [])];
  assertFinalizableReceipt(previous.receipt, owner.lock);
  require(deploymentOwnerGone(owner.lock, await deploymentProcessIdentity(owner.lock.pid)), 'INSTALL_RECOVERY_OWNER_ALIVE');
  await assertOwnedDeploymentFiles(previous.receipt.files);
  await releaseEvidence(previous.receipt);
  const credential = await assessRecoveryCredential(previous.receipt);
  await assertDeploymentLifecycle(previous.receipt.stateDirectory, previous.receipt.serviceUid);
  const systemctl = '/usr/bin/systemctl';
  await assertDeploymentExecutable(systemctl);
  await assertDeploymentStopped(systemctl, units, true);
  const reviewedRecoverySha256 = digest(Buffer.concat([previous.bytes, Buffer.from('\n'), owner.bytes, Buffer.from('\n' + JSON.stringify(credential))]));
  const result = { operation: 'recover', apply: Boolean(options.apply), action: 'finalize-installed-files', reviewedRecoverySha256,
    receiptStatus: previous.receipt.status, credential: credential.status, administratorInitializationRequired: credential.status === 'initialization-required',
    services: 'remain stopped and disabled', state: 'preserved-in-place',
    automaticProgramRollback: false, actions: ['systemd daemon-reload', 'mark receipt complete', 'remove matching abandoned install lock'] };
  if (!options.apply) return result;
  require(options.reviewedRecoverySha256 === reviewedRecoverySha256, 'INSTALL_RECOVERY_REVIEW_REQUIRED');
  // Separate exclusive recovery lock prevents concurrent finalizers. A crash leaves it for manual review.
  const recoveryLock = STORE + '/recovery.lock';
  const handle = await open(recoveryLock, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(JSON.stringify({ transaction: owner.lock.id, pid: process.pid }) + '\n'); await handle.sync(); }
  finally { await handle.close(); }
  try {
    const current = await readReceipt(), currentOwner = await readLock();
    require(current.bytes.equals(previous.bytes) && currentOwner.bytes.equals(owner.bytes), 'INSTALL_RECOVERY_EVIDENCE_CHANGED');
    require(deploymentOwnerGone(owner.lock, await deploymentProcessIdentity(owner.lock.pid)), 'INSTALL_RECOVERY_OWNER_ALIVE');
    await assertOwnedDeploymentFiles(previous.receipt.files);
    await releaseEvidence(previous.receipt);
    await assessRecoveryCredential(previous.receipt, undefined, credential);
    await assertDeploymentLifecycle(previous.receipt.stateDirectory, previous.receipt.serviceUid);
    await assertDeploymentStopped(systemctl, units, true);
    await runDeploymentTool(systemctl, ['daemon-reload']);
    await assertDeploymentStopped(systemctl, units);
    await writeAtomicDeploymentFile(RECEIPT, JSON.stringify({ ...previous.receipt, status: 'complete' }) + '\n', 0o600);
    await unlink(LOCK);
    await unlink(recoveryLock);
  } catch (error) {
    // Retain both locks as evidence; do not convert a second interruption into an automatic retry.
    throw error;
  }
  return result;
}
