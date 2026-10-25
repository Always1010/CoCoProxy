import { canonicalJson, ConfigError, type JsonObject, type JsonValue } from './index.ts';
import { domesticDomainRules, domesticIpRules } from '../routing/domestic-data.ts';

const marker = 'x-coproxy-rule-mode';
const version = 'domestic-v1';
const domains = 'coproxy-domestic-domain-v1';
const networks = 'coproxy-domestic-ip-v1';
const domainRules = domesticDomainRules.map(rule => `${rule},Domestic`);
const ipRules = domesticIpRules.map(rule => `${rule},Domestic`);
const regexRules = domainRules.filter(rule => rule.startsWith('DOMAIN-REGEX,'));
const compactDomains = [`RULE-SET,${domains},Domestic`, ...regexRules];
const compactIPs = [`RULE-SET,${networks},Domestic`];
const providers: JsonObject = {
  [domains]: { type: 'inline', behavior: 'domain', payload: domesticDomainRules.flatMap(rule => {
    if (rule.startsWith('DOMAIN,')) return [rule.slice(7)];
    if (rule.startsWith('DOMAIN-SUFFIX,')) return ['+.' + rule.slice(14)];
    return [];
  }) },
  [networks]: { type: 'inline', behavior: 'ipcidr', payload: domesticIpRules.map(rule => rule.slice(8)) },
};

function invalid(): never { throw new ConfigError('PROTECTED_FIELD', '内部规则集合与固定资源不一致。'); }
function replaceOnce(rules: JsonValue[], original: readonly string[], replacement: readonly string[]): JsonValue[] {
  let offset = -1;
  for (let index = 0; index <= rules.length - original.length; index++) {
    if (rules[index] !== original[0]) continue;
    if (!original.every((rule, step) => rules[index + step] === rule)) continue;
    if (offset !== -1) invalid();
    offset = index;
  }
  if (offset === -1) invalid();
  return [...rules.slice(0, offset), ...replacement, ...rules.slice(offset + original.length)];
}

/** Only the exact pinned, same-target blocks can become compiler-owned sets.
 * Input provider/download/file fields still pass through the normal rejection.
 */
export function compactCompilerRuleSets(config: JsonObject): JsonObject {
  if (config[marker] === undefined) return config;
  if (config[marker] !== version || config['rule-providers'] !== undefined || !Array.isArray(config.rules)) invalid();
  // Logical global/direct modes intentionally have no domestic block.
  if (config.rules.length === 1 && ['MATCH,DIRECT', 'MATCH,Proxy'].includes(String(config.rules[0]))) {
    const result = { ...config }; delete result[marker]; return result;
  }
  const rules = replaceOnce(replaceOnce(config.rules, domainRules, compactDomains), ipRules, compactIPs);
  if (rules.some(rule => typeof rule === 'string' && rule.startsWith('RULE-SET,') &&
      rule !== compactDomains[0] && rule !== compactIPs[0])) invalid();
  return { ...config, rules, 'rule-providers': structuredClone(providers) };
}

/** Reconstruct policy only after checking every compiler-owned provider byte.
 * Runtime callers must still recompile and compare the complete generation.
 */
export function expandCompilerRuleSets(config: JsonObject): JsonObject {
  if (config[marker] === undefined) return { ...config };
  if (config[marker] !== version || !Array.isArray(config.rules) ||
      canonicalJson(config['rule-providers'] ?? null) !== canonicalJson(providers)) invalid();
  const rules = replaceOnce(replaceOnce(config.rules, compactDomains, domainRules), compactIPs, ipRules);
  const result: JsonObject = { ...config, rules };
  delete result['rule-providers'];
  return result;
}
