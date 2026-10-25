import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeNodeSnapshot, decodeSubscriptionProfile, resolveSubscriptionProfile, SnapshotDecodeError } from '../packages/subscriptions/yaml.ts';
import { compileConfig } from '../packages/config/index.ts';

const node = { name: 'Example', type: 'ss', server: '192.0.2.10', port: 443, cipher: 'aes-128-gcm', password: 'synthetic-password' };
const reject = (text: string, expected?: string) => assert.throws(() => decodeNodeSnapshot(text), (error: unknown) => {
  assert.ok(error instanceof SnapshotDecodeError);
  if (expected) assert.equal(error.code, expected);
  assert.equal(error.message, error.code);
  assert.equal(error.cause, undefined);
  assert.ok(!String(error).includes('synthetic-password'));
  assert.ok(!String(error).includes('https://subscription.example'));
  return true;
});

test('JSON and common Clash YAML decode into the same plain node snapshot', () => {
  const expected = { proxies: [node] };
  assert.deepEqual(decodeNodeSnapshot(JSON.stringify(expected)), expected);
  assert.deepEqual(decodeNodeSnapshot(`%YAML 1.2
---
proxies:
  - name: Example
    type: ss
    server: 192.0.2.10
    port: 443
    cipher: aes-128-gcm
    password: synthetic-password
`), expected);
  assert.deepEqual(decodeNodeSnapshot('proxies: []'), { proxies: [] });
});

test('only nodes are imported from full upstream policy, deployment, providers and scripts', () => {
  const value = decodeNodeSnapshot(`proxies: ${JSON.stringify([node])}
proxy-groups: [{name: upstream, type: select, proxies: [Example]}]
rules: [MATCH,upstream]
mixed-port: 9999
external-controller: 0.0.0.0:9090
secret: upstream-secret
proxy-providers: {remote: {type: http, url: https://subscription.example/remote}}
script: {code: "throw new Error('must never execute')"}
`);
  assert.deepEqual(value, { proxies: [node] });
  assert.deepEqual(Object.keys(value as object), ['proxies']);
});

test('limited harmless scalar and mapping anchors are copied into independent JSON data', () => {
  const value = decodeNodeSnapshot(`defaults: &options {path: /example, headers: {Host: example.test}}
server: &server 192.0.2.10
proxies:
  - {name: A, type: vmess, server: *server, port: 443, ws-opts: *options}
  - {name: B, type: vmess, server: *server, port: 443, ws-opts: *options}
`) as { proxies: JsonNode[] };
  type JsonNode = { [key: string]: unknown };
  assert.equal(value.proxies[0].server, '192.0.2.10');
  assert.deepEqual(value.proxies[0]['ws-opts'], value.proxies[1]['ws-opts']);
  assert.notEqual(value.proxies[0]['ws-opts'], value.proxies[1]['ws-opts']);
  assert.equal(Object.getPrototypeOf(value.proxies[0]), Object.prototype);
  assert.deepEqual(JSON.parse(JSON.stringify(value)), value);
});

test('missing inline proxies, URI and base64 inputs do not masquerade as supported subscriptions', () => {
  for (const input of [
    'proxy-providers: {remote: {type: http, url: https://subscription.example/nodes}}',
    'scripts: [synthetic-password]', 'rules: [MATCH,DIRECT]', '', 'null', '[]',
    'ss://synthetic-password@subscription.example:443', Buffer.from(JSON.stringify({ proxies: [node] })).toString('base64'),
  ]) reject(input, 'SNAPSHOT_UNSUPPORTED');
  for (const input of ['proxies: null', 'proxies: {}', 'proxies: [null]', 'proxies: [text]', 'proxies: [[]]']) reject(input, 'SNAPSHOT_INVALID');
});

test('tags, duplicate keys, complex keys and extra documents are rejected without source diagnostics', () => {
  for (const input of [
    'proxies: !include https://subscription.example/synthetic-password',
    'proxies: !!js/function "synthetic-password"',
    'proxies: !!binary c3ludGhldGljLXBhc3N3b3Jk',
    'proxies: !!set {A: null}', 'proxies: [{when: !!timestamp 2025-01-01}]',
    'proxies: []\nproxies: []', 'proxies: [{name: first, name: synthetic-password}]',
    '? [complex, key]\n: value\nproxies: []',
    'proxies: []\n---\nproxies: []', 'proxies: []\n...\n---\n',
    '%YAML 1.1\n---\nproxies: []', '%TAG !e! tag:example.test,2026:\n---\nproxies: []',
  ]) reject(input);
});

test('cycles, alias bombs and excessive alias references are rejected', () => {
  reject('proxies: &cycle [*cycle]');
  reject('ignored: &cycle {self: *cycle}\nproxies: []');
  const levels = ['a: &a [x,x,x,x,x,x,x,x,x,x]'];
  let previous = 'a';
  for (const next of ['b', 'c', 'd', 'e']) {
    levels.push(`${next}: &${next} [${Array(10).fill(`*${previous}`).join(',')}]`);
    previous = next;
  }
  reject(levels.join('\n') + '\nproxies: []');
  reject('base: &base 1\nignored: [' + Array(51).fill('*base').join(',') + ']\nproxies: []', 'SNAPSHOT_LIMIT');
});

test('input bytes, structure depth, expanded bytes and expanded value counts are bounded', () => {
  reject('proxies: []\n#' + '中'.repeat(350_000), 'SNAPSHOT_LIMIT');
  reject('proxies: []\nignored: ' + '['.repeat(60) + '0' + ']'.repeat(60), 'SNAPSHOT_LIMIT');
  reject('base: &base "' + 'x'.repeat(100_000) + '"\nignored: [' + Array(45).fill('*base').join(',') + ']\nproxies: []', 'SNAPSHOT_LIMIT');
  reject('base: &base [' + Array(2_500).fill('0').join(',') + ']\nignored: [' + Array(45).fill('*base').join(',') + ']\nproxies: []', 'SNAPSHOT_LIMIT');
});

test('non-JSON numbers and pollution keys cannot reach a snapshot', () => {
  for (const value of ['.nan', '.inf', '-.inf']) reject(`proxies: [{value: ${value}}]`, 'SNAPSHOT_INVALID');
  for (const key of ['__proto__', 'constructor', 'prototype']) {
    reject(`proxies: [{${key}: {polluted: true}}]`, 'SNAPSHOT_INVALID');
    reject(`proxies: []\n${key}: {polluted: true}`, 'SNAPSHOT_INVALID');
    reject(`{"proxies":[{"${key}":{"polluted":true}}]}`, 'SNAPSHOT_INVALID');
  }
  assert.equal(({} as { polluted?: boolean }).polluted, undefined);
});

test('decoder preserves node safety fields for the compiler to reject', () => {
  const decoded = decodeNodeSnapshot(`proxies: [{name: unsafe, type: ss, exec: synthetic-password}]`) as { proxies: unknown[] };
  assert.throws(() => compileConfig({
    schemaVersion: 1,
    deployment: { mixedPort: 18080, controllerPort: 18081, dnsPort: 18053, controllerSecret: 'test-secret', bootstrapResolvers: ['192.0.2.53'] },
    policy: { rules: ['MATCH,REJECT'] }, sources: [{ id: 'source', proxies: decoded.proxies }],
  }), { code: 'PROTECTED_FIELD' });
  reject('proxies: [\n  password: synthetic-password\n  url: https://subscription.example/private\n');
});

test('profile decoder preserves complete inline policy and discloses deployment fields', () => {
  const policy = { proxies: [node], 'proxy-groups': [{ name: 'Automatic', type: 'url-test',
    proxies: ['Example'], url: 'https://probe.example/check', interval: 300 }],
    rules: ['DOMAIN,example.test,Automatic', 'MATCH,DIRECT'],
    'sub-rules': { local: ['DOMAIN-SUFFIX,example.test,DIRECT'] }, 'log-level': 'info' };
  const result = decodeSubscriptionProfile(JSON.stringify({ ...policy, tun: { enable: true }, 'mixed-port': 9999 }));
  assert.deepEqual(result, { proxies: [node], policy, unsupportedFields: ['mixed-port', 'tun'] });
  assert.deepEqual(decodeSubscriptionProfile('rules: ["MATCH,DIRECT"]'), { proxies: [], policy: { proxies: [], rules: ['MATCH,DIRECT'] } });
  assert.deepEqual(decodeSubscriptionProfile(JSON.stringify({ proxies: [node] })), { proxies: [node] });
  for (const key of ['proxy-providers', 'rule-providers']) {
    assert.throws(() => decodeSubscriptionProfile(JSON.stringify({ proxies: [node], [key]: {} })), { code: 'SNAPSHOT_UNSUPPORTED' });
  }
  assert.throws(() => decodeSubscriptionProfile('proxies: []\nproxies: []'), { code: 'SNAPSHOT_DECODE_FAILED' });
});

test('node DNS policies retain only exact imported hosts and dedicated resolver precedence', () => {
  const proxies = [
    { ...node, name: 'one', server: 'Node.Example.test' },
    { ...node, name: 'two', server: 'other.example.test' },
    { ...node, name: 'three', server: 'unrelated.test' }, node,
  ];
  const endpoint = 'https://resolver.example:8443/private/synthetic-token/dns-query';
  const document = { proxies, hosts: { 'node.example.test': '192.0.2.9' }, dns: {
    listen: '0.0.0.0:53', 'enhanced-mode': 'fake-ip', 'fake-ip-range': '198.18.0.1/16',
    nameserver: ['https://unrelated.example/dns-query'],
    'nameserver-policy': { '+.example.test': '1.1.1.1', 'node.example.test': '8.8.8.8',
      '+.test': 'http://ignored.example/invalid', 'geosite:private': 'invalid', 'unused.test': 'invalid' },
    'proxy-server-nameserver-policy': { '+.example.test': endpoint, 'other.example.test': ['9.9.9.9'] },
  } };
  const nodeDnsPolicy = { 'node.example.test': [endpoint], 'other.example.test': ['9.9.9.9'] };
  assert.deepEqual(decodeNodeSnapshot(JSON.stringify(document)), { proxies, nodeDnsPolicy });
  assert.deepEqual(decodeSubscriptionProfile(JSON.stringify(document)), {
    proxies, policy: { proxies }, nodeDnsPolicy, unsupportedFields: ['dns', 'hosts'],
  });
  // More specific suffixes win independently of upstream key order.
  assert.deepEqual((decodeNodeSnapshot(JSON.stringify({ proxies,
    dns: { 'nameserver-policy': { '+.node.example.test': '9.9.9.9', '+.example.test': '1.1.1.1' } },
  })) as { nodeDnsPolicy: unknown }).nodeDnsPolicy,
  { 'node.example.test': ['9.9.9.9'], 'other.example.test': ['1.1.1.1'] });
});

test('matching node DNS resolver errors are fixed and cannot silently change node resolution', () => {
  const proxies = [{ ...node, server: 'node.example.test' }];
  for (const resolver of [
    'https://user:synthetic-token@resolver.example/dns-query', 'https://resolver.example/dns-query?synthetic-token',
    'https://resolver.example/dns-query#synthetic-token', 'http://resolver.example/synthetic-token',
    'https://resolver.example:0/synthetic-token', 'https://resolver.example/', '127.0.0.1', '192.168.1.1',
    '::1', '2001:db8::1', 'https://resolver.example\\synthetic-token', 'system', [], ['1.1.1.1', 'invalid'],
    'https://resolver.example/' + 'x'.repeat(2048), Array(17).fill('1.1.1.1'),
  ]) {
    for (const decode of [decodeNodeSnapshot, decodeSubscriptionProfile]) {
      assert.throws(() => decode(JSON.stringify({ proxies, dns: { 'nameserver-policy': { 'node.example.test': resolver },
        'proxy-server-nameserver-policy': { 'node.example.test': '1.1.1.1' } } })), (error: unknown) => {
        assert.ok(error instanceof SnapshotDecodeError);
        assert.match(error.code, /^SNAPSHOT_(INVALID|LIMIT)$/);
        assert.equal(error.message, error.code);
        assert.ok(!JSON.stringify(error).includes('synthetic-token'));
        return true;
      });
    }
  }
});

test('provider DNS policies follow retained nodes and parent policies cover expanded nodes', async () => {
  const endpoint = 'https://resolver.example:5443/synthetic-private-token/dns-query';
  const root = { 'proxy-providers': { remote: { type: 'http', url: 'https://provider.example/nodes', filter: '^keep' } },
    'proxy-groups': [{ name: 'Choose', type: 'select', use: ['remote'] }],
    dns: { 'proxy-server-nameserver-policy': { 'keep.example.test': '9.9.9.9' } } };
  const response = { proxies: [{ ...node, name: 'keep', server: 'keep.example.test' },
    { ...node, name: 'drop', server: 'drop.example.test' }],
    dns: { listen: '0.0.0.0:53', 'nameserver-policy': { 'keep.example.test': endpoint, 'drop.example.test': 'invalid' } } };
  const resolve = () => resolveSubscriptionProfile(JSON.stringify(root), async () => ({ status: 'modified', text: JSON.stringify(response) }));
  const result = await resolve();
  assert.deepEqual((result.value as { nodeDnsPolicy: unknown }).nodeDnsPolicy, { 'keep.example.test': ['9.9.9.9'] });
  delete (root as { dns?: unknown }).dns;
  assert.deepEqual(((await resolve()).value as { nodeDnsPolicy: unknown }).nodeDnsPolicy, { 'keep.example.test': [endpoint] });
  response.dns['nameserver-policy']['keep.example.test'] = 'https://resolver.example/dns-query#synthetic-private-token';
  await assert.rejects(resolve(), { code: 'SNAPSHOT_INVALID' });
});

test('provider count, total download bytes and expanded rule bytes are bounded', async () => {
  let calls = 0;
  const providers = Object.fromEntries(Array.from({ length: 17 }, (_, index) => ['source' + index,
    { type: 'http', url: 'https://provider.example/' + index }]));
  await assert.rejects(resolveSubscriptionProfile(JSON.stringify({ 'proxy-providers': providers }), async () => {
    calls++; return { status: 'modified', text: 'proxies: []' };
  }), { code: 'SNAPSHOT_LIMIT' });
  assert.equal(calls, 0);
  delete providers.source16;
  const largeBody = 'proxies: []\n#' + 'x'.repeat(1024 * 1024 - 15);
  await assert.rejects(resolveSubscriptionProfile(JSON.stringify({ 'proxy-providers': providers }), async () => {
    calls++; return { status: 'modified', text: largeBody };
  }), { code: 'SNAPSHOT_LIMIT' });
  assert.equal(calls, 4);
  await assert.rejects(resolveSubscriptionProfile(JSON.stringify({
    'rule-providers': { domains: { type: 'inline', behavior: 'domain', payload: ['a'.repeat(100_000) + '.test'] } },
    rules: Array(50).fill('RULE-SET,domains,DIRECT'),
  }), async () => { throw new Error('inline providers must not download'); }), { code: 'SNAPSHOT_LIMIT' });
});

test('group count and aggregate member expansion fail before fetching later providers', async () => {
  const ruleProvider = { domains: { type: 'http', behavior: 'domain', url: 'https://provider.example/domains' } };
  let calls = 0;
  const fetch = async () => { calls++; return { status: 'modified', text: 'payload: [example.test]' }; };
  // A compact input must not allocate the full million-member Cartesian result.
  const proxies = Array.from({ length: 1_000 }, (_, index) => ({ ...node, name: `node-${index}` }));
  const groups = Array.from({ length: 1_000 }, (_, index) => ({ name: `group-${index}`, type: 'select', 'include-all': true }));
  for (const profile of [
    { 'proxy-groups': [...groups, { name: 'extra', type: 'select' }] },
    { proxies, 'proxy-groups': groups },
    // The byte budget is independent of the number of expanded members.
    { proxies: proxies.slice(0, 20).map((entry, index) => ({ ...entry, name: `${index}-` + '中'.repeat(80) })), 'proxy-groups': groups },
  ]) {
    await assert.rejects(resolveSubscriptionProfile(JSON.stringify({ ...profile, 'rule-providers': ruleProvider }), fetch),
      { code: 'SNAPSHOT_LIMIT' });
    assert.equal(calls, 0);
  }
});

test('provider overrides are budgeted while materializing nodes', async () => {
  let calls = 0;
  await assert.rejects(resolveSubscriptionProfile(JSON.stringify({
    'proxy-providers': {
      inline: { type: 'inline', payload: Array.from({ length: 500 }, (_, index) => ({ ...node, name: `node-${index}` })),
        override: { password: 'x'.repeat(10_000) } },
      later: { type: 'http', url: 'https://provider.example/later' },
    },
  }), async () => { calls++; return { status: 'modified', text: 'proxies: []' }; }), { code: 'SNAPSHOT_LIMIT' });
  assert.equal(calls, 0);
});

test('streamed group membership preserves ordering, filters and repeated provider references', async () => {
  const profile = {
    proxies: [{ ...node, name: 'local' }],
    'proxy-providers': {
      first: { type: 'inline', payload: [{ ...node, name: 'first' }, { ...node, name: 'excluded' }] },
      second: { type: 'inline', payload: [{ ...node, name: 'second' }] },
    },
    'proxy-groups': [
      { name: 'all', type: 'select', proxies: ['DIRECT', 'first', 'DIRECT'], 'include-all': true,
        use: Array(10_000).fill('first'), 'exclude-filter': 'excluded' },
      { name: 'ordered', type: 'select', use: ['second', 'first', 'second'], filter: 'first|second' },
    ],
  };
  const result = await resolveSubscriptionProfile(JSON.stringify(profile), async () => { throw new Error('inline providers must not download'); });
  assert.deepEqual(result, { materializedProviders: true, value: {
    proxies: [profile.proxies[0], ...profile['proxy-providers'].first.payload, ...profile['proxy-providers'].second.payload],
    policy: {
      proxies: [profile.proxies[0], ...profile['proxy-providers'].first.payload, ...profile['proxy-providers'].second.payload],
      'proxy-groups': [
        { name: 'all', type: 'select', proxies: ['DIRECT', 'first', 'local', 'second'] },
        { name: 'ordered', type: 'select', proxies: ['second', 'first'] },
      ],
    },
  } });
});
