import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { canonicalJson, compileConfig, type Candidate, type JsonObject } from '../packages/config/index.ts';
import { GatewayCandidateError, loadGatewayCandidate, validateGatewayCandidate } from '../packages/network/candidate.ts';
import { compileGatewayPreview, GATEWAY_CORE_SHA256 } from '../packages/network/config.ts';
import type { NetworkPlanInput } from '../packages/network/plan.ts';
import { loadRuntimeCandidate } from '../packages/runtime/settings.ts';
import type { RuntimeSettings } from '../packages/runtime/types.ts';
import { FileTransactionStore } from '../packages/transaction/index.ts';

function source() {
  return { schemaVersion: 1, base: { schemaVersion: 1,
    deployment: { mixedPort: 17890, controllerPort: 19090, controllerSecret: 'synthetic-controller-secret',
      dnsPort: 15353, bootstrapResolvers: ['192.0.2.53', '192.0.2.54'] },
    policy: { proxies: [{ name: 'synthetic-node', type: 'socks5', server: '192.0.2.80', port: 1080 }],
      'proxy-groups': [{ name: 'synthetic-choice', type: 'select', proxies: ['synthetic-node', 'source-node'] }],
      rules: ['DOMAIN,synthetic.invalid,synthetic-choice', 'MATCH,REJECT'] },
    sources: [{ id: 'synthetic-source', proxies: [{ name: 'source-node', type: 'http', server: '192.0.2.81', port: 8080 }] }] },
  network: { schemaVersion: 1, core: { serviceUid: 12345, binarySha256: GATEWAY_CORE_SHA256, unitSha256: 'c'.repeat(64) },
    ingressInterface: 'lan-test', gatewayIPv4: '192.0.2.2', prefixLength: 24, routerIPv4: '192.0.2.1',
    routerMAC: '02:00:00:00:00:01', clientIPv4: '192.0.2.3', dnsPort: 15353, tun: { interface: 'coproxy-tun', mtu: 1500 },
    marks: { mask: 0xff00, capture: 0x100, egress: 0x200, return: 0x300 },
    tables: { capture: 10003, egress: 10002, return: 10001 }, priorities: { capture: 10003, egress: 10002, return: 10001 } } };
}
function fixture() {
  const preview = compileGatewayPreview(source());
  return { candidate: preview.candidate, expected: preview.networkPlan.deployment };
}
function rehash(config: JsonObject): Candidate {
  const id = createHash('sha256').update(canonicalJson(config)).digest('hex');
  return { id, sha256: id, config };
}
const untrusted = (error: unknown) => error instanceof GatewayCandidateError &&
  error.message === 'GATEWAY_CANDIDATE_UNTRUSTED' && error.code === error.message && !('cause' in error);
function settings(root: string): RuntimeSettings {
  return { schemaVersion: 1, stateDirectory: root, binaryPath: '/opt/coproxy/bin/mihomo', binarySha256: GATEWAY_CORE_SHA256,
    systemctlPath: '/usr/bin/systemctl', unitPath: '/etc/systemd/system/coproxy-mihomo.service',
    unitSha256: 'c'.repeat(64), serviceUid: 12345 };
}

test('gateway validator recompiles complete nonempty policy, flattened source proxies and exact DNS', () => {
  const { candidate, expected } = fixture();
  const result = validateGatewayCandidate(candidate, expected);
  assert.deepEqual(result.candidate, candidate);
  assert.deepEqual(result.networkPlan.deployment, expected);
  assert.deepEqual(result.controller, { port: 19090, secret: 'synthetic-controller-secret' });
  assert.equal((result.candidate.config.proxies as unknown[]).length, 2);
  assert.deepEqual((result.candidate.config.dns as JsonObject)['default-nameserver'], ['192.0.2.53', '192.0.2.54']);
  assert.deepEqual((result.candidate.config.dns as JsonObject).nameserver, ['192.0.2.53', '192.0.2.54']);
  candidate.config.rules = [];
  expected.marks.egress = 0x400;
  assert.equal((result.candidate.config.rules as unknown[]).length, 2);
  assert.equal(result.networkPlan.deployment.marks.egress, 0x200);
});

test('hash-valid changes to every compiler-owned surface cannot authorize themselves', () => {
  const changes: Array<(config: JsonObject) => void> = [
    config => { config['allow-lan'] = true; },
    config => { config['bind-address'] = '*'; },
    config => { config['mixed-port'] = 80; },
    config => { config['external-controller'] = '0.0.0.0:19090'; },
    config => { config['external-controller-routing-mark'] = 0x200; },
    config => { config.ipv6 = true; },
    config => { config['interface-name'] = 'foreign-test'; },
    config => { config['routing-mark'] = 0x400; },
    config => { (config.dns as JsonObject).listen = '0.0.0.0:15353'; },
    config => { (config.dns as JsonObject).nameserver = ['192.0.2.90']; },
    config => { (config.dns as JsonObject)['enhanced-mode'] = 'fake-ip'; },
    config => { (config.dns as JsonObject)['listen-routing-mark'] = 0x400; },
    config => { (config.dns as JsonObject)['fake-ip-range'] = '198.19.0.1/30'; },
    config => { (config.dns as JsonObject)['nameserver-policy'] = { '+.invalid': '192.0.2.90' }; },
    config => { (config.tun as JsonObject)['auto-route'] = true; },
    config => { (config.tun as JsonObject)['dns-hijack'] = ['any:53']; },
    config => { (config.tun as JsonObject).mtu = 1400; },
    config => { (config.tun as JsonObject).stack = 'system'; },
    config => { ((config.proxies as JsonObject[])[0])['routing-mark'] = 0x200; },
  ];
  for (const change of changes) {
    const { candidate, expected } = fixture();
    change(candidate.config);
    const changed = rehash(candidate.config);
    assert.throws(() => validateGatewayCandidate(changed, { ...expected, generation: changed.id }), untrusted);
  }
});

test('network deployment and core identity must match the independent expected binding', () => {
  const { candidate, expected } = fixture();
  const changes: Array<(input: NetworkPlanInput) => void> = [
    input => { input.generation = 'a'.repeat(64); },
    input => { input.core.serviceUid++; },
    input => { input.core.unitSha256 = 'd'.repeat(64); },
    input => { input.core.binarySha256 = 'b'.repeat(64); },
    input => { input.routerMAC = '02:00:00:00:00:02'; },
    input => { input.tables.capture++; },
    input => { input.priorities.capture++; },
    input => { input.marks.capture = 0x400; },
    input => { input.clientIPv4 = '192.0.2.4'; },
  ];
  for (const change of changes) {
    const different = structuredClone(expected); change(different);
    assert.throws(() => validateGatewayCandidate(candidate, different), untrusted);
  }
  const metadata = candidate.config['x-coproxy-network'] as JsonObject;
  metadata.routerMAC = '02:00:00:00:00:02';
  const changed = rehash(candidate.config);
  assert.throws(() => validateGatewayCandidate(changed, { ...expected, generation: changed.id }), untrusted);
  const explicit = compileConfig(source().base);
  assert.throws(() => validateGatewayCandidate(explicit, { ...expected, generation: explicit.id }), untrusted);
});

test('candidate validation rejects forged envelopes, supplied previews, hooks and invalid hashes without executing code', () => {
  const { candidate, expected } = fixture();
  let invoked = false;
  const invalid: unknown[] = [null, [], { ...candidate, arbitrary: true }, { ...candidate, id: 'a'.repeat(64) },
    { ...candidate, sha256: 'b'.repeat(64) }, compileGatewayPreview(source()),
    new Proxy({}, { getPrototypeOf() { invoked = true; throw new Error('sensitive'); } }),
    Object.defineProperty({}, 'config', { enumerable: true, get() { invoked = true; return candidate.config; } })];
  for (const value of invalid) assert.throws(() => validateGatewayCandidate(value, expected), untrusted);
  assert.throws(() => validateGatewayCandidate(candidate, new Proxy(expected, {
    ownKeys() { invoked = true; throw new Error('sensitive'); },
  })), untrusted);
  assert.throws(() => validateGatewayCandidate(candidate, compileGatewayPreview(source()) as unknown as NetworkPlanInput), untrusted);
  assert.equal(invoked, false);
});

test('private loader binds immutable candidate, generation and runtime identity while explicit runtime still rejects gateway',
  { skip: process.platform !== 'linux' }, async t => {
    const root = await mkdtemp(join(tmpdir(), 'coproxy-gateway-candidate-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const { candidate, expected } = fixture();
    await new FileTransactionStore(root).stage(candidate);
    const runtime = settings(root), loaded = await loadGatewayCandidate(runtime, candidate.id, expected);
    assert.deepEqual(loaded.candidate, candidate);
    assert.equal(loaded.path, join(root, 'candidates', candidate.id + '.json'));
    assert.equal(Object.hasOwn(loaded, 'home'), false);
    await assert.rejects(loadRuntimeCandidate(runtime, candidate.id), error => error instanceof Error && error.message === 'CANDIDATE_UNTRUSTED');
    for (const runtimeChange of [{ serviceUid: 12346 }, { unitSha256: 'd'.repeat(64) }, { binarySha256: 'b'.repeat(64) }]) {
      await assert.rejects(loadGatewayCandidate({ ...runtime, ...runtimeChange }, candidate.id, expected), untrusted);
    }
    await assert.rejects(loadGatewayCandidate(runtime, 'a'.repeat(64), expected), untrusted);
    await assert.rejects(loadGatewayCandidate(runtime, '../private', expected), untrusted);
    const altered = structuredClone(candidate.config);
    (altered.dns as JsonObject).nameserver = ['192.0.2.90'];
    const alteredCandidate = rehash(altered);
    await new FileTransactionStore(root).stage(alteredCandidate);
    await assert.rejects(loadGatewayCandidate(runtime, alteredCandidate.id,
      { ...expected, generation: alteredCandidate.id }), untrusted);
    const explicit = compileConfig(source().base);
    await new FileTransactionStore(root).stage(explicit);
    await assert.rejects(loadGatewayCandidate(runtime, explicit.id,
      { ...expected, generation: explicit.id }), untrusted);
    const bytes = await readFile(loaded.path, 'utf8');
    const noncanonical = bytes + '\n';
    const noncanonicalId = createHash('sha256').update(noncanonical).digest('hex');
    await writeFile(join(root, 'candidates', noncanonicalId + '.json'), noncanonical, { mode: 0o600 });
    await assert.rejects(loadGatewayCandidate(runtime, noncanonicalId,
      { ...expected, generation: noncanonicalId }), untrusted);
    await writeFile(loaded.path, bytes + '\n', { mode: 0o600 });
    await assert.rejects(loadGatewayCandidate(runtime, candidate.id, expected), untrusted);
    await writeFile(loaded.path, bytes, { mode: 0o600 });
    await chmod(loaded.path, 0o644);
    await assert.rejects(loadGatewayCandidate(runtime, candidate.id, expected), untrusted);
    await chmod(loaded.path, 0o600);
    await chmod(join(root, 'candidates'), 0o755);
    await assert.rejects(loadGatewayCandidate(runtime, candidate.id, expected), untrusted);
    await chmod(join(root, 'candidates'), 0o700);
    const target = join(root, 'synthetic-candidate.json');
    await writeFile(target, bytes, { mode: 0o600 });
    await unlink(loaded.path); await symlink(target, loaded.path);
    await assert.rejects(loadGatewayCandidate(runtime, candidate.id, expected), untrusted);
  });

test('missing private store stays missing after loader rejection', { skip: process.platform !== 'linux' }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'coproxy-gateway-candidate-missing-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { candidate, expected } = fixture(), missing = join(root, 'absent');
  await assert.rejects(loadGatewayCandidate(settings(missing), candidate.id, expected), untrusted);
  await assert.rejects(readFile(join(missing, 'candidates', candidate.id + '.json')), { code: 'ENOENT' });
});
