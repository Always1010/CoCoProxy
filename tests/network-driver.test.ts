import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { GatewayNetworkDriver, type GatewayDriverFixtureDependencies, type GatewayDriverSettings,
  type GatewayResourceSession } from '../packages/network/driver.ts';
import { GATEWAY_CORE_SHA256 } from '../packages/network/config.ts';
import { renderNetworkPlan, type NetworkPlan } from '../packages/network/plan.ts';
import { renderGatewayRuntimePlan } from '../packages/network/runtime-plan.ts';
import { NetworkDriverError, NetworkTransactionError, type NetworkIdentity } from '../packages/network/transaction.ts';

function configuration(parent = '/var/lib/coproxy-fixture'): GatewayDriverSettings {
  const core = renderGatewayRuntimePlan({ schemaVersion: 1, stateDirectory: parent + '/core-state', coreHome: parent + '/home',
    binaryPath: '/opt/coproxy/bin/mihomo', binarySha256: GATEWAY_CORE_SHA256, systemctlPath: '/usr/bin/systemctl',
    unitPath: '/etc/systemd/system/coproxy-mihomo.service', serviceUid: 12345 });
  return { authorityDirectory: parent + '/network', resourceDirectory: parent + '/resources',
    core: { runtime: core.settings, coreHome: core.coreHome }, tools: { ipBinary: '/usr/sbin/ip', nftBinary: '/usr/sbin/nft' },
    host: { ipBinary: '/usr/sbin/ip', tcBinary: '/usr/sbin/tc', iptablesLegacySaveBinary: '/usr/sbin/iptables-legacy-save',
      ip6tablesLegacySaveBinary: '/usr/sbin/ip6tables-legacy-save' },
    probe: { ipBinary: '/usr/sbin/ip', queryDomain: 'probe.example.com', expectedIPv4: '198.51.100.80' },
    link: { ipBinary: '/usr/sbin/ip', probeIPv4: '198.51.100.80' } };
}
function plan(settings: GatewayDriverSettings, generation = 'a'.repeat(64)): NetworkPlan {
  return renderNetworkPlan({ schemaVersion: 1, generation,
    core: { serviceUid: 12345, binarySha256: GATEWAY_CORE_SHA256, unitSha256: settings.core.runtime.unitSha256 },
    management: { serviceUid: 12346 }, ingressInterface: 'lan-test', gatewayIPv4: '192.0.2.2', prefixLength: 24,
    routerIPv4: '192.0.2.1', routerMAC: '02:00:00:00:00:01', clientIPv4: '192.0.2.3', dnsPort: 15353,
    tun: { interface: 'coproxy-tun', mtu: 1500 }, marks: { mask: 0xff00, capture: 0x100, egress: 0x200, return: 0x300 },
    tables: { capture: 10003, egress: 10002, return: 10001 }, priorities: { capture: 10003, egress: 10002, return: 10001 } });
}
function identity(p: NetworkPlan): NetworkIdentity {
  return { scope: 'fixture', generation: p.deployment.generation, planSha256: p.sha256, checkedAt: Date.now(),
    bootId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', corePid: 101, corePidStartTime: '12345',
    coreUnitControlGroup: '/system.slice/coproxy-mihomo.service', coreCgroupKernelId: '9007199254740999',
    ...p.deployment.core, processAndUnitVerified: true, socketCgroupIsolationVerified: true,
    management: { pid: 202, pidStartTime: '23456', serviceUid: 12346, unitControlGroup: '/system.slice/coproxy-management.service',
      cgroupKernelId: '9007199254741000' } };
}
function fixture(settings = configuration()) {
  const calls: string[] = [];
  const model = { initialized: false, bound: plan(settings), mode: null as 'blocked' | 'core-only' | 'active' | null,
    capture: false, hostVerified: true, hostSettled: true, hostScope: 'fixture' as 'fixture' | 'production',
    managementStart: '23456', changedIdentity: false, failActivation: false, activeEvidence: true,
    candidateAvailable: true, pending: false, fence: undefined as undefined | (() => Promise<void>) };
  const mutation = async (name: string) => { calls.push(name); await model.fence?.(); };
  const session: GatewayResourceSession = {
    scope: 'fixture', get plan() { return model.bound; },
    async inspect() {
      calls.push('inspect'); return { scope: 'fixture', generation: model.bound.deployment.generation, planSha256: model.bound.sha256,
        mode: model.mode, terminalPath: 'unverified', sha256: 'd'.repeat(64), nftSha256: 'e'.repeat(64), nftIdentitySha256: 'f'.repeat(64),
        rulesPresent: [], routesPresent: model.capture ? ['capture'] : [] };
    },
    async recoverBlocked() { await mutation('recover-blocked'); model.mode = 'blocked'; model.capture = false; },
    async installBlocked() { await mutation('blocked'); model.mode = 'blocked'; },
    async retainBlocked() { await mutation('retain'); assert.equal(model.mode, 'blocked'); model.capture = false; },
    async prepare() { await mutation('prepare'); assert.equal(model.mode, 'blocked'); assert.equal(model.capture, false); },
    async rebind(input) { await mutation('rebind'); assert.equal(model.mode, 'blocked'); assert.equal(model.capture, false); model.bound = renderNetworkPlan(input); },
    async authorizeCore() { await mutation('authorize'); assert.equal(model.mode, 'blocked'); model.mode = 'core-only'; },
    async activate() { await mutation('activate'); assert.equal(model.mode, 'core-only');
      if (model.failActivation) throw new Error('private failure'); model.mode = 'active'; model.capture = true; },
  };
  const deps: GatewayDriverFixtureDependencies = {
    core: {
      async preflight() { calls.push('candidate'); if (!model.candidateAvailable) throw new NetworkDriverError(true); },
      async preflightSettlement() { calls.push('core-preflight-settle'); },
      async settlePending() { await mutation('core-settle'); model.pending = false; },
      async assertSettled() { calls.push('core-settled'); if (model.pending) throw new NetworkDriverError(false); },
      async ensure(_, blocked) { await blocked(); await mutation('ensure-core'); },
      async recoverStopped(blocked) { await blocked(); await mutation('stop-core'); },
    },
    async preflight(p, purpose) {
      calls.push('preflight:' + purpose);
      return { scope: 'fixture', generation: p.deployment.generation, planSha256: p.sha256, initialized: model.initialized,
        recoveryRequired: model.initialized, pending: false, revision: 0,
        binding: !model.initialized ? 'absent' : model.bound.sha256 === p.sha256 ? 'current' : 'previous-generation', terminalPath: 'unverified' };
    },
    async settle() { await mutation('native-settle'); }, async settled() { calls.push('native-settled'); },
    async open() { await mutation('open'); model.initialized = true; return session; },
    async host(p) {
      calls.push('host'); return { scope: model.hostScope, generation: p.deployment.generation, planSha256: p.sha256,
        verified: model.hostVerified, commandsSettled: model.hostSettled, checkedAt: Date.now(), reason: null,
        checks: { platform: true, trustedViews: true, sysctls: true, bypassAbsent: true, stable: true } };
    },
    async management() { calls.push('management'); return { scope: 'fixture', verified: true, commandsSettled: true,
      checkedAt: Date.now(), reason: null, facts: { managementPid: 202, managementPidStartTime: model.managementStart,
        managementUid: 12346, bootId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        managementUnitControlGroup: '/system.slice/coproxy-management.service' } }; },
    async identity(p, observer) { calls.push('identity'); assert.equal(observer.managementPid, 202);
      const value = identity(p); if (model.changedIdentity) value.corePid++; return value; },
    async evidence(p, observer, expected, options) { calls.push('evidence:' + options.mode); assert.equal(observer.managementPid, 202);
      assert.equal(model.mode, options.mode); assert.equal(expected.generation, p.deployment.generation);
      if (options.mode === 'active' && !model.activeEvidence) throw new NetworkDriverError(true);
      return { identity: identity(p), checkedAt: Date.now(), checks: { dnsSocketsOwned: true, dnsUdpQuery: true,
        dnsTcpQuery: true, tunOwned: true, linkAndNeighbour: true, socketEgressMark: true, ownedResources: true } }; },
  };
  return { settings, model, calls, deps, session, driver: GatewayNetworkDriver.fixture(settings, deps) };
}
const failed = (settled: boolean) => (error: unknown) => error instanceof NetworkDriverError &&
  error.childSettled === settled && error.message === 'NETWORK_DRIVER_FAILED' && !Object.hasOwn(error, 'cause');

test('driver composes blocked, core-only and active with fresh fixed management and runtime evidence', async () => {
  const f = fixture(), p = plan(f.settings);
  await f.driver.preflight(p, 'apply'); assert.equal(f.calls.includes('open'), false);
  await f.driver.installBlockedGuard(p); await f.driver.prepareBlocked(p); await f.driver.ensureCore(p);
  const bound = await f.driver.observeIdentity(p); await f.driver.authorizeCore(p, bound);
  const evidence = await f.driver.probe(p, bound); await f.driver.activate(p, evidence); await f.driver.verifyActive(p, evidence);
  assert.equal(f.model.mode, 'active'); assert.equal(f.model.capture, true);
  assert.ok(f.calls.indexOf('blocked') < f.calls.indexOf('ensure-core'));
  assert.ok(f.calls.indexOf('identity') < f.calls.indexOf('authorize'));
  assert.equal(f.calls.filter(value => value === 'evidence:core-only').length, 2);
  assert.equal(f.calls.filter(value => value === 'evidence:active').length, 1);
});

test('recovery converges trusted operations and blocks without requiring candidate or host readiness', async () => {
  const f = fixture(), p = plan(f.settings);
  f.model.initialized = true; f.model.mode = 'active'; f.model.capture = true;
  f.model.candidateAvailable = false; f.model.hostVerified = false; f.model.pending = true;
  await f.driver.preflight(p, 'settle'); await f.driver.settlePending(p); await f.driver.assertSettled(p);
  await f.driver.preflight(p, 'recover'); await f.driver.installBlockedGuard(p); await f.driver.retainBlockedResources(p);
  assert.equal(f.model.mode, 'blocked'); assert.equal(f.model.capture, false);
  assert.ok(f.calls.indexOf('native-settle') < f.calls.indexOf('core-settle'));
  assert.ok(f.calls.indexOf('recover-blocked') < f.calls.indexOf('stop-core'));
  assert.equal(f.calls.includes('host'), false); assert.equal(f.calls.includes('candidate'), false);
  assert.equal(f.calls.includes('ensure-core'), false);
});

test('generation changes retain blocking and remove capture before explicit rebind', async () => {
  const f = fixture(), p = plan(f.settings), next = plan(f.settings, 'b'.repeat(64));
  f.model.initialized = true; f.model.mode = 'active'; f.model.capture = true;
  await f.driver.installBlockedGuard(next);
  assert.equal(f.model.bound.sha256, next.sha256);
  assert.ok(f.calls.indexOf('recover-blocked') < f.calls.indexOf('rebind'));
  f.model.mode = 'active'; f.model.capture = true; f.calls.length = 0;
  await f.driver.installBlockedGuard(p);
  assert.equal(f.model.bound.sha256, p.sha256);
  assert.ok(f.calls.indexOf('blocked') < f.calls.indexOf('retain') && f.calls.indexOf('retain') < f.calls.indexOf('rebind'));
  const changed = renderNetworkPlan({ ...p.deployment, clientIPv4: '192.0.2.4' });
  const before = [...f.calls]; await assert.rejects(f.driver.installBlockedGuard(changed), failed(true));
  assert.deepEqual(f.calls, before);
});

test('unverified host or mixed evidence never authorizes core or activates clients', async () => {
  for (const change of ['hostVerified', 'hostSettled', 'hostScope'] as const) {
    const f = fixture(), p = plan(f.settings);
    if (change === 'hostScope') f.model.hostScope = 'production'; else f.model[change] = false;
    await assert.rejects(f.driver.preflight(p, 'apply'), failed(change !== 'hostSettled'));
    assert.equal(f.calls.includes('open'), false);
  }
  const f = fixture(), p = plan(f.settings);
  await f.driver.installBlockedGuard(p); await f.driver.prepareBlocked(p);
  const expected = await f.driver.observeIdentity(p);
  f.model.managementStart = '99999'; await assert.rejects(f.driver.authorizeCore(p, expected), failed(true));
  assert.equal(f.calls.includes('authorize'), false);
});

test('factory isolates scopes, rejects overlapping stores and never invokes hostile getters', () => {
  const f = fixture(); let invoked = false;
  const hostile = { ...f.settings }; Object.defineProperty(hostile, 'tools', { enumerable: true, get() { invoked = true; return f.settings.tools; } });
  assert.throws(() => GatewayNetworkDriver.fixture(hostile, f.deps), failed(true)); assert.equal(invoked, false);
  assert.throws(() => GatewayNetworkDriver.fixture({ ...f.settings, resourceDirectory: f.settings.authorityDirectory + '/nested' }, f.deps), failed(true));
  assert.throws(() => GatewayNetworkDriver.fixture(f.settings, { ...f.deps, backend: 'production' } as never), failed(true));
  if (process.platform !== 'linux' || process.geteuid?.() !== 0) assert.throws(() => GatewayNetworkDriver.production(f.settings), failed(true));
  assert.equal(f.driver.scope, 'fixture'); assert.equal(Object.isFrozen(f.driver.settings.core.runtime), true);
});

test('actual coordinator persists mutation fences, rejects unsafe retry and explicitly recovers composed driver',
  { skip: process.platform !== 'linux' }, async t => {
    const parent = await mkdtemp(join(tmpdir(), 'coproxy-driver-')); await chmod(parent, 0o700);
    t.after(() => rm(parent, { recursive: true, force: true }));
    const f = fixture(configuration(parent)), p = plan(f.settings), coordinator = f.driver.coordinator();
    f.model.fence = async () => {
      const state = JSON.parse(await readFile(join(f.settings.authorityDirectory, 'network-state.json'), 'utf8'));
      assert.equal(state.unsettled, true);
    };
    const first = await coordinator.apply(p.deployment, 0); assert.equal(first.status.lastPhase, 'ready');
    f.model.failActivation = true;
    await assert.rejects(coordinator.apply(p.deployment, first.status.revision),
      error => error instanceof NetworkTransactionError && error.code === 'NETWORK_COMMAND_UNSETTLED');
    assert.equal((await coordinator.status()).unsettled, true);
    const before = [...f.calls];
    await assert.rejects(coordinator.apply(p.deployment, (await coordinator.status()).revision),
      error => error instanceof NetworkTransactionError && error.code === 'NETWORK_RECOVERY_REQUIRED');
    assert.deepEqual(f.calls, before);
    f.model.failActivation = false; f.model.candidateAvailable = false;
    const recovered = await coordinator.recover(); assert.equal(recovered.lastPhase, 'blocked');
    assert.equal(recovered.unsettled, false); assert.equal(f.model.mode, 'blocked'); assert.equal(f.model.capture, false);
    f.model.candidateAvailable = true; f.model.activeEvidence = false;
    await assert.rejects(coordinator.apply(p.deployment, recovered.revision),
      error => error instanceof NetworkTransactionError && error.code === 'NETWORK_APPLY_FAILED');
    const contained = await coordinator.status(); assert.equal(contained.lastPhase, 'blocked');
    assert.equal(contained.unsettled, false); assert.equal(f.model.mode, 'blocked'); assert.equal(f.model.capture, false);
  });
