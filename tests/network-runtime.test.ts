import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { canonicalJson } from '../packages/config/index.ts';
import { loadGatewayCandidate } from '../packages/network/candidate.ts';
import { compileGatewayPreview, GATEWAY_CORE_SHA256 } from '../packages/network/config.ts';
import type { FencedCommandInspection, FencedWorkerIdentity } from '../packages/network/fenced-command.ts';
import { GatewayCoreRuntime, type GatewayRuntimeFixtureDependencies } from '../packages/network/runtime.ts';
import { renderGatewayRuntimePlan } from '../packages/network/runtime-plan.ts';
import { NetworkDriverError } from '../packages/network/transaction.ts';
import { FileTransactionStore } from '../packages/transaction/index.ts';

const linux = { skip: process.platform !== 'linux' };
const secret = 'synthetic-private-controller-secret';
const group = '/system.slice/coproxy-mihomo.service';
type Action = Parameters<GatewayRuntimeFixtureDependencies['command']>[1];
type Stored = { revision: number; selected: string | null; pending: null | { action: Action; token: string; commandSHA: string;
  context: Pick<FencedWorkerIdentity, 'bootID' | 'userNS' | 'netNS' | 'uid'> } };
const failed = (error: unknown): boolean => {
  assert.ok(error instanceof NetworkDriverError);
  assert.equal(error.message, 'NETWORK_DRIVER_FAILED');
  assert.equal(Object.hasOwn(error, 'cause'), false);
  assert.equal(String(error).includes(secret), false);
  return true;
};
const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');

async function fixture(t: test.TestContext, controllerSecret = secret) {
  const parent = await mkdtemp(join(tmpdir(), 'coproxy-gateway-runtime-'));
  await chmod(parent, 0o700);
  t.after(() => rm(parent, { recursive: true, force: true }));
  const proposed = renderGatewayRuntimePlan({ schemaVersion: 1, stateDirectory: join(parent, 'state'),
    coreHome: join(parent, 'home'), binaryPath: '/opt/coproxy/bin/mihomo', binarySha256: GATEWAY_CORE_SHA256,
    systemctlPath: '/usr/bin/systemctl', unitPath: '/etc/systemd/system/coproxy-mihomo.service', serviceUid: 12345 });
  const preview = compileGatewayPreview({ schemaVersion: 1, base: { schemaVersion: 1,
    deployment: { mixedPort: 17890, controllerPort: 19090, controllerSecret, dnsPort: 15353, bootstrapResolvers: ['192.0.2.53'] },
    policy: { proxies: [], rules: ['MATCH,REJECT'] } },
    network: { schemaVersion: 1, core: { serviceUid: 12345, binarySha256: GATEWAY_CORE_SHA256, unitSha256: proposed.settings.unitSha256 },
      ingressInterface: 'lan-test', gatewayIPv4: '192.0.2.2', prefixLength: 24, routerIPv4: '192.0.2.1',
      routerMAC: '02:00:00:00:00:01', clientIPv4: '192.0.2.3', dnsPort: 15353,
      tun: { interface: 'coproxy-tun', mtu: 1500 }, marks: { mask: 0xff00, capture: 0x100, egress: 0x200, return: 0x300 },
      tables: { capture: 10003, egress: 10002, return: 10001 }, priorities: { capture: 10003, egress: 10002, return: 10001 } } });
  await new FileTransactionStore(proposed.settings.stateDirectory).stage(preview.candidate);
  const journalPath = join(proposed.settings.stateDirectory, 'gateway-core-state.json');
  const journal = async () => JSON.parse(await readFile(journalPath, 'utf8')) as Stored;
  const calls: string[] = [], commands: Action[] = [];
  const inspections = new Map<string, FencedCommandInspection>();
  const model = {
    observed: { state: { loadState: 'loaded', activeState: 'active', subState: 'running', mainPid: 34567,
      jobPending: false, fragmentPath: proposed.settings.unitPath, hasDropIns: false, needsReload: false, user: '12345' }, controlGroup: group },
    commandFailure: null as Action | null,
    blockedFailureAt: 0,
    blockedCalls: 0,
    inspectHook: undefined as ((token: string, settle: boolean, value: FencedCommandInspection) => Promise<FencedCommandInspection>) | undefined,
    showHook: undefined as (() => Promise<void>) | undefined,
    commandHook: undefined as ((action: Action) => Promise<void>) | undefined,
  };
  const dependencies: GatewayRuntimeFixtureDependencies = {
    async preflight() { calls.push('preflight'); },
    async show() { calls.push('show'); await model.showHook?.(); return structuredClone(model.observed); },
    async candidate(settings, generation, plan) { calls.push('candidate'); return loadGatewayCandidate(settings, generation, plan); },
    async validate(candidate, options) {
      calls.push('validate'); assert.equal(candidate.id, preview.candidate.id); assert.equal(options.binaryPath, proposed.settings.binaryPath);
    },
    async command(token, action, args) {
      calls.push('command:' + action); commands.push(action);
      const stored = await journal(), pending = stored.pending!;
      assert.ok(pending, 'a durable command intent must exist before invoking systemctl');
      assert.equal(pending.token, token); assert.equal(pending.action, action);
      assert.deepEqual(args, ['--no-ask-password', '--no-pager', action, 'coproxy-mihomo.service']);
      assert.ok(model.blockedCalls > 0, 'every command requires preceding blocked evidence');
      const worker: FencedWorkerIdentity = { ...pending.context, pid: 98765, pgid: 98765, sid: 98765, startTime: '12345678' };
      const receipt = { ...worker, version: 1 as const, token, commandSHA: pending.commandSHA };
      const ok = model.commandFailure !== action;
      inspections.set(token, { state: 'settled', receipt,
        result: { version: 1, token, commandSHA: pending.commandSHA, worker, ok, stdout: '', code: ok ? '' : 'NETWORK_COMMAND_FAILED' } });
      if (action === 'start') {
        assert.equal(stored.selected, preview.candidate.id);
        assert.equal(await readFile(proposed.selectedPath, 'utf8'), canonicalJson(preview.candidate.config));
      }
      if (!ok) throw new Error(secret);
      model.observed = { ...model.observed, controlGroup: action === 'start' ? group : '', state: { ...model.observed.state,
        mainPid: action === 'start' ? 34568 : 0, activeState: action === 'start' ? 'active' : 'inactive',
        subState: action === 'start' ? 'running' : 'dead', jobPending: false } };
      await model.commandHook?.(action);
    },
    async inspect(token, settle) {
      calls.push('inspect:' + (settle ? 'settle' : 'readonly'));
      const value = structuredClone(inspections.get(token) ?? { state: 'absent' as const });
      return model.inspectHook ? model.inspectHook(token, settle, value) : value;
    },
    async emptyCgroup() { calls.push('empty'); assert.equal(model.observed.state.mainPid, 0); assert.equal(model.observed.state.jobPending, false); },
  };
  const settings = { runtime: proposed.settings, coreHome: proposed.coreHome };
  const runtime = GatewayCoreRuntime.fixture(settings, dependencies);
  const blocked = async () => {
    model.blockedCalls++; calls.push('blocked');
    if (model.blockedFailureAt === model.blockedCalls) throw new Error(secret);
  };
  return { parent, proposed, preview, journalPath, journal, calls, commands, inspections, model, dependencies, settings, runtime, blocked };
}

async function tree(path: string): Promise<string> {
  const entries: string[] = [];
  async function visit(at: string, relative: string) {
    for (const entry of (await readdir(at, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const child = join(at, entry.name), name = relative + '/' + entry.name;
      if (entry.isDirectory()) { entries.push(name + '/'); await visit(child, name); }
      else entries.push(name + ':' + sha(await readFile(child)));
    }
  }
  await visit(path, ''); return entries.join('\n');
}

test('gateway ensure proves blocking, completely stops, selects canonical credentials, then starts the fixed unit', linux, async t => {
  const f = await fixture(t);
  await f.runtime.ensure(f.preview.networkPlan.deployment, f.blocked);
  assert.deepEqual(f.commands, ['stop', 'start']);
  const stopped = f.calls.indexOf('command:stop'), empty = f.calls.indexOf('empty'), started = f.calls.indexOf('command:start');
  assert.ok(f.calls.indexOf('validate') < stopped);
  assert.ok(f.calls.indexOf('blocked') < stopped && stopped < empty && empty < started);
  assert.ok(f.calls.slice(empty + 1, started).includes('blocked'), 'starting needs fresh blocked evidence after selecting credentials');
  const state = await f.journal();
  assert.equal(state.selected, f.preview.candidate.id); assert.equal(state.pending, null);
  assert.equal(sha(await readFile(f.proposed.selectedPath)), state.selected);
  assert.equal((await lstat(f.proposed.selectedPath)).mode & 0o777, 0o600);
  assert.equal((await lstat(f.proposed.settings.stateDirectory)).mode & 0o777, 0o700);
});

test('gateway assertSettled is strictly read-only for missing and completed journals', linux, async t => {
  const f = await fixture(t), before = await tree(f.proposed.settings.stateDirectory);
  await f.runtime.assertSettled();
  assert.equal(await tree(f.proposed.settings.stateDirectory), before);
  assert.deepEqual(f.commands, []); assert.equal(f.calls.some(call => call.startsWith('inspect:')), false);
  await f.runtime.ensure(f.preview.networkPlan.deployment, f.blocked);
  const complete = await tree(f.proposed.settings.stateDirectory); f.calls.length = 0;
  await f.runtime.assertSettled();
  assert.equal(await tree(f.proposed.settings.stateDirectory), complete);
  assert.deepEqual(f.calls, ['preflight', 'show']);
});

test('gateway read-only settlement refuses unknown workers and manager jobs without clearing pending', linux, async t => {
  const f = await fixture(t); f.model.commandFailure = 'start';
  await assert.rejects(f.runtime.ensure(f.preview.networkPlan.deployment, f.blocked), failed);
  const before = await tree(f.proposed.settings.stateDirectory), prior = await f.journal();
  f.calls.length = 0;
  await f.runtime.assertSettled();
  assert.ok(f.calls.includes('inspect:readonly')); assert.equal(f.calls.includes('inspect:settle'), false);
  assert.equal(await tree(f.proposed.settings.stateDirectory), before, 'a settled failed job remains recorded until explicit recovery');
  for (const state of ['running', 'uncertain'] as const) {
    f.model.inspectHook = async (_token, settle, value) => { assert.equal(settle, false); return { ...value, state }; };
    f.calls.length = 0;
    await assert.rejects(f.runtime.assertSettled(), failed);
    assert.ok(f.calls.includes('inspect:readonly')); assert.equal(f.calls.includes('inspect:settle'), false);
    assert.equal(await tree(f.proposed.settings.stateDirectory), before);
  }
  f.model.inspectHook = undefined; f.model.observed.state.jobPending = true;
  await assert.rejects(f.runtime.assertSettled(), failed);
  assert.deepEqual(await f.journal(), prior); assert.deepEqual(f.commands, ['stop', 'start']);
});

test('gateway settlement preflight and explicit settlement do not initialize missing journals or storage', linux, async t => {
  const f = await fixture(t);
  for (const missingRoot of [false, true]) {
    if (missingRoot) await rm(f.proposed.settings.stateDirectory, { recursive: true });
    const before = await tree(f.parent);
    await f.runtime.preflightSettlement(); await f.runtime.settlePending();
    assert.equal(await tree(f.parent), before);
    f.model.observed.state.jobPending = true;
    await assert.rejects(f.runtime.preflightSettlement(), failed);
    await assert.rejects(f.runtime.settlePending(), failed);
    assert.equal(await tree(f.parent), before);
    f.model.observed.state.jobPending = false;
  }
  assert.deepEqual(f.commands, []); assert.equal(f.calls.includes('inspect:settle'), false);
});

test('gateway checks the old receipt before every settlement path can signal a worker', linux, async t => {
  for (const kind of ['unknown-worker', 'uncertain', 'wrong-token', 'wrong-command', 'wrong-context', 'wrong-result-worker'] as const) {
    await t.test(kind, async child => {
      const f = await fixture(child); f.model.commandFailure = 'start';
      await assert.rejects(f.runtime.ensure(f.preview.networkPlan.deployment, f.blocked), failed);
      const before = await tree(f.proposed.settings.stateDirectory);
      f.model.inspectHook = async (_token, settle, value) => {
        assert.equal(settle, false, 'unverified worker must never reach the signaling seam');
        value.state = kind === 'uncertain' ? 'uncertain' : 'running';
        if (kind === 'unknown-worker') return { state: 'running' };
        if (kind === 'wrong-token') value.receipt!.token = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
        if (kind === 'wrong-command') value.receipt!.commandSHA = '0'.repeat(64);
        if (kind === 'wrong-context') value.receipt!.netNS = 'net:[1]';
        if (kind === 'wrong-result-worker') value.result!.worker.startTime = '999';
        return value;
      };
      f.calls.length = 0;
      for (const operation of [() => f.runtime.preflightSettlement(), () => f.runtime.settlePending(),
        () => f.runtime.ensure(f.preview.networkPlan.deployment, f.blocked), () => f.runtime.recoverStopped(f.blocked)]) {
        await assert.rejects(operation(), failed);
        assert.equal(await tree(f.proposed.settings.stateDirectory), before);
      }
      assert.equal(f.calls.includes('inspect:settle'), false); assert.deepEqual(f.commands, ['stop', 'start']);
    });
  }
});

test('gateway explicit settlement terminates only the bound worker, waits for its manager job and retains the durable pending', linux, async t => {
  const f = await fixture(t); f.model.commandFailure = 'start';
  await assert.rejects(f.runtime.ensure(f.preview.networkPlan.deployment, f.blocked), failed);
  const old = await f.journal(), before = await tree(f.proposed.settings.stateDirectory), blockedCalls = f.model.blockedCalls;
  const receipt = f.inspections.get(old.pending!.token)!; receipt.state = 'running'; delete receipt.result;
  f.model.observed.state.jobPending = true;
  let signaled = false, managerReads = 0;
  f.model.inspectHook = async (token, settle, value) => {
    assert.equal(token, old.pending!.token);
    if (settle) { signaled = true; f.inspections.get(token)!.state = 'settled'; value.state = 'settled'; }
    return value;
  };
  f.model.showHook = async () => {
    if (signaled && ++managerReads === 3) f.model.observed.state.jobPending = false;
  };
  f.calls.length = 0;
  await f.runtime.preflightSettlement();
  assert.equal(signaled, false); assert.deepEqual(f.calls, ['preflight', 'inspect:readonly', 'show']);
  await assert.rejects(f.runtime.assertSettled(), failed);
  await f.runtime.settlePending();
  assert.equal(signaled, true); assert.equal(managerReads, 3);
  assert.ok(f.calls.indexOf('inspect:readonly') < f.calls.indexOf('inspect:settle'));
  assert.ok(f.calls.lastIndexOf('inspect:readonly') > f.calls.indexOf('inspect:settle'));
  assert.equal(await tree(f.proposed.settings.stateDirectory), before);
  assert.deepEqual(await f.journal(), old); assert.equal(f.model.blockedCalls, blockedCalls);
  assert.deepEqual(f.commands, ['stop', 'start']);
  await f.runtime.assertSettled();
});

test('gateway settlement fails boundedly on a persistent manager job or changed worker binding without clearing pending', linux, async t => {
  for (const changedWorker of [false, true]) {
    const f = await fixture(t); f.model.commandFailure = 'start';
    await assert.rejects(f.runtime.ensure(f.preview.networkPlan.deployment, f.blocked), failed);
    const old = await f.journal(), before = await tree(f.proposed.settings.stateDirectory);
    f.model.observed.state.jobPending = !changedWorker;
    if (changedWorker) {
      f.inspections.get(old.pending!.token)!.state = 'running';
      f.model.inspectHook = async (_token, settle, value) => {
        if (settle) {
          value.state = 'settled'; value.receipt!.startTime = '999';
          value.result!.worker.startTime = '999';
        }
        return value;
      };
    }
    const started = performance.now();
    await assert.rejects(f.runtime.settlePending(), failed);
    assert.ok(performance.now() - started < 5000, 'manager settlement has a short fixed bound');
    assert.equal(await tree(f.proposed.settings.stateDirectory), before);
    assert.deepEqual(await f.journal(), old); assert.deepEqual(f.commands, ['stop', 'start']);
  }
});

test('gateway issue requires a bound successful worker result and confirmed manager completion', linux, async t => {
  for (const kind of ['absent', 'no-result', 'failed-result', 'wrong-token', 'wrong-command', 'wrong-context',
    'wrong-result-token', 'wrong-result-command', 'wrong-result-worker', 'job', 'live-pid', 'populated-cgroup'] as const) {
    await t.test(kind, async child => {
      const f = await fixture(child);
      f.model.inspectHook = async (_token, _settle, value) => {
        if (kind === 'absent') return { state: 'absent' };
        if (kind === 'no-result') return { state: 'settled', receipt: value.receipt };
        if (kind === 'failed-result') value.result = { ...value.result!, ok: false, code: 'NETWORK_COMMAND_FAILED' };
        if (kind === 'wrong-token') value.receipt!.token = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
        if (kind === 'wrong-command') value.receipt!.commandSHA = '0'.repeat(64);
        if (kind === 'wrong-context') value.receipt!.netNS = 'net:[1]';
        if (kind === 'wrong-result-token') value.result!.token = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
        if (kind === 'wrong-result-command') value.result!.commandSHA = '0'.repeat(64);
        if (kind === 'wrong-result-worker') value.result!.worker.startTime = '999';
        return value;
      };
      if (kind === 'job') f.model.commandHook = async () => { f.model.observed.state.jobPending = true; };
      if (kind === 'live-pid') f.model.commandHook = async () => { f.model.observed.state.mainPid = 34567; };
      const runtime = kind === 'populated-cgroup' ? GatewayCoreRuntime.fixture(f.settings,
        { ...f.dependencies, emptyCgroup: async () => { throw new Error(secret); } }) : f.runtime;
      await assert.rejects(runtime.ensure(f.preview.networkPlan.deployment, f.blocked), failed);
      assert.deepEqual(f.commands, ['stop']); assert.equal((await f.journal()).pending!.action, 'stop');
      await assert.rejects(lstat(f.proposed.selectedPath), { code: 'ENOENT' });
    });
  }
});

test('gateway explicit recovery never starts and preserves an old pending until its settlement is proven', linux, async t => {
  const f = await fixture(t); f.model.commandFailure = 'start';
  await assert.rejects(f.runtime.ensure(f.preview.networkPlan.deployment, f.blocked), failed);
  const old = await f.journal(), raw = await readFile(f.journalPath, 'utf8'), selected = await readFile(f.proposed.selectedPath, 'utf8');
  f.model.inspectHook = async (token, settle, value) => {
    assert.equal(token, old.pending!.token); assert.equal(settle, false); return { ...value, state: 'uncertain' };
  };
  await assert.rejects(f.runtime.recoverStopped(f.blocked), failed);
  assert.equal(await readFile(f.journalPath, 'utf8'), raw); assert.deepEqual(f.commands, ['stop', 'start']);
  f.model.inspectHook = undefined; f.model.commandFailure = null;
  await f.runtime.recoverStopped(f.blocked);
  assert.deepEqual(f.commands, ['stop', 'start', 'stop']);
  assert.equal((await f.journal()).pending, null); assert.equal((await f.journal()).selected, old.selected);
  assert.equal(await readFile(f.proposed.selectedPath, 'utf8'), selected);
});

test('gateway refuses core mutation when blocked proof is missing, including after persisting the command fence', linux, async t => {
  for (const blockedFailureAt of [1, 2]) {
    const f = await fixture(t); f.model.blockedFailureAt = blockedFailureAt;
    await assert.rejects(f.runtime.ensure(f.preview.networkPlan.deployment, f.blocked), failed);
    assert.deepEqual(f.commands, []);
    await assert.rejects(lstat(f.proposed.selectedPath), { code: 'ENOENT' });
  }
  const f = await fixture(t); f.model.blockedFailureAt = 1;
  const missing = undefined as unknown as () => Promise<void>;
  await assert.rejects(f.runtime.ensure(f.preview.networkPlan.deployment, missing), failed);
  await assert.rejects(f.runtime.recoverStopped(missing), failed);
  await assert.rejects(f.runtime.recoverStopped(f.blocked), failed);
  assert.deepEqual(f.commands, []); assert.equal(f.calls.includes('inspect:settle'), false);
});

test('gateway oversized canonical credentials are rejected before stop, selection, validation or start', linux, async t => {
  const f = await fixture(t, secret + 'x'.repeat(1_000_001));
  assert.ok(Buffer.byteLength(canonicalJson(f.preview.candidate.config)) > 1_000_000);
  await assert.rejects(f.runtime.ensure(f.preview.networkPlan.deployment, f.blocked), failed);
  assert.deepEqual(f.commands, []); assert.equal(f.model.blockedCalls, 0); assert.equal(f.calls.includes('validate'), false);
  await assert.rejects(lstat(f.journalPath), { code: 'ENOENT' });
  await assert.rejects(lstat(f.proposed.selectedPath), { code: 'ENOENT' });
});

test('gateway fixture scope cannot become production and inspection never asserts readiness', linux, async t => {
  const f = await fixture(t);
  if (process.geteuid?.() !== 0) assert.throws(() => GatewayCoreRuntime.production(f.settings), failed);
  assert.throws(() => GatewayCoreRuntime.fixture(f.settings, { ...f.dependencies, scope: 'production' } as GatewayRuntimeFixtureDependencies), failed);
  const runtime = f.runtime;
  assert.equal(runtime.scope, 'fixture');
  await runtime.ensure(f.preview.networkPlan.deployment, f.blocked);
  const result = await runtime.inspect();
  assert.equal(result.scope, 'fixture'); assert.equal(result.readiness, 'unknown');
  assert.equal(result.generation, f.preview.candidate.id); assert.equal(result.operationPending, false);
  assert.equal(Object.hasOwn(result, 'ready'), false); assert.equal(JSON.stringify(result).includes(secret), false);
  const stored = JSON.parse(await readFile(f.journalPath, 'utf8'));
  stored.scope = 'production';
  await writeFile(f.journalPath, JSON.stringify(stored), { mode: 0o600 });
  await assert.rejects(runtime.assertSettled(), failed);
  assert.equal(runtime.scope, 'fixture'); assert.deepEqual(f.commands, ['stop', 'start']);
});

test('gateway fixture rejects missing or partial dependencies instead of selecting a production backend', linux, async t => {
  const f = await fixture(t);
  for (const dependencies of [undefined, null, {}, { ...f.dependencies, inspect: undefined }]) {
    assert.throws(() => GatewayCoreRuntime.fixture(f.settings, dependencies as unknown as GatewayRuntimeFixtureDependencies), failed);
  }
  assert.deepEqual(f.commands, []);
});

test('gateway managers serialize the real filesystem lock and never overlap systemd mutations', linux, async t => {
  const f = await fixture(t);
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  let paused = false;
  f.model.commandHook = async action => { if (action === 'stop' && !paused) { paused = true; entered(); await held; } };
  const holder = f.runtime.ensure(f.preview.networkPlan.deployment, f.blocked);
  await started;
  try {
    const contender = GatewayCoreRuntime.fixture(f.settings, f.dependencies);
    await assert.rejects(contender.ensure(f.preview.networkPlan.deployment, f.blocked), failed);
    assert.deepEqual(f.commands, ['stop']);
    await assert.rejects(f.runtime.recoverStopped(f.blocked), failed);
  } finally { release(); await holder; }
  assert.deepEqual(f.commands, ['stop', 'start']);
  await assert.rejects(lstat(join(f.proposed.settings.stateDirectory, '.lock')), { code: 'ENOENT' });
});

test('gateway lifecycle failures expose fixed driver errors without private diagnostics', linux, async t => {
  const f = await fixture(t);
  const validationFailure = GatewayCoreRuntime.fixture(f.settings, { ...f.dependencies, validate: async () => { throw new Error(secret); } });
  await assert.rejects(validationFailure.ensure(f.preview.networkPlan.deployment, f.blocked), failed);
  assert.deepEqual(f.commands, []);
  const readonlyFailure = GatewayCoreRuntime.fixture(f.settings, { ...f.dependencies, preflight: async () => { throw new Error(secret); } });
  for (const operation of [() => readonlyFailure.preflight(f.preview.networkPlan.deployment), () => readonlyFailure.assertSettled(),
    () => readonlyFailure.inspect(), () => readonlyFailure.recoverStopped(f.blocked)]) await assert.rejects(operation(), failed);
});
