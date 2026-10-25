import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, chown, lstat, mkdir, open, readFile, readdir, realpath, rename, unlink } from 'node:fs/promises';
import { posix, resolve } from 'node:path';
import { arch, machine, platform } from 'node:os';
import { execFile } from 'node:child_process';
import { renderDeploymentPlan, type DeploymentPlan } from './plan.ts';

// This is deliberately an offline file installer. Service lifecycle, router
// activation and the existing root network helper remain separate operations.
const STORE = '/var/lib/cocoproxy-deployment';
const RECEIPT = STORE + '/receipt.json';
const HASH = /^[a-f0-9]{64}$/;
type Operation = 'install' | 'upgrade' | 'uninstall';
type Entry = { path: string; sha256: string; size: number; mode: string };
type Owned = { path: string; sha256: string; mode: string; owner: 'root' | number; sensitive: boolean };
type Receipt = { schemaVersion: 1; status: 'pending' | 'complete' | 'uninstalled'; release: string;
  manifestSha256: string; files: Owned[]; serviceUid: number; stateDirectory: string; credentialPath: string };
export type InstallOptions = { payload: string; input: string; manifestSha256: string; operation: Operation; apply?: boolean; reviewedConfigurationSha256?: string };
export class InstallError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.name = 'InstallError'; this.code = code; }
}
/** Installation must not race the opt-in background runtime reconciler. */
export function assertMaintenanceLifecycle(value: unknown): void {
  require(value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === 'enabled,paused,schemaVersion' &&
    (value as any).schemaVersion === 1 && typeof (value as any).enabled === 'boolean' &&
    typeof (value as any).paused === 'boolean', 'INSTALL_LIFECYCLE_INVALID');
  require(!(value as any).enabled || (value as any).paused, 'INSTALL_LIFECYCLE_MUST_BE_PAUSED');
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
    /^(source|server|bin)\//.test(path), 'INSTALL_MANIFEST_PATH_INVALID');
  return path;
}
async function regular(path: string, limit = 8 * 1024 * 1024) {
  const stat = await lstat(path);
  require(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size <= limit, 'INSTALL_REGULAR_FILE_REQUIRED');
  return readFile(path);
}
/** No links, sockets, devices, private areas or unlisted files enter a release. */
export async function verifyRelease(payload: string, expected: string): Promise<{ files: Entry[]; coreSHA: string }> {
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
  return { files: value.files, coreSHA: core.sha256 };
}
/** Existing path components must be root-controlled; missing leaves are explicit. */
async function trusted(path: string, leafMissing = false) {
  absolute(path);
  let current = '';
  for (const part of path.slice(1).split('/')) {
    current += '/' + part;
    const stat = await info(current);
    if (!stat && leafMissing && current === path) return;
    require(stat && !stat.isSymbolicLink() && stat.uid === 0 && !(stat.mode & 0o022), 'INSTALL_ROOT_OWNERSHIP_REQUIRED');
    if (current !== path) require(stat.isDirectory(), 'INSTALL_DIRECTORY_REQUIRED');
  }
}
async function executable(path: string) {
  // Permit distro usr-merge/python links, checking each link owner and parent.
  let current = path;
  for (let count = 0; count < 16; count++) {
    const parts = current.slice(1).split('/'); let prefix = ''; let changed = false;
    for (let index = 0; index < parts.length; index++) {
      prefix += '/' + parts[index]; const stat = await info(prefix);
      require(stat, 'INSTALL_REQUIRED_SYSTEM_TOOL_MISSING');
      require(stat.uid === 0 && (stat.isSymbolicLink() || !(stat.mode & 0o022)), 'INSTALL_TOOL_UNTRUSTED');
      if (stat.isSymbolicLink()) {
        current = await realpath(prefix) + (index + 1 < parts.length ? '/' + parts.slice(index + 1).join('/') : '');
        changed = true; break;
      }
    }
    if (!changed) { await trusted(current); require((await lstat(current)).isFile() && ((await lstat(current)).mode & 0o111), 'INSTALL_TOOL_NOT_EXECUTABLE'); return; }
  }
  throw new InstallError('INSTALL_TOOL_LINK_LIMIT');
}
async function run(binary: string, args: string[]) {
  return new Promise<string>((accept, reject) => execFile(binary, args, { encoding: 'utf8', timeout: 15000,
    maxBuffer: 8 * 1024 * 1024, windowsHide: true, env: { PATH: '/usr/sbin:/usr/bin', LC_ALL: 'C' } },
  (error, stdout) => error ? reject(new InstallError('INSTALL_SYSTEM_QUERY_FAILED')) : accept(stdout)));
}
async function privateFile(path: string, uid: number) {
  const stat = await info(path);
  require(stat && stat.isFile() && stat.nlink === 1 && stat.uid === uid && (stat.mode & 0o7777) === 0o600,
    'INSTALL_PRIVATE_FILE_OWNERSHIP');
}
async function serviceAncestors(path: string) {
  let parent = posix.dirname(path);
  while (parent !== '/') {
    const stat = await info(parent);
    if (stat) require(stat.isDirectory() && Boolean(stat.mode & 0o001), 'INSTALL_SERVICE_TRAVERSE_REQUIRED');
    parent = posix.dirname(parent);
  }
}
async function stopped(systemctl: string, units: string[]) {
  for (const unit of units) {
    const value = await run(systemctl, ['show', unit, '--property=ActiveState,MainPID,ControlPID,DropInPaths,NeedDaemonReload,FragmentPath']);
    const properties = Object.fromEntries(value.trim().split('\n').map(line => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)]; }));
    require(['inactive', 'failed'].includes(properties.ActiveState) && properties.MainPID === '0' &&
      properties.ControlPID === '0' && !properties.DropInPaths && properties.NeedDaemonReload === 'no' &&
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
  require(!links.some((l: any) => l.ifname === 'cocoproxy-tun'), 'INSTALL_TUN_CONFLICT');
  const addresses = await ip(['-j', '-4', 'address', 'show', 'dev', n.ingressInterface]);
  require(addresses.length === 1 && addresses[0].flags.includes('UP') && addresses[0].addr_info.some((a: any) =>
    a.local === n.gatewayIPv4 && a.prefixlen === n.prefixLength), 'INSTALL_INGRESS_ADDRESS_REQUIRED');
  const rules = await ip(['-j', '-4', 'rule', 'show']);
  require(!rules.some((r: any) => [n.egressPriority, n.egressPriority + 1, n.egressPriority + 2].includes(r.priority) ||
    r.priority >= 9000 && r.priority <= 9010), 'INSTALL_RULE_CONFLICT');
  const routes = await ip(['-N', '-j', '-4', 'route', 'show', 'table', 'all']);
  require(!routes.some((r: any) => [String(n.egressTable), ...(n.clientCIDR ? [String(n.egressTable + 20000)] : []), '2022'].includes(String(r.table)) ||
    (r.table === 'main' || r.table === 254 || r.table === undefined) && [n.clientIPv4, n.clientIPv4 + '/32'].includes(r.dst)), 'INSTALL_ROUTE_CONFLICT');
  const tables = JSON.parse(await run('/usr/sbin/nft', ['-j', 'list', 'tables']));
  require(!tables.nftables.some((t: any) => ['cocoproxy_auto_guard', 'mihomo'].includes(t.table?.name)), 'INSTALL_NFT_CONFLICT');
  const receiptPath = '/var/lib/cocoproxy-gateway-network/network-receipt.json';
  if (await info(receiptPath)) {
    await trusted(receiptPath); await privateFile(receiptPath, 0);
    const previous = JSON.parse((await regular(receiptPath)).toString());
    require(previous.schemaVersion === 1 && previous.status === 'removed', 'INSTALL_NETWORK_REMOVE_REQUIRED');
  }
}
function owned(plan: DeploymentPlan): Owned[] {
  return plan.files.map(file => ({ path: file.path, mode: file.mode, owner: file.owner, sensitive: file.sensitive, sha256: digest(file.content) }));
}
export function releaseTarget(input: any, manifestSha256: string) {
  require(HASH.test(manifestSha256), 'INSTALL_MANIFEST_HASH_REQUIRED');
  const target = posix.dirname(absolute(input.runtime.sourceDirectory));
  require(posix.basename(target) === manifestSha256 && input.runtime.sourceDirectory === target + '/source' &&
    input.runtime.binaryPath === target + '/bin/mihomo' && input.management.serverEntry === target + '/server/.output/server/index.mjs' &&
    !['/etc', '/usr', '/var', '/srv', '/opt', '/run'].includes(posix.dirname(target)), 'INSTALL_RELEASE_LAYOUT_REQUIRED');
  return target;
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

export async function deployRelease(options: InstallOptions) {
  require(platform() === 'linux' && process.getuid?.() === 0, 'INSTALL_LINUX_ROOT_REQUIRED');
  require(['install', 'upgrade', 'uninstall'].includes(options.operation), 'INSTALL_OPERATION_INVALID');
  require(options.reviewedConfigurationSha256 === undefined || options.operation === 'upgrade', 'INSTALL_CONFIGURATION_REVIEW_UPGRADE_ONLY');
  const payload = absolute(options.payload), inputPath = absolute(options.input);
  // Input and payload are operator-owned trusted material. They never enter the receipt.
  await trusted(payload); await trusted(inputPath); await privateFile(inputPath, 0);
  const release = await verifyRelease(payload, options.manifestSha256);
  await trusted(payload + '/manifest.json');
  for (const entry of release.files) await trusted(payload + '/' + entry.path);
  const inputBytes = await regular(inputPath, 128 * 1024);
  const input = JSON.parse(inputBytes.toString());
  const plan = renderDeploymentPlan(input), target = releaseTarget(input, options.manifestSha256);
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
  const accounts = (await run('/usr/bin/getent', ['passwd'])).trim().split('\n').map(line => line.split(':'));
  require(accounts.filter(a => a[0] === input.management.serviceUser).length === 1 &&
    accounts.filter(a => Number(a[2]) === input.runtime.serviceUid).length === 1 &&
    accounts.some(a => a[0] === input.management.serviceUser && Number(a[2]) === input.runtime.serviceUid &&
      ['/usr/sbin/nologin', '/sbin/nologin', '/bin/false', '/usr/bin/false'].includes(a[6])), 'INSTALL_DEDICATED_ACCOUNT_REQUIRED');
  const units = ['cocoproxy-mihomo.service', 'cocoproxy-management.service', 'cocoproxy-gateway-network.service'];
  const lifecyclePath = posix.join(input.runtime.stateDirectory, 'lifecycle.json');
  if (await info(lifecyclePath)) {
    await privateFile(lifecyclePath, input.runtime.serviceUid);
    let lifecycle: unknown;
    try { lifecycle = JSON.parse((await regular(lifecyclePath, 4096)).toString('utf8')); }
    catch { throw new InstallError('INSTALL_LIFECYCLE_INVALID'); }
    assertMaintenanceLifecycle(lifecycle);
  }
  await stopped(input.runtime.systemctlPath, units);
  await trusted(posix.dirname(target)); await trusted(STORE, true);
  if (await info(STORE)) require(((await lstat(STORE)).mode & 0o7777) === 0o700, 'INSTALL_RECEIPT_DIRECTORY_PRIVATE_REQUIRED');
  require(!(await info(STORE + '/install.lock')), 'INSTALL_PREVIOUS_APPLY_INCOMPLETE');
  const currentFiles = owned(plan); let previous: Receipt | null = null;
  if (await info(RECEIPT)) {
    await trusted(RECEIPT); await privateFile(RECEIPT, 0);
    previous = JSON.parse((await regular(RECEIPT)).toString());
    require(previous?.schemaVersion === 1 && previous.status === 'complete' && HASH.test(previous.manifestSha256) &&
      posix.basename(previous.release) === previous.manifestSha256 && previous.serviceUid === input.runtime.serviceUid &&
      previous.stateDirectory === input.runtime.stateDirectory && previous.credentialPath === input.management.credentialPath &&
      previous.files.length === currentFiles.length && previous.files.every(old => currentFiles.some(file => file.path === old.path &&
        file.mode === old.mode && file.owner === old.owner && file.sensitive === old.sensitive)), 'INSTALL_RECEIPT_MISMATCH_OR_INCOMPLETE');
    await checkOwned(previous.files);
    await trusted(previous.release);
    await trusted(previous.release + '/manifest.json');
    const oldRelease = await verifyRelease(previous.release, previous.manifestSha256);
    for (const entry of oldRelease.files) {
      const path = previous.release + '/' + entry.path;
      await trusted(path);
      require(((await lstat(path)).mode & 0o7777) === parseInt(entry.mode, 8), 'INSTALL_RELEASE_PERMISSIONS_CHANGED');
    }
  }
  require(options.operation === 'install' ? !previous : previous, 'INSTALL_OPERATION_RECEIPT_REQUIRED');
  for (const directory of plan.directories) {
    await trusted(posix.dirname(directory.path));
    const stat = await info(directory.path);
    if (stat) require(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === (directory.owner === 'root' ? 0 : directory.owner) &&
      (directory.mode === '0700' ? (stat.mode & 0o7777) === 0o700 : !(stat.mode & 0o022)), 'INSTALL_DIRECTORY_OWNERSHIP_CONFLICT');
  }
  await trusted(posix.dirname(input.management.credentialPath), true);
  if (await info(input.management.credentialPath)) await privateFile(input.management.credentialPath, input.runtime.serviceUid);
  if (options.operation === 'install') {
    require(!(await info(target)), 'INSTALL_TARGET_EXISTS');
    for (const file of plan.files) require(!(await info(file.path)), 'INSTALL_EXISTING_FILE_CONFLICT');
  }
  let configurationReviewed = false;
  if (options.operation === 'upgrade') {
    require(previous!.release !== target && !(await info(target)), 'INSTALL_UPGRADE_NEW_RELEASE_REQUIRED');
    // A separate explicit review permits schema-validated configuration migration;
    // receipt identity, owners, paths and lifecycle checks above remain mandatory.
    let unchanged = true;
    for (const file of plan.files.filter(file => file.sensitive)) {
      if (file.path !== input.runtime.settingsPath) {
        unchanged &&= digest(file.content) === previous!.files.find(old => old.path === file.path)?.sha256;
      } else {
        const old = JSON.parse((await regular(file.path)).toString()), next = JSON.parse(file.content);
        for (const key of ['binaryPath', 'binarySha256', 'unitSha256']) { delete old[key]; delete next[key]; }
        unchanged &&= JSON.stringify(old) === JSON.stringify(next);
      }
    }
    configurationReviewed = assertReviewedUpgradeConfiguration({ previousManifestSha256: previous!.manifestSha256,
      manifestSha256: options.manifestSha256, inputSha256: digest(inputBytes),
      previousConfiguration: previous!.files.filter(file => file.sensitive).map(file => ({ path: file.path, sha256: file.sha256 })) },
    options.reviewedConfigurationSha256, unchanged);
  }
  if (options.operation === 'uninstall') {
    require(previous!.release === target && previous!.manifestSha256 === options.manifestSha256 &&
      currentFiles.every(file => previous!.files.some(old => old.path === file.path && old.sha256 === file.sha256)), 'INSTALL_UNINSTALL_INPUT_MISMATCH');
  }
  await networkClear(input);
  // No mkdir, receipt, locks, temp files or helper execution before --apply.
  const preview = { operation: options.operation, apply: Boolean(options.apply), release: target,
    files: plan.files.map(file => ({ path: file.path, mode: file.mode, owner: file.owner,
      action: options.operation === 'uninstall' ? file.sensitive ? 'preserve' : 'remove' : 'write' })),
    preserved: [input.runtime.stateDirectory, input.management.credentialPath, '/var/lib/cocoproxy-gateway-network'],
    services: 'remain stopped and disabled', network: 'unchanged', configurationReviewed };
  if (!options.apply) return preview;
  if (!(await info(STORE))) { await mkdir(STORE, { mode: 0o700 }); await chown(STORE, 0, 0); await chmod(STORE, 0o700); }
  // Exclusive intent lock survives errors/crashes. An operator must inspect the
  // pending receipt before recovery; never guess/overwrite an incomplete install.
  const lock = STORE + '/install.lock';
  await writeExclusive(lock, `${process.pid}\n`, 0o600);
  // Catch a concurrent completed installer between read-only preflight and lock.
  // No target changes have occurred yet, so these checks can release our lock.
  try {
    const observed = await info(RECEIPT) ? JSON.parse((await regular(RECEIPT)).toString()) : null;
    require(JSON.stringify(observed) === JSON.stringify(previous), 'INSTALL_RECEIPT_CHANGED');
    if (options.operation !== 'uninstall') require(!(await info(target)), 'INSTALL_TARGET_EXISTS');
    if (previous) await checkOwned(previous.files);
    require(digest(await regular(inputPath, 128 * 1024)) === digest(inputBytes), 'INSTALL_INPUT_CHANGED');
    await stopped(input.runtime.systemctlPath, units);
    await networkClear(input);
  } catch (error) { await unlink(lock); throw error; }
  const next: Receipt = { schemaVersion: 1, status: 'pending', release: target, manifestSha256: options.manifestSha256,
    files: currentFiles, serviceUid: input.runtime.serviceUid, stateDirectory: input.runtime.stateDirectory,
    credentialPath: input.management.credentialPath };
  await atomic(RECEIPT, JSON.stringify(next) + '\n', 0o600);
  if (options.operation === 'uninstall') {
    for (const file of plan.files.filter(file => !file.sensitive)) await unlink(file.path);
  } else {
    for (const directory of plan.directories) if (!(await info(directory.path))) {
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
    for (const file of plan.files) await atomic(file.path, file.content, parseInt(file.mode, 8), file.owner === 'root' ? 0 : file.owner);
    await checkOwned(currentFiles);
  }
  await run(input.runtime.systemctlPath, ['daemon-reload']);
  next.status = options.operation === 'uninstall' ? 'uninstalled' : 'complete';
  await atomic(RECEIPT, JSON.stringify(next) + '\n', 0o600);
  await unlink(lock);
  return preview;
}
