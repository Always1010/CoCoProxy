import { lstat, realpath } from 'node:fs/promises';
import { isIP } from 'node:net';
import { dirname } from 'node:path';
import { types } from 'node:util';
import { runNetworkCommand } from './command.ts';
import { renderNetworkPlan, type NetworkPlan } from './plan.ts';

export interface NetworkLinkOptions {
  ipBinary: '/usr/sbin/ip' | '/usr/bin/ip' | '/sbin/ip' | '/bin/ip';
  /** Trusted deployment probe destination; route lookup only, no packet sent. */
  probeIPv4: string;
}
export interface NetworkLinkObservation {
  scope: 'production' | 'fixture';
  verified: boolean;
  checkedAt: number;
  planSha256: string | null;
  generation: string | null;
  reason: null | 'NETWORK_LINK_UNVERIFIED';
  checks: { interfaceIdentity: boolean; carrier: boolean; gatewayAddress: boolean; mtu: boolean;
    routerNeighbour: boolean; egressRoute: boolean; stable: boolean };
}
/** Trusted test seam; observations can never acquire production scope. */
export interface NetworkLinkFixtureReader {
  platform: string;
  root: boolean;
  command(args: readonly string[]): Promise<string>;
  now(): number;
}
type Json = null | boolean | number | string | Json[] | Obj;
type Obj = { [key: string]: Json };
function fail(): never { throw new Error('NETWORK_LINK_UNVERIFIED'); }
const binaries = ['/usr/sbin/ip', '/usr/bin/ip', '/sbin/ip', '/bin/ip'];

function record(value: unknown, allowed?: readonly string[], required: readonly string[] = []): Obj {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail();
  const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(descriptors);
  if (keys.some(key => typeof key !== 'string' || (allowed && !allowed.includes(key))) ||
    required.some(key => !Object.hasOwn(descriptors, key))) fail();
  const out: Obj = Object.create(null);
  for (const key of keys as string[]) {
    const descriptor = descriptors[key];
    if (!descriptor.enumerable || !('value' in descriptor)) fail();
    out[key] = descriptor.value;
  }
  return out;
}

/** Bounded JSON parsing rejects repeated keys, including escaped spellings. */
function parse(raw: string): Json {
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > 65_536) fail();
  let at = 0, nodes = 0;
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
  function value(depth: number): Json {
    if (++nodes > 4096 || depth > 16) fail();
    ws();
    if (raw[at] === '"') return string();
    if (raw[at] === '{') {
      at++; ws(); const out: Obj = Object.create(null);
      if (raw[at] === '}') { at++; return out; }
      for (;;) {
        ws(); if (raw[at] !== '"') fail();
        const key = string();
        if (Object.hasOwn(out, key) || ['__proto__', 'constructor', 'prototype'].includes(key)) fail();
        ws(); if (raw[at++] !== ':') fail();
        out[key] = value(depth + 1); ws();
        const separator = raw[at++]; if (separator === '}') return out; if (separator !== ',') fail();
      }
    }
    if (raw[at] === '[') {
      at++; ws(); const out: Json[] = [];
      if (raw[at] === ']') { at++; return out; }
      for (;;) {
        out.push(value(depth + 1)); ws();
        const separator = raw[at++]; if (separator === ']') return out; if (separator !== ',') fail();
      }
    }
    const token = /^(?:null|true|false|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(raw.slice(at))?.[0];
    if (!token) fail(); at += token.length;
    const out: Json = JSON.parse(token);
    if (typeof out === 'number' && (!Number.isSafeInteger(out) || Object.is(out, -0))) fail();
    return out;
  }
  const result = value(0); ws(); if (at !== raw.length) fail(); return result;
}
function array(value: Json | undefined): Json[] { if (!Array.isArray(value)) fail(); return value; }
function integer(value: Json | undefined, min = 0, max = 0xffff_ffff): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) fail(); return value;
}
function strings(value: Json | undefined): string[] {
  const entries = array(value);
  if (entries.some(entry => typeof entry !== 'string') || new Set(entries).size !== entries.length) fail();
  return entries as string[];
}
function one(raw: string, allowed: readonly string[], required: readonly string[]): Obj {
  const entries = array(parse(raw)); if (entries.length !== 1) fail(); return record(entries[0], allowed, required);
}
function mac(value: Json | undefined): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/.test(value) ||
    value === '00:00:00:00:00:00' || (parseInt(value.slice(0, 2), 16) & 1) !== 0) fail(); return value;
}
function ipNumber(value: string): number {
  if (isIP(value) !== 4) fail();
  return value.split('.').reduce((total, octet) => total * 256 + Number(octet), 0);
}

async function trustedBinary(path: string, fixture: boolean): Promise<string> {
  if (!binaries.includes(path)) fail();
  const binary = await realpath(path);
  if (!binaries.includes(binary)) fail();
  for (let current = binary;; current = dirname(current)) {
    const metadata = await lstat(current, { bigint: true });
    if ((metadata.uid !== 0n && !(fixture && metadata.uid === 65534n)) || (metadata.mode & 0o022n) !== 0n ||
      metadata.isSymbolicLink() || (current === binary ? !metadata.isFile() || (metadata.mode & 0o111n) === 0n : !metadata.isDirectory())) fail();
    if (current === '/') break;
  }
  return binary;
}

const linkKeys = ['ifindex', 'ifname', 'flags', 'mtu', 'qdisc', 'operstate', 'group', 'txqlen', 'link_type',
  'address', 'broadcast', 'link_index', 'link_netnsid', 'linkinfo', 'addr_info', 'altnames', 'allmulti', 'promiscuity',
  'min_mtu', 'max_mtu', 'num_tx_queues', 'num_rx_queues', 'gso_max_size', 'gso_max_segs', 'tso_max_size',
  'tso_max_segs', 'gro_max_size', 'gso_ipv4_max_size', 'gro_ipv4_max_size', 'event', 'inet6_addr_gen_mode',
  'parentbus', 'parentdev', 'permaddr', 'ifalias', 'carrier', 'mode', 'linkmode', 'proto_down', 'addrgenmode', 'master'];

function link(raw: string, plan: NetworkPlan, fixture: boolean, address: boolean) {
  const input = one(raw, linkKeys, ['ifindex', 'ifname', 'flags', 'mtu', 'operstate', 'link_type', 'address']);
  const flags = strings(input.flags);
  if (input.ifname !== plan.deployment.ingressInterface || input.link_type !== 'ether' || input.operstate !== 'UP' ||
    !flags.includes('UP') || !flags.includes('LOWER_UP') ||
    flags.some(flag => ['NO-CARRIER', 'LOOPBACK', 'POINTOPOINT', 'NOARP', 'SLAVE', 'MASTER'].includes(flag)) ||
    Object.hasOwn(input, 'master') || (Object.hasOwn(input, 'carrier') && input.carrier !== 1) ||
    (Object.hasOwn(input, 'proto_down') && input.proto_down !== false)) fail();
  if (Object.hasOwn(input, 'linkinfo')) {
    const info = record(input.linkinfo, ['info_kind', 'info_data'], []);
    if (info.info_kind !== undefined && (!fixture || info.info_kind !== 'veth')) fail();
    if (info.info_data !== undefined && Object.keys(record(info.info_data, [])).length !== 0) fail();
  }
  // With -d physical interfaces may contain counters and driver identity strings.
  for (const key of ['txqlen', 'allmulti', 'promiscuity', 'min_mtu', 'max_mtu', 'num_tx_queues', 'num_rx_queues',
    'gso_max_size', 'gso_max_segs', 'tso_max_size', 'tso_max_segs', 'gro_max_size', 'gso_ipv4_max_size', 'gro_ipv4_max_size']) {
    if (Object.hasOwn(input, key)) integer(input[key]);
  }
  if (input.promiscuity !== undefined && input.promiscuity !== 0) fail();
  for (const key of ['qdisc', 'group', 'broadcast', 'event', 'inet6_addr_gen_mode', 'parentbus', 'parentdev', 'ifalias', 'mode', 'linkmode', 'addrgenmode']) {
    if (input[key] !== undefined && typeof input[key] !== 'string' && !(key === 'group' && typeof input[key] === 'number')) fail();
  }
  if (input.altnames !== undefined) strings(input.altnames);
  if (input.permaddr !== undefined) mac(input.permaddr);
  if (input.link_index !== undefined) integer(input.link_index, 1);
  if (input.link_netnsid !== undefined) integer(input.link_netnsid, -1, 0x7fffffff);
  const mtu = integer(input.mtu, plan.deployment.tun.mtu, 0x7fffffff);
  const identity = { ifindex: integer(input.ifindex, 1, 0x7fffffff), address: mac(input.address), mtu,
    flags: [...flags].sort(), kind: input.linkinfo === undefined ? null : record(input.linkinfo).info_kind ?? null };
  const addressIdentity = address ? addresses(input.addr_info, plan) : null;
  if (!address && input.addr_info !== undefined) fail();
  return { identity, addresses: addressIdentity };
}

function addresses(value: Json | undefined, plan: NetworkPlan): string[] {
  const entries = array(value), locals = new Set<string>(); let gateway = 0;
  if (entries.length > 16) fail();
  for (const entry of entries) {
    const input = record(entry, ['family', 'local', 'prefixlen', 'broadcast', 'scope', 'label', 'valid_life_time',
      'preferred_life_time', 'dynamic', 'secondary', 'tentative', 'deprecated', 'dadfailed', 'mngtmpaddr',
      'noprefixroute', 'flags', 'metric', 'protocol'], ['family', 'local', 'prefixlen', 'scope']);
    if (typeof input.local !== 'string' || locals.has(input.local)) fail(); locals.add(input.local);
    for (const key of ['dynamic', 'secondary', 'tentative', 'deprecated', 'dadfailed', 'mngtmpaddr', 'noprefixroute']) {
      if (input[key] !== undefined && typeof input[key] !== 'boolean') fail();
    }
    if (['secondary', 'tentative', 'deprecated', 'dadfailed'].some(key => input[key] === true)) fail();
    if (input.flags !== undefined && strings(input.flags).some(flag => ['secondary', 'tentative', 'deprecated', 'dadfailed'].includes(flag))) fail();
    for (const key of ['valid_life_time', 'preferred_life_time']) if (input[key] !== undefined && input[key] !== 'forever') integer(input[key], 1);
    if (input.metric !== undefined) integer(input.metric);
    if (input.protocol !== undefined && typeof input.protocol !== 'string' && typeof input.protocol !== 'number') fail();
    if (input.broadcast !== undefined && (typeof input.broadcast !== 'string' || isIP(input.broadcast) !== 4)) fail();
    if (input.family === 'inet') {
      if (++gateway !== 1 || input.local !== plan.deployment.gatewayIPv4 || input.prefixlen !== plan.deployment.prefixLength ||
        input.scope !== 'global' || (input.label !== undefined && input.label !== plan.deployment.ingressInterface)) fail();
    } else if (input.family === 'inet6') {
      // A normal Linux ethernet interface may retain its own link-local IPv6.
      if (isIP(input.local) !== 6 || !/^fe[89ab][0-9a-f]:/i.test(input.local) || input.scope !== 'link' || input.label !== undefined) fail();
      integer(input.prefixlen, 1, 128);
    } else fail();
  }
  if (gateway !== 1) fail();
  return [...locals].sort();
}

function neighbour(raw: string, plan: NetworkPlan): string {
  const input = one(raw, ['dst', 'dev', 'lladdr', 'state', 'flags', 'router', 'probes', 'used', 'confirmed', 'updated', 'protocol'],
    ['dst', 'lladdr', 'state']);
  // iproute2 deliberately omits dev when the request already supplies dev.
  // The fixed kernel query supplies that fact; any emitted dev must still agree.
  if (input.dst !== plan.deployment.routerIPv4 || (input.dev !== undefined && input.dev !== plan.deployment.ingressInterface) ||
    mac(input.lladdr) !== plan.deployment.routerMAC) fail();
  const states = strings(input.state);
  if (states.length !== 1 || !['REACHABLE', 'PERMANENT'].includes(states[0])) fail();
  if (input.flags !== undefined && strings(input.flags).length !== 0) fail();
  if (input.router !== undefined && input.router !== null && typeof input.router !== 'boolean') fail();
  for (const key of ['probes', 'used', 'confirmed', 'updated']) if (input[key] !== undefined) integer(input[key]);
  if (input.protocol !== undefined && typeof input.protocol !== 'string' && typeof input.protocol !== 'number') fail();
  return states[0];
}

function route(raw: string, plan: NetworkPlan, probe: string): void {
  const input = one(raw, ['dst', 'from', 'gateway', 'dev', 'table', 'prefsrc', 'mark', 'uid', 'flags', 'cache',
    'type', 'protocol', 'scope', 'metric'], ['dst', 'from', 'gateway', 'dev', 'table', 'mark', 'uid', 'flags']);
  const deployment = plan.deployment;
  if (input.dst !== probe || input.from !== deployment.gatewayIPv4 || input.gateway !== deployment.routerIPv4 ||
    input.dev !== deployment.ingressInterface || input.mark !== deployment.marks.egress || input.uid !== deployment.core.serviceUid ||
    (input.table !== deployment.tables.egress && input.table !== String(deployment.tables.egress)) ||
    (input.prefsrc !== undefined && input.prefsrc !== deployment.gatewayIPv4) ||
    (input.type !== undefined && input.type !== 'unicast') || strings(input.flags).length !== 0) fail();
  if (input.cache !== undefined && array(input.cache).length !== 0) fail();
  if (input.metric !== undefined) integer(input.metric);
  for (const key of ['protocol', 'scope']) if (input[key] !== undefined && typeof input[key] !== 'string' && typeof input[key] !== 'number') fail();
}

async function observe(input: NetworkPlan, optionsInput: NetworkLinkOptions,
  supplied: NetworkLinkFixtureReader | undefined, fixture: boolean): Promise<NetworkLinkObservation> {
  let verified = false, planSha256: string | null = null, generation: string | null = null;
  const now = supplied ? () => supplied.now() : Date.now;
  let checkedAt = Date.now();
  try {
    const descriptors = record(input);
    const plan = renderNetworkPlan(descriptors.deployment);
    if (descriptors.sha256 !== plan.sha256) fail();
    planSha256 = plan.sha256; generation = plan.deployment.generation;
    const options = record(optionsInput, ['ipBinary', 'probeIPv4'], ['ipBinary', 'probeIPv4']);
    if (typeof options.ipBinary !== 'string' || !binaries.includes(options.ipBinary) || typeof options.probeIPv4 !== 'string') fail();
    const destination = ipNumber(options.probeIPv4), first = Math.floor(destination / 2 ** 24), size = 2 ** (32 - plan.deployment.prefixLength);
    // Route lookup targets may be documentation/test addresses in fixtures, but
    // must be unicast outside the deployment and complete reserved TUN /15.
    if (first === 0 || first === 127 || first >= 224 || Math.floor(destination / 65536) === 0xa9fe ||
      Math.floor(destination / 131072) === Math.floor(ipNumber('198.18.0.1') / 131072) ||
      Math.floor(destination / size) === Math.floor(ipNumber(plan.deployment.gatewayIPv4) / size)) fail();
    const started = now(); if (!Number.isSafeInteger(started) || started < 0) fail();
    let reader = supplied;
    if (!reader) {
      const binary = await trustedBinary(options.ipBinary, fixture);
      reader = { platform: process.platform, root: typeof process.geteuid === 'function' && process.geteuid() === 0,
        command: args => runNetworkCommand(binary, args, { timeoutMs: 500, maxOutputBytes: 65_536 }), now: Date.now };
      if (fixture) reader.root = true;
    }
    if (reader.platform !== 'linux' || !reader.root) fail();
    const rounds: string[] = [];
    for (let index = 0; index < 2; index++) {
      const deployment = plan.deployment;
      const linked = link(await reader.command(['-d', '-j', 'link', 'show', 'dev', deployment.ingressInterface]), plan, fixture, false);
      const addressed = link(await reader.command(['-d', '-j', 'address', 'show', 'dev', deployment.ingressInterface]), plan, fixture, true);
      if (JSON.stringify(linked.identity) !== JSON.stringify(addressed.identity)) fail();
      const state = neighbour(await reader.command(['-j', '-4', 'neigh', 'show', 'to', deployment.routerIPv4, 'dev', deployment.ingressInterface]), plan);
      route(await reader.command(['-j', '-4', '-N', 'route', 'get', options.probeIPv4, 'from', deployment.gatewayIPv4,
        'mark', String(deployment.marks.egress), 'uid', String(deployment.core.serviceUid)]), plan, options.probeIPv4);
      rounds.push(JSON.stringify({ linked: linked.identity, addresses: addressed.addresses, state }));
    }
    const ended = now();
    if (!Number.isSafeInteger(ended) || ended < started || ended - started > 5000 || rounds[0] !== rounds[1]) fail();
    checkedAt = ended; verified = true;
  } catch { /* Raw kernel output, topology and nested errors never leave this observer. */ }
  return { scope: fixture ? 'fixture' : 'production', verified, checkedAt, planSha256, generation,
    reason: verified ? null : 'NETWORK_LINK_UNVERIFIED', checks: { interfaceIdentity: verified, carrier: verified,
      gatewayAddress: verified, mtu: verified, routerNeighbour: verified, egressRoute: verified, stable: verified } };
}

/** Fixed read-only ip queries; no packet exchange or network mutation. */
export async function observeNetworkLink(plan: NetworkPlan, options: NetworkLinkOptions): Promise<NetworkLinkObservation> {
  return observe(plan, options, undefined, false);
}
export async function observeNetworkLinkFixture(plan: NetworkPlan, options: NetworkLinkOptions,
  reader?: NetworkLinkFixtureReader): Promise<NetworkLinkObservation> {
  return observe(plan, options, reader, true);
}
