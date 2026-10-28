import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, readFile, writeFile, stat, symlink, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalJson } from '../packages/config/index.ts';
import type { Candidate } from '../packages/config/index.ts';
import { FileTransactionStore, TransactionManager, TransactionError } from '../packages/transaction/index.ts';
import type { RuntimeAdapter } from '../packages/transaction/index.ts';
import { withOperationTiming, type OperationTiming } from '../packages/diagnostics/operation-timing.ts';

function candidate(name: string): Candidate {
  const config = { name, token: 'synthetic-private-value' };
  const sha256 = createHash('sha256').update(canonicalJson(config)).digest('hex');
  return { id: sha256, sha256, config };
}

class TestRuntime implements RuntimeAdapter {
  calls: string[] = [];
  validationFails = false;
  activationFails = false;
  restoreFails = false;
  confirms = true;
  async validate(_path: string): Promise<void> {
    this.calls.push('validate');
    if (this.validationFails) throw new Error('synthetic-private-value');
  }
  async activate(_path: string, generation: string): Promise<void> {
    this.calls.push(`activate:${generation}`);
    if (this.activationFails) throw new Error('synthetic-private-value');
  }
  async confirm(_generation: string): Promise<boolean> { this.calls.push('confirm'); return this.confirms; }
  async restore(_path: string | null, generation: string | null): Promise<void> {
    this.calls.push(`restore:${generation}`);
    if (this.restoreFails) throw new Error('synthetic-private-value');
  }
}

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'cocoproxy-transaction-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new FileTransactionStore(root);
  const runtime = new TestRuntime();
  const manager = new TransactionManager(store, runtime);
  return { root, store, runtime, manager };
}

const code = (expected: string) => (error: unknown): boolean => {
  assert.ok(error instanceof TransactionError);
  assert.equal(error.code, expected);
  assert.equal(error.message, expected);
  assert.ok(!String(error).includes('synthetic-private-value'));
  return true;
};

test('stage checks digest, rejects path traversal and never invokes runtime', async t => {
  const { manager, runtime, root } = await fixture(t);
  const good = candidate('first');
  await assert.rejects(manager.stage({ ...good, config: { different: true } }), code('INVALID_CANDIDATE_DIGEST'));
  await assert.rejects(manager.stage({ ...good, id: '../state' }), code('INVALID_CANDIDATE_DIGEST'));
  const staged = await manager.stage(good);
  assert.equal(staged.id, good.id);
  assert.equal(await readFile(staged.path, 'utf8'), canonicalJson(good.config));
  assert.deepEqual(runtime.calls, []);
  assert.deepEqual(await manager.status(), {
    desired: null, active: null, transaction: null, fault: null, checkedAt: null, readiness: 'unknown',
  });
  if (process.platform !== 'win32') {
    assert.equal((await stat(root)).mode & 0o777, 0o700);
    assert.equal((await stat(staged.path)).mode & 0o777, 0o600);
  }
});

test('stage is idempotent and refuses to overwrite modified candidates', async t => {
  const { store, manager } = await fixture(t);
  const good = candidate('immutable');
  const staged = await store.stage(good);
  assert.deepEqual(await manager.stage(good), staged);
  await writeFile(staged.path, '{"tampered":true}', { mode: 0o600 });
  await assert.rejects(store.stage(good), code('CANDIDATE_COLLISION'));
  await assert.rejects(manager.apply(good.id, null), code('CANDIDATE_TAMPERED'));
  assert.equal(await readFile(staged.path, 'utf8'), '{"tampered":true}');
});

test('CAS includes null and successful state never claims current health', async t => {
  const { manager, runtime } = await fixture(t);
  const first = candidate('first');
  const second = candidate('second');
  await manager.stage(first);
  await manager.stage(second);
  await assert.rejects(manager.apply(first.id, second.id), code('ACTIVE_CONFLICT'));
  assert.deepEqual(runtime.calls, []);
  const result = await manager.apply(first.id, null);
  assert.equal(result.active, first.id);
  assert.equal(result.desired, first.id);
  assert.equal(result.readiness, 'unknown');
  assert.equal(result.transaction, null);
  await assert.rejects(manager.apply(second.id, null), code('ACTIVE_CONFLICT'));
  assert.ok(!JSON.stringify(result).includes('synthetic-private-value'));
});

test('operation timings isolate concurrent transactions, omit private data and cannot change success or failure', async t => {
  const good = await fixture(t), bad = await fixture(t), target = candidate('timing-private-node');
  await good.manager.stage(target); await bad.manager.stage(target);
  bad.runtime.confirms = false;
  const timings: OperationTiming[] = [];
  const observe = (timing: OperationTiming) => { timings.push(timing); throw new Error('synthetic observer failure'); };
  const results = await Promise.allSettled([
    withOperationTiming('select', observe, () => good.manager.apply(target.id, null)),
    withOperationTiming('reconcile', observe, () => bad.manager.apply(target.id, null)),
  ]);
  assert.equal(results[0].status, 'fulfilled');
  assert.equal(results[1].status, 'rejected');
  if (results[1].status === 'rejected') assert.equal(results[1].reason.code, 'CONFIRM_FAILED');
  assert.equal(timings.length, 2);
  const succeeded = timings.find(timing => timing.operation === 'select')!, failed = timings.find(timing => timing.operation === 'reconcile')!;
  assert.equal(succeeded.outcome, 'ok'); assert.equal(failed.outcome, 'failed');
  assert.equal(typeof succeeded.phases.commit, 'number'); assert.equal(succeeded.phases.restore, undefined);
  assert.equal(typeof failed.phases.restore, 'number'); assert.equal(failed.phases.commit, undefined);
  for (const timing of timings) {
    for (const phase of ['lock', 'held', 'validate', 'activate', 'confirm'] as const) assert.equal(typeof timing.phases[phase], 'number');
    assert.ok([timing.totalMs, ...Object.values(timing.phases)].every(value => Number.isFinite(value) && value >= 0));
  }
  for (const value of [good.root, bad.root, target.id, 'synthetic-private-value', 'timing-private-node'])
    assert.ok(!JSON.stringify(timings).includes(value));
});

test('validation failure neither activates nor restores and errors are opaque', async t => {
  const { manager, runtime } = await fixture(t);
  const target = candidate('invalid');
  await manager.stage(target);
  runtime.validationFails = true;
  await assert.rejects(manager.apply(target.id, null), code('VALIDATION_FAILED'));
  assert.deepEqual(runtime.calls, ['validate']);
  const state = await manager.status();
  assert.equal(state.active, null);
  assert.equal(state.desired, target.id);
  assert.equal(state.transaction, null);
});

test('failed confirmation restores the previous committed generation', async t => {
  const { manager, runtime } = await fixture(t);
  const previous = candidate('previous');
  const target = candidate('target');
  await manager.stage(previous);
  await manager.stage(target);
  await manager.apply(previous.id, null);
  runtime.confirms = false;
  await assert.rejects(manager.apply(target.id, previous.id), code('CONFIRM_FAILED'));
  assert.equal(runtime.calls.at(-1), `restore:${previous.id}`);
  const state = await manager.status();
  assert.equal(state.active, previous.id);
  assert.equal(state.desired, target.id);
  assert.equal(state.transaction, null);
});

test('first activation failure asks adapter to stop via restore(null,null)', async t => {
  const { manager, runtime } = await fixture(t);
  const target = candidate('target');
  await manager.stage(target);
  runtime.activationFails = true;
  await assert.rejects(manager.apply(target.id, null), code('ACTIVATION_FAILED'));
  assert.equal(runtime.calls.at(-1), 'restore:null');
  assert.equal((await manager.status()).active, null);
});

test('rollback fault is durable, blocks new apply and can be recovered repeatedly', async t => {
  const { manager, runtime, store } = await fixture(t);
  const previous = candidate('previous');
  const target = candidate('target');
  await manager.stage(previous);
  await manager.stage(target);
  await manager.apply(previous.id, null);
  runtime.confirms = false;
  runtime.restoreFails = true;
  await assert.rejects(manager.apply(target.id, previous.id), code('RESTORE_FAILED'));
  const fault = await store.status();
  assert.equal(fault.active, null);
  assert.equal(fault.readiness, 'fault');
  assert.equal(fault.fault, 'RESTORE_FAILED');
  assert.equal(fault.transaction?.phase, 'fault');
  await assert.rejects(manager.apply(target.id, null), code('RECOVERY_REQUIRED'));
  await assert.rejects(manager.recover(), code('RESTORE_FAILED'));
  runtime.restoreFails = false;
  const recovered = await manager.recover();
  assert.equal(recovered.active, previous.id);
  assert.equal(recovered.fault, null);
  assert.equal(recovered.transaction, null);
  assert.deepEqual(await manager.recover(), recovered);
});

test('explicit target recovery binds the fault transaction and commits only after runtime confirmation', async t => {
  const { manager, runtime, store } = await fixture(t);
  const previous = candidate('prior-deployment'), target = candidate('reviewed-new-deployment');
  await manager.stage(previous); await manager.stage(target); await manager.apply(previous.id, null);
  runtime.confirms = false; runtime.restoreFails = true;
  await assert.rejects(manager.apply(target.id, previous.id), code('RESTORE_FAILED'));
  const fault = await store.status(), id = fault.transaction!.id;
  const activate = runtime.activate.bind(runtime);
  runtime.activate = async (path, generation) => {
    const inFlight = await store.readState();
    assert.equal(inFlight.pending?.phase, 'recovering-target');
    assert.equal(inFlight.active, null); assert.equal(inFlight.fault, 'RESTORE_FAILED');
    await activate(path, generation);
  };
  const calls = runtime.calls.length;
  await assert.rejects(manager.recoverTarget(id, previous.id), code('ACTIVE_CONFLICT'));
  assert.equal(runtime.calls.length, calls);
  await assert.rejects(manager.recoverTarget(id, target.id), code('CONFIRM_FAILED'));
  assert.equal((await store.status()).active, null);
  assert.equal((await store.status()).fault, 'RESTORE_FAILED');
  runtime.confirms = true;
  const result = await manager.recoverTarget(id, target.id);
  assert.equal(result.active, target.id); assert.equal(result.fault, null); assert.equal(result.transaction, null);
  assert.deepEqual(runtime.calls.slice(-3), ['validate', `activate:${target.id}`, 'confirm']);
});

test('pending interruption restores predecessor before permitting apply', async t => {
  const { store, manager, runtime } = await fixture(t);
  const target = candidate('interrupted');
  await manager.stage(target);
  const write = store.writeState.bind(store);
  let interrupted = false;
  store.writeState = async state => {
    await write(state);
    if (!interrupted && state.pending?.phase === 'activating') { interrupted = true; throw new Error('simulated interruption'); }
  };
  await assert.rejects(manager.apply(target.id, null), code('STORE_IO'));
  assert.equal((await manager.status()).transaction?.phase, 'activating');
  assert.deepEqual(runtime.calls, ['validate']);
  store.writeState = write;
  const recovered = await manager.recover();
  assert.equal(recovered.active, null);
  assert.equal(recovered.transaction, null);
  assert.equal(runtime.calls.at(-1), 'restore:null');
});

test('crash after durable commit preserves target and only cleans pending', async t => {
  const { store, manager, runtime } = await fixture(t);
  const target = candidate('committed');
  await manager.stage(target);
  const write = store.writeState.bind(store);
  store.writeState = async state => {
    await write(state);
    if (state.pending?.phase === 'committed') throw new Error('simulated interruption');
  };
  await assert.rejects(manager.apply(target.id, null), code('STORE_IO'));
  assert.equal((await manager.status()).transaction?.phase, 'committed');
  store.writeState = write;
  const callsBefore = runtime.calls.length;
  assert.equal((await manager.recover()).active, target.id);
  assert.equal(runtime.calls.length, callsBefore);
  assert.equal((await manager.status()).transaction, null);
});

test('different managers serialize mutations with an exclusive store lock', async t => {
  const { root, store, manager, runtime } = await fixture(t);
  const target = candidate('contended');
  await manager.stage(target);
  let release!: () => void;
  let entered!: () => void;
  const enteredValidation = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  runtime.validate = async () => { entered(); await gate; };
  const applying = manager.apply(target.id, null);
  try {
    await enteredValidation;
    const other = new TransactionManager(new FileTransactionStore(root), new TestRuntime());
    await assert.rejects(other.stage(candidate('other')), code('STORE_LOCKED'));
    await assert.rejects(other.recover(), code('STORE_LOCKED'));
    assert.equal((await store.status()).transaction?.phase, 'validating');
  } finally { release(); }
  await applying;
});

test('transaction intents bind apply and recovery to the current exclusive owner', async t => {
  const { store, manager, runtime } = await fixture(t);
  const target = candidate('owner-binding');
  await manager.stage(target);
  let applyingToken: string | undefined;
  runtime.activate = async () => {
    applyingToken = (await store.readState()).pending!.ownerToken;
    assert.match(applyingToken!, /^[a-f0-9-]{36}$/);
    if (process.platform === 'linux') assert.equal(await store.hasLiveLockOwner(applyingToken), true);
    throw new Error('synthetic activation interruption');
  };
  runtime.restoreFails = true;
  await assert.rejects(manager.apply(target.id, null), code('RESTORE_FAILED'));
  assert.equal(await store.hasLiveLockOwner(applyingToken), false);
  runtime.restore = async () => {
    const recoveringToken = (await store.readState()).pending!.ownerToken;
    assert.notEqual(recoveringToken, applyingToken);
    if (process.platform === 'linux') assert.equal(await store.hasLiveLockOwner(recoveringToken), true);
  };
  await manager.recover();
  await store.exclusive(async unrelatedToken => {
    assert.notEqual(unrelatedToken, applyingToken);
    assert.equal(await store.hasLiveLockOwner(applyingToken), false);
    assert.equal(await store.hasLiveLockOwner(unrelatedToken), process.platform === 'linux');
  });
});

test('an incomplete lock owner fails closed instead of guessing staleness', async t => {
  const { root, store } = await fixture(t);
  await store.status();
  await mkdir(join(root, '.lock'), { mode: 0o700 });
  await assert.rejects(store.stage(candidate('blocked')), code('STORE_LOCKED'));
});

test('Linux reclaims a lock only after process identity proves its owner is gone', { skip: process.platform !== 'linux' }, async t => {
  const { root, store } = await fixture(t);
  await store.status();
  await mkdir(join(root, '.lock'), { mode: 0o700 });
  const bootId = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
  await writeFile(join(root, '.lock', 'owner.json'), JSON.stringify({
    pid: process.pid, token: 'synthetic-dead-owner', bootId, startTime: '0',
  }), { mode: 0o600 });
  const target = candidate('reclaimed');
  assert.equal((await store.stage(target)).id, target.id);
});

test('interrupted fault recovery remains valid and the next restore is idempotent', async t => {
  const { manager, runtime, store } = await fixture(t);
  const previous = candidate('previous');
  const target = candidate('target');
  await manager.stage(previous);
  await manager.stage(target);
  await manager.apply(previous.id, null);
  runtime.confirms = false;
  runtime.restoreFails = true;
  await assert.rejects(manager.apply(target.id, previous.id), code('RESTORE_FAILED'));
  runtime.restoreFails = false;
  const write = store.writeState.bind(store);
  store.writeState = async state => {
    await write(state);
    if (state.pending?.phase === 'restoring') throw new Error('simulated interruption');
  };
  await assert.rejects(manager.recover(), code('STORE_IO'));
  assert.equal((await manager.status()).transaction?.phase, 'restoring');
  store.writeState = write;
  assert.equal((await manager.recover()).active, previous.id);
});

test('Linux recovers a lock left by a killed process', { skip: process.platform !== 'linux', timeout: 10000 }, async t => {
  const { root, store } = await fixture(t);
  await store.status();
  const script = `
    import {mkdir,readFile,writeFile} from 'node:fs/promises';
    import {join} from 'node:path';
    const root=process.argv[1];
    const bootId=(await readFile('/proc/sys/kernel/random/boot_id','utf8')).trim();
    const stat=await readFile('/proc/'+process.pid+'/stat','utf8');
    const startTime=stat.slice(stat.lastIndexOf(')')+2).split(' ')[19];
    await mkdir(join(root,'.lock'),{mode:0o700});
    await writeFile(join(root,'.lock','owner.json'),JSON.stringify({pid:process.pid,token:'00000000-0000-4000-8000-000000000001',bootId,startTime}),{mode:0o600});
    process.send('ready');
    setInterval(()=>{},1000);
  `;
  const child = spawn(process.execPath, ['--input-type=module', '--eval', script, root], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  const [message] = await once(child, 'message');
  assert.equal(message, 'ready');
  const token = '00000000-0000-4000-8000-000000000001';
  assert.equal(await store.hasLiveLockOwner(token), true);
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
  assert.equal(await store.hasLiveLockOwner(token), false);
  const target = candidate('after-kill');
  assert.equal((await store.stage(target)).id, target.id);
});

test('POSIX store rejects broad existing directory permissions without changing them', { skip: process.platform === 'win32' }, async t => {
  const { root, store } = await fixture(t);
  await chmod(root, 0o755);
  await assert.rejects(store.status(), code('UNSAFE_STORE'));
  assert.equal((await stat(root)).mode & 0o777, 0o755);
});

test('POSIX candidate and root symlinks are rejected without following them', { skip: process.platform === 'win32' }, async t => {
  const { root, store } = await fixture(t);
  await store.stage(candidate('seed'));
  const target = candidate('symlink');
  const outside = join(root, 'synthetic-outside.json');
  await writeFile(outside, canonicalJson(target.config), { mode: 0o600 });
  await symlink(outside, store.candidatePath(target.id));
  await assert.rejects(store.stage(target), code('UNSAFE_STORE'));
  assert.equal(await readFile(outside, 'utf8'), canonicalJson(target.config));
  const alias = join(root, 'alias');
  await symlink(root, alias, 'dir');
  await assert.rejects(new FileTransactionStore(alias).status(), code('UNSAFE_STORE'));
});

test('status on an absent store is read-only and returns empty status', async t => {
  const { root } = await fixture(t);
  const absent = join(root, 'absent');
  const status = await new FileTransactionStore(absent).status();
  assert.equal(status.active, null);
  assert.equal(status.readiness, 'unknown');
  await assert.rejects(stat(absent), { code: 'ENOENT' });
});
