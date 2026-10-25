import { createHash } from 'node:crypto';
import { isIP } from 'node:net';

export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
export type JsonObject = { [key: string]: JsonValue };
export type Candidate = { id: string; config: JsonObject; sha256: string };

export type ConfigErrorCode =
  | 'INVALID_INPUT'
  | 'LIMIT_EXCEEDED'
  | 'PROTECTED_FIELD'
  | 'NAME_CONFLICT';

/** Messages intentionally contain neither input values nor property paths. */
export class ConfigError extends Error {
  readonly code: ConfigErrorCode;

  constructor(code: ConfigErrorCode, message: string) {
    super(message);
    this.name = 'ConfigError';
    this.code = code;
  }
}

// Bound work before invoking the core; these limits are not a Mihomo schema.
const MAX_DEPTH = 48;
const MAX_VALUES = 100_000;
const MAX_JSON_BYTES = 4 * 1024 * 1024;
const MAX_PROXIES = 5_000;
const MAX_SOURCES = 100;
const MAX_GROUPS = 1_000;
const MAX_NAME_LENGTH = 256;
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const DEPLOYMENT_FIELDS = new Set([
  'mixedPort', 'controllerPort', 'controllerSecret', 'dnsPort', 'bootstrapResolvers', 'nameservers', 'sniffing',
  'nameserverPolicy', 'nodeResolvers', 'directResolvers',
  'performance',
]);

// These fields belong to deployment, even when the supplied value is disabled.
const PROTECTED_ROOT_KEYS = new Set([
  'port', 'socks-port', 'redir-port', 'tproxy-port', 'mixed-port',
  'allow-lan', 'bind-address', 'lan-allowed-ips', 'lan-disallowed-ips',
  'authentication', 'skip-auth-prefixes', 'listeners', 'tunnels', 'tun',
  'external-controller', 'external-controller-tls', 'external-controller-unix',
  'external-controller-pipe', 'external-controller-cors', 'secret',
  'external-controller-routing-mark', 'external-doh-server',
  'external-ui', 'external-ui-url', 'external-ui-name', 'tls',
  'iptables', 'tuic-server', 'ss-config', 'vmess-config', 'ntp', 'clash-for-android',
  'dns', 'hosts', 'sniffer', 'ipv6',
  'x-coproxy-network',
  'x-coproxy-gateway',
  'geodata-mode', 'geodata-loader', 'geosite-matcher', 'geo-auto-update',
  'geo-update-interval', 'geox-url',
]);

// Block provider/download/script/file and egress overrides at every depth.
// Node `port` and websocket `path`, for example, are legitimate nested fields.
const PROTECTED_RECURSIVE_KEYS = new Set([
  'proxy-providers', 'rule-providers', 'providers', 'script', 'scripts',
  'interface-name', 'routing-mark', 'dialer-proxy', 'dialer',
  'iproute2-table-index', 'iproute2-rule-index', 'auto-route',
  'auto-redirect', 'auto-detect-interface', 'device', 'netns',
  'certificate', 'private-key', 'client-certificate', 'client-key',
  'ca', 'ca-str', 'ca-file', 'ca-cert', 'ca-cert-file', 'cert-file', 'key-file',
  'ssh-private-key', 'private-key-path', 'public-key-path',
  'plugin', 'plugin-opts', 'exec', 'command', 'executable',
  'external-ui', 'external-ui-url', 'external-ui-name',
  'geox-url', 'geo-auto-update', 'geodata-mode', 'geodata-loader',
  'listeners', 'tunnels', 'tun', 'authentication', 'skip-auth-prefixes',
  'external-controller', 'external-controller-tls', 'external-controller-unix',
  'external-controller-pipe', 'external-controller-cors',
  'file-descriptor', 'dialer-ip4p-convert',
  'x-coproxy-network',
  'x-coproxy-gateway',
]);

const RESERVED_NAMES = new Set([
  'DIRECT', 'REJECT', 'REJECT-DROP', 'PASS', 'COMPATIBLE', 'GLOBAL',
]);

function invalid(): never {
  throw new ConfigError('INVALID_INPUT', '配置结构或字段值无效。');
}

function protectedField(): never {
  throw new ConfigError('PROTECTED_FIELD', '配置包含不受支持的部署、远程来源、脚本或文件读取字段。');
}

function limit(): never {
  throw new ConfigError('LIMIT_EXCEEDED', '配置超过编译器的大小、深度或数量限制。');
}

/** Copy only plain JSON data; do not invoke accessors, toJSON or prototypes. */
function cloneJson(input: unknown): JsonValue {
  let values = 0;
  let bytes = 0;
  const ancestors = new Set<object>();
  const charge = (value: string) => {
    bytes += Buffer.byteLength(value, 'utf8');
    if (bytes > MAX_JSON_BYTES) limit();
  };
  const copy = (value: unknown, depth: number): JsonValue => {
    if (++values > MAX_VALUES || depth > MAX_DEPTH) limit();
    if (value === null || typeof value === 'boolean') {
      bytes += 5;
      return value;
    }
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) invalid();
      bytes += 24;
      return value;
    }
    if (typeof value === 'string') {
      charge(value);
      return value;
    }
    if (typeof value !== 'object') invalid();
    if (ancestors.has(value)) invalid();
    const array = Array.isArray(value);
    if (!array && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) invalid();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(descriptors).some((key) => typeof key !== 'string')) invalid();
    ancestors.add(value);
    let result: JsonValue;
    if (array) {
      if (value.length > MAX_VALUES) limit();
      if (Object.keys(descriptors).some((key) => key !== 'length' && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length))) invalid();
      const items: JsonValue[] = [];
      for (let index = 0; index < value.length; index++) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) invalid();
        items.push(copy(descriptor.value, depth + 1));
      }
      result = items;
    } else {
      const object: JsonObject = {};
      for (const [key, descriptor] of Object.entries(descriptors)) {
        if (UNSAFE_KEYS.has(key)) invalid();
        if (!descriptor.enumerable || !('value' in descriptor)) invalid();
        charge(key);
        object[key] = copy(descriptor.value, depth + 1);
      }
      result = object;
    }
    ancestors.delete(value);
    if (bytes > MAX_JSON_BYTES) limit();
    return result;
  };
  return copy(input, 0);
}

function object(value: JsonValue | undefined): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid();
  return value;
}

function exactKeys(value: JsonObject, allowed: Set<string>): void {
  if (Object.keys(value).some((key) => !allowed.has(key))) invalid();
}

function port(value: JsonValue | undefined): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 65_535) invalid();
  return value;
}

function name(value: JsonValue | undefined): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > MAX_NAME_LENGTH || /[\u0000-\u001f\u007f]/.test(value)) invalid();
  return value;
}

/** Match core field aliases without rewriting protocol options in the output. */
function protectedKey(key: string): string {
  // The core normalizes underscores before its case-insensitive node decoding.
  // Go EqualFold also equates ASCII S/K with long s/Kelvin sign. Lowercasing
  // handles Kelvin sign; long s needs an explicit fold. All protected keys are ASCII.
  return key.replaceAll('_', '-').toLowerCase().replaceAll('\u017f', 's');
}

function checkProtected(value: JsonValue): void {
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const child of value) checkProtected(child);
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    const checkedKey = protectedKey(key);
    if (PROTECTED_RECURSIVE_KEYS.has(checkedKey) || /(?:^|-)(file|filename|filepath)$/.test(checkedKey)) protectedField();
    checkProtected(child);
  }
}

function array(value: JsonValue | undefined): JsonValue[] {
  if (!Array.isArray(value)) invalid();
  return value;
}

function registerName(value: JsonValue | undefined, used: Set<string>): void {
  const entry = name(value);
  if (used.has(entry)) throw new ConfigError('NAME_CONFLICT', '节点、策略组或来源名称重复或与保留名称冲突。');
  used.add(entry);
}

function checkRules(value: JsonValue): void {
  // Compound rules can contain these operators below their outermost level.
  if (typeof value === 'string' && /(?:^|[,\s(])(RULE-SET|GEOIP|SRC-GEOIP|GEOSITE|IP-ASN|SRC-IP-ASN|SCRIPT)\s*,/i.test(value)) protectedField();
  if (Array.isArray(value)) {
    for (const child of value) checkRules(child);
  } else if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) checkRules(child);
  }
}

/** Deliberately excludes core rule-set/geosite/regex/URL matching syntax. */
function domainPattern(value: string): void {
  const domain = value.startsWith('+.') ? value.slice(2) : value;
  if (domain.length > 253 || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i.test(domain) ||
    isIP(domain) !== 0) invalid();
}

function dnsResolvers(value: JsonValue, allowIP: boolean): JsonValue[] {
  const servers = array(value);
  if (servers.length === 0 || servers.length > 16) invalid();
  for (const server of servers) {
    if (typeof server !== 'string' || server.length > 2048 || /[\s\\]/.test(server)) invalid();
    if (allowIP && isIP(server)) continue;
    let endpoint: URL;
    try { endpoint = new URL(server); } catch { invalid(); }
    // No credentials, proxy/interface fragments, queries or arbitrary core syntax.
    if (endpoint.protocol !== 'https:' || !endpoint.hostname || endpoint.username || endpoint.password ||
      server.includes('#') || server.includes('?') || endpoint.pathname === '/') invalid();
  }
  return servers;
}

function dnsPolicy(value: JsonValue): JsonObject {
  const policies = object(value), entries = Object.entries(policies);
  if (entries.length === 0 || entries.length > 256) invalid();
  for (const [domain, servers] of entries) {
    domainPattern(domain);
    dnsResolvers(servers, true);
  }
  return policies;
}

const SNIFF_PORTS: Record<string, (number | string)[]> = { HTTP: [80, '8080-8880'], TLS: [443, 8443], QUIC: [443, 8443] };
function portRange(value: JsonValue): [number, number] {
  if (typeof value === 'number') return [port(value), port(value)];
  if (typeof value !== 'string' || !/^[1-9]\d{0,4}-[1-9]\d{0,4}$/.test(value)) invalid();
  const [start, end] = value.split('-').map(Number);
  if (port(start) > port(end)) invalid();
  return [start, end];
}
function subtractPorts(ports: (number | string)[], skipped: JsonValue[]): (number | string)[] {
  let ranges = ports.map(portRange);
  for (const entry of skipped) {
    const [start, end] = portRange(entry);
    ranges = ranges.flatMap(([first, last]) => end < first || start > last ? [[first, last] as [number, number]] :
      [...(first < start ? [[first, start - 1] as [number, number]] : []), ...(last > end ? [[end + 1, last] as [number, number]] : [])]);
  }
  return ranges.map(([start, end]) => start === end ? start : `${start}-${end}`);
}

function snifferOptions(value: JsonValue | undefined): JsonObject | undefined {
  if (value === undefined || value === false || value === 'off') return undefined;
  const options = typeof value === 'object' && value !== null ? object(value) : { mode: value === true ? 'force' : value };
  exactKeys(options, new Set(['mode', 'skipDomains', 'skipPorts']));
  if (options.mode !== 'missing-only' && options.mode !== 'force' && options.mode !== 'off') invalid();
  if (options.mode === 'off') {
    if (Object.keys(options).length !== 1) invalid();
    return undefined;
  }
  const domains = options.skipDomains === undefined ? undefined : array(options.skipDomains);
  if (domains) {
    if (domains.length > 256) invalid();
    for (const domain of domains) { if (typeof domain !== 'string') invalid(); domainPattern(domain); }
  }
  const skipped = options.skipPorts === undefined ? [] : array(options.skipPorts);
  if (skipped.length > 64) invalid();
  for (const entry of skipped) portRange(entry);
  const sniff: JsonObject = {};
  for (const [protocol, ports] of Object.entries(SNIFF_PORTS)) {
    const included = subtractPorts(ports, skipped);
    if (included.length) sniff[protocol] = { ports: included };
  }
  // An empty sniff map makes the core restore its defaults; reject that case.
  if (Object.keys(sniff).length === 0) invalid();
  return { enable: true, 'force-dns-mapping': options.mode === 'force',
    'parse-pure-ip': true, 'override-destination': true, sniff,
    'skip-dst-address': ['0.0.0.0/8', '10.0.0.0/8', '127.0.0.0/8', '169.254.0.0/16',
      '172.16.0.0/12', '192.168.0.0/16', '224.0.0.0/4', '240.0.0.0/4'],
    ...(domains?.length ? { 'skip-domain': domains } : {}) };
}

function performanceOptions(value: JsonValue | undefined): JsonObject {
  if (value === undefined) return {};
  const options = object(value);
  exactKeys(options, new Set(['tcpConcurrent', 'findProcessMode']));
  if (options.tcpConcurrent !== undefined && typeof options.tcpConcurrent !== 'boolean') invalid();
  if (options.findProcessMode !== undefined && !['off', 'strict', 'always'].includes(String(options.findProcessMode))) invalid();
  return { ...(options.tcpConcurrent === undefined ? {} : { 'tcp-concurrent': options.tcpConcurrent }),
    ...(options.findProcessMode === undefined ? {} : { 'find-process-mode': options.findProcessMode }) };
}

function hasProcessRules(value: JsonValue | undefined): boolean {
  if (typeof value === 'string') return /(?:^|[,\s(])PROCESS-(?:NAME|PATH)(?:-REGEX)?\s*,/i.test(value);
  if (Array.isArray(value)) return value.some(hasProcessRules);
  return value !== null && typeof value === 'object' && Object.values(value).some(hasProcessRules);
}

/** Canonical JSON is the exact representation whose UTF-8 bytes are hashed. */
export function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

/**
 * Compile an offline snapshot into a loopback-only explicit-proxy candidate.
 * Performs safety-boundary checks, not complete Mihomo schema validation.
 * The caller must run `mihomo -t` before applying the candidate.
 */
export function compileConfig(input: unknown): Candidate {
  const envelope = object(cloneJson(input));
  exactKeys(envelope, new Set(['schemaVersion', 'deployment', 'policy', 'sources']));
  if (envelope.schemaVersion !== 1) invalid();
  const deployment = object(envelope.deployment);
  exactKeys(deployment, DEPLOYMENT_FIELDS);
  const mixedPort = port(deployment.mixedPort);
  const controllerPort = port(deployment.controllerPort);
  const dnsPort = port(deployment.dnsPort);
  if (new Set([mixedPort, controllerPort, dnsPort]).size !== 3) invalid();
  const secret = deployment.controllerSecret;
  if (typeof secret !== 'string' || secret.trim().length === 0) invalid();
  const resolvers = array(deployment.bootstrapResolvers);
  if (resolvers.length === 0 || resolvers.length > 16) invalid();
  for (const resolver of resolvers) {
    if (typeof resolver !== 'string' || isIP(resolver) === 0) invalid();
  }
  const nameservers = deployment.nameservers === undefined ? undefined : dnsResolvers(deployment.nameservers, false);
  const nameserverPolicy = deployment.nameserverPolicy === undefined ? undefined : dnsPolicy(deployment.nameserverPolicy);
  const nodeResolvers = deployment.nodeResolvers === undefined ? undefined : dnsResolvers(deployment.nodeResolvers, true);
  const directResolvers = deployment.directResolvers === undefined ? undefined : dnsResolvers(deployment.directResolvers, true);
  const sniffer = snifferOptions(deployment.sniffing), performance = performanceOptions(deployment.performance);

  const policy = object(envelope.policy);
  for (const key of Object.keys(policy)) {
    if (PROTECTED_ROOT_KEYS.has(protectedKey(key))) protectedField();
  }
  checkProtected(policy);
  if (policy.profile !== undefined) {
    if (policy.profile === null || typeof policy.profile !== 'object' || Array.isArray(policy.profile)) protectedField();
    const profile = object(policy.profile);
    // Managed choices live in the versioned workspace. A core cache must not
    // override the selected first member after apply, rollback or plan switch.
    if (Object.keys(profile).length !== 1 || profile['store-selected'] !== false) protectedField();
  }
  if (policy.mode !== undefined && policy.mode !== 'rule') protectedField();
  if (policy.rules !== undefined) {
    for (const rule of array(policy.rules)) if (typeof rule !== 'string') invalid();
    checkRules(policy.rules);
  }
  if (policy['sub-rules'] !== undefined) checkRules(policy['sub-rules']);
  if (performance['find-process-mode'] === 'off' && policy['find-process-mode'] !== 'off' &&
    (hasProcessRules(policy.rules) || hasProcessRules(policy['sub-rules']))) invalid();

  const usedNames = new Set(RESERVED_NAMES);
  const proxies: JsonObject[] = [];
  const addProxies = (entries: JsonValue[]) => {
    if (proxies.length + entries.length > MAX_PROXIES) limit();
    for (const entry of entries) {
      const proxy = object(entry);
      registerName(proxy.name, usedNames);
      if (typeof proxy.type !== 'string' || proxy.type.trim().length === 0) invalid();
      checkProtected(proxy);
      proxies.push(proxy);
    }
  };
  if (policy.proxies !== undefined) addProxies(array(policy.proxies));
  if (envelope.sources !== undefined) {
    const sources = array(envelope.sources);
    if (sources.length > MAX_SOURCES) limit();
    const sourceIds = new Set<string>();
    for (const entry of sources) {
      const source = object(entry);
      exactKeys(source, new Set(['id', 'proxies']));
      registerName(source.id, sourceIds);
      addProxies(array(source.proxies));
    }
  }
  if (policy['proxy-groups'] !== undefined) {
    const groups = array(policy['proxy-groups']);
    if (groups.length > MAX_GROUPS) limit();
    for (const entry of groups) {
      const group = object(entry);
      registerName(group.name, usedNames);
      if (group.use !== undefined) protectedField();
    }
  }

  const config: JsonObject = {
    ...policy,
    ...performance,
    mode: 'rule',
    proxies,
    'allow-lan': false,
    'bind-address': '127.0.0.1',
    'mixed-port': mixedPort,
    'external-controller': `127.0.0.1:${controllerPort}`,
    secret,
    tun: { enable: false },
    ipv6: false,
    ...(sniffer ? { sniffer } : {}),
    dns: {
      enable: true,
      listen: `127.0.0.1:${dnsPort}`,
      'enhanced-mode': 'redir-host',
      ipv6: false,
      'default-nameserver': [...resolvers],
      nameserver: [...(nameservers ?? resolvers)],
      ...(nameservers || nameserverPolicy ? { 'respect-rules': true,
        'proxy-server-nameserver': [...(nodeResolvers ?? resolvers)],
        'direct-nameserver': [...(directResolvers ?? resolvers)] } : {
        ...(nodeResolvers ? { 'proxy-server-nameserver': [...nodeResolvers] } : {}),
        ...(directResolvers ? { 'direct-nameserver': [...directResolvers] } : {}),
      }),
      ...(nameserverPolicy ? { 'nameserver-policy': nameserverPolicy } : {}),
    },
  };
  const sha256 = createHash('sha256').update(canonicalJson(config), 'utf8').digest('hex');
  return { id: sha256, config, sha256 };
}

/** Reconstruct optional compiler-owned DNS inputs without changing legacy hashes. */
export function deploymentDnsOptions(config: JsonObject): JsonObject {
  const dns = object(config.dns);
  const routed = dns['respect-rules'] === true && array(dns.nameserver).some(server => typeof server === 'string' && isIP(server) === 0);
  const performance: JsonObject = {
    ...(typeof config['tcp-concurrent'] === 'boolean' ? { tcpConcurrent: config['tcp-concurrent'] } : {}),
    ...(['off', 'strict', 'always'].includes(String(config['find-process-mode'])) ? { findProcessMode: config['find-process-mode'] } : {}),
  };
  return { ...(routed ? { nameservers: dns.nameserver } : {}),
    ...(dns['nameserver-policy'] === undefined ? {} : { nameserverPolicy: dns['nameserver-policy'] }),
    ...(dns['proxy-server-nameserver'] === undefined ? {} : { nodeResolvers: dns['proxy-server-nameserver'] }),
    ...(dns['direct-nameserver'] === undefined ? {} : { directResolvers: dns['direct-nameserver'] }),
    ...(Object.keys(performance).length ? { performance } : {}),
    ...(config.sniffer === undefined ? {} : { sniffing: extractSniffing(object(config.sniffer)) }) };
}

function extractSniffing(sniffer: JsonObject): JsonObject {
  const sniff = object(sniffer.sniff), skipped = new Set<number>();
  for (const [protocol, defaults] of Object.entries(SNIFF_PORTS)) {
    const options = sniff[protocol] === undefined ? undefined : object(sniff[protocol]);
    const included = options === undefined ? [] : array(options.ports).map(portRange);
    for (const entry of defaults) {
      const [start, end] = portRange(entry);
      for (let value = start; value <= end; value++) if (!included.some(([first, last]) => value >= first && value <= last)) skipped.add(value);
    }
  }
  const ranges: (number | string)[] = [], ordered = [...skipped].sort((a, b) => a - b);
  for (let index = 0; index < ordered.length; index++) {
    const start = ordered[index]; let end = start;
    while (ordered[index + 1] === end + 1) end = ordered[++index];
    ranges.push(start === end ? start : `${start}-${end}`);
  }
  return { mode: sniffer['force-dns-mapping'] === true ? 'force' : 'missing-only',
    ...(sniffer['skip-domain'] === undefined ? {} : { skipDomains: sniffer['skip-domain'] }),
    ...(ranges.length ? { skipPorts: ranges } : {}) };
}
