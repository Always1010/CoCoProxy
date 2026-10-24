import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, lstat, mkdtemp, readFile, rm, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { NetworkCommandError } from '../packages/network/command.ts';
import { renderNetworkPlan, type NetworkPlan, type NetworkPlanInput } from '../packages/network/plan.ts';
import { NetworkCoordinator, NetworkDriverError, NetworkTransactionError } from '../packages/network/transaction.ts';
import type { NetworkDriver, NetworkEvidence, NetworkIdentity } from '../packages/network/transaction.ts';

function input(): NetworkPlanInput {
  return { schemaVersion: 1, generation: 'a'.repeat(64),
    core: { serviceUid: 12345, binarySha256: 'b'.repeat(64), unitSha256: 'c'.repeat(64) },
    ingressInterface: 'lan-test', gatewayIPv4: '192.0.2.2', prefixLength: 24, routerIPv4: '192.0.2.1',
    routerMAC: '02:00:00:00:00:01', clientIPv4: '192.0.2.3', dnsPort: 15353,
    tun: { interface: 'coproxy-tun', mtu: 1500 }, marks: { mask: 0xff00, capture: 0x100, egress: 0x200, return: 0x300 },
    tables: { capture: 10003, egress: 10002, return: 10001 }, priorities: { capture: 10003, egress: 10002, return: 10001 } };
}
function identity(plan: NetworkPlan, now: number): NetworkIdentity {
  return { scope: 'fixture', generation: plan.deployment.generation, planSha256: plan.sha256, checkedAt: now,
    bootId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', corePid: 101, corePidStartTime: '12345',
    coreUnitControlGroup: '/system.slice/coproxy-mihomo.service', coreCgroupKernelId: '9007199254740999',
    ...plan.deployment.core, processAndUnitVerified: true, socketCgroupIsolationVerified: true,
    ...(plan.deployment.management ? { management: { pid: 202, pidStartTime: '23456',
      serviceUid: plan.deployment.management.serviceUid, unitControlGroup: '/system.slice/coproxy-management.service' as const,
      cgroupKernelId: '9007199254741000' } } : {}) };
}
function evidence(bound: NetworkIdentity, now: number): NetworkEvidence {
  return { identity: { ...bound, checkedAt: now }, checkedAt: now, checks: { dnsSocketsOwned: true,
    dnsUdpQuery: true, dnsTcpQuery: true, tunOwned: true, linkAndNeighbour: true, socketEgressMark: true, ownedResources: true } };
}
const reject = (code: string) => (error: unknown) => error instanceof NetworkTransactionError && error.code === code && error.message === code;

async function fixture() {
  const parent = await mkdtemp(join(tmpdir(), 'coproxy-network-transaction-'));
  await chmod(parent, 0o700);
  const root = join(parent, 'network'), calls: string[] = [];
  let now = Date.now();
  let verifyFence = true;
  const mutation = async (name: string) => {
    calls.push(name);
    if (verifyFence) {
      const state = JSON.parse(await readFile(join(root, 'network-state.json'), 'utf8'));
      assert.equal(state.unsettled, true, 'durable in-flight fence precedes every mutation');
      assert.equal(state.deployment.generation.length, 64);
    }
  };
  const driver: NetworkDriver = {
    scope: 'fixture',
    async preflight(_, purpose) { calls.push('preflight:' + purpose); },
    async settlePending() { await mutation('settle');
      const state = JSON.parse(await readFile(join(root, 'network-state.json'), 'utf8'));
      assert.equal(state.phase, 'settling');
      assert.equal((await lstat(join(root, '.lock'))).isDirectory(), true);
    },
    async assertSettled() { calls.push('settled'); },
    async installBlockedGuard() { await mutation('guard'); },
    async prepareBlocked() { await mutation('prepare'); },
    async ensureCore() { await mutation('core'); },
    async observeIdentity(plan) { calls.push('identity'); return identity(plan, now); },
    async authorizeCore() { await mutation('authorize'); },
    async probe(_, bound) { calls.push('probe'); return evidence(bound, now); },
    async activate() { await mutation('activate'); },
    async verifyActive(_, proof) { calls.push('verify'); return evidence(proof.identity, now); },
    async retainBlockedResources() { await mutation('retain'); },
  };
  const coordinator = () => new NetworkCoordinator(root, driver, () => now);
  return { parent, root, calls, driver, coordinator, clock: { get now() { return now; }, set now(value: number) { now = value; } },
    disableFenceAssertion() { verifyFence = false; }, async close() { await chmod(root, 0o700).catch(() => {}); await rm(parent, { recursive: true, force: true }); } };
}

test('durable intent and per-mutation fences precede ordered activation; status never reuses readiness', async () => {
  const f = await fixture();
  try {
    const manager = f.coordinator();
    assert.equal((await manager.recover()).desiredEnabled, false);
    await assert.rejects(lstat(f.root), { code: 'ENOENT' });
    const result = await manager.apply(input(), 0);
    assert.deepEqual(f.calls, ['preflight:apply', 'guard', 'prepare', 'core', 'identity', 'authorize', 'probe', 'identity', 'activate', 'verify']);
    assert.equal(result.observation.localReady, true);
    assert.equal(result.observation.scope, 'fixture');
    assert.equal(result.observation.terminalPath, 'unverified');
    assert.equal(result.status.readiness, 'unknown');
    assert.equal((await manager.status()).lastPhase, 'ready');
    if (process.platform !== 'win32') assert.equal((await lstat(join(f.root, 'network-state.json'))).mode & 0o777, 0o600);
    const next = input(); next.generation = 'd'.repeat(64);
    await assert.rejects(manager.apply(next, 0), reject('NETWORK_REVISION_CONFLICT'));
    await manager.apply(next, result.status.revision);
    const persisted = await f.coordinator().status();
    assert.equal(persisted.desiredGeneration, next.generation);
    assert.equal(persisted.readiness, 'unknown');
    const newInstance = f.coordinator(), before = f.calls.length;
    await assert.rejects(newInstance.apply(next, persisted.revision), reject('NETWORK_RECOVERY_REQUIRED'));
    assert.equal(f.calls.length, before);
    const recovered = await newInstance.recover();
    assert.deepEqual(f.calls.slice(before), ['preflight:settle', 'settle', 'settled', 'preflight:recover', 'guard', 'retain']);
    assert.equal(recovered.lastPhase, 'blocked');
    assert.equal(recovered.desiredEnabled, true);
    assert.equal(recovered.fault, 'NETWORK_RECOVERY_REQUIRED');
    await newInstance.apply(next, recovered.revision);
  } finally { await f.close(); }
});

test('read-only preflight failures preserve state and enabled protection scope cannot silently change', async () => {
  const f = await fixture();
  try {
    const normal = f.driver.preflight;
    f.driver.preflight = async () => { throw new NetworkDriverError(true); };
    await assert.rejects(f.coordinator().apply(input(), 0), reject('NETWORK_PREFLIGHT_FAILED'));
    await assert.rejects(lstat(join(f.root, 'network-state.json')), { code: 'ENOENT' });
    f.driver.preflight = normal;
    const manager = f.coordinator(), applied = await manager.apply(input(), 0), before = f.calls.length;
    for (const change of [(value: NetworkPlanInput) => { value.clientIPv4 = '192.0.2.4'; },
      (value: NetworkPlanInput) => { value.core.serviceUid++; },
      (value: NetworkPlanInput) => { value.marks.egress = 0x400; }]) {
      const value = input(); change(value);
      await assert.rejects(manager.apply(value, applied.status.revision), reject('NETWORK_PROTECTION_CHANGE_UNSUPPORTED'));
    }
    assert.equal(f.calls.length, before);
    assert.equal((await manager.status()).revision, applied.status.revision);
  } finally { await f.close(); }
});

test('independent management identity is required, remains bound through activation and cannot change protection domain', async () => {
  const f = await fixture();
  try {
    const plan = { ...input(), management: { serviceUid: 12346 } }, manager = f.coordinator();
    const applied = await manager.apply(plan, 0);
    assert.equal(applied.observation.localReady, true);
    const before = f.calls.length;
    await assert.rejects(manager.apply({ ...plan, management: { serviceUid: 12347 } }, applied.status.revision), reject('NETWORK_PROTECTION_CHANGE_UNSUPPORTED'));
    await assert.rejects(manager.apply(input(), applied.status.revision), reject('NETWORK_PROTECTION_CHANGE_UNSUPPORTED'));
    assert.equal(f.calls.length, before);
  } finally { await f.close(); }
  for (const kind of ['missing', 'uid', 'pid', 'start', 'cgroup', 'unit', 'restarted'] as const) {
    const f = await fixture();
    try {
      f.driver.probe = async (_, bound) => {
        const proof = evidence(bound, f.clock.now), management = { ...bound.management! };
        if (kind === 'uid') management.serviceUid++;
        if (kind === 'pid') management.pid = bound.corePid;
        if (kind === 'start') management.pidStartTime = '0';
        if (kind === 'cgroup') management.cgroupKernelId = bound.coreCgroupKernelId;
        if (kind === 'unit') management.unitControlGroup = '/system.slice/other.service' as typeof management.unitControlGroup;
        if (kind === 'restarted') { management.pid++; management.pidStartTime = '34567'; }
        if (kind === 'missing') delete proof.identity.management;
        else proof.identity.management = management;
        return proof;
      };
      await assert.rejects(f.coordinator().apply({ ...input(), management: { serviceUid: 12346 } }, 0), reject('NETWORK_APPLY_FAILED'), kind);
      assert.equal(f.calls.includes('activate'), false, kind);
      assert.deepEqual(f.calls.slice(-2), ['guard', 'retain'], kind);
    } finally { await f.close(); }
  }
});

test('production apply cannot use a legacy plan without an independent management identity', async () => {
  const f = await fixture();
  try {
    const manager = new NetworkCoordinator(f.root, { ...f.driver, scope: 'production' });
    await assert.rejects(manager.apply(input(), 0), reject('NETWORK_INPUT_INVALID'));
    assert.deepEqual(f.calls, []);
    await assert.rejects(lstat(f.root), { code: 'ENOENT' });
  } finally { await f.close(); }
});

test('stale, future, changed, incomplete and hostile proofs never activate and trigger guard before route containment', async () => {
  for (const kind of ['stale', 'future', 'changed', 'missing', 'scope', 'accessor', 'proxy', 'clock'] as const) {
    const f = await fixture();
    try {
      let invoked = false;
      f.driver.probe = async (_, bound) => {
        f.calls.push('probe');
        const proof = evidence(bound, f.clock.now);
        if (kind === 'stale') proof.checkedAt -= 30_001;
        if (kind === 'future') proof.checkedAt++;
        if (kind === 'changed') proof.identity.coreCgroupKernelId = '888';
        if (kind === 'missing') delete (proof.checks as Partial<NetworkEvidence['checks']>).dnsTcpQuery;
        if (kind === 'scope') proof.identity.scope = 'production';
        if (kind === 'accessor') Object.defineProperty(proof, 'checks', { enumerable: true, get() { invoked = true; return {}; } });
        if (kind === 'proxy') return new Proxy(proof, { ownKeys() { invoked = true; throw new Error('private'); } });
        if (kind === 'clock') f.clock.now += 30_001;
        return proof;
      };
      const manager = f.coordinator();
      await assert.rejects(manager.apply(input(), 0), reject('NETWORK_APPLY_FAILED'), kind);
      assert.equal(invoked, false);
      assert.equal(f.calls.includes('activate'), false, kind);
      assert.deepEqual(f.calls.slice(-2), ['guard', 'retain'], kind);
      assert.equal((await manager.status()).lastPhase, 'blocked');
    } finally { await f.close(); }
  }
});

test('a new PID between proof and activation, or failed post-activation verification, retains enabled blocking', async () => {
  for (const failure of ['identity', 'verify'] as const) {
    const f = await fixture();
    try {
      let reads = 0;
      if (failure === 'identity') f.driver.observeIdentity = async plan => {
        f.calls.push('identity'); const bound = identity(plan, f.clock.now); if (++reads === 2) bound.corePid++; return bound;
      };
      else f.driver.verifyActive = async (_, proof) => {
        f.calls.push('verify'); return { ...evidence(proof.identity, f.clock.now), checkedAt: f.clock.now + 1 };
      };
      const manager = f.coordinator();
      await assert.rejects(manager.apply(input(), 0), reject('NETWORK_APPLY_FAILED'));
      assert.equal(f.calls.includes('activate'), failure === 'verify');
      assert.deepEqual(f.calls.slice(-2), ['guard', 'retain']);
      assert.equal((await manager.status()).desiredEnabled, true);
    } finally { await f.close(); }
  }
});

test('unknown or unsettled driver failures fence recovery; no parallel blocking mutation is issued', async () => {
  for (const failure of ['mutation', 'readonly', 'unknown'] as const) {
    const f = await fixture();
    try {
      if (failure === 'readonly') f.driver.probe = async () => {
        f.calls.push('probe'); throw new NetworkCommandError('NETWORK_COMMAND_UNSETTLED', false);
      };
      else f.driver.activate = async () => {
        f.calls.push('activate'); if (failure === 'unknown') throw new Error('private source'); throw new NetworkDriverError(false);
      };
      const manager = f.coordinator();
      await assert.rejects(manager.apply(input(), 0), reject('NETWORK_COMMAND_UNSETTLED'));
      assert.equal(f.calls.filter(name => name === 'guard').length, 1);
      assert.equal((await manager.status()).unsettled, true);
      assert.equal((await manager.status()).lastPhase, 'fault');
      const before = f.calls.length;
      f.driver.assertSettled = async () => { f.calls.push('settled'); throw new NetworkDriverError(false); };
      await assert.rejects(manager.recover(), reject('NETWORK_COMMAND_UNSETTLED'));
      assert.deepEqual(f.calls.slice(before), ['preflight:settle', 'settle', 'settled']);
      f.driver.assertSettled = async () => { f.calls.push('settled'); };
      const recovered = await manager.recover();
      assert.deepEqual(f.calls.slice(-6), ['preflight:settle', 'settle', 'settled', 'preflight:recover', 'guard', 'retain']);
      assert.equal(recovered.lastPhase, 'blocked');
      assert.equal(recovered.unsettled, false);
    } finally { await f.close(); }
  }
});

test('explicit recovery converges bound pending work under a durable fence even after saved ready', async () => {
  const f = await fixture();
  try {
    await f.coordinator().apply(input(), 0);
    const saved = JSON.parse(await readFile(join(f.root, 'network-state.json'), 'utf8'));
    assert.equal(saved.unsettled, false);
    let pending = true;
    const settle = f.driver.settlePending, preflight = f.driver.preflight;
    f.driver.preflight = async (plan, purpose) => {
      await preflight(plan, purpose);
      if (purpose === 'recover') assert.equal(pending, false);
    };
    f.driver.settlePending = async plan => {
      assert.equal(plan.sha256, renderNetworkPlan(input()).sha256);
      await settle(plan);
      await assert.rejects(f.coordinator().recover(), reject('NETWORK_BUSY'));
      pending = false;
    };
    f.driver.assertSettled = async () => {
      f.calls.push('settled');
      assert.equal(pending, false);
      const state = JSON.parse(await readFile(join(f.root, 'network-state.json'), 'utf8'));
      assert.equal(state.phase, 'settling');
      assert.equal(state.unsettled, true, 'settle success alone never clears the durable fence');
    };
    const before = f.calls.length, result = await f.coordinator().recover();
    assert.deepEqual(f.calls.slice(before), ['preflight:settle', 'settle', 'settled', 'preflight:recover', 'guard', 'retain']);
    assert.equal(result.lastPhase, 'blocked');
    assert.equal(result.unsettled, false);
    assert.equal(result.fault, 'NETWORK_RECOVERY_REQUIRED');
  } finally { await f.close(); }
});

test('recovery never proceeds to another mutation after failed provenance, convergence or settlement proof', async () => {
  for (const failure of ['provenance', 'settle-known', 'settle-unknown', 'proof', 'preflight-known', 'preflight-unknown'] as const) {
    const f = await fixture();
    try {
      await f.coordinator().apply(input(), 0);
      const before = f.calls.length;
      const preflight = f.driver.preflight;
      f.driver.preflight = async (plan, purpose) => {
        await preflight(plan, purpose);
        if (failure === 'provenance' && purpose === 'settle') throw new NetworkDriverError(true);
        if (failure.startsWith('preflight-') && purpose === 'recover') {
          if (failure === 'preflight-unknown') throw new Error('private preflight failure');
          throw new NetworkDriverError(true);
        }
      };
      if (failure.startsWith('settle-')) {
        const settle = f.driver.settlePending;
        f.driver.settlePending = async plan => {
          await settle(plan);
          if (failure === 'settle-unknown') throw new Error('private convergence failure');
          throw new NetworkDriverError(true);
        };
      }
      if (failure === 'proof') f.driver.assertSettled = async () => {
        f.calls.push('settled'); throw new NetworkDriverError(true);
      };
      const manager = f.coordinator();
      const stillUnsettled = failure !== 'preflight-known';
      await assert.rejects(manager.recover(), reject(stillUnsettled ? 'NETWORK_COMMAND_UNSETTLED' : 'NETWORK_RECOVERY_FAILED'), failure);
      const expected = ['preflight:settle'];
      if (failure !== 'provenance') expected.push('settle');
      if (failure === 'proof' || failure.startsWith('preflight-')) expected.push('settled');
      if (failure.startsWith('preflight-')) expected.push('preflight:recover');
      assert.deepEqual(f.calls.slice(before), expected, failure);
      const result = await manager.status();
      assert.equal(result.lastPhase, 'fault', failure);
      assert.equal(result.unsettled, stillUnsettled, failure);
      await assert.rejects(manager.apply(input(), result.revision), reject('NETWORK_RECOVERY_REQUIRED'));
    } finally { await f.close(); }
  }
});

test('a journal interrupted during settling is accepted only for a fresh explicit recovery', async () => {
  const f = await fixture();
  try {
    await f.coordinator().apply(input(), 0);
    const path = join(f.root, 'network-state.json'), saved = JSON.parse(await readFile(path, 'utf8'));
    saved.phase = 'settling'; saved.unsettled = true; saved.fault = 'NETWORK_RECOVERY_REQUIRED';
    await writeFile(path, JSON.stringify(saved));
    const manager = f.coordinator(), before = f.calls.length;
    await assert.rejects(manager.apply(input(), saved.revision), reject('NETWORK_RECOVERY_REQUIRED'));
    assert.equal((await manager.recover()).lastPhase, 'blocked');
    assert.deepEqual(f.calls.slice(before), ['preflight:settle', 'settle', 'settled', 'preflight:recover', 'guard', 'retain']);
  } finally { await f.close(); }
});

test('scope, corrupted journal and external revision cannot be adopted as recovered authority', async () => {
  const f = await fixture();
  try {
    const manager = f.coordinator(), first = await manager.apply(input(), 0);
    const peer = f.coordinator(), recovered = await peer.recover();
    await assert.rejects(manager.apply(input(), recovered.revision), reject('NETWORK_RECOVERY_REQUIRED'));
    const production = new NetworkCoordinator(f.root, { ...f.driver, scope: 'production' });
    await assert.rejects(production.status(), reject('NETWORK_STORE_CORRUPT'));
    assert.equal(first.status.scope, 'fixture');
    const path = join(f.root, 'network-state.json'), saved = await readFile(path, 'utf8');
    await writeFile(path, saved.replace('"planSha256":"', '"planSha256":"f'));
    const before = f.calls.length;
    await assert.rejects(peer.recover(), reject('NETWORK_STORE_CORRUPT'));
    assert.equal(f.calls.length, before);
  } finally { await f.close(); }
});

test('a failed ready journal write still reasserts blocking and cannot return application success',
  { skip: process.platform !== 'linux' || process.getuid?.() === 0 ? 'requires non-root POSIX permissions' : false }, async () => {
    const f = await fixture();
    try {
      f.driver.verifyActive = async (_, proof) => {
        f.calls.push('verify'); f.disableFenceAssertion(); await chmod(f.root, 0o500); return evidence(proof.identity, f.clock.now);
      };
      f.driver.retainBlockedResources = async () => { f.calls.push('retain'); await chmod(f.root, 0o700); };
      const manager = f.coordinator();
      await assert.rejects(manager.apply(input(), 0), reject('NETWORK_STORE_IO'));
      assert.deepEqual(f.calls.slice(-2), ['guard', 'retain']);
      assert.equal((await manager.status()).lastPhase, 'blocked');
      assert.equal((await manager.status()).readiness, 'unknown');
    } finally { await f.close(); }
  });

test('lock release failure after a ready write clears the instance activation gate', async () => {
  const f = await fixture();
  try {
    f.driver.verifyActive = async (_, proof) => {
      f.calls.push('verify'); await unlink(join(f.root, '.lock', 'owner.json')); return evidence(proof.identity, f.clock.now);
    };
    const manager = f.coordinator();
    await assert.rejects(manager.apply(input(), 0), reject('NETWORK_STORE_IO'));
    const persisted = await manager.status();
    assert.equal(persisted.lastPhase, 'ready');
    assert.equal(persisted.readiness, 'unknown');
    // Simulate explicit repair of this fixture's empty lock. Production never
    // guesses ownership of an ownerless lock or removes it automatically.
    await rmdir(join(f.root, '.lock'));
    const before = f.calls.length;
    await assert.rejects(manager.apply(input(), persisted.revision), reject('NETWORK_RECOVERY_REQUIRED'));
    assert.equal(f.calls.length, before);
    assert.equal((await manager.recover()).lastPhase, 'blocked');
  } finally { await f.close(); }
});

test('process death during a mutation leaves a durable fence and dead-owner recovery never resumes activation',
  { skip: process.platform !== 'linux' ? 'requires Linux dead-owner lock recovery' : false, timeout: 10_000 }, async () => {
    const f = await fixture();
    let child: ReturnType<typeof spawn> | undefined;
    try {
      const module = new URL('../packages/network/transaction.ts', import.meta.url).href;
      const script = `import { NetworkCoordinator } from ${JSON.stringify(module)};
        const driver = { scope:'fixture', async preflight(){}, async settlePending(){}, async installBlockedGuard(){}, async prepareBlocked(){},
          async ensureCore(){ process.stdout.write('IN_FLIGHT\\n'); await new Promise(() => setInterval(() => {}, 1000)); } };
        await new NetworkCoordinator(${JSON.stringify(f.root)}, driver).apply(${JSON.stringify(input())}, 0);`;
      child = spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
      const closed = new Promise<void>((resolve, reject) => { child!.once('error', reject); child!.once('close', () => resolve()); });
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('fixture child did not reach mutation')), 4000);
        child!.stdout!.once('data', chunk => { clearTimeout(timer); assert.match(chunk.toString(), /IN_FLIGHT/); resolve(); });
        child!.once('error', error => { clearTimeout(timer); reject(error); });
      });
      const journal = JSON.parse(await readFile(join(f.root, 'network-state.json'), 'utf8'));
      assert.equal(journal.phase, 'starting-core'); assert.equal(journal.unsettled, true);
      await assert.rejects(f.coordinator().recover(), reject('NETWORK_BUSY'));
      child.kill('SIGKILL'); await closed;
      const result = await f.coordinator().recover();
      assert.equal(result.lastPhase, 'blocked');
      assert.deepEqual(f.calls, ['preflight:settle', 'settle', 'settled', 'preflight:recover', 'guard', 'retain']);
    } finally { child?.kill('SIGKILL'); await f.close(); }
  });
