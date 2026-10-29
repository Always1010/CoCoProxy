import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, chown, lstat, mkdir, open, readFile, readdir, realpath, rename, unlink } from 'node:fs/promises';
import { posix, resolve } from 'node:path';
import { arch, machine, platform } from 'node:os';
import { execFile } from 'node:child_process';
import { renderDeploymentPlan, type DeploymentPlan } from './plan.ts';
import { createUpgradeAssessment, inspectStateCompatibility, stateDirectoryExists, type UpgradeStateHost } from './upgrade-assessment.ts';
import { parseRuntimeSettings } from '../runtime/settings.ts';
import { verifyManagedWeb } from '../setup/https.ts';
import { inspectServiceAccount, validServiceAccountRequest } from './service-account.ts';
import { assertRootControlledPath, assertTrustedExecutable, assertServiceAncestors, assertPlannedDeploymentDirectory, assertPrivatePath,
  PathEvidenceError, type PathEvidenceHost } from './path-evidence.ts';
import { policyRuleConflicts, routeConflicts, firewallConflicts, tunConflicts, networkReceiptRemoved, NetworkObservationError } from './network-evidence.ts';
import { validateBuildInputs, validateComponentUpdate, validateFrontendUpdate } from './update-scope.mjs';
import { inspectUsageDatabase } from '../management/usage.ts';
import { assessRuntimePreservation } from './runtime-preservation.ts';

// This is deliberately an offline file installer. Service lifecycle, router
// activation and the existing root network helper remain separate operations.
const STORE = '/var/lib/cocoproxy-deployment';
const RECEIPT = STORE + '/receipt.json';
const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
type Operation = 'install' | 'upgrade' | 'uninstall';
type Entry = { path: string; sha256: string; size: number; mode: string };
export type Owned = { path: string; sha256: string; mode: string; owner: 'root' | number; sensitive: boolean };
export type Receipt = { schemaVersion: 1; status: 'pending' | 'complete' | 'uninstalled'; release: string;
  manifestSha256: string; files: Owned[]; serviceUid: number; stateDirectory: string; credentialPath: string;
  runtimeManifestSha256?: string;
  transaction?: { id: string; operation: Operation } };
export type InstallOptions = { payload: string; input: string; manifestSha256: string; operation: Operation; apply?: boolean; reviewedConfigurationSha256?: string; preserveRuntime?: boolean };
export type DeploymentLock = { schemaVersion: 1; id: string; pid: number; bootId: string; startTime: string };
export function parseDeploymentLock(value: unknown): DeploymentLock {
  const lock = value as DeploymentLock;
  require(lock && typeof lock === 'object' && !Array.isArray(lock) && lock.schemaVersion === 1 &&
    Object.keys(lock).sort().join(',') === 'bootId,id,pid,schemaVersion,startTime' &&
    UUID.test(lock.id) && Number.isSafeInteger(lock.pid) && lock.pid > 0 &&
    UUID.test(lock.bootId) && /^[1-9]\d{0,31}$/.test(lock.startTime), 'INSTALL_LOCK_LEGACY_OR_INVALID');
  return lock;
}
export async function deploymentProcessIdentity(pid: number): Promise<{ bootId: string; startTime: string | null }> {
  const bootId = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
  let stat: string;
  try { stat = await readFile(`/proc/${pid}/stat`, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { bootId, startTime: null }; throw error; }
  const startTime = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19];
  require(UUID.test(bootId) && /^[1-9]\d{0,31}$/.test(startTime), 'INSTALL_PROCESS_IDENTITY_UNAVAILABLE');
  return { bootId, startTime };
}
export class InstallError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.name = 'InstallError'; this.code = code; }
}
/** Validate before receipt paths are ever used for reads or recovery. */
export function validateReceipt(value: unknown): Receipt {
  const r = value as Receipt;
  require(r && typeof r === 'object' && !Array.isArray(r) && r.schemaVersion === 1 &&
    Object.keys(r).every(key => ['schemaVersion', 'status', 'release', 'manifestSha256', 'files', 'serviceUid', 'stateDirectory', 'credentialPath', 'transaction', 'runtimeManifestSha256'].includes(key)) &&
    ['pending', 'complete', 'uninstalled'].includes(r.status) && HASH.test(r.manifestSha256) &&
    Number.isSafeInteger(r.serviceUid) && r.serviceUid > 0 && Array.isArray(r.files) && r.files.length > 0 && r.files.length <= 16,
  'INSTALL_RECEIPT_INVALID');
  absolute(r.release); absolute(r.stateDirectory); absolute(r.credentialPath);
  require(r.runtimeManifestSha256 === undefined || HASH.test(r.runtimeManifestSha256), 'INSTALL_RECEIPT_INVALID');
  require(posix.basename(r.release) === r.manifestSha256 && !['/etc', '/usr', '/var', '/srv', '/opt', '/run', '/'].includes(posix.dirname(r.release)),
    'INSTALL_RECEIPT_INVALID');
  require(r.files.every(file => file && typeof file === 'object' && !Array.isArray(file)), 'INSTALL_RECEIPT_INVALID');
  require(new Set(r.files.map(file => file.path)).size === r.files.length, 'INSTALL_RECEIPT_INVALID');
  for (const file of r.files) {
    absolute(file.path);
    require(HASH.test(file.sha256) && ['0600', '0644'].includes(file.mode) && typeof file.sensitive === 'boolean' &&
      (file.owner === 'root' || file.owner === r.serviceUid) &&
      file.path !== RECEIPT && !file.path.startsWith(STORE + '/'), 'INSTALL_RECEIPT_INVALID');
  }
  if (r.transaction !== undefined) require(r.transaction && Object.keys(r.transaction).sort().join(',') === 'id,operation' && UUID.test(r.transaction.id) &&
    ['install', 'upgrade', 'uninstall'].includes(r.transaction.operation), 'INSTALL_RECEIPT_INVALID');
  return r;
}
/** Installation must not race the opt-in background runtime reconciler. */
export function assertMaintenanceLifecycle(value: unknown): void {
  require(value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === 'enabled,paused,schemaVersion' &&
    (value as any).schemaVersion === 1 && typeof (value as any).enabled === 'boolean' &&
    typeof (value as any).paused === 'boolean', 'INSTALL_LIFECYCLE_INVALID');
  require(!(value as any).enabled || (value as any).paused, 'INSTALL_LIFECYCLE_MUST_BE_PAUSED');
}
export async function assertDeploymentLifecycle(stateDirectory: string, serviceUid: number, allowRunning = false) {
  if (!(await info(stateDirectory))) return;
  await trusted(posix.dirname(stateDirectory));
  const state = await lstat(stateDirectory);
  require(state.isDirectory() && !state.isSymbolicLink() && state.uid === serviceUid && (state.mode & 0o7777) === 0o700,
    'INSTALL_DIRECTORY_OWNERSHIP_CONFLICT');
  const path = posix.join(stateDirectory, 'lifecycle.json');
  if (!(await info(path))) return;
  await privateFile(path, serviceUid);
  let lifecycle: unknown;
  try { lifecycle = JSON.parse((await regular(path, 4096)).toString('utf8')); }
  catch { throw new InstallError('INSTALL_LIFECYCLE_INVALID'); }
  if (allowRunning) {
    require(lifecycle && typeof lifecycle === 'object' && !Array.isArray(lifecycle), 'INSTALL_LIFECYCLE_INVALID');
    assertMaintenanceLifecycle({ ...(lifecycle as Record<string, unknown>), paused: true });
    require(typeof (lifecycle as any).paused === 'boolean', 'INSTALL_LIFECYCLE_INVALID');
  } else assertMaintenanceLifecycle(lifecycle);
}

/** Add only known managed units; never adopt an arbitrary pre-existing file. */
export function compatibleOwnedFiles(previous: readonly Owned[], current: readonly Owned[], upgrade: boolean): boolean {
  if (previous.some(old => !current.some(file => file.path === old.path && file.mode === old.mode &&
      file.owner === old.owner && file.sensitive === old.sensitive))) return false;
  const added = current.filter(file => !previous.some(old => old.path === file.path));
  return added.length === 0 && previous.length === current.length || upgrade && previous.length === 7 && current.length === 8 &&
    added.length === 1 && added[0].path === '/etc/systemd/system/cocoproxy-gateway-guard.service' &&
    added[0].owner === 'root' && added[0].mode === '0644' && added[0].sensitive === false &&
    previous.some(file => file.path === '/etc/systemd/system/cocoproxy-gateway-network.service') ||
    upgrade && previous.length === 8 && current.length === 10 && added.length === 2 &&
    added.every(file => file.owner === 'root' && file.mode === '0644' && !file.sensitive) &&
    ['/etc/cocoproxy/web/nginx.conf', '/etc/systemd/system/cocoproxy-web.service'].every(path => added.some(file => file.path === path)) &&
    previous.some(file => file.path === '/etc/systemd/system/cocoproxy-gateway-guard.service');
}
function require(value: unknown, code: string): asserts value { if (!value) throw new InstallError(code); }
const digest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
export type ConfigurationReview = {
  previousManifestSha256: string;
  manifestSha256: string;
  inputSha256: string;
  previousConfiguration: readonly { path: string; sha256: string }[];
};

/** Operator-reviewed CAS: hashes only, never configuration or credential contents. */
export function configurationReviewDigest(review: ConfigurationReview): string {
  require([review.previousManifestSha256, review.manifestSha256, review.inputSha256].every(value => HASH.test(value)) &&
    Array.isArray(review.previousConfiguration) && review.previousConfiguration.length > 0 && review.previousConfiguration.length <= 16,
  'INSTALL_CONFIGURATION_REVIEW_INVALID');
  const previousConfiguration = review.previousConfiguration.map(file => ({ path: absolute(file.path), sha256: file.sha256 }))
    .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  require(previousConfiguration.every(file => HASH.test(file.sha256)) &&
    new Set(previousConfiguration.map(file => file.path)).size === previousConfiguration.length, 'INSTALL_CONFIGURATION_REVIEW_INVALID');
  return digest(JSON.stringify({ schemaVersion: 1, previousManifestSha256: review.previousManifestSha256,
    manifestSha256: review.manifestSha256, inputSha256: review.inputSha256, previousConfiguration }));
}

/** Default upgrade stays immutable; opt-in binds both old owned bytes and new input. */
export function assertReviewedUpgradeConfiguration(review: ConfigurationReview, supplied: string | undefined, unchanged: boolean): boolean {
  if (supplied === undefined) { require(unchanged, 'INSTALL_CONFIGURATION_CHANGE_REQUIRES_REVIEW'); return false; }
  require(HASH.test(supplied) && supplied === configurationReviewDigest(review), 'INSTALL_CONFIGURATION_REVIEW_MISMATCH');
  return true;
}

async function info(path: string) {
  try { return await lstat(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
function absolute(path: string) {
  require(typeof path === 'string' && path.startsWith('/') && posix.normalize(path) === path && path !== '/' &&
    !/[\x00-\x20\x7f]/.test(path) && !path.split('/').includes('.local'), 'INSTALL_PATH_INVALID');
  return path;
}
function relative(path: string) {
  require(typeof path === 'string' && path.length <= 1024 && path.split('/').length <= 32 &&
    !path.startsWith('/') && posix.normalize(path) === path && !/[\\\x00-\x20\x7f]/.test(path) &&
    !path.split('/').some(part => ['..', '.', '.local', '.git'].includes(part)) &&
    (/^(source|server|bin)\//.test(path) || ['README.md', 'cocoproxy'].includes(path)), 'INSTALL_MANIFEST_PATH_INVALID');
  return path;
}
async function regular(path: string, limit = 8 * 1024 * 1024) {
  const before = await lstat(path);
  require(before.isFile() && !before.isSymbolicLink() && before.nlink === 1 && before.size <= limit, 'INSTALL_REGULAR_FILE_REQUIRED');
  const handle = await open(path, constants.O_RDONLY | (platform() === 'win32' ? 0 : constants.O_NOFOLLOW));
  try {
    const stat = await handle.stat();
    require(stat.isFile() && stat.nlink === 1 && stat.dev === before.dev && stat.ino === before.ino && stat.size <= limit,
      'INSTALL_REGULAR_FILE_REQUIRED');
    const bytes = await handle.readFile();
    require(bytes.length <= limit, 'INSTALL_REGULAR_FILE_REQUIRED');
    return bytes;
  } finally { await handle.close(); }
}
function deploymentStateHost(stateDirectory: string, serviceUid: number): UpgradeStateHost {
  async function statePath(path: string, allowMissing = false) {
    await trusted(posix.dirname(stateDirectory));
    let current = stateDirectory;
    for (const part of ['', ...posix.relative(stateDirectory, posix.dirname(path)).split('/').filter(Boolean)]) {
      if (part) current += '/' + part;
      const stat = await info(current);
      if (!stat && allowMissing) return;
      require(stat && stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === serviceUid &&
        (stat.mode & 0o7777) === 0o700, 'INSTALL_STATE_OWNERSHIP_REQUIRED');
    }
  }
  return {
    usage: async () => {
      if (!await stateDirectoryExists(stateDirectory, { info, rootPath: trusted })) return null;
      await statePath(posix.join(stateDirectory, 'usage.sqlite'));
      return inspectUsageDatabase(stateDirectory, serviceUid);
    },
    read: async (relative, limit) => {
      if (!await stateDirectoryExists(stateDirectory, { info, rootPath: trusted })) return null;
      const path = posix.join(stateDirectory, relative);
      await statePath(path, true);
      if (!await info(path)) return null;
      await statePath(path); await privateFile(path, serviceUid);
      return (await regular(path, limit)).toString('utf8');
    },
    list: async relative => {
      if (!await stateDirectoryExists(stateDirectory, { info, rootPath: trusted })) return null;
      const path = posix.join(stateDirectory, relative);
      await statePath(path + '/placeholder', true);
      if (!await info(path)) return null;
      await statePath(path + '/placeholder');
      return readdir(path);
    },
  };
}
export function assertDeploymentStateCompatibility(files: Awaited<ReturnType<typeof inspectStateCompatibility>>['findings']) {
  require(!files.some(file => file.status === 'unsupported-version' || file.contentCompatibility.code === 'DEPLOYMENT_STATE_VERSION_UNSUPPORTED'), 'INSTALL_STATE_SCHEMA_UNSUPPORTED');
  require(!files.some(file => file.contentCompatibility.status === 'unsupported'), 'INSTALL_STATE_CONTENT_UNSUPPORTED');
  require(!files.some(file => file.status === 'unavailable'), 'INSTALL_STATE_INSPECTION_UNAVAILABLE');
  require(!files.some(file => file.status === 'not-declared' || file.contentCompatibility.status === 'unknown'), 'INSTALL_STATE_COMPATIBILITY_NOT_DECLARED');
}
/** No links, sockets, devices, private areas or unlisted files enter a release. */
export async function verifyRelease(payload: string, expected: string): Promise<{ files: Entry[]; coreSHA: string;
  compatibility?: unknown;
  buildInputs?: ReturnType<typeof validateBuildInputs>;
  frontendUpdate?: ReturnType<typeof validateFrontendUpdate>; backendInputSha256?: string;
  componentUpdate?: ReturnType<typeof validateComponentUpdate>; frontendInputSha256?: string; serverInputSha256?: string; inputSchemaVersion?: number }> {
  require(HASH.test(expected), 'INSTALL_MANIFEST_HASH_REQUIRED');
  // Cross-platform artifact verification is also used by the synthetic tests.
  require(resolve(payload) === payload && !(await lstat(payload)).isSymbolicLink(), 'INSTALL_PAYLOAD_PATH_INVALID');
  const bytes = await regular(posix.join(payload.replaceAll('\\', '/'), 'manifest.json'));
  require(digest(bytes) === expected, 'INSTALL_MANIFEST_HASH_MISMATCH');
  const value = JSON.parse(bytes.toString());
  require(value.schemaVersion === 1 && value.scope === 'local-explicit-proxy-payload' &&
    Array.isArray(value.files) && value.files.length > 0 && value.files.length <= 12000, 'INSTALL_MANIFEST_INVALID');
  const paths = new Set<string>(); let total = 0;
  for (const entry of value.files as Entry[]) {
    relative(entry.path);
    require(!paths.has(entry.path.toLowerCase()) && HASH.test(entry.sha256) &&
      Number.isSafeInteger(entry.size) && entry.size >= 0 && entry.size <= 256 * 1024 * 1024 &&
      ['0644', '0755'].includes(entry.mode), 'INSTALL_MANIFEST_INVALID');
    if (['README.md', 'cocoproxy'].includes(entry.path)) require(entry.mode === (entry.path === 'cocoproxy' ? '0755' : '0644'), 'INSTALL_MANIFEST_INVALID');
    paths.add(entry.path.toLowerCase()); total += entry.size;
    require(total <= 512 * 1024 * 1024, 'INSTALL_PAYLOAD_LIMIT');
  }
  const found = new Set<string>();
  const neededDirectories = new Set<string>();
  for (const entry of value.files as Entry[]) {
    let parent = posix.dirname(entry.path);
    while (parent !== '.') { neededDirectories.add(parent); parent = posix.dirname(parent); }
  }
  async function walk(directory: string, prefix = '') {
    for (const name of await readdir(directory)) {
      const namePath = prefix + name, path = directory + '/' + name, stat = await lstat(path);
      require(!stat.isSymbolicLink(), 'INSTALL_PAYLOAD_LINK');
      if (stat.isDirectory()) {
        require(neededDirectories.has(namePath), 'INSTALL_PAYLOAD_UNLISTED');
        await walk(path, namePath + '/');
      } else {
        require(stat.isFile() && stat.nlink === 1 && (namePath === 'manifest.json' || paths.has(namePath.toLowerCase())),
          'INSTALL_PAYLOAD_UNLISTED');
        found.add(namePath);
      }
    }
  }
  await walk(payload);
  require(found.size === value.files.length + 1, 'INSTALL_PAYLOAD_MISSING');
  for (const entry of value.files as Entry[]) {
    require(found.has(entry.path), 'INSTALL_PAYLOAD_MISSING');
    const bytes = await regular(payload + '/' + entry.path, 256 * 1024 * 1024);
    require(bytes.length === entry.size && digest(bytes) === entry.sha256, 'INSTALL_PAYLOAD_HASH_MISMATCH');
  }
  const core = value.files.find((entry: Entry) => entry.path === 'bin/mihomo');
  require(core && core.sha256 === value.components?.mihomo?.binarySha256 &&
    found.has('source/apps/runtime/launch-core.ts') && found.has('server/.output/server/index.mjs'), 'INSTALL_PAYLOAD_ENTRY_MISSING');
  const inputSchemaVersion = value.buildInputs?.schemaVersion ?? 1;
  require([1, 2].includes(inputSchemaVersion), 'INSTALL_BUILD_INPUTS_INVALID');
  if (inputSchemaVersion === 2) {
    try { validateBuildInputs(value.buildInputs); } catch { throw new InstallError('INSTALL_BUILD_INPUTS_INVALID'); }
  }
  let frontendUpdate;
  if (value.frontendUpdate !== undefined) {
    try { frontendUpdate = validateFrontendUpdate(value.frontendUpdate); } catch { throw new InstallError('INSTALL_FRONTEND_DECLARATION_INVALID'); }
    require(inputSchemaVersion === frontendUpdate.schemaVersion && value.buildInputs?.backendInputSha256 === frontendUpdate.backendInputSha256, 'INSTALL_FRONTEND_DECLARATION_INVALID');
  }
  let componentUpdate;
  if (value.componentUpdate !== undefined) {
    try { componentUpdate = validateComponentUpdate(value.componentUpdate); } catch { throw new InstallError('INSTALL_COMPONENT_DECLARATION_INVALID'); }
    const reusedSHA = componentUpdate.components === 'management' ? core.sha256
      : value.buildInputs?.[componentUpdate.components === 'core' ? 'serverInputSha256' : 'frontendInputSha256'];
    require(!frontendUpdate && (componentUpdate.components === 'management' || componentUpdate.schemaVersion === inputSchemaVersion)
      && componentUpdate.reusedInputSha256 === reusedSHA, 'INSTALL_COMPONENT_DECLARATION_INVALID');
  }
  return { files: value.files as Entry[], coreSHA: core.sha256 as string, compatibility: value.compatibility,
    buildInputs: inputSchemaVersion === 2 ? value.buildInputs : undefined, frontendUpdate, componentUpdate, inputSchemaVersion,
    backendInputSha256: value.buildInputs?.backendInputSha256 as string | undefined,
    frontendInputSha256: value.buildInputs?.frontendInputSha256 as string | undefined,
    serverInputSha256: value.buildInputs?.serverInputSha256 as string | undefined };
}

/** Component reuse binds both inputs and every byte of the reused output. */
export function assertComponentReuse(previous: Awaited<ReturnType<typeof verifyRelease>>, next: Awaited<ReturnType<typeof verifyRelease>>, previousSHA: string) {
  const update = next.componentUpdate;
  const core = update?.components === 'core';
  const management = update?.components === 'management';
  require(update && (management || update.schemaVersion === (previous.inputSchemaVersion ?? 1)
    && update.schemaVersion === (next.inputSchemaVersion ?? 1)) && update.baseManifestSha256 === previousSHA
    && update.reusedInputSha256 === (management ? previous.coreSHA : core ? previous.serverInputSha256 : previous.frontendInputSha256),
    'INSTALL_COMPONENT_BASE_CHANGED');
  const prefix = core ? 'server/.output/' : 'server/.output/public/';
  const reusedFiles = (release: typeof previous) => JSON.stringify(release.files.filter(file => management ? file.path === 'bin/mihomo' : file.path.startsWith(prefix))
    .map(file => [file.path, file.sha256, file.size, file.mode]).sort((a, b) => String(a[0]).localeCompare(String(b[0]), 'en')));
  require((core || next.coreSHA === previous.coreSHA) && (!management || previous.files.some(file => file.path === 'bin/mihomo'))
    && next.files.some(file => file.path.startsWith('server/.output/public/')) && reusedFiles(previous) === reusedFiles(next),
    'INSTALL_REUSED_PAYLOAD_CHANGED');
}
const pathHost: PathEvidenceHost = { resolve: realpath, info: async path => {
  const stat = await info(path);
  return stat ? { directory: stat.isDirectory(), file: stat.isFile(), link: stat.isSymbolicLink(),
    uid: stat.uid, mode: stat.mode, nlink: stat.nlink } : null;
} };
async function pathCheck(action: () => Promise<unknown>) {
  try { await action(); } catch (error) {
    if (error instanceof PathEvidenceError) throw new InstallError(error.code);
    throw error;
  }
}
async function trusted(path: string, leafMissing = false) {
  await pathCheck(() => assertRootControlledPath(path, pathHost, leafMissing));
}
async function executable(path: string) { await pathCheck(() => assertTrustedExecutable(path, pathHost)); }
async function run(binary: string, args: string[], timeoutMs = 15000) {
  require(Number.isSafeInteger(timeoutMs) && timeoutMs >= 1000 && timeoutMs <= 90000, 'INSTALL_TOOL_TIMEOUT_INVALID');
  return new Promise<string>((accept, reject) => execFile(binary, args, { encoding: 'utf8', timeout: timeoutMs,
    maxBuffer: 8 * 1024 * 1024, windowsHide: true, env: { PATH: '/usr/sbin:/usr/bin', LC_ALL: 'C' } },
  (error, stdout) => error ? reject(new InstallError('INSTALL_SYSTEM_QUERY_FAILED')) : accept(stdout)));
}
export async function assertDeploymentAccount(serviceUser: string, serviceUid: number) {
  require(validServiceAccountRequest(serviceUser, serviceUid), 'INSTALL_DEDICATED_ACCOUNT_REQUIRED');
  await executable('/usr/bin/getent');
  const identity = inspectServiceAccount(await run('/usr/bin/getent', ['passwd']), serviceUser, serviceUid);
  require(identity.status === 'valid', 'INSTALL_DEDICATED_ACCOUNT_REQUIRED');
}
async function privateFile(path: string, uid: number) {
  await pathCheck(() => assertPrivatePath(path, uid, pathHost));
}
async function serviceAncestors(path: string) { await pathCheck(() => assertServiceAncestors(path, pathHost)); }
async function stopped(systemctl: string, units: string[], allowReload = false) {
  for (const unit of units) {
    const value = await run(systemctl, ['show', unit, '--property=ActiveState,MainPID,ControlPID,DropInPaths,NeedDaemonReload,FragmentPath']);
    const properties = Object.fromEntries(value.trim().split('\n').map(line => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)]; }));
    require(['inactive', 'failed'].includes(properties.ActiveState) && properties.MainPID === '0' &&
      properties.ControlPID === '0' && !properties.DropInPaths && (allowReload || properties.NeedDaemonReload === 'no') &&
      (!properties.FragmentPath || properties.FragmentPath === '/etc/systemd/system/' + unit), 'INSTALL_SERVICES_MUST_BE_STOPPED');
    require(!(await info('/etc/systemd/system/' + unit + '.d')) && !(await info('/run/systemd/system/' + unit)) &&
      !(await info('/run/systemd/system/' + unit + '.d')), 'INSTALL_UNIT_OVERRIDE_CONFLICT');
    // An enabled unit would survive removal as a dangling alias. Lifecycle is explicit.
    const state = (await run(systemctl, ['show', unit, '--property=UnitFileState', '--value'])).trim();
    require(['', 'disabled', 'static', 'not-found'].includes(state), 'INSTALL_UNITS_MUST_BE_DISABLED');
  }
}
async function networkClear(input: any) {
  const n = input.runtime.automaticGateway;
  if (!n) return;
  for (const binary of ['/usr/bin/python3', '/usr/sbin/ip', '/usr/sbin/nft']) await executable(binary);
  const python = (await run('/usr/bin/python3', ['--version'])).trim().match(/^Python (\d+)\.(\d+)\./);
  require(python && (Number(python[1]) > 3 || Number(python[1]) === 3 && Number(python[2]) >= 9), 'INSTALL_PYTHON_3_9_REQUIRED');
  const tun = await info('/dev/net/tun');
  require(tun && tun.isCharacterDevice() && tun.rdev === 10 * 256 + 200, 'INSTALL_TUN_REQUIRED');
  require((await readFile('/proc/sys/net/ipv4/ip_forward', 'utf8')).trim() === '1', 'INSTALL_IPV4_FORWARDING_REQUIRED');
  const ip = (args: string[]) => run('/usr/sbin/ip', args).then(JSON.parse);
  const links = await ip(['-j', 'link', 'show']);
  require(networkObservation(() => tunConflicts(links)).length === 0, 'INSTALL_TUN_CONFLICT');
  const addresses = await ip(['-j', '-4', 'address', 'show', 'dev', n.ingressInterface]);
  require(addresses.length === 1 && addresses[0].flags.includes('UP') && addresses[0].addr_info.some((a: any) =>
    a.local === n.gatewayIPv4 && a.prefixlen === n.prefixLength), 'INSTALL_INGRESS_ADDRESS_REQUIRED');
  const rules = await ip(['-j', '-4', 'rule', 'show']);
  const ruleConflicts = networkObservation(() => policyRuleConflicts(rules, n));
  require(ruleConflicts.length === 0, ruleConflicts[0]);
  const routes = await ip(['-N', '-j', '-4', 'route', 'show', 'table', 'all']);
  require(networkObservation(() => routeConflicts(routes, n)).length === 0, 'INSTALL_ROUTE_CONFLICT');
  const tables = JSON.parse(await run('/usr/sbin/nft', ['-j', 'list', 'tables']));
  require(networkObservation(() => firewallConflicts(tables)).length === 0, 'INSTALL_NFT_CONFLICT');
  const receiptPath = '/var/lib/cocoproxy-gateway-network/network-receipt.json';
  if (await info(receiptPath)) {
    await trusted(receiptPath); await privateFile(receiptPath, 0);
    const previous = JSON.parse((await regular(receiptPath)).toString());
    require(networkObservation(() => networkReceiptRemoved(previous)), 'INSTALL_NETWORK_REMOVE_REQUIRED');
  }
}
function networkObservation<T>(action: () => T): T {
  try { return action(); } catch (error) {
    if (error instanceof NetworkObservationError) throw new InstallError(error.code);
    throw error;
  }
}
function owned(plan: DeploymentPlan): Owned[] {
  return plan.files.map(file => ({ path: file.path, mode: file.mode, owner: file.owner, sensitive: file.sensitive, sha256: digest(file.content) }));
}
export function releaseTarget(input: any, manifestSha256: string) {
  require(HASH.test(manifestSha256), 'INSTALL_MANIFEST_HASH_REQUIRED');
  const runtimeTarget = posix.dirname(absolute(input.runtime.sourceDirectory));
  const suffix = '/server/.output/server/index.mjs';
  const serverEntry = absolute(input.management.serverEntry);
  const target = serverEntry.slice(0, -suffix.length);
  require(serverEntry.endsWith(suffix) && HASH.test(posix.basename(runtimeTarget)) && posix.dirname(runtimeTarget) === posix.dirname(target) &&
    posix.basename(target) === manifestSha256 && input.runtime.sourceDirectory === runtimeTarget + '/source' &&
    input.runtime.binaryPath === runtimeTarget + '/bin/mihomo' &&
    !['/etc', '/usr', '/var', '/srv', '/opt', '/run'].includes(posix.dirname(target)), 'INSTALL_RELEASE_LAYOUT_REQUIRED');
  return target;
}

/** A UI update retains the immutable runtime tree, including its executable paths. */
export function assertFrontendFiles(previous: Owned[], current: Owned[]) {
  require(previous.length === current.length && current.every(file => previous.some(old => old.path === file.path && old.mode === file.mode &&
    old.owner === file.owner && old.sensitive === file.sensitive &&
    (file.path === '/etc/systemd/system/cocoproxy-management.service' || old.sha256 === file.sha256))), 'INSTALL_FRONTEND_SCOPE_CHANGED');
}

export async function verifyRuntimeRelease(receipt: Receipt) {
  if (!receipt.runtimeManifestSha256 || receipt.runtimeManifestSha256 === receipt.manifestSha256) return;
  const runtime = posix.join(posix.dirname(receipt.release), receipt.runtimeManifestSha256);
  await trusted(runtime);
  const release = await verifyRelease(runtime, receipt.runtimeManifestSha256);
  for (const entry of release.files) {
    await trusted(runtime + '/' + entry.path);
    require(((await lstat(runtime + '/' + entry.path)).mode & 0o7777) === parseInt(entry.mode, 8), 'INSTALL_RELEASE_PERMISSIONS_CHANGED');
  }
}
async function checkOwned(files: Owned[]) {
  for (const file of files) {
    await trusted(posix.dirname(file.path));
    const stat = await info(file.path);
    require(stat && stat.isFile() && stat.nlink === 1 && stat.uid === (file.owner === 'root' ? 0 : file.owner) &&
      (stat.mode & 0o7777) === parseInt(file.mode, 8) && digest(await regular(file.path)) === file.sha256, 'INSTALL_OWNED_FILE_CHANGED');
  }
}
async function writeExclusive(path: string, bytes: Buffer | string, mode: number, uid = 0) {
  const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, mode);
  try { await handle.writeFile(bytes); await handle.chown(uid, 0); await handle.chmod(mode); await handle.sync(); } finally { await handle.close(); }
}
async function atomic(path: string, bytes: string, mode: number, uid = 0) {
  const temporary = posix.dirname(path) + '/.cocoproxy-install-' + randomUUID();
  await writeExclusive(temporary, bytes, mode, uid);
  await rename(temporary, path);
  const directory = await open(posix.dirname(path), constants.O_RDONLY | constants.O_DIRECTORY);
  try { await directory.sync(); } finally { await directory.close(); }
}

export async function prepareUpgrade(options: Omit<InstallOptions, 'operation' | 'apply' | 'reviewedConfigurationSha256'>) {
  return deployment({ ...options, operation: 'upgrade', apply: false }, true);
}
export async function deployRelease(options: InstallOptions) { return deployment(options, false); }

async function deployment(options: InstallOptions, preparing: boolean) {
  require(platform() === 'linux' && process.getuid?.() === 0, 'INSTALL_LINUX_ROOT_REQUIRED');
  require(['install', 'upgrade', 'uninstall'].includes(options.operation), 'INSTALL_OPERATION_INVALID');
  require(options.reviewedConfigurationSha256 === undefined || options.operation === 'upgrade', 'INSTALL_CONFIGURATION_REVIEW_UPGRADE_ONLY');
  const payload = absolute(options.payload), inputPath = absolute(options.input);
  // Input and payload are operator-owned trusted material. They never enter the receipt.
  await trusted(payload); await trusted(inputPath); await privateFile(inputPath, 0);
  const release = await verifyRelease(payload, options.manifestSha256);
  const frontend = Boolean(release.frontendUpdate) && options.operation !== 'uninstall';
  require(!options.preserveRuntime || options.operation === 'upgrade' && release.componentUpdate?.components !== 'core', 'INSTALL_RUNTIME_PRESERVATION_UPGRADE_ONLY');
  const preserveRuntime = frontend || Boolean(options.preserveRuntime);
  require(!release.frontendUpdate || ['upgrade', 'uninstall'].includes(options.operation), 'INSTALL_FRONTEND_EXISTING_INSTALL_REQUIRED');
  require(!release.componentUpdate || ['upgrade', 'uninstall'].includes(options.operation), 'INSTALL_COMPONENT_EXISTING_INSTALL_REQUIRED');
  await trusted(payload + '/manifest.json');
  for (const entry of release.files) await trusted(payload + '/' + entry.path);
  const inputBytes = await regular(inputPath, 128 * 1024);
  const input = JSON.parse(inputBytes.toString());
  const plan = renderDeploymentPlan(input), target = releaseTarget(input, options.manifestSha256);
  if (!preserveRuntime && options.operation !== 'uninstall') require(posix.dirname(input.runtime.sourceDirectory) === target, 'INSTALL_RELEASE_LAYOUT_REQUIRED');
  if (input.web) await verifyManagedWeb({ web: input.web, gatewayIPv4: input.runtime.automaticGateway.gatewayIPv4,
    origin: input.management.origin, listenPort: input.management.listenPort, serviceUid: input.runtime.serviceUid });
  if (input.runtime.automaticGateway) require(release.files.some(file => file.path === 'source/apps/gateway/network.py'),
    'INSTALL_PAYLOAD_NETWORK_HELPER_MISSING');
  const reserved = (path: string) => path === STORE || path.startsWith(STORE + '/') || STORE.startsWith(path + '/');
  require(![target, input.runtime.stateDirectory, input.management.credentialPath, ...plan.files.map(file => file.path)].some(reserved),
    'INSTALL_RECEIPT_PATH_OVERLAP');
  require(payload !== target && !payload.startsWith(target + '/') && !target.startsWith(payload + '/'), 'INSTALL_PAYLOAD_TARGET_OVERLAP');
  require(input.runtime.binarySha256 === release.coreSHA, 'INSTALL_CORE_HASH_MISMATCH');
  const core = await regular(payload + '/bin/mihomo', 256 * 1024 * 1024);
  const host = ({ aarch64: { node: 'arm64', elf: 183 }, x86_64: { node: 'x64', elf: 62 } } as
    Record<string, { node: string; elf: number }>)[machine()];
  require(core.length >= 20 && core.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70])) && core[4] === 2 && core[5] === 1 &&
    host && host.node === arch() && host.elf === core.readUInt16LE(18), 'INSTALL_CORE_ARCH_UNSUPPORTED');
  await executable(input.runtime.nodePath); await executable(input.runtime.systemctlPath); await executable('/usr/bin/getent');
  for (const path of [target + '/source', input.runtime.stateDirectory, input.management.credentialPath,
    input.runtime.nodePath, input.runtime.systemctlPath, ...plan.files.filter(file => file.owner !== 'root').map(file => file.path)]) {
    await serviceAncestors(path);
  }
  for (const path of [input.runtime.nodePath, input.runtime.systemctlPath]) {
    const resolved = await realpath(path); await serviceAncestors(resolved);
    require(((await lstat(resolved)).mode & 0o005) === 0o005, 'INSTALL_SERVICE_TOOL_ACCESS_REQUIRED');
  }
  const version = (await run(input.runtime.nodePath, ['--version'])).trim().match(/^v(\d+)\.(\d+)\.(\d+)$/);
  require(version && (Number(version[1]) > 22 || Number(version[1]) === 22 && Number(version[2]) >= 18), 'INSTALL_NODE_22_18_REQUIRED');
  require(await info('/run/systemd/system'), 'INSTALL_SYSTEMD_REQUIRED');
  await trusted('/etc/polkit-1/rules.d');
  require((await run(input.runtime.systemctlPath, ['show', 'polkit.service', '--property=LoadState', '--value'])).trim() === 'loaded',
    'INSTALL_POLKIT_REQUIRED');
  await assertDeploymentAccount(input.management.serviceUser, input.runtime.serviceUid);
  const units = [...(preserveRuntime ? [] : ['cocoproxy-mihomo.service', 'cocoproxy-gateway-network.service', 'cocoproxy-gateway-guard.service']), 'cocoproxy-management.service',
    ...(input.web ? ['cocoproxy-web.service'] : [])];
  await assertDeploymentLifecycle(input.runtime.stateDirectory, input.runtime.serviceUid, preparing || preserveRuntime);
  if (!preparing) await stopped(input.runtime.systemctlPath, units);
  await trusted(posix.dirname(target)); await trusted(STORE, true);
  if (await info(STORE)) require(((await lstat(STORE)).mode & 0o7777) === 0o700, 'INSTALL_RECEIPT_DIRECTORY_PRIVATE_REQUIRED');
  require(!(await info(STORE + '/install.lock')), 'INSTALL_PREVIOUS_APPLY_INCOMPLETE');
  const currentFiles = owned(plan); let previous: Receipt | null = null;
  let runtimePreservation: ReturnType<typeof assessRuntimePreservation> | undefined;
  if (await info(RECEIPT)) {
    await trusted(RECEIPT); await privateFile(RECEIPT, 0);
    previous = validateReceipt(JSON.parse((await regular(RECEIPT)).toString()));
    require(previous?.schemaVersion === 1 && previous.status === 'complete' && HASH.test(previous.manifestSha256) &&
      posix.basename(previous.release) === previous.manifestSha256 && previous.serviceUid === input.runtime.serviceUid &&
      previous.stateDirectory === input.runtime.stateDirectory && previous.credentialPath === input.management.credentialPath &&
      compatibleOwnedFiles(previous.files, currentFiles, options.operation === 'upgrade'), 'INSTALL_RECEIPT_MISMATCH_OR_INCOMPLETE');
    await checkOwned(previous.files);
    await verifyRuntimeRelease(previous);
    for (const file of currentFiles.filter(file => !previous!.files.some(old => old.path === file.path))) {
      require(!(await info(file.path)), 'INSTALL_EXISTING_FILE_CONFLICT');
    }
    await trusted(previous.release);
    await trusted(previous.release + '/manifest.json');
    const oldRelease = await verifyRelease(previous.release, previous.manifestSha256);
    runtimePreservation = assessRuntimePreservation(oldRelease, release);
    if (options.preserveRuntime) {
      require(runtimePreservation.eligible, 'INSTALL_RUNTIME_PRESERVATION_INCOMPATIBLE');
      require(posix.dirname(input.runtime.sourceDirectory) === posix.join(posix.dirname(target), previous.runtimeManifestSha256 ?? previous.manifestSha256),
        'INSTALL_FRONTEND_RUNTIME_CHANGED');
      assertFrontendFiles(previous.files, currentFiles);
    }
    if (release.componentUpdate && options.operation === 'upgrade') assertComponentReuse(oldRelease, release, previous.manifestSha256);
    if (frontend && options.operation === 'upgrade') {
      require(previous.manifestSha256 === release.frontendUpdate!.baseManifestSha256 &&
        oldRelease.inputSchemaVersion === release.frontendUpdate!.schemaVersion &&
        oldRelease.backendInputSha256 === release.frontendUpdate!.backendInputSha256 && oldRelease.coreSHA === release.coreSHA,
      'INSTALL_FRONTEND_BASE_CHANGED');
      require(posix.dirname(input.runtime.sourceDirectory) === posix.join(posix.dirname(target), previous.runtimeManifestSha256 ?? previous.manifestSha256),
        'INSTALL_FRONTEND_RUNTIME_CHANGED');
      assertFrontendFiles(previous.files, currentFiles);
    } else if (!preserveRuntime && options.operation !== 'uninstall') {
      require(posix.dirname(input.runtime.sourceDirectory) === target, 'INSTALL_RELEASE_LAYOUT_REQUIRED');
    }
    for (const entry of oldRelease.files) {
      const path = previous.release + '/' + entry.path;
      await trusted(path);
      require(((await lstat(path)).mode & 0o7777) === parseInt(entry.mode, 8), 'INSTALL_RELEASE_PERMISSIONS_CHANGED');
    }
  }
  require(options.operation === 'install' ? !previous : previous, 'INSTALL_OPERATION_RECEIPT_REQUIRED');
  for (const directory of plan.directories) {
    await pathCheck(() => assertPlannedDeploymentDirectory(directory, plan.directories, pathHost));
  }
  await trusted(posix.dirname(input.management.credentialPath), true);
  if (await info(input.management.credentialPath)) await privateFile(input.management.credentialPath, input.runtime.serviceUid);
  if (options.operation === 'install') {
    require(!(await info(target)), 'INSTALL_TARGET_EXISTS');
    for (const file of plan.files) require(!(await info(file.path)), 'INSTALL_EXISTING_FILE_CONFLICT');
  }
  let configurationReviewed = false;
  let review: { digest: string; configurationChanged: boolean; changedFiles: string[]; authorization: 'required-on-apply' } | undefined;
  if (options.operation === 'upgrade') {
    require(previous!.release !== target && !(await info(target)), 'INSTALL_UPGRADE_NEW_RELEASE_REQUIRED');
    // A separate explicit review permits schema-validated configuration migration;
    // receipt identity, owners, paths and lifecycle checks above remain mandatory.
    let unchanged = !(input.web && !previous!.files.some(file => file.path === '/etc/systemd/system/cocoproxy-web.service'));
    for (const file of plan.files.filter(file => file.sensitive)) {
      if (file.path !== input.runtime.settingsPath) {
        unchanged &&= digest(file.content) === previous!.files.find(old => old.path === file.path)?.sha256;
      } else {
        const old = JSON.parse((await regular(file.path)).toString()), next = JSON.parse(file.content);
        for (const key of ['binaryPath', 'binarySha256', 'unitSha256']) { delete old[key]; delete next[key]; }
        unchanged &&= JSON.stringify(old) === JSON.stringify(next);
      }
    }
    const configuration = { previousManifestSha256: previous!.manifestSha256,
      manifestSha256: options.manifestSha256, inputSha256: digest(inputBytes),
      previousConfiguration: previous!.files.filter(file => file.sensitive).map(file => ({ path: file.path, sha256: file.sha256 })) };
    if (preparing) review = { digest: configurationReviewDigest(configuration), configurationChanged: !unchanged,
      changedFiles: currentFiles.filter(file => file.sensitive && file.sha256 !== previous!.files.find(old => old.path === file.path)?.sha256).map(file => file.path),
      authorization: 'required-on-apply' };
    else configurationReviewed = assertReviewedUpgradeConfiguration(configuration, options.reviewedConfigurationSha256, unchanged);
  }
  const declaration = JSON.parse((await regular(payload + '/manifest.json')).toString()).compatibility;
  const stateHost = deploymentStateHost(input.runtime.stateDirectory, input.runtime.serviceUid);
  const inspectedState = options.operation === 'upgrade' ? await inspectStateCompatibility(stateHost, declaration) : undefined;
  const stateCompatibility = inspectedState?.findings ?? [];
  if (!preparing && options.operation === 'upgrade') assertDeploymentStateCompatibility(stateCompatibility);
  let compatibilityAssessment: Awaited<ReturnType<typeof createUpgradeAssessment>> | undefined;
  if (options.operation === 'upgrade') {
    const oldRuntime = parseRuntimeSettings(JSON.parse((await regular(input.runtime.settingsPath, 65536)).toString()));
    const newRuntime = parseRuntimeSettings(JSON.parse(plan.files.find(file => file.path === input.runtime.settingsPath)!.content));
    const oldManagement = JSON.parse((await regular(input.management.settingsPath, 65536)).toString());
    const newManagement = JSON.parse(plan.files.find(file => file.path === input.management.settingsPath)!.content);
    let credential: unknown, credentialObserved = false;
    if (await info(input.management.credentialPath)) {
      await privateFile(input.management.credentialPath, input.runtime.serviceUid);
      const bytes = await regular(input.management.credentialPath, 16384); credentialObserved = true;
      try { credential = JSON.parse(bytes.toString()); } catch { credential = null; }
    }
    const networkReceiptPath = '/var/lib/cocoproxy-gateway-network/network-receipt.json';
    let networkReceipt: { observation: 'absent' | 'read' | 'unavailable'; value?: unknown };
    try {
      if (!await info(networkReceiptPath)) networkReceipt = { observation: 'absent' };
      else {
        await trusted(networkReceiptPath); await privateFile(networkReceiptPath, 0);
        const bytes = await regular(networkReceiptPath, 4 * 1024 * 1024);
        try { networkReceipt = { observation: 'read', value: JSON.parse(bytes.toString()) }; }
        catch { networkReceipt = { observation: 'read', value: null }; }
      }
    } catch { networkReceipt = { observation: 'unavailable' }; }
    compatibilityAssessment = await createUpgradeAssessment({ targetDeclaration: declaration, currentRuntime: oldRuntime, targetRuntime: newRuntime,
      currentManagement: oldManagement, targetManagement: newManagement, credential, credentialObserved, networkReceipt }, stateHost, inspectedState);
    if (!preparing) {
      require(compatibilityAssessment.assessments.historyCandidates.status !== 'unsupported', 'INSTALL_HISTORY_CANDIDATE_UNSUPPORTED');
      require(compatibilityAssessment.assessments.historyCandidates.status !== 'unknown', 'INSTALL_HISTORY_COMPATIBILITY_NOT_DECLARED');
      require(compatibilityAssessment.assessments.configuration.status !== 'unsupported', 'INSTALL_CONFIGURATION_FORMAT_UNSUPPORTED');
      require(compatibilityAssessment.assessments.configuration.status !== 'unknown', 'INSTALL_CONFIGURATION_COMPATIBILITY_NOT_DECLARED');
    }
  }
  if (options.operation === 'uninstall') {
    require(previous!.release === target && previous!.manifestSha256 === options.manifestSha256 &&
      currentFiles.every(file => previous!.files.some(old => old.path === file.path && old.sha256 === file.sha256)), 'INSTALL_UNINSTALL_INPUT_MISMATCH');
  }
  if (!preparing && !preserveRuntime) await networkClear(input);
  // No mkdir, receipt, locks, temp files or helper execution before --apply.
  const preview = { operation: preparing ? 'prepare' : options.operation, apply: Boolean(options.apply), release: target,
    files: plan.files.map(file => ({ path: file.path, mode: file.mode, owner: file.owner,
      action: options.operation === 'uninstall' ? file.sensitive ? 'preserve' : 'remove' : 'write' })),
    preserved: [input.runtime.stateDirectory, input.management.credentialPath, '/var/lib/cocoproxy-gateway-network'],
    services: preserveRuntime ? 'management and dependent HTTPS only; runtime and network preserved' : preparing ? 'running services allowed; apply still requires stopped and disabled units' : 'remain stopped and disabled',
    ...(runtimePreservation ? { runtimePreservation } : {}),
    network: 'unchanged', configurationReviewed, ...(review ? { review } : {}),
    ...(preparing ? { readiness: [compatibilityAssessment!.assessments.state, compatibilityAssessment!.assessments.configuration,
      compatibilityAssessment!.assessments.historyCandidates].some(item => item.status === 'unsupported') ? 'compatibility-unsupported' :
      [compatibilityAssessment!.assessments.state, compatibilityAssessment!.assessments.configuration,
        compatibilityAssessment!.assessments.historyCandidates].some(item => item.status === 'unknown') ? 'compatibility-evidence-incomplete' : 'prepared-not-applied',
    readinessScope: 'required-static-formats-ready-for-maintenance-preparation',
    stateCompatibility, compatibilityAssessment, compatibilityLimitations: ['supported results cover observed content and explicit reader formats only',
      'candidate core syntax and actual runtime remain separately unverified', 'full network receipt resources and live ownership require old helper validation',
      'future state writes must be reassessed before program rollback'],
    applyPrerequisites: preserveRuntime ? ['explicit operator authorization', 'stop and drain management writers',
      'preserve pinned runtime files and network', 'repeat complete apply preflight'] : ['explicit operator authorization',
      'pause automatic lifecycle', 'stop and disable deployment units', 'remove owned gateway network resources', 'repeat complete apply preflight'],
    state: { action: 'preserve-in-place', automaticProgramRollback: false } } : {}) };
  if (!options.apply) return preview;
  if (!(await info(STORE))) { await mkdir(STORE, { mode: 0o700 }); await chown(STORE, 0, 0); await chmod(STORE, 0o700); }
  // Exclusive intent lock survives errors/crashes. An operator must inspect the
  // pending receipt before recovery; never guess/overwrite an incomplete install.
  const lock = STORE + '/install.lock';
  const identity = await deploymentProcessIdentity(process.pid);
  require(identity.startTime !== null, 'INSTALL_PROCESS_IDENTITY_UNAVAILABLE');
  const lockOwner: DeploymentLock = { schemaVersion: 1, id: randomUUID(), pid: process.pid,
    bootId: identity.bootId, startTime: identity.startTime };
  await writeExclusive(lock, JSON.stringify(lockOwner) + '\n', 0o600);
  // Catch a concurrent completed installer between read-only preflight and lock.
  // No target changes have occurred yet, so these checks can release our lock.
  try {
    const observed = await info(RECEIPT) ? JSON.parse((await regular(RECEIPT)).toString()) : null;
    require(JSON.stringify(observed) === JSON.stringify(previous), 'INSTALL_RECEIPT_CHANGED');
    if (options.operation !== 'uninstall') require(!(await info(target)), 'INSTALL_TARGET_EXISTS');
    if (previous) await checkOwned(previous.files);
    require(digest(await regular(inputPath, 128 * 1024)) === digest(inputBytes), 'INSTALL_INPUT_CHANGED');
    await assertDeploymentLifecycle(input.runtime.stateDirectory, input.runtime.serviceUid, preserveRuntime);
    if (options.operation === 'upgrade') assertDeploymentStateCompatibility((await inspectStateCompatibility(stateHost, declaration)).findings);
    await stopped(input.runtime.systemctlPath, units);
    if (!preserveRuntime) await networkClear(input);
  } catch (error) { await unlink(lock); throw error; }
  const next: Receipt = { schemaVersion: 1, status: 'pending', release: target, manifestSha256: options.manifestSha256,
    files: currentFiles, serviceUid: input.runtime.serviceUid, stateDirectory: input.runtime.stateDirectory,
    credentialPath: input.management.credentialPath, transaction: { id: lockOwner.id, operation: options.operation } };
  if (preserveRuntime) next.runtimeManifestSha256 = previous!.runtimeManifestSha256 ?? previous!.manifestSha256;
  await atomic(RECEIPT, JSON.stringify(next) + '\n', 0o600);
  if (options.operation === 'uninstall') {
    for (const file of plan.files.filter(file => !file.sensitive)) await unlink(file.path);
  } else {
    for (const directory of [...plan.directories].sort((a, b) => a.path.split('/').length - b.path.split('/').length)) if (!(await info(directory.path))) {
      await mkdir(directory.path, { mode: parseInt(directory.mode, 8) });
      await chown(directory.path, directory.owner === 'root' ? 0 : directory.owner, 0);
      await chmod(directory.path, parseInt(directory.mode, 8));
    }
    await mkdir(target, { mode: 0o755 });
    await chmod(target, 0o755); await chown(target, 0, 0);
    for (const entry of release.files) {
      const path = target + '/' + entry.path;
      await mkdir(posix.dirname(path), { recursive: true, mode: 0o755 });
      // mkdir modes are affected by the caller's umask. Newly copied runtime
      // parents must remain readable by the dedicated service identity.
      let directory = posix.dirname(path);
      while (directory !== target) { await chmod(directory, 0o755); await chown(directory, 0, 0); directory = posix.dirname(directory); }
      await writeExclusive(path, await regular(payload + '/' + entry.path, 256 * 1024 * 1024), parseInt(entry.mode, 8));
    }
    await writeExclusive(target + '/manifest.json', await regular(payload + '/manifest.json'), 0o644);
    await verifyRelease(target, options.manifestSha256);
    for (const file of plan.files.filter(file => !preserveRuntime || file.path === '/etc/systemd/system/cocoproxy-management.service')) {
      await atomic(file.path, file.content, parseInt(file.mode, 8), file.owner === 'root' ? 0 : file.owner);
    }
    await checkOwned(currentFiles);
  }
  await run(input.runtime.systemctlPath, ['daemon-reload']);
  next.status = options.operation === 'uninstall' ? 'uninstalled' : 'complete';
  await atomic(RECEIPT, JSON.stringify(next) + '\n', 0o600);
  await unlink(lock);
  return preview;
}

// Shared host checks keep inspection and finalization at the installer's trust boundary.
export { info as deploymentPathInfo, trusted as assertRootPath, regular as readRegularDeploymentFile,
  privateFile as assertPrivateDeploymentFile, checkOwned as assertOwnedDeploymentFiles,
  executable as assertDeploymentExecutable, stopped as assertDeploymentStopped,
  run as runDeploymentTool, atomic as writeAtomicDeploymentFile };
