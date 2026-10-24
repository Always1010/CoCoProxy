import { constants } from 'node:fs';
import { lstat, open, readdir, readlink, realpath, statfs } from 'node:fs/promises';
import { release } from 'node:os';
import { posix } from 'node:path';
import { types } from 'node:util';
import { NetworkCommandError, runNetworkCommand } from './command.ts';
import { readKernelBpf } from './host-bpf.ts';
import { renderNetworkPlan, type NetworkPlan } from './plan.ts';

export interface NetworkHostOptions {
  ipBinary: string;
  tcBinary: string;
  iptablesLegacySaveBinary: string;
  ip6tablesLegacySaveBinary: string;
}
export interface NetworkHostObservation {
  scope: 'production' | 'fixture';
  verified: boolean;
  commandsSettled: boolean;
  checkedAt: number;
  generation: string | null;
  planSha256: string | null;
  reason: null | 'NETWORK_HOST_UNVERIFIED';
  checks: { platform: boolean; trustedViews: boolean; sysctls: boolean; bypassAbsent: boolean; stable: boolean };
}
type Tool = 'ip' | 'tc' | 'iptables-legacy-save' | 'ip6tables-legacy-save';
export interface NetworkHostMetadata { uid: bigint; mode: bigint; dev: bigint; ino: bigint; ctimeNs: bigint }
/** Trusted synthetic seam. It can never produce production scope. */
export interface NetworkHostFixtureReader {
  platform: string;
  arch: string;
  kernelRelease: string;
  uid: number;
  pid: number;
  now(): number;
  read(path: string): Promise<string>;
  metadata(path: string): Promise<NetworkHostMetadata>;
  fsType(path: string): Promise<bigint>;
  link(path: string): Promise<string>;
  realpath(path: string): Promise<string>;
  entries(path: string): Promise<string[]>;
  command(tool: Tool, args: readonly string[]): Promise<string>;
  /** Fixed native read-only BPF inventory; no supplied acceptance booleans. */
  bpf(): Promise<string>;
}
type Obj = Record<string, unknown>;
const ROOT = '/sys/fs/cgroup';
const tools: Tool[] = ['ip', 'tc', 'iptables-legacy-save', 'ip6tables-legacy-save'];
const optionKeys = ['ipBinary', 'tcBinary', 'iptablesLegacySaveBinary', 'ip6tablesLegacySaveBinary'];
const prefixes = ['/usr/sbin/', '/usr/bin/', '/sbin/', '/bin/'];
const fail: () => never = () => { throw new Error('NETWORK_HOST_UNVERIFIED'); };
const bounded = (raw: string, maximum = 262144) => {
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > maximum || raw.includes('\0')) fail();
  return raw;
};
function object(value: unknown, allowed?: readonly string[], required: readonly string[] = []): Obj {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail();
  const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(descriptors);
  if (keys.some(key => typeof key !== 'string' || (allowed && !allowed.includes(key))) ||
    required.some(key => !Object.hasOwn(descriptors, key))) fail();
  const out: Obj = Object.create(null);
  for (const key of keys as string[]) {
    if (!descriptors[key].enumerable || !('value' in descriptors[key])) fail();
    out[key] = descriptors[key].value;
  }
  return out;
}
/** Bounded JSON, including rejection of duplicate or escaped duplicate keys. */
function parse(raw: string): unknown {
  bounded(raw); let at = 0, nodes = 0;
  const ws = () => { while (at < raw.length && ' \r\n\t'.includes(raw[at])) at++; };
  function string(): string {
    const start = at++;
    while (at < raw.length) {
      const char = raw[at++];
      if (char === '"') return JSON.parse(raw.slice(start, at));
      if (char === '\\') at++;
      else if (char.charCodeAt(0) < 32) fail();
    }
    return fail();
  }
  function value(depth: number): unknown {
    if (++nodes > 32768 || depth > 16) fail();
    ws();
    if (raw[at] === '"') return string();
    if (raw[at] === '{') {
      at++; ws(); const out: Obj = Object.create(null);
      if (raw[at] === '}') { at++; return out; }
      for (;;) {
        ws(); if (raw[at] !== '"') fail(); const key = string();
        if (Object.hasOwn(out, key) || ['__proto__', 'constructor', 'prototype'].includes(key)) fail();
        ws(); if (raw[at++] !== ':') fail(); out[key] = value(depth + 1); ws();
        const separator = raw[at++]; if (separator === '}') return out; if (separator !== ',') fail();
      }
    }
    if (raw[at] === '[') {
      at++; ws(); const out: unknown[] = [];
      if (raw[at] === ']') { at++; return out; }
      for (;;) {
        out.push(value(depth + 1)); ws(); const separator = raw[at++];
        if (separator === ']') return out; if (separator !== ',') fail();
      }
    }
    const token = /^(?:null|true|false|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(raw.slice(at))?.[0];
    if (!token) fail(); at += token.length; const out: unknown = JSON.parse(token);
    if (typeof out === 'number' && (!Number.isSafeInteger(out) || Object.is(out, -0))) fail();
    return out;
  }
  const result = value(0); ws(); if (at !== raw.length) fail(); return result;
}
function array(value: unknown): unknown[] { if (!Array.isArray(value)) fail(); return value; }
function empty(raw: string, allowEmpty = false): void {
  if (allowEmpty && bounded(raw).trim() === '') return;
  if (array(parse(raw)).length) fail();
}
function names(value: unknown): string[] {
  const out = array(value);
  if (out.some(name => typeof name !== 'string' || !/^[A-Za-z0-9_.-]{1,15}$/.test(name) || ['.', '..'].includes(name)) ||
    new Set(out).size !== out.length) fail();
  return out as string[];
}
function stamp(value: NetworkHostMetadata): string {
  return [value.uid, value.mode, value.dev, value.ino, value.ctimeNs].join(':');
}
async function trustedPath(reader: NetworkHostFixtureReader, path: string, executable = false): Promise<string[]> {
  const proofs: string[] = [];
  for (let current = path;; current = posix.dirname(current)) {
    const stat = await reader.metadata(current), type = stat.mode & 0o170000n;
    if (stat.uid !== 0n || (stat.mode & 0o022n) !== 0n ||
      (current === path && executable ? type !== 0o100000n || (stat.mode & 0o111n) === 0n : type !== 0o040000n)) fail();
    proofs.push(current + ':' + stamp(stat));
    if (current === '/') return proofs;
  }
}
function options(input: NetworkHostOptions): Record<Tool, string> {
  const value = object(input, optionKeys, optionKeys), paths = Object.create(null) as Record<Tool, string>;
  for (const [index, tool] of tools.entries()) {
    const path = value[optionKeys[index]];
    if (typeof path !== 'string' || !prefixes.some(prefix => path === prefix + tool)) fail();
    paths[tool] = path;
  }
  return paths;
}
async function trustedTool(reader: NetworkHostFixtureReader, path: string, tool: Tool): Promise<string[]> {
  const target = await reader.realpath(path);
  const basenames = tool.endsWith('legacy-save') ? [tool, 'xtables-legacy-multi'] : [tool];
  if (!prefixes.some(prefix => basenames.some(name => target === prefix + name))) fail();
  const result = await trustedPath(reader, target, true);
  // Distribution /bin and /sbin aliases are root-owned symlinks. Preserve the
  // original argv[0], especially for xtables-legacy-multi's save dispatch.
  for (let current = path;; current = posix.dirname(current)) {
    const stat = await reader.metadata(current), type = stat.mode & 0o170000n;
    if (stat.uid !== 0n || (type !== 0o120000n && (stat.mode & 0o022n) !== 0n) ||
      ![0o040000n, 0o100000n, 0o120000n].includes(type)) fail();
    result.push(current + ':' + stamp(stat)); if (current === '/') break;
  }
  return result;
}
const overlap = (left: string, right: string) => left === right || left.startsWith(right + '/') || right.startsWith(left + '/');
async function context(reader: NetworkHostFixtureReader, paths: Record<Tool, string>) {
  if (reader.platform !== 'linux' || reader.uid !== 0 || !['x64', 'arm64'].includes(reader.arch) ||
    !/^6\.([1-9]\d*)\.\d+(?:[-+.][A-Za-z0-9_.+-]+)?$/.test(reader.kernelRelease) ||
    !Number.isSafeInteger(reader.pid) || reader.pid < 2 || reader.pid > 0x7fffffff) fail();
  const mountinfo = bounded(await reader.read('/proc/self/mountinfo'));
  const mounts = mountinfo.trim().split('\n').map(line => {
    const parts = line.split(' - '); if (parts.length !== 2) fail();
    const left = parts[0].split(' '), right = parts[1].split(' ');
    if (left.length < 6 || right.length !== 3 || !/^\d+$/.test(left[0]) || !/^\d+$/.test(left[1]) ||
      !/^\d+:\d+$/.test(left[2]) || !left[3].startsWith('/') || !left[4].startsWith('/')) fail();
    return { left, right };
  });
  const procPaths = ['/proc/self', '/proc/1', `/proc/${reader.pid}`, '/proc/sys/net/ipv4', '/proc/sys/kernel/random/boot_id'];
  for (const [target, filesystem, magic] of [['/proc', 'proc', 0x9fa0n], ['/sys', 'sysfs', 0x62656572n], [ROOT, 'cgroup2', 0x63677270n]] as const) {
    const mounted = mounts.filter(mount => mount.left[4] === target);
    if (mounted.length !== 1 || mounted[0].left[3] !== '/' || mounted[0].right[0] !== filesystem ||
      await reader.fsType(target) !== magic || mounts.some(mount => mount.left[4].startsWith(target + '/') &&
        (target === ROOT || (target === '/proc' ? procPaths : ['/sys/class/net', '/sys/devices']).some(path => overlap(mount.left[4], path))))) fail();
  }
  const namespaces: string[] = [];
  for (const name of ['user', 'net', 'pid', 'cgroup', 'mnt']) {
    const init = await reader.link(`/proc/1/ns/${name}`);
    if (!new RegExp(`^${name}:\\[[1-9]\\d*\\]$`).test(init) || await reader.link(`/proc/self/ns/${name}`) !== init) fail();
    namespaces.push(init);
  }
  const uidMap = bounded(await reader.read('/proc/self/uid_map'), 4096);
  if (!/^\s*0\s+0\s+4294967295\s*$/.test(uidMap) ||
    !/^\s*0\s+0\s+4294967295\s*$/.test(bounded(await reader.read('/proc/1/uid_map'), 4096))) fail();
  const status = bounded(await reader.read('/proc/self/status'), 65536);
  if (!/^Uid:\s+0\s+0\s+0\s+0\s*$/m.test(status) ||
    !new RegExp(`^NSpid:\\s+${reader.pid}\\s*$`, 'm').test(status)) fail();
  const bootId = bounded(await reader.read('/proc/sys/kernel/random/boot_id'), 128).trim();
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(bootId)) fail();
  const proofs = await trustedPath(reader, ROOT);
  for (const tool of tools) proofs.push(...await trustedTool(reader, paths[tool], tool));
  return { mountinfo, namespaces, bootId, proofs };
}
const linkKeys = ['ifindex', 'ifname', 'flags', 'mtu', 'qdisc', 'operstate', 'group', 'txqlen', 'link_type', 'address',
  'broadcast', 'link_index', 'link', 'link_netnsid', 'linkinfo', 'altnames', 'allmulti', 'promiscuity', 'min_mtu', 'max_mtu',
  'num_tx_queues', 'num_rx_queues', 'gso_max_size', 'gso_max_segs', 'tso_max_size', 'tso_max_segs', 'gro_max_size',
  'gso_ipv4_max_size', 'gro_ipv4_max_size', 'inet6_addr_gen_mode', 'parentbus', 'parentdev', 'permaddr', 'ifalias',
  'carrier', 'mode', 'linkmode', 'proto_down', 'addrgenmode', 'master', 'xdp'];
function links(raw: string, plan: NetworkPlan, fixture: boolean): Obj[] {
  const rows = array(parse(raw)).map(value => object(value, linkKeys, ['ifindex', 'ifname', 'link_type', 'flags']));
  if (!rows.length || rows.length > 64) fail();
  names(rows.map(row => row.ifname));
  if (new Set(rows.map(row => row.ifindex)).size !== rows.length) fail();
  for (const row of rows) {
    if (!Number.isSafeInteger(row.ifindex) || (row.ifindex as number) < 1 || Object.hasOwn(row, 'xdp')) fail();
    const flags = array(row.flags);
    if (flags.some(flag => typeof flag !== 'string') || new Set(flags).size !== flags.length) fail();
  }
  const ingress = rows.find(row => row.ifname === plan.deployment.ingressInterface);
  if (!ingress || ingress.link_type !== 'ether' || ingress.master !== undefined) fail();
  if (ingress.linkinfo !== undefined) {
    const info = object(ingress.linkinfo, ['info_kind', 'info_data'], ['info_kind']);
    if (!fixture || info.info_kind !== 'veth' || (info.info_data !== undefined && Object.keys(object(info.info_data)).length)) fail();
  } else if (ingress.link_index !== undefined || ingress.link !== undefined || ingress.link_netnsid !== undefined) fail();
  return rows.sort((left, right) => (left.ifname as string).localeCompare(right.ifname as string));
}
function qdiscs(raw: string): Obj[] {
  const rows = array(parse(raw)).map(value => object(value, ['kind', 'handle', 'root', 'parent', 'refcnt', 'options'], ['kind', 'handle', 'options']));
  if (!rows.length || rows.length > 128) fail();
  for (const row of rows) {
    if (!['noqueue', 'fq_codel', 'pfifo_fast', 'mq', 'ingress', 'clsact'].includes(row.kind as string) ||
      typeof row.handle !== 'string' || !/^(?:0|[1-9a-f][a-f0-9]{0,3}):$/.test(row.handle) ||
      (row.root !== undefined && row.root !== true) || (row.root === true) === (row.parent !== undefined) ||
      (row.parent !== undefined && (typeof row.parent !== 'string' || !/^[a-f0-9]{0,4}:[a-f0-9]{0,4}$/.test(row.parent))) ||
      (row.refcnt !== undefined && (!Number.isSafeInteger(row.refcnt) || (row.refcnt as number) < 0))) fail();
    const optionKeys = row.kind === 'fq_codel' ? ['limit', 'flows', 'quantum', 'target', 'interval', 'memory_limit', 'ecn',
      'ce_threshold', 'ce_threshold_selector', 'ce_threshold_mask', 'drop_batch'] : row.kind === 'pfifo_fast' ? ['bands', 'priomap', 'multiqueue'] : [];
    const options = object(row.options, optionKeys);
    for (const [key, value] of Object.entries(options)) {
      if (key === 'priomap') {
        if (array(value).length !== 16 || array(value).some(item => !Number.isSafeInteger(item) || (item as number) < 0 || (item as number) > 15)) fail();
      } else if (['ecn', 'multiqueue'].includes(key)) { if (typeof value !== 'boolean') fail(); }
      else if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 0xffffffff) fail();
    }
  }
  return rows;
}
function bpfInventory(raw: string): Obj {
  const keys = ['schemaVersion', 'devicePrograms', 'inventorySha256'];
  const value = object(parse(raw), keys, keys);
  if (value.schemaVersion !== 1 || !Number.isSafeInteger(value.devicePrograms) || (value.devicePrograms as number) < 0 ||
    (value.devicePrograms as number) > 4096 || typeof value.inventorySha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.inventorySha256)) fail();
  return value;
}
/** Strict legacy save grammar: only complete tables with built-in ACCEPT chains. */
function legacy(raw: string): void {
  const text = bounded(raw); if (!text.trim()) return;
  const tables: Record<string, string[]> = { filter: ['INPUT', 'FORWARD', 'OUTPUT'], nat: ['PREROUTING', 'INPUT', 'OUTPUT', 'POSTROUTING'],
    mangle: ['PREROUTING', 'INPUT', 'FORWARD', 'OUTPUT', 'POSTROUTING'], raw: ['PREROUTING', 'OUTPUT'], security: ['INPUT', 'FORWARD', 'OUTPUT'] };
  let active: string | null = null; const seen = new Set<string>(), chains = new Set<string>(); let committed = 0;
  for (const line of text.split('\n')) {
    if (line === '' || line.startsWith('#')) continue;
    if (line.startsWith('*')) {
      const name = line.slice(1); if (active || !Object.hasOwn(tables, name) || seen.has(name)) fail();
      active = name; seen.add(name); chains.clear(); continue;
    }
    if (line === 'COMMIT') {
      if (!active || tables[active].some(chain => !chains.has(chain))) fail();
      active = null; committed++; continue;
    }
    const chain = /^:([A-Z]+) ACCEPT \[\d+:\d+\]$/.exec(line);
    if (!active || !chain || !tables[active].includes(chain[1]) || chains.has(chain[1])) fail();
    chains.add(chain[1]);
  }
  if (active || committed === 0) fail();
}
async function snapshot(reader: NetworkHostFixtureReader, plan: NetworkPlan, paths: Record<Tool, string>, fixture: boolean,
  command: (tool: Tool, args: readonly string[]) => Promise<string>, observeBpf: () => Promise<string>) {
  const before = await context(reader, paths);
  const rows = links(await command('ip', ['-d', '-j', 'link', 'show']), plan, fixture);
  const interfaces = rows.map(row => row.ifname as string);
  if (JSON.stringify(names(await reader.entries('/sys/class/net')).sort()) !== JSON.stringify([...interfaces].sort())) fail();
  const physical = await reader.realpath('/sys/class/net/' + plan.deployment.ingressInterface);
  if (!physical.startsWith('/sys/devices/') || (!fixture && physical.startsWith('/sys/devices/virtual/')) ||
    !physical.endsWith('/net/' + plan.deployment.ingressInterface)) fail();
  const physicalProof = await trustedPath(reader, physical);
  if (await reader.fsType(physical) !== 0x62656572n) fail();
  if (bounded(await reader.read('/proc/sys/net/ipv4/ip_forward'), 32).trim() !== '1') fail();
  for (const name of ['all', 'default', plan.deployment.ingressInterface,
    ...(interfaces.includes(plan.deployment.tun.interface) ? [plan.deployment.tun.interface] : [])]) {
    for (const setting of ['rp_filter', 'send_redirects', 'accept_redirects', 'accept_source_route', 'route_localnet']) {
      if (bounded(await reader.read(`/proc/sys/net/ipv4/conf/${name}/${setting}`), 32).trim() !== '0') fail();
    }
  }
  empty(await command('ip', ['-j', 'xfrm', 'policy', 'list']), true);
  empty(await command('ip', ['-j', 'xfrm', 'state', 'list']), true);
  const queues: unknown[] = [];
  for (const name of interfaces) {
    const discs = qdiscs(await command('tc', ['-j', 'qdisc', 'show', 'dev', name]));
    queues.push({ name, discs });
    const parents = new Set(discs.flatMap(row => [row.handle as string, ...(row.parent ? [row.parent as string] : [])]));
    for (const location of ['root', 'ingress', 'egress']) empty(await command('tc', ['-j', 'filter', 'show', 'dev', name, location]));
    for (const parent of parents) empty(await command('tc', ['-j', 'filter', 'show', 'dev', name, 'parent', parent]));
  }
  const bpf = bpfInventory(await observeBpf());
  legacy(await command('iptables-legacy-save', [])); legacy(await command('ip6tables-legacy-save', []));
  const after = await context(reader, paths);
  if (JSON.stringify(before) !== JSON.stringify(after)) fail();
  return { context: after, rows, queues, bpf, physicalProof };
}
function liveReader(paths: Record<Tool, string>): NetworkHostFixtureReader {
  const reader: NetworkHostFixtureReader = { platform: process.platform, arch: process.arch, kernelRelease: release(),
    uid: process.geteuid?.() ?? -1, pid: process.pid, now: Date.now,
    async read(path) {
      const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const bytes = Buffer.alloc(262145); let used = 0;
        for (;;) {
          const result = await fd.read(bytes, used, bytes.length - used, null); used += result.bytesRead;
          if (used > 262144) fail();
          if (!result.bytesRead) return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, used));
        }
      } finally { await fd.close(); }
    },
    async metadata(path) { return lstat(path, { bigint: true }); },
    async fsType(path) { return (await statfs(path, { bigint: true })).type; },
    link: readlink, realpath, entries: readdir, bpf: readKernelBpf,
    async command(tool, args) {
      await trustedTool(reader, paths[tool], tool);
      return runNetworkCommand(paths[tool], args, { timeoutMs: 750, maxOutputBytes: 262144 });
    },
  };
  return reader;
}
async function observe(input: unknown, settings: NetworkHostOptions, supplied: NetworkHostFixtureReader | undefined,
  fixture: boolean): Promise<NetworkHostObservation> {
  let verified = false, commandsSettled = true, generation: string | null = null, planSha256: string | null = null;
  let checkedAt = Date.now();
  try {
    const plan = renderNetworkPlan(input); generation = plan.deployment.generation; planSha256 = plan.sha256;
    const paths = options(settings), reader = supplied ?? liveReader(paths), started = reader.now();
    if (!Number.isSafeInteger(started) || started <= 0) fail();
    const withinDeadline = () => {
      const now = reader.now(); if (!Number.isSafeInteger(now) || now < started || now - started > 10000) fail(); return now;
    };
    const command = async (tool: Tool, args: readonly string[]) => {
      withinDeadline();
      try { return await reader.command(tool, args); }
      catch (error) { commandsSettled = error instanceof NetworkCommandError && error.childSettled; throw error; }
    };
    const observeBpf = async () => {
      withinDeadline();
      try { return await reader.bpf(); }
      catch (error) { commandsSettled = error instanceof NetworkCommandError && error.childSettled; throw error; }
    };
    const before = await snapshot(reader, plan, paths, fixture, command, observeBpf);
    const after = await snapshot(reader, plan, paths, fixture, command, observeBpf);
    checkedAt = withinDeadline();
    if (JSON.stringify(before) !== JSON.stringify(after)) fail();
    verified = true;
  } catch { /* Fixed public result: no topology, command output, paths or nested errors. */ }
  return { scope: fixture ? 'fixture' : 'production', verified, commandsSettled, checkedAt, generation, planSha256,
    reason: verified ? null : 'NETWORK_HOST_UNVERIFIED', checks: { platform: verified, trustedViews: verified,
      sysctls: verified, bypassAbsent: verified, stable: verified } };
}
/** Fixed, root-only, read-only host observations. No installation, repair or ARP. */
export async function observeNetworkHost(deployment: unknown, options: NetworkHostOptions): Promise<NetworkHostObservation> {
  return observe(deployment, options, undefined, false);
}
export async function observeNetworkHostFixture(deployment: unknown, options: NetworkHostOptions,
  reader: NetworkHostFixtureReader): Promise<NetworkHostObservation> {
  return observe(deployment, options, reader, true);
}
