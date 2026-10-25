import { createHash } from 'node:crypto';
import { types } from 'node:util';
import { NETWORK_TUN_ADDRESS, renderNetworkPlan, type NetworkPlan } from './plan.ts';

/** No supplied values, paths, parser diagnostics or nested causes escape. */
export class NetworkReadbackError extends Error {
  readonly code = 'NETWORK_READBACK_INVALID';
  constructor() { super('NETWORK_READBACK_INVALID'); this.name = 'NetworkReadbackError'; }
}
export interface NetworkReadbackInput { nft: string; ipv4Rules: string; ipv4Routes: string }
export interface NetworkReadbackExpectation {
  /** Trusted kernel-compiled reference, never a candidate supplied by an API caller. */
  nft: string;
  rules: 'absent' | 'partial' | 'complete';
  routes: 'absent' | 'partial' | 'prepared' | 'active' | 'retained';
}
export interface NftEchoUpdate {
  table: 'cocoproxy_guard' | 'cocoproxy_data';
  operation: 'create' | 'replace';
  /** Counts independently derived from the trusted renderer batch, not the echo. */
  ruleCounts: Record<string, number>;
}
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Obj = { [key: string]: Json };
function fail(): never { throw new NetworkReadbackError(); }
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

function object(value: unknown, allowed: readonly string[], required: readonly string[] = []): Obj {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail();
  const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(descriptors);
  if (keys.some(k => typeof k !== 'string' || !allowed.includes(k)) || required.some(k => !Object.hasOwn(descriptors, k))) fail();
  const result: Obj = Object.create(null);
  for (const k of keys as string[]) {
    const d = descriptors[k];
    if (!d.enumerable || !('value' in d)) fail();
    result[k] = d.value;
  }
  return result;
}

/** Bounded JSON parser also rejects duplicate keys (JSON.parse silently loses them). */
function parse(raw: unknown): Json {
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > 4_194_304) fail();
  let at = 0, nodes = 0;
  const ws = () => { while (/\s/.test(raw[at] ?? '') && at < raw.length) { if (!' \r\n\t'.includes(raw[at])) fail(); at++; } };
  const string = (): string => {
    const start = at++;
    while (at < raw.length) {
      const c = raw[at++];
      if (c === '"') return JSON.parse(raw.slice(start, at));
      if (c === '\\') at++;
      else if (c.charCodeAt(0) < 32) fail();
    }
    return fail();
  };
  const value = (depth: number): Json => {
    if (++nodes > 100_000 || depth > 32) fail();
    ws();
    if (raw[at] === '"') return string();
    if (raw[at] === '{') {
      at++; ws(); const out: Obj = Object.create(null);
      if (raw[at] === '}') { at++; return out; }
      while (true) {
        ws(); if (raw[at] !== '"') fail();
        const key = string();
        if (Object.hasOwn(out, key) || ['__proto__', 'constructor', 'prototype'].includes(key)) fail();
        ws(); if (raw[at++] !== ':') fail();
        out[key] = value(depth + 1); ws();
        const c = raw[at++]; if (c === '}') return out; if (c !== ',') fail();
      }
    }
    if (raw[at] === '[') {
      at++; ws(); const out: Json[] = [];
      if (raw[at] === ']') { at++; return out; }
      while (true) {
        out.push(value(depth + 1)); ws();
        const c = raw[at++]; if (c === ']') return out; if (c !== ',') fail();
      }
    }
    const token = /^(?:null|true|false|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(raw.slice(at))?.[0];
    if (!token) fail();
    at += token.length;
    const out: Json = JSON.parse(token);
    if (typeof out === 'number' && (!Number.isSafeInteger(out) || Object.is(out, -0))) fail();
    return out;
  };
  const out = value(0); ws(); if (at !== raw.length) fail(); return out;
}
function array(value: Json | undefined): Json[] { if (!Array.isArray(value)) fail(); return value; }
function integer(value: Json | undefined, min = 0, max = 0xffff_ffff): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) fail(); return value;
}
function canonical(value: Json): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  return JSON.stringify(value);
}
const chainDefinitions: Record<string, { table: string; type: string; hook: string; prio: number }> = {
  input_guard: { table: 'cocoproxy_guard', type: 'filter', hook: 'input', prio: -10 },
  forward_guard: { table: 'cocoproxy_guard', type: 'filter', hook: 'forward', prio: -10 },
  output_guard: { table: 'cocoproxy_guard', type: 'filter', hook: 'output', prio: -10 },
  classify_ingress: { table: 'cocoproxy_data', type: 'filter', hook: 'prerouting', prio: -150 },
  classify_output: { table: 'cocoproxy_data', type: 'route', hook: 'output', prio: -150 },
  classify_return: { table: 'cocoproxy_data', type: 'filter', hook: 'prerouting', prio: -149 },
};

/** Preserve expression order and every expression field. Only volatile handles and
 * known libnftables version metadata are omitted. Foreign objects fail closed. */
function nft(raw: unknown, identity = false): string {
  const root = object(parse(raw), ['nftables'], ['nftables']);
  const tables = new Map<string, Obj>(), chains = new Map<string, Obj>(), rules = new Map<string, Json[]>();
  let metadata = false;
  for (const entry of array(root.nftables)) {
    const wrapper = object(entry, ['metainfo', 'table', 'chain', 'rule']);
    const keys = Object.keys(wrapper); if (keys.length !== 1) fail();
    const kind = keys[0];
    if (kind === 'metainfo') {
      if (metadata) fail(); metadata = true;
      const info = object(wrapper.metainfo, ['version', 'release_name', 'json_schema_version'], ['json_schema_version']);
      if (info.json_schema_version !== 1 || ('version' in info && typeof info.version !== 'string') ||
        ('release_name' in info && typeof info.release_name !== 'string')) fail();
      continue;
    }
    const allowed = kind === 'table' ? ['family', 'name', 'handle'] : kind === 'chain' ?
      ['family', 'table', 'name', 'handle', 'type', 'hook', 'prio', 'policy'] :
      ['family', 'table', 'chain', 'handle', 'expr'];
    const o = object(wrapper[kind], allowed, kind === 'table' ? ['family', 'name'] : kind === 'chain' ?
      ['family', 'table', 'name', 'type', 'hook', 'prio', 'policy'] : ['family', 'table', 'chain', 'expr']);
    if (o.family !== 'inet' || ('handle' in o && integer(o.handle, 1, Number.MAX_SAFE_INTEGER) < 1)) fail();
    if (identity && !('handle' in o)) fail();
    if (!identity) delete o.handle;
    if (kind === 'table') {
      if (!['cocoproxy_guard', 'cocoproxy_data'].includes(o.name as string) || tables.has(o.name as string)) fail();
      tables.set(o.name as string, o); continue;
    }
    if (!tables.has(o.table as string)) fail();
    if (kind === 'chain') {
      const name = o.name as string, definition = chainDefinitions[name];
      if (!definition || chains.has(name) || o.table !== definition.table || o.type !== definition.type ||
        o.hook !== definition.hook || o.prio !== definition.prio || o.policy !== 'accept') fail();
      chains.set(name, o); rules.set(name, []); continue;
    }
    const name = o.chain as string;
    if (!chains.has(name) || chainDefinitions[name].table !== o.table || array(o.expr).length === 0) fail();
    rules.get(name)!.push(identity ? o : o.expr);
  }
  for (const [name, definition] of Object.entries(chainDefinitions)) if (tables.has(definition.table) !== chains.has(name)) fail();
  return canonical([...tables.keys()].sort().map(name => ({ table: identity ? tables.get(name)! : name, chains: [...chains].filter(([, o]) => o.table === name)
    .sort(([a], [b]) => a.localeCompare(b)).map(([name, chain]) => ({ chain, rules: rules.get(name)! })) })));
}

/** Reconstruct a full expected snapshot from a successful trusted command's
 * complete JSON echo. No current kernel listing is promoted into authority. */
export function nftSnapshotFromEcho(previous: string, echo: string, updates: readonly NftEchoUpdate[]): string {
  try {
    nft(previous, true);
    if (!Array.isArray(updates) || types.isProxy(updates) || Object.getPrototypeOf(updates) !== Array.prototype) fail();
    const descriptors = Object.getOwnPropertyDescriptors(updates) as unknown as Record<string, PropertyDescriptor>;
    const length = descriptors.length?.value as number;
    if (!Number.isSafeInteger(length) || length < 1 || length > 2 || Reflect.ownKeys(descriptors).length !== length + 1) fail();
    const specifications = new Map<string, { operation: string; counts: Obj }>();
    for (let i = 0; i < length; i++) {
      const descriptor = descriptors[String(i)];
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) fail();
      const update: unknown = descriptor.value;
      const o = object(update, ['table', 'operation', 'ruleCounts'], ['table', 'operation', 'ruleCounts']);
      if (!['cocoproxy_guard', 'cocoproxy_data'].includes(o.table as string) || specifications.has(o.table as string) ||
        !['create', 'replace'].includes(o.operation as string)) fail();
      const names = Object.keys(chainDefinitions).filter(name => chainDefinitions[name].table === o.table);
      const counts = object(o.ruleCounts, names, names);
      for (const count of Object.values(counts)) integer(count, 0, 10_000);
      specifications.set(o.table as string, { operation: o.operation as string, counts });
    }
    const before = array(object(parse(previous), ['nftables'], ['nftables']).nftables);
    const oldTables = new Set(before.flatMap(wrapper => {
      const o = wrapper as Obj; return o.table ? [((o.table as Obj).name as string)] : [];
    }));
    for (const [table, spec] of specifications) if (oldTables.has(table) !== (spec.operation === 'replace')) fail();
    const retained = before.filter(wrapper => {
      const o = wrapper as Obj;
      if (o.metainfo) return false;
      const body = (o.table ?? o.chain ?? o.rule) as Obj;
      const table = (o.table ? body.name : body.table) as string;
      return !(o.rule && specifications.has(table));
    });
    const added: Json[] = [], tableCounts = new Map<string, number>(), chainCounts = new Map<string, number>(),
      ruleCounts = new Map<string, number>(), flushes = new Set<string>();
    let metadata = false;
    for (const entry of array(object(parse(echo), ['nftables'], ['nftables']).nftables)) {
      const wrapper = object(entry, ['metainfo', 'add', 'flush']);
      const keys = Object.keys(wrapper); if (keys.length !== 1) fail();
      if (keys[0] === 'metainfo') {
        if (metadata) fail(); metadata = true;
        // Reuse the strict metadata validator without accepting any objects.
        nft(JSON.stringify({ nftables: [{ metainfo: wrapper.metainfo }] })); continue;
      }
      if (keys[0] === 'flush') {
        const f = object(wrapper.flush, ['chain'], ['chain']);
        const c = object(f.chain, ['family', 'table', 'name'], ['family', 'table', 'name']);
        const name = c.name as string;
        if (c.family !== 'inet' || !Object.hasOwn(chainDefinitions, name) || chainDefinitions[name].table !== c.table ||
          specifications.get(c.table as string)?.operation !== 'replace' || flushes.has(name) || ruleCounts.has(name)) fail();
        flushes.add(name); continue;
      }
      const a = object(wrapper.add, ['table', 'chain', 'rule']);
      if (Object.keys(a).length !== 1) fail();
      const kind = Object.keys(a)[0], body = a[kind] as Obj;
      if (!body || typeof body !== 'object' || Array.isArray(body)) fail();
      const table = (kind === 'table' ? body.name : body.table) as string;
      const spec = specifications.get(table); if (!spec) fail();
      if (kind === 'table') {
        if (spec.operation !== 'create') fail();
        tableCounts.set(table, (tableCounts.get(table) ?? 0) + 1);
      } else if (kind === 'chain') {
        if (spec.operation !== 'create' || !Object.hasOwn(spec.counts, body.name as string)) fail();
        const name = body.name as string; chainCounts.set(name, (chainCounts.get(name) ?? 0) + 1);
      } else {
        const name = body.chain as string;
        if (!Object.hasOwn(spec.counts, name)) fail();
        ruleCounts.set(name, (ruleCounts.get(name) ?? 0) + 1);
      }
      added.push(a);
    }
    for (const [table, spec] of specifications) {
      if ((tableCounts.get(table) ?? 0) !== (spec.operation === 'create' ? 1 : 0)) fail();
      for (const [name, count] of Object.entries(spec.counts)) {
        if ((chainCounts.get(name) ?? 0) !== (spec.operation === 'create' ? 1 : 0) ||
          (ruleCounts.get(name) ?? 0) !== count) fail();
      }
    }
    // Sort object categories so every table and chain is declared before its rules;
    // stable sorting retains the kernel's per-chain rule order.
    const ordered = [...retained, ...added].sort((a, b) => {
      const rank = (o: Json) => 'table' in (o as Obj) ? 0 : 'chain' in (o as Obj) ? 1 : 2;
      return rank(a) - rank(b);
    });
    const result = JSON.stringify({ nftables: ordered }); nft(result, true); return result;
  } catch { return fail(); }
}

function mark(value: Json | undefined): number {
  if (typeof value === 'number') return integer(value);
  if (typeof value !== 'string' || !/^(?:0x[0-9a-fA-F]{1,8}|\d{1,10})$/.test(value)) fail();
  return integer(Number(value));
}
function table(value: Json | undefined): number {
  if (value === 'local') return 255; if (value === 'main' || value === undefined) return 254;
  if (value === 'default') return 253;
  if (typeof value === 'string' && /^\d{1,10}$/.test(value)) return integer(Number(value), 1);
  return integer(value, 1);
}
function address(value: Json | undefined): string {
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,2})(\.(0|[1-9]\d{0,2})){3}$/.test(value) || value.split('.').some(o => Number(o) > 255)) fail();
  return value;
}
function prefix(value: Json | undefined): string {
  if (value === 'all' || value === 'default' || value === undefined) return '0.0.0.0/0';
  if (typeof value !== 'string') fail();
  const bits = value.split('/'); if (bits.length > 2) fail();
  const ip = address(bits[0]), width = bits.length === 1 ? 32 : Number(bits[1]);
  if (!Number.isInteger(width) || width < 0 || width > 32 || (bits.length === 2 && String(width) !== bits[1])) fail();
  const n = ip.split('.').reduce((n, octet) => n * 256 + Number(octet), 0);
  if (n % (2 ** (32 - width)) !== 0) fail();
  return ip + '/' + width;
}
function iface(value: Json | undefined): string {
  if (typeof value !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_.:-]{0,14}$/.test(value)) fail(); return value;
}
function protocol(value: Json | undefined): number | string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'number') return integer(value, 0, 255);
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,32}$/.test(value)) fail();
  if (/^\d+$/.test(value)) return integer(Number(value), 0, 255);
  const standard: Record<string, number> = { kernel: 2, boot: 3, static: 4, bgp: 186 };
  if (Object.hasOwn(standard, value)) return standard[value];
  return value;
}
function rpdb(plan: NetworkPlan, raw: unknown, state: NetworkReadbackExpectation['rules'],
  routeState: NetworkReadbackExpectation['routes']): number[] {
  const found = new Set<number>(), builtin = new Set<number>();
  for (const entry of array(parse(raw))) {
    const o = object(entry, ['priority', 'src', 'dst', 'fwmark', 'fwmask', 'iif', 'iif_detached', 'table', 'protocol'], ['priority', 'src', 'table']);
    const priority = integer(o.priority), routeTable = table(o.table);
    if (o.protocol !== undefined && !['boot', 'static', 'kernel', 0, 2, 3, 4].includes(protocol(o.protocol)!)) fail();
    const ordinary = { priority, src: prefix(o.src), table: routeTable };
    if (['0', '32766', '32767'].includes(String(priority))) {
      const target = priority === 0 ? 255 : priority === 32766 ? 254 : 253;
      if (routeTable !== target || ordinary.src !== '0.0.0.0/0' ||
        Object.keys(o).some(k => !['priority', 'src', 'table', 'protocol'].includes(k)) || builtin.has(priority)) fail();
      builtin.add(priority); continue;
    }
    const expected = plan.rules.find(r => r.priority === priority);
    if (!expected || found.has(priority) || state === 'absent' || routeTable !== expected.table || ordinary.src !== '0.0.0.0/0' ||
      mark(o.fwmark) !== expected.mark || mark(o.fwmask) !== expected.mask) fail();
    if (expected.role === 'return') {
      if (o.iif !== plan.deployment.tun.interface || prefix(o.dst) !== expected.destination) fail();
      // RPDB is installed while the core's TUN may still be absent. This kernel
      // annotation never authorizes an active path or a different rule selector.
      if ('iif_detached' in o && (o.iif_detached !== null || !['partial', 'prepared', 'retained'].includes(routeState))) fail();
    } else if ('iif' in o || 'dst' in o || 'iif_detached' in o) fail();
    found.add(priority);
  }
  if (builtin.size !== 3 || (state === 'complete' && found.size !== 3)) fail();
  return [...found].sort((a, b) => a - b);
}
type Route = { table: number; dst: string; type: string; protocol?: number | string; metric?: number;
  dev?: string; gateway?: string; prefsrc?: string; scope?: string };
function expectedRoutes(plan: NetworkPlan): Map<string, Route> {
  const result = new Map<string, Route>();
  for (const r of plan.blackholes) result.set('blackhole:' + r.role, { table: r.table, dst: r.destination, type: r.type,
    protocol: r.protocol, metric: r.metric });
  for (const [i, r] of plan.egressRoutes.entries()) result.set('egress:' + i, { table: r.table, dst: r.destination,
    type: r.type, protocol: r.protocol, metric: r.metric, dev: r.interface,
    ...('via' in r ? { gateway: r.via } : {}), ...('preferredSource' in r ? { prefsrc: r.preferredSource } : {}),
    ...('scope' in r ? { scope: r.scope } : {}) });
  const r = plan.captureRoute;
  result.set('capture', { table: r.table, dst: r.destination, type: r.type, protocol: r.protocol, metric: r.metric,
    dev: r.interface, scope: 'link' });
  return result;
}
function isKernelTunRoute(plan: NetworkPlan, route: Route): boolean {
  const [ip, length] = NETWORK_TUN_ADDRESS.split('/'), size = 2 ** (32 - Number(length));
  const number = ip.split('.').reduce((n, o) => n * 256 + Number(o), 0);
  const network = Math.floor(number / size) * size;
  const address = (n: number) => [24, 16, 8, 0].map(shift => (n >>> shift) & 255).join('.');
  const base = { dev: plan.deployment.tun.interface, protocol: 2, prefsrc: ip };
  const allowed: Route[] = [{ ...base, table: 254, dst: address(network) + '/' + length, type: 'unicast', scope: 'link' },
    { ...base, table: 255, dst: ip + '/32', type: 'local', scope: 'host' },
    ...[network, network + size - 1].map(n => ({ ...base, table: 255, dst: address(n) + '/32', type: 'broadcast', scope: 'link' }))];
  return allowed.some(expected => canonical(expected as unknown as Json) === canonical(route as unknown as Json));
}
function routes(plan: NetworkPlan, raw: unknown, state: NetworkReadbackExpectation['routes']): string[] {
  const expected = expectedRoutes(plan), seen = new Set<string>(), ownedTables = Object.values(plan.deployment.tables);
  for (const entry of array(parse(raw))) {
    const o = object(entry, ['type', 'dst', 'table', 'protocol', 'scope', 'prefsrc', 'metric', 'dev', 'gateway', 'flags'], ['dst']);
    if ('flags' in o && array(o.flags).length !== 0) fail();
    if ('type' in o && typeof o.type !== 'string') fail();
    const r: Route = { table: table(o.table), dst: prefix(o.dst), type: typeof o.type === 'string' ? o.type : 'unicast' };
    if ('protocol' in o) r.protocol = protocol(o.protocol);
    if ('metric' in o) r.metric = integer(o.metric);
    if ('dev' in o) r.dev = iface(o.dev);
    if ('gateway' in o) r.gateway = address(o.gateway);
    if ('prefsrc' in o) r.prefsrc = address(o.prefsrc);
    if ('scope' in o) {
      if (!['global', 'link', 'host'].includes(o.scope as string)) fail();
      if (o.scope !== 'global') r.scope = o.scope as string;
    }
    if (ownedTables.includes(r.table)) {
      if (state === 'absent') fail();
      const id = [...expected].find(([, e]) => canonical(e as unknown as Json) === canonical(r as unknown as Json))?.[0];
      if (!id || seen.has(id) || (id === 'capture' && ['prepared', 'retained'].includes(state))) fail();
      seen.add(id);
    } else {
      if (r.dev === plan.deployment.tun.interface) {
        if (!isKernelTunRoute(plan, r)) fail();
        continue;
      }
      if (![253, 254, 255].includes(r.table) ||
        !['unicast', 'local', 'broadcast', 'blackhole', 'unreachable', 'prohibit', 'throw'].includes(r.type)) fail();
      if (r.table === 255 && !['local', 'broadcast'].includes(r.type)) fail();
      // Priority-zero local delivery must never absorb the protected client.
      if (r.table === 255) {
        const [ip, length] = r.dst.split('/'), size = 2 ** (32 - Number(length));
        const number = (text: string) => text.split('.').reduce((n, o) => n * 256 + Number(o), 0);
        if (Math.floor(number(ip) / size) === Math.floor(number(plan.deployment.clientIPv4) / size)) fail();
      }
    }
  }
  if (['prepared', 'retained', 'active'].includes(state) && (seen.size !== (state === 'active' ? 8 : 7) ||
    [...expected.keys()].some(id => (id !== 'capture' || state === 'active') && !seen.has(id)))) fail();
  return [...seen].sort();
}

/** Pure structural comparison only. Driver must independently establish private
 * ownership receipts, trusted compiler provenance, namespace and exclusive writer. */
export function verifyNetworkReadback(deployment: unknown, input: NetworkReadbackInput, expected: NetworkReadbackExpectation) {
  try {
    const plan = renderNetworkPlan(deployment);
    const raw = object(input, ['nft', 'ipv4Rules', 'ipv4Routes'], ['nft', 'ipv4Rules', 'ipv4Routes']);
    const want = object(expected, ['nft', 'rules', 'routes'], ['nft', 'rules', 'routes']);
    if (!['absent', 'partial', 'complete'].includes(want.rules as string) ||
      !['absent', 'partial', 'prepared', 'active', 'retained'].includes(want.routes as string)) fail();
    const nftState = nft(raw.nft);
    if (nftState !== nft(want.nft)) fail();
    const nftIdentity = nft(raw.nft, true);
    if (nftIdentity !== nft(want.nft, true)) fail();
    const rulesPresent = rpdb(plan, raw.ipv4Rules, want.rules as NetworkReadbackExpectation['rules'],
      want.routes as NetworkReadbackExpectation['routes']);
    const routesPresent = routes(plan, raw.ipv4Routes, want.routes as NetworkReadbackExpectation['routes']);
    const nftSha256 = digest(nftState);
    const nftIdentitySha256 = digest(nftIdentity);
    return Object.freeze({ sha256: digest(canonical({ nftSha256, nftIdentitySha256, rulesPresent, routesPresent })), nftSha256, nftIdentitySha256,
      rulesPresent: Object.freeze(rulesPresent), routesPresent: Object.freeze(routesPresent) });
  } catch { return fail(); }
}
