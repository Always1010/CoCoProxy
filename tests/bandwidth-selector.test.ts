import assert from 'node:assert/strict';
import test from 'node:test';
import { createBandwidthSelector, parseBandwidthLedger, type BandwidthLedger } from '../packages/management/bandwidth-selector.ts';
import { DEFAULT_BANDWIDTH_SETTINGS, type BandwidthSettings } from '../packages/management/bandwidth-policy.ts';
import { DEFAULT_AUTO_PROBES } from '../packages/management/automatic-policy.ts';
import type { AutoSnapshot } from '../packages/management/automatic-selector.ts';

function fixture(options: { enabled?: boolean; observeOnly?: boolean; candidateMbps?: number; currentMbps?: number;
  preferred?: string[]; fallback?: string[]; rates?: Record<string, number[]>; delays?: Record<string, number>;
  settings?: Partial<BandwidthSettings>; bytes?: number; ledger?: BandwidthLedger; blocked?: boolean; storageFails?: boolean } = {}) {
  let now = 0, total = 0, loads = 0;
  const measures: string[] = [], switches: string[] = [], saved: BandwidthLedger[] = [], probes: string[] = [];
  const counts = new Map<string, number>();
  const snapshot: AutoSnapshot = { key: 'synthetic', scope: 'scope', generation: '1', probes: DEFAULT_AUTO_PROBES,
    groups: [{ name: 'media', current: 'a', policy: { preferred: options.preferred ?? ['a', 'b'], fallback: options.fallback ?? [], returnToPreferred: true,
      bandwidth: { ...DEFAULT_BANDWIDTH_SETTINGS, ...options.settings, enabled: options.enabled ?? true, observeOnly: options.observeOnly ?? false } } }] };
  const engine = createBandwidthSelector({ now: () => now,
    load: async () => { loads++; return options.ledger ?? { version: 1, charges: [], switches: [] }; },
    save: async value => { if (options.storageFails) throw new Error('synthetic ledger failure'); saved.push(structuredClone(value)); },
    probe: async (_s, node) => { probes.push(node); return { ok: true, delay: options.delays?.[node] ?? (node === 'a' ? 80 : 150) }; },
    select: async (_s, _g, node) => { switches.push(node); snapshot.groups[0].current = node; snapshot.generation = String(Number(snapshot.generation) + 1); return true; },
    measure: async (_s, node, _settings, signal, report) => {
      measures.push(node); report(options.bytes ?? 1000000);
      if (options.blocked) await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
      const count = counts.get(node) ?? 0; counts.set(node, count + 1);
      const rates = options.rates?.[node];
      const mbps = rates ? rates[Math.min(count, rates.length - 1)] : node === 'a' ? options.currentMbps ?? 4 : options.candidateMbps ?? 8;
      return signal.aborted || mbps === -1 ? null : { delayMs: 999, mbps, bytes: options.bytes ?? 1000000 };
    } });
  engine.update(snapshot);
  return { engine, snapshot, measures, switches, saved, probes, get loads() { return loads; }, get now() { return now; },
    async step(bytes = 0, ready = true) {
      now += 1000; total += bytes;
      engine.update(snapshot);
      engine.observe({ epoch: 'one', download: total, upload: 0,
        connections: [{ id: 'one', outbound: 'a', download: total, upload: 0, sourceIP: '192.0.2.1', host: 'media.example', process: 'Unknown', inboundUser: 'Unknown' }] });
      engine.tick([{ name: 'media', ready }]);
      await new Promise<void>(resolve => setImmediate(resolve));
    } };
}

test('legacy opt-out performs no ledger or network work; sustained low traffic only triggers verification', async () => {
  const off = fixture({ enabled: false });
  for (let i = 0; i < 100; i++) await off.step(200000);
  assert.equal(off.loads, 0); assert.deepEqual(off.measures, []); await off.engine.close();
  const f = fixture();
  for (let i = 0; i < 70; i++) await f.step(200000);
  assert.deepEqual(f.measures, []); // Busy application traffic is suspicion, never a reason to steal bandwidth.
  for (let i = 0; i < 150; i++) await f.step();
  assert.deepEqual(f.measures, ['a', 'b', 'a', 'b']);
  assert.deepEqual(f.switches, ['b']);
  assert.equal(f.engine.status('media')?.reason, 'bandwidth-improvement');
  assert.ok(f.saved.some(s => s.charges.some(c => c.bytes === 8 * 1048576))); // Precharged before transfer.
  await f.engine.close();
});

test('uncertain candidate and observation mode keep the current selection; persisted budget survives restart', async () => {
  for (const options of [{ candidateMbps: 5 }, { observeOnly: true }]) {
    const f = fixture(options); f.engine.request('media', 'b');
    for (let i = 0; i < 150; i++) await f.step();
    assert.deepEqual(f.switches, []);
    if (options.observeOnly) assert.equal(f.engine.status('media')?.reason, 'would-switch');
    else assert.ok(f.engine.status('media')?.pool.some(n => n.name === 'b' && n.reason === 'no-clear-gain'));
    await f.engine.close();
  }
  const f = fixture({ ledger: { version: 1, charges: [{ at: 0, bytes: 64 * 1048576 }], switches: [] } });
  f.engine.request('media', 'b'); for (let i = 0; i < 20; i++) await f.step();
  assert.deepEqual(f.measures, []); assert.equal(f.engine.status('media')?.reason, 'budget-exhausted');
  await f.engine.close();
  assert.throws(() => parseBandwidthLedger({ version: 1, charges: [{ at: 0, bytes: -1 }], switches: [] }));
});

test('disabling, generation changes and latency failure cancel in-flight work and reject late results', async () => {
  for (const reason of ['disable', 'generation', 'failure']) {
    const f = fixture({ blocked: true }); f.engine.request('media', 'b');
    for (let i = 0; i < 13; i++) await f.step();
    assert.deepEqual(f.measures, ['a']);
    if (reason === 'disable') { f.snapshot.groups[0].policy.bandwidth!.enabled = false; f.engine.update(null); }
    if (reason === 'generation') { f.snapshot.generation = '2'; f.engine.update(f.snapshot); }
    await f.step(0, reason !== 'failure'); await f.engine.close();
    assert.deepEqual(f.switches, []);
    assert.equal(f.saved.at(-1)?.charges[0].bytes, 1000000);
  }
});

test('a candidate that fails confirmation yields to another candidate without cooling down the group', async () => {
  const f = fixture({ preferred: ['a', 'b', 'c'], rates: { b: [8, 1], c: [8] }, delays: { b: 100, c: 150 } });
  f.engine.requestCheck('media');
  for (let i = 0; i < 115; i++) await f.step();
  assert.deepEqual(f.switches, ['c']);
  assert.equal(f.measures.filter(n => n === 'b').length, 2);
  assert.ok(f.measures.includes('c'));
  assert.ok(f.engine.status('media')!.pool.find(n => n.name === 'b')!.nextAt > 0);
  await f.engine.close();
});

test('latency screening orders downloads, stops hopeless probes and permits relative improvement beyond reference lines', async () => {
  const sorted = fixture({ preferred: ['a', 'b', 'c'], delays: { b: 400, c: 100 } });
  sorted.engine.requestCheck('media'); for (let i = 0; i < 100; i++) await sorted.step();
  assert.equal(sorted.measures.find(n => n !== 'a'), 'c'); assert.deepEqual(sorted.switches, ['c']);
  await sorted.engine.close();
  const healthy = fixture({ currentMbps: 8 }); healthy.engine.requestCheck('media');
  for (let i = 0; i < 100; i++) await healthy.step();
  assert.deepEqual(healthy.measures, ['a']); assert.deepEqual(healthy.switches, []); await healthy.engine.close();
  const poor = fixture({ currentMbps: 0.5, candidateMbps: 2, delays: { a: 2000, b: 800 } }); poor.engine.requestCheck('media');
  for (let i = 0; i < 100; i++) await poor.step();
  assert.deepEqual(poor.switches, ['b']); await poor.engine.close();
});

test('reserves protect degradation work, search yield preserves the pool and ledger failure prevents transfers', async () => {
  const ledger: BandwidthLedger = { version: 1, charges: [{ at: 0, bytes: 32 * 1048576 }], switches: [] };
  const f = fixture({ ledger }); f.engine.requestCheck('media');
  for (let i = 0; i < 40; i++) await f.step();
  assert.ok(f.measures.length <= 1); assert.equal(f.engine.status('media')!.reason, 'budget-exhausted');
  f.engine.request('media', undefined, 'latency');
  for (let i = 0; i < 100; i++) await f.step();
  assert.ok(f.measures.length > 1); await f.engine.close();
  const failed = fixture({ storageFails: true }); failed.engine.requestCheck('media');
  for (let i = 0; i < 25; i++) await failed.step();
  assert.deepEqual(failed.measures, []); assert.equal(failed.engine.status('media')!.reason, 'storage-unavailable'); await failed.engine.close();
  const yielded = fixture({ preferred: ['a', 'b', 'c'], rates: { b: [8, 1] }, bytes: 8 * 1048576 }); yielded.engine.requestCheck('media');
  for (let i = 0; i < 100; i++) await yielded.step();
  assert.ok(yielded.engine.status('media')!.pool.some(n => n.name === 'c'));
  assert.ok(['search-yield', 'budget-exhausted'].includes(yielded.engine.status('media')!.reason));
  assert.ok(yielded.measures.length <= 4); await yielded.engine.close();
});

test('busy traffic aborts verification as unknown without condemning other candidates', async () => {
  const f = fixture({ blocked: true, preferred: ['a', 'b', 'c'] }); f.engine.requestCheck('media');
  for (let i = 0; i < 15; i++) await f.step();
  await f.step(500000); await f.step(500000);
  assert.deepEqual(f.switches, []);
  assert.equal(f.engine.status('media')!.pool.find(n => n.name === 'b')!.state, 'pending');
  assert.ok(f.saved.at(-1)!.charges[0].bytes > 0);
  await f.engine.close();
});

test('fresh latency deterioration or incumbent recovery invalidates an otherwise worthwhile switch', async () => {
  for (const recovery of [false, true]) {
    const f = fixture({ currentMbps: recovery ? 8 : 5, delays: { a: recovery ? 500 : 80, b: 100 } });
    f.engine.requestCheck('media');
    for (let i = 0; i < 100 && f.measures.filter(n => n === 'b').length < 2; i++) await f.step();
    assert.equal(f.measures.filter(n => n === 'b').length, 2);
    f.engine.observeProbe('media', recovery ? 'a' : 'b', { ok: true, delay: recovery ? 100 : 450 });
    await f.step();
    assert.deepEqual(f.switches, []);
    assert.equal(f.engine.status('media')!.pool.find(n => n.name === 'b')!.state, 'backoff');
    await f.engine.close();
  }
});

test('custom no-gain backoff cap is honored on repeated unsuccessful comparisons', async () => {
  const f = fixture({ currentMbps: 8, settings: { cooldownSeconds: 300 } });
  f.engine.requestCheck('media');
  const delays: number[] = [];
  let previous = 0;
  for (let i = 0; i < 1000 && delays.length < 3; i++) {
    await f.step();
    const retry = f.engine.status('media')!.pool.find(n => n.name === 'b')!.nextAt;
    if (retry > previous) { delays.push(retry - f.now); previous = retry; }
  }
  assert.deepEqual(delays, [120000, 300000, 300000]);
  assert.deepEqual(f.switches, []);
  await f.engine.close();
});
