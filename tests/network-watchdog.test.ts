import assert from 'node:assert/strict';
import { chmod, lstat, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { renderNetworkPlan, type NetworkPlan } from '../packages/network/plan.ts';
import { NetworkCoordinator, NetworkDriverError, type NetworkDriver, type NetworkIdentity } from '../packages/network/transaction.ts';
import { NetworkWatchdog, NetworkWatchdogError } from '../packages/network/watchdog.ts';

const plan = renderNetworkPlan({ schemaVersion: 1, generation: 'a'.repeat(64),
  core: { serviceUid: 12345, binarySha256: 'b'.repeat(64), unitSha256: 'c'.repeat(64) }, ingressInterface: 'lan-test',
  gatewayIPv4: '192.0.2.2', prefixLength: 24, routerIPv4: '192.0.2.1', routerMAC: '02:00:00:00:00:01',
  clientIPv4: '192.0.2.3', dnsPort: 15353, tun: { interface: 'coproxy-tun', mtu: 1500 },
  marks: { mask: 0xff00, capture: 0x100, egress: 0x200, return: 0x300 },
  tables: { capture: 10003, egress: 10002, return: 10001 }, priorities: { capture: 10003, egress: 10002, return: 10001 } });
const identity = (p: NetworkPlan): NetworkIdentity => ({ scope: 'fixture', generation: p.deployment.generation,
  planSha256: p.sha256, checkedAt: Date.now(), bootId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', corePid: 101,
  corePidStartTime: '12345', coreUnitControlGroup: '/system.slice/coproxy-mihomo.service', coreCgroupKernelId: '123456789',
  ...p.deployment.core, processAndUnitVerified: true, socketCgroupIsolationVerified: true });
const evidence = (p: NetworkPlan) => ({ identity: identity(p), checkedAt: Date.now(), checks: {
  dnsSocketsOwned: true as const, dnsUdpQuery: true as const, dnsTcpQuery: true as const, tunOwned: true as const,
  linkAndNeighbour: true as const, socketEgressMark: true as const, ownedResources: true as const } });
async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'coproxy-watchdog-')); await chmod(root, 0o700);
  const state = { failure: 'none' as 'none' | 'known' | 'unknown', verify: 0, guard: 0, activate: 0, pending: false };
  const driver: NetworkDriver = { scope: 'fixture', async preflight() {}, async settlePending() { state.pending = false; },
    async assertSettled() { if (state.pending) throw new NetworkDriverError(false); },
    async installBlockedGuard() { state.guard++; }, async prepareBlocked() {}, async ensureCore() {},
    async observeIdentity(p) { return identity(p); }, async authorizeCore() {}, async probe(p) { return evidence(p); },
    async activate() { state.activate++; }, async verifyActive(p) {
      state.verify++; if (state.failure === 'known') throw new NetworkDriverError(true);
      if (state.failure === 'unknown') { state.pending = true; throw new Error('private-error'); }
      return evidence(p);
    }, async retainBlockedResources() {},
  };
  const coordinator = new NetworkCoordinator(join(root, 'network'), driver), watchdog = new NetworkWatchdog(coordinator, 100);
  t.after(async () => { state.failure = 'none'; await watchdog.stop(); await rm(root, { recursive: true, force: true }); });
  return { root, coordinator, watchdog, state };
}
async function until(predicate: () => boolean): Promise<void> {
  const limit = Date.now() + 3000;
  while (!predicate()) { assert.ok(Date.now() < limit, 'watchdog did not reach expected state'); await delay(10); }
}
const linux = { skip: process.platform !== 'linux' };

test('watchdog starts with recovery, reports fresh checks, contains a live failure and never reactivates', linux, async t => {
  const f = await fixture(t);
  const check = f.coordinator.checkActive.bind(f.coordinator); let concurrent = 0, maximum = 0;
  f.coordinator.checkActive = async () => {
    maximum = Math.max(maximum, ++concurrent);
    try { await delay(150); return await check(); } finally { concurrent--; }
  };
  await f.watchdog.start();
  await assert.rejects(lstat(join(f.root, 'network')), { code: 'ENOENT' });
  await f.coordinator.apply(plan.deployment, 0);
  await until(() => f.watchdog.snapshot().observation?.localReady === true);
  assert.equal(f.watchdog.snapshot().status?.readiness, 'unknown');
  assert.equal(f.watchdog.snapshot().observation?.terminalPath, 'unverified');
  f.state.failure = 'known'; await until(() => f.watchdog.snapshot().status?.lastPhase === 'blocked');
  assert.equal(f.watchdog.snapshot().observation, null); assert.equal(f.watchdog.snapshot().error, 'NETWORK_HEALTH_FAILED');
  const activated = f.state.activate, verified = f.state.verify;
  await delay(220); assert.equal(f.state.activate, activated); assert.equal(f.state.verify, verified);
  assert.equal(maximum, 1, 'checks slower than the interval never overlap');
  assert.equal(Object.isFrozen(f.watchdog.snapshot().status), true);
});

test('watchdog keeps unknown commands fenced and graceful stop explicitly recovers only to blocking', linux, async t => {
  const f = await fixture(t); await f.watchdog.start(); await f.coordinator.apply(plan.deployment, 0);
  await until(() => f.watchdog.snapshot().observation !== null);
  const guards = f.state.guard; f.state.failure = 'unknown';
  await until(() => f.watchdog.snapshot().status?.unsettled === true);
  assert.equal(f.watchdog.snapshot().error, 'NETWORK_COMMAND_UNSETTLED'); assert.equal(f.state.guard, guards);
  await f.watchdog.stop();
  assert.equal(f.watchdog.snapshot().running, false); assert.equal(f.watchdog.snapshot().observation, null);
  assert.equal((await f.coordinator.status()).lastPhase, 'blocked'); assert.equal(f.state.activate, 1);
  const revision = (await f.coordinator.status()).revision; await f.watchdog.stop();
  assert.equal((await f.coordinator.status()).revision, revision, 'completed stop is idempotent');
});

test('watchdog rejects duplicate starts and stop failure cannot report successful shutdown', linux, async t => {
  const f = await fixture(t); await f.watchdog.start();
  await assert.rejects(f.watchdog.start(), error => error instanceof NetworkWatchdogError && error.code === 'NETWORK_WATCHDOG_BUSY');
  await f.coordinator.apply(plan.deployment, 0); await until(() => f.watchdog.snapshot().observation !== null);
  const original = f.coordinator.recover;
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
  f.coordinator.recover = async () => { entered(); await held; throw new Error('private-stop-failure'); };
  const stopped = f.watchdog.stop(); await started;
  assert.equal(f.watchdog.snapshot().observation, null, 'shutdown withdraws ready before containment finishes');
  release();
  await assert.rejects(stopped, error => error instanceof NetworkWatchdogError && error.code === 'NETWORK_WATCHDOG_STOP_FAILED' && !Object.hasOwn(error, 'cause'));
  assert.equal(f.watchdog.snapshot().observation, null); assert.equal(f.watchdog.snapshot().error, 'NETWORK_WATCHDOG_FAILED');
  await assert.rejects(f.watchdog.start(), error => error instanceof NetworkWatchdogError && error.code === 'NETWORK_WATCHDOG_BUSY');
  f.coordinator.recover = original; await f.watchdog.stop(); assert.equal((await f.coordinator.status()).lastPhase, 'blocked');
});
