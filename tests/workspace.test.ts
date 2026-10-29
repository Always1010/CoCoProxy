import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createServer } from 'node:net';
import { once } from 'node:events';
import type { TestContext } from 'node:test';
import type { JsonObject } from '../packages/config/index.ts';
import { FileTransactionStore } from '../packages/transaction/index.ts';
import { WorkspaceStore, parseWorkspaceSettings } from '../packages/management/workspace.ts';
import { memoizePolicyCompiler } from '../packages/management/shared-work.ts';
import { compileConfig } from '../packages/config/index.ts';
import type { Workspace, WorkspaceSettings } from '../packages/management/workspace.ts';
import { DEFAULT_AUTO_PROBES } from '../packages/management/automatic-policy.ts';
import type { AutoEngineStatus } from '../packages/management/automatic-diagnostics.ts';
import { DEFAULT_BANDWIDTH_SETTINGS } from '../packages/management/bandwidth-policy.ts';
import { createBandwidthTrace, type BandwidthRound, type BandwidthHistoryResult } from '../packages/management/bandwidth-history.ts';
import { setRuntimeLifecycle } from '../packages/runtime/lifecycle.ts';
import { AutomaticHistoryStore, retainAutomaticEvents, AUTOMATIC_HISTORY_AGE, AUTOMATIC_HISTORY_FILE_LIMIT } from '../packages/management/automatic-history.ts';
import { randomUUID } from 'node:crypto';
import type { OperationTiming } from '../packages/diagnostics/operation-timing.ts';

const deployment = { mixedPort: 17890, controllerPort: 19090, dnsPort: 15353,
  controllerSecret: 'EXAMPLE_ONLY_DEPLOYMENT_SECRET', bootstrapResolvers: ['192.0.2.53'] };
const node = { name: 'synthetic-node', type: 'socks5', server: '192.0.2.10', port: 1080 };
const profile: JsonObject = { proxies: [node],
  'proxy-groups': [
    { name: 'Provider', type: 'select', proxies: ['Auto', 'synthetic-node', 'DIRECT', 'REJECT'] },
    { name: 'Auto', type: 'url-test', proxies: ['synthetic-node'], url: 'https://probe.example/generate_204', interval: 300, tolerance: 50 },
  ], rules: ['DOMAIN-SUFFIX,provider.example,Provider', 'MATCH,Provider'], 'tcp-concurrent': true };

test('workspace rejects unaffordable combined bandwidth budgets but isolates disabled groups and schemes', () => {
  const policy = (limits = {}) => ({ preferred: ['synthetic-node'], fallback: ['spare'], returnToPreferred: true,
    bandwidth: { ...DEFAULT_BANDWIDTH_SETTINGS, enabled: true, ...limits } });
  const combinations = [
    { small: policy({ hourMiB: 48 }), large: policy({ reserveHourMiB: 32 }) },
    { small: policy({ dayMiB: 64 }), large: policy({ reserveDayMiB: 64 }) },
    { small: policy({ hourMiB: 48 }), large: policy({ hourMiB: 80, confirmRounds: 3, searchMiB: 48 }) },
  ];
  for (const automatic of combinations) {
    const local = { selections: {}, rules: [], automatic };
    assert.throws(() => parseWorkspaceSettings(settings({ local })), { code: 'AUTO_SETTINGS_INVALID' });
    for (const group of Object.values(automatic)) assert.doesNotThrow(() => parseWorkspaceSettings(settings({ local: {
      ...local, automatic: { single: group },
    } })));
    assert.doesNotThrow(() => parseWorkspaceSettings(settings({ local: { ...local,
      automatic: { ...automatic, large: { ...automatic.large, enabled: false } },
    } })));
    assert.doesNotThrow(() => parseWorkspaceSettings(settings({ local: { ...local,
      automatic: { ...automatic, large: { ...automatic.large, bandwidth: { ...automatic.large.bandwidth, enabled: false } } },
    } })));
    assert.doesNotThrow(() => parseWorkspaceSettings(settings({ local: { ...local, automatic: { small: automatic.small } },
      subscriptionOverrides: { sample: { ...local, automatic: { large: automatic.large } } },
    })));
  }
});

test('site choices save without applying routing and reject stale scope and referenced deletion', async t => {
  const f = await fixture(t);
  await f.source('pool', { proxies: [node] });
  await f.save(settings({ sourceIds: ['pool'] }), 0);
  type Sites = { revision: number; workspaceRevision: number; scope: string; selections: Record<string, string[]>; targets: { id: string; permitted: boolean }[] };
  const initial = await f.call<Sites>('/workspace/sites');
  assert.ok(initial.targets.length > 2 && initial.targets.every(target => target.permitted));
  const body = { expectedRevision: initial.revision, expectedWorkspaceRevision: initial.workspaceRevision, scope: initial.scope,
    group: 'Proxy', selected: ['github', 'openai'], add: { name: 'Example', url: 'https://probe.example/check' } };
  const saved = await f.call<Sites>('/workspace/sites', 'PUT', body);
  assert.deepEqual(saved.selections.Proxy!.slice(0, 2), ['github', 'openai']);
  assert.equal(saved.selections.Proxy!.length, 3);
  assert.deepEqual(f.events, []);
  assert.equal((await f.view()).workspace.revision, initial.workspaceRevision);
  await assert.rejects(f.call('/workspace/sites', 'PUT', body), { code: 'SITE_SETTINGS_CONFLICT' });
  await assert.rejects(f.call('/workspace/sites', 'PUT', { expectedRevision: saved.revision,
    expectedWorkspaceRevision: saved.workspaceRevision, scope: saved.scope, remove: saved.selections.Proxy![2] }), { code: 'SITE_TARGET_IN_USE' });
  await f.source('other', { proxies: [node] });
  await f.save(settings({ sourceIds: ['other'] }), initial.workspaceRevision);
  assert.deepEqual((await f.call<Sites>('/workspace/sites')).selections, {});
  await assert.rejects(f.call('/workspace/sites', 'PUT', { ...body, expectedRevision: saved.revision }), { code: 'SITE_SETTINGS_CONFLICT' });
});

test('decision history binds scope and revision, loads details on demand and stays readable when disabled', async t => {
  let round: BandwidthRound | undefined, reads = 0;
  const f = await fixture(t, {}, undefined, async (scope, group) => {
    reads++; assert.equal(scope, round!.scope); assert.equal(group, 'Proxy');
    return { since: 1000, evicted: false, error: false, rounds: [round!] };
  });
  await f.source('pool', { proxies: [node] });
  const saved = await f.save(settings({ sourceIds: ['pool'] }), 0);
  const scope = JSON.stringify(['local', ['pool']]);
  const trace = createBandwidthTrace(() => 1000, r => { round = r; });
  trace.begin(scope, 'Proxy', 'synthetic-generation', 'synthetic-node', 'manual', DEFAULT_BANDWIDTH_SETTINGS, [{ name: 'synthetic-node', preferred: true }]);
  trace.end('Proxy', 'current-sufficient');
  const query = new URLSearchParams({ group: 'Proxy', scope, revision: String(saved.revision) });
  const path = '/automatic/bandwidth/history?' + query;
  const summary = await f.call<{ rounds: { id: string; events?: unknown; eventCount: number }[]; detail: null }>(path);
  assert.equal(summary.rounds.length, 1); assert.equal(summary.rounds[0].events, undefined); assert.equal(summary.detail, null);
  assert.equal(summary.rounds[0].eventCount, 2);
  const detail = await f.call<{ detail: BandwidthRound }>(path + '&round=' + round!.id);
  assert.equal(detail.detail.events.at(-1)!.reason, 'current-sufficient'); assert.equal(detail.detail.settings.enabled, false);
  assert.equal((await f.call<{ detail: null }>(path + '&round=expired')).detail, null);
  const before = reads;
  for (const change of [{ scope: 'another-scheme' }, { revision: '-1' }, { group: 'missing' }]) {
    const invalid = new URLSearchParams(query); for (const [key, value] of Object.entries(change)) invalid.set(key, value!);
    await assert.rejects(f.call('/automatic/bandwidth/history?' + invalid));
  }
  assert.equal(reads, before); assert.deepEqual(f.bandwidthChecks, []);
});

test('automatic engine diagnostics remain visible without active groups and snapshot suspension has an explicit reason', async t => {
  const engine: AutoEngineStatus = { state: 'error', reason: 'inactive', lastStartedAt: 1000, lastCompletedAt: 1000,
    lastSnapshotAt: null, pendingProbes: 0, nextStartAt: null,
    error: { phase: 'snapshot', code: 'AUTO_SNAPSHOT_UNAVAILABLE', since: 1000, at: 1000, count: 1 } };
  const f = await fixture(t, {}, () => ({ engine, groups: [], events: [] }));
  const response = await f.call<{ engine: AutoEngineStatus; groups: unknown[] }>('/automatic/status');
  assert.deepEqual(response.engine, engine); assert.deepEqual(response.groups, []);
  assert.equal(await f.action.automaticSnapshot(), null);
  assert.equal(f.action.automaticSuspensionReason(), 'disabled');
  await f.save(settings({ runMode: 'direct' }), 0);
  assert.equal(await f.action.automaticSnapshot(), null);
  assert.equal(f.action.automaticSuspensionReason(), 'direct');
});

test('automatic selections preserve manual intent, use confirmed transactions, persist across reads and reject stale decisions', async t => {
  const f = await fixture(t);
  await f.source('pool', { proxies: [node, { ...node, name: 'spare' }, { ...node, name: 'outside' }] });
  const initial = settings({ sourceIds: ['pool'], local: { selections: { Proxy: 'synthetic-node' }, rules: [], automatic: {
    Proxy: { preferred: ['synthetic-node'], fallback: ['spare'], returnToPreferred: true },
  } } });
  const saved = await f.save(initial, 0), applied = await f.apply(saved, null);
  f.observe({ Proxy: 'synthetic-node' });
  const snapshot = await f.action.automaticSnapshot();
  assert.ok(snapshot);
  assert.equal(await f.action.automaticSwitch(snapshot, 'Proxy', 'outside', 'failure-recovery'), false);
  const attempts = await Promise.all([
    f.action.automaticSwitch(snapshot, 'Proxy', 'spare', 'failure-recovery'),
    f.action.automaticSwitch(snapshot, 'Proxy', 'spare', 'failure-recovery'),
  ]);
  assert.deepEqual(attempts.sort(), [false, true]);
  f.observe({ Proxy: 'spare' });
  const after = await f.view();
  assert.equal(after.pending, false);
  assert.notEqual(after.active, applied.active);
  assert.equal(after.workspace.revision, saved.revision);
  assert.deepEqual(JSON.parse(JSON.stringify(after.workspace.local)), initial.local);
  assert.equal(after.groups.find(group => group.name === 'Proxy')?.activeSelected, 'spare');
  assert.ok(after.groups.find(group => group.name === 'Proxy')?.options.includes('outside'));
  assert.equal(await f.action.automaticSwitch(snapshot, 'Proxy', 'synthetic-node', 'preferred-restored'), false);
  const fresh = await f.action.automaticSnapshot();
  assert.ok(fresh); assert.equal(fresh.key, snapshot.key);
  const file = JSON.parse(await readFile(join(f.state, 'automatic-selections.json'), 'utf8'));
  assert.equal(file.targets.Proxy.target, 'spare');
  assert.equal(file.events.length, 1);
  assert.equal(file.pendingEvent, undefined);
  assert.equal((await f.call<{ events: unknown[] }>('/automatic/status')).events.length, 1);
  // Simulate process loss after commit but before the confirmation journal write.
  const committedWithoutEvent = structuredClone(file);
  const confirmed = committedWithoutEvent.events.pop();
  committedWithoutEvent.pendingEvent = { ...confirmed, signature: file.targets.Proxy.signature, revision: saved.revision };
  await writeFile(join(f.state, 'automatic-selections.json'), JSON.stringify(committedWithoutEvent), { mode: 0o600 });
  await f.action.automaticSnapshot(true);
  const journal = JSON.parse(await readFile(join(f.state, 'automatic-selections.json'), 'utf8'));
  assert.equal(journal.pendingEvent, undefined);
  assert.deepEqual(journal.events, file.events);
  await f.action.automaticSnapshot(true);
  assert.equal(JSON.parse(await readFile(join(f.state, 'automatic-selections.json'), 'utf8')).events.length, 1);
  const activeConfig = await f.candidate(after.active!);
  const proxyGroup = (activeConfig['proxy-groups'] as JsonObject[]).find(group => group.name === 'Proxy')!;
  assert.deepEqual(proxyGroup.proxies, ['spare', 'synthetic-node', 'REJECT']);
  // Simulate process loss after writing a proposed return, before apply commits.
  const interrupted = structuredClone(file);
  interrupted.targets.Proxy.target = 'synthetic-node';
  interrupted.pendingEvent = { ...confirmed, id: '11111111-1111-4111-8111-111111111111', from: 'spare', to: 'synthetic-node', signature: file.targets.Proxy.signature, revision: saved.revision };
  await writeFile(join(f.state, 'automatic-selections.json'), JSON.stringify(interrupted), { mode: 0o600 });
  const activationCount = f.events.length;
  assert.equal((await f.view()).pending, true);
  const recovered = await f.action.automaticSnapshot(true);
  assert.equal(recovered?.groups[0].current, 'spare');
  assert.equal((await f.view()).pending, false);
  assert.equal(f.events.length, activationCount);
  const rolledBack = JSON.parse(await readFile(join(f.state, 'automatic-selections.json'), 'utf8'));
  assert.equal(rolledBack.targets.Proxy.target, 'spare');
  assert.equal(rolledBack.pendingEvent, undefined);
  assert.equal(rolledBack.events.length, 1);
  await setRuntimeLifecycle(f.state, { enabled: true, paused: true });
  await assert.rejects(f.action.automaticSwitch(recovered!, 'Proxy', 'synthetic-node', 'preferred-restored'), { code: 'AUTO_PAUSED' });
  assert.equal((await f.view()).pending, false);
  await setRuntimeLifecycle(f.state, { enabled: true, paused: false });
  // Real pending edits outside automatic groups must never be auto-applied.
  const edited = structuredClone((await f.view()).workspace);
  edited.local.selections.OpenAI = 'DIRECT';
  await f.save(withoutRevision(edited), edited.revision);
  assert.equal(await f.action.automaticSnapshot(true), null);
  assert.equal((await f.view()).pending, true);
});

test('automatic switching rejects routing drafts and changed decision settings captured after its fresh snapshot', async t => {
  for (const change of ['rules', 'automatic'] as const) await t.test(change, async t => {
    const f = await fixture(t);
    await f.source('pool', { proxies: [node, { ...node, name: 'spare' }] });
    const initial = settings({ sourceIds: ['pool'], local: { selections: { Proxy: 'synthetic-node' }, rules: [], automatic: {
      Proxy: { preferred: ['synthetic-node'], fallback: ['spare'], returnToPreferred: true },
    } } });
    const saved = await f.save(initial, 0), active = await f.apply(saved, null);
    f.observe({ Proxy: 'synthetic-node' });
    const snapshot = await f.action.automaticSnapshot(); assert.ok(snapshot);
    const edited = structuredClone(initial);
    if (change === 'rules') edited.local.rules.push('DOMAIN,pending.example,DIRECT');
    else edited.local.automatic!.Proxy.returnToPreferred = false;
    const events = [...f.events];
    const read = WorkspaceStore.prototype.read;
    let reads = 0;
    WorkspaceStore.prototype.read = async function() {
      // The first read belongs to automaticSnapshot(true); the second captures
      // the workspace that automaticSwitch will use for its proposed binding.
      if (this.root === f.state && ++reads === 2) await new WorkspaceStore(f.state).save(edited, saved.revision);
      return read.call(this);
    };
    try {
      await assert.rejects(f.action.automaticSwitch(snapshot, 'Proxy', 'spare', 'failure-recovery'), { code: 'AUTO_STATE_CONFLICT' });
    } finally { WorkspaceStore.prototype.read = read; }
    const after = await f.view();
    assert.equal(after.workspace.revision, saved.revision + 1);
    assert.deepEqual(JSON.parse(JSON.stringify(after.workspace.local)), edited.local);
    assert.equal(after.active, active.active);
    assert.equal(after.pending, change === 'rules');
    assert.deepEqual(f.events, events);
    await assert.rejects(readFile(join(f.state, 'automatic-selections.json'), 'utf8'), { code: 'ENOENT' });
    assert.deepEqual((await f.call<{ events: unknown[] }>('/automatic/status')).events, []);
  });
});

test('automatic apply rejects source changes recaptured after its binding write and rolls the binding back', async t => {
  const f = await fixture(t);
  const metadata = await f.source('pool', { proxies: [node, { ...node, name: 'spare' }] });
  const initial = settings({ sourceIds: ['pool'], local: { selections: { Proxy: 'synthetic-node' }, rules: [], automatic: {
    Proxy: { preferred: ['synthetic-node'], fallback: ['spare'], returnToPreferred: true },
  } } });
  const saved = await f.save(initial, 0), active = await f.apply(saved, null);
  f.observe({ Proxy: 'synthetic-node' });
  const snapshot = await f.action.automaticSnapshot(); assert.ok(snapshot);
  const events = [...f.events];
  const exclusive = FileTransactionStore.prototype.exclusive;
  let injected = false;
  FileTransactionStore.prototype.exclusive = async function<T>(operation: (ownerToken: string) => Promise<T>): Promise<T> {
    const result = await exclusive.call(this, operation) as T;
    // Refresh only after the proposed binding's lock is released and before
    // automatic apply rebuilds its candidate from the current source snapshot.
    if (this.root === f.state && !injected) {
      injected = true;
      const proposed = JSON.parse(await readFile(join(f.state, 'automatic-selections.json'), 'utf8'));
      assert.equal(proposed.targets.Proxy.target, 'spare');
      f.payloads.set('https://subscription.example/pool?token=EXAMPLE_ONLY_TOKEN', JSON.stringify({
        proxies: [{ ...node, server: '192.0.2.20' }, { ...node, name: 'spare' }],
      }));
      await f.call('/sources/pool/refresh', 'POST', { expectedRevision: metadata.revision });
    }
    return result;
  };
  try {
    assert.equal(await f.action.automaticSwitch(snapshot, 'Proxy', 'spare', 'failure-recovery'), false);
  } finally { FileTransactionStore.prototype.exclusive = exclusive; }
  assert.equal(injected, true);
  const after = await f.view();
  assert.equal(after.active, active.active);
  assert.equal(after.pending, true);
  assert.equal(after.workspace.revision, saved.revision);
  assert.deepEqual(f.events, events);
  const bindings = JSON.parse(await readFile(join(f.state, 'automatic-selections.json'), 'utf8'));
  assert.deepEqual(bindings.targets, {});
  assert.equal(bindings.pendingEvent, undefined);
  assert.deepEqual((await f.call<{ events: unknown[] }>('/automatic/status')).events, []);
});

test('automatic activation failure rolls back only its private binding and manual takeover remains available', async t => {
  const f = await fixture(t);
  await f.source('pool', { proxies: [node, { ...node, name: 'spare' }] });
  const initial = settings({ sourceIds: ['pool'], local: { selections: { Proxy: 'synthetic-node' }, rules: [], automatic: {
    Proxy: { preferred: ['synthetic-node'], fallback: ['spare'], returnToPreferred: true },
  } } });
  const saved = await f.save(initial, 0), active = await f.apply(saved, null);
  f.observe({ Proxy: 'synthetic-node' });
  const snapshot = await f.action.automaticSnapshot(); assert.ok(snapshot);
  f.fail();
  assert.equal(await f.action.automaticSwitch(snapshot, 'Proxy', 'spare', 'failure-recovery'), false);
  const after = await f.view();
  assert.equal(after.active, active.active); assert.equal(after.pending, false);
  assert.deepEqual(JSON.parse(JSON.stringify(after.workspace.local)), initial.local);
  assert.deepEqual(JSON.parse(await readFile(join(f.state, 'automatic-selections.json'), 'utf8')).targets, {});
  // Remove automatic policy before persisting an explicit manual target.
  const manual = structuredClone(after.workspace);
  delete manual.local.automatic;
  manual.local.selections.Proxy = 'DIRECT';
  const updated = await f.save(withoutRevision(manual), manual.revision);
  assert.equal(updated.local.selections.Proxy, 'DIRECT');
  assert.equal(await f.action.automaticSnapshot(), null);
});

test('automatic history retains each group independently and expires old records without unstable equal-time ordering', () => {
  const now = Date.now();
  const event = (group: string, at: number) => ({ id: randomUUID(), at, group, from: 'old-node', to: 'new-node', reason: 'failure-recovery' });
  const records = [event('Quiet', now), event('Expired', now - AUTOMATIC_HISTORY_AGE),
    ...Array.from({ length: 60 }, (_, i) => event('Busy', now - 1000 + i))];
  const retained = retainAutomaticEvents(records, now);
  assert.equal(retained.filter(e => e.group === 'Quiet').length, 1);
  assert.equal(retained.filter(e => e.group === 'Busy').length, 50);
  assert.equal(retained.some(e => e.group === 'Expired'), false);
  const equalTime = Array.from({ length: 3 }, () => event('Equal', now));
  assert.deepEqual(retainAutomaticEvents(retainAutomaticEvents(equalTime, now), now), equalTime);
});

test('automatic history clear is scoped, survives journal recovery and keeps routing and new switches intact', async t => {
  const f = await fixture(t);
  const proxies = [node, { ...node, name: 'spare' }];
  await f.source('pool', { proxies });
  await f.source('other', { proxies });
  const policy = { preferred: ['synthetic-node'], fallback: ['spare'], returnToPreferred: true };
  const initial = settings({ sourceIds: ['pool'], local: { selections: { Proxy: 'synthetic-node', OpenAI: 'synthetic-node' }, rules: [],
    automatic: { Proxy: policy, OpenAI: policy } } });
  const saved = await f.save(initial, 0);
  await f.apply(saved, null);
  f.observe({ Proxy: 'synthetic-node', OpenAI: 'synthetic-node' });
  assert.equal(await f.action.automaticSwitch((await f.action.automaticSnapshot(true))!, 'Proxy', 'spare', 'failure-recovery'), true);
  f.observe({ Proxy: 'spare', OpenAI: 'synthetic-node' });
  assert.equal(await f.action.automaticSwitch((await f.action.automaticSnapshot(true))!, 'OpenAI', 'spare', 'failure-recovery'), true);
  f.observe({ Proxy: 'spare', OpenAI: 'spare' });
  type Status = { scope: string; workspaceRevision: number; events: { id: string; group: string; fromPool: string; toPool: string }[] };
  const status = await f.call<Status>('/automatic/status');
  assert.equal(status.events.length, 2);
  assert.equal(status.events[0].fromPool, 'preferred');
  assert.equal(status.events[0].toPool, 'fallback');
  // Recreate the committed-but-not-finalized journal left by a process crash.
  const bindings = JSON.parse(await readFile(join(f.state, 'automatic-selections.json'), 'utf8'));
  const old = bindings.events.find((e: { group: string }) => e.group === 'Proxy');
  bindings.pendingEvent = { ...old, signature: bindings.targets.Proxy.signature, revision: saved.revision };
  await writeFile(join(f.state, 'automatic-selections.json'), JSON.stringify(bindings), { mode: 0o600 });
  const before = await f.view(), activations = f.events.length;
  const body = { expectedRevision: saved.revision, scope: status.scope, group: 'Proxy' };
  await assert.rejects(f.call('/automatic/history/clear', 'POST', { ...body, scope: 'other-scheme' }), { code: 'WORKSPACE_CONFLICT' });
  await assert.rejects(f.call('/automatic/history/clear', 'POST', { ...body, group: 'missing' }), { code: 'AUTO_GROUP_INVALID' });
  const cleared = await f.call<Status>('/automatic/history/clear', 'POST', body);
  assert.deepEqual(cleared.events.map(e => e.group), ['OpenAI']);
  const after = await f.view();
  assert.equal(after.active, before.active);
  assert.equal(after.workspace.revision, saved.revision);
  assert.deepEqual(after.workspace.local, before.workspace.local);
  assert.equal(f.events.length, activations);
  // A fresh reader and recovery must not republish the cleared pending event or legacy ring.
  assert.equal((await new AutomaticHistoryStore(f.state).read()).scopes[0].events.length, 1);
  await f.action.automaticSnapshot(true);
  assert.deepEqual((await f.call<Status>('/automatic/status')).events.map(e => e.group), ['OpenAI']);
  assert.equal(await f.action.automaticSwitch((await f.action.automaticSnapshot(true))!, 'Proxy', 'synthetic-node', 'preferred-restored'), true);
  f.observe({ Proxy: 'synthetic-node', OpenAI: 'spare' });
  assert.equal((await f.call<Status>('/automatic/status')).events.filter(e => e.group === 'Proxy').length, 1);
  // Turning automatic selection off retains history. Switching schemes isolates the same group name.
  const disabled = structuredClone(initial);
  disabled.local.automatic!.Proxy.enabled = false;
  const off = await f.save(disabled, saved.revision);
  assert.equal((await f.call<Status>('/automatic/status')).events.filter(e => e.group === 'Proxy').length, 1);
  const other = await f.save({ ...disabled, sourceIds: ['other'] }, off.revision);
  assert.equal((await f.call<Status>('/automatic/status')).events.length, 0);
  await assert.rejects(f.call('/automatic/history/clear', 'POST', { ...body, expectedRevision: other.revision }), { code: 'WORKSPACE_CONFLICT' });
  await f.save(disabled, other.revision);
  assert.equal((await f.call<Status>('/automatic/status')).events.length, 2);
  // A damaged optional archive must not take down the workspace/manual recovery surface.
  await writeFile(join(f.state, 'automatic-history.json'), '{"version":2}', { mode: 0o600 });
  assert.equal((await f.call<{ automatic: { error: string } }>('/workspace')).automatic.error, 'AUTO_HISTORY_CORRUPT');
  await assert.rejects(f.call('/automatic/status'), { code: 'AUTO_HISTORY_CORRUPT' });
});

test('automatic history imports legacy IDs once and keeps its multibyte archive within the private read ceiling', async t => {
  const root = await directory(t), archive = new AutomaticHistoryStore(root), now = Date.now();
  await writeFile(join(root, 'automatic-selections.json'), JSON.stringify({ version: 1, scope: 'legacy', targets: {},
    events: [{ at: now, group: 'Quiet', from: 'old', to: 'new', reason: 'failure-recovery' }] }), { mode: 0o600 });
  const imported = await archive.read();
  assert.equal(imported.scopes[0].events[0].id, (await archive.read()).scopes[0].events[0].id);
  await archive.write(imported);
  await archive.clear('legacy', 'Quiet');
  assert.equal((await new AutomaticHistoryStore(root).read()).scopes.length, 0);
  const events = Array.from({ length: 1100 }, (_, i) => ({ id: randomUUID(), at: now + i,
    group: `组${Math.floor(i / 50)}${'组'.repeat(1000)}`, from: '节'.repeat(1024), to: '点'.repeat(1024), reason: 'failure-recovery' }));
  await archive.write({ version: 1, scopes: [{ scope: 'synthetic', events }] });
  assert.ok(Buffer.byteLength(await readFile(join(root, 'automatic-history.json'), 'utf8')) <= AUTOMATIC_HISTORY_FILE_LIMIT);
  const retained = (await archive.read()).scopes[0].events;
  assert.ok(retained.length < events.length);
  assert.equal(retained.at(-1)!.id, events.at(-1)!.id);
});

test('manual takeover and toggling automatic selection retain candidate pools and resume only when enabled', async t => {
  const f = await fixture(t);
  await f.source('pool', { proxies: [node, { ...node, name: 'spare' }, { ...node, name: 'outside' }] });
  const policy = { preferred: ['synthetic-node'], fallback: ['spare'], returnToPreferred: false,
    bandwidth: { ...DEFAULT_BANDWIDTH_SETTINGS, enabled: true, observeOnly: true } };
  const saved = await f.save(settings({ sourceIds: ['pool'], local: {
    selections: { Proxy: 'synthetic-node' }, rules: [], automatic: { Proxy: policy },
  } }), 0);
  const active = await f.apply(saved, null);
  f.observe({ Proxy: 'synthetic-node' });
  const before = await f.action.automaticSnapshot(); assert.ok(before);
  const status = await f.call<{ scope: string }>('/automatic/status');
  const checkBody = { expectedRevision: saved.revision, expectedActive: active.active, scope: status.scope, group: 'Proxy' };
  await assert.rejects(f.call('/automatic/bandwidth/check', 'POST', { ...checkBody, expectedRevision: -1 }), { code: 'WORKSPACE_CONFLICT' });
  await assert.rejects(f.call('/automatic/bandwidth/check', 'POST', { ...checkBody, group: 'outside' }), { code: 'AUTO_SETTINGS_INVALID' });
  const eventCount = f.events.length;
  await f.call('/automatic/bandwidth/check', 'POST', checkBody);
  assert.deepEqual(f.bandwidthChecks, ['Proxy']); assert.equal(f.events.length, eventCount);
  f.observe({ Proxy: 'outside' });
  const receipt = await f.call<{ active: string; view: View }>('/workspace/select', 'POST', {
    expectedRevision: saved.revision, expectedActive: active.active, group: 'Proxy', name: 'outside' });
  assert.equal(receipt.view.active, receipt.active);
  assert.equal(receipt.view.workspace.revision, saved.revision + 1);
  assert.equal(receipt.view.pending, false);
  assert.equal(receipt.view.groups.find(group => group.name === 'Proxy')!.activeSelected, 'outside');
  assert.equal(f.timings.at(-1)!.outcome, 'ok');
  assert.equal(typeof f.timings.at(-1)!.phases.readback, 'number');
  const manual = await f.view();
  assert.equal(manual.pending, false);
  assert.equal(manual.workspace.local.selections.Proxy, 'outside');
  assert.deepEqual({ ...manual.workspace.local.automatic!.Proxy }, { ...policy, enabled: false });
  assert.equal(await f.action.automaticSnapshot(true), null);
  assert.equal(await f.action.automaticSwitch(before, 'Proxy', 'spare', 'failure-recovery'), false);
  const resumedSettings = withoutRevision(structuredClone(manual.workspace));
  resumedSettings.local.automatic!.Proxy.enabled = true;
  const resumed = await f.save(resumedSettings, manual.workspace.revision);
  const running = await f.apply(resumed, manual.active);
  f.observe({ Proxy: 'synthetic-node' });
  assert.deepEqual((await f.action.automaticSnapshot(true))?.groups[0].policy, { ...policy, enabled: true });
  const disabledSettings = withoutRevision(structuredClone(resumed));
  disabledSettings.local.automatic!.Proxy.enabled = false;
  disabledSettings.local.selections.Proxy = 'synthetic-node';
  const disabled = await f.save(disabledSettings, resumed.revision);
  await f.apply(disabled, running.active);
  assert.equal(await f.action.automaticSnapshot(true), null);
  assert.deepEqual({ ...(await f.view()).workspace.local.automatic!.Proxy }, { ...policy, enabled: false });
  // A removed candidate in a dormant pool must not block manual operation;
  // enabling that same pool still requires current group membership.
  const stale = withoutRevision(structuredClone(disabled));
  stale.local.automatic!.Proxy.preferred = ['removed-node'];
  const dormant = await f.save(stale, disabled.revision);
  stale.local.automatic!.Proxy.enabled = true;
  await assert.rejects(f.save(stale, dormant.revision), { code: 'AUTO_GROUP_INVALID' });
});

test('automatic configuration rejects group aliases, foreign candidates, native algorithms and unpermitted probes before saving', async t => {
  const f = await fixture(t);
  await f.source('pool', profile);
  const invalid = (target: string) => settings({ sourceIds: ['pool'], local: { selections: {}, rules: [], automatic: {
    Proxy: { preferred: [target], fallback: [], returnToPreferred: true },
  } } });
  for (const name of ['OpenAI', 'not-in-pool']) await assert.rejects(f.save(invalid(name), 0), { code: 'AUTO_GROUP_INVALID' });
  const unpermitted = invalid('synthetic-node');
  unpermitted.autoProbes = { ...DEFAULT_AUTO_PROBES, secondary: { url: 'https://unpermitted.example/check', expectedStatus: 204 } };
  await assert.rejects(f.save(unpermitted, 0), { code: 'AUTO_PROBE_DENIED', status: 400 });
  await assert.rejects(f.save(settings({ mode: 'subscription', subscriptionId: 'pool', subscriptionOverrides: { pool: {
    selections: {}, rules: [], automatic: { Auto: { preferred: ['synthetic-node'], fallback: [], returnToPreferred: true } },
  } } }), 0), { code: 'AUTO_GROUP_INVALID' });
  assert.equal((await f.view()).workspace.revision, 0);
});

test('automatic probe settings are validated through active concrete nodes without persisting failed or stale settings', async t => {
  const f = await fixture(t);
  await f.source('pool', { proxies: [node] });
  const saved = await f.save(settings({ sourceIds: ['pool'] }), 0), applied = await f.apply(saved, null);
  f.observe({ Proxy: 'synthetic-node' });
  const checked = await f.call<{ ok: boolean }>('/automatic/test', 'POST', {
    expectedRevision: saved.revision, expectedActive: applied.active, probes: DEFAULT_AUTO_PROBES,
  });
  assert.equal(checked.ok, true);
  assert.equal((await f.view()).workspace.autoProbes, undefined);
  await assert.rejects(f.call('/automatic/test', 'POST', {
    expectedRevision: 0, expectedActive: applied.active, probes: DEFAULT_AUTO_PROBES,
  }), { code: 'WORKSPACE_CONFLICT' });
});

test('compiled policy reuse is immutable and invalidates on content even at the same workspace revision', () => {
  let compilations = 0;
  const compile = memoizePolicyCompiler(policy => {
    compilations++;
    return compileConfig({ schemaVersion: 1, deployment, policy });
  });
  const policy: JsonObject = { rules: ['MATCH,DIRECT'] };
  const first = compile(policy);
  assert.equal(compile(structuredClone(policy)), first);
  assert.throws(() => (first.config.rules as string[]).push('MATCH,REJECT'), TypeError);
  policy.rules = ['MATCH,REJECT'];
  assert.notEqual(compile(policy).id, first.id);
  assert.equal(compilations, 2);
  assert.throws(() => compile({ dns: {} }));
  assert.equal(compile(policy).id, compile(policy).id);
  assert.equal(compilations, 3); // Failed compilations never replace the last verified entry.
  compile({ rules: ['MATCH,DIRECT'], extension: null });
  for (const extension of [Infinity, NaN]) assert.throws(() => compile({ rules: ['MATCH,DIRECT'], extension }), { code: 'INVALID_INPUT' });
  let invoked = false;
  const accessor: JsonObject = { rules: ['MATCH,DIRECT'] };
  Object.defineProperty(accessor, 'extension', { enumerable: true, get: () => { invoked = true; return null; } });
  assert.throws(() => compile(accessor), { code: 'INVALID_INPUT' });
  assert.equal(invoked, false);
});

function settings(changes: Partial<WorkspaceSettings> = {}): WorkspaceSettings {
  return { mode: 'local', subscriptionId: null, sourceIds: [], runMode: 'rule',
    local: { selections: {}, rules: [] }, subscriptionOverrides: {}, ...changes };
}
function withoutRevision({ revision: _revision, ...value }: Workspace): WorkspaceSettings { return value; }
type View = { workspace: Workspace; active: string | null; pending: boolean; error?: string;
  groups: { name: string; type: string; role: 'service' | 'shared'; selected: string; activeSelected: string | null; options: string[] }[];
  nodes: string[]; tcpNodes: { name: string; fingerprint: string; applicable: boolean }[];
  rules: { value: string; source: string; editable: boolean }[]; ruleCount: number; invalidSelections: string[] };

async function directory(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'cocoproxy-workspace-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function fixture(t: TestContext, deploymentOverrides: JsonObject = {}, automaticStatus?: () => unknown,
  automaticBandwidthHistory?: (scope: string, group: string) => Promise<BandwidthHistoryResult>) {
  // Keep the pure settings/store test runnable without the optional YAML runtime.
  const [{ createManagementApplication }, { decodeSubscriptionProfile }] = await Promise.all([
    import('../packages/management/application.ts'), import('../packages/subscriptions/yaml.ts'),
  ]);
  const root = await directory(t), state = join(root, 'state');
  const payloads = new Map<string, string>();
  const events: string[] = [];
  const bandwidthChecks: string[] = [];
  const timings: OperationTiming[] = [];
  let failActivation = false;
  let observedChoices: Record<string, string> | null = null;
  const runtime = {
    validate: async () => { events.push('validate'); },
    activate: async () => { events.push('activate'); if (failActivation) throw new Error('EXAMPLE_ONLY_RUNTIME_DIAGNOSTIC'); },
    confirm: async () => { events.push('confirm'); return true; },
    restore: async () => { events.push('restore'); },
    observe: async (generation: string) => ({ ready: true, generation, checkedAt: new Date().toISOString(), reason: null }),
  };
  const action = createManagementApplication({ stateDirectory: state, deployment: { ...deployment, ...deploymentOverrides }, runtime,
    onTiming: timing => { timings.push(timing); },
    allowedProbeOrigins: ['https://www.gstatic.com', 'https://cp.cloudflare.com'],
    automaticProbe: async () => ({ ok: true, delay: 25 }),
    automaticBandwidthCheck: group => { bandwidthChecks.push(group); return true; },
    automaticStatus,
    automaticBandwidthHistory,
    observeSelections: async () => {
      const generation = (await new FileTransactionStore(state).status()).active;
      if (!generation || !observedChoices) throw new Error('Synthetic core unavailable');
      return { generation, selections: observedChoices };
    },
    sourceDecoder: decodeSubscriptionProfile, sourceClient: { fetch: async url => {
      const text = payloads.get(url);
      if (text === undefined) throw new Error('Synthetic source missing');
      return { status: 'modified' as const, text };
    } } });
  async function call<T = unknown>(path: string, method = 'GET', body?: unknown): Promise<T> {
    const request = new Request(`https://management.example/api/cocoproxy${path}`, { method,
      headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return await action(request, { username: 'synthetic-admin', expiresAt: Date.now() + 60_000 }) as T;
  }
  async function source(id: string, input: JsonObject) {
    const url = `https://subscription.example/${id}?token=EXAMPLE_ONLY_TOKEN`;
    payloads.set(url, JSON.stringify(input));
    const configured = await call<{ revision: number }>(`/sources/${id}`, 'PUT', { expectedRevision: 0, url });
    return await call<{ revision: number }>(`/sources/${id}/refresh`, 'POST', { expectedRevision: configured.revision });
  }
  const view = () => call<View>('/workspace');
  const save = async (value: WorkspaceSettings, expectedRevision: number) => (await call<{ workspace: Workspace }>('/workspace', 'PUT', { settings: value, expectedRevision })).workspace;
  const apply = (workspace: Workspace, expectedActive: string | null) => call<{ active: string; workspaceRevision: number }>('/workspace/apply', 'POST', { expectedRevision: workspace.revision, expectedActive });
  const candidate = async (id: string) => JSON.parse(await readFile(await new FileTransactionStore(state).readCandidate(id), 'utf8')) as JsonObject;
  return { state, events, bandwidthChecks, timings, call, view, save, apply, source, candidate, payloads, action, fail: () => { failActivation = true; },
    observe: (choices: Record<string, string>) => { observedChoices = choices; } };
}

test('workspace binds private node DNS to captured sources in local and subscription modes', async t => {
  const f = await fixture(t);
  const resolver = 'https://resolver.example/private/EXAMPLE_ONLY_TOKEN';
  const input = { ...profile, proxies: [{ ...node, server: 'entry.example' }],
    dns: { 'nameserver-policy': { 'entry.example': resolver } } };
  await f.source('provider', input);
  const saved = await f.save(settings({ sourceIds: ['provider'] }), 0);
  const active = await f.apply(saved, null);
  assert.deepEqual(((await f.candidate(active.active)).dns as JsonObject)['proxy-server-nameserver-policy'], { 'entry.example': [resolver] });
  assert.equal(JSON.stringify(await f.view()).includes('EXAMPLE_ONLY_TOKEN'), false);
  assert.equal((await f.view()).pending, false);
  const full = await f.save(settings({ mode: 'subscription', subscriptionId: 'provider' }), saved.revision);
  const next = await f.apply(full, active.active);
  assert.deepEqual(((await f.candidate(next.active)).dns as JsonObject)['proxy-server-nameserver-policy'], { 'entry.example': [resolver] });
  const admin = await fixture(t, { nodeNameserverPolicy: { 'entry.example': ['https://admin.example/dns-query'] } });
  await admin.source('provider', input);
  const configured = await admin.save(settings({ sourceIds: ['provider'] }), 0);
  const overridden = await admin.apply(configured, null);
  assert.deepEqual(((await admin.candidate(overridden.active)).dns as JsonObject)['proxy-server-nameserver-policy'], { 'entry.example': ['https://admin.example/dns-query'] });
});

test('conflicting node DNS from multiple sources blocks application without leaking resolver paths', async t => {
  const f = await fixture(t);
  for (const [id, resolver] of [['first', 'https://one.example/EXAMPLE_ONLY_PRIVATE'], ['second', 'https://two.example/EXAMPLE_ONLY_PRIVATE']]) {
    const metadata = await f.source(id, { proxies: [{ ...node, name: id, server: 'entry.example' }], rules: ['MATCH,DIRECT'], dns: { 'nameserver-policy': { 'entry.example': resolver } } });
    assert.equal((metadata as unknown as { snapshotCurrent: boolean }).snapshotCurrent, true);
  }
  // Older persisted workspaces may contain multiple sources; the current UI
  // permits one source, but compilation must still reject ambiguous DNS.
  const saved = await new WorkspaceStore(f.state).save(settings({ sourceIds: ['first', 'second'] }), 0);
  await assert.rejects(f.apply(saved, null), { code: 'NODE_DNS_POLICY_CONFLICT' });
  assert.equal(f.events.length, 0);
});

test('refresh keeps a local node source as nodes while recovering dedicated DNS from a full upstream file', async t => {
  const f = await fixture(t);
  await f.source('provider', { proxies: [{ ...node, server: 'entry.example' }] });
  const saved = await f.save(settings({ sourceIds: ['provider'] }), 0);
  const initial = await f.apply(saved, null);
  const url = [...f.payloads.keys()][0];
  f.payloads.set(url, JSON.stringify({ proxies: [{ ...node, server: 'entry.example' }], mode: 'Rule',
    rules: ['GEOIP,CN,DIRECT', 'MATCH,REJECT'], dns: { 'nameserver-policy': { 'entry.example': 'https://resolver.example/EXAMPLE_ONLY_PRIVATE' } } }));
  const view = await f.view();
  const sources = await f.call<{ sources: { id: string; revision: number }[] }>('/sources');
  const refreshed = await f.call<{ kind: string }>('/sources/provider/refresh', 'POST', { expectedRevision: sources.sources[0].revision });
  assert.equal(refreshed.kind, 'nodes');
  const active = await f.apply(view.workspace, initial.active);
  const candidate = await f.candidate(active.active);
  assert.deepEqual((candidate.dns as JsonObject)['proxy-server-nameserver-policy'], { 'entry.example': ['https://resolver.example/EXAMPLE_ONLY_PRIVATE'] });
  assert.ok((candidate.rules as string[]).includes('RULE-SET,cocoproxy-domestic-domain-v2,Domestic'));
});

test('workspace TCP tests bind to the active node and revision without applying configuration', async t => {
  const server = createServer(socket => socket.resume());
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const f = await fixture(t);
  const port = (server.address() as { port: number }).port;
  await f.source('tcp-source', { proxies: [{ name: 'tcp-test-node', type: 'socks5', server: '127.0.0.1', port }] });
  const current = await f.view();
  const saved = await f.save(settings({ sourceIds: ['tcp-source'] }), current.workspace.revision);
  await f.apply(saved, current.active);
  const view = await f.view();
  const metadata = view.tcpNodes[0];
  const body = { expectedRevision: view.workspace.revision, expectedActive: view.active, name: metadata.name, fingerprint: metadata.fingerprint };
  const before = f.events.length;
  const result = await f.call<{ status: string; delay: number; fingerprint: string }>('/workspace/tcp-delay', 'POST', body);
  assert.equal(result.status, 'success');
  assert.ok(result.delay >= 0);
  assert.equal(result.fingerprint, metadata.fingerprint);
  assert.equal(f.events.length, before);
  assert.equal((await f.view()).workspace.revision, view.workspace.revision);
  assert.deepEqual(Object.keys(metadata).sort(), ['applicable', 'fingerprint', 'name']);
  await assert.rejects(f.call('/workspace/tcp-delay', 'POST', { ...body, name: 'foreign-node' }), { code: 'TCP_NODE_CONFLICT' });
  await assert.rejects(f.call('/workspace/tcp-delay', 'POST', { ...body, fingerprint: '0'.repeat(64) }), { code: 'TCP_NODE_CONFLICT' });
  await assert.rejects(f.call('/workspace/tcp-delay', 'POST', { ...body, expectedRevision: -1 }), { code: 'WORKSPACE_CONFLICT' });
  await assert.rejects(f.call('/workspace/tcp-delay', 'POST', { ...body, host: '192.0.2.20' }), { code: 'INVALID_REQUEST' });
});

test('workspace settings enforce schema and durable compare-and-save without aliasing', async t => {
  const store = new WorkspaceStore(join(await directory(t), 'state'));
  assert.equal(await store.read(), null);
  const input = settings({ local: { selections: { Other: 'REJECT' }, rules: ['DOMAIN,synthetic.example,REJECT'] } });
  const saved = await store.save(input, 0);
  input.local.rules.push('MATCH,DIRECT');
  input.local.selections.Other = 'DIRECT';
  assert.equal(saved.revision, 1);
  assert.deepEqual((await store.read())!.local, { selections: { Other: 'REJECT' }, rules: ['DOMAIN,synthetic.example,REJECT'] });
  await assert.rejects(store.save(settings(), 0), { code: 'WORKSPACE_CONFLICT' });
  for (const invalid of [settings({ sourceIds: ['duplicate', 'duplicate'] }), settings({ mode: 'subscription' }),
    { ...settings(), injected: true }, settings({ runMode: 'invalid' as WorkspaceSettings['runMode'] })]) {
    assert.throws(() => parseWorkspaceSettings(invalid));
  }
  let invoked = false;
  const accessor = settings();
  Object.defineProperty(accessor.local.selections, 'Proxy', { enumerable: true, get() { invoked = true; return 'DIRECT'; } });
  assert.throws(() => parseWorkspaceSettings(accessor));
  assert.equal(invoked, false);
  assert.equal((await store.read())!.revision, 1);
  await writeFile(join(store.root, 'workspace.json'), '{broken', { mode: 0o600 });
  await assert.rejects(store.read(), { code: 'WORKSPACE_CORRUPT' });
});

test('local shared exit groups persist and compile while subscription overrides reject them', async t => {
  const f = await fixture(t);
  await f.source('pool', { proxies: [node, { ...node, name: 'second-node' }] });
  const saved = await f.save(settings({ sourceIds: ['pool'], local: {
    sharedGroups: ['AI Exit'], selections: { 'AI Exit': 'synthetic-node', OpenAI: 'AI Exit', TikTok: 'AI Exit' }, rules: [],
  } }), 0);
  const view = await f.view();
  assert.deepEqual(view.groups.filter(group => ['Proxy', 'AI Exit', 'OpenAI', 'TikTok'].includes(group.name)).map(group =>
    [group.name, group.role, group.selected]), [
    ['Proxy', 'shared', 'synthetic-node'], ['AI Exit', 'shared', 'synthetic-node'],
    ['OpenAI', 'service', 'AI Exit'], ['TikTok', 'service', 'AI Exit'],
  ]);
  const active = await f.apply(saved, null);
  const groups = (await f.candidate(active.active))['proxy-groups'] as JsonObject[];
  assert.deepEqual(groups.find(group => group.name === 'AI Exit')!.proxies, ['synthetic-node', 'second-node', 'DIRECT', 'REJECT']);
  assert.ok((groups.find(group => group.name === 'OpenAI')!.proxies as string[]).includes('AI Exit'));
  assert.throws(() => parseWorkspaceSettings(settings({ subscriptionOverrides: {
    pool: { selections: {}, rules: [], sharedGroups: ['invalid'] } as never,
  } })));
});

test('legacy migration retains manual and automatic groups and waits for an explicit scheme choice', async t => {
  const f = await fixture(t);
  await f.call('/draft', 'PUT', { expectedRevision: 0, policy: profile });
  const initial = await f.view();
  assert.equal(initial.workspace.mode, 'legacy');
  assert.equal(initial.workspace.revision, 0);
  assert.equal(initial.error, undefined);
  assert.deepEqual(initial.groups.map(group => [group.name, group.type]), [['Provider', 'select'], ['Auto', 'url-test']]);
  assert.deepEqual(initial.rules.map(rule => rule.value), profile.rules);
  assert.deepEqual(initial.workspace.local, { selections: {}, rules: [] });
  assert.deepEqual(f.events, []);
  const legacy = await f.save(withoutRevision(initial.workspace), 0);
  const active = await f.apply(legacy, null);
  assert.deepEqual((await f.candidate(active.active))['proxy-groups'], profile['proxy-groups']);
  assert.equal((await f.view()).pending, false);
});

test('opening the new workspace keeps an already applied legacy config current without creating preferences', async t => {
  const f = await fixture(t);
  await f.call('/draft', 'PUT', { expectedRevision: 0, policy: profile });
  const staged = await f.call<{ generation: string }>('/stage', 'POST', { expectedRevision: 1 });
  await f.call('/apply', 'POST', { generation: staged.generation, expectedActive: null });
  const before = [...f.events];
  const opened = await f.view();
  assert.equal(opened.active, staged.generation);
  assert.equal(opened.pending, false);
  assert.equal(opened.workspace.revision, 0);
  assert.deepEqual(f.events, before);
  assert.equal(await new WorkspaceStore(f.state).read(), null);
});

test('legacy runtime cache choices are displayed and captured before managed migration', async t => {
  const f = await fixture(t);
  const second = { ...node, name: 'second-node' };
  const legacy = { proxies: [node, second], 'proxy-groups': [{ name: 'Proxy', type: 'select', proxies: ['synthetic-node', 'second-node'] }], rules: ['MATCH,Proxy'] };
  await f.source('provider', { proxies: [node, second] });
  await f.call('/draft', 'PUT', { expectedRevision: 0, policy: legacy });
  const staged = await f.call<{ generation: string }>('/stage', 'POST', { expectedRevision: 1 });
  await f.call('/apply', 'POST', { generation: staged.generation, expectedActive: null });
  f.observe({ Proxy: 'second-node' });
  const opened = await f.view();
  assert.equal(opened.pending, false);
  assert.equal(opened.groups[0].selected, 'second-node');
  assert.deepEqual(opened.workspace.subscriptionOverrides.legacy.selections, {});
  const migrated = await f.save({ ...withoutRevision(opened.workspace), mode: 'local' }, 0);
  assert.equal(migrated.local.selections.Proxy, 'second-node');
  assert.equal(migrated.subscriptionOverrides.legacy.selections.Proxy, 'second-node');
  const active = await f.apply(migrated, staged.generation);
  assert.equal((((await f.candidate(active.active))['proxy-groups'] as JsonObject[])[0].proxies as string[])[0], 'second-node');
});

test('full subscription and local schemes preserve their own rules and selections across switches', async t => {
  const f = await fixture(t);
  await f.source('provider', { ...profile, 'mixed-port': 9999, dns: { nameserver: ['198.51.100.53'] } });
  const fullSettings = settings({ mode: 'subscription', subscriptionId: 'provider', sourceIds: ['missing-unused'],
    subscriptionOverrides: { provider: { selections: { Provider: 'REJECT' }, rules: ['DOMAIN,override.example,DIRECT'] } } });
  const full = await f.save(fullSettings, 0);
  let view = await f.view();
  assert.equal(view.error, undefined);
  assert.equal(view.groups.find(group => group.name === 'Provider')!.selected, 'REJECT');
  assert.deepEqual(view.rules.map(rule => rule.source), ['user', 'subscription', 'subscription']);
  const fullActive = await f.apply(full, null);
  const fullConfig = await f.candidate(fullActive.active);
  assert.equal(fullConfig['tcp-concurrent'], true);
  assert.deepEqual((fullConfig['proxy-groups'] as JsonObject[])[1], (profile['proxy-groups'] as JsonObject[])[1]);
  assert.equal(fullConfig['mixed-port'], deployment.mixedPort);
  assert.equal(fullConfig.secret, deployment.controllerSecret);
  const localSettings = { ...fullSettings, mode: 'local' as const, sourceIds: ['provider'],
    local: { selections: { Other: 'DIRECT', Overseas: 'REJECT', OpenAI: 'REJECT' }, rules: ['DOMAIN,local.example,REJECT'] } };
  const local = await f.save(localSettings, full.revision);
  view = await f.view();
  assert.ok(view.rules.some(rule => rule.value === 'RULE-SET,cocoproxy-domestic-domain-v2,Domestic'));
  assert.ok(view.rules.some(rule => rule.value === 'RULE-SET,cocoproxy-overseas-domain-v1,Overseas'));
  assert.deepEqual(view.rules[0], { value: 'DOMAIN,local.example,REJECT', source: 'user', editable: true });
  assert.equal(view.groups.find(group => group.name === 'Other')!.selected, 'DIRECT');
  assert.equal(view.groups.find(group => group.name === 'Overseas')!.selected, 'REJECT');
  const localActive = await f.apply(local, fullActive.active);
  assert.equal((await f.candidate(localActive.active))['tcp-concurrent'], true);
  const back = await f.save({ ...localSettings, mode: 'subscription', sourceIds: ['missing-unused'] }, local.revision);
  view = await f.view();
  assert.equal(view.groups.find(group => group.name === 'Provider')!.selected, 'REJECT');
  assert.deepEqual(view.workspace.local, localSettings.local);
  assert.deepEqual(view.rules.map(rule => rule.value), ['DOMAIN,override.example,DIRECT', ...profile.rules as string[]]);
  const restored = await f.apply(back, localActive.active);
  assert.equal(restored.active, fullActive.active);
});

test('revision and active CAS reject stale actions before runtime activation or selection persistence', async t => {
  const f = await fixture(t);
  const saved = await f.save(settings(), 0);
  await assert.rejects(f.save(settings({ runMode: 'direct' }), 0), { code: 'WORKSPACE_CONFLICT', status: 409 });
  const active = await f.apply(saved, null);
  const events = [...f.events];
  await assert.rejects(f.apply(saved, null), { code: 'ACTIVE_CONFLICT', status: 409 });
  await assert.rejects(f.call('/workspace/select', 'POST', { expectedRevision: saved.revision, expectedActive: null, group: 'Proxy', name: 'DIRECT' }), { code: 'ACTIVE_CONFLICT', status: 409 });
  await assert.rejects(f.call('/workspace/select', 'POST', { expectedRevision: 0, expectedActive: active.active, group: 'Proxy', name: 'DIRECT' }), { code: 'WORKSPACE_CONFLICT', status: 409 });
  assert.deepEqual(f.events, events);
  const view = await f.view();
  assert.equal(view.active, active.active);
  assert.equal(view.workspace.revision, saved.revision);
  assert.equal(view.groups.find(group => group.name === 'Proxy')!.selected, 'REJECT');
});

test('failed selection apply restores the active generation while keeping reviewable pending preferences', async t => {
  const f = await fixture(t);
  const saved = await f.save(settings(), 0);
  const active = await f.apply(saved, null);
  f.observe({ Proxy: 'REJECT' });
  f.fail();
  await assert.rejects(f.call('/workspace/select', 'POST', { expectedRevision: saved.revision, expectedActive: active.active, group: 'Proxy', name: 'DIRECT' }), { code: 'ACTIVATION_FAILED', status: 503 });
  const view = await f.view();
  assert.equal(view.active, active.active);
  assert.equal(view.pending, true);
  assert.equal(view.workspace.revision, saved.revision + 1);
  assert.equal(view.workspace.local.selections.Proxy, 'DIRECT');
  assert.equal(view.groups.find(group => group.name === 'Proxy')!.activeSelected, 'REJECT');
  assert.equal(view.groups.find(group => group.name === 'Proxy')!.selected, 'DIRECT');
  assert.equal(f.events.at(-1), 'restore');
  assert.equal((await new FileTransactionStore(f.state).status()).transaction, null);
});

test('selection receipts require actual controller agreement even after the transaction commits', async t => {
  const f = await fixture(t), saved = await f.save(settings(), 0), active = await f.apply(saved, null);
  f.observe({ Proxy: 'REJECT' });
  await assert.rejects(f.call('/workspace/select', 'POST', {
    expectedRevision: saved.revision, expectedActive: active.active, group: 'Proxy', name: 'DIRECT',
  }), { code: 'SELECTION_UNCONFIRMED', status: 503 });
  assert.equal(f.timings.at(-1)!.outcome, 'failed');
  assert.equal(typeof f.timings.at(-1)!.phases.readback, 'number');
  const after = await f.view();
  assert.notEqual(after.active, active.active); // A failed response must not be replayed as an unapplied write.
  assert.equal(after.workspace.revision, saved.revision + 1);
  assert.equal(after.groups.find(group => group.name === 'Proxy')!.activeSelected, 'REJECT');
  await assert.rejects(f.call('/workspace/select', 'POST', {
    expectedRevision: saved.revision, expectedActive: active.active, group: 'Proxy', name: 'DIRECT',
  }), { code: 'WORKSPACE_CONFLICT', status: 409 });
});

test('available subscriptions require one current local source and reject cancellation without changing preferences', async t => {
  const f = await fixture(t);
  await f.source('provider', profile);
  await f.source('replacement', profile);
  await f.call('/draft', 'PUT', { expectedRevision: 0, policy: profile });
  const initial = await f.view();
  assert.equal(initial.workspace.mode, 'legacy');
  assert.deepEqual(initial.workspace.sourceIds, ['provider']);
  await assert.rejects(f.save(settings(), initial.workspace.revision), { code: 'SOURCE_REQUIRED', status: 400 });
  assert.deepEqual((await f.view()).workspace.sourceIds, ['provider']);
  const saved = await f.save(settings({ sourceIds: ['provider'] }), initial.workspace.revision);
  const next = await f.save(settings({ sourceIds: ['replacement'] }), saved.revision);
  assert.deepEqual(next.sourceIds, ['replacement']);
  const activeSource = await f.call<{ source: { revision: number } }>('/sources/replacement');
  await assert.rejects(f.call('/sources/replacement', 'DELETE', { expectedRevision: activeSource.source.revision }), { code: 'SOURCE_IN_USE', status: 409 });
  const previousSource = await f.call<{ source: { revision: number } }>('/sources/provider');
  await f.call('/sources/provider', 'DELETE', { expectedRevision: previousSource.source.revision });
  assert.deepEqual((await f.view()).workspace.sourceIds, ['replacement']);
});

test('workspace and source changes between capture and transaction entry reject stale activation', async t => {
  const f = await fixture(t);
  const metadata = await f.source('provider', profile);
  const saved = await f.save(settings({ mode: 'subscription', subscriptionId: 'provider' }), 0);
  const stage = FileTransactionStore.prototype.stage;
  let mutation: (() => Promise<unknown>) | null = () => f.save(settings({ sourceIds: ['provider'] }), saved.revision);
  FileTransactionStore.prototype.stage = async function(candidate) {
    const result = await stage.call(this, candidate);
    if (this.root === f.state && mutation) { const mutate = mutation; mutation = null; await mutate(); }
    return result;
  };
  try {
    await assert.rejects(f.apply(saved, null), { code: 'WORKSPACE_CONFLICT', status: 409 });
    const current = (await f.view()).workspace;
    const reset = await f.save(settings({ mode: 'subscription', subscriptionId: 'provider' }), current.revision);
    mutation = () => f.call('/sources/provider', 'PUT', { expectedRevision: metadata.revision, name: 'renamed-provider' });
    await assert.rejects(f.apply(reset, null), { code: 'SOURCE_CONFLICT', status: 409 });
    assert.deepEqual(f.events, []);
    const status = await new FileTransactionStore(f.state).status();
    assert.equal(status.active, null);
    assert.equal(status.transaction, null);
  } finally { FileTransactionStore.prototype.stage = stage; }
});

test('missing sources and node-only subscriptions fail explicitly without replacing the active config', async t => {
  const f = await fixture(t);
  const saved = await f.save(settings(), 0);
  const active = await f.apply(saved, null);
  const missing = await f.save(settings({ sourceIds: ['missing'] }), saved.revision);
  assert.equal((await f.view()).error, 'SOURCE_NOT_FOUND');
  await assert.rejects(f.apply(missing, active.active), { code: 'SOURCE_NOT_FOUND', status: 404 });
  await f.source('nodes', { proxies: [node] });
  const noProfile = await f.save(settings({ mode: 'subscription', subscriptionId: 'nodes' }), missing.revision);
  assert.equal((await f.view()).error, 'PROFILE_RULES_REQUIRED');
  await assert.rejects(f.apply(noProfile, active.active), { code: 'PROFILE_RULES_REQUIRED', status: 400 });
  assert.equal((await f.view()).active, active.active);
  assert.deepEqual(f.events, ['validate', 'activate', 'confirm']);
});

test('full profiles reject unknown group members, cycles and overrides of automatic groups', async t => {
  const f = await fixture(t);
  const badProfiles: JsonObject[] = [
    { ...profile, 'proxy-groups': [{ name: 'Provider', type: 'select', proxies: ['missing'] }] },
    { ...profile, 'proxy-groups': [{ name: 'Provider', type: 'select', proxies: ['Loop'] }, { name: 'Loop', type: 'select', proxies: ['Provider'] }] },
  ];
  let expectedRevision = 0;
  for (const [index, bad] of badProfiles.entries()) {
    const id = `invalid${index}`;
    await f.source(id, bad);
    const saved = await f.save(settings({ mode: 'subscription', subscriptionId: id }), expectedRevision);
    expectedRevision = saved.revision;
    assert.equal((await f.view()).error, 'GROUP_REFERENCE_INVALID');
    await assert.rejects(f.apply(saved, null), { code: 'GROUP_REFERENCE_INVALID', status: 400 });
  }
  await f.source('valid', profile);
  const automatic = await f.save(settings({ mode: 'subscription', subscriptionId: 'valid',
    subscriptionOverrides: { valid: { selections: { Auto: 'synthetic-node' }, rules: [] } } }), expectedRevision);
  assert.equal((await f.view()).error, 'GROUP_SELECTION_UNSUPPORTED');
  await assert.rejects(f.apply(automatic, null), { code: 'GROUP_SELECTION_UNSUPPORTED', status: 400 });
  assert.deepEqual(f.events, []);
});

test('refresh detects stale selections and protects the current source without replacing the active generation', async t => {
  const f = await fixture(t);
  const metadata = await f.source('provider', profile);
  const saved = await f.save(settings({ mode: 'subscription', subscriptionId: 'provider',
    subscriptionOverrides: { provider: { selections: { Provider: 'synthetic-node' }, rules: [] } } }), 0);
  const active = await f.apply(saved, null);
  f.payloads.set('https://subscription.example/provider?token=EXAMPLE_ONLY_TOKEN', JSON.stringify({ proxies: [node],
    'proxy-groups': [{ name: 'Provider', type: 'select', proxies: ['DIRECT', 'REJECT'] }], rules: ['MATCH,Provider'] }));
  const refreshed = await f.call<{ revision: number }>('/sources/provider/refresh', 'POST', { expectedRevision: metadata.revision });
  const repair = await f.view();
  assert.equal(repair.error, 'GROUP_SELECTION_CONFLICT');
  assert.deepEqual(repair.groups.find(group => group.name === 'Provider')!.options, ['DIRECT', 'REJECT']);
  assert.deepEqual(repair.invalidSelections, ['Provider']);
  await assert.rejects(f.apply(saved, active.active), { code: 'GROUP_SELECTION_CONFLICT', status: 409 });
  await assert.rejects(f.call('/sources/provider', 'DELETE', { expectedRevision: refreshed.revision }), { code: 'SOURCE_IN_USE', status: 409 });
  const view = await f.view();
  assert.equal(view.error, 'GROUP_SELECTION_CONFLICT');
  assert.equal(view.active, active.active);
  assert.equal(view.pending, true);
  assert.equal(view.workspace.subscriptionOverrides.provider.selections.Provider, 'synthetic-node');
  assert.deepEqual(f.events, ['validate', 'activate', 'confirm']);
});
