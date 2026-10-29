import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { canonicalJson, compileConfig, ConfigError, deploymentDnsOptions } from '../packages/config/index.ts';
import type { JsonObject, JsonValue } from '../packages/config/index.ts';

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

test('managed choices may disable the selector cache without enabling other profile features', () => {
  const value = input();
  (value.policy as JsonObject).profile = { 'store-selected': false };
  assert.deepEqual(compileConfig(value).config.profile, { 'store-selected': false });
  const profiles: JsonObject[] = [{ 'store-selected': true }, { 'store-selected': false, 'store-fake-ip': true }, {}];
  for (const profile of profiles) {
    (value.policy as JsonObject).profile = profile;
    fails(value, 'PROTECTED_FIELD');
  }
});

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

test('deployment separates routed HTTPS DNS from independent node and direct resolvers', () => {
  const value = input();
  (value.deployment as JsonObject).nameservers = ['https://192.0.2.54/dns-query'];
  const candidate = compileConfig(value), dns = candidate.config.dns as JsonObject;
  assert.deepEqual(dns.nameserver, ['https://192.0.2.54/dns-query']);
  assert.equal(dns['respect-rules'], true);
  assert.deepEqual(dns['proxy-server-nameserver'], ['192.0.2.53']);
  assert.deepEqual(dns['direct-nameserver'], ['192.0.2.53']);
  assert.deepEqual(dns['default-nameserver'], ['192.0.2.53']);
  assert.notEqual(candidate.id, compileConfig(input()).id);
  for (const nameservers of [[], ['http://192.0.2.54/dns-query'], ['192.0.2.54'],
    ['https://user:pass@resolver.invalid/dns-query'], ['https://resolver.invalid/dns-query#eth0'],
    ['https://resolver.invalid/dns-query?name=example.com'], ['https://resolver.invalid/'], ['https://resolver.invalid/dns query']]) {
    (value.deployment as JsonObject).nameservers = nameservers;
    fails(value, 'INVALID_INPUT');
  }
});

test('deployment can recover domain rules without DNS mapping while excluding local destinations', () => {
  const value = input();
  assert.equal(compileConfig(value).id, '1becc2e498827b72410f3995dc21418f8b02ceabdd9a38dc3f0e9328ba954458');
  assert.equal(compileConfig(value).config.sniffer, undefined);
  (value.deployment as JsonObject).sniffing = true;
  assert.equal(compileConfig(value).id, 'e9a823a62aa7ea40627826fd0f6f18de4df76aba3ed5fcd1af238b9b9b3f3c85');
  const sniffer = compileConfig(value).config.sniffer as JsonObject;
  assert.equal(sniffer.enable, true);
  assert.equal(sniffer['parse-pure-ip'], true);
  assert.equal(sniffer['force-dns-mapping'], true);
  assert.equal(sniffer['override-destination'], true);
  assert.ok((sniffer['skip-dst-address'] as string[]).includes('192.168.0.0/16'));
  (value.deployment as JsonObject).sniffing = 'true';
  fails(value, 'INVALID_INPUT');
});

test('trusted performance options are explicit and cannot silently disable process rules', () => {
  const value = input(), deployment = value.deployment as JsonObject, policy = value.policy as JsonObject;
  assert.equal(compileConfig(value).config['tcp-concurrent'], undefined);
  policy['tcp-concurrent'] = false;
  policy['find-process-mode'] = 'strict';
  deployment.performance = { tcpConcurrent: true, findProcessMode: 'off' };
  const config = compileConfig(value).config;
  assert.equal(config['tcp-concurrent'], true);
  assert.equal(config['find-process-mode'], 'off');
  policy.rules = ['AND,((PROCESS-NAME,example),(NETWORK,TCP)),DIRECT', 'MATCH,REJECT'];
  fails(value, 'INVALID_INPUT');
  deployment.performance = { tcpConcurrent: true, findProcessMode: 'strict' };
  assert.equal(compileConfig(value).config['find-process-mode'], 'strict');
  for (const performance of [{ tcpConcurrent: 'true' }, { findProcessMode: 'auto' }, { findProcessMode: ['off'] }, { extra: true }] as JsonObject[]) {
    deployment.performance = performance; fails(value, 'INVALID_INPUT');
  }
});

test('missing-only sniffing excludes bounded domains and ports and reconstructs exact compiler output', () => {
  const value = input(), deployment = value.deployment as JsonObject;
  deployment.sniffing = { mode: 'missing-only', skipDomains: ['+.example.com'], skipPorts: [443, '8440-8450'] };
  const candidate = compileConfig(value), sniffer = candidate.config.sniffer as JsonObject;
  assert.equal(sniffer['force-dns-mapping'], false);
  assert.deepEqual(sniffer['skip-domain'], ['+.example.com']);
  assert.deepEqual(sniffer.sniff, { HTTP: { ports: [80, '8080-8439', '8451-8880'] } });
  assert.equal(compileConfig({ ...value, deployment: { ...deployment, ...deploymentDnsOptions(candidate.config) } }).id, candidate.id);
  deployment.sniffing = 'force';
  assert.equal((compileConfig(value).config.sniffer as JsonObject)['force-dns-mapping'], true);
  for (const sniffing of [false, 'off', { mode: 'off' }]) {
    deployment.sniffing = sniffing; assert.equal(compileConfig(value).config.sniffer, undefined);
  }
  for (const sniffing of ['always', { mode: 'missing-only', skipDomains: ['rule-set:remote'] },
    { mode: 'missing-only', skipPorts: [0] }, { mode: 'force', skipPorts: ['443-80'] },
    { mode: 'force', skipPorts: ['1-65535'] }, { mode: 'off', skipPorts: [443] }] as JsonValue[]) {
    deployment.sniffing = sniffing; fails(value, 'INVALID_INPUT');
  }
  // A range crossing unsniffed gaps must not expand past the 64-entry bound.
  deployment.sniffing = { mode: 'missing-only', skipPorts: ['1-8080', ...Array.from({ length: 63 }, (_, index) => 8082 + index * 2)] };
  const bounded = compileConfig(value), recovered = deploymentDnsOptions(bounded.config);
  assert.equal(((recovered.sniffing as JsonObject).skipPorts as JsonValue[]).length, 64);
  assert.equal(compileConfig({ ...value, deployment: { ...deployment, ...recovered } }).id, bounded.id);
});

test('bounded deployment DNS policies preserve bootstrap and round trip independent resolvers', () => {
  const value = input(), deployment = value.deployment as JsonObject;
  Object.assign(deployment, { nameserverPolicy: { '+.example.com': ['192.0.2.54'], 'login.example.com': ['https://resolver.example/dns-query'] },
    nodeResolvers: ['https://node-dns.example/dns-query'], directResolvers: ['198.51.100.53'] });
  const candidate = compileConfig(value), dns = candidate.config.dns as JsonObject;
  assert.deepEqual(dns['default-nameserver'], ['192.0.2.53']);
  assert.deepEqual(dns['nameserver-policy'], deployment.nameserverPolicy);
  assert.deepEqual(dns['proxy-server-nameserver'], deployment.nodeResolvers);
  assert.deepEqual(dns['direct-nameserver'], deployment.directResolvers);
  assert.equal(dns['respect-rules'], true);
  assert.equal(compileConfig({ ...value, deployment: { ...deployment, ...deploymentDnsOptions(candidate.config) } }).id, candidate.id);
  for (const nameserverPolicy of [{}, { 'rule-set:remote': ['192.0.2.54'] }, { 'geosite:cn': ['192.0.2.54'] },
    { '*.example.com': ['192.0.2.54'] }, { 'example.com': ['https://resolver.example/dns-query#'] },
    { 'example.com': ['https://user@resolver.example/dns-query'] }, { 'example.com': [] },
    Object.fromEntries(Array.from({ length: 257 }, (_, index) => [`d${index}.example`, ['192.0.2.54']]))]) {
    deployment.nameserverPolicy = nameserverPolicy;
    fails(value, 'INVALID_INPUT');
  }
  delete deployment.nameserverPolicy;
  for (const field of ['nodeResolvers', 'directResolvers']) {
    deployment[field] = ['192.0.2.54#DIRECT']; fails(value, 'INVALID_INPUT'); delete deployment[field];
  }
});

test('node DNS policies compile independently with bootstrap fallback and stable reconstruction', () => {
  const value = input(), deployment = value.deployment as JsonObject;
  const legacy = compileConfig(value);
  const endpoint = 'https://node-resolver.example:5443/synthetic-private-token/dns-query';
  deployment.nodeNameserverPolicy = { 'node.example.test': [endpoint] };
  const candidate = compileConfig(value), dns = candidate.config.dns as JsonObject;
  assert.notEqual(candidate.id, legacy.id);
  assert.deepEqual(dns['proxy-server-nameserver-policy'], deployment.nodeNameserverPolicy);
  assert.deepEqual(dns['proxy-server-nameserver'], deployment.bootstrapResolvers);
  assert.deepEqual(dns.nameserver, deployment.bootstrapResolvers);
  assert.equal(dns['respect-rules'], undefined);
  assert.equal(dns['nameserver-policy'], undefined);
  const recovered = deploymentDnsOptions(candidate.config);
  assert.deepEqual(recovered.nodeNameserverPolicy, deployment.nodeNameserverPolicy);
  assert.equal(compileConfig({ ...value, deployment: { ...deployment, ...recovered } }).id, candidate.id);
  deployment.nodeResolvers = ['1.1.1.1'];
  deployment.nameserverPolicy = { '+.website.example': ['9.9.9.9'] };
  const split = compileConfig(value), splitDns = split.config.dns as JsonObject;
  assert.deepEqual(splitDns['proxy-server-nameserver'], ['1.1.1.1']);
  assert.deepEqual(splitDns['proxy-server-nameserver-policy'], deployment.nodeNameserverPolicy);
  assert.deepEqual(splitDns['nameserver-policy'], deployment.nameserverPolicy);
  assert.equal(compileConfig({ ...value, deployment: { ...deployment, ...deploymentDnsOptions(split.config) } }).id, split.id);
  for (const policy of [{}, { '*.example.test': ['1.1.1.1'] }, { 'geosite:private': ['1.1.1.1'] },
    { 'node.example.test': [] }, { 'node.example.test': endpoint },
    ...['https:resolver.example/dns-query', 'https://@resolver.example/dns-query',
      'https://resolver.example:0/dns-query', endpoint + '?token=synthetic', endpoint + '#DIRECT']
      .map(resolver => ({ 'node.example.test': [resolver] }))] as JsonValue[]) {
    deployment.nodeNameserverPolicy = policy;
    fails(value, 'INVALID_INPUT');
  }
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
    'iptables', 'tuic-server', 'ss-config', 'vmess-config', 'ntp', 'external-doh-server', 'external-controller-routing-mark', 'clash-for-android', 'x-cocoproxy-host-proxy']) {
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

test('rejects protected core field aliases regardless of case, separators or duplicate spelling', () => {
  for (const key of ['interface_name', 'routing_mark', 'Private_Key', 'INTERFACE-NAME',
    'private-\u212aey', '\u017fcript', 'ssh_PRIVATE_\u212aEY', 'CA_FILE', 'options_FileName']) {
    for (const sourced of [false, true]) {
      const value = input();
      const proxy = { name: 'alias-node', type: 'socks5', server: '192.0.2.10', port: 1080,
        options: { [key]: 'SENSITIVE_NODE_CONTENT' } };
      if (sourced) value.sources = [{ id: 'snapshot', proxies: [proxy] }];
      else (value.policy as JsonObject).proxies = [proxy];
      fails(value, 'PROTECTED_FIELD');
    }
  }
  for (const key of ['mixed_port', 'ALLOW_LAN', 'External_Controller_Routing_Mark', '\u017fecret']) {
    const value = input();
    (value.policy as JsonObject)[key] = false;
    fails(value, 'PROTECTED_FIELD');
  }
  for (const keys of [['interface-name', 'Interface_Name'], ['Interface_Name', 'interface-name']]) {
    const value = input();
    const proxy = ((value.policy as JsonObject).proxies as JsonObject[])[0];
    for (const key of keys) proxy[key] = 'synthetic-interface';
    fails(value, 'PROTECTED_FIELD');
  }
});

test('preserves ordinary protocol field spellings while checking protected aliases', () => {
  const value = input();
  const proxy = ((value.policy as JsonObject).proxies as JsonObject[])[0];
  proxy['ws-opts'] = { Path: '/synthetic', headers: { 'X_Custom_Header': 'synthetic' } };
  proxy['TLS_Options'] = { 'Server_Name': 'node.example', 'skip-cert-verify': false };
  assert.deepEqual((compileConfig(value).config.proxies as JsonObject[])[0], proxy);
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
