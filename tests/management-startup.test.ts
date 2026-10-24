import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { compileConfig } from '../packages/config/index.ts';
import { FileTransactionStore, TransactionManager } from '../packages/transaction/index.ts';
import { recoverManagementStartup } from '../packages/management/startup.ts';

const input = { schemaVersion: 1, deployment: { mixedPort: 17890, controllerPort: 19090, dnsPort: 15353,
  controllerSecret: 'synthetic-private-controller-secret', bootstrapResolvers: ['192.0.2.53'] }, policy: { rules: ['MATCH,REJECT'] } };
function runtime(events: (string | null)[], fail = false) {
  return { validate: async () => {}, activate: async () => {}, confirm: async () => true,
    restore: async (_path: string | null, generation: string | null) => { events.push(generation); if (fail) throw new Error('PRIVATE_DIAGNOSTICS'); } };
}
async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'coproxy-startup-'));
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
