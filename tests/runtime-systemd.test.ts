import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compileConfig } from '../packages/config/index.ts';
import { FileTransactionStore, TransactionManager, TransactionError } from '../packages/transaction/index.ts';
import { runRuntimeCommand } from '../packages/runtime/command.ts';
import { parseUnitState, SystemdMihomoRuntime } from '../packages/runtime/systemd.ts';
import { readSelection } from '../packages/runtime/settings.ts';
import { RuntimeError } from '../packages/runtime/types.ts';
import type { RuntimeSettings, RuntimeUnitState } from '../packages/runtime/types.ts';
import { AUTOMATIC_GATEWAY_CORE_SHA256 } from '../packages/gateway/profile.ts';

const linux = process.platform === 'linux';
const secret = 'SYNTHETIC_SYSTEMD_TEST_PRIVATE_VALUE';

function candidate(label: string) {
  return compileConfig({ schemaVersion: 1, deployment: {
    mixedPort: 17890, controllerPort: 19090, controllerSecret: secret,
    dnsPort: 15353, bootstrapResolvers: ['192.0.2.53'],
  }, policy: { rules: ['MATCH,DIRECT'], 'log-level': label } });
}

function show(unit: RuntimeUnitState): string {
  return [
    `LoadState=${unit.loadState}`, `ActiveState=${unit.activeState}`, `SubState=${unit.subState}`,
    `MainPID=${unit.mainPid}`, `Job=${unit.jobPending ? '91' : ''}`, `FragmentPath=${unit.fragmentPath}`,
    `DropInPaths=${unit.hasDropIns ? '/synthetic/override.conf' : ''}`,
    `NeedDaemonReload=${unit.needsReload ? 'yes' : 'no'}`, `User=${unit.user}`, '',
  ].join('\n');
}

const runtimeCode = (code: string) => (error: unknown): boolean => {
  assert.ok(error instanceof RuntimeError);
  assert.equal(error.code, code);
  assert.equal(error.message, code);
  assert.ok(!String(error).includes(secret));
  return true;
};

const transactionCode = (code: string) => (error: unknown): boolean => {
  assert.ok(error instanceof TransactionError);
  assert.equal(error.code, code);
  assert.ok(!String(error).includes(secret));
  return true;
};

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'cocoproxy-systemd-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const settings: RuntimeSettings = { schemaVersion: 1, stateDirectory: join(root, 'state'),
    binaryPath: '/synthetic/pinned-core', binarySha256: 'a'.repeat(64), systemctlPath: '/synthetic/systemctl',
    unitPath: '/synthetic/cocoproxy-mihomo.service', unitSha256: 'b'.repeat(64), serviceUid: 12345 };
  const store = new FileTransactionStore(settings.stateDirectory);
  const first = candidate('warning');
  const second = candidate('error');
  await store.stage(first);
  await store.stage(second);
  const writes: Parameters<FileTransactionStore['writeState']>[0][] = [];
  const writeState = store.writeState.bind(store);
  store.writeState = async state => { writes.push(structuredClone(state)); await writeState(state); };
  const unit: RuntimeUnitState = { loadState: 'loaded', activeState: 'inactive', subState: 'dead', mainPid: 0,
    jobPending: false, fragmentPath: settings.unitPath, hasDropIns: false, needsReload: false, user: String(settings.serviceUid) };
  const events: { action: string; selected: string | null; pending: boolean; pid: number }[] = [];
  const observed: { generation: string; activeAtObservation: string | null }[] = [];
  const behavior = { untrusted: false, unsettledStop: false, timeoutGeneration: null as string | null };
  const runtime = new SystemdMihomoRuntime(settings, {
    verifySystemctl: async supplied => { assert.equal(supplied.systemctlPath, settings.systemctlPath); return settings.systemctlPath; },
    assertUnit: async (supplied, observedUnit) => {
      assert.equal(supplied.unitSha256, settings.unitSha256);
      assert.equal(observedUnit.fragmentPath, settings.unitPath);
      assert.equal(observedUnit.user, String(settings.serviceUid));
      if (behavior.untrusted) throw new RuntimeError('UNIT_UNTRUSTED');
    },
    binary: async supplied => { assert.equal(supplied.binarySha256, settings.binarySha256); return settings.binaryPath; },
    validate: async (supplied, options) => {
      assert.ok([first.id, second.id].includes(supplied.id));
      assert.equal(options.binaryPath, settings.binaryPath);
    },
    command: async (binary, args) => {
      assert.equal(binary, settings.systemctlPath);
      assert.deepEqual(args.slice(0, 2), ['--no-ask-password', '--no-pager']);
      assert.equal(args.at(-1), 'cocoproxy-mihomo.service');
      const action = args[2];
      const selected = await readSelection(settings);
      events.push({ action, selected, pending: unit.jobPending, pid: unit.mainPid });
      if (action === 'show') return show(unit);
      if (action === 'stop') {
        if (behavior.unsettledStop) {
          unit.jobPending = true;
          return '';
        }
        Object.assign(unit, { activeState: 'inactive', subState: 'dead', mainPid: 0, jobPending: false });
        return '';
      }
      assert.equal(action, 'start');
      // The adapter must settle both the job and PID before asking for a successor.
      assert.equal(unit.jobPending, false);
      assert.equal(unit.mainPid, 0);
      assert.ok(selected === first.id || selected === second.id);
      if (selected === behavior.timeoutGeneration) {
        Object.assign(unit, { activeState: 'activating', subState: 'start', mainPid: 22002, jobPending: true });
        throw new RuntimeError('RUNTIME_COMMAND_TIMEOUT');
      }
      Object.assign(unit, { activeState: 'active', subState: 'running', mainPid: 22001, jobPending: false });
      return '';
    },
    observe: async (supplied, generation, observedUnit) => {
      assert.equal(supplied.stateDirectory, settings.stateDirectory);
      assert.equal(await readSelection(settings), generation);
      if (observedUnit.mainPid === 0) return { ready: false, generation, checkedAt: new Date().toISOString(), reason: 'CORE_STOPPED' };
      assert.equal(observedUnit.mainPid, 22001);
      assert.equal(observedUnit.jobPending, false);
      const state = await store.readState();
      observed.push({ generation, activeAtObservation: state.active });
      return { ready: true, generation, checkedAt: new Date().toISOString(), reason: null };
    },
  });
  return { settings, store, first, second, unit, runtime, manager: new TransactionManager(store, runtime), writes, events, observed, behavior };
}

test('systemd apply commits a new active generation only after its observation', { skip: !linux }, async t => {
  const f = await fixture(t);
  assert.equal((await f.manager.status()).active, null);
  assert.equal(f.events.length, 0);
  const status = await f.manager.apply(f.first.id, null);
  assert.equal(status.active, f.first.id);
  assert.equal(status.desired, f.first.id);
  assert.equal(status.transaction, null);
  assert.equal(status.fault, null);
  assert.equal(status.readiness, 'unknown');
  assert.deepEqual(f.observed, [{ generation: f.first.id, activeAtObservation: null }]);
  const transitions = f.writes.filter((state, index) => state.active === f.first.id && (index === 0 || f.writes[index - 1].active !== f.first.id));
  assert.equal(transitions.length, 1);
  assert.equal(transitions[0].pending?.phase, 'committed');
  assert.ok(f.writes.filter(state => state.pending?.phase !== 'committed' && state.pending !== null).every(state => state.active === null));
  assert.deepEqual(f.events.filter(event => event.action !== 'show').map(event => event.action), ['stop', 'start']);
  assert.equal(await readSelection(f.settings), f.first.id);
  const persisted = JSON.parse(await readFile(join(f.settings.stateDirectory, 'state.json'), 'utf8'));
  assert.equal(persisted.active, f.first.id);
  assert.equal(persisted.pending, null);
  assert.ok(!JSON.stringify(status).includes(secret));
  const calls = f.events.length;
  await assert.rejects(f.manager.apply(f.second.id, null), transactionCode('ACTIVE_CONFLICT'));
  assert.equal(f.events.length, calls);
});

test('a timed out start client leaves a job which is explicitly stopped before rollback', { skip: !linux }, async t => {
  const f = await fixture(t);
  await f.manager.apply(f.first.id, null);
  f.events.length = 0;
  f.writes.length = 0;
  f.observed.length = 0;
  f.behavior.timeoutGeneration = f.second.id;
  await assert.rejects(f.manager.apply(f.second.id, f.first.id), transactionCode('ACTIVATION_FAILED'));
  const start = f.events.findIndex(event => event.action === 'start' && event.selected === f.second.id);
  assert.ok(start >= 0);
  const afterTimeout = f.events.slice(start + 1);
  assert.ok(afterTimeout.some(event => event.action === 'show' && event.pending && event.pid === 22002));
  const stop = afterTimeout.findIndex(event => event.action === 'stop');
  const restore = afterTimeout.findIndex(event => event.action === 'start' && event.selected === f.first.id);
  assert.ok(stop >= 0 && restore > stop);
  assert.deepEqual(f.events.filter(event => event.action === 'start').map(event => event.selected), [f.second.id, f.first.id]);
  assert.ok(f.writes.every(state => state.active !== f.second.id));
  assert.deepEqual(f.observed, [{ generation: f.first.id, activeAtObservation: f.first.id }]);
  const status = await f.manager.status();
  assert.equal(status.active, f.first.id);
  assert.equal(status.desired, f.second.id);
  assert.equal(status.transaction, null);
  assert.equal(status.fault, null);
  assert.equal(await readSelection(f.settings), f.first.id);
  assert.equal(f.unit.jobPending, false);
});

test('an unsettled stop faults the transaction without selecting or starting the successor', { skip: !linux }, async t => {
  const f = await fixture(t);
  await f.manager.apply(f.first.id, null);
  f.events.length = 0;
  f.behavior.unsettledStop = true;
  await assert.rejects(f.manager.apply(f.second.id, f.first.id), transactionCode('RESTORE_FAILED'));
  assert.ok(f.events.filter(event => event.action === 'stop').length >= 2);
  assert.equal(f.events.filter(event => event.action === 'start').length, 0);
  assert.equal(await readSelection(f.settings), f.first.id);
  const status = await f.manager.status();
  assert.equal(status.active, null);
  assert.equal(status.desired, f.second.id);
  assert.equal(status.fault, 'RESTORE_FAILED');
  assert.equal(status.readiness, 'fault');
  assert.equal(status.transaction?.phase, 'fault');
});

test('an untrusted unit is rejected during validation before any service change', { skip: !linux }, async t => {
  const f = await fixture(t);
  f.behavior.untrusted = true;
  await assert.rejects(f.manager.apply(f.first.id, null), transactionCode('VALIDATION_FAILED'));
  assert.deepEqual(f.events.map(event => event.action), ['show']);
  assert.equal(await readSelection(f.settings), null);
  assert.deepEqual(f.observed, []);
  const status = await f.manager.status();
  assert.equal(status.active, null);
  assert.equal(status.transaction, null);
  assert.equal(status.fault, null);
});

test('persistent reconciliation retains a healthy process, defers systemd jobs and restores only active', { skip: !linux }, async t => {
  const f = await fixture(t);
  await f.manager.apply(f.first.id, null);
  f.events.length = 0;
  assert.equal(await f.runtime.reconcile(f.store.candidatePath(f.first.id), f.first.id), true);
  assert.deepEqual(f.events.filter(event => event.action !== 'show'), []);
  f.unit.jobPending = true;
  assert.equal(await f.runtime.reconcile(f.store.candidatePath(f.first.id), f.first.id), false);
  f.unit.jobPending = false;
  Object.assign(f.unit, { activeState: 'inactive', subState: 'dead', mainPid: 0 });
  assert.equal(await f.runtime.reconcile(f.store.candidatePath(f.first.id), f.first.id), true);
  assert.deepEqual(f.events.filter(event => event.action !== 'show').map(event => event.action), ['stop', 'start']);
  assert.equal((await f.store.status()).active, f.first.id);
});

test('gateway reconciliation uses only fixed start/reload permissions and never restarts a core after network rejection', { skip: !linux }, async t => {
  const f = await fixture(t);
  const commands: string[][] = [];
  const settings: RuntimeSettings = { ...f.settings, binarySha256: AUTOMATIC_GATEWAY_CORE_SHA256,
    automaticGateway: { schemaVersion: 1, ingressInterface: 'lan0', gatewayIPv4: '192.0.2.2', routerIPv4: '192.0.2.1',
      routerMAC: '02:00:00:00:00:01', clientCIDR: '192.0.2.0/24', prefixLength: 24, dnsPort: 15353,
      egressMark: 3030, egressTable: 3030, egressPriority: 8000, tunMtu: 1500 } };
  const runtime = new SystemdMihomoRuntime(settings, {
    platform: 'linux', verifySystemctl: async () => settings.systemctlPath,
    assertUnit: async () => {},
    load: async () => ({ candidate: f.first, path: f.store.candidatePath(f.first.id), home: '/synthetic/home', controller: { port: 19090, secret } }),
    command: async (_binary, args) => {
      commands.push(args);
      if (args[2] === 'show') return show(f.unit);
      if (args[2] === 'reload') throw new RuntimeError('RUNTIME_COMMAND_FAILED');
      assert.deepEqual(args, ['--no-ask-password', '--no-pager', 'start', 'cocoproxy-gateway-network.service']);
      return '';
    },
  });
  await assert.rejects(runtime.reconcile(f.store.candidatePath(f.first.id), f.first.id), runtimeCode('RUNTIME_COMMAND_FAILED'));
  assert.deepEqual(commands.filter(args => args[2] !== 'show'), [
    ['--no-ask-password', '--no-pager', 'start', 'cocoproxy-gateway-network.service'],
    ['--no-ask-password', '--no-pager', 'reload', 'cocoproxy-gateway-network.service'],
  ]);
});

test('systemd show parser rejects partial, duplicate, injected and malformed state', () => {
  const unit: RuntimeUnitState = { loadState: 'loaded', activeState: 'active', subState: 'running', mainPid: 22001,
    jobPending: false, fragmentPath: '/synthetic/cocoproxy-mihomo.service', hasDropIns: false, needsReload: false, user: '12345' };
  const good = show(unit);
  assert.deepEqual(parseUnitState(good), unit);
  assert.equal(parseUnitState(good.replace('Job=', 'Job=12')).jobPending, true);
  assert.equal(parseUnitState(good.replace('DropInPaths=', 'DropInPaths=/synthetic/override.conf')).hasDropIns, true);
  for (const invalid of [
    '', good.replace('LoadState=loaded\n', ''), good + 'MainPID=2\n', good + 'Unknown=yes\n',
    good.replace('MainPID=22001', 'MainPID=-1'), good.replace('MainPID=22001', 'MainPID=1.5'),
    good.replace('MainPID=22001', 'MainPID=9007199254740992'), good.replace('MainPID=22001', 'MainPID=01'),
    good.replace('NeedDaemonReload=no', 'NeedDaemonReload=maybe'), good.replace('LoadState=loaded', 'LoadState=loaded\0'),
    good.replace('ActiveState=active', 'ActiveState=active\r'), good.trimEnd() + '\r\n',
  ]) assert.throws(() => parseUnitState(invalid), runtimeCode('UNIT_STATE_INVALID'));
});

test('command fixture returns only bounded stdout and sanitizes stderr, exit, bytes and timeouts', { skip: !linux }, async () => {
  const run = (script: string, limits = {}) => runRuntimeCommand(process.execPath, ['-e', script], limits);
  assert.equal(await run(`process.stdout.write('approved');process.stderr.write(${JSON.stringify(secret)});`), 'approved');
  await assert.rejects(run(`process.stderr.write(${JSON.stringify(secret)});process.exitCode=7;`), runtimeCode('RUNTIME_COMMAND_FAILED'));
  await assert.rejects(run(`process.stdout.write(Buffer.from([255]));`), runtimeCode('RUNTIME_COMMAND_INVALID_OUTPUT'));
  await assert.rejects(run(`process.stderr.write(${JSON.stringify(secret)}.repeat(1024));`, { maxOutputBytes: 64 }), runtimeCode('RUNTIME_COMMAND_OUTPUT_LIMIT'));
  await assert.rejects(run(`process.stderr.write(${JSON.stringify(secret)});process.on('SIGTERM',()=>{});setInterval(()=>{},1000);`, { timeoutMs: 50 }), runtimeCode('RUNTIME_COMMAND_TIMEOUT'));
  await assert.rejects(runRuntimeCommand('/synthetic/absent-command', []), runtimeCode('RUNTIME_COMMAND_UNAVAILABLE'));
});

test('command fixture rejects invalid limits and NUL arguments without raw spawn diagnostics', { skip: !linux }, async () => {
  assert.throws(() => runRuntimeCommand(process.execPath, [], { timeoutMs: 0 }), runtimeCode('RUNTIME_COMMAND_INVALID'));
  assert.throws(() => runRuntimeCommand(process.execPath, [], { maxOutputBytes: -1 }), runtimeCode('RUNTIME_COMMAND_INVALID'));
  await assert.rejects(async () => runRuntimeCommand(process.execPath, ['-e', secret + '\0']), runtimeCode('RUNTIME_COMMAND_INVALID'));
});
