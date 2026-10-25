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
