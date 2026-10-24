import assert from 'node:assert/strict';
import test from 'node:test';
import { GATEWAY_CORE_SHA256 } from '../packages/network/config.ts';
import { observeGatewayEvidenceFixture, observeGatewayIdentityFixture, type GatewayObserverFixture } from '../packages/network/observer.ts';
import { renderNetworkPlan } from '../packages/network/plan.ts';
import { renderGatewayRuntimePlan } from '../packages/network/runtime-plan.ts';
import { NetworkDriverError } from '../packages/network/transaction.ts';
import { NativeNetworkError } from '../packages/network/native.ts';
import { NetworkReadbackError } from '../packages/network/readback.ts';
import { NetworkCommandError } from '../packages/network/command.ts';

const runtime = renderGatewayRuntimePlan({ schemaVersion: 1, stateDirectory: '/var/lib/coproxy-observer-fixture',
  coreHome: '/var/lib/coproxy-observer-home', binaryPath: '/opt/coproxy/bin/mihomo', binarySha256: GATEWAY_CORE_SHA256,
  systemctlPath: '/usr/bin/systemctl', unitPath: '/etc/systemd/system/coproxy-mihomo.service', serviceUid: 12345 });
const plan = renderNetworkPlan({ schemaVersion: 1, generation: 'a'.repeat(64),
  core: { serviceUid: 12345, binarySha256: GATEWAY_CORE_SHA256, unitSha256: runtime.settings.unitSha256 }, management: { serviceUid: 12346 },
  ingressInterface: 'lan-test', gatewayIPv4: '192.0.2.2', prefixLength: 24, routerIPv4: '192.0.2.1',
  routerMAC: '02:00:00:00:00:01', clientIPv4: '192.0.2.3', dnsPort: 15353,
  tun: { interface: 'coproxy-tun', mtu: 1500 }, marks: { mask: 0xff00, capture: 0x100, egress: 0x200, return: 0x300 },
  tables: { capture: 10003, egress: 10002, return: 10001 }, priorities: { capture: 10003, egress: 10002, return: 10001 } });
const settings = { core: { runtime: runtime.settings, coreHome: runtime.coreHome }, managementPid: 202 };
const bootId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const options = { mode: 'core-only' as const, probe: { queryDomain: 'probe.invalid', expectedIPv4: '198.51.100.77', ipBinary: '/usr/sbin/ip' as const },
  link: { ipBinary: '/usr/sbin/ip' as const, probeIPv4: '203.0.113.80' } };
function fixture() {
  const state = { now: 1_000_000, managementStart: '23456', corePid: 101, commandsSettled: true };
  const calls: string[] = [];
  const stamp = () => ({ scope: 'fixture' as const, verified: true, checkedAt: state.now, reason: null });
  const reader: GatewayObserverFixture = {
    async core() { calls.push('core'); return { ...stamp(), commandsSettled: state.commandsSettled, terminalPath: 'unverified',
      facts: { generation: plan.deployment.generation, planSha256: plan.sha256, bootId, corePid: state.corePid,
        corePidStartTime: '12345', coreUnitControlGroup: '/system.slice/coproxy-mihomo.service', ...plan.deployment.core } }; },
    async cgroup(request) {
      calls.push('cgroup'); assert.equal(request.managementUid, 12346);
      return { ...stamp(), identity: { bootId, corePid: state.corePid, corePidStartTime: '12345',
        coreUnitControlGroup: '/system.slice/coproxy-mihomo.service', coreCgroupKernelId: '9007199254740999',
        managementPid: 202, managementPidStartTime: state.managementStart,
        managementUnitControlGroup: '/system.slice/coproxy-management.service', managementCgroupKernelId: '9007199254741000' } };
    },
    async sockets(_, binding, stage) {
      calls.push('sockets:' + stage.stage); assert.equal(binding.management.uid, 12346);
      return { ...stamp(), commandsSettled: true, stage: stage.stage, generation: plan.deployment.generation, planSha256: plan.sha256,
        checks: { dnsListenerSources: true, coreSocketSources: true, egressSocketMarks: true, managementExcluded: true, upstreamObserved: stage.stage === 'ready' },
        counts: { core: 4, management: 1, upstream: stage.stage === 'ready' ? 1 : 0 } };
    },
    async probe() { calls.push('probe'); return { ...stamp(), commandsSettled: true, terminalPath: 'unverified',
      checks: { dnsSocketsOwned: true, dnsUdpQuery: true, dnsTcpQuery: true, tunOwned: true } }; },
    async link() { calls.push('link'); return { ...stamp(), commandsSettled: true, generation: plan.deployment.generation, planSha256: plan.sha256,
      checks: { interfaceIdentity: true, carrier: true, gatewayAddress: true, mtu: true, routerNeighbour: true, egressRoute: true, stable: true } }; },
    async resources() { calls.push('resources'); return { scope: 'fixture', generation: plan.deployment.generation, planSha256: plan.sha256, mode: 'core-only' }; },
    now: () => state.now,
  };
  return { state, calls, reader, identity: () => observeGatewayIdentityFixture(plan, settings, reader) };
}
const rejected = (settled: boolean) => (error: unknown) => error instanceof NetworkDriverError &&
  error.childSettled === settled && error.message === 'NETWORK_DRIVER_FAILED' && !Object.hasOwn(error, 'cause');

test('live observation composition binds both service identities and requires every local evidence source', async () => {
  const f = fixture(), identity = await f.identity();
  assert.equal(identity.scope, 'fixture'); assert.equal(identity.management?.serviceUid, 12346);
  assert.equal(identity.management?.cgroupKernelId, '9007199254741000'); assert.ok(Object.isFrozen(identity.management));
  assert.deepEqual(f.calls, ['core', 'cgroup', 'sockets:identity', 'core', 'cgroup']);
  const evidence = await observeGatewayEvidenceFixture(plan, settings, identity, options, f.reader);
  assert.ok(Object.values(evidence.checks).every(Boolean)); assert.ok(Object.isFrozen(evidence));
  assert.deepEqual(evidence.identity, identity);
  assert.deepEqual(f.calls.slice(5), ['core', 'cgroup', 'sockets:identity', 'core', 'cgroup', 'probe', 'link',
    'sockets:ready', 'resources', 'core', 'cgroup', 'sockets:identity', 'core', 'cgroup']);
});

test('identity composition rejects mismatched scope, generation, management restart and incomplete socket proof', async () => {
  for (const kind of ['scope', 'generation', 'management', 'socket', 'legacy'] as const) {
    const f = fixture();
    if (kind === 'scope' || kind === 'generation') {
      const core = f.reader.core; f.reader.core = async (...args) => {
        const result = await core(...args);
        if (kind === 'scope') result.scope = 'production'; else result.facts!.generation = 'b'.repeat(64);
        return result;
      };
    }
    if (kind === 'management') { const sockets = f.reader.sockets; f.reader.sockets = async (...args) => {
      const result = await sockets(...args); f.state.managementStart = '34567'; return result;
    }; }
    if (kind === 'socket') { const sockets = f.reader.sockets; f.reader.sockets = async (...args) => {
      const result = await sockets(...args); result.checks.managementExcluded = false; return result;
    }; }
    const target = kind === 'legacy' ? renderNetworkPlan(Object.fromEntries(Object.entries(plan.deployment).filter(([key]) => key !== 'management'))) : plan;
    await assert.rejects(observeGatewayIdentityFixture(target, settings, f.reader), rejected(true), kind);
  }
});

test('evidence cannot combine old identity with changed services, failed probes, wrong resources or stale observation time', async () => {
  for (const kind of ['restart', 'dns', 'mark', 'route', 'resources', 'stale'] as const) {
    const f = fixture(), identity = await f.identity();
    if (kind === 'restart') f.state.managementStart = '34567';
    if (kind === 'dns') { const probe = f.reader.probe; f.reader.probe = async (...args) => {
      const result = await probe(...args); result.checks.dnsTcpQuery = false; return result;
    }; }
    if (kind === 'mark') { const sockets = f.reader.sockets; f.reader.sockets = async (...args) => {
      const result = await sockets(...args); if (args[2].stage === 'ready') result.checks.upstreamObserved = false; return result;
    }; }
    if (kind === 'route') { const link = f.reader.link; f.reader.link = async (...args) => {
      const result = await link(...args); result.planSha256 = 'b'.repeat(64); return result;
    }; }
    if (kind === 'resources') f.reader.resources = async () => ({ scope: 'fixture', generation: plan.deployment.generation, planSha256: plan.sha256, mode: 'active' });
    if (kind === 'stale') { const link = f.reader.link; f.reader.link = async (...args) => {
      const result = await link(...args); f.state.now += 30_001; return result;
    }; }
    await assert.rejects(observeGatewayEvidenceFixture(plan, settings, identity, options, f.reader), rejected(true), kind);
  }
});

test('unsettled observers and unknown reader failures retain the driver fence', async () => {
  const f = fixture(); f.state.commandsSettled = false;
  await assert.rejects(f.identity(), rejected(false)); assert.deepEqual(f.calls, ['core']);
  const g = fixture(), identity = await g.identity();
  const link = g.reader.link; g.reader.link = async (...args) => ({ ...await link(...args), verified: false, commandsSettled: false });
  await assert.rejects(observeGatewayEvidenceFixture(plan, settings, identity, options, g.reader), rejected(false));
  assert.equal(g.calls.includes('resources'), false);
  const h = fixture(); h.reader.core = async () => { throw new Error('synthetic-private-error'); };
  await assert.rejects(h.identity(), rejected(false));
  const missing = fixture(), core = missing.reader.core;
  missing.reader.core = async (...args) => {
    const result = await core(...args); delete (result as Partial<typeof result>).commandsSettled; return result;
  };
  await assert.rejects(missing.identity(), rejected(false));
  for (const [error, settled] of [[new NetworkReadbackError(), true],
    [new NativeNetworkError('NETWORK_RESOURCE_MEMBERSHIP_CHANGED'), true],
    [new NativeNetworkError('NETWORK_SESSION_UNAVAILABLE'), false],
    [new NetworkCommandError('NETWORK_COMMAND_FAILED', false), false],
    [new Error('private-resource-error'), false]] as const) {
    const f = fixture(), expected = await f.identity();
    f.reader.resources = async () => { throw error; };
    await assert.rejects(observeGatewayEvidenceFixture(plan, settings, expected, options, f.reader), rejected(settled));
  }
});
