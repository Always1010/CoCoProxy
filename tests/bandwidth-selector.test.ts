import assert from 'node:assert/strict';
import test from 'node:test';
import { createBandwidthSelector, parseBandwidthLedger, type BandwidthLedger } from '../packages/management/bandwidth-selector.ts';
import { DEFAULT_BANDWIDTH_SETTINGS } from '../packages/management/bandwidth-policy.ts';
import { DEFAULT_AUTO_PROBES } from '../packages/management/automatic-policy.ts';
import type { AutoSnapshot } from '../packages/management/automatic-selector.ts';

function fixture(options: { enabled?: boolean; observeOnly?: boolean; candidateMbps?: number; ledger?: BandwidthLedger; blocked?: boolean } = {}) {
  let now = 0, total = 0, loads = 0;
  const measures: string[] = [], switches: string[] = [], saved: BandwidthLedger[] = [];
  const snapshot: AutoSnapshot = { key: 'synthetic', scope: 'scope', generation: '1', probes: DEFAULT_AUTO_PROBES,
    groups: [{ name: 'media', current: 'a', policy: { preferred: ['a', 'b'], fallback: [], returnToPreferred: true,
      bandwidth: { ...DEFAULT_BANDWIDTH_SETTINGS, enabled: options.enabled ?? true, observeOnly: options.observeOnly ?? false } } }] };
  const engine = createBandwidthSelector({ now: () => now,
    load: async () => { loads++; return options.ledger ?? { version: 1, charges: [], switches: [] }; },
    save: async value => { saved.push(structuredClone(value)); },
    probe: async () => ({ ok: true, delay: 150 }),
    select: async (_s, _g, node) => { switches.push(node); return true; },
    measure: async (_s, node, _settings, signal, report) => {
      measures.push(node); report(1000000);
      if (options.blocked) await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
      return signal.aborted ? null : { delayMs: node === 'a' ? 80 : 150, mbps: node === 'a' ? 6 : options.candidateMbps ?? 8, bytes: 1000000 };
    } });
  engine.update(snapshot);
  return { engine, snapshot, measures, switches, saved, get loads() { return loads; },
    async step(bytes = 0, ready = true) {
      now += 1000; total += bytes;
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
  assert.deepEqual(f.measures, ['a', 'b', 'a', 'b', 'a', 'b']);
  assert.deepEqual(f.switches, ['b']);
  assert.equal(f.engine.status('media')?.decision?.worthwhile, true);
  assert.ok(f.saved.some(s => s.charges.some(c => c.bytes === 8 * 1048576))); // Precharged before transfer.
  await f.engine.close();
});

test('uncertain candidate and observation mode keep the current selection; persisted budget survives restart', async () => {
  for (const options of [{ candidateMbps: 5 }, { observeOnly: true }]) {
    const f = fixture(options); f.engine.request('media', 'b');
    for (let i = 0; i < 150; i++) await f.step();
    assert.deepEqual(f.switches, []);
    assert.equal(f.engine.status('media')?.reason, options.observeOnly ? 'would-switch' : 'no-clear-gain');
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
    if (reason === 'generation') f.engine.update({ ...f.snapshot, generation: '2' });
    await f.step(0, reason !== 'failure'); await f.engine.close();
    assert.deepEqual(f.switches, []);
    assert.equal(f.saved.at(-1)?.charges[0].bytes, 1000000);
  }
});
