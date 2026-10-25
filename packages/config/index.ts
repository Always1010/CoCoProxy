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
  'mixedPort', 'controllerPort', 'controllerSecret', 'dnsPort', 'bootstrapResolvers', 'nameservers',
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

function checkProtected(value: JsonValue): void {
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const child of value) checkProtected(child);
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (PROTECTED_RECURSIVE_KEYS.has(key) || /(?:^|[-_])(file|filename|filepath)$/.test(key)) protectedField();
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
  const nameservers = deployment.nameservers === undefined ? undefined : array(deployment.nameservers);
  if (nameservers) {
    if (nameservers.length === 0 || nameservers.length > 16) invalid();
    for (const server of nameservers) {
      if (typeof server !== 'string' || server.length > 2048 || /[\s\\]/.test(server)) invalid();
      let endpoint: URL;
      try { endpoint = new URL(server); } catch { invalid(); }
      // Deployment owns DNS transport. Do not accept interface/proxy fragments,
      // credentials, cleartext endpoints or arbitrary core resolver syntax.
      if (endpoint.protocol !== 'https:' || !endpoint.hostname || endpoint.username || endpoint.password ||
        endpoint.hash || endpoint.search || endpoint.pathname === '/') invalid();
    }
  }

  const policy = object(envelope.policy);
  for (const key of Object.keys(policy)) {
    if (PROTECTED_ROOT_KEYS.has(key)) protectedField();
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
    mode: 'rule',
    proxies,
    'allow-lan': false,
    'bind-address': '127.0.0.1',
    'mixed-port': mixedPort,
    'external-controller': `127.0.0.1:${controllerPort}`,
    secret,
    tun: { enable: false },
    ipv6: false,
    dns: {
      enable: true,
      listen: `127.0.0.1:${dnsPort}`,
      'enhanced-mode': 'redir-host',
      ipv6: false,
      'default-nameserver': [...resolvers],
      nameserver: [...(nameservers ?? resolvers)],
      ...(nameservers ? { 'respect-rules': true, 'proxy-server-nameserver': [...resolvers],
        'direct-nameserver': [...resolvers] } : {}),
    },
  };
  const sha256 = createHash('sha256').update(canonicalJson(config), 'utf8').digest('hex');
  return { id: sha256, config, sha256 };
}

/** Reconstruct optional compiler-owned DNS inputs without changing legacy hashes. */
export function deploymentDnsOptions(config: JsonObject): JsonObject {
  const dns = object(config.dns);
  return dns['respect-rules'] === true ? { nameservers: dns.nameserver } : {};
}
