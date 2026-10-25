import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { canonicalJson, compileConfig, type JsonObject } from '../packages/config/index.ts';
import { AUTOMATIC_GATEWAY_CORE_SHA256, AUTOMATIC_GATEWAY_CORE_SHA256_BY_PLATFORM, AutomaticGatewayConfigError, automaticGatewayManagesIPv4, automaticGatewayPolicy,
  compileAutomaticGatewayConfig, parseAutomaticGatewaySettings, recompileAutomaticGatewayConfig } from '../packages/gateway/profile.ts';
import { validateWithMihomo } from '../packages/mihomo/validator.ts';
import { loadRuntimeCandidate, parseRuntimeSettings } from '../packages/runtime/settings.ts';
import { FileTransactionStore } from '../packages/transaction/index.ts';

function base(): JsonObject {
  return { schemaVersion: 1, deployment: { mixedPort: 17890, controllerPort: 19090,
    controllerSecret: 'synthetic-controller-secret', dnsPort: 15353, bootstrapResolvers: ['192.0.2.53'] },
  policy: { proxies: [{ name: 'manual', type: 'socks5', server: '192.0.2.10', port: 1080 }],
    'proxy-groups': [{ name: 'select', type: 'select', proxies: ['manual', 'REJECT'] }], rules: ['MATCH,select'] } };
}
function settings() {
  return { schemaVersion: 1, ingressInterface: 'lan-test', gatewayIPv4: '192.0.2.2', routerIPv4: '192.0.2.1',
    routerMAC: '02:00:00:00:00:01', clientIPv4: '192.0.2.3', prefixLength: 24, dnsPort: 15353,
    egressMark: 0x200, egressTable: 10002, egressPriority: 8000, tunMtu: 1500 };
}

test('routed HTTPS DNS survives native candidate recompilation and preserves legacy generations', () => {
  const original = compileAutomaticGatewayConfig(base(), settings());
  assert.deepEqual(recompileAutomaticGatewayConfig(original.config, settings()), original);
  const source = base();
  (source.deployment as JsonObject).nameservers = ['https://192.0.2.54/dns-query'];
  (source.deployment as JsonObject).sniffing = true;
  const encrypted = compileAutomaticGatewayConfig(source, settings());
  assert.notEqual(encrypted.id, original.id);
  assert.deepEqual(recompileAutomaticGatewayConfig(encrypted.config, settings()), encrypted);
  assert.equal((encrypted.config.dns as JsonObject)['respect-rules'], true);
  assert.equal((encrypted.config.sniffer as JsonObject)['parse-pure-ip'], true);
  Object.assign(source.deployment as JsonObject, { nameserverPolicy: { '+.example.com': ['198.51.100.53'] },
    nodeResolvers: ['https://node-resolver.example/dns-query'], directResolvers: ['198.51.100.54'] });
  const split = compileAutomaticGatewayConfig(source, settings());
  assert.deepEqual(recompileAutomaticGatewayConfig(split.config, settings()), split);
  for (const field of ['nodeResolvers', 'directResolvers']) {
    for (const resolver of ['192.0.2.2', 'https://192.0.2.3/dns-query', '127.0.0.1', '::1']) {
      const unsafe = structuredClone(source);
      (unsafe.deployment as JsonObject)[field] = [resolver];
      assert.throws(() => compileAutomaticGatewayConfig(unsafe, settings()), AutomaticGatewayConfigError);
    }
  }
});

test('node resolver policies survive gateway reconstruction and reject intercepted DNS endpoints', () => {
  const source = base(), deployment = source.deployment as JsonObject;
  const endpoint = 'https://resolver.example:5443/synthetic-private-token/dns-query';
  deployment.nodeNameserverPolicy = { 'node.example.test': [endpoint] };
  const candidate = compileAutomaticGatewayConfig(source, settings()), dns = candidate.config.dns as JsonObject;
  assert.deepEqual(dns['proxy-server-nameserver-policy'], deployment.nodeNameserverPolicy);
  assert.deepEqual(dns['proxy-server-nameserver'], ['192.0.2.53']);
  assert.deepEqual(recompileAutomaticGatewayConfig(candidate.config, settings()), candidate);
  assert.equal(dns['respect-rules'], undefined);
  for (const resolver of ['192.0.2.2', 'https://192.0.2.3/dns-query',
    'HTTPS://192.0.2.3:5443/synthetic-private-token/dns-query', '127.0.0.1', 'https://127.0.0.1/dns-query', '::1']) {
    deployment.nodeNameserverPolicy = { 'node.example.test': [resolver] };
    assert.throws(() => compileAutomaticGatewayConfig(source, settings()), (error: unknown) => {
      assert.ok(error instanceof AutomaticGatewayConfigError);
      assert.equal(error.message, error.code);
      assert.ok(!JSON.stringify(error).includes('synthetic-private-token'));
      return true;
    });
  }
  // CIDR mode intercepts every ordinary LAN client, not just one designated host.
  const subnet = { ...settings(), clientCIDR: '192.0.2.0/24' } as Record<string, unknown>;
  delete subnet.clientIPv4;
  deployment.nodeNameserverPolicy = { 'node.example.test': ['https://192.0.2.99/dns-query'] };
  assert.throws(() => compileAutomaticGatewayConfig(source, subnet), AutomaticGatewayConfigError);
});
const invalid = (run: () => unknown) => assert.throws(run, (error: unknown) =>
  error instanceof AutomaticGatewayConfigError && error.code === 'AUTOMATIC_GATEWAY_CONFIG_INVALID' && error.message === error.code);

test('native profile binds policy and all normalized deployment inputs to a canonical generation', () => {
  const source = base(), supplied = settings(), before = JSON.stringify([source, supplied]);
  const candidate = compileAutomaticGatewayConfig(source, supplied), config = candidate.config;
  assert.equal(candidate.id, candidate.sha256);
  assert.equal(candidate.id, createHash('sha256').update(canonicalJson(config)).digest('hex'));
  assert.equal(JSON.stringify([source, supplied]), before);
  assert.equal(config['allow-lan'], false);
  assert.equal(config['bind-address'], '127.0.0.1');
  assert.equal(config['external-controller'], '127.0.0.1:19090');
  assert.equal(config['routing-mark'], supplied.egressMark);
  assert.equal(config['interface-name'], supplied.ingressInterface);
  assert.deepEqual(config.tun, { enable: true, device: 'cocoproxy-tun', stack: 'mips', mtu: 1500,
    'auto-route': true, 'auto-redirect': true, 'auto-detect-interface': false, 'strict-route': true,
    'include-interface': ['lan-test'], 'route-exclude-address': ['192.0.2.0/24'],
    'exclude-uid-range': ['0:4294967294'],
    'iproute2-table-index': 2022, 'iproute2-rule-index': 9000, 'auto-redirect-input-mark': 2023,
    'auto-redirect-output-mark': 2024, 'dns-mode': 'disabled', 'dns-hijack': [], gso: false, 'disable-icmp-forwarding': true });
  assert.deepEqual(config.dns, { enable: true, listen: '192.0.2.2:15353', 'enhanced-mode': 'redir-host', ipv6: false,
    'default-nameserver': ['192.0.2.53'], nameserver: ['192.0.2.53'], 'listen-routing-mark': 0x200, 'fake-ip-range': '198.18.0.1/30' });
  assert.deepEqual(config['x-cocoproxy-gateway'], supplied);
  assert.deepEqual(compileConfig(source).config.tun, { enable: false });
  for (const change of [{ routerMAC: '02:00:00:00:00:02' }, { routerIPv4: '192.0.2.4' }, { clientIPv4: '192.0.2.5' },
    { egressTable: 10003 }, { egressPriority: 8001 }, { egressMark: 0x201 }, { tunMtu: 1400 }]) {
    assert.notEqual(compileAutomaticGatewayConfig(source, { ...supplied, ...change }).id, candidate.id);
  }
  const normalized = compileAutomaticGatewayConfig(source, { ...supplied, routerMAC: '02:AA:BB:CC:DD:01' });
  assert.equal(normalized.id, compileAutomaticGatewayConfig(source, { ...supplied, routerMAC: '02:aa:bb:cc:dd:01' }).id);
});

test('performance and selective sniffing survive trusted gateway recompilation', () => {
  const source = base();
  Object.assign(source.deployment as JsonObject, { performance: { tcpConcurrent: true, findProcessMode: 'off' },
    sniffing: { mode: 'missing-only', skipDomains: ['+.example.com'], skipPorts: ['8080-8880'] } });
  const candidate = compileAutomaticGatewayConfig(source, settings());
  assert.deepEqual(recompileAutomaticGatewayConfig(candidate.config, settings()), candidate);
  for (const processMode of ['off', 'strict', 'always', 'legacy-value']) {
    const legacy = base();
    Object.assign(legacy.policy as JsonObject, { 'find-process-mode': processMode, 'tcp-concurrent': 'legacy-value', rules: ['PROCESS-NAME,example,DIRECT', 'MATCH,REJECT'] });
    const previous = compileAutomaticGatewayConfig(legacy, settings());
    assert.deepEqual(recompileAutomaticGatewayConfig(previous.config, settings()), previous);
  }
});

test('trusted TUN tuning validates bounded values and preserves settings across recompilation', () => {
  const original = compileAutomaticGatewayConfig(base(), settings());
  assert.equal((original.config.tun as JsonObject).stack, 'mips');
  assert.equal((original.config.tun as JsonObject).gso, false);
  assert.equal((original.config['x-cocoproxy-gateway'] as JsonObject).tunStack, undefined);
  for (const tunStack of ['mips', 'system', 'mixed', 'gvisor']) {
    for (const tunGso of [false, true]) {
      const tuned = { ...settings(), tunStack, tunGso, tunMtu: 1400 };
      const candidate = compileAutomaticGatewayConfig(base(), tuned);
      assert.equal((candidate.config.tun as JsonObject).stack, tunStack);
      assert.equal((candidate.config.tun as JsonObject).gso, tunGso);
      assert.equal((candidate.config.tun as JsonObject).mtu, 1400);
      assert.deepEqual(candidate.config['x-cocoproxy-gateway'], tuned);
      assert.deepEqual(recompileAutomaticGatewayConfig(candidate.config, tuned), candidate);
      const changed = structuredClone(candidate.config); (changed.tun as JsonObject).stack = 'untrusted';
      assert.equal(recompileAutomaticGatewayConfig(changed, tuned).id, candidate.id);
    }
  }
  for (const change of [{ tunStack: 'auto' }, { tunStack: 'SYSTEM' }, { tunStack: null },
    { tunGso: 'true' }, { tunGso: 1 }, { tunMtu: 1279 }, { tunMtu: 9001 }]) {
    invalid(() => parseAutomaticGatewaySettings({ ...settings(), ...change }));
  }
});

test('network settings reject malformed, overlapping, reserved and non-host values', () => {
  for (const change of [
    { schemaVersion: 2 }, { generation: 'a'.repeat(64) }, { command: '/synthetic' },
    { ingressInterface: 'lo' }, { ingressInterface: 'cocoproxy-tun' }, { ingressInterface: 'eth0;command' },
    { ingressInterface: 'interface-is-too-long' }, { gatewayIPv4: '127.0.0.2' }, { routerIPv4: '224.0.0.1' },
    { clientIPv4: '169.254.1.2' }, { gatewayIPv4: '192.0.2.0' }, { clientIPv4: '192.0.2.255' },
    { routerIPv4: '192.0.3.1' }, { clientIPv4: '192.0.2.2' }, { prefixLength: 0 }, { prefixLength: 30 },
    { gatewayIPv4: '198.18.0.2', routerIPv4: '198.18.0.1', clientIPv4: '198.18.0.3' },
    { routerMAC: '01:00:00:00:00:01' }, { routerMAC: '00:00:00:00:00:00' }, { routerMAC: '02-00-00-00-00-01' },
    { dnsPort: 53 }, { dnsPort: 65536 }, { tunMtu: 1279 }, { tunMtu: 9001 }, { tunMtu: 1500.5 },
    { egressMark: 0 }, { egressMark: 0x100000000 }, { egressMark: 2023 }, { egressMark: 2024 },
    { egressTable: 1999 }, { egressTable: 20000 }, { egressTable: 2022 },
    { egressPriority: 999 }, { egressPriority: 8998 }, { egressPriority: 9000 },
  ]) invalid(() => parseAutomaticGatewaySettings({ ...settings(), ...change }));
  for (const key of Object.keys(settings())) {
    const missing: Record<string, unknown> = { ...settings() }; delete missing[key];
    invalid(() => parseAutomaticGatewaySettings(missing));
  }
  assert.equal(parseAutomaticGatewaySettings({ ...settings(), egressMark: 0xffffffff }).egressMark, 0xffffffff);
});

test('profile preserves compiler policy and snapshot protection and enforces DNS deployment consistency', () => {
  for (const key of ['x-cocoproxy-gateway', 'tun', 'dns', 'interface-name', 'routing-mark']) {
    const source = base(); (source.policy as JsonObject)[key] = false;
    invalid(() => compileAutomaticGatewayConfig(source, settings()));
  }
  for (const key of ['x-cocoproxy-gateway', 'tun', 'interface-name', 'routing-mark']) {
    const nested = base(); nested.sources = [{ id: 'source', proxies: [{ name: 'injected', type: 'socks5', options: { [key]: false } }] }];
    invalid(() => compileAutomaticGatewayConfig(nested, settings()));
  }
  invalid(() => compileAutomaticGatewayConfig(base(), { ...settings(), dnsPort: 15354 }));
  for (const resolver of ['::1', '127.0.0.1', '0.0.0.0', '169.254.0.1', '224.0.0.1', '192.0.2.2', '192.0.2.3']) {
    const source = base(); (source.deployment as JsonObject).bootstrapResolvers = [resolver];
    invalid(() => compileAutomaticGatewayConfig(source, settings()));
  }
  const source = base(); source.sources = [{ id: 'snapshot', proxies: [{ name: 'source', type: 'socks5', server: '198.51.100.10', port: 1080 }] }];
  assert.equal((compileAutomaticGatewayConfig(source, settings()).config.proxies as unknown[]).length, 2);
});

test('descriptor-only input rejects supplied code without invoking it', () => {
  let invoked = false;
  const proxy = new Proxy({}, { getPrototypeOf() { invoked = true; throw new Error('secret'); } });
  const getter = Object.defineProperty({ ...settings() }, 'dnsPort', { enumerable: true, get() { invoked = true; return 15353; } });
  for (const value of [proxy, getter, { ...settings(), tunMtu: () => 1500 }, { ...settings(), extra: new Date() },
    Object.defineProperty({ ...settings() }, 'hidden', { value: true }), { ...settings(), [Symbol('hidden')]: true }]) {
    invalid(() => parseAutomaticGatewaySettings(value));
  }
  invalid(() => compileAutomaticGatewayConfig(proxy, settings()));
  invalid(() => compileAutomaticGatewayConfig(Object.defineProperty(base(), 'policy', { enumerable: true, get() { invoked = true; return {}; } }), settings()));
  assert.equal(invoked, false);
});

test('trusted recompile derives overlay from deployment and requires generation equality to authenticate stored bytes', () => {
  const source = base(), candidate = compileAutomaticGatewayConfig(source, settings());
  assert.equal(recompileAutomaticGatewayConfig(candidate.config, settings()).id, candidate.id);
  assert.deepEqual(automaticGatewayPolicy(candidate.config), { ...(source.policy as JsonObject), mode: 'rule' });
  const changed = structuredClone(candidate.config);
  (changed['x-cocoproxy-gateway'] as JsonObject).routerMAC = '02:00:00:00:00:02';
  (changed.tun as JsonObject)['auto-route'] = false;
  const tamperedId = createHash('sha256').update(canonicalJson(changed)).digest('hex');
  assert.notEqual(recompileAutomaticGatewayConfig(changed, settings()).id, tamperedId);
  assert.notEqual(recompileAutomaticGatewayConfig(candidate.config, { ...settings(), routerMAC: '02:00:00:00:00:02' }).id, candidate.id);
  changed['external-controller'] = '0.0.0.0:19090';
  invalid(() => recompileAutomaticGatewayConfig(changed, settings()));
});

test('native runtime pins exactly the platform review catalog without trusting deployment-supplied hashes', async () => {
  const review = JSON.parse(await readFile(new URL('../integrations/metacubexd/review.json', import.meta.url), 'utf8'));
  assert.deepEqual(AUTOMATIC_GATEWAY_CORE_SHA256_BY_PLATFORM,
    Object.fromEntries(Object.entries(review.coreCandidate.platforms).map(([key, value]) => [key, (value as { binarySha256: string }).binarySha256])));
  const runtime = { schemaVersion: 1, stateDirectory: '/var/lib/synthetic-proxy', binaryPath: '/opt/synthetic-proxy/bin/mihomo',
    systemctlPath: '/usr/bin/systemctl', unitPath: '/etc/systemd/system/cocoproxy-mihomo.service',
    unitSha256: 'c'.repeat(64), serviceUid: 12345, automaticGateway: settings() };
  for (const binarySha256 of Object.values(AUTOMATIC_GATEWAY_CORE_SHA256_BY_PLATFORM)) {
    assert.equal(parseRuntimeSettings({ ...runtime, binarySha256 }).binarySha256, binarySha256);
  }
  assert.throws(() => parseRuntimeSettings({ ...runtime, binarySha256: 'a'.repeat(64) }), /INVALID_RUNTIME_SETTINGS/);
});

test('runtime accepts native candidates only with matching explicit deployment opt-in', { skip: process.platform !== 'linux' }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'cocoproxy-native-profile-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const candidate = compileAutomaticGatewayConfig(base(), settings());
  await new FileTransactionStore(root).stage(candidate);
  const runtime = { schemaVersion: 1 as const, stateDirectory: root,
    binaryPath: '/opt/cocoproxy/bin/mihomo', binarySha256: AUTOMATIC_GATEWAY_CORE_SHA256, systemctlPath: '/usr/bin/systemctl',
    unitPath: '/etc/systemd/system/cocoproxy-mihomo.service', unitSha256: 'c'.repeat(64), serviceUid: 12345 };
  await assert.rejects(loadRuntimeCandidate(runtime, candidate.id),
  (error: unknown) => error instanceof Error && error.message === 'CANDIDATE_UNTRUSTED');
  assert.equal((await loadRuntimeCandidate({ ...runtime, automaticGateway: parseAutomaticGatewaySettings(settings()) }, candidate.id)).candidate.id, candidate.id);
  await assert.rejects(loadRuntimeCandidate({ ...runtime, automaticGateway: parseAutomaticGatewaySettings({ ...settings(), clientIPv4: '192.0.2.4' }) }, candidate.id),
    (error: unknown) => error instanceof Error && error.message === 'CANDIDATE_UNTRUSTED');
});

test('pinned reviewed core parses native profile without starting listeners or TUN',
  { skip: !process.env.COCOPROXY_TEST_MIHOMO, timeout: 20_000 }, async () => {
    const binaryPath = process.env.COCOPROXY_TEST_MIHOMO!;
    const review = JSON.parse(await readFile(new URL('../integrations/metacubexd/review.json', import.meta.url), 'utf8'));
    assert.equal(AUTOMATIC_GATEWAY_CORE_SHA256, review.coreCandidate.binarySha256);
    assert.equal(createHash('sha256').update(await readFile(binaryPath)).digest('hex'), AUTOMATIC_GATEWAY_CORE_SHA256);
    await validateWithMihomo(compileAutomaticGatewayConfig(base(), settings()), { binaryPath });
    const source = base();
    Object.assign(source.deployment as JsonObject, { nameservers: ['https://192.0.2.54/dns-query'], sniffing: true,
      nodeNameserverPolicy: { 'node.example.test': ['https://resolver.example:5443/synthetic-private-token/dns-query'] } });
    await validateWithMihomo(compileAutomaticGatewayConfig(source, settings()), { binaryPath });
  });


test('LAN scope covers changing ordinary clients, binds the generation, and excludes control identities', async () => {
  const { clientIPv4: _, ...common } = settings();
  const lan = { ...common, clientCIDR: '192.0.2.0/24' };
  const parsed = parseAutomaticGatewaySettings(lan);
  assert.deepEqual(parsed, lan);
  for (const address of ['192.0.2.3', '192.0.2.99', '192.0.2.254']) assert.equal(automaticGatewayManagesIPv4(parsed, address), true);
  for (const address of ['192.0.2.0', '192.0.2.1', '192.0.2.2', '192.0.2.255', '192.0.3.3']) assert.equal(automaticGatewayManagesIPv4(parsed, address), false);
  for (const clientCIDR of ['192.0.2.3/24', '192.0.2.0/25', '192.0.3.0/24', '0.0.0.0/0', '::/0']) {
    invalid(() => parseAutomaticGatewaySettings({ ...lan, clientCIDR }));
  }
  invalid(() => parseAutomaticGatewaySettings({ ...lan, clientIPv4: '192.0.2.3' }));
  const source = base(); (source.deployment as JsonObject).bootstrapResolvers = ['198.51.100.2'];
  const candidate = compileAutomaticGatewayConfig(source, lan);
  assert.equal(recompileAutomaticGatewayConfig(candidate.config, lan).id, candidate.id);
  assert.notEqual(compileAutomaticGatewayConfig(source, settings()).id, candidate.id);
  (source.deployment as JsonObject).bootstrapResolvers = ['192.0.2.99'];
  invalid(() => compileAutomaticGatewayConfig(source, lan));
  const example = JSON.parse(await readFile(new URL('../examples/automatic-gateway-deployment.json', import.meta.url), 'utf8'));
  const exampleCandidate = compileAutomaticGatewayConfig({ schemaVersion: 1, deployment: example.management.deployment,
    policy: { rules: ['MATCH,REJECT'] } }, example.runtime.automaticGateway);
  assert.equal(recompileAutomaticGatewayConfig(exampleCandidate.config, example.runtime.automaticGateway).id, exampleCandidate.id);
});
