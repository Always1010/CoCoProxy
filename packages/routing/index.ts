import { isIP } from 'node:net';
import { ConfigError } from '../config/index.ts';
import type { JsonObject } from '../config/index.ts';
import { serviceCatalog } from './service-catalog.ts';
import { domesticDomainRules, domesticIpRules } from './domestic-data.ts';

export { serviceCatalog } from './service-catalog.ts';
export type LocalPolicyOptions = {
  proxies: JsonObject[];
  selections: Record<string, string>;
  rules: string[];
  mode: 'rule' | 'global' | 'direct';
};

const ids = new Set<string>(serviceCatalog.map((service) => service.id));
const reserved = new Set(['DIRECT', 'REJECT', 'REJECT-DROP', 'PASS', 'COMPATIBLE', 'GLOBAL']);
const aliases = new Set(['direct', 'block', 'reject']);
const priority = ['OpenAI', 'Claude', 'YouTube', 'TikTok', 'Google', 'X', 'Telegram', 'Microsoft', 'Apple', 'Meta', 'Discord', 'Steam', 'Proxy', 'Domestic'];
const userRuleTypes = new Set(['DOMAIN', 'DOMAIN-SUFFIX', 'DOMAIN-KEYWORD', 'DOMAIN-REGEX', 'IP-CIDR', 'IP-CIDR6', 'SRC-IP-CIDR', 'SRC-IP-CIDR6', 'DST-PORT', 'SRC-PORT', 'NETWORK']);

function invalid(): never {
  // Do not include a rule, node, target or subscription data in error messages.
  throw new ConfigError('INVALID_INPUT', '本地分流的节点、规则或策略组选择无效。');
}

function validName(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 256 && !/[,\r\n\u0000-\u001f\u007f]/.test(value);
}

function normalizedTarget(value: string): string {
  return value === 'direct' ? 'DIRECT' : value === 'block' || value === 'reject' ? 'REJECT' : value;
}

/**
 * Local plans intentionally support one reference level: a service may follow
 * Proxy. Proxy itself must choose a concrete node, DIRECT or REJECT. This keeps
 * every group option acyclic, including options not currently selected.
 */
export function localGroupChoices(proxies: JsonObject[], groupId: string): string[] {
  if (!validName(groupId) || reserved.has(groupId) || aliases.has(groupId) || !Array.isArray(proxies) || proxies.length > 5000) invalid();
  const nodes = proxies.map((proxy) => {
    if (!proxy || typeof proxy !== 'object' || Array.isArray(proxy) || !validName(proxy.name) || ids.has(proxy.name) || reserved.has(proxy.name) || aliases.has(proxy.name)) invalid();
    return proxy.name;
  });
  if (new Set(nodes).size !== nodes.length) invalid();
  return [...(groupId === 'Proxy' ? [] : ['Proxy']), ...nodes, 'DIRECT', 'REJECT'];
}

/** Validate simple user rules while retaining their exact order and match type. */
function userRules(rules: string[], targets: Set<string>): string[] {
  if (!Array.isArray(rules) || rules.length > 2000) invalid();
  return rules.map((rule) => {
    if (typeof rule !== 'string' || rule.length > 8192 || /[\r\n\u0000]/.test(rule)) invalid();
    const parts = rule.split(',');
    if (parts.length < 3 || parts.length > 4 || !userRuleTypes.has(parts[0]) || !parts[1]) invalid();
    const [kind, value, target, option] = parts;
    const destination = normalizedTarget(target);
    if (!targets.has(destination)) invalid();
    const ipRule = ['IP-CIDR', 'IP-CIDR6', 'SRC-IP-CIDR', 'SRC-IP-CIDR6'].includes(kind);
    if (option !== undefined && (!ipRule || option !== 'no-resolve')) invalid();
    if (ipRule) {
      const [address, prefix, extra] = value.split('/');
      const family = isIP(address);
      if (!family || family !== (kind.endsWith('6') ? 6 : 4) || extra !== undefined || !/^\d+$/.test(prefix) || +prefix > (family === 4 ? 32 : 128)) invalid();
    } else if (kind === 'DOMAIN' || kind === 'DOMAIN-SUFFIX') {
      if (!/^[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(value) || value.includes('..')) invalid();
    } else if (kind === 'DOMAIN-REGEX') {
      try { new RegExp(value); } catch { invalid(); }
    } else if (kind.endsWith('-PORT')) {
      if (!/^\d+(?:-\d+)?$/.test(value)) invalid();
      const range = value.split('-').map(Number);
      if (range.some((port) => port < 1 || port > 65535) || (range.length === 2 && range[0] > range[1])) invalid();
    } else if (kind === 'NETWORK' && value !== 'tcp' && value !== 'udp') invalid();
    parts[2] = destination;
    return parts.join(',');
  });
}

/**
 * Pure, offline Mihomo policy projection. All logical modes compile as rule
 * mode; global/direct use one MATCH so deployment remains compiler-owned.
 * DNS settings are deliberately left to the deployment compiler.
 */
export function buildLocalPolicy(options: LocalPolicyOptions): JsonObject {
  const { proxies, selections, rules, mode } = options;
  if (!Array.isArray(proxies) || proxies.length > 5000 || !selections || typeof selections !== 'object' || Array.isArray(selections) || !['rule', 'global', 'direct'].includes(mode)) invalid();
  if (Object.keys(selections).length > 100 || Object.entries(selections).some(([id, target]) => !validName(id) || reserved.has(id) || aliases.has(id) || ['__proto__', 'constructor', 'prototype'].includes(id) || typeof target !== 'string' || !target)) invalid();
  // Validate nodes once before constructing references, including the empty case.
  localGroupChoices(proxies, 'Proxy');
  const enabled = serviceCatalog.filter((service) => service.default || Object.hasOwn(selections, service.id)).map(service => ({ ...service }));
  for (const id of Object.keys(selections)) if (!ids.has(id)) {
    if (proxies.some(proxy => proxy.name === id)) invalid();
    enabled.push({ id, name: id, default: false, description: '', domains: [], exactDomains: [] } as unknown as typeof enabled[number]);
  }
  const targets = new Set(['DIRECT', 'REJECT', ...enabled.map((service) => service.id), ...proxies.map((proxy) => proxy.name as string)]);
  const groups: JsonObject[] = enabled.map((service) => {
    const choices = localGroupChoices(proxies, service.id);
    const fallback = service.id === 'Proxy' ? (proxies[0]?.name ?? 'REJECT') : service.id === 'Domestic' ? 'DIRECT' : 'Proxy';
    const selected = normalizedTarget(selections[service.id] ?? String(fallback));
    if (!choices.includes(selected)) invalid();
    return { name: service.id, type: 'select', proxies: [selected, ...choices.filter((choice) => choice !== selected)] };
  });
  // Validate even inactive manual rules; switching modes must not hide invalid data.
  const manual = userRules(rules, targets);
  let outputRules: string[];
  if (mode === 'direct') outputRules = ['MATCH,DIRECT'];
  else if (mode === 'global') outputRules = ['MATCH,Proxy'];
  else {
    outputRules = [...manual];
    for (const id of priority) {
      const service = enabled.find((entry) => entry.id === id);
      if (!service) continue;
      outputRules.push(...service.exactDomains.map((domain) => `DOMAIN,${domain},${id}`));
      outputRules.push(...service.domains.map((domain) => `DOMAIN-SUFFIX,${domain},${id}`));
    }
    outputRules.push(...domesticDomainRules.map((rule) => `${rule},Domestic`));
    // Resolve domain destinations at IP fallback. Earlier user IP rules use the
    // same native Mihomo resolution semantics; never force no-resolve here.
    outputRules.push(...domesticIpRules.map((rule) => `${rule},Domestic`));
    outputRules.push('MATCH,Other');
  }
  return { mode: 'rule', proxies: structuredClone(proxies), 'proxy-groups': groups, rules: outputRules };
}
