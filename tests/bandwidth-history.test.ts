import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BandwidthHistoryStore, createBandwidthTrace, parseBandwidthHistory, retainBandwidthHistory,
  BANDWIDTH_HISTORY_AGE, BANDWIDTH_HISTORY_FILE, type BandwidthRound } from '../packages/management/bandwidth-history.ts';
import { DEFAULT_BANDWIDTH_SETTINGS } from '../packages/management/bandwidth-policy.ts';

test('process snapshots survive restart, stay group-scoped, coalesce waits and bound retention', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cocoproxy-bandwidth-history-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let now = 1000000, writes = 0;
  const store = new BandwidthHistoryStore(root, async run => { writes++; return run(); }, () => now);
  const trace = createBandwidthTrace(() => now, r => store.record(r));
  const settings = { ...DEFAULT_BANDWIDTH_SETTINGS, enabled: true };
  trace.begin('scheme', 'group', 'generation', 'a', 'manual', settings, [{ name: 'a', preferred: true }]);
  settings.targetMbps = 12;
  for (let i = 0; i < 60; i++) { now += 1000; trace.event('group', { kind: 'state', reason: 'waiting-idle' }); }
  const before = await store.read('scheme', 'group');
  assert.equal(before.rounds.length, 1); assert.equal(before.rounds[0].settings.targetMbps, 8);
  assert.equal(before.rounds[0].events.length, 2); assert.ok(before.rounds[0].events[1].until > before.rounds[0].events[1].at);
  assert.deepEqual((await store.read('other', 'group')).rounds, []);
  assert.deepEqual((await store.read('scheme', 'other')).rounds, []);
  await store.close(); assert.equal(writes, 1);
  const disk = parseBandwidthHistory(JSON.parse(await readFile(join(root, BANDWIDTH_HISTORY_FILE), 'utf8')));
  assert.equal(disk.rounds[0].endedAt, null);
  const restarted = new BandwidthHistoryStore(root, run => run(), () => now);
  assert.equal((await restarted.read('scheme', 'group')).rounds[0].reason, 'service-restarted');
  await restarted.close();
  const crowded = { ...disk, rounds: Array.from({ length: 105 }, (_, i) => ({ ...disk.rounds[0], id: String(i), startedAt: now + i, updatedAt: now })) };
  const retained = retainBandwidthHistory(crowded, now);
  assert.equal(retained.rounds.length, 100); assert.equal(retained.evicted, true);
  assert.equal(retainBandwidthHistory(crowded, now + BANDWIDTH_HISTORY_AGE + 1).rounds.length, 0);
});

test('archive failures are reported without leaking contents or affecting the trace observer', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cocoproxy-bandwidth-history-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const secret = 'synthetic-private-corrupt-content';
  await writeFile(join(root, BANDWIDTH_HISTORY_FILE), secret, { mode: 0o600 });
  const store = new BandwidthHistoryStore(root, run => run());
  assert.equal((await store.read('scheme', 'group')).error, true);
  await store.close(); assert.equal(await readFile(join(root, BANDWIDTH_HISTORY_FILE), 'utf8'), secret);
  assert.throws(() => parseBandwidthHistory({ version: 1, since: 0, evicted: false, rounds: [{ id: 'invalid' }] }), /^Error: BANDWIDTH_HISTORY_INVALID$/);
  let round: BandwidthRound | undefined;
  const trace = createBandwidthTrace(() => 100, r => { round = r; throw new Error(secret); });
  assert.doesNotThrow(() => {
    trace.begin('scheme', 'group', 'generation', 'a', 'manual', DEFAULT_BANDWIDTH_SETTINGS, []);
    for (let i = 0; i < 500; i++) trace.event('group', { kind: 'excluded', reason: 'sample-unknown', node: 'a' });
    trace.end('group', 'stopped');
  });
  assert.equal(round!.truncated, true); assert.ok(round!.events.length <= 200); assert.equal(round!.reason, 'stopped');
  const incomplete = JSON.parse(JSON.stringify({ version: 1, since: 0, evicted: false, rounds: [round] }));
  delete incomplete.rounds[0].settings.targetMbps;
  assert.throws(() => parseBandwidthHistory(incomplete), /^Error: BANDWIDTH_HISTORY_INVALID$/);
  const writable = join(root, 'write-failure'); await mkdir(writable, { mode: 0o700 });
  let failWrite = true;
  const failing = new BandwidthHistoryStore(writable, async run => { if (failWrite) throw new Error(secret); return run(); }, () => 100);
  failing.record(round!); await failing.flush();
  assert.equal((await failing.read('scheme', 'group')).error, true);
  assert.equal((await failing.read('scheme', 'group')).rounds[0].reason, 'stopped');
  failWrite = false; await failing.flush();
  assert.equal((await failing.read('scheme', 'group')).error, false);
  await failing.close();
  assert.equal(parseBandwidthHistory(JSON.parse(await readFile(join(writable, BANDWIDTH_HISTORY_FILE), 'utf8'))).rounds.length, 1);
});
