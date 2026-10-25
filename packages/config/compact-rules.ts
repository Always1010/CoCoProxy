import { canonicalJson, ConfigError, type JsonObject, type JsonValue } from './index.ts';
import { domesticDomainRules, domesticIpRules } from '../routing/domestic-data.ts';
import { legacyDomesticDomainRules } from '../routing/legacy-domestic-data.ts';

export const DOMESTIC_POLICY_VERSION = 'domestic-v2';
export const DOMESTIC_DOMAIN_PROVIDER = 'cocoproxy-domestic-domain-v2';
export const DOMESTIC_IP_PROVIDER = 'cocoproxy-domestic-ip-v1';
const marker = 'x-cocoproxy-rule-mode';
const legacyVersion = 'domestic-v1';
const legacyDomains = 'cocoproxy-domestic-domain-v1';
const legacyDomainRules = legacyDomesticDomainRules.map(rule => `${rule},Domestic`);
const ipRules = domesticIpRules.map(rule => `${rule},Domestic`);
const regexRules = domesticDomainRules.filter(rule => rule.startsWith('DOMAIN-REGEX,')).map(rule => `${rule},Domestic`);
const legacyCompactDomains = [`RULE-SET,${legacyDomains},Domestic`, ...regexRules];
const compactIPs = [`RULE-SET,${DOMESTIC_IP_PROVIDER},Domestic`];
export const domesticReferenceRules = [`RULE-SET,${DOMESTIC_DOMAIN_PROVIDER},Domestic`, ...regexRules, ...compactIPs];
const domainProvider = (rules: readonly string[]): JsonObject => ({ type: 'inline', behavior: 'domain', payload: rules.flatMap(rule => {
    if (rule.startsWith('DOMAIN,')) return [rule.slice(7)];
    if (rule.startsWith('DOMAIN-SUFFIX,')) return ['+.' + rule.slice(14)];
    return [];
  }) });
const ipProvider: JsonObject = { type: 'inline', behavior: 'ipcidr', payload: domesticIpRules.map(rule => rule.slice(8)) };
const providers: JsonObject = { [DOMESTIC_DOMAIN_PROVIDER]: domainProvider(domesticDomainRules), [DOMESTIC_IP_PROVIDER]: ipProvider };
const legacyProviders: JsonObject = { [legacyDomains]: domainProvider(legacyDomesticDomainRules), [DOMESTIC_IP_PROVIDER]: ipProvider };
const ownedDnsKey = `rule-set:${DOMESTIC_DOMAIN_PROVIDER}`;

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

/** Only two exact references become legal; external sets remain rejected. */
export function isCompilerRuleReference(rule: string, policy: JsonObject): boolean {
  return policy[marker] === DOMESTIC_POLICY_VERSION &&
    (rule === domesticReferenceRules[0] || rule === compactIPs[0]);
}

/** The large immutable data enters only after bounded external input validation. */
export function compactCompilerRuleSets(config: JsonObject): JsonObject {
  const version = config[marker];
  if (version === undefined) return config;
  if (![legacyVersion, DOMESTIC_POLICY_VERSION].includes(String(version)) || config['rule-providers'] !== undefined || !Array.isArray(config.rules)) invalid();
  // Logical global/direct modes intentionally have no domestic block.
  if (config.rules.length === 1 && ['MATCH,DIRECT', 'MATCH,Proxy'].includes(String(config.rules[0]))) {
    const result = { ...config }; delete result[marker]; return result;
  }
  if (version === legacyVersion) {
    const rules = replaceOnce(replaceOnce(config.rules, legacyDomainRules, legacyCompactDomains), ipRules, compactIPs);
    if (rules.some(rule => typeof rule === 'string' && rule.startsWith('RULE-SET,') && rule !== legacyCompactDomains[0] && rule !== compactIPs[0])) invalid();
    return { ...config, rules, 'rule-providers': structuredClone(legacyProviders) };
  }
  const rules = replaceOnce(config.rules, domesticReferenceRules, domesticReferenceRules);
  if (rules.some(rule => typeof rule === 'string' && rule.startsWith('RULE-SET,') &&
      rule !== domesticReferenceRules[0] && rule !== compactIPs[0])) invalid();
  if (rules.filter(rule => rule === domesticReferenceRules[0]).length !== 1 || rules.filter(rule => rule === compactIPs[0]).length !== 1) invalid();
  const dns = config.dns as JsonObject;
  const groups = config['proxy-groups'] as JsonObject[] | undefined;
  const domestic = groups?.find(group => group.name === 'Domestic');
  const direct = domestic && Array.isArray(domestic.proxies) && domestic.proxies[0] === 'DIRECT';
  const existing = dns['nameserver-policy'] as JsonObject | undefined;
  const localResolvers = dns['direct-nameserver'] ?? dns['default-nameserver'];
  // These queries resolve DIRECT destinations. Without an explicit DNS dialer,
  // respect-rules can send a private bootstrap address through Other/Proxy.
  const localDnsResolvers = (localResolvers as string[]).map(server => `${server}#DIRECT`);
  return { ...config, rules, 'rule-providers': structuredClone(providers),
    ...(direct ? { dns: { ...dns, 'respect-rules': true,
      'proxy-server-nameserver': dns['proxy-server-nameserver'] ?? dns['default-nameserver'],
      'direct-nameserver': localResolvers, 'nameserver-policy': {
      '+.cn': localDnsResolvers, ...existing, [ownedDnsKey]: localDnsResolvers,
    } } } : {}) };
}

/** Reconstruct policy only after checking every compiler-owned provider byte.
 * Runtime callers must still recompile and compare the complete generation.
 */
export function expandCompilerRuleSets(config: JsonObject): JsonObject {
  if (config[marker] === undefined) return { ...config };
  const version = config[marker];
  const expected = version === legacyVersion ? legacyProviders : version === DOMESTIC_POLICY_VERSION ? providers : null;
  if (!expected || !Array.isArray(config.rules) || canonicalJson(config['rule-providers'] ?? null) !== canonicalJson(expected)) invalid();
  const rules = version === legacyVersion
    ? replaceOnce(replaceOnce(config.rules, legacyCompactDomains, legacyDomainRules), compactIPs, ipRules)
    : replaceOnce(config.rules, domesticReferenceRules, domesticReferenceRules);
  const result: JsonObject = { ...config, rules };
  delete result['rule-providers'];
  return result;
}

/** Upgrade a newly requested workspace candidate, never old-generation verification. */
export function upgradeCompilerRulePolicy(policy: JsonObject): JsonObject {
  if (policy[marker] !== legacyVersion || !Array.isArray(policy.rules)) return policy;
  const rules = replaceOnce(replaceOnce(policy.rules, legacyDomainRules, [domesticReferenceRules[0], ...regexRules]), ipRules, compactIPs);
  return { ...policy, [marker]: DOMESTIC_POLICY_VERSION, rules };
}

/** Remove only compiler-owned DNS entries before reconstructing deployment input. */
export function externalNameserverPolicy(config: JsonObject): JsonObject | undefined {
  const dns = config.dns as JsonObject;
  const original = dns['nameserver-policy'] as JsonObject | undefined;
  if (!original) return undefined;
  const result = { ...original };
  if (config[marker] === DOMESTIC_POLICY_VERSION) {
    delete result[ownedDnsKey];
    const localResolvers = dns['direct-nameserver'] ?? dns['default-nameserver'];
    const generated = (localResolvers as string[]).map(server => `${server}#DIRECT`);
    if (canonicalJson(result['+.cn'] ?? null) === canonicalJson(generated)) delete result['+.cn'];
  }
  return Object.keys(result).length ? result : undefined;
}
