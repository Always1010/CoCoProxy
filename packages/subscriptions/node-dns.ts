import { BlockList, isIP } from 'node:net';
import type { JsonObject } from '../config/index.ts';

/** Private resolver endpoints must never be included in diagnostics. */
export class NodeDnsPolicyError extends Error {
  readonly code: 'SNAPSHOT_INVALID' | 'SNAPSHOT_LIMIT';
  constructor(code: 'SNAPSHOT_INVALID' | 'SNAPSHOT_LIMIT') { super(code); this.code = code; }
}
const invalid: () => never = () => { throw new NodeDnsPolicyError('SNAPSHOT_INVALID'); };
const limit: () => never = () => { throw new NodeDnsPolicyError('SNAPSHOT_LIMIT'); };
const restricted = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) restricted.addSubnet(network, prefix, 'ipv4');
const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
const restrictedV6 = new BlockList();
for (const [network, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]] as const) {
  restrictedV6.addSubnet(network, prefix, 'ipv6');
}

function domain(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const host = value.toLowerCase().replace(/\.$/, '');
  if (host.length > 253 || isIP(host) || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/.test(host) ||
      ['__proto__', 'constructor', 'prototype'].includes(host)) return undefined;
  return host;
}

function ownEntries(value: unknown): [string, unknown][] | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return undefined;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some(key => typeof key !== 'string')) return undefined;
  const entries: [string, unknown][] = [];
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!descriptor.enumerable || !('value' in descriptor)) return undefined;
    entries.push([key, descriptor.value]);
  }
  return entries;
}

function resolvers(value: unknown): string[] {
  const entries: unknown[] = typeof value === 'string' ? [value] : Array.isArray(value) ? value : invalid();
  if (!entries.length) invalid();
  if (entries.length > 16) limit();
  const output: string[] = [];
  for (let index = 0; index < entries.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(entries, String(index));
    if (!descriptor?.enumerable || !('value' in descriptor)) invalid();
    const entry: unknown = descriptor.value;
    if (typeof entry !== 'string' || !entry || /[\s\u0000-\u001f\u007f\\?#]/.test(entry)) invalid();
    if (entry.length > 2048) limit();
    const family = isIP(entry);
    if (family) {
      if (entry.includes('%') || (family === 4 ? restricted.check(entry, 'ipv4') :
        !globalV6.check(entry, 'ipv6') || restrictedV6.check(entry, 'ipv6'))) invalid();
    } else {
      let endpoint: URL;
      try { endpoint = new URL(entry); } catch { invalid(); }
      const host = endpoint.hostname.replace(/^\[|\]$/g, '');
      if (!/^https:\/\//i.test(entry) || endpoint.protocol !== 'https:' || !host ||
          (!isIP(host) && !domain(host)) || endpoint.username || endpoint.password ||
          entry.slice(entry.indexOf('//') + 2).split('/', 1)[0].includes('@') ||
          endpoint.pathname === '/' || endpoint.port === '0') invalid();
    }
    output.push(entry);
  }
  return output;
}

function budget(policy: JsonObject): void {
  if (Object.keys(policy).length > 256 || Buffer.byteLength(JSON.stringify(policy), 'utf8') > 64 * 1024) limit();
}

/** Strict stored form: only exact hosts of retained nodes, with resolver arrays. */
export function validateNodeDnsPolicy(value: unknown, proxies: JsonObject[]): JsonObject {
  const entries = ownEntries(value);
  if (!entries?.length) invalid();
  const hosts = new Set(proxies.map(node => domain(node.server)).filter(Boolean));
  const result: JsonObject = {};
  for (const [key, value] of entries) {
    if (domain(key) !== key || !hosts.has(key) || !Array.isArray(value)) invalid();
    result[key] = resolvers(value);
    budget(result);
  }
  return result;
}

/** Project safe upstream matchers onto actual node hosts; no DNS side effects. */
export function extractNodeDnsPolicy(dns: unknown, proxies: JsonObject[]): JsonObject | undefined {
  const fields = ownEntries(dns);
  if (!fields) return undefined;
  const hosts = [...new Set(proxies.map(node => domain(node.server)).filter((host): host is string => !!host))];
  const selected = new Map<string, { priority: number; servers: string[] }>();
  for (const [field, tier] of [['nameserver-policy', 0], ['proxy-server-nameserver-policy', 1]] as const) {
    const matchers = ownEntries(fields.find(([key]) => key === field)?.[1]);
    if (!matchers) continue;
    for (const [pattern, value] of matchers) {
      const suffix = pattern.startsWith('+.');
      const key = domain(suffix ? pattern.slice(2) : pattern);
      // Broad TLD suffixes and core-specific matcher expressions are ignored.
      if (!key || (suffix && !key.includes('.'))) continue;
      const matched = hosts.filter(host => host === key || (suffix && host.endsWith('.' + key)));
      if (!matched.length) continue;
      const servers = resolvers(value);
      const priority = tier * 1000 + (suffix ? key.length : 500);
      for (const host of matched) {
        if (!selected.has(host) || selected.get(host)!.priority < priority) selected.set(host, { priority, servers });
      }
    }
  }
  if (!selected.size) return undefined;
  const result: JsonObject = {};
  for (const host of [...selected.keys()].sort()) {
    result[host] = [...selected.get(host)!.servers];
    budget(result);
  }
  return result;
}
