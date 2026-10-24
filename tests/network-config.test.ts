import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { canonicalJson, compileConfig } from '../packages/config/index.ts';
import { compileGatewayPreview, GatewayConfigError, GATEWAY_CORE_SHA256 } from '../packages/network/config.ts';
import { FileTransactionStore } from '../packages/transaction/index.ts';
import { loadRuntimeCandidate } from '../packages/runtime/settings.ts';
import { validateWithMihomo } from '../packages/mihomo/validator.ts';

function input() {
  return { schemaVersion: 1, base: { schemaVersion: 1,
    deployment: { mixedPort: 17890, controllerPort: 19090, controllerSecret: 'synthetic-controller-secret', dnsPort: 15353, bootstrapResolvers: ['192.0.2.53'] },
    policy: { proxies: [], rules: ['MATCH,REJECT'] } },
  network: { schemaVersion: 1, core: { serviceUid: 12345, binarySha256: GATEWAY_CORE_SHA256, unitSha256: 'c'.repeat(64) },
    ingressInterface: 'lan-test', gatewayIPv4: '192.0.2.2', prefixLength: 24, routerIPv4: '192.0.2.1',
    routerMAC: '02:00:00:00:00:01', clientIPv4: '192.0.2.3', dnsPort: 15353, tun: { interface: 'coproxy-tun', mtu: 1500 },
    marks: { mask: 0xff00, capture: 0x100, egress: 0x200, return: 0x300 },
    tables: { capture: 10003, egress: 10002, return: 10001 }, priorities: { capture: 10003, egress: 10002, return: 10001 } } };
}

test('gateway preview binds complete network deployment to the canonical core generation without automatic network ownership', () => {
  const source = input(), preview = compileGatewayPreview(source);
  const config = preview.candidate.config;
  assert.equal(preview.candidate.id, createHash('sha256').update(canonicalJson(config)).digest('hex'));
  assert.equal(preview.networkPlan.deployment.generation, preview.candidate.id);
  assert.equal(config['routing-mark'], source.network.marks.egress);
  assert.equal(config['interface-name'], 'lan-test');
  assert.deepEqual(config.tun, { enable: true, device: 'coproxy-tun', stack: 'mips', mtu: 1500,
    'auto-route': false, 'auto-redirect': false, 'auto-detect-interface': false, gso: false, 'dns-hijack': [], 'disable-icmp-forwarding': true });
  assert.equal((config.dns as Record<string, unknown>).listen, '192.0.2.2:15353');
  assert.equal((config.dns as Record<string, unknown>)['listen-routing-mark'], source.network.marks.egress);
  assert.equal((config.dns as Record<string, unknown>)['enhanced-mode'], 'redir-host');
  assert.deepEqual(preview.expectedTun, { interface: 'coproxy-tun', address: '198.18.0.1/30', mtu: 1500 });
  assert.equal(preview.activation, 'unsupported-by-current-runtime');
  assert.equal(preview.networkPlan.status.terminalPath, 'unverified');
  source.network.routerMAC = '02:00:00:00:00:02';
  const changedMac = compileGatewayPreview(source).candidate.id;
  assert.notEqual(changedMac, preview.candidate.id);
  source.network.tables.capture++;
  assert.notEqual(compileGatewayPreview(source).candidate.id, changedMac);
  const separate = compileGatewayPreview({ ...input(), network: { ...input().network, management: { serviceUid: 12346 } } });
  assert.notEqual(separate.candidate.id, preview.candidate.id);
  assert.deepEqual(separate.networkPlan.deployment.management, { serviceUid: 12346 });
  assert.deepEqual((separate.candidate.config['x-coproxy-network'] as Record<string, unknown>).management, { serviceUid: 12346 });
  const explicit = compileConfig(input().base);
  assert.equal(explicit.config['x-coproxy-network'], undefined);
  assert.deepEqual(explicit.config.tun, { enable: false });
});

test('gateway preview rejects deployment mismatches, recursive policy injection and supplied execution hooks', () => {
  const invalid = (value: unknown) => assert.throws(() => compileGatewayPreview(value), (error: unknown) =>
    error instanceof GatewayConfigError && error.code === 'GATEWAY_CONFIG_INVALID' && error.message === error.code);
  const mismatch = input(); mismatch.network.dnsPort++;
  invalid(mismatch);
  const lowPort = input(); lowPort.base.deployment.mixedPort = 80; invalid(lowPort);
  const unreviewed = input(); unreviewed.network.core.binarySha256 = 'b'.repeat(64); invalid(unreviewed);
  for (const resolver of ['::1', '127.0.0.1', '169.254.0.1', '224.0.0.1', '192.0.2.2', '192.0.2.3']) {
    const value = input(); value.base.deployment.bootstrapResolvers = [resolver]; invalid(value);
  }
  const overlap = input(); Object.assign(overlap.network, { gatewayIPv4: '198.18.0.2', routerIPv4: '198.18.0.1', clientIPv4: '198.18.0.3' }); invalid(overlap);
  invalid({ ...input(), network: { ...input().network, generation: 'a'.repeat(64) } });
  for (const policy of [{ 'x-coproxy-network': {} }, { proxies: [{ name: 'node', type: 'vless', 'x-coproxy-network': {} }] }]) {
    invalid({ ...input(), base: { ...input().base, policy } });
  }
  let executed = false;
  invalid(new Proxy({}, { getPrototypeOf() { executed = true; throw new Error('secret'); } }));
  invalid({ ...input(), base: Object.defineProperty({}, 'policy', { enumerable: true, get() { executed = true; } }) });
  invalid({ ...input(), network: { ...input().network, core: new Proxy({}, { ownKeys() { executed = true; return []; } }) } });
  assert.equal(executed, false);
});

test('explicit runtime rejects a hash-valid gateway preview before it can gain network capability',
  { skip: process.platform !== 'linux' }, async t => {
    const root = await mkdtemp(join(tmpdir(), 'coproxy-gateway-profile-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const preview = compileGatewayPreview(input());
    await new FileTransactionStore(root).stage(preview.candidate);
    await assert.rejects(loadRuntimeCandidate({ schemaVersion: 1, stateDirectory: root,
      binaryPath: '/opt/coproxy/bin/mihomo', binarySha256: GATEWAY_CORE_SHA256, systemctlPath: '/usr/bin/systemctl',
      unitPath: '/etc/systemd/system/coproxy-mihomo.service', unitSha256: 'c'.repeat(64), serviceUid: 12345 }, preview.candidate.id),
    (error: unknown) => error instanceof Error && error.message === 'CANDIDATE_UNTRUSTED');
  });

test('reviewed core parses the protected gateway preview without starting TUN or listeners',
  { skip: !process.env.COPROXY_TEST_MIHOMO, timeout: 20_000 }, async () => {
    const binaryPath = process.env.COPROXY_TEST_MIHOMO!;
    const review = JSON.parse(await readFile(new URL('../integrations/metacubexd/review.json', import.meta.url), 'utf8'));
    assert.equal(GATEWAY_CORE_SHA256, review.coreCandidate.binarySha256);
    assert.equal(createHash('sha256').update(await readFile(binaryPath)).digest('hex'), GATEWAY_CORE_SHA256);
    await validateWithMihomo(compileGatewayPreview({ ...input(), network: { ...input().network,
      management: { serviceUid: 12346 } } }).candidate, { binaryPath });
  });
