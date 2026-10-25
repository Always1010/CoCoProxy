import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { compileConfig } from '../packages/config/index.ts';
import { FileTransactionStore, TransactionManager } from '../packages/transaction/index.ts';
import { reconcileManagementRuntime, recoverManagementStartup, createManagementLifecycle } from '../packages/management/startup.ts';
import { readRuntimeLifecycle, setRuntimeLifecycle } from '../packages/runtime/lifecycle.ts';

const input = { schemaVersion: 1, deployment: { mixedPort: 17890, controllerPort: 19090, dnsPort: 15353,
  controllerSecret: 'synthetic-private-controller-secret', bootstrapResolvers: ['192.0.2.53'] }, policy: { rules: ['MATCH,REJECT'] } };
function runtime(events: (string | null)[], fail = false) {
  return { validate: async () => {}, activate: async () => {}, confirm: async () => true,
    restore: async (_path: string | null, generation: string | null) => { events.push(generation); if (fail) throw new Error('PRIVATE_DIAGNOSTICS'); } };
}
async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'cocoproxy-startup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return join(root, 'state');
}

test('fresh and committed startup never creates state, starts a core or applies a draft', async t => {
  const stateDirectory = await fixture(t);
  const events: (string | null)[] = [];
  const untouched = await recoverManagementStartup(stateDirectory, runtime(events));
  assert.equal(untouched.attempted, false); assert.equal(untouched.status.active, null);
  await assert.rejects(stat(stateDirectory), { code: 'ENOENT' });
  const store = new FileTransactionStore(stateDirectory);
  const candidate = compileConfig(input); await store.stage(candidate);
  await new TransactionManager(store, runtime(events)).apply(candidate.id, null);
  const settled = await recoverManagementStartup(stateDirectory, runtime(events));
  assert.equal(settled.attempted, false); assert.equal(settled.status.active, candidate.id);
  assert.deepEqual(events, []);
});

test('startup awaits interrupted recovery to the prior generation and preserves fault on failed restore', async t => {
  const stateDirectory = await fixture(t);
  const store = new FileTransactionStore(stateDirectory);
  const previous = compileConfig(input);
  const target = compileConfig({ ...input, policy: { ...input.policy, 'log-level': 'warning' } });
  await store.stage(previous); await store.stage(target);
  const interrupted = { version: 1 as const, active: previous.id, desired: target.id,
    pending: { id: '00000000-0000-4000-8000-000000000001', previous: previous.id, target: target.id, phase: 'confirming' as const },
    fault: null, checkedAt: null };
  await store.exclusive(() => store.writeState(interrupted));
  const events: (string | null)[] = [];
  let release!: () => void;
  const adapter = runtime(events);
  adapter.restore = async (_path, generation) => { await new Promise<void>(resolve => { release = resolve; }); events.push(generation); };
  let finished = false;
  const recovery = recoverManagementStartup(stateDirectory, adapter).then(result => { finished = true; return result; });
  while (!release) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(finished, false);
  release();
  const recovered = await recovery;
  assert.equal(recovered.recovered, true); assert.equal(recovered.attempted, true);
  assert.equal(recovered.status.active, previous.id); assert.equal(recovered.status.transaction, null);
  assert.deepEqual(events, [previous.id]);
  await store.exclusive(() => store.writeState(interrupted));
  const failed = await recoverManagementStartup(stateDirectory, runtime(events, true));
  assert.equal(failed.recovered, false); assert.equal(failed.status.fault, 'RESTORE_FAILED');
  assert.equal(failed.status.active, null); assert.equal(failed.status.transaction?.phase, 'fault');
  assert.ok(!JSON.stringify(failed).includes('PRIVATE_DIAGNOSTICS'));
});

test('startup lock contention keeps the transaction pending without a parallel restore', async t => {
  const stateDirectory = await fixture(t); const store = new FileTransactionStore(stateDirectory);
  const candidate = compileConfig(input); await store.stage(candidate);
  await store.exclusive(async () => {
    await store.writeState({ version: 1, active: null, desired: candidate.id,
      pending: { id: '00000000-0000-4000-8000-000000000002', previous: null, target: candidate.id, phase: 'activating' }, fault: null, checkedAt: null });
    const events: (string | null)[] = [];
    const result = await recoverManagementStartup(stateDirectory, runtime(events));
    assert.equal(result.recovered, false); assert.equal(result.reason, 'STORE_LOCKED');
    assert.equal(result.status.transaction?.phase, 'activating'); assert.deepEqual(events, []);
  });
});

test('persistent lifecycle restores only committed active, and a durable pause fences all automatic recovery', async t => {
  const stateDirectory = await fixture(t);
  assert.deepEqual(await readRuntimeLifecycle(stateDirectory), { schemaVersion: 1, enabled: false, paused: false });
  await assert.rejects(stat(stateDirectory), { code: 'ENOENT' });
  const store = new FileTransactionStore(stateDirectory);
  const previous = compileConfig(input);
  const draft = compileConfig({ ...input, policy: { rules: ['MATCH,DIRECT'] } });
  await store.stage(previous); await store.stage(draft);
  await store.exclusive(() => store.writeState({ version: 1, active: previous.id, desired: draft.id,
    pending: null, fault: null, checkedAt: null }));
  const restored: (string | null)[] = [], reconciled: string[] = [];
  const adapter = { ...runtime(restored), reconcile: async (path: string, generation: string) => {
    assert.equal(path, store.candidatePath(previous.id)); reconciled.push(generation); return true;
  } };
  await reconcileManagementRuntime(stateDirectory, adapter);
  assert.deepEqual(reconciled, []);
  await setRuntimeLifecycle(stateDirectory, { enabled: true, paused: false });
  await reconcileManagementRuntime(stateDirectory, adapter);
  assert.deepEqual(reconciled, [previous.id]);
  assert.equal((await store.status()).desired, draft.id);
  const interrupted = { version: 1 as const, active: previous.id, desired: draft.id,
    pending: { id: '00000000-0000-4000-8000-000000000003', previous: previous.id, target: draft.id, phase: 'activating' as const },
    fault: null, checkedAt: null };
  await store.exclusive(() => store.writeState(interrupted));
  await setRuntimeLifecycle(stateDirectory, { enabled: true, paused: true });
  await reconcileManagementRuntime(stateDirectory, adapter);
  assert.equal((await recoverManagementStartup(stateDirectory, adapter)).reason, 'RUNTIME_LIFECYCLE_PAUSED');
  assert.deepEqual(restored, []);
  await setRuntimeLifecycle(stateDirectory, { enabled: true, paused: false });
  await reconcileManagementRuntime(stateDirectory, adapter);
  assert.deepEqual(restored, [previous.id]);
  assert.deepEqual(reconciled, [previous.id, previous.id]);
  assert.equal((await store.status()).active, previous.id);
  await store.exclusive(async () => {
    await assert.rejects(setRuntimeLifecycle(stateDirectory, { enabled: false, paused: true }, { timeoutMs: 0 }), { code: 'STORE_LOCKED' });
  });
  let release!: () => void;
  let locked!: () => void;
  const acquired = new Promise<void>(resolve => { locked = resolve; });
  const operation = store.exclusive(async () => { locked(); await new Promise<void>(resolve => { release = resolve; }); });
  await acquired;
  const pause = setRuntimeLifecycle(stateDirectory, { enabled: true, paused: true }, { timeoutMs: 1000, retryMs: 5 });
  release(); await operation; await pause;
  assert.equal((await readRuntimeLifecycle(stateDirectory)).paused, true);
  await writeFile(join(stateDirectory, 'lifecycle.json'), '{"schemaVersion":1,"enabled":"yes","paused":false}', { mode: 0o600 });
  await assert.rejects(reconcileManagementRuntime(stateDirectory, adapter), { code: 'RUNTIME_LIFECYCLE_INVALID' });
  assert.equal(reconciled.length, 2);
});

test('manager serializes persistent retries, keeps retrying transient failures, and drains on close', async t => {
  const stateDirectory = await fixture(t);
  const store = new FileTransactionStore(stateDirectory);
  const candidate = compileConfig(input); await store.stage(candidate);
  await new TransactionManager(store, runtime([])).apply(candidate.id, null);
  await setRuntimeLifecycle(stateDirectory, { enabled: true, paused: false });
  let calls = 0, failures = 0, inFlight = 0, maximum = 0;
  let ready!: () => void;
  const completed = new Promise<void>(resolve => { ready = resolve; });
  const adapter = { ...runtime([]), reconcile: async () => {
    calls++; inFlight++; maximum = Math.max(maximum, inFlight);
    try {
      await new Promise(resolve => setTimeout(resolve, 8));
      if (calls < 3) throw new Error('private transient detail');
      ready(); return true;
    } finally { inFlight--; }
  } };
  const lifecycle = createManagementLifecycle(stateDirectory, adapter, () => { failures++; }, 5);
  await lifecycle.start();
  await Promise.race([completed, new Promise((_, reject) => setTimeout(() => reject(new Error('retry timeout')), 2000))]);
  await lifecycle.close();
  assert.equal(maximum, 1); assert.equal(inFlight, 0); assert.equal(failures, 2);
  const stoppedAt = calls;
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(calls, stoppedAt);
});
