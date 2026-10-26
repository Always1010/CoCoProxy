import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeRules, createRuleTestHandler, normalizeRuleTarget, type RoutingSnapshot } from '../packages/management/rule-test.ts';
import { buildLocalPolicy } from '../packages/routing/index.ts';
import { compileConfig } from '../packages/config/index.ts';

const proxies: RoutingSnapshot['proxies'] = {
  Overseas: { type: 'Selector', now: 'Proxy', udp: true }, Proxy: { type: 'Selector', now: 'synthetic-node', udp: true },
  'synthetic-node': { type: 'Socks5', udp: true }, Domestic: { type: 'Selector', now: 'DIRECT', udp: true },
};
function snapshot(rules: string[], extra: Partial<RoutingSnapshot> = {}): RoutingSnapshot {
  return { generation: 'a'.repeat(64), config: { rules }, proxies, disabled: [], ...extra };
}
const noDns = async (): Promise<string[]> => { throw new Error('DNS should not be needed'); };

test('active local template resolves owned rule sets and current group chains, preserving first-match priority', async () => {
  const policy = buildLocalPolicy({ proxies: [{ name: 'synthetic-node', type: 'socks5', server: '192.0.2.10', port: 1080 }], selections: {}, rules: [], mode: 'rule' });
  const candidate = compileConfig({ schemaVersion: 1, deployment: { mixedPort: 17890, controllerPort: 19090, dnsPort: 15353,
    controllerSecret: 'EXAMPLE_ONLY_SECRET', bootstrapResolvers: ['192.0.2.53'] }, policy });
  const base = snapshot([], { config: candidate.config });
  const [overseas] = await analyzeRules({ target: 'registry.npmjs.org' }, base, noDns);
  assert.equal(overseas.policy, 'Overseas');
  assert.deepEqual(overseas.chain, ['Overseas', 'Proxy', 'synthetic-node']);
  assert.match(overseas.detail, /域名集合/);
  assert.equal((await analyzeRules({ target: 'www.baidu.com' }, base, noDns))[0].policy, 'Domestic');
  assert.equal((await analyzeRules({ target: 'google.com' }, snapshot(['DOMAIN,google.com,REJECT', 'DOMAIN-SUFFIX,google.com,Overseas', 'MATCH,DIRECT']), noDns))[0].policy, 'REJECT');
  assert.equal((await analyzeRules({ target: 'notgoogle.com' }, snapshot(['DOMAIN-SUFFIX,google.com,Overseas', 'MATCH,DIRECT']), noDns))[0].policy, 'DIRECT');
  assert.equal((await analyzeRules({ target: 'google.com' }, snapshot(['DOMAIN,google.com,REJECT', 'MATCH,DIRECT'], { disabled: [0] }), noDns))[0].policy, 'DIRECT');
});

test('DNS-dependent rules preserve no-resolve ordering and show separate IP outcomes; missing conditions never become a false fallback', async () => {
  const data = snapshot(['IP-CIDR,192.0.2.0/24,REJECT,no-resolve', 'IP-CIDR,192.0.2.0/24,Domestic', 'MATCH,Overseas']);
  const result = await analyzeRules({ target: 'unlisted.example' }, data, async () => ['192.0.2.1', '198.51.100.1']);
  assert.deepEqual(result.map(match => match.policy), ['Domestic', 'Overseas']);
  assert.equal((await analyzeRules({ target: '192.0.2.1' }, data, noDns))[0].policy, 'REJECT');
  assert.equal((await analyzeRules({ target: '2001:db8::42' }, snapshot(['IP-CIDR6,2001:db8::/32,DIRECT', 'MATCH,REJECT']), noDns))[0].policy, 'DIRECT');
  const conditions = snapshot(['SRC-IP-CIDR,192.0.2.0/24,REJECT', 'DST-PORT,443,Domestic', 'MATCH,Overseas']);
  assert.equal((await analyzeRules({ target: 'example.com' }, conditions, noDns))[0].status, 'indeterminate');
  assert.equal((await analyzeRules({ target: 'example.com', sourceIP: '198.51.100.1', destinationPort: 443 }, conditions, noDns))[0].policy, 'Domestic');
  assert.equal((await analyzeRules({ target: 'example.com' }, snapshot(['DOMAIN-REGEX,(a+)+$,REJECT', 'MATCH,DIRECT']), noDns))[0].status, 'indeterminate');
  await assert.rejects(analyzeRules({ target: 'example.com' }, data, async () => []), { code: 'RULE_TEST_DNS_FAILED' });
});

test('diagnostic input is bounded and generation changes invalidate results without writes', async () => {
  assert.equal(normalizeRuleTarget(' EXAMPLE.COM. '), 'example.com');
  assert.equal(normalizeRuleTarget('例子.中国'), 'xn--fsqu00a.xn--fiqs8s');
  assert.equal(normalizeRuleTarget('[2001:db8::1]'), '2001:db8::1');
  for (const target of ['https://example.com', 'example.com/path', 'example.com?x=1', 'example.com:443', '192.168.01.1', '', 'a'.repeat(254)])
    assert.throws(() => normalizeRuleTarget(target), { code: 'RULE_TEST_TARGET_INVALID' });
  let checks = 0;
  const handler = createRuleTestHandler({ snapshot: async () => snapshot(['MATCH,DIRECT']), resolve: noDns, isCurrent: async () => ++checks === 1 });
  const request = (body: unknown) => new Request('https://management.example/api/cocoproxy/rules/test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  await assert.rejects(handler(request({ target: 'example.com', destinationPort: 0 })), { code: 'RULE_TEST_INPUT_INVALID' });
  await assert.rejects(handler(request({ target: 'example.com', url: 'https://other.example' })), { code: 'INVALID_REQUEST' });
  await assert.rejects(handler(request({ target: 'example.com' })), { code: 'ACTIVE_CONFLICT' });
});
