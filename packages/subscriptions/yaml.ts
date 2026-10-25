import { isIP } from 'node:net';
import { isAlias, isMap, isScalar, isSeq, parseDocument } from 'yaml';
import type { JsonObject, JsonValue } from '../config/index.ts';
import { extractNodeDnsPolicy, validateNodeDnsPolicy, NodeDnsPolicyError } from './node-dns.ts';

export type SnapshotDecodeCode = 'SNAPSHOT_DECODE_FAILED' | 'SNAPSHOT_UNSUPPORTED' | 'SNAPSHOT_INVALID' | 'SNAPSHOT_LIMIT';

/** No parser diagnostics, property paths or upstream values cross this boundary. */
export class SnapshotDecodeError extends Error {
  readonly code: SnapshotDecodeCode;
  constructor(code: SnapshotDecodeCode) { super(code); this.name = 'SnapshotDecodeError'; this.code = code; }
}

const MAX_INPUT_BYTES = 1024 * 1024;
const MAX_JSON_BYTES = 4 * 1024 * 1024;
const MAX_DEPTH = 48;
const MAX_VALUES = 100_000;
const MAX_ALIASES = 50;
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const CORE_TAGS = new Set(['map', 'seq', 'str', 'null', 'bool', 'int', 'float'].map(tag => `tag:yaml.org,2002:${tag}`));
const fail: (code: SnapshotDecodeCode) => never = code => { throw new SnapshotDecodeError(code); };

/** Bound the syntax tree before conversion, including content we do not import. */
function checkTree(root: unknown): void {
  const pending = [{ node: root, depth: 0 }];
  let values = 0;
  let aliases = 0;
  while (pending.length) {
    const { node, depth } = pending.pop()!;
    if (++values > MAX_VALUES || depth > MAX_DEPTH) fail('SNAPSHOT_LIMIT');
    if (node === null) continue;
    if (isAlias(node)) {
      if (++aliases > MAX_ALIASES) fail('SNAPSHOT_LIMIT');
      continue;
    }
    if (!isMap(node) && !isSeq(node) && !isScalar(node)) fail('SNAPSHOT_INVALID');
    if (node.tag && !CORE_TAGS.has(node.tag)) fail('SNAPSHOT_UNSUPPORTED');
    if (isMap(node)) {
      for (const pair of node.items) {
        if (!isScalar(pair.key) || typeof pair.key.value !== 'string' || UNSAFE_KEYS.has(pair.key.value)) fail('SNAPSHOT_INVALID');
        pending.push({ node: pair.key, depth: depth + 1 }, { node: pair.value, depth: depth + 1 });
      }
    } else if (isSeq(node)) {
      for (const item of node.items) pending.push({ node: item, depth: depth + 1 });
    }
  }
}

/** Expand aliases into independent ordinary JSON values without calling hooks. */
function plainJson(input: unknown): JsonValue {
  let values = 0;
  let bytes = 0;
  const ancestors = new Set<object>();
  const charge = (amount: number) => {
    bytes += amount;
    if (bytes > MAX_JSON_BYTES) fail('SNAPSHOT_LIMIT');
  };
  const copy = (value: unknown, depth: number): JsonValue => {
    if (++values > MAX_VALUES || depth > MAX_DEPTH) fail('SNAPSHOT_LIMIT');
    if (value === null || typeof value === 'boolean') { charge(5); return value; }
    if (typeof value === 'string') { charge(Buffer.byteLength(value, 'utf8')); return value; }
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) fail('SNAPSHOT_INVALID');
      charge(24); return value;
    }
    if (!value || typeof value !== 'object' || ancestors.has(value)) fail('SNAPSHOT_INVALID');
    const array = Array.isArray(value);
    if (!array && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) fail('SNAPSHOT_INVALID');
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(descriptors).some(key => typeof key !== 'string')) fail('SNAPSHOT_INVALID');
    ancestors.add(value);
    let result: JsonValue;
    if (array) {
      if (value.length > MAX_VALUES || Object.keys(descriptors).some(key => key !== 'length' &&
          (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length))) fail('SNAPSHOT_INVALID');
      const items: JsonValue[] = [];
      for (let index = 0; index < value.length; index++) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) fail('SNAPSHOT_INVALID');
        items.push(copy(descriptor.value, depth + 1));
      }
      result = items;
    } else {
      const object: JsonObject = {};
      for (const [key, descriptor] of Object.entries(descriptors)) {
        if (UNSAFE_KEYS.has(key) || !descriptor.enumerable || !('value' in descriptor)) fail('SNAPSHOT_INVALID');
        charge(Buffer.byteLength(key, 'utf8'));
        object[key] = copy(descriptor.value, depth + 1);
      }
      result = object;
    }
    ancestors.delete(value);
    return result;
  };
  return copy(input, 0);
}

/**
 * Import only inline nodes from JSON or a single Clash YAML 1.2 document.
 * Upstream policy, deployment, scripts and remote providers are never imported.
 * Node field safety and names are subsequently validated by SubscriptionStore.
 */
function decodeDocument(text: string): JsonValue {
  try {
    if (typeof text !== 'string') fail('SNAPSHOT_DECODE_FAILED');
    if (Buffer.byteLength(text, 'utf8') > MAX_INPUT_BYTES) fail('SNAPSHOT_LIMIT');
    const document = parseDocument(text, {
      version: '1.2', schema: 'core', strict: true, uniqueKeys: true, stringKeys: true,
      customTags: [], resolveKnownTags: false, merge: false, prettyErrors: false,
      // `silent` also disables parseDocument's multiple-document error.
      logLevel: 'error',
    });
    if (document.errors.length || document.warnings.length) fail('SNAPSHOT_DECODE_FAILED');
    if (document.directives.yaml.version !== '1.2' || Object.entries(document.directives.tags).some(
      ([handle, prefix]) => handle !== '!!' || prefix !== 'tag:yaml.org,2002:',
    )) fail('SNAPSHOT_UNSUPPORTED');
    checkTree(document.contents);
    return plainJson(document.toJS({ mapAsMap: false, maxAliasCount: MAX_ALIASES }));
  } catch (error) {
    if (error instanceof SnapshotDecodeError) throw error;
    throw new SnapshotDecodeError('SNAPSHOT_DECODE_FAILED');
  }
}

export function decodeNodeSnapshot(text: string): unknown {
  try {
    const value = decodeDocument(text);
    if (value === null || typeof value !== 'object' || Array.isArray(value) || !Object.hasOwn(value, 'proxies')) fail('SNAPSHOT_UNSUPPORTED');
    if (!Array.isArray(value.proxies) || value.proxies.some(node => node === null || typeof node !== 'object' || Array.isArray(node))) fail('SNAPSHOT_INVALID');
    const nodeDnsPolicy = nodePolicy(value.dns, value.proxies as JsonObject[]);
    return { proxies: value.proxies, ...(nodeDnsPolicy ? { nodeDnsPolicy } : {}) };
  } catch (error) {
    if (error instanceof SnapshotDecodeError) throw error;
    throw new SnapshotDecodeError('SNAPSHOT_DECODE_FAILED');
  }
}

/**
 * Full inline Mihomo policy. The store validates every retained field through
 * compileConfig; it never permits upstream deployment settings to take effect.
 * External providers cannot be made offline safely here and fail explicitly.
 */
export function decodeSubscriptionProfile(text: string): unknown {
  return profileDocument(decodeDocument(text));
}

function nodePolicy(dns: unknown, proxies: JsonObject[]): JsonObject | undefined {
  try { return extractNodeDnsPolicy(dns, proxies); }
  catch (error) { fail(error instanceof NodeDnsPolicyError ? error.code : 'SNAPSHOT_INVALID'); }
}

function profileDocument(value: JsonValue, providerPolicy?: JsonObject): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('SNAPSHOT_UNSUPPORTED');
  if (Object.hasOwn(value, 'proxy-providers') || Object.hasOwn(value, 'rule-providers')) fail('SNAPSHOT_UNSUPPORTED');
  if (!['proxies', 'proxy-groups', 'rules', 'sub-rules'].some(key => Object.hasOwn(value, key))) fail('SNAPSHOT_UNSUPPORTED');
  const proxies = value.proxies ?? [];
  if (!Array.isArray(proxies) || proxies.some(node => node === null || typeof node !== 'object' || Array.isArray(node))) fail('SNAPSHOT_INVALID');
  const nodeDnsPolicy = { ...providerPolicy, ...nodePolicy(value.dns, proxies as JsonObject[]) };
  if (Object.keys(nodeDnsPolicy).length) {
    try { validateNodeDnsPolicy(nodeDnsPolicy, proxies as JsonObject[]); }
    catch (error) { fail(error instanceof NodeDnsPolicyError ? error.code : 'SNAPSHOT_INVALID'); }
  }
  const nodeDns = Object.keys(nodeDnsPolicy).length ? { nodeDnsPolicy } : {};
  // Node-only input keeps the legacy digest and representation.
  if (Object.keys(value).every(key => key === 'proxies')) return { proxies, ...nodeDns };
  const deployment = new Set([
    'mode', 'port', 'socks-port', 'redir-port', 'tproxy-port', 'mixed-port',
    'allow-lan', 'bind-address', 'lan-allowed-ips', 'lan-disallowed-ips',
    'authentication', 'skip-auth-prefixes', 'listeners', 'tunnels', 'tun',
    'external-controller', 'external-controller-tls', 'external-controller-unix',
    'external-controller-pipe', 'external-controller-cors', 'secret',
    'external-controller-routing-mark', 'external-doh-server',
    'external-ui', 'external-ui-url', 'external-ui-name', 'tls',
    'iptables', 'tuic-server', 'ss-config', 'vmess-config', 'ntp', 'clash-for-android',
    'dns', 'hosts', 'sniffer', 'ipv6', 'profile',
    'x-cocoproxy-network', 'x-cocoproxy-gateway',
    'geodata-mode', 'geodata-loader', 'geosite-matcher', 'geo-auto-update',
    'geo-update-interval', 'geox-url',
  ]);
  const policy: JsonObject = { proxies };
  const unsupportedFields: string[] = [];
  for (const [key, entry] of Object.entries(value)) {
    if (deployment.has(key)) unsupportedFields.push(key);
    else policy[key] = entry;
  }
  return { proxies, policy, ...nodeDns, ...(unsupportedFields.length ? { unsupportedFields: unsupportedFields.sort() } : {}) };
}

type ProviderFetcher = (url: string) => Promise<{ status: string; text?: string }>;
const object = (value: JsonValue | undefined): JsonObject => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('SNAPSHOT_INVALID');
  return value;
};
const strings = (value: JsonValue | undefined): string[] => {
  if (!Array.isArray(value) || value.some(entry => typeof entry !== 'string')) fail('SNAPSHOT_INVALID');
  return value as string[];
};

/** Filters intentionally accept a bounded, non-nesting regular-expression subset. */
function filterPattern(value: JsonValue | undefined): RegExp | undefined {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string' || value.length > 256 || /[(){}+?\\]/.test(value) ||
      value.split('|').some(part => (part.match(/\.\*/g)?.length ?? 0) > 1 || part.replace(/\.\*/g, '').includes('*'))) fail('SNAPSHOT_UNSUPPORTED');
  try { return new RegExp(value); } catch { fail('SNAPSHOT_INVALID'); }
}

function nodeFilter(settings: JsonObject): (node: JsonObject) => boolean {
  const include = filterPattern(settings.filter);
  const exclude = filterPattern(settings['exclude-filter']);
  const excluded = settings['exclude-type'];
  const excludedTypes = excluded === undefined ? [] : typeof excluded === 'string' && /^[A-Za-z0-9_|-]{1,256}$/.test(excluded)
    ? excluded.split('|') : strings(excluded);
  return node => typeof node.name === 'string' && (!include || include.test(node.name)) &&
    (!exclude || !exclude.test(node.name)) && !excludedTypes.includes(String(node.type));
}

function providerUrl(value: JsonValue | undefined): string {
  if (typeof value !== 'string' || value.length > 8192 || /[\s\u0000-\u001f\u007f\\#]/.test(value)) fail('SNAPSHOT_UNSUPPORTED');
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !/^https?:\/\//i.test(value)) fail('SNAPSHOT_UNSUPPORTED');
  } catch { fail('SNAPSHOT_UNSUPPORTED'); }
  return value;
}

/** Materialize bounded providers through the caller's existing restricted transport. */
export async function resolveSubscriptionProfile(text: string, fetch: ProviderFetcher): Promise<{ value: unknown; materializedProviders: boolean }> {
  const root = object(decodeDocument(text));
  const proxyDefinitions = root['proxy-providers'] === undefined ? {} : object(root['proxy-providers']);
  const ruleDefinitions = root['rule-providers'] === undefined ? {} : object(root['rule-providers']);
  const count = Object.keys(proxyDefinitions).length + Object.keys(ruleDefinitions).length;
  if (count > 16) fail('SNAPSHOT_LIMIT');
  const groups = root['proxy-groups'];
  if (groups !== undefined && !Array.isArray(groups)) fail('SNAPSHOT_INVALID');
  if (Array.isArray(groups) && groups.length > 1_000) fail('SNAPSHOT_LIMIT');
  if (!Object.hasOwn(root, 'proxy-providers') && !Object.hasOwn(root, 'rule-providers')) return { value: profileDocument(root), materializedProviders: false };
  let bytes = Buffer.byteLength(text, 'utf8');
  const download = async (definition: JsonObject): Promise<string> => {
    if (definition.type !== 'http' || definition.payload !== undefined || definition.header !== undefined || definition.proxy !== undefined) fail('SNAPSHOT_UNSUPPORTED');
    const response = await fetch(providerUrl(definition.url));
    // No provider ETag is sent and no provider cache exists.
    if (response.status !== 'modified' || typeof response.text !== 'string') fail('SNAPSHOT_UNSUPPORTED');
    const size = Buffer.byteLength(response.text, 'utf8');
    bytes += size;
    if (size > MAX_INPUT_BYTES || bytes > MAX_JSON_BYTES) fail('SNAPSHOT_LIMIT');
    return response.text;
  };
  const checkDefinition = (definition: JsonObject, allowed: string[]) => {
    if (Object.keys(definition).some(key => !allowed.includes(key))) fail('SNAPSHOT_UNSUPPORTED');
    if (definition.type !== 'inline' && definition.type !== 'http') fail('SNAPSHOT_UNSUPPORTED');
    if (definition.type === 'inline' && (definition.url !== undefined || definition.path !== undefined)) fail('SNAPSHOT_UNSUPPORTED');
    if (definition.interval !== undefined && (typeof definition.interval !== 'number' || !Number.isSafeInteger(definition.interval) || definition.interval < 1)) fail('SNAPSHOT_INVALID');
    if (definition.path !== undefined && typeof definition.path !== 'string') fail('SNAPSHOT_INVALID');
  };
  const inline = root.proxies === undefined ? [] : root.proxies;
  if (!Array.isArray(inline)) fail('SNAPSHOT_INVALID');
  // Charge retained expansion incrementally, before appending to output arrays.
  // The final plainJson check also accounts for the unexpanded policy fields.
  let expandedValues = 0;
  let expandedBytes = 0;
  const charge = (value: JsonValue): void => {
    if (++expandedValues > MAX_VALUES) fail('SNAPSHOT_LIMIT');
    if (typeof value === 'string') expandedBytes += Buffer.byteLength(value, 'utf8');
    else if (typeof value === 'number') expandedBytes += 24;
    else if (value === null || typeof value === 'boolean') expandedBytes += 5;
    else if (Array.isArray(value)) { for (const item of value) charge(item); }
    else {
      for (const [key, item] of Object.entries(value)) {
        expandedBytes += Buffer.byteLength(key, 'utf8');
        if (expandedBytes > MAX_JSON_BYTES) fail('SNAPSHOT_LIMIT');
        charge(item);
      }
    }
    if (expandedBytes > MAX_JSON_BYTES) fail('SNAPSHOT_LIMIT');
  };
  const nodes: JsonObject[] = [];
  const appendNode = (node: JsonObject, target?: JsonObject[]): void => {
    if (nodes.length >= 5_000) fail('SNAPSHOT_LIMIT');
    charge(node);
    nodes.push(node);
    target?.push(node);
  };
  for (const entry of inline) appendNode(object(entry));
  const providerNodes = new Map<string, JsonObject[]>();
  const providerPolicy: JsonObject = {};
  for (const [name, entry] of Object.entries(proxyDefinitions)) {
    const definition = object(entry);
    checkDefinition(definition, ['type', 'url', 'path', 'interval', 'payload', 'filter', 'exclude-filter', 'exclude-type', 'override', 'health-check']);
    // Provider health checks are replaced by the importing group's normal check.
    if (definition['health-check'] !== undefined) {
      const health = object(definition['health-check']);
      if (Object.keys(health).some(key => !['enable', 'url', 'interval', 'timeout', 'lazy', 'expected-status'].includes(key))) fail('SNAPSHOT_UNSUPPORTED');
      for (const [key, value] of Object.entries(health)) {
        if (['enable', 'lazy'].includes(key) ? typeof value !== 'boolean' : ['interval', 'timeout'].includes(key)
          ? typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 : typeof value !== 'string') fail('SNAPSHOT_INVALID');
      }
    }
    let payload: JsonValue | undefined = definition.payload;
    let providerDns: JsonValue | undefined;
    if (definition.type !== 'inline') {
      const document = object(decodeDocument(await download(definition)));
      if (Object.keys(document).some(key => key !== 'proxies' && key !== 'dns')) fail('SNAPSHOT_UNSUPPORTED');
      payload = document.proxies;
      providerDns = document.dns;
    }
    if (!Array.isArray(payload)) fail('SNAPSHOT_INVALID');
    const overrides = definition.override === undefined ? {} : object(definition.override);
    if (overrides.name !== undefined) fail('SNAPSHOT_UNSUPPORTED');
    const prefix = overrides['additional-prefix'] ?? '';
    const suffix = overrides['additional-suffix'] ?? '';
    if (typeof prefix !== 'string' || typeof suffix !== 'string') fail('SNAPSHOT_INVALID');
    const nodeOverrides = { ...overrides };
    delete nodeOverrides['additional-prefix']; delete nodeOverrides['additional-suffix'];
    const accepts = nodeFilter(definition);
    const imported: JsonObject[] = [];
    for (const value of payload) {
      const node = object(value);
      if (typeof node.name !== 'string') fail('SNAPSHOT_INVALID');
      const candidate = { ...node, ...nodeOverrides, name: prefix + node.name + suffix };
      if (accepts(candidate)) appendNode(candidate, imported);
    }
    providerNodes.set(name, imported);
    for (const [host, servers] of Object.entries(nodePolicy(providerDns, imported) ?? {})) {
      if (providerPolicy[host] !== undefined && JSON.stringify(providerPolicy[host]) !== JSON.stringify(servers)) fail('SNAPSHOT_INVALID');
      providerPolicy[host] = servers;
    }
  }
  root.proxies = nodes;
  if (Array.isArray(groups)) {
    for (const entry of groups) {
      const group = object(entry);
      const uses = group.use === undefined ? [] : strings(group.use);
      for (const flag of ['include-all', 'include-all-proxies', 'include-all-providers']) {
        if (group[flag] !== undefined && typeof group[flag] !== 'boolean') fail('SNAPSHOT_INVALID');
      }
      const existing = group.proxies === undefined ? [] : strings(group.proxies);
      // Filters on an explicitly enumerated group have core-specific semantics.
      if (!uses.length && !['include-all', 'include-all-proxies', 'include-all-providers'].some(key => group[key] === true) &&
          ['filter', 'exclude-filter', 'exclude-type'].some(key => group[key] !== undefined)) fail('SNAPSHOT_UNSUPPORTED');
      const accepts = nodeFilter(group);
      const members: string[] = [];
      const seen = new Set<string>();
      const appendMember = (name: string): void => {
        if (seen.has(name)) return;
        charge(name);
        seen.add(name);
        members.push(name);
      };
      for (const name of existing) appendMember(name);
      const select = (source: JsonObject[]): void => {
        for (const node of source) if (accepts(node)) appendMember(node.name as string);
      };
      if (group['include-all'] === true || group['include-all-proxies'] === true) select(inline as JsonObject[]);
      const selectedProviders = new Set<string>();
      if (group['include-all'] === true || group['include-all-providers'] === true) {
        for (const [name, provider] of providerNodes) { select(provider); selectedProviders.add(name); }
      }
      for (const name of uses) {
        if (selectedProviders.has(name)) continue;
        const provider = providerNodes.get(name);
        if (!provider) fail('SNAPSHOT_UNSUPPORTED');
        select(provider);
        selectedProviders.add(name);
      }
      group.proxies = members;
      for (const key of ['use', 'include-all', 'include-all-proxies', 'include-all-providers', 'filter', 'exclude-filter', 'exclude-type']) delete group[key];
    }
  }
  const rulePayloads = new Map<string, { behavior: string; payload: string[] }>();
  for (const [name, entry] of Object.entries(ruleDefinitions)) {
    const definition = object(entry);
    checkDefinition(definition, ['type', 'url', 'path', 'interval', 'payload', 'behavior', 'format']);
    if (!['domain', 'ipcidr', 'classical'].includes(String(definition.behavior))) fail('SNAPSHOT_UNSUPPORTED');
    if (definition.format !== undefined && definition.format !== 'yaml' && definition.format !== 'text') fail('SNAPSHOT_UNSUPPORTED');
    let payload: string[];
    if (definition.type === 'inline') payload = strings(definition.payload);
    else {
      const content = await download(definition);
      if (definition.format === 'text') payload = content.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#'));
      else {
        const document = object(decodeDocument(content));
        if (Object.keys(document).some(key => key !== 'payload')) fail('SNAPSHOT_UNSUPPORTED');
        payload = strings(document.payload);
      }
    }
    if (payload.length > 50_000) fail('SNAPSHOT_LIMIT');
    rulePayloads.set(name, { behavior: definition.behavior as string, payload });
  }
  const chargeRule = (rule: string): string => {
    charge(rule);
    return rule;
  };
  const expand = (rules: JsonValue | undefined): string[] => strings(rules).flatMap(rule => {
    if (!/^RULE-SET\s*,/i.test(rule)) {
      if (/(?:^|[,\s(])(RULE-SET|GEOIP|SRC-GEOIP|GEOSITE|IP-ASN|SRC-IP-ASN|SCRIPT)\s*,/i.test(rule)) fail('SNAPSHOT_UNSUPPORTED');
      return [chargeRule(rule)];
    }
    const parts = rule.split(',').map(part => part.trim());
    if (parts.length < 3 || parts.length > 4 || !parts[1] || !parts[2] || (parts.length === 4 && parts[3] !== 'no-resolve')) fail('SNAPSHOT_UNSUPPORTED');
    const provider = rulePayloads.get(parts[1]);
    if (!provider) fail('SNAPSHOT_UNSUPPORTED');
    return provider.payload.map(entry => chargeRule(providerRule(provider.behavior, entry, parts[2], parts[3] === 'no-resolve')));
  });
  if (root.rules !== undefined) root.rules = expand(root.rules);
  if (root['sub-rules'] !== undefined) {
    const subRules = object(root['sub-rules']);
    for (const key of Object.keys(subRules)) subRules[key] = expand(subRules[key]);
  }
  delete root['proxy-providers']; delete root['rule-providers'];
  // Recheck aggregate expanded JSON values and bytes after Cartesian expansion.
  const result = plainJson(root);
  return { value: profileDocument(result, providerPolicy), materializedProviders: true };
}

function providerRule(behavior: string, raw: string, target: string, noResolve: boolean): string {
  const entry = raw.trim();
  if (!entry || /[\r\n\u0000]/.test(entry)) fail('SNAPSHOT_INVALID');
  if (behavior === 'domain') {
    if (!/^(?:\+\.|\*\.)?[A-Za-z0-9_\u0080-\uffff-]+(?:\.[A-Za-z0-9_\u0080-\uffff-]+)*$/.test(entry)) fail('SNAPSHOT_UNSUPPORTED');
    if (entry.startsWith('*.')) fail('SNAPSHOT_UNSUPPORTED');
    return `${entry.startsWith('+.') ? 'DOMAIN-SUFFIX' : 'DOMAIN'},${entry.replace(/^\+\./, '')},${target}`;
  }
  if (behavior === 'ipcidr') {
    const [address, prefix, extra] = entry.split('/');
    const family = isIP(address);
    if (!family || extra !== undefined || prefix === undefined || !/^\d+$/.test(prefix) || Number(prefix) > (family === 4 ? 32 : 128)) fail('SNAPSHOT_INVALID');
    return `${family === 4 ? 'IP-CIDR' : 'IP-CIDR6'},${entry},${target}${noResolve ? ',no-resolve' : ''}`;
  }
  // Classical providers contain matcher expressions without an outbound target.
  // Reject composite/nested/provider/geo expressions rather than guess syntax.
  const parts = entry.split(',').map(part => part.trim());
  const type = parts[0].toUpperCase();
  const supported = new Set(['DOMAIN', 'DOMAIN-SUFFIX', 'DOMAIN-KEYWORD', 'DOMAIN-REGEX', 'IP-CIDR', 'IP-CIDR6',
    'SRC-IP-CIDR', 'SRC-IP-CIDR6', 'IP-SUFFIX', 'SRC-IP-SUFFIX', 'SRC-PORT', 'DST-PORT', 'IN-PORT',
    'PROCESS-NAME', 'PROCESS-PATH', 'PROCESS-NAME-REGEX', 'PROCESS-PATH-REGEX', 'NETWORK', 'DSCP', 'UID', 'IN-TYPE', 'IN-USER', 'IN-NAME']);
  if (!supported.has(type) || parts.length < 2 || parts.length > 3 || !parts[1] ||
      (parts.length === 3 && parts[2] !== 'no-resolve')) fail('SNAPSHOT_UNSUPPORTED');
  const resolves = ['IP-CIDR', 'IP-CIDR6', 'IP-SUFFIX'].includes(type);
  if (parts.length === 3 && !resolves) fail('SNAPSHOT_UNSUPPORTED');
  return `${parts[0]},${parts[1]},${target}${resolves && (noResolve || parts[2] === 'no-resolve') ? ',no-resolve' : ''}`;
}
