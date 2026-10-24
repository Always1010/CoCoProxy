import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { canonicalJson, compileConfig, ConfigError } from '../packages/config/index.ts';
import type { JsonObject } from '../packages/config/index.ts';

function input(): JsonObject {
  return {
    schemaVersion: 1,
    deployment: {
      mixedPort: 17890,
      controllerPort: 19090,
      controllerSecret: 'EXAMPLE_ONLY_SECRET',
      dnsPort: 15353,
      bootstrapResolvers: ['192.0.2.53'],
    },
    policy: {
      proxies: [{ name: 'manual', type: 'socks5', server: '192.0.2.10', port: 1080 }],
      'proxy-groups': [{ name: 'select', type: 'select', proxies: ['manual', 'REJECT'] }],
      rules: ['DOMAIN-SUFFIX,example.com,select', 'MATCH,REJECT'],
    },
  };
}

function fails(value: unknown, code: string): void {
  assert.throws(() => compileConfig(value), (error: unknown) => {
    assert.ok(error instanceof ConfigError);
    assert.equal(error.code, code);
    assert.ok(!error.message.includes('EXAMPLE_ONLY_SECRET'));
    assert.ok(!error.message.includes('192.0.2.10'));
    return true;
  });
}

test('compiles loopback explicit proxy with real-address DNS and disabled TUN', () => {
  const candidate = compileConfig(input());
  const config = candidate.config;
  assert.equal(config['allow-lan'], false);
  assert.equal(config['bind-address'], '127.0.0.1');
  assert.equal(config['mixed-port'], 17890);
  assert.equal(config['external-controller'], '127.0.0.1:19090');
  assert.equal(config.secret, 'EXAMPLE_ONLY_SECRET');
  assert.equal(config.mode, 'rule');
  assert.equal(config.ipv6, false);
  assert.deepEqual(config.tun, { enable: false });
  assert.deepEqual(config.dns, {
    enable: true,
    listen: '127.0.0.1:15353',
    'enhanced-mode': 'redir-host',
    ipv6: false,
    'default-nameserver': ['192.0.2.53'],
    nameserver: ['192.0.2.53'],
  });
});

test('canonical hash ignores object-key order and changes with actual content', () => {
  const first = input();
  const second = {
    policy: { rules: ['DOMAIN-SUFFIX,example.com,select', 'MATCH,REJECT'],
      'proxy-groups': [{ proxies: ['manual', 'REJECT'], type: 'select', name: 'select' }],
      proxies: [{ port: 1080, server: '192.0.2.10', type: 'socks5', name: 'manual' }] },
    deployment: { dnsPort: 15353, bootstrapResolvers: ['192.0.2.53'], controllerSecret: 'EXAMPLE_ONLY_SECRET', controllerPort: 19090, mixedPort: 17890 },
    schemaVersion: 1,
  };
  const a = compileConfig(first);
  const b = compileConfig(second);
  assert.equal(a.id, a.sha256);
  assert.match(a.sha256, /^[a-f0-9]{64}$/);
  assert.equal(a.sha256, b.sha256);
  assert.equal(a.sha256, createHash('sha256').update(canonicalJson(a.config), 'utf8').digest('hex'));
  (first.policy as JsonObject)['log-level'] = 'warning';
  assert.notEqual(compileConfig(first).sha256, a.sha256);
});

test('merges only in-memory source snapshots and preserves advanced JSON fields', () => {
  const value = input();
  (value.policy as JsonObject)['tcp-concurrent'] = true;
  (value.policy as JsonObject)['experimental-option'] = { enabled: true, thresholds: [1, 2] };
  value.sources = [{ id: 'snapshot', proxies: [{ name: 'source-node', type: 'vless', server: 'node.example', port: 443, 'ws-opts': { path: '/synthetic' } }] }];
  const candidate = compileConfig(value);
  assert.deepEqual(candidate.config['experimental-option'], { enabled: true, thresholds: [1, 2] });
  assert.equal(candidate.config['tcp-concurrent'], true);
  assert.equal((candidate.config.proxies as JsonObject[]).length, 2);
  assert.equal((candidate.config.proxies as JsonObject[])[1].server, 'node.example');
  assert.equal(candidate.config.sources, undefined);
});

test('does not mutate or retain references to the input', () => {
  const value = input();
  const before = JSON.stringify(value);
  const candidate = compileConfig(value);
  assert.equal(JSON.stringify(value), before);
  ((value.policy as JsonObject).proxies as JsonObject[])[0].name = 'changed';
  ((value.deployment as JsonObject).bootstrapResolvers as string[])[0] = '198.51.100.53';
  assert.equal((candidate.config.proxies as JsonObject[])[0].name, 'manual');
  assert.deepEqual((candidate.config.dns as JsonObject).nameserver, ['192.0.2.53']);
});

test('rejects protected deployment keys even when supplied with disabled values', () => {
  for (const key of ['tun', 'dns', 'allow-lan', 'port', 'mixed-port', 'socks-port', 'redir-port', 'tproxy-port', 'listeners', 'external-controller', 'external-controller-unix', 'secret', 'authentication', 'external-ui', 'external-ui-url', 'profile', 'hosts', 'sniffer', 'ipv6',
    'iptables', 'tuic-server', 'ss-config', 'vmess-config', 'ntp', 'external-doh-server', 'external-controller-routing-mark', 'clash-for-android']) {
    const value = input();
    (value.policy as JsonObject)[key] = false;
    fails(value, 'PROTECTED_FIELD');
  }
  for (const mode of ['direct', 'global']) {
    const value = input();
    (value.policy as JsonObject).mode = mode;
    fails(value, 'PROTECTED_FIELD');
  }
});

test('rejects recursive providers, scripts, file reads and egress overrides', () => {
  for (const key of ['proxy-providers', 'rule-providers', 'script', 'interface-name', 'routing-mark', 'dialer-proxy', 'certificate', 'private-key', 'ca-file', 'plugin', 'executable', 'file-descriptor', 'dialer-ip4p-convert']) {
    const value = input();
    value.sources = [{ id: 'snapshot', proxies: [{ name: 'untrusted', type: 'socks5', options: { [key]: 'SENSITIVE_NODE_CONTENT' } }] }];
    fails(value, 'PROTECTED_FIELD');
  }
  const value = input();
  (value.policy as JsonObject).extension = { nested: { 'rule-providers': {} } };
  fails(value, 'PROTECTED_FIELD');
});

test('rejects source URLs, failed snapshots and incomplete envelopes without fetching', () => {
  const value = input();
  value.sources = [{ id: 'remote', url: 'https://example.invalid/subscription', proxies: [] }];
  fails(value, 'INVALID_INPUT');
  value.sources = [{ id: 'failed', error: 'download failed' }];
  fails(value, 'INVALID_INPUT');
  value.sources = [{ id: 'missing-snapshot' }];
  fails(value, 'INVALID_INPUT');
});

test('rejects external rule data even inside compound rules', () => {
  for (const rule of ['RULE-SET,remote,REJECT', 'GEOIP,CN,DIRECT', 'SRC-GEOIP,CN,DIRECT', 'GEOSITE,category,REJECT', 'IP-ASN,64500,REJECT', 'SRC-IP-ASN,64500,REJECT', 'AND,((NETWORK,TCP),(GEOSITE,category)),REJECT']) {
    const value = input();
    (value.policy as JsonObject).rules = [rule];
    fails(value, 'PROTECTED_FIELD');
  }
  const value = input();
  (value.policy as JsonObject)['sub-rules'] = { sub: ['RULE-SET,local,REJECT'] };
  fails(value, 'PROTECTED_FIELD');
});

test('rejects duplicate nodes, groups, source IDs and reserved proxy names', () => {
  const duplicatedNode = input();
  duplicatedNode.sources = [{ id: 'snapshot', proxies: [{ name: 'manual', type: 'socks5' }] }];
  fails(duplicatedNode, 'NAME_CONFLICT');
  const duplicatedGroup = input();
  ((duplicatedGroup.policy as JsonObject)['proxy-groups'] as JsonObject[]).push({ name: 'select', type: 'select' });
  fails(duplicatedGroup, 'NAME_CONFLICT');
  const groupNodeConflict = input();
  ((groupNodeConflict.policy as JsonObject)['proxy-groups'] as JsonObject[])[0].name = 'manual';
  fails(groupNodeConflict, 'NAME_CONFLICT');
  const duplicatedSource = input();
  duplicatedSource.sources = [{ id: 'same', proxies: [] }, { id: 'same', proxies: [] }];
  fails(duplicatedSource, 'NAME_CONFLICT');
  const reserved = input();
  ((reserved.policy as JsonObject).proxies as JsonObject[])[0].name = 'DIRECT';
  fails(reserved, 'NAME_CONFLICT');
});

test('accepts only literal bootstrap IPs and distinct valid ports', () => {
  for (const resolver of ['dns.example', 'https://dns.example/dns-query', '192.0.2.53:53', ' 192.0.2.53']) {
    const value = input();
    (value.deployment as JsonObject).bootstrapResolvers = [resolver];
    fails(value, 'INVALID_INPUT');
  }
  for (const badPort of [0, 65536, 1.5, '17890']) {
    const value = input();
    (value.deployment as JsonObject).mixedPort = badPort;
    fails(value, 'INVALID_INPUT');
  }
  const conflict = input();
  (conflict.deployment as JsonObject).dnsPort = 17890;
  fails(conflict, 'INVALID_INPUT');
  const noSecret = input();
  (noSecret.deployment as JsonObject).controllerSecret = '  ';
  fails(noSecret, 'INVALID_INPUT');
});

test('rejects unsafe object keys, accessors, cyclic/non-JSON inputs and sparse arrays', () => {
  for (const key of ['__proto__', 'constructor', 'prototype']) {
    const value = input();
    (value.policy as JsonObject).extension = JSON.parse(`{"${key}": {"polluted": true}}`);
    fails(value, 'INVALID_INPUT');
  }
  let accessorInvoked = false;
  const accessor = input();
  Object.defineProperty(accessor.policy as JsonObject, 'leak', { enumerable: true, get() { accessorInvoked = true; throw new Error('SENSITIVE_NODE_CONTENT'); } });
  fails(accessor, 'INVALID_INPUT');
  assert.equal(accessorInvoked, false);
  const cycle = input();
  (cycle.policy as JsonObject).cycle = cycle;
  fails(cycle, 'INVALID_INPUT');
  const nonJson = input();
  (nonJson.policy as Record<string, unknown>).date = new Date();
  fails(nonJson, 'INVALID_INPUT');
  const sparse = input();
  (sparse.policy as JsonObject).rules = new Array(2);
  fails(sparse, 'INVALID_INPUT');
  assert.equal(({} as { polluted?: boolean }).polluted, undefined);
});

test('rejects oversized and excessively nested input before core validation', () => {
  const oversized = input();
  (oversized.policy as JsonObject).extension = 'x'.repeat(4 * 1024 * 1024 + 1);
  fails(oversized, 'LIMIT_EXCEEDED');
  const nested = input();
  let cursor = nested.policy as JsonObject;
  for (let index = 0; index < 60; index++) {
    cursor.child = {};
    cursor = cursor.child;
  }
  fails(nested, 'LIMIT_EXCEEDED');
});
