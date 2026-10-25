import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { canonicalJson, compileConfig } from '../packages/config/index.ts';
import type { Candidate, JsonObject } from '../packages/config/index.ts';
import { FileTransactionStore, TransactionManager } from '../packages/transaction/index.ts';
import { SystemdMihomoRuntime } from '../packages/runtime/systemd.ts';
import { inspectCoreFixture, observeCoreFixture } from '../packages/runtime/observer.ts';
import type { CoreObserverFixtureReader } from '../packages/runtime/observer.ts';
import { manualSelections, selectionChanges, setControllerSelection, verifyControllerSelections } from '../packages/runtime/selections.ts';
import type { CoreInspection, RuntimeProcessIdentity, RuntimeSelection, RuntimeSettings, RuntimeUnitState } from '../packages/runtime/types.ts';

const bootId = '12345678-1234-1234-1234-123456789abc';
const settings: RuntimeSettings = { schemaVersion: 1, stateDirectory: '/synthetic/state', binaryPath: '/synthetic/core',
  binarySha256: 'a'.repeat(64), systemctlPath: '/synthetic/systemctl', unitPath: '/synthetic/cocoproxy-mihomo.service',
  unitSha256: 'b'.repeat(64), serviceUid: 12345 };
function candidate(reversed = false, log = 'warning'): Candidate {
  return compileConfig({ schemaVersion: 1, deployment: { mixedPort: 17890, controllerPort: 19090,
    controllerSecret: 'synthetic-hot-selection-secret', dnsPort: 15353, bootstrapResolvers: ['192.0.2.53'] },
  policy: { rules: ['MATCH,Manual'], profile: { 'store-selected': false }, 'log-level': log,
    'proxy-groups': ['Manual', 'Secondary'].map(name => ({ name, type: 'select', proxies: reversed ? ['REJECT', 'DIRECT'] : ['DIRECT', 'REJECT'] })) } });
}
const unitState = (): RuntimeUnitState => ({ loadState: 'loaded', activeState: 'inactive', subState: 'dead', mainPid: 0,
  jobPending: false, fragmentPath: settings.unitPath, hasDropIns: false, needsReload: false, user: String(settings.serviceUid) });
const show = (unit: RuntimeUnitState) => [`LoadState=${unit.loadState}`, `ActiveState=${unit.activeState}`, `SubState=${unit.subState}`,
  `MainPID=${unit.mainPid}`, 'Job=', `FragmentPath=${unit.fragmentPath}`, 'DropInPaths=', 'NeedDaemonReload=no', `User=${unit.user}`, ''].join('\n');

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'cocoproxy-hot-selection-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new FileTransactionStore(root), first = candidate(), second = candidate(true), changed = candidate(true, 'error');
  const candidates = new Map([first, second, changed].map(value => [value.id, value]));
  for (const value of candidates.values()) await store.stage(value);
  let selected: RuntimeSelection | null = null, physical: RuntimeProcessIdentity | undefined;
  const unit = unitState(), choices = new Map<string, string>(), events: string[] = [];
  const faults = { group: '', restartAfterWrite: false, lateWrite: false, untrustedGeneration: '' };
  const inspect = async (_settings: RuntimeSettings, generation: string, _unit?: RuntimeUnitState): Promise<CoreInspection> => {
    const value = candidates.get(generation)!;
    const desired = manualSelections(value.config)!;
    const receipt = selected?.hot;
    const ready = !!physical && selected?.generation === generation &&
      (physical.baseGeneration === generation || !!receipt && canonicalJson(receipt as unknown as JsonObject) === canonicalJson(physical as unknown as JsonObject)) &&
      desired.every(choice => choices.get(choice.group) === choice.name);
    return { ready, generation, reason: ready ? null : 'PROCESS_UNVERIFIED', checkedAt: new Date().toISOString(), ...(ready ? { process: physical } : {}) };
  };
  const runtime = new SystemdMihomoRuntime(settings, {
    platform: 'linux', verifySystemctl: async () => settings.systemctlPath, assertUnit: async () => {},
    binary: async () => settings.binaryPath, validate: async () => {}, inspect,
    observe: async (...args) => { const { process: _process, ...result } = await inspect(...args); return result; },
    load: async (_settings, generation) => {
      if (generation === faults.untrustedGeneration) throw new Error('synthetic deployment migration');
      return { candidate: candidates.get(generation)!, path: store.candidatePath(generation),
        home: '/synthetic/state/core-home', controller: { port: 19090, secret: 'synthetic-hot-selection-secret' } };
    },
    readSelection: async () => structuredClone(selected),
    writeSelection: async (_settings, selection) => {
      selected = structuredClone(selection);
      if (faults.restartAfterWrite && selection.hot) {
        physical = { ...physical!, pid: physical!.pid + 1, startTime: String(Number(physical!.startTime) + 1), baseGeneration: selection.generation };
        unit.mainPid = physical.pid;
      }
    },
    setSelection: async (_port, _secret, group, name) => {
      events.push(`put:${group}:${name}`);
      if (group === faults.group) throw new Error('synthetic failure');
      if (faults.lateWrite) await new Promise(resolve => setTimeout(resolve, 20));
      choices.set(group, name);
    },
    command: async (_binary, args) => {
      const action = args[2];
      if (action === 'show') return show(unit);
      events.push(action);
      if (action === 'stop') {
        Object.assign(unit, { activeState: 'inactive', subState: 'dead', mainPid: 0 }); physical = undefined;
      } else {
        assert.equal(action, 'start'); assert.ok(selected);
        physical = { pid: 22001, bootId, startTime: '42', baseGeneration: selected.generation };
        Object.assign(unit, { activeState: 'active', subState: 'running', mainPid: physical.pid });
        for (const choice of manualSelections(candidates.get(selected.generation)!.config)!) choices.set(choice.group, choice.name);
      }
      return '';
    },
  });
  const manager = new TransactionManager(store, runtime);
  await manager.apply(first.id, null); events.length = 0;
  return { store, runtime, manager, first, second, changed, candidates, choices, events, faults,
    selected: () => selected, physical: () => physical };
}

test('manual selection commits immutable generations without stopping the physical process and keeps one base receipt', async t => {
  const f = await fixture(t), original = structuredClone(f.physical());
  const state = await f.manager.apply(f.second.id, f.first.id);
  assert.equal(state.active, f.second.id); assert.equal(state.transaction, null);
  assert.deepEqual(f.events, ['put:Manual:REJECT', 'put:Secondary:REJECT']);
  assert.deepEqual(f.physical(), original); assert.deepEqual(f.selected()?.hot, original);
  assert.equal(f.selected()?.generation, f.second.id);
  f.events.length = 0;
  await f.manager.apply(f.first.id, f.second.id);
  assert.deepEqual(f.events, ['put:Manual:DIRECT', 'put:Secondary:DIRECT']);
  assert.deepEqual(f.selected()?.hot, original);
  assert.equal((await f.store.readState()).active, f.first.id);
});

test('non-selection changes restart normally, and a failed partial update restores the committed predecessor', async t => {
  const unrelated = await fixture(t);
  await unrelated.manager.apply(unrelated.changed.id, unrelated.first.id);
  assert.deepEqual(unrelated.events, ['stop', 'start']); assert.equal(unrelated.selected()?.hot, undefined);
  const partial = await fixture(t); partial.faults.group = 'Secondary'; partial.faults.lateWrite = true;
  await assert.rejects(partial.manager.apply(partial.second.id, partial.first.id), { code: 'ACTIVATION_FAILED' });
  assert.deepEqual(partial.events, ['put:Manual:REJECT', 'put:Secondary:REJECT', 'stop', 'start']);
  assert.equal((await partial.store.readState()).active, partial.first.id);
  assert.equal(partial.selected()?.generation, partial.first.id); assert.equal(partial.selected()?.hot, undefined);
  assert.ok([...partial.choices.values()].every(choice => choice === 'DIRECT'));
});

test('an old candidate invalidated by reviewed deployment migration cannot block a verified full activation', async t => {
  const f = await fixture(t); f.faults.untrustedGeneration = f.first.id;
  const status = await f.manager.apply(f.second.id, f.first.id);
  assert.equal(status.active, f.second.id); assert.equal(f.selected()?.generation, f.second.id);
  assert.deepEqual(f.events, ['stop', 'start']); assert.equal(f.selected()?.hot, undefined);
});

test('a crash before commit is durably recovered and a concurrent restart cannot reuse the old process receipt', async t => {
  const crashed = await fixture(t), write = crashed.store.writeState.bind(crashed.store);
  let once = true;
  crashed.store.writeState = async state => {
    if (once && state.pending?.phase === 'confirming') { once = false; throw new Error('synthetic crash'); }
    await write(state);
  };
  await assert.rejects(crashed.manager.apply(crashed.second.id, crashed.first.id), { code: 'STORE_IO' });
  assert.equal((await crashed.store.readState()).pending?.phase, 'activating');
  assert.equal(crashed.selected()?.generation, crashed.second.id);
  await new TransactionManager(crashed.store, crashed.runtime).recover();
  assert.equal((await crashed.store.readState()).active, crashed.first.id);
  assert.equal(crashed.selected()?.generation, crashed.first.id);
  assert.deepEqual(crashed.events.slice(-2), ['stop', 'start']);
  const restarted = await fixture(t); restarted.faults.restartAfterWrite = true;
  await assert.rejects(restarted.manager.apply(restarted.second.id, restarted.first.id), { code: 'ACTIVATION_FAILED' });
  assert.equal((await restarted.store.readState()).active, restarted.first.id);
  assert.deepEqual(restarted.events.slice(-2), ['stop', 'start']);
});

test('selection eligibility refuses every change outside identical select membership and order', () => {
  const first = candidate().config, next = candidate(true).config;
  assert.equal(selectionChanges(first, next)?.length, 2);
  for (const modified of [
    { ...next, profile: { 'store-selected': true } }, { ...next, secret: 'other' }, { ...next, rules: ['MATCH,REJECT'] },
    { ...next, 'proxy-groups': [{ name: 'Manual', type: 'select', proxies: ['REJECT'] }] },
    { ...next, 'proxy-groups': [{ name: 'Manual', type: 'url-test', proxies: ['DIRECT', 'REJECT'] }] },
  ]) assert.equal(selectionChanges(first, modified), null);
});

function observerFixture() {
  const first = candidate(), second = candidate(true), pid = 22001, unit = { ...unitState(), activeState: 'active', subState: 'running', mainPid: pid };
  const path = (id: string) => `/synthetic/state/candidates/${id}.json`, home = '/synthetic/state/core-home';
  const hot: RuntimeProcessIdentity = { pid, bootId, startTime: '42', baseGeneration: first.id };
  const receipt: RuntimeSelection = { schemaVersion: 1, generation: second.id, hot };
  const files = new Map<string, string>([
    ['/proc/sys/kernel/random/boot_id', bootId + '\n'],
    [`/proc/${pid}/stat`, `${pid} (synthetic core) S ${'0 '.repeat(18)}42\n`],
    [`/proc/${pid}/status`, `Uid:\t12345\t12345\t12345\t12345\nCapPrm:\t0\n`],
    [`/proc/${pid}/cmdline`, [settings.binaryPath, '-d', home, '-f', path(first.id), ''].join('\0')],
    [`/proc/${pid}/net/tcp`, 'header\n0: 0100007F:4A92 00000000:0000 0A 0 0 0 0 0 777\n'],
  ]);
  const reader: CoreObserverFixtureReader = {
    platform: 'linux', read: async name => Buffer.from(files.get(name) ?? ''), realpath: async () => settings.binaryPath,
    entries: async () => ['7'], link: async () => 'socket:[777]', unit: async () => {}, binary: async () => settings.binaryPath,
    candidate: async (_settings, id) => ({ candidate: id === first.id ? first : second, path: path(id), home,
      controller: { port: 19090, secret: 'synthetic-hot-selection-secret' } }),
    version: async () => {}, selection: async () => receipt,
    selections: async (_port, _secret, selections) => assert.deepEqual(selections, [{ group: 'Manual', name: 'REJECT' }, { group: 'Secondary', name: 'REJECT' }]),
  };
  return { first, second, pid, unit, reader, receipt, files, path, home,
    observe: () => observeCoreFixture(settings, second.id, unit, reader),
    inspect: () => inspectCoreFixture(settings, second.id, unit, reader) };
}

test('receipt observation retains process/controller checks, rejects recycled identity and accepts a normal target restart', async () => {
  const good = observerFixture();
  assert.equal((await good.observe()).ready, true); assert.deepEqual((await good.inspect()).process, good.receipt.hot);
  assert.equal('process' in await good.observe(), false);
  const mutations: ((f: ReturnType<typeof observerFixture>) => void)[] = [
    f => { f.receipt.hot!.pid++; }, f => { f.receipt.hot!.bootId = '87654321-1234-1234-1234-123456789abc'; },
    f => { f.receipt.hot!.startTime = '43'; }, f => { f.reader.link = async () => 'socket:[999]'; },
    f => { f.reader.realpath = async () => '/synthetic/wrong-core'; },
    f => { f.reader.selections = async () => { throw new Error('wrong choice'); }; },
    f => { f.reader.version = async () => { f.files.set(`/proc/${f.pid}/stat`, `${f.pid} (synthetic core) S ${'0 '.repeat(18)}43\n`); }; },
  ];
  for (const mutate of mutations) { const f = observerFixture(); mutate(f); assert.equal((await f.observe()).ready, false); }
  const restarted = observerFixture();
  restarted.files.set(`/proc/${restarted.pid}/stat`, `${restarted.pid} (synthetic core) S ${'0 '.repeat(18)}99\n`);
  restarted.files.set(`/proc/${restarted.pid}/cmdline`, [settings.binaryPath, '-d', restarted.home, '-f', restarted.path(restarted.second.id), ''].join('\0'));
  const after = await restarted.inspect();
  assert.equal(after.ready, true); assert.equal(after.process?.baseGeneration, restarted.second.id); assert.equal(after.process?.startTime, '99');
});

test('controller uses authenticated escaped PUT and one bounded full readback for all manual groups', async t => {
  const requests: string[] = [], choices = new Map([['策略 / ?', 'DIRECT'], ['Secondary', 'REJECT']]);
  let mode = 'normal';
  const server = createServer(async (request, response) => {
    assert.equal(request.headers.authorization, 'Bearer synthetic-secret');
    requests.push(`${request.method} ${request.url}`);
    if (mode === 'redirect') { response.writeHead(302, { Location: '/other' }).end(); return; }
    if (request.method === 'PUT') {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk);
      choices.set(decodeURIComponent(request.url!.slice('/proxies/'.length)), JSON.parse(Buffer.concat(chunks).toString()).name);
      response.writeHead(204).end(); return;
    }
    assert.equal(request.url, '/proxies');
    const proxies = Object.fromEntries([...choices].map(([name, now]) => [name, { type: 'Selector', now }]));
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ proxies }));
  });
  t.after(() => { server.closeAllConnections(); server.close(); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = (server.address() as import('node:net').AddressInfo).port;
  await setControllerSelection(port, 'synthetic-secret', '策略 / ?', 'REJECT');
  await verifyControllerSelections(port, 'synthetic-secret', [{ group: '策略 / ?', name: 'REJECT' }, { group: 'Secondary', name: 'REJECT' }]);
  assert.deepEqual(requests, [`PUT /proxies/${encodeURIComponent('策略 / ?')}`, 'GET /proxies']);
  await assert.rejects(verifyControllerSelections(port, 'synthetic-secret', [{ group: 'Secondary', name: 'DIRECT' }]), { code: 'CONTROLLER_SELECTION_MISMATCH' });
  mode = 'redirect';
  await assert.rejects(setControllerSelection(port, 'synthetic-secret', 'Secondary', 'DIRECT'), { code: 'CONTROLLER_SELECTION_FAILED' });
  assert.equal(requests.at(-1), 'PUT /proxies/Secondary');
});
