import { constants } from 'node:fs';
import { lstat, open, readlink, realpath, statfs } from 'node:fs/promises';
import { posix } from 'node:path';
import { types } from 'node:util';
import { parseUnitState } from '../runtime/systemd.ts';
import { NetworkCommandError, runNetworkCommand } from './command.ts';
import { MANAGEMENT_CONTROL_GROUP } from './identity.ts';

export interface GatewayManagementRequest { systemctlPath: string; managementUid: number }
export interface GatewayManagementFacts {
  managementPid: number; managementPidStartTime: string; managementUid: number; bootId: string;
  managementUnitControlGroup: typeof MANAGEMENT_CONTROL_GROUP;
}
export interface GatewayManagementObservation {
  scope: 'production' | 'fixture'; verified: boolean; commandsSettled: boolean; checkedAt: number;
  reason: 'NETWORK_MANAGEMENT_UNVERIFIED' | null; facts: GatewayManagementFacts | null;
}
export interface GatewayManagementFileMetadata {
  dev: bigint; ino: bigint; uid: bigint; mode: bigint; nlink: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint;
}
/** Synthetic trusted-code seam only; it cannot produce production evidence. */
export interface GatewayManagementFixtureReader {
  platform: string; root: boolean;
  read(path: string, maximum: number): Promise<Buffer>;
  link(path: string): Promise<string>;
  realpath(path: string): Promise<string>;
  metadata(path: string): Promise<GatewayManagementFileMetadata>;
  fsType(path: string): Promise<bigint>;
  command(binary: string, args: readonly string[]): Promise<string>;
  now(): number;
}
const SYSTEMCTL = '/usr/bin/systemctl', UNIT = 'coproxy-management.service';
const FRAGMENT = '/etc/systemd/system/' + UNIT, CGROUP = '/sys/fs/cgroup';
const properties = 'LoadState,ActiveState,SubState,MainPID,Job,ControlGroup,User,FragmentPath,DropInPaths,NeedDaemonReload';
const fail: () => never = () => { throw new Error('NETWORK_MANAGEMENT_UNVERIFIED'); };
const text = (value: Buffer) => new TextDecoder('utf-8', { fatal: true }).decode(value);
const stamp = (value: GatewayManagementFileMetadata) => [value.dev, value.ino, value.uid, value.mode,
  value.nlink, value.size, value.mtimeNs, value.ctimeNs].map(String).join(':');

async function boundedRead(path: string, maximum: number): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const bytes = Buffer.alloc(maximum + 1); let used = 0;
    while (used < bytes.length) {
      const result = await file.read(bytes, used, bytes.length - used, null);
      if (!result.bytesRead) break; used += result.bytesRead;
    }
    if (used > maximum) fail(); return bytes.subarray(0, used);
  } finally { await file.close(); }
}
const liveReader: GatewayManagementFixtureReader = {
  platform: process.platform, root: false, read: boundedRead, link: readlink, realpath,
  async metadata(path) { return lstat(path, { bigint: true }); },
  async fsType(path) { return (await statfs(path, { bigint: true })).type; },
  command: (binary, args) => runNetworkCommand(binary, args, { timeoutMs: 1000, maxOutputBytes: 16_384 }), now: Date.now,
};
function validate(input: GatewayManagementRequest): GatewayManagementRequest {
  if (!input || typeof input !== 'object' || types.isProxy(input) || Array.isArray(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input))) fail();
  const descriptors = Object.getOwnPropertyDescriptors(input), keys = Reflect.ownKeys(descriptors);
  if (keys.length !== 2 || keys.some(key => key !== 'systemctlPath' && key !== 'managementUid')) fail();
  for (const key of ['systemctlPath', 'managementUid']) {
    if (!descriptors[key]?.enumerable || !('value' in descriptors[key])) fail();
  }
  const systemctlPath = descriptors.systemctlPath.value, managementUid = descriptors.managementUid.value;
  if (typeof systemctlPath !== 'string' || systemctlPath.length > 4096 || !posix.isAbsolute(systemctlPath) ||
    /[\u0000-\u0020\u007f]/.test(systemctlPath) || posix.normalize(systemctlPath) !== systemctlPath ||
    typeof managementUid !== 'number' || !Number.isSafeInteger(managementUid) || managementUid < 1 || managementUid > 0xfffffffe) fail();
  return { systemctlPath, managementUid };
}
async function trustedPath(reader: GatewayManagementFixtureReader, path: string, executable: boolean) {
  if (await reader.realpath(path) !== path) fail();
  const proofs: string[] = [];
  for (let current = path;; current = posix.dirname(current)) {
    const value = await reader.metadata(current), leaf = current === path;
    if (value.uid !== 0n || (value.mode & 0o022n) !== 0n ||
      (value.mode & 0o170000n) !== (leaf ? 0o100000n : 0o040000n) ||
      (leaf && (value.nlink !== 1n || (executable && (value.mode & 0o111n) === 0n)))) fail();
    proofs.push(current + ':' + stamp(value)); if (current === '/') break;
  }
  return proofs;
}
async function manager(reader: GatewayManagementFixtureReader, input: GatewayManagementRequest) {
  const binary = await trustedPath(reader, SYSTEMCTL, true);
  const fragment = await trustedPath(reader, FRAGMENT, false);
  if (await reader.realpath(input.systemctlPath) !== SYSTEMCTL) fail();
  let raw: string;
  try {
    raw = await reader.command(SYSTEMCTL, ['--no-ask-password', '--no-pager', 'show', '--property=' + properties, UNIT]);
  } catch (error) {
    // Unknown command failures cannot establish that the client and its descendants have exited.
    if (error instanceof NetworkCommandError) throw error;
    throw new NetworkCommandError('NETWORK_COMMAND_FAILED', false);
  }
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > 16_384) fail();
  const lines = raw.replace(/\n$/, '').split('\n'), groups = lines.filter(line => line.startsWith('ControlGroup='));
  if (groups.length !== 1 || groups[0] !== 'ControlGroup=' + MANAGEMENT_CONTROL_GROUP) fail();
  const state = parseUnitState(lines.filter(line => !line.startsWith('ControlGroup=')).join('\n') + '\n');
  if (state.loadState !== 'loaded' || state.activeState !== 'active' || state.subState !== 'running' ||
    state.mainPid <= 1 || state.mainPid > 0x7fffffff || state.jobPending || state.hasDropIns || state.needsReload ||
    state.user !== String(input.managementUid) || state.fragmentPath !== FRAGMENT) fail();
  if (JSON.stringify(binary) !== JSON.stringify(await trustedPath(reader, SYSTEMCTL, true)) ||
    JSON.stringify(fragment) !== JSON.stringify(await trustedPath(reader, FRAGMENT, false))) fail();
  return { state, binary, fragment };
}
async function snapshot(reader: GatewayManagementFixtureReader, input: GatewayManagementRequest) {
  if (await reader.fsType('/proc') !== 0x9fa0n || await reader.fsType(CGROUP) !== 0x63677270n) fail();
  const unit = await manager(reader, input), pid = unit.state.mainPid;
  const mounts = text(await reader.read('/proc/self/mountinfo', 262_144));
  const records = mounts.trim().split('\n').map(line => {
    const parts = line.split(' - '); if (parts.length !== 2) fail();
    const left = parts[0].split(' '), right = parts[1].split(' ');
    if (left.length < 6 || right.length < 3 || !left[4].startsWith('/')) fail();
    return { left, right };
  });
  const paths = ['/proc/sys/kernel/random/boot_id', '/proc/1', '/proc/self', `/proc/${process.pid}`, `/proc/${pid}`];
  const overlaps = (a: string, b: string) => a === b || a.startsWith(b + '/') || b.startsWith(a + '/');
  for (const [target, filesystem] of [['/proc', 'proc'], [CGROUP, 'cgroup2']]) {
    const at = records.filter(record => record.left[4] === target);
    if (at.length !== 1 || at[0].left[3] !== '/' || at[0].right[0] !== filesystem || records.some(record =>
      record.left[4].startsWith(target + '/') && (target === CGROUP || paths.some(path => overlaps(record.left[4], path))))) fail();
  }
  // The full initial mapping excludes root in a subordinate user namespace.
  for (const owner of ['1', 'self']) {
    if (!/^\s*0\s+0\s+4294967295\s*$/.test(text(await reader.read(`/proc/${owner}/uid_map`, 4096)))) fail();
  }
  const namespaces: string[] = [];
  for (const name of ['user', 'net', 'pid', 'cgroup', 'mnt']) {
    const initial = await reader.link(`/proc/1/ns/${name}`);
    if (!new RegExp(`^${name}:\\[[1-9][0-9]*\\]$`).test(initial) ||
      await reader.link(`/proc/self/ns/${name}`) !== initial) fail();
    const target = await reader.link(`/proc/${pid}/ns/${name}`);
    if (!new RegExp(`^${name}:\\[[1-9][0-9]*\\]$`).test(target) || (name !== 'mnt' && target !== initial)) fail();
    namespaces.push(initial, target);
  }
  const bootId = text(await reader.read('/proc/sys/kernel/random/boot_id', 128)).trim();
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(bootId)) fail();
  for (const [owner, expected] of [['1', 1], ['self', process.pid], [String(pid), pid]] as const) {
    const status = text(await reader.read(`/proc/${owner}/status`, 65_536));
    const lines = status.split('\n').filter(line => line.startsWith('NSpid:'));
    if (lines.length !== 1 || !new RegExp(`^NSpid:\\s+${expected}\\s*$`).test(lines[0])) fail();
    if (owner === 'self' && !/^Uid:\s+0\s+0\s+0\s+0\s*$/m.test(status)) fail();
    if (owner === String(pid)) {
      const uids = status.split('\n').filter(line => line.startsWith('Uid:'));
      if (uids.length !== 1 || !new RegExp(`^Uid:\\s+${input.managementUid}\\s+${input.managementUid}\\s+${input.managementUid}\\s+${input.managementUid}\\s*$`).test(uids[0])) fail();
    }
  }
  const raw = text(await reader.read(`/proc/${pid}/stat`, 65_536)), boundary = raw.lastIndexOf(')');
  const fields = raw.slice(boundary + 2).trim().split(/\s+/);
  if (!raw.startsWith(`${pid} (`) || boundary < 1 || !['R', 'S', 'D', 'I'].includes(fields[0]) ||
    !/^[1-9][0-9]{0,19}$/.test(fields[19] ?? '') ||
    text(await reader.read(`/proc/${pid}/cgroup`, 4096)) !== `0::${MANAGEMENT_CONTROL_GROUP}\n`) fail();
  return { unit, pid, startTime: fields[19], bootId, mounts, namespaces };
}
async function observe(input: GatewayManagementRequest, reader: GatewayManagementFixtureReader,
  scope: GatewayManagementObservation['scope']): Promise<GatewayManagementObservation> {
  let checkedAt = Date.now();
  try {
    const request = validate(input);
    if (reader.platform !== 'linux' || !reader.root || (scope === 'production' && process.geteuid?.() !== 0)) fail();
    const started = reader.now();
    const before = await snapshot(reader, request), after = await snapshot(reader, request);
    checkedAt = reader.now();
    if (!Number.isSafeInteger(started) || !Number.isSafeInteger(checkedAt) || started <= 0 || checkedAt < started ||
      checkedAt - started > 5000 || JSON.stringify(before) !== JSON.stringify(after)) fail();
    return { scope, verified: true, commandsSettled: true, checkedAt, reason: null, facts: {
      managementPid: after.pid, managementPidStartTime: after.startTime, managementUid: request.managementUid,
      bootId: after.bootId, managementUnitControlGroup: MANAGEMENT_CONTROL_GROUP } };
  } catch (error) {
    return { scope, verified: false, commandsSettled: !(error instanceof NetworkCommandError && error.childSettled === false),
      checkedAt, reason: 'NETWORK_MANAGEMENT_UNVERIFIED', facts: null };
  }
}
/** Root-only bounded read-only source: PID comes exclusively from the fixed management systemd unit. */
export async function observeGatewayManagement(input: GatewayManagementRequest): Promise<GatewayManagementObservation> {
  return observe(input, { ...liveReader, root: process.geteuid?.() === 0 }, 'production');
}
/** Fixture observations always retain fixture scope, regardless of reader platform or privileges. */
export async function observeGatewayManagementFixture(input: GatewayManagementRequest,
  reader: GatewayManagementFixtureReader): Promise<GatewayManagementObservation> {
  return observe(input, reader, 'fixture');
}
