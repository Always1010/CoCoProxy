import { randomBytes } from 'node:crypto';
import { createSocket } from 'node:dgram';
import { constants } from 'node:fs';
import { lstat, open, opendir, readlink, realpath, stat, statfs } from 'node:fs/promises';
import { createConnection, isIP } from 'node:net';
import { dirname } from 'node:path';
import { NetworkCommandError, runNetworkCommand } from './command.ts';
import { NETWORK_TUN_ADDRESS, renderNetworkPlan, type NetworkPlan } from './plan.ts';
import type { NetworkIdentity } from './transaction.ts';

export interface NetworkProbeOptions {
  /** Root-controlled deployment input: wildcard A record for every random child. Never browser input. */
  queryDomain: string;
  expectedIPv4: string;
  ipBinary: '/usr/sbin/ip' | '/usr/bin/ip' | '/sbin/ip';
  /** Per transport deadline, including bind/connect/read. */
  timeoutMs?: number;
}
export type NetworkProbeIdentity = Pick<NetworkIdentity, 'corePid' | 'corePidStartTime' | 'bootId' | 'serviceUid'>;
export interface NetworkProbeObservation {
  scope: 'production' | 'fixture';
  verified: boolean;
  /** False forbids recovery mutations while a read command may still be alive. */
  commandsSettled: boolean;
  checkedAt: number;
  reason: null | 'NETWORK_PROBE_UNVERIFIED';
  checks: { dnsSocketsOwned: boolean; dnsUdpQuery: boolean; dnsTcpQuery: boolean; tunOwned: boolean };
  terminalPath: 'unverified';
}

/** Trusted test seam. Its observations always carry fixture scope, even with real sockets. */
export interface NetworkProbeFixtureReader {
  platform: string;
  root: boolean;
  read(path: string): Promise<string>;
  link(path: string): Promise<string>;
  entries(path: string): Promise<string[]>;
  procType(): Promise<bigint>;
  tunDevice(path: string): Promise<boolean>;
  address(options: NetworkProbeOptions): Promise<string>;
  exchange(protocol: 'udp' | 'tcp', packet: Buffer, address: string, port: number, timeoutMs: number): Promise<Buffer>;
}

function fail(): never { throw new Error('NETWORK_PROBE_UNVERIFIED'); }
const positive = /^[1-9]\d{0,19}$/;
const MAXIMUM = 1_048_576;
async function read(path: string): Promise<string> {
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const buffer = Buffer.alloc(MAXIMUM + 1);
    let used = 0;
    while (used < buffer.length) {
      const { bytesRead } = await fd.read(buffer, used, buffer.length - used, null);
      if (!bytesRead) break;
      used += bytesRead;
    }
    if (used > MAXIMUM) fail();
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, used));
  } finally { await fd.close(); }
}

async function readAddress(options: NetworkProbeOptions, fixture: boolean): Promise<string> {
  // A fixed allowlist alone is insufficient if the binary or its ancestors can be replaced.
  const binary = await realpath(options.ipBinary);
  if (!['/usr/sbin/ip', '/usr/bin/ip'].includes(binary)) fail();
  for (let path = binary;; path = dirname(path)) {
    const metadata = await lstat(path, { bigint: true });
    // A fixture user namespace may not map the host root UID. No production
    // caller can enable this exception or supply an alternate executable.
    if ((metadata.uid !== 0n && !(fixture && metadata.uid === 65534n)) || (metadata.mode & 0o022n) !== 0n || metadata.isSymbolicLink() ||
      (path === binary ? !metadata.isFile() : !metadata.isDirectory())) fail();
    if (path === '/') break;
  }
  return runNetworkCommand(binary, ['-d', '-j', 'address', 'show', 'dev', 'cocoproxy-tun'],
    { timeoutMs: 1000, maxOutputBytes: 16_384 });
}

/** No system resolver, proxy, search domains, redirects, retries or unbounded response data. */
async function exchange(protocol: 'udp' | 'tcp', packet: Buffer, host: string, port: number, timeoutMs: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (response?: Buffer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (protocol === 'udp') { try { udp!.close(); } catch {} }
      else tcp?.destroy();
      if (response) resolve(response); else reject(new Error('NETWORK_PROBE_UNVERIFIED'));
    };
    let udp: ReturnType<typeof createSocket> | undefined;
    let tcp: ReturnType<typeof createConnection> | undefined;
    const timer = setTimeout(() => finish(), timeoutMs);
    try {
      if (protocol === 'udp') {
        udp = createSocket('udp4');
        udp.once('error', () => finish());
        udp.once('message', (message, remote) => {
          finish(remote.address === host && remote.port === port && message.length <= 4096 ? message : undefined);
        });
        udp.bind({ address: '127.0.0.1', port: 0, exclusive: true }, () => {
          if (settled) return;
          udp!.connect(port, host, () => { if (!settled) udp!.send(packet, error => { if (error) finish(); }); });
        });
      } else {
        tcp = createConnection({ host, port, family: 4, localAddress: '127.0.0.1' });
        tcp.once('error', () => finish());
        tcp.once('end', () => finish());
        tcp.once('connect', () => {
          const prefix = Buffer.alloc(2); prefix.writeUInt16BE(packet.length);
          tcp!.write(Buffer.concat([prefix, packet]));
        });
        let received = Buffer.alloc(0);
        tcp.on('data', (chunk: Buffer) => {
          if (received.length + chunk.length > 4098) { finish(); return; }
          received = Buffer.concat([received, chunk]);
          if (received.length < 2) return;
          const length = received.readUInt16BE();
          if (length < 12 || length > 4096 || received.length > length + 2) { finish(); return; }
          if (received.length === length + 2) finish(received.subarray(2));
        });
      }
    } catch { finish(); }
  });
}

const liveReader: NetworkProbeFixtureReader = {
  platform: process.platform, root: typeof process.geteuid === 'function' && process.geteuid() === 0,
  read, link: readlink,
  async entries(path) {
    const result: string[] = [];
    for await (const entry of await opendir(path)) {
      if (result.length >= 8192) fail();
      result.push(entry.name);
    }
    return result;
  },
  async procType() { return (await statfs('/proc', { bigint: true })).type; },
  async tunDevice(path) { const value = await stat(path, { bigint: true }); return value.isCharacterDevice() && value.rdev === 2760n; },
  address: options => readAddress(options, false), exchange,
};

function validate(plan: NetworkPlan, identity: NetworkProbeIdentity, options: NetworkProbeOptions): NetworkProbeOptions {
  if (renderNetworkPlan(plan.deployment).sha256 !== plan.sha256 ||
    !Number.isSafeInteger(identity.corePid) || identity.corePid <= 1 || identity.corePid > 0x7fffffff ||
    typeof identity.corePidStartTime !== 'string' || !positive.test(identity.corePidStartTime) ||
    typeof identity.bootId !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(identity.bootId) ||
    identity.serviceUid !== plan.deployment.core.serviceUid ||
    typeof options.queryDomain !== 'string' || options.queryDomain.length > 210 ||
    options.queryDomain.split('.').some(label =>
      !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) ||
    isIP(options.expectedIPv4) !== 4 ||
    !['/usr/sbin/ip', '/usr/bin/ip', '/sbin/ip'].includes(options.ipBinary)) fail();
  const timeoutMs = options.timeoutMs ?? 1000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > 3000) fail();
  return { queryDomain: options.queryDomain, expectedIPv4: options.expectedIPv4, ipBinary: options.ipBinary, timeoutMs };
}

function socketInode(table: string, local: string, protocol: 'udp' | 'tcp', uid: number): string {
  if (Buffer.byteLength(table) > MAXIMUM) fail();
  const rows = table.trim().split('\n');
  if (!rows.shift()?.includes('local_address')) fail();
  const matches = rows.map(row => row.trim().split(/\s+/)).filter(fields =>
    fields[1]?.split(':')[1] === local.split(':')[1] && (protocol !== 'tcp' || fields[3] === '0A'));
  if (matches.length !== 1) fail();
  const row = matches[0];
  if (row[1] !== local || row[2] !== '00000000:0000' || row[3] !== (protocol === 'tcp' ? '0A' : '07') ||
    row[7] !== String(uid) || !positive.test(row[9] ?? '')) fail();
  return row[9];
}

async function snapshot(plan: NetworkPlan, identity: NetworkProbeIdentity, reader: NetworkProbeFixtureReader,
  options: NetworkProbeOptions): Promise<string> {
  if (reader.platform !== 'linux' || !reader.root || await reader.procType() !== 0x9fa0n) fail();
  const pid = identity.corePid;
  const mounts = await reader.read('/proc/self/mountinfo');
  const paths = ['/proc/sys/kernel/random/boot_id', '/proc/self', `/proc/${process.pid}`, `/proc/${pid}`];
  const records = mounts.trim().split('\n').map(line => {
    const parts = line.split(' - ');
    if (parts.length !== 2) fail();
    return { left: parts[0].split(' '), right: parts[1].split(' ') };
  });
  const proc = records.filter(value => value.left[4] === '/proc');
  if (proc.length !== 1 || proc[0].left[3] !== '/' || proc[0].right[0] !== 'proc' || records.some(value => {
    const mount = value.left[4];
    return mount !== '/proc' && mount.startsWith('/proc/') && paths.some(path =>
      mount === path || mount.startsWith(`${path}/`) || path.startsWith(`${mount}/`));
  })) fail();
  const boot = (await reader.read('/proc/sys/kernel/random/boot_id')).trim();
  if (boot !== identity.bootId) fail();
  const namespaces: string[] = [];
  for (const name of ['net', 'pid', 'user']) {
    const own = await reader.link(`/proc/self/ns/${name}`);
    if (!new RegExp(`^${name}:\\[[1-9][0-9]*\\]$`).test(own) || await reader.link(`/proc/${pid}/ns/${name}`) !== own) fail();
    namespaces.push(own);
  }
  const processStat = await reader.read(`/proc/${pid}/stat`);
  const end = processStat.lastIndexOf(')');
  const fields = processStat.slice(end + 2).trim().split(/\s+/);
  if (!processStat.startsWith(`${pid} (`) || end < 1 || fields[19] !== identity.corePidStartTime || !['R', 'S', 'D', 'I'].includes(fields[0])) fail();
  const status = await reader.read(`/proc/${pid}/status`);
  const uids = /^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*$/m.exec(status);
  if (!uids || uids.slice(1).some(uid => uid !== String(identity.serviceUid))) fail();
  const local = plan.deployment.gatewayIPv4.split('.').reverse().map(octet => Number(octet).toString(16).padStart(2, '0')).join('').toUpperCase() +
    ':' + plan.deployment.dnsPort.toString(16).toUpperCase().padStart(4, '0');
  const inodes: string[] = [];
  for (const protocol of ['udp', 'tcp'] as const) {
    inodes.push(socketInode(await reader.read(`/proc/${pid}/net/${protocol}`), local, protocol, identity.serviceUid));
    // IPv6 wildcard/dual-stack listeners cannot satisfy an exact IPv4 bind.
    const ipv6 = await reader.read(`/proc/${pid}/net/${protocol}6`);
    const rows = ipv6.trim().split('\n');
    if (Buffer.byteLength(ipv6) > MAXIMUM || !rows.shift()?.includes('local_address') || rows.some(row => {
      const fields = row.trim().split(/\s+/);
      return fields[1]?.split(':')[1] === local.split(':')[1] && (protocol !== 'tcp' || fields[3] === '0A');
    })) fail();
  }
  if (new Set(inodes).size !== 2) fail();
  const descriptors = await reader.entries(`/proc/${pid}/fd`);
  if (descriptors.length > 8192 || descriptors.some(fd => !/^(0|[1-9]\d{0,9})$/.test(fd))) fail();
  const sockets = new Set<string>();
  const tun: string[] = [];
  for (const fd of descriptors) {
    let target: string;
    try { target = await reader.link(`/proc/${pid}/fd/${fd}`); }
    catch { continue; } // A nonessential transient descriptor can close.
    const socket = /^socket:\[([1-9]\d*)\]$/.exec(target);
    if (socket && inodes.includes(socket[1])) sockets.add(socket[1]);
    if (target === '/dev/net/tun') {
      if (!await reader.tunDevice(`/proc/${pid}/fd/${fd}`)) fail();
      const info = await reader.read(`/proc/${pid}/fdinfo/${fd}`);
      const names = [...info.matchAll(/^iff:\s+([^\s]+)\s*$/gm)].map(match => match[1]);
      if (names.length !== 1 || names[0] !== 'cocoproxy-tun') fail();
      tun.push(fd);
    }
  }
  if (sockets.size !== 2 || tun.length === 0) fail();
  const rawAddress = await reader.address(options);
  if (Buffer.byteLength(rawAddress) > 16_384) fail();
  const devices = JSON.parse(rawAddress);
  if (!Array.isArray(devices) || devices.length !== 1) fail();
  const device = devices[0];
  const addresses = device.addr_info?.filter((entry: { family: string }) => entry.family === 'inet');
  if (device.ifname !== 'cocoproxy-tun' || !Number.isSafeInteger(device.ifindex) || device.ifindex < 1 ||
    device.mtu !== plan.deployment.tun.mtu || !device.flags?.includes('UP') || device.linkinfo?.info_kind !== 'tun' ||
    device.linkinfo?.info_data?.type !== 'tun' || !Array.isArray(addresses) || addresses.length !== 1 ||
    `${addresses[0].local}/${addresses[0].prefixlen}` !== NETWORK_TUN_ADDRESS) fail();
  return JSON.stringify({ boot, namespaces, startTime: fields[19], uid: uids[1], inodes, tun: tun.sort(),
    ifindex: device.ifindex, mtu: device.mtu, address: NETWORK_TUN_ADDRESS, mounts });
}

function query(domain: string) {
  const name = `${randomBytes(16).toString('hex')}.${domain}`;
  const id = randomBytes(2).readUInt16BE();
  const header = Buffer.alloc(12); header.writeUInt16BE(id); header.writeUInt16BE(0x0100, 2); header.writeUInt16BE(1, 4);
  const labels = name.split('.').map(label => Buffer.concat([Buffer.from([label.length]), Buffer.from(label, 'ascii')]));
  const packet = Buffer.concat([header, ...labels, Buffer.from([0, 0, 1, 0, 1])]);
  return { name, id, packet };
}

/** Strict bounded RFC 1035 A-answer/CNAME-chain validation; no packet/name escapes this module. */
function response(packet: Buffer, expected: ReturnType<typeof query>, ipv4: string): void {
  if (!Buffer.isBuffer(packet) || packet.length < 12 || packet.length > 4096 || packet.readUInt16BE() !== expected.id) fail();
  const flags = packet.readUInt16BE(2);
  if ((flags & 0x8000) === 0 || (flags & 0x780f) !== 0 || (flags & 0x0240) !== 0 || packet.readUInt16BE(4) !== 1) fail();
  function name(at: number): { text: string; next: number } {
    const labels: string[] = []; const visited = new Set<number>();
    let cursor = at, next = -1, size = 1;
    for (let hops = 0; hops < 128; hops++) {
      if (cursor >= packet.length || visited.has(cursor)) fail();
      visited.add(cursor);
      const length = packet[cursor++];
      if ((length & 0xc0) === 0xc0) {
        if (cursor >= packet.length) fail();
        const target = ((length & 0x3f) << 8) | packet[cursor++];
        if (target < 12 || target >= cursor - 2) fail();
        if (next === -1) next = cursor;
        cursor = target; continue;
      }
      if ((length & 0xc0) !== 0 || cursor + length > packet.length) fail();
      if (length === 0) return { text: labels.join('.'), next: next === -1 ? cursor : next };
      size += length + 1; if (size > 255) fail();
      const raw = packet.subarray(cursor, cursor + length);
      if (raw.some(byte => byte > 127)) fail();
      const label = raw.toString('ascii');
      if (!/^[a-z0-9_-]+$/i.test(label)) fail();
      labels.push(label.toLowerCase()); cursor += length;
    }
    return fail();
  }
  let offset = 12;
  const question = name(offset); offset = question.next;
  if (question.text !== expected.name || offset + 4 > packet.length || packet.readUInt16BE(offset) !== 1 || packet.readUInt16BE(offset + 2) !== 1) fail();
  offset += 4;
  const counts = [packet.readUInt16BE(6), packet.readUInt16BE(8), packet.readUInt16BE(10)];
  if (counts.reduce((sum, count) => sum + count, 0) > 128) fail();
  const answers = new Map<string, { aliases: Set<string>; addresses: Set<string> }>();
  for (const [section, count] of counts.entries()) for (let index = 0; index < count; index++) {
    const owner = name(offset); offset = owner.next;
    if (offset + 10 > packet.length) fail();
    const type = packet.readUInt16BE(offset), klass = packet.readUInt16BE(offset + 2), length = packet.readUInt16BE(offset + 8);
    offset += 10;
    const end = offset + length; if (end > packet.length) fail();
    if (type === 41 && ((packet.readUInt32BE(offset - 6) >>> 24) !== 0)) fail(); // extended RCODE
    if (type === 1 && length !== 4) fail();
    const alias = type === 5 ? name(offset) : null;
    if (alias && alias.next !== end) fail();
    if (section === 0 && klass === 1 && (type === 1 || type === 5)) {
      const item = answers.get(owner.text) ?? { aliases: new Set<string>(), addresses: new Set<string>() };
      if (alias) item.aliases.add(alias.text);
      else item.addresses.add([...packet.subarray(offset, end)].join('.'));
      answers.set(owner.text, item);
    }
    offset = end;
  }
  if (offset !== packet.length) fail();
  const seen = new Set<string>(); let current = expected.name;
  for (let depth = 0; depth < 16; depth++) {
    if (seen.has(current)) fail(); seen.add(current);
    const item = answers.get(current); if (!item) fail();
    if (item.aliases.size === 0 && item.addresses.size === 1 && item.addresses.has(ipv4)) return;
    if (item.aliases.size !== 1 || item.addresses.size !== 0) fail();
    current = [...item.aliases][0];
  }
  fail();
}

async function observe(plan: NetworkPlan, identity: NetworkProbeIdentity, input: NetworkProbeOptions,
  reader: NetworkProbeFixtureReader, scope: NetworkProbeObservation['scope']): Promise<NetworkProbeObservation> {
  const started = Date.now();
  let verified = false, commandsSettled = true;
  try {
    const options = validate(plan, identity, input);
    const before = await snapshot(plan, identity, reader, options);
    for (const protocol of ['udp', 'tcp'] as const) {
      const request = query(options.queryDomain);
      const reply = await reader.exchange(protocol, request.packet, plan.deployment.gatewayIPv4, plan.deployment.dnsPort, options.timeoutMs!);
      response(reply, request, options.expectedIPv4);
    }
    const after = await snapshot(plan, identity, reader, options);
    if (before !== after || Date.now() < started || Date.now() - started > 12_000) fail();
    verified = true;
  } catch (error) {
    // Never retain raw procfs, deployment name, DNS packet or nested cause.
    commandsSettled = !(error instanceof NetworkCommandError && error.childSettled === false);
  }
  return { scope, verified, commandsSettled, checkedAt: Date.now(), reason: verified ? null : 'NETWORK_PROBE_UNVERIFIED',
    checks: { dnsSocketsOwned: verified, dnsUdpQuery: verified, dnsTcpQuery: verified, tunOwned: verified }, terminalPath: 'unverified' };
}

/** Read-only kernel inspection and two explicitly loopback-bound DNS exchanges. No activation. */
export async function observeNetworkReadiness(plan: NetworkPlan, identity: NetworkProbeIdentity,
  options: NetworkProbeOptions): Promise<NetworkProbeObservation> {
  return observe(plan, identity, options, liveReader, 'production');
}

export async function observeNetworkReadinessFixture(plan: NetworkPlan, identity: NetworkProbeIdentity,
  options: NetworkProbeOptions, reader: NetworkProbeFixtureReader = {
    ...liveReader, root: true, address: options => readAddress(options, true),
  }): Promise<NetworkProbeObservation> {
  // Explicit isolated kernel fixtures may have procfs read permission through the
  // same UID/user namespace instead of host euid 0. This never changes scope.
  return observe(plan, identity, options, reader, 'fixture');
}
