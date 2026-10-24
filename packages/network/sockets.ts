import { lstat, readlink, realpath, statfs } from 'node:fs/promises';
import { isIP } from 'node:net';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { types } from 'node:util';
import { runNetworkCommand } from './command.ts';
import { renderNetworkPlan, type NetworkPlan } from './plan.ts';

export interface SocketProcessBinding { pid: number; startTime: string; uid: number; cgroupKernelId: string }
export interface SocketSourceBinding { bootId: string; core: SocketProcessBinding; management: SocketProcessBinding }
export interface SocketSourceOptions { stage: 'identity' | 'ready' }
interface ProcessFacts { pid: number; startTime: string; uids: number[]; inodes: string[] }
interface SocketFacts {
  inode: string; cookie: string; family: 4 | 6; protocol: 'tcp' | 'udp'; uid: number; state: number;
  localAddress: string; remoteAddress: string; localPort: number; remotePort: number; ifindex: number;
  mark: number | null; cgroupID: string | null;
}
interface Diagnostics {
  schemaVersion: 1; bootId: string; userNS: string; netNS: string; processes: ProcessFacts[];
  uidPeers: { uid: number; pids: number[] }[]; sockets: SocketFacts[];
  nonInet: { inode: string; family: 'unix' | 'netlink' }[]; unknown: string[];
}
export interface SocketSourceObservation {
  scope: 'production' | 'fixture'; stage: 'identity' | 'ready'; verified: boolean; checkedAt: number;
  generation: string; planSha256: string; reason: null | 'NETWORK_SOCKET_UNVERIFIED';
  checks: { dnsListenerSources: boolean; coreSocketSources: boolean; egressSocketMarks: boolean;
    managementExcluded: boolean; upstreamObserved: boolean };
  counts: null | { core: number; management: number; upstream: number };
}
/** Trusted seam only. No synthetic reader can create production observations. */
export interface SocketSourceFixtureReader { dump(pids: readonly number[]): Promise<string>; now(): number }
const fail: () => never = () => { throw new Error('NETWORK_SOCKET_UNVERIFIED'); };
const uint = (value: unknown, max = 0xffff_ffff): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max;
const positive = (value: unknown, max = 0xffff_ffff_ffff_ffffn): value is string => typeof value === 'string' &&
  /^[1-9]\d{0,19}$/.test(value) && BigInt(value) <= max;
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== keys.length || keys.some(key => !descriptors[key]?.enumerable || !('value' in descriptors[key]))) fail();
  return Object.fromEntries(keys.map(key => [key, descriptors[key].value]));
}
function list(value: unknown, maximum = 8192): unknown[] {
  if (!Array.isArray(value) || types.isProxy(value) || value.length > maximum) fail();
  return value;
}
function distinct<T>(values: T[]): T[] { if (new Set(values).size !== values.length) fail(); return values; }
function inodeList(value: unknown): string[] {
  const values = list(value);
  if (!values.every(item => positive(item, 0xffff_ffffn))) fail();
  return distinct(values as string[]);
}
/** The fixed helper emits canonical ASCII JSON. This also rejects duplicate keys. */
function parse(raw: string): Diagnostics {
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > 1_048_576) fail();
  const text = raw.endsWith('\n') ? raw.slice(0, -1) : raw;
  const data = JSON.parse(text);
  if (JSON.stringify(data) !== text) fail();
  const root = object(data, ['schemaVersion', 'bootId', 'userNS', 'netNS', 'processes', 'uidPeers', 'sockets', 'nonInet', 'unknown']);
  if (root.schemaVersion !== 1 || !uuid(root.bootId) || typeof root.userNS !== 'string' || !/^user:\[[1-9]\d{0,19}\]$/.test(root.userNS) ||
    typeof root.netNS !== 'string' || !/^net:\[[1-9]\d{0,19}\]$/.test(root.netNS)) fail();
  for (const value of list(root.processes, 2)) {
    const item = object(value, ['pid', 'startTime', 'uids', 'inodes']);
    if (!uint(item.pid, 0x7fff_ffff) || item.pid < 2 || !positive(item.startTime) ||
      list(item.uids, 4).length !== 4 || !(item.uids as unknown[]).every(uid => uint(uid))) fail();
    inodeList(item.inodes);
  }
  const pids = (root.processes as ProcessFacts[]).map(item => item.pid); distinct(pids);
  for (const value of list(root.uidPeers, 8)) {
    const item = object(value, ['uid', 'pids']);
    if (!uint(item.uid) || !list(item.pids, 65536).every(pid => uint(pid, 0x7fff_ffff) && pid > 0)) fail();
    distinct(item.pids as number[]);
  }
  distinct((root.uidPeers as Diagnostics['uidPeers']).map(item => item.uid));
  for (const value of list(root.sockets, 4096)) {
    const item = object(value, ['inode', 'cookie', 'family', 'protocol', 'uid', 'state', 'localAddress', 'remoteAddress',
      'localPort', 'remotePort', 'ifindex', 'mark', 'cgroupID']);
    if (!positive(item.inode, 0xffff_ffffn) || !positive(item.cookie) || item.cookie === '18446744073709551615' ||
      ![4, 6].includes(item.family as number) || !['tcp', 'udp'].includes(item.protocol as string) || !uint(item.uid) ||
      !uint(item.state, 255) || typeof item.localAddress !== 'string' || isIP(item.localAddress) !== item.family ||
      typeof item.remoteAddress !== 'string' || isIP(item.remoteAddress) !== item.family || !uint(item.localPort, 65535) ||
      !uint(item.remotePort, 65535) || !uint(item.ifindex) || (item.mark !== null && !uint(item.mark)) ||
      (item.cgroupID !== null && !positive(item.cgroupID))) fail();
  }
  const sockets = root.sockets as SocketFacts[];
  distinct(sockets.map(item => item.inode)); distinct(sockets.map(item => item.cookie));
  for (const value of list(root.nonInet)) {
    const item = object(value, ['inode', 'family']);
    if (!positive(item.inode, 0xffff_ffffn) || !['unix', 'netlink'].includes(item.family as string)) fail();
  }
  const nonInet = root.nonInet as Diagnostics['nonInet'];
  distinct([...sockets.map(item => item.inode), ...nonInet.map(item => item.inode), ...inodeList(root.unknown)]);
  const requested = new Set((root.processes as ProcessFacts[]).flatMap(item => item.inodes));
  const classified = [...sockets.map(item => item.inode), ...nonInet.map(item => item.inode), ...root.unknown as string[]];
  if (classified.length !== requested.size || classified.some(inode => !requested.has(inode))) fail();
  return data as Diagnostics;
}
async function trusted(path: string, fixture: boolean, executable: boolean): Promise<string> {
  const actual = await realpath(path);
  if (!executable && actual !== path) fail();
  if (executable && !/^\/usr\/bin\/python3(?:\.\d{1,2})?$/.test(actual)) fail();
  for (let current = actual;; current = dirname(current)) {
    const stat = await lstat(current);
    const owners = fixture ? [0, 65534, process.geteuid!()] : [0];
    if (!owners.includes(stat.uid) || stat.isSymbolicLink() || ((stat.mode & 0o022) !== 0 &&
      !(fixture && current !== actual && [0, 65534].includes(stat.uid) && (stat.mode & 0o1000))) ||
      (current === actual ? !stat.isFile() || stat.nlink !== 1 || (executable && !(stat.mode & 0o111)) : !stat.isDirectory())) fail();
    if (current === '/') break;
  }
  return actual;
}
async function dump(pids: readonly number[], fixture: boolean): Promise<string> {
  if (process.platform !== 'linux' || (!fixture && process.geteuid?.() !== 0) || pids.length < 1 || pids.length > 2 ||
    pids.some(pid => !uint(pid, 0x7fff_ffff) || pid < 2) || new Set(pids).size !== pids.length || (await statfs('/proc')).type !== 0x9fa0) fail();
  if (!fixture) for (const name of ['user', 'net']) if (await readlink(`/proc/self/ns/${name}`) !== await readlink(`/proc/1/ns/${name}`)) fail();
  const binary = await trusted('/usr/bin/python3', fixture, true);
  const helper = await trusted(fileURLToPath(new URL('./socket-diag.py', import.meta.url)), fixture, false);
  return runNetworkCommand(binary, ['-I', '-S', helper], { input: JSON.stringify({ schemaVersion: 1, pids }), timeoutMs: 5000, maxOutputBytes: 1_048_576 });
}

/** Real kernel fixture data is sensitive and remains internal; never expose as an API response. */
export async function readSocketDiagnosticsFixture(pids: readonly number[], proof: { outerUser: string; outerNet: string }): Promise<Diagnostics> {
  if (!proof || !/^user:\[[1-9]\d*\]$/.test(proof.outerUser) || !/^net:\[[1-9]\d*\]$/.test(proof.outerNet) ||
    await readlink('/proc/self/ns/user') === proof.outerUser || await readlink('/proc/self/ns/net') === proof.outerNet) fail();
  return parse(await dump(pids, true));
}

function binding(input: SocketSourceBinding, plan: NetworkPlan): SocketSourceBinding {
  const value = object(input, ['bootId', 'core', 'management']);
  if (!uuid(value.bootId)) fail();
  const result = { bootId: value.bootId, core: null as unknown as SocketProcessBinding, management: null as unknown as SocketProcessBinding };
  for (const role of ['core', 'management'] as const) {
    const item = object(value[role], ['pid', 'startTime', 'uid', 'cgroupKernelId']);
    if (!uint(item.pid, 0x7fff_ffff) || item.pid < 2 || !positive(item.startTime) || !uint(item.uid) || item.uid < 1 ||
      !positive(item.cgroupKernelId)) fail();
    result[role] = item as unknown as SocketProcessBinding;
  }
  if (result.core.uid !== plan.deployment.core.serviceUid || result.core.pid === result.management.pid ||
    result.core.uid === result.management.uid || result.core.cgroupKernelId === result.management.cgroupKernelId ||
    (plan.deployment.management && result.management.uid !== plan.deployment.management.serviceUid)) fail();
  return result;
}
function verify(data: Diagnostics, plan: NetworkPlan, expected: SocketSourceBinding) {
  if (data.bootId !== expected.bootId || data.unknown.length || data.processes.length !== 2) fail();
  const owned = new Map<string, 'core' | 'management'>();
  const byInode = new Map(data.sockets.map(item => [item.inode, item]));
  let core = 0, management = 0, upstream = 0, dnsTcp = 0, dnsUdp = 0;
  for (const role of ['core', 'management'] as const) {
    const target = expected[role], process = data.processes.find(item => item.pid === target.pid);
    if (!process || process.startTime !== target.startTime || process.uids.some(uid => uid !== target.uid)) fail();
    // Dedicated service identities prevent an unrelated same-UID process from
    // borrowing/injecting sockets through ptrace or pidfd_getfd.
    const peers = data.uidPeers.find(item => item.uid === target.uid);
    if (!peers || peers.pids.length !== 1 || peers.pids[0] !== target.pid) fail();
    for (const inode of process.inodes) {
      if (owned.has(inode)) fail();
      owned.set(inode, role);
      const socket = byInode.get(inode); if (!socket) continue;
      if (socket.uid !== target.uid || socket.cgroupID !== target.cgroupKernelId || socket.mark === null) fail();
      const reserved = (socket.mark & plan.deployment.marks.mask) >>> 0;
      if (role === 'management') { if (reserved !== 0) fail(); management++; continue; }
      core++;
      const zero = socket.family === 4 ? '0.0.0.0' : '::';
      const loopback = socket.family === 4 ? socket.localAddress === '127.0.0.1' &&
        [zero, '127.0.0.1'].includes(socket.remoteAddress) : socket.localAddress === '::1' && [zero, '::1'].includes(socket.remoteAddress);
      const dns = socket.family === 4 && socket.localAddress === plan.deployment.gatewayIPv4 && socket.localPort === plan.deployment.dnsPort;
      if (dns && socket.remotePort === 0 && socket.remoteAddress === zero) {
        if (socket.protocol === 'tcp' && socket.state === 10) dnsTcp++;
        else if (socket.protocol === 'udp' && socket.state === 7) dnsUdp++;
        else fail();
      }
      if (loopback) { if (![0, plan.deployment.marks.egress].includes(reserved)) fail(); }
      else {
        if (socket.family !== 4 || reserved !== plan.deployment.marks.egress) fail();
        if (!dns && socket.protocol === 'tcp' && socket.state === 10) fail();
        // An unconnected UDP bind is not evidence of an upstream endpoint.
        const first = Number(socket.remoteAddress.split('.')[0]);
        if (!dns && socket.localPort > 0 && socket.remotePort > 0 && socket.state === 1 &&
          first > 0 && first !== 127 && first < 224 && socket.remoteAddress !== '255.255.255.255') upstream++;
      }
    }
  }
  if (dnsTcp !== 1 || dnsUdp !== 1 || core < 2 || management < 1) fail();
  return { core, management, upstream };
}
function stable(data: Diagnostics, plan: NetworkPlan) {
  return JSON.stringify({ bootId: data.bootId, userNS: data.userNS, netNS: data.netNS, uidPeers: data.uidPeers,
    processes: data.processes.map(({ pid, startTime, uids }) => ({ pid, startTime, uids })),
    dns: data.sockets.filter(socket => socket.family === 4 && socket.localAddress === plan.deployment.gatewayIPv4 &&
      socket.localPort === plan.deployment.dnsPort && socket.remotePort === 0 && socket.remoteAddress === '0.0.0.0') });
}
async function observe(planInput: NetworkPlan, input: SocketSourceBinding, options: SocketSourceOptions,
  reader: SocketSourceFixtureReader, scope: SocketSourceObservation['scope']): Promise<SocketSourceObservation> {
  const checks = { dnsListenerSources: false, coreSocketSources: false, egressSocketMarks: false, managementExcluded: false, upstreamObserved: false };
  const result: SocketSourceObservation = { scope, stage: options?.stage === 'identity' ? 'identity' : 'ready', verified: false,
    checkedAt: Date.now(), generation: '', planSha256: '', reason: 'NETWORK_SOCKET_UNVERIFIED', checks, counts: null };
  try {
    const started = reader.now(), plan = renderNetworkPlan(planInput.deployment), expected = binding(input, plan);
    if (!Number.isSafeInteger(started) || started <= 0 || !['identity', 'ready'].includes(options.stage) || plan.sha256 !== planInput.sha256) fail();
    result.generation = plan.deployment.generation; result.planSha256 = plan.sha256;
    const pids = [expected.core.pid, expected.management.pid];
    const before = parse(await reader.dump(pids)); verify(before, plan, expected);
    const after = parse(await reader.dump(pids)), counts = verify(after, plan, expected), checkedAt = reader.now();
    if (stable(before, plan) !== stable(after, plan) || !Number.isSafeInteger(checkedAt) || checkedAt < started || checkedAt - started > 5000) fail();
    Object.assign(checks, { dnsListenerSources: true, coreSocketSources: true, egressSocketMarks: true,
      managementExcluded: true, upstreamObserved: counts.upstream > 0 });
    result.checkedAt = checkedAt; result.counts = counts;
    result.verified = options.stage === 'identity' || checks.upstreamObserved;
    if (result.verified) result.reason = null;
  } catch { /* No paths, socket addresses, parser diagnostics or process IDs escape. */ }
  return result;
}
/** Independent socket facts only; unit/executable/cgroup ownership are separate prerequisites. */
export async function observeSocketSources(plan: NetworkPlan, input: SocketSourceBinding, options: SocketSourceOptions): Promise<SocketSourceObservation> {
  return observe(plan, input, options, { dump: pids => dump(pids, false), now: Date.now }, 'production');
}
export async function observeSocketSourcesFixture(plan: NetworkPlan, input: SocketSourceBinding, options: SocketSourceOptions,
  reader: SocketSourceFixtureReader): Promise<SocketSourceObservation> {
  return observe(plan, input, options, reader, 'fixture');
}
