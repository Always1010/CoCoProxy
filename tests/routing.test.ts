import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildLocalPolicy, localGroupChoices, serviceCatalog } from '../packages/routing/index.ts';
import { domesticDomainRules, domesticIpRules } from '../packages/routing/domestic-data.ts';
import { legacyDomesticDomainRules } from '../packages/routing/legacy-domestic-data.ts';
import { overseasDomainRules } from '../packages/routing/overseas-data.ts';
import { compileConfig, ConfigError } from '../packages/config/index.ts';
import { DOMESTIC_DOMAIN_PROVIDER, DOMESTIC_IP_PROVIDER, OVERSEAS_DOMAIN_PROVIDER, overseasReferenceRule, domesticReferenceRules, localReferenceRules, expandCompilerRuleSets, upgradeCompilerRulePolicy } from '../packages/config/compact-rules.ts';
import { compileAutomaticGatewayConfig, recompileAutomaticGatewayConfig } from '../packages/gateway/profile.ts';
import type { JsonObject } from '../packages/config/index.ts';

const nodes: JsonObject[] = [{ name: 'example-node', type: 'socks5', server: '192.0.2.10', port: 1080 }];
const policy = (overrides: Partial<Parameters<typeof buildLocalPolicy>[0]> = {}) => buildLocalPolicy({ proxies: nodes, selections: {}, rules: [], mode: 'rule', ...overrides });
const groups = (value: JsonObject) => value['proxy-groups'] as JsonObject[];
const selected = (value: JsonObject, id: string) => (groups(value).find((group) => group.name === id)!.proxies as string[])[0];
const rules = (value: JsonObject) => value.rules as string[];

function domainTarget(value: JsonObject, domain: string): string {
  const matches = (type: string, match: string) =>
    (type === 'DOMAIN' && domain === match) || (type === 'DOMAIN-SUFFIX' && (domain === match || domain.endsWith(`.${match}`))) ||
    (type === 'DOMAIN-REGEX' && new RegExp(match).test(domain));
  for (const rule of rules(value)) {
    const [type, match, target] = rule.split(',');
    if (type === 'MATCH') return match;
    if (matches(type, match)) return target;
    const domainSet = match === DOMESTIC_DOMAIN_PROVIDER ? domesticDomainRules : match === OVERSEAS_DOMAIN_PROVIDER ? overseasDomainRules : [];
    if (type === 'RULE-SET' && domainSet.some(entry => {
      const [kind, pattern] = entry.split(','); return matches(kind, pattern);
    })) return target;
  }
  return '';
}

test('local catalog separates overseas traffic from the shared proxy and enables optional services explicitly', () => {
  const value = policy();
  assert.deepEqual(groups(value).map((group) => group.name), ['Proxy', 'Overseas', 'OpenAI', 'Claude', 'Google', 'YouTube', 'TikTok', 'X', 'Telegram', 'Domestic', 'Other']);
  assert.equal(selected(value, 'Proxy'), 'example-node');
  assert.equal(selected(value, 'Domestic'), 'DIRECT');
  assert.equal(selected(value, 'Other'), 'Proxy');
  assert.equal(selected(value, 'Overseas'), 'Proxy');
  assert.equal(selected(value, 'OpenAI'), 'Proxy');
  assert.equal(serviceCatalog.length, 16);
  const optional = policy({ selections: { Microsoft: 'REJECT', Domestic: 'Proxy', Other: 'DIRECT' } });
  assert.equal(selected(optional, 'Microsoft'), 'REJECT');
  assert.equal(selected(optional, 'Domestic'), 'Proxy');
  assert.equal(selected(optional, 'Other'), 'DIRECT');
  assert.equal(domainTarget(optional, 'www.microsoft.com'), 'Microsoft');
  assert.equal(domainTarget(value, 'www.microsoft.com'), 'Overseas');
});

test('user overrides precede exact service rules, aggregates and domestic fallback', () => {
  const value = policy({ rules: ['DOMAIN,youtubei.googleapis.com,REJECT', 'IP-CIDR,192.0.2.0/24,DIRECT'] });
  assert.equal(domainTarget(value, 'youtubei.googleapis.com'), 'REJECT');
  assert.equal(domainTarget(value, 'yt3.googleusercontent.com'), 'YouTube');
  assert.equal(domainTarget(value, 'child.yt3.googleusercontent.com'), 'Google');
  assert.equal(domainTarget(value, 'ggpht.cn'), 'YouTube');
  assert.equal(domainTarget(value, 'www.github.com'), 'Overseas');
  assert.equal(domainTarget(value, 'unlisted.example.cn'), 'Domestic');
  assert.equal(domainTarget(value, 'unlisted.invalid'), 'Other');
  const compiledRules = rules(value);
  assert.deepEqual(compiledRules.slice(0, 2), ['DOMAIN,youtubei.googleapis.com,REJECT', 'IP-CIDR,192.0.2.0/24,DIRECT']);
  assert.ok(compiledRules.indexOf('DOMAIN,yt3.googleusercontent.com,YouTube') < compiledRules.indexOf('DOMAIN-SUFFIX,googleusercontent.com,Google'));
  assert.ok(compiledRules.indexOf('DOMAIN-SUFFIX,github.com,Overseas') < compiledRules.indexOf('DOMAIN-SUFFIX,cn,Domestic'));
  assert.ok(compiledRules.indexOf(domesticReferenceRules[0]) < compiledRules.indexOf(overseasReferenceRule));
  assert.ok(compiledRules.indexOf(overseasReferenceRule) < compiledRules.indexOf(`RULE-SET,${DOMESTIC_IP_PROVIDER},Domestic`));
  assert.deepEqual(compiledRules.slice(compiledRules.indexOf(domesticReferenceRules[0]), -1), localReferenceRules);
  assert.ok(compiledRules.indexOf('DOMAIN-SUFFIX,cn,Domestic') < compiledRules.indexOf(`RULE-SET,${DOMESTIC_IP_PROVIDER},Domestic`));
  assert.equal(compiledRules.at(-1), 'MATCH,Other');
});

test('pinned domestic resources retain exact, suffix, regex and IPv4 semantics', () => {
  const value = policy();
  assert.equal(domesticDomainRules.length, 111813);
  for (const domain of ['qq.com', 'jd.com', 'taobao.com', 'bilibili.com', 'hdslb.com', 'www.baidu.com', 'v.qq.com', 'i1.hdslb.com', 'img.alicdn.com', 'img14.360buyimg.com']) {
    assert.equal(domainTarget(value, domain), 'Domestic', domain);
  }
  for (const domain of ['www.google.com', 'www.github.com', 'www.youtube.com', 'example.com', 'hdslb.com.invalid', 'nothdslb.com']) {
    assert.notEqual(domainTarget(value, domain), 'Domestic', domain);
  }
  assert.ok(domesticDomainRules.includes('DOMAIN,api.blipsandchitz.me'));
  assert.ok(!domesticDomainRules.includes('DOMAIN-SUFFIX,api.blipsandchitz.me'));
  assert.equal(domainTarget(value, 'api.blipsandchitz.me'), 'Domestic');
  assert.equal(domainTarget(value, 'child.api.blipsandchitz.me'), 'Other');
  assert.equal(domainTarget(value, 'synthetic-mihayo.akamaized.net'), 'Domestic');
  assert.equal(domainTarget(value, 'synthetic-mihayo.akamaized.net.invalid'), 'Other');
  assert.equal(domesticIpRules.length, 6525);
  assert.equal(rules(value).filter((rule) => rule.startsWith('DOMAIN-REGEX,')).length, 3);
  assert.ok(!rules(value).some((rule) => rule.includes('no-resolve') || rule.startsWith('IP-CIDR6,')));
  assert.equal(rules(value).filter(rule => rule.startsWith('RULE-SET,')).length, 3);
});

test('pinned overseas domains fill missing services while preserving domestic, business and manual priority', () => {
  const value = policy({ selections: { Overseas: 'REJECT', Other: 'DIRECT' } });
  assert.equal(overseasDomainRules.length, 27268);
  assert.equal(overseasDomainRules.filter(rule => rule.startsWith('DOMAIN,')).length, 762);
  assert.equal(selected(value, 'Overseas'), 'REJECT');
  for (const domain of ['figma.com', 'www.notion.so', 'docker.com', 'registry.npmjs.org', 'www.wikipedia.org', 'reddit.com']) {
    assert.equal(domainTarget(value, domain), 'Overseas', domain);
  }
  for (const domain of ['www.baidu.com', 'img.alicdn.com', 'www.bilibili.com', 'alibabacloud.com']) {
    assert.equal(domainTarget(value, domain), 'Domestic', domain);
  }
  assert.ok(overseasDomainRules.includes('DOMAIN-SUFFIX,alibabacloud.com'));
  assert.equal(domainTarget(value, 'www.google.com'), 'Google');
  assert.equal(domainTarget(value, 'youtubei.googleapis.com'), 'YouTube');
  assert.equal(domainTarget(value, 'figma.com.invalid'), 'Other');
  assert.equal(domainTarget(value, 'notfigma.com'), 'Other');
  assert.equal(domainTarget(value, '1password.drift.click'), 'Overseas');
  assert.equal(domainTarget(value, 'child.1password.drift.click'), 'Other');
  assert.equal(domainTarget(value, 'unlisted.invalid'), 'Other');
  assert.equal(domainTarget(policy({ rules: ['DOMAIN-SUFFIX,figma.com,DIRECT'] }), 'www.figma.com'), 'DIRECT');
  assert.equal(domainTarget(policy({ selections: { Microsoft: 'DIRECT' } }), 'www.microsoft.com'), 'Microsoft');
});

test('empty nodes fail closed and explicit selections persist without cycles', () => {
  for (const mode of ['rule', 'global', 'direct'] as const) {
    const value = policy({ proxies: [], mode });
    assert.equal(selected(value, 'Proxy'), 'REJECT');
    assert.equal(selected(value, 'Other'), 'Proxy');
  }
  assert.equal(selected(policy({ selections: { Proxy: 'DIRECT', OpenAI: 'block' } }), 'Proxy'), 'DIRECT');
  assert.equal(selected(policy({ selections: { OpenAI: 'block' } }), 'OpenAI'), 'REJECT');
  assert.deepEqual(localGroupChoices(nodes, 'OpenAI'), ['Proxy', 'example-node', 'DIRECT', 'REJECT']);
  const invalidSelections: Record<string, string>[] = [{ OpenAI: 'missing-node' }, { Proxy: 'OpenAI' }, { OpenAI: 'Claude', Claude: 'OpenAI' }, { Proxy: 'Proxy' }, { Proxy: 'Overseas' }, { Overseas: 'OpenAI' }];
  for (const selections of invalidSelections) {
    assert.throws(() => policy({ selections }), ConfigError);
  }
  assert.throws(() => policy({ proxies: [{ ...nodes[0], name: 'Proxy' }] }), ConfigError);
  assert.throws(() => policy({ proxies: [{ ...nodes[0], name: 'direct' }] }), ConfigError);
  assert.throws(() => policy({ selections: { Proxy: null } as unknown as Record<string, string> }), ConfigError);
});

test('custom local groups route manual rules and reject node-name collisions or chained references', () => {
  const value = policy({ selections: { 'Custom service': 'Proxy' }, rules: ['DOMAIN,custom.example,Custom service'] });
  assert.equal(selected(value, 'Custom service'), 'Proxy');
  assert.equal(domainTarget(value, 'custom.example'), 'Custom service');
  assert.deepEqual(localGroupChoices(nodes, 'Custom service'), ['Proxy', 'example-node', 'DIRECT', 'REJECT']);
  assert.throws(() => policy({ selections: { 'example-node': 'Proxy' } }), ConfigError);
  assert.throws(() => policy({ selections: { Custom: 'OpenAI' } }), ConfigError);
  assert.throws(() => policy({ selections: { First: 'Second', Second: 'First' } }), ConfigError);
});

test('logical global/direct modes exclude service, domestic and overseas matching', () => {
  assert.deepEqual(rules(policy({ mode: 'global' })), ['MATCH,Proxy']);
  assert.deepEqual(rules(policy({ mode: 'direct' })), ['MATCH,DIRECT']);
  assert.equal(policy({ mode: 'global' }).mode, 'rule');
});

test('manual match types preserve order and validate references before core checks', () => {
  const manual = ['DOMAIN-REGEX,^synthetic[0-9]+\\.example$,OpenAI', 'IP-CIDR6,2001:db8::/32,REJECT,no-resolve', 'DOMAIN-SUFFIX,example.org,direct'];
  assert.deepEqual(rules(policy({ rules: manual })).slice(0, 3), [...manual.slice(0, 2), 'DOMAIN-SUFFIX,example.org,DIRECT']);
  for (const rule of ['MATCH,DIRECT', 'RULE-SET,remote,Proxy', 'IP-CIDR,192.0.2.0/99,Proxy', 'DOMAIN,example.org,Unknown', 'DOMAIN-REGEX,[,Proxy', 'DOMAIN,example.org,Proxy,no-resolve']) {
    assert.throws(() => policy({ rules: [rule] }), ConfigError);
  }
});

test('offline template compacts only pinned blocks and round-trips without accepting external providers', () => {
  const value = policy();
  const deployment = { mixedPort: 17890, controllerPort: 19090, controllerSecret: 'EXAMPLE_ONLY', dnsPort: 15353, bootstrapResolvers: ['192.0.2.53'] };
  const result = compileConfig({ schemaVersion: 1, deployment, policy: value });
  assert.deepEqual(expandCompilerRuleSets(result.config).rules, value.rules);
  assert.ok((result.config.rules as string[]).length < 110);
  const sets = result.config['rule-providers'] as JsonObject;
  assert.deepEqual(Object.values(sets).map(set => (set as JsonObject).type), ['inline', 'inline', 'inline']);
  const restored = expandCompilerRuleSets(result.config);
  for (const key of ['mixed-port', 'allow-lan', 'bind-address', 'external-controller', 'secret', 'tun', 'ipv6', 'dns']) delete restored[key];
  assert.equal(compileConfig({ schemaVersion: 1, deployment, policy: restored }).id, result.id);
  const network = { schemaVersion: 1, ingressInterface: 'lan-test', gatewayIPv4: '192.0.2.2', routerIPv4: '192.0.2.1',
    routerMAC: '02:00:00:00:00:01', clientIPv4: '192.0.2.3', prefixLength: 24, dnsPort: 15353,
    egressMark: 65536, egressTable: 2024, egressPriority: 8000, tunMtu: 1500 };
  const gateway = compileAutomaticGatewayConfig({ schemaVersion: 1, deployment, policy: value }, network);
  assert.equal(recompileAutomaticGatewayConfig(gateway.config, network).id, gateway.id);
  assert.throws(() => compileConfig({ schemaVersion: 1, deployment, policy: { ...value, 'rule-providers': sets } }), ConfigError);
  const tampered = structuredClone(result.config);
  ((tampered['rule-providers'] as JsonObject)[DOMESTIC_DOMAIN_PROVIDER] as JsonObject).payload = ['+.attacker.invalid'];
  assert.throws(() => expandCompilerRuleSets(tampered), ConfigError);
  const changedOverseas = structuredClone(result.config);
  ((changedOverseas['rule-providers'] as JsonObject)[OVERSEAS_DOMAIN_PROVIDER] as JsonObject).payload = ['+.attacker.invalid'];
  assert.throws(() => expandCompilerRuleSets(changedOverseas), ConfigError);
  const changed = structuredClone(value);
  (changed.rules as string[]).splice((changed.rules as string[]).indexOf(domesticReferenceRules[0]), 1);
  assert.throws(() => compileConfig({ schemaVersion: 1, deployment, policy: changed }), ConfigError);
  for (const rules of [
    (value.rules as string[]).filter(rule => rule !== overseasReferenceRule),
    [...value.rules as string[], overseasReferenceRule],
    (value.rules as string[]).map(rule => rule === overseasReferenceRule ? `RULE-SET,${OVERSEAS_DOMAIN_PROVIDER},Other` : rule),
  ]) {
    assert.throws(() => compileConfig({ schemaVersion: 1, deployment, policy: { ...value, rules } }), ConfigError);
  }
  for (const marker of ['domestic-v2', ['routing-v3'], {}, 'unknown']) {
    assert.throws(() => compileConfig({ schemaVersion: 1, deployment, policy: { ...value, 'x-cocoproxy-rule-mode': marker } }), ConfigError);
  }
  assert.equal(value.dns, undefined);
  assert.ok(Buffer.byteLength(JSON.stringify(value)) < 1024 * 1024);
  const other = policy();
  (other.proxies as JsonObject[])[0].name = 'changed';
  assert.equal(nodes[0].name, 'example-node');
  assert.ok(Buffer.byteLength(JSON.stringify(result.config)) < 4 * 1024 * 1024);
  const dns = result.config.dns as JsonObject;
  const directDns = deployment.bootstrapResolvers.map(server => `${server}#DIRECT`);
  assert.deepEqual((dns['nameserver-policy'] as JsonObject)[`rule-set:${DOMESTIC_DOMAIN_PROVIDER}`], directDns);
  assert.deepEqual((dns['nameserver-policy'] as JsonObject)['+.cn'], directDns);
  const proxiedDomestic = compileConfig({ schemaVersion: 1, deployment, policy: policy({ selections: { Domestic: 'Proxy' } }) });
  assert.equal((proxiedDomestic.config.dns as JsonObject)['nameserver-policy'], undefined);
});

test('old fixed providers remain verifiable while a new workspace explicitly upgrades their assets', () => {
  const value = policy();
  // Reproduce the previous template: Proxy owned the short overseas list,
  // and the independent Overseas group/provider did not exist.
  const domesticV2 = { ...value, 'x-cocoproxy-rule-mode': 'domestic-v2',
    'proxy-groups': groups(value).filter(group => group.name !== 'Overseas'),
    rules: rules(value).filter(rule => rule !== overseasReferenceRule).map(rule => rule.replace(/,Overseas$/, ',Proxy')) };
  const start = domesticV2.rules.indexOf(domesticReferenceRules[0]);
  const legacy = { ...domesticV2, 'x-cocoproxy-rule-mode': 'domestic-v1', rules: [
    ...domesticV2.rules.slice(0, start), ...legacyDomesticDomainRules.map(rule => `${rule},Domestic`),
    ...domesticIpRules.map(rule => `${rule},Domestic`), 'MATCH,Other',
  ] };
  const deployment = { mixedPort: 17890, controllerPort: 19090, controllerSecret: 'EXAMPLE_ONLY', dnsPort: 15353, bootstrapResolvers: ['192.0.2.53'] };
  const old = compileConfig({ schemaVersion: 1, deployment, policy: legacy });
  const restored = expandCompilerRuleSets(old.config);
  for (const key of ['mixed-port', 'allow-lan', 'bind-address', 'external-controller', 'secret', 'tun', 'ipv6', 'dns']) delete restored[key];
  assert.equal(compileConfig({ schemaVersion: 1, deployment, policy: restored }).id, old.id);
  const upgraded = compileConfig({ schemaVersion: 1, deployment, policy: upgradeCompilerRulePolicy(restored) });
  assert.notEqual(upgraded.id, old.id);
  assert.deepEqual(upgraded.config.rules, compileConfig({ schemaVersion: 1, deployment, policy: domesticV2 }).config.rules);
  assert.equal((upgraded.config['rule-providers'] as JsonObject)[OVERSEAS_DOMAIN_PROVIDER], undefined);
  const restoredV2 = expandCompilerRuleSets(upgraded.config);
  for (const key of ['mixed-port', 'allow-lan', 'bind-address', 'external-controller', 'secret', 'tun', 'ipv6', 'dns']) delete restoredV2[key];
  assert.equal(compileConfig({ schemaVersion: 1, deployment, policy: restoredV2 }).id, upgraded.id);
  assert.notEqual(compileConfig({ schemaVersion: 1, deployment, policy: value }).id, upgraded.id);
});
