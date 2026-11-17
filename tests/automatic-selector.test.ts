import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_AUTO_PROBES, parseAutoGroupPolicy, parseAutoProbeSettings } from '../packages/management/automatic-policy.ts';
import { DEFAULT_BANDWIDTH_SETTINGS } from '../packages/management/bandwidth-policy.ts';
import { createAutomaticSelector, type AutoSnapshot, type ProbeResult } from '../packages/management/automatic-selector.ts';
import { ManagementError } from '../packages/management/http.ts';
import { createAutomaticDiagnostics, type AutoDiagnostic } from '../packages/management/automatic-diagnostics.ts';
import type { BandwidthRound } from '../packages/management/bandwidth-history.ts';
import { latencyWindow } from '../packages/management/latency-policy.ts';

const good = (delay = 100): ProbeResult => ({ ok: true, delay });
const bad = (): ProbeResult => ({ ok: false, delay: null });

test('two groups finish timed bandwidth confirmation without cancelling their own probe quota', async () => {
  for (const duration of [14000, 20000]) {
    let time = 0, suspended = false;
    const pending: { due: number; progress: () => void; resolve: () => void; signal: AbortSignal }[] = [];
    const samples = new Map<string, { valid: boolean; reason: string }>();
    const probes: number[] = [], changes: string[] = [];
    const snapshot: AutoSnapshot = { key: 'timed-bandwidth', generation: '1', probes: structuredClone(DEFAULT_AUTO_PROBES),
      groups: [0, 1].map(i => ({ name: `group-${i}`, current: `current-${i}`, policy: {
        preferred: [`current-${i}`, `candidate-${i}`], fallback: [], returnToPreferred: false,
        bandwidth: { ...DEFAULT_BANDWIDTH_SETTINGS, enabled: true, targetMbps: i ? 4 : 6,
          confirmRounds: i ? 2 : 3, roundIntervalSeconds: i ? 30 : 60, searchMiB: i ? 32 : 48 },
      } })) };
    const engine = createAutomaticSelector({ now: () => time, snapshot: async () => suspended ? null : snapshot,
      probe: async () => { probes.push(time); return good(); },
      switch: async (_s, name, node) => {
        suspended = true; await new Promise<void>(resolve => setImmediate(resolve)); await engine.tick(); suspended = false;
        changes.push(name); snapshot.groups.find(g => g.name === name)!.current = node;
        snapshot.generation = String(Number(snapshot.generation) + 1); return true;
      },
      bandwidth: {
        trace: round => { for (const e of round.events) if (e.sample)
          samples.set(`${round.group}:${e.sample.startedAt}`, { valid: e.sample.valid, reason: e.reason }); },
        measure: async (_s, node, settings, signal, report, _group, phase) => {
          const started = time; phase('preparing');
          const progress = () => {
            const elapsed = Math.max(0, time - started - (duration - 8000));
            if (elapsed) phase('download');
            report(Math.floor((node.startsWith('current') ? 2 : settings.targetMbps * 1.25) * 125 * elapsed));
          };
          await new Promise<void>(resolve => {
            pending.push({ due: time + duration, progress, resolve, signal });
            signal.addEventListener('abort', () => resolve(), { once: true });
          });
          return signal.aborted ? null : { mbps: node.startsWith('current') ? 2 : settings.targetMbps, delayMs: 100, bytes: 0 };
        },
      },
    });
    for (let second = 0; second < 450 && changes.length < 2; second++) {
      time = second * 1000;
      for (const task of pending.splice(0)) if (!task.signal.aborted) {
        task.progress(); if (time >= task.due) task.resolve(); else pending.push(task);
      }
      await new Promise<void>(resolve => setImmediate(resolve));
      engine.observeUsage({ epoch: 'timed-core', download: 0, upload: 0, connections: [] });
      await engine.tick(); await new Promise<void>(resolve => setImmediate(resolve));
      if (second === 1) for (const group of snapshot.groups) engine.requestBandwidthCheck(group.name);
    }
    assert.equal(new Set(changes).size, 2, `both groups must finish for ${duration}ms tasks`);
    assert.ok([...samples.values()].every(s => s.valid), JSON.stringify([...samples.values()]));
    assert.ok(probes.every(at => probes.filter(p => p > at - 60000 && p <= at).length <= 24));
    await engine.close();
  }
});

test('bandwidth history preserves specific suspension causes without storing raw errors', async () => {
  for (const mode of ['paused', 'transaction', 'locked', 'failed'] as const) {
    let unavailable = false;
    const records: BandwidthRound[] = [];
    const snapshot: AutoSnapshot = { key: 'suspension-synthetic', generation: '1', probes: DEFAULT_AUTO_PROBES,
      groups: [{ name: 'group', current: 'a', policy: { preferred: ['a', 'b'], fallback: [], returnToPreferred: false,
        bandwidth: { ...DEFAULT_BANDWIDTH_SETTINGS, enabled: true } } }] };
    const engine = createAutomaticSelector({ now: () => 1000,
      snapshot: async () => {
        if (!unavailable) return snapshot;
        if (mode === 'locked') throw new ManagementError('STORE_LOCKED', 409);
        if (mode === 'failed') throw new Error('EXAMPLE_ONLY_SECRET');
        return null;
      }, suspensionReason: () => mode === 'transaction' ? 'transaction' : 'paused',
      probe: async () => good(), switch: async () => false,
      bandwidth: { measure: async () => null, trace: record => records.push(record) },
    });
    await engine.tick();
    assert.equal(engine.requestBandwidthCheck('group'), true);
    unavailable = true; await engine.tick();
    const expected = mode === 'locked' ? 'snapshot-locked' : mode === 'failed' ? 'snapshot-failed' : `runtime-${mode}`;
    assert.equal(records.at(-1)?.reason, expected);
    assert.equal(records.at(-1)?.events.at(-1)?.reason, expected);
    assert.doesNotMatch(JSON.stringify(records), /EXAMPLE_ONLY_SECRET/);
    await engine.close();
  }
});

test('bandwidth opt-in cannot block legacy fault recovery or apply a late download result', async () => {
  let time = 0, total = 0, failed = false, measured = 0, aborted = false;
  const changes: string[] = [];
  const snapshot: AutoSnapshot = { key: 'bandwidth-synthetic', generation: '1', probes: DEFAULT_AUTO_PROBES,
    groups: [{ name: 'media', current: 'a', policy: { preferred: ['a', 'b'], fallback: [], returnToPreferred: false,
      bandwidth: { ...DEFAULT_BANDWIDTH_SETTINGS, enabled: true } } }] };
  const engine = createAutomaticSelector({ now: () => time, snapshot: async () => snapshot,
    probe: async (_s, node) => failed && node === 'a' ? bad() : good(80),
    switch: async (_s, name, node, reason) => { changes.push(reason); snapshot.groups[0].current = node; snapshot.generation = '2'; return true; },
    bandwidth: { measure: async (_s, _node, _settings, signal, report) => {
      measured++; report(1024);
      await new Promise<void>(resolve => signal.addEventListener('abort', () => { aborted = true; resolve(); }, { once: true }));
      return { delayMs: 50, mbps: 8, bytes: 1024 }; // Even a plausible late result cannot switch.
    } } });
  for (let second = 0; second <= 96; second++) {
    time = second * 1000; total += second < 70 ? 200000 : 0;
    if (second === 89) failed = true;
    engine.observeUsage({ epoch: 'core', download: total, upload: 0,
      connections: [{ id: 'one', outbound: 'a', download: total, upload: 0, host: 'media.example', sourceIP: '192.0.2.1', process: 'Unknown', inboundUser: 'Unknown' }] });
    await engine.tick(); await new Promise<void>(resolve => setImmediate(resolve));
  }
  assert.equal(measured, 1); assert.equal(aborted, true);
  assert.deepEqual(changes, ['failure-recovery']);
  await engine.close();
});
function harness(options: { current?: string; preferred?: string[]; fallback?: string[]; names?: string[];
  bandwidth?: boolean; responsive?: boolean;
  probe?: (node: string, secondary: boolean, at: number) => ProbeResult | Promise<ProbeResult> } = {}) {
  let time = 0;
  const policy = { preferred: options.preferred ?? ['primary', 'alternate'], fallback: options.fallback ?? ['backup'], returnToPreferred: true,
    ...(options.responsive ? { latency: { mode: 'responsive' as const, slowMs: 500 } } : {}),
    ...(options.bandwidth === undefined ? {} : { bandwidth: { ...DEFAULT_BANDWIDTH_SETTINGS, enabled: options.bandwidth } }) };
  let snapshot: AutoSnapshot | null = { key: 'synthetic-config', generation: '1', probes: structuredClone(DEFAULT_AUTO_PROBES),
    groups: (options.names ?? ['group']).map(name => ({ name, current: options.current ?? 'primary', policy: structuredClone(policy) })) };
  const calls: { node: string; secondary: boolean; at: number }[] = [];
  const switches: { node: string; at: number; reason: string }[] = [];
  const engine = createAutomaticSelector({ now: () => time, snapshot: async () => snapshot,
    probe: async (_snapshot, node, target) => {
      const secondary = target.url === DEFAULT_AUTO_PROBES.secondary.url;
      calls.push({ node, secondary, at: time });
      return options.probe?.(node, secondary, time) ?? good();
    },
    switch: async (_snapshot, name, node, reason) => {
      switches.push({ node, at: time, reason });
      snapshot!.groups.find(group => group.name === name)!.current = node;
      snapshot!.generation = String(Number(snapshot!.generation) + 1);
      return true;
    },
  });
  return { engine, calls, switches, get snapshot() { return snapshot; }, set snapshot(value) { snapshot = value; },
    async at(at: number) { time = at; await engine.tick(); }, setTime(at: number) { time = at; } };
}

test('automatic policy validates bounded disjoint nodes and safe HTTPS probe settings', () => {
  assert.deepEqual(parseAutoProbeSettings(DEFAULT_AUTO_PROBES), DEFAULT_AUTO_PROBES);
  assert.deepEqual(parseAutoGroupPolicy({ preferred: ['a'], fallback: ['b'], returnToPreferred: false }),
    { preferred: ['a'], fallback: ['b'], returnToPreferred: false });
  assert.deepEqual(parseAutoGroupPolicy({ enabled: false, preferred: ['a'], fallback: ['b'], returnToPreferred: false }),
    { enabled: false, preferred: ['a'], fallback: ['b'], returnToPreferred: false });
  assert.equal(parseAutoGroupPolicy({ enabled: false, preferred: [], fallback: [], returnToPreferred: true }).enabled, false);
  const invalid = (fn: () => unknown) => assert.throws(fn, error => (error as { code: string }).code === 'AUTO_SETTINGS_INVALID'
    && !(error as Error).message.includes('SECRET'));
  for (const preferred of [['DIRECT'], ['REJECT'], ['a', 'a'], Array.from({ length: 33 }, (_, i) => String(i))]) {
    invalid(() => parseAutoGroupPolicy({ preferred, fallback: [], returnToPreferred: true }));
  }
  invalid(() => parseAutoGroupPolicy({ preferred: ['a'], fallback: ['a'], returnToPreferred: true }));
  invalid(() => parseAutoGroupPolicy({ preferred: [], fallback: ['a'], returnToPreferred: true }));
  invalid(() => parseAutoGroupPolicy({ enabled: true, preferred: [], fallback: ['a'], returnToPreferred: true }));
  invalid(() => parseAutoGroupPolicy({ enabled: 'false', preferred: ['a'], fallback: [], returnToPreferred: true }));
  invalid(() => parseAutoGroupPolicy({ preferred: ['a'], fallback: [], returnToPreferred: true, extra: true }));
  assert.deepEqual(parseAutoGroupPolicy({ preferred: ['a'], fallback: [], returnToPreferred: true, latency: { mode: 'responsive' } }).latency,
    { mode: 'responsive', slowMs: 500 });
  for (const latency of [{ mode: 'responsive', slowMs: 499 }, { mode: 'responsive', slowMs: null },
    { mode: 'unknown', slowMs: 500 }, { mode: 'responsive', extra: true }]) {
    invalid(() => parseAutoGroupPolicy({ preferred: ['a'], fallback: [], returnToPreferred: true, latency }));
  }
  for (const url of ['http://example.test/', 'https://user:SECRET@example.test/', 'https://example.test/?token=SECRET', 'https://example.test/#SECRET']) {
    invalid(() => parseAutoProbeSettings({ ...DEFAULT_AUTO_PROBES, primary: { url, expectedStatus: 204 } }));
  }
});

test('responsive selection confirms intermittent deterioration independently of throughput parameters', async () => {
  let checks = 0;
  const h = harness({ responsive: true, bandwidth: false, probe: node => good(node === 'primary' ? [680, 1050, 280][Math.min(checks++, 2)] : 190) });
  h.snapshot!.groups[0].policy.bandwidth!.marginMs = 500;
  h.snapshot!.groups[0].policy.bandwidth!.minGainMs = 2000;
  for (const at of [0, 5000, 10000, 11000, 13000]) await h.at(at);
  assert.deepEqual(h.switches, [{ node: 'alternate', at: 13000, reason: 'faster-candidate' }]);
  assert.equal(h.calls.filter(c => c.node === 'alternate').length, 2);
  await h.engine.close();
});

test('responsive windows expire, tolerate one recovery and reject two recent recoveries', () => {
  const policy = { mode: 'responsive' as const, slowMs: 500 };
  const samples = [800, 950, 700, 180, 160].map((delayMs, i) => ({ at: i * 5000, delayMs }));
  assert.equal(latencyWindow(samples.slice(0, 4), policy, 15000).degraded, true);
  assert.equal(latencyWindow(samples, policy, 20000).degraded, false);
  assert.equal(latencyWindow(samples.slice(0, 3), policy, 100000).degraded, false);
});

test('responsive spike checks are bounded and external generations invalidate their evidence', async () => {
  let checks = 0;
  const h = harness({ responsive: true, probe: () => good(checks++ ? 140 : 2300) });
  for (const at of [0, 5000, 10000, 15000, 44000]) await h.at(at);
  assert.equal(h.calls.length, 4); assert.equal(h.switches.length, 0);
  assert.ok(h.calls.every(c => c.node === 'primary'));
  h.snapshot!.generation = 'external';
  await h.at(45000);
  assert.equal(h.engine.status().groups[0].latency!.samples.length, 1);
  assert.equal(h.engine.status().groups[0].latency!.decision, null);
  await h.engine.close();
});

test('responsive searches examine two rotating candidates and retain current when no gain exists', async () => {
  const h = harness({ responsive: true, preferred: ['primary', 'first', 'second', 'third'], fallback: [], probe: () => good(750) });
  for (let at = 0; at <= 370000; at += 1000) await h.at(at);
  const candidates = h.calls.filter(c => c.node !== 'primary');
  assert.deepEqual(candidates.slice(0, 2).map(c => c.node), ['first', 'second']);
  assert.deepEqual(candidates.slice(2, 4).map(c => c.node), ['third', 'first']);
  assert.equal(h.switches.length, 0);
  assert.equal(h.engine.status().groups[0].latency!.decision!.worthwhile, false);
  await h.engine.close();
});

test('responsive search traffic shares the physical quota and leaves hard failure recovery available', async () => {
  let time = 0;
  const starts: number[] = [], changes: { group: string; reason: string }[] = [];
  const snapshot: AutoSnapshot = { key: 'responsive-quota', generation: '1', probes: DEFAULT_AUTO_PROBES,
    groups: ['one', 'two', 'three', 'four', 'fault'].map(name => ({ name, current: name,
      policy: { latency: { mode: 'responsive', slowMs: 500 }, preferred: [name, name + '-next'], fallback: [], returnToPreferred: false } })) };
  const engine = createAutomaticSelector({ now: () => time, snapshot: async () => snapshot,
    probe: async (_s, node) => { starts.push(time); return node === 'fault' && time >= 30000 ? bad() : good(node.endsWith('-next') ? 700 : 800); },
    switch: async (_s, group, node, reason) => {
      changes.push({ group, reason }); snapshot.groups.find(g => g.name === group)!.current = node;
      snapshot.generation = String(Number(snapshot.generation) + 1); return true;
    } });
  for (time = 0; time <= 100000; time += 1000) await engine.tick();
  assert.ok(changes.some(c => c.group === 'fault' && c.reason === 'failure-recovery'));
  for (const at of starts) assert.ok(starts.filter(s => s <= at && s > at - 60000).length <= 24);
  await engine.close();
});

test('healthy monitoring includes manual outside nodes, measures only unique currents every 30 seconds and coalesces results', async () => {
  const h = harness({ names: ['one', 'two'], current: 'outside' });
  await h.at(0); await h.at(29_999);
  assert.deepEqual(h.calls.map(call => call.node), ['outside']);
  await h.at(30_000);
  assert.deepEqual(h.calls.map(call => call.node), ['outside', 'outside']);
  assert.equal(h.switches.length, 0);
  assert.ok(h.engine.status().groups.every(group => group.phase === 'monitoring'));
  await h.engine.close();
});

test('automatic diagnostics bound repeated failures, report recovery once and contain a failing observer', () => {
  let time = 0;
  const events: AutoDiagnostic[] = [];
  const diagnostics = createAutomaticDiagnostics(() => time, event => { events.push(event); throw new Error('synthetic observer failure'); });
  diagnostics.fail('snapshot'); time = 1000; diagnostics.fail('snapshot');
  assert.equal(events.length, 1);
  time = 60_000; diagnostics.fail('snapshot');
  assert.deepEqual(events.map(event => [event.event, event.code, event.count]), [
    ['failure', 'AUTO_SNAPSHOT_UNAVAILABLE', 1], ['failure', 'AUTO_SNAPSHOT_UNAVAILABLE', 3],
  ]);
  time++; diagnostics.success('snapshot'); diagnostics.success('snapshot');
  assert.equal(events.length, 3); assert.equal(events[2].event, 'recovered');
  assert.equal(diagnostics.status(true, null, 0, null).error, null);
});

test('snapshot failures invalidate evidence, preserve residence and recover without leaking exception details', async () => {
  let time = 0, unavailable = false;
  const events: AutoDiagnostic[] = [], changes: string[] = [];
  const snapshot: AutoSnapshot = { key: 'diagnostic-synthetic', generation: '1', probes: DEFAULT_AUTO_PROBES,
    groups: [{ name: 'group', current: 'a', policy: { preferred: ['a', 'b'], fallback: [], returnToPreferred: false } }] };
  const engine = createAutomaticSelector({ now: () => time,
    snapshot: async () => { if (unavailable) throw new Error('EXAMPLE_ONLY_SECRET https://private.example/'); return snapshot; },
    probe: async (_s, node) => good((node === 'a') === !changes.length ? 2000 : 100),
    switch: async (_s, _g, node) => { changes.push(node); snapshot.groups[0].current = node; snapshot.generation = String(Number(snapshot.generation) + 1); return true; },
    diagnostic: event => { events.push(event); throw new Error('Synthetic diagnostic sink unavailable'); },
  });
  for (const at of [0, 30_000, 60_000, 60_001, 62_001]) { time = at; await engine.tick(); }
  assert.deepEqual(changes, ['b']);
  unavailable = true; time = 63_000; await engine.tick();
  assert.equal(engine.status().engine.state, 'error');
  assert.equal(engine.status().engine.error?.phase, 'snapshot');
  assert.equal(engine.status().groups[0].health, 'unknown');
  assert.equal(engine.status().engine.lastSnapshotAt, 62_001);
  unavailable = false;
  for (const at of [64_000, 94_000, 124_000, 124_001, 126_001]) { time = at; await engine.tick(); }
  assert.deepEqual(changes, ['b']); // The original two-minute residence was not lost.
  assert.equal(engine.status().engine.state, 'running');
  assert.equal(engine.status().engine.error, null);
  assert.deepEqual(events.map(event => event.event), ['failure', 'recovered']);
  assert.doesNotMatch(JSON.stringify({ events, engine: engine.status().engine }), /EXAMPLE_ONLY_SECRET|private\.example/);
  await engine.close();
  assert.equal(engine.status().engine.reason, 'stopped');
});

test('normal node failures and generation conflicts are distinct from probe service and unexpected tick failures', async () => {
  let time = 0, mode = 'service', nullSnapshot = false, invalidReason = false;
  const events: AutoDiagnostic[] = [];
  const snapshot: AutoSnapshot = { key: 'synthetic', generation: '1', probes: DEFAULT_AUTO_PROBES,
    groups: [{ name: 'group', current: 'a', policy: { preferred: ['a'], fallback: [], returnToPreferred: false } }] };
  const engine = createAutomaticSelector({ now: () => time, snapshot: async () => nullSnapshot ? null : snapshot,
    suspensionReason: () => { if (invalidReason) throw new Error('EXAMPLE_ONLY_PRIVATE_PATH'); return 'paused'; },
    probe: async () => {
      if (mode === 'service') throw new Error('EXAMPLE_ONLY_SECRET');
      if (mode === 'conflict') throw new ManagementError('ACTIVE_CONFLICT', 409);
      return bad();
    }, switch: async () => false, diagnostic: event => { events.push(event); },
  });
  await engine.tick(); assert.equal(engine.status().engine.error?.code, 'AUTO_PROBE_UNAVAILABLE');
  mode = 'node'; time = 2000; await engine.tick();
  assert.equal(engine.status().engine.error, null); // A completed negative probe is still a working service.
  nullSnapshot = true; time++; await engine.tick();
  assert.equal(engine.status().engine.state, 'suspended'); assert.equal(engine.status().engine.reason, 'paused');
  nullSnapshot = false; mode = 'conflict'; time++; await engine.tick();
  assert.equal(engine.status().engine.error, null);
  nullSnapshot = true; invalidReason = true; time++;
  await assert.rejects(engine.tick(), /EXAMPLE_ONLY_PRIVATE_PATH/);
  assert.equal(engine.status().engine.error?.code, 'AUTO_INTERNAL_ERROR');
  invalidReason = false; time++; await engine.tick();
  assert.equal(engine.status().engine.error, null);
  assert.doesNotMatch(JSON.stringify(events), /EXAMPLE_ONLY/);
  await engine.close();
});

test('outside node failure requires delayed secondary evidence; candidates confirm in preferred order and stop before fallback', async () => {
  let firstCalls = 0;
  const h = harness({ current: 'outside', preferred: ['first', 'second'], probe: node => {
    if (node === 'outside') throw new Error('ACTIVE_CONFLICT'); // A matching message alone is still a real failure.
    return node === 'first' && ++firstCalls > 1 ? bad() : good();
  } });
  await h.at(0); await h.at(1999);
  assert.equal(h.calls.length, 1);
  await h.at(2000); await h.at(2001);
  assert.deepEqual(h.calls.map(call => [call.node, call.secondary]), [['outside', false], ['outside', true], ['first', false], ['second', false]]);
  await h.at(4000); assert.equal(h.switches.length, 0);
  await h.at(4001); await h.at(6001);
  assert.deepEqual(h.switches.map(item => item.node), ['second']);
  assert.ok(h.calls.every(call => call.node !== 'backup'));
  assert.equal(h.engine.status().events[0].reason, 'failure-recovery');
  await h.engine.close();
});

test('three slow samples require both improvement thresholds; failed search cools down but hard failure bypasses it', async () => {
  let failed = false;
  const h = harness({ preferred: ['primary', 'alternate'], fallback: [], probe: node => node === 'primary' ? failed ? bad() : good(2000) : good(1300) });
  await h.at(0); await h.at(30_000); assert.ok(h.calls.every(call => call.node === 'primary'));
  await h.at(60_000); await h.at(60_001);
  assert.equal(h.calls.filter(call => call.node === 'alternate').length, 1);
  assert.equal(h.engine.status().groups[0].reason, 'no-better-candidate');
  await h.at(90_000); await h.at(120_000); await h.at(150_000); await h.at(150_001);
  assert.equal(h.calls.filter(call => call.node === 'alternate').length, 1);
  failed = true;
  await h.at(180_000); await h.at(182_000); await h.at(182_001); await h.at(184_001);
  assert.equal(h.switches[0].node, 'alternate');
  await h.engine.close();
});

test('slow switch uses confirmed conservative delay and preserves residence across own generation changes', async () => {
  const h = harness({ preferred: ['primary', 'alternate'], fallback: [], probe: node => good(node === 'primary' ? 2000 : 1100) });
  await h.at(0); await h.at(30_000); await h.at(60_000); await h.at(60_001); await h.at(62_001);
  assert.equal(h.switches[0].reason, 'faster-candidate');
  await h.at(63_000);
  assert.equal(h.engine.status().groups[0].nextAt, 92_001);
  assert.equal(h.calls.filter(call => call.node === 'alternate').length, 2);
  await h.engine.close();
});

test('return checks back off 5, 10, 15, then 15 minutes and rotate at most two preferred nodes', async () => {
  const h = harness({ current: 'backup', preferred: ['one', 'two', 'three'], probe: node => node === 'backup' ? good(50) : bad() });
  await h.at(0); await h.at(300_000); await h.at(300_001);
  assert.deepEqual(h.calls.filter(call => call.node !== 'backup').map(call => call.node), ['one', 'two']);
  for (const at of [900_001, 1_800_002, 2_700_003]) { await h.at(at); await h.at(at + 1); }
  assert.deepEqual(h.calls.filter(call => call.node !== 'backup').map(call => [call.node, call.at]), [
    ['one', 300_000], ['two', 300_001], ['three', 900_001], ['one', 900_002],
    ['two', 1_800_002], ['three', 1_800_003], ['one', 2_700_003], ['two', 2_700_004],
  ]);
  await h.engine.close();
});

test('profitable preferred return requires stable +30/+60 second evidence; early relapse postpones another return', async () => {
  let failPreferred = false;
  const h = harness({ current: 'backup', preferred: ['primary'], probe: node => node === 'backup' ? good(900) : failPreferred ? bad() : good(100) });
  await h.at(0); await h.at(300_000); await h.at(329_999); assert.equal(h.switches.length, 0);
  await h.at(330_000); await h.at(360_000);
  assert.equal(h.switches[0].node, 'primary');
  failPreferred = true;
  await h.at(390_000); await h.at(392_000); await h.at(392_001); await h.at(394_001);
  assert.equal(h.switches[1].node, 'backup');
  failPreferred = false;
  const count = h.calls.filter(call => call.node === 'primary').length;
  await h.at(1_291_999);
  assert.equal(h.calls.filter(call => call.node === 'primary').length, count);
  await h.at(1_292_000);
  assert.equal(h.calls.filter(call => call.node === 'primary').length, count + 1);
  await h.engine.close();
});

test('soft relapse after a preferred return respects minimum residence and escalates the repeated return penalty', async () => {
  let slowPreferred = false;
  const h = harness({ current: 'backup', preferred: ['primary'], probe: node => good(node === 'backup' ? 900 : slowPreferred ? 2000 : 100) });
  await h.at(0); await h.at(300_000); await h.at(330_000); await h.at(360_000);
  slowPreferred = true;
  await h.at(390_000); await h.at(420_000); await h.at(450_000); await h.at(450_001);
  assert.equal(h.switches.length, 1);
  await h.at(480_000); await h.at(480_001); await h.at(482_001);
  assert.equal(h.switches[1].node, 'backup');
  slowPreferred = false;
  let count = h.calls.filter(call => call.node === 'primary').length;
  await h.at(1_379_999); assert.equal(h.calls.filter(call => call.node === 'primary').length, count);
  await h.at(1_380_000); await h.at(1_410_000); await h.at(1_440_000);
  assert.equal(h.switches[2].node, 'primary');
  slowPreferred = true;
  await h.at(1_470_000); await h.at(1_500_000); await h.at(1_530_000); await h.at(1_560_000);
  await h.at(1_560_001); await h.at(1_562_001);
  assert.equal(h.switches[3].node, 'backup');
  slowPreferred = false;
  count = h.calls.filter(call => call.node === 'primary').length;
  await h.at(3_359_999); assert.equal(h.calls.filter(call => call.node === 'primary').length, count);
  await h.at(3_360_000); assert.equal(h.calls.filter(call => call.node === 'primary').length, count + 1);
  await h.engine.close();
});

test('outage suspends normal monitoring, rotates at most three candidates, and backs off from completion', async () => {
  const h = harness({ preferred: ['primary', 'a', 'b', 'c', 'd', 'e', 'f'], fallback: [], probe: () => bad() });
  await h.at(0); await h.at(2000);
  for (let at = 2001; at <= 2006; at++) await h.at(at);
  assert.equal(h.engine.status().groups[0].phase, 'outage');
  assert.equal(h.engine.status().groups[0].nextAt, 17_006);
  const before = h.calls.length;
  for (let at = 17_006; at <= 17_009; at++) await h.at(at);
  assert.deepEqual(h.calls.slice(before).map(call => [call.node, call.secondary]), [
    ['primary', false], ['a', false], ['primary', true], ['a', true], ['b', false], ['b', true],
  ]);
  assert.equal(h.engine.status().groups[0].nextAt, 47_009);
  const second = h.calls.length;
  await h.at(30_000); assert.equal(h.calls.length, second);
  // Wait for the first round's starts to leave the shared rolling quota.
  for (let at = 77_009; at <= 77_012; at++) await h.at(at);
  assert.deepEqual(h.calls.slice(second).map(call => [call.node, call.secondary]), [
    ['c', false], ['d', false], ['c', true], ['d', true], ['e', false], ['e', true],
  ]);
  assert.equal(h.engine.status().groups[0].nextAt, 137_012);
  await h.engine.close();
});

test('failure and outage recover preferred nodes through the alternate target and keep its confirmed evidence', async () => {
  for (const availableAt of [0, 20_000]) {
    let primaryAvailable = false;
    const h = harness({ current: 'dead', preferred: ['dead', 'working'], fallback: availableAt ? [] : ['backup'], bandwidth: true,
      probe: (node, secondary, at) => node === 'dead' ? bad()
        : node === 'backup' || at >= availableAt && (secondary || primaryAvailable) ? good() : bad() });
    for (let at = 0; at <= 100_000; at += 1000) await h.at(at);
    assert.deepEqual(h.switches.map(item => item.node), ['working']);
    const switchedAt = h.switches[0].at;
    const confirmed = h.calls.filter(call => call.node === 'working' && call.at <= switchedAt);
    assert.deepEqual(confirmed.slice(-2).map(call => call.secondary), [true, true]);
    assert.ok(h.calls.filter(call => call.at > switchedAt).every(call => call.secondary));
    assert.ok(h.calls.every(call => call.node !== 'backup'));
    assert.equal(h.engine.status().groups[0].bandwidth!.pool.find(node => node.name === 'working')!.delayMs, 100);
    for (const call of h.calls) assert.ok(h.calls.filter(other => other.at > call.at - 60_000 && other.at <= call.at).length <= 24);
    primaryAvailable = true;
    await h.at(switchedAt + 900_000); await h.at(switchedAt + 930_000);
    assert.equal(h.calls.at(-1)!.secondary, false);
    await h.engine.close();
  }
});

test('rolling quota is global, concurrent workers stay at two, and queued groups eventually run fairly', async () => {
  let active = 0, maximum = 0;
  const h = harness({ names: Array.from({ length: 30 }, (_, i) => `group-${i}`), probe: async () => {
    maximum = Math.max(maximum, ++active); await Promise.resolve(); active--; return good();
  } });
  h.snapshot!.groups.forEach((group, i) => { group.current = `node-${i}`; group.policy.preferred = [group.current]; });
  await h.at(0);
  assert.equal(h.calls.length, 2);
  for (let at = 1000; at <= 11_000; at += 1000) await h.at(at);
  assert.equal(h.calls.length, 24); assert.equal(maximum, 2);
  assert.equal(h.engine.status().engine.reason, 'quota');
  assert.equal(h.engine.status().engine.nextStartAt, 60_000);
  assert.equal(h.engine.status().engine.pendingProbes, 6);
  await h.at(59_999); assert.equal(h.calls.length, 24);
  await h.at(60_000);
  for (let at = 61_000; at <= 71_000; at += 1000) await h.at(at);
  assert.ok(h.calls.some(call => call.node === 'node-29'));
  assert.equal(h.calls.length, 48);
  await h.engine.close();
});

test('a slow batch yields before queued monitors and the next tick prioritizes an overdue failure confirmation', async () => {
  let release!: () => void;
  const h = harness({ names: ['fault', 'slow', 'queued-one', 'queued-two'], probe: async node => {
    if (node === 'fault') return bad();
    if (node === 'slow') await new Promise<void>(resolve => { release = resolve; });
    return good();
  } });
  h.snapshot!.groups.forEach(group => { group.current = group.name; group.policy.preferred = [group.name, 'alternate']; });
  const pending = h.at(0);
  await new Promise<void>(resolve => setImmediate(resolve));
  const duplicate = h.engine.tick();
  assert.deepEqual(h.calls.map(call => call.node), ['fault', 'slow']);
  h.setTime(3000); release(); await Promise.all([pending, duplicate]);
  assert.equal(h.calls.length, 2); // No old-queue draining after the slow request completes.
  await h.at(3000);
  assert.deepEqual(h.calls.slice(2).map(call => [call.node, call.secondary]), [['fault', true], ['queued-one', false]]);
  await h.at(3001);
  assert.ok(h.calls.some(call => call.node === 'queued-two'));
  await h.engine.close();
});

test('retry-after postpones observations and serialized ticks cannot create duplicate samples', async () => {
  let release!: (result: ProbeResult) => void;
  const h = harness({ probe: () => new Promise(resolve => { release = resolve; }) });
  const first = h.at(0);
  await Promise.resolve(); await Promise.resolve();
  const duplicate = h.engine.tick();
  release({ ok: false, delay: null, retryAfterMs: 10_000 });
  await Promise.all([first, duplicate]);
  assert.equal(h.calls.length, 1);
  assert.equal(h.engine.status().engine.reason, 'retry-after');
  assert.equal(h.engine.status().engine.nextStartAt, 10_000);
  await h.at(9999); assert.equal(h.calls.length, 1);
  const after = h.at(10_000); await Promise.resolve(); await Promise.resolve(); release(good()); await after;
  assert.equal(h.calls.length, 2);
  assert.equal(h.engine.status().groups[0].phase, 'monitoring');
  await h.engine.close();
});

test('structured generation conflicts discard evidence without refunding starts or retrying inside a tick', async () => {
  let conflict = true;
  const h = harness({ probe: () => { if (conflict) throw new ManagementError('ACTIVE_CONFLICT', 409); return good(); } });
  for (let at = 0; at < 25_000; at += 1000) {
    await h.at(at);
    assert.equal(h.engine.status().groups[0].phase, 'monitoring');
  }
  assert.equal(h.calls.length, 24);
  assert.equal(h.switches.length, 0);
  conflict = false;
  await h.at(59_999); assert.equal(h.calls.length, 24);
  await h.at(60_000); assert.equal(h.calls.length, 25);
  assert.equal(h.engine.status().groups[0].health, 'healthy');
  await h.engine.close();
});

test('a committed group switch fences old in-flight and queued confirmations without resetting its residence', async () => {
  for (const result of ['conflict', 'healthy'] as const) {
    let time = 0, switched!: () => void;
    const committed = new Promise<void>(resolve => { switched = resolve; });
    const calls: { node: string; at: number; generation: string }[] = [], changes: string[] = [];
    const snapshot: AutoSnapshot = { key: 'stable-config', generation: '1', probes: structuredClone(DEFAULT_AUTO_PROBES),
      groups: ['a', 'b', 'c'].map(node => ({ name: node, current: node,
        policy: { preferred: [node, node + '-next'], fallback: [], returnToPreferred: true } })) };
    const engine = createAutomaticSelector({ now: () => time, snapshot: async () => snapshot,
      probe: async (s, node) => {
        calls.push({ node, at: time, generation: s.generation });
        if (time === 35_001 && node === 'b-next') {
          await committed;
          if (result === 'conflict') throw new ManagementError('ACTIVE_CONFLICT', 409);
        }
        return time >= 30_000 && time <= 35_001 && !node.endsWith('-next') ? bad() : good();
      },
      switch: async (_s, group, node) => {
        changes.push(group); snapshot.groups.find(item => item.name === group)!.current = node;
        snapshot.generation = '2'; switched(); return true;
      } });
    for (const at of [0, 1000, 30_000, 31_000, 32_000, 33_000, 33_001, 35_001]) { time = at; await engine.tick(); }
    assert.deepEqual(changes, ['a']);
    assert.ok(!calls.some(call => call.at === 35_001 && call.node === 'c-next'));
    for (const at of [36_000, 38_000]) { time = at; await engine.tick(); }
    assert.deepEqual(changes, ['a']);
    assert.equal(engine.status().groups[0].nextAt, 65_001);
    assert.ok(engine.status().groups.slice(1).every(group => group.health === 'healthy' && group.phase === 'monitoring'));
    assert.ok(calls.filter(call => call.at === 36_000).every(call => call.generation === '2' && ['b', 'c'].includes(call.node)));
    await engine.close();
  }
});

test('late probes cannot switch after snapshot changes or close; close waits for pending work', async () => {
  let resolveProbe!: (result: ProbeResult) => void;
  let held = false;
  const h = harness({ probe: node => node === 'primary' ? bad() : held
    ? new Promise(resolve => { resolveProbe = resolve; }) : good() });
  await h.at(0); await h.at(2000); await h.at(2001);
  held = true;
  const tick = h.at(4001); await Promise.resolve(); await Promise.resolve();
  h.snapshot = { ...h.snapshot!, generation: '2' };
  resolveProbe(good()); await tick;
  assert.equal(h.switches.length, 0);
  assert.equal(h.engine.status().groups[0].phase, 'failure-search');
  h.snapshot = null; await h.at(4002);
  assert.deepEqual(h.engine.status().groups, []);
  await h.engine.close();

  const pending = harness({ probe: () => new Promise(resolve => { resolveProbe = resolve; }) });
  const work = pending.at(0); await Promise.resolve(); await Promise.resolve();
  let closed = false;
  const closing = pending.engine.close().then(() => { closed = true; });
  await Promise.resolve(); assert.equal(closed, false);
  resolveProbe(good()); await work; await closing;
  await pending.at(60_000); assert.equal(pending.calls.length, 1);
});

test('group target recovery coalesces identical probes and requires two healthy primary checks', async () => {
  let primaryAvailable = false;
  const h = harness({ names: ['one', 'two'], probe: (_node, secondary) => secondary || primaryAvailable ? good() : bad() });
  // Real snapshots can recreate settings objects on every read.
  await h.at(0);
  h.snapshot = structuredClone(h.snapshot);
  await h.at(2000); await h.at(32_000);
  assert.equal(h.calls.length, 3);
  assert.equal(h.calls[2].secondary, true);
  assert.equal(h.switches.length, 0);
  await h.at(901_999);
  const primaryBefore = h.calls.filter(call => !call.secondary).length;
  await h.at(902_000);
  assert.equal(h.calls.filter(call => !call.secondary).length, primaryBefore + 1);
  await h.at(1_801_999);
  assert.equal(h.calls.filter(call => !call.secondary).length, primaryBefore + 1);
  primaryAvailable = true;
  await h.at(1_802_000);
  assert.ok(h.engine.status().groups.every(g => g.probeTarget === 'secondary'));
  await h.at(1_832_000);
  assert.ok(h.engine.status().groups.every(g => g.probeTarget === 'primary'));
  assert.equal(h.calls.at(-1)!.secondary, false);
  assert.equal(h.switches.length, 0);
  await h.engine.close();
});

test('a group target fallback cannot change another group or misroute its overlapping candidate probe', async () => {
  let time = 0;
  const calls: { node: string; secondary: boolean }[] = [], changes: string[] = [];
  const snapshot: AutoSnapshot = { key: 'target-isolation', generation: '1', probes: structuredClone(DEFAULT_AUTO_PROBES),
    groups: ['a', 'c'].map((current, i) => ({ name: `group-${i}`, current, policy: {
      preferred: [current, 'shared'], fallback: [], returnToPreferred: false,
      bandwidth: { ...DEFAULT_BANDWIDTH_SETTINGS, enabled: true },
    } })) };
  const engine = createAutomaticSelector({ now: () => time, snapshot: async () => snapshot,
    probe: async (_s, node, target) => {
      const secondary = target.url === DEFAULT_AUTO_PROBES.secondary.url; calls.push({ node, secondary });
      return node === 'a' && !secondary ? bad() : good();
    }, switch: async (_s, group, node) => {
      changes.push(group); snapshot.groups.find(g => g.name === group)!.current = node;
      snapshot.generation = String(Number(snapshot.generation) + 1); return true;
    }, bandwidth: { measure: async (_s, node) => ({ mbps: node === 'shared' ? 8 : 2, delayMs: 100, bytes: 0 }) } });
  for (let second = 0; second < 150 && !changes.length; second++) {
    time = second * 1000;
    engine.observeUsage({ epoch: 'isolation-core', download: 0, upload: 0, connections: [] });
    await engine.tick(); await new Promise<void>(resolve => setImmediate(resolve));
    if (second === 3) {
      assert.deepEqual(engine.status().groups.map(g => g.probeTarget), ['secondary', 'primary']);
      engine.requestBandwidthCheck('group-1');
    }
  }
  assert.deepEqual(changes, ['group-1']);
  assert.ok(calls.some(c => c.node === 'shared'));
  assert.ok(calls.filter(c => c.node === 'shared').every(c => !c.secondary));
  await engine.close();
});

test('bandwidth enhancement cannot block confirmed latency rescue or justify an unprofitable preferred return', async () => {
  for (const bandwidth of [false, true]) {
    const h = harness({ bandwidth, fallback: [], probe: node => good(node === 'primary' ? 2000 : 1000) });
    await h.at(0); await h.at(30000); await h.at(60000); await h.at(60001); await h.at(62001);
    assert.deepEqual(h.switches.map(s => s.reason), ['faster-candidate']);
    await h.engine.close();
    const stable = harness({ bandwidth, current: 'backup', preferred: ['primary'], probe: node => good(node === 'backup' ? 50 : 900) });
    await stable.at(0); await stable.at(300000); await stable.at(330000); await stable.at(360000);
    assert.deepEqual(stable.switches, []);
    await stable.engine.close();
  }
});

test('enhanced switch probes promptly and recovers a failing new node without discarding its individual penalty', async () => {
  let time = 0, suspended = false;
  const changes: { node: string; reason: string; at: number }[] = [], calls: { node: string; at: number }[] = [];
  const snapshot: AutoSnapshot = { key: 'post-switch', generation: '1', probes: structuredClone(DEFAULT_AUTO_PROBES),
    groups: [{ name: 'group', current: 'a', policy: { preferred: ['a', 'b'], fallback: [], returnToPreferred: false,
      bandwidth: { ...DEFAULT_BANDWIDTH_SETTINGS, enabled: true } } }] };
  const engine = createAutomaticSelector({ now: () => time, snapshot: async () => suspended ? null : snapshot,
    probe: async (_s, node) => {
      calls.push({ node, at: time });
      return node === 'b' && changes.length ? bad() : good(node === 'a' ? 80 : 150);
    },
    switch: async (_s, _group, node, reason) => {
      if (reason === 'bandwidth-improvement') {
        suspended = true; await new Promise<void>(resolve => setImmediate(resolve)); await engine.tick(); suspended = false;
      }
      changes.push({ node, reason, at: time }); snapshot.groups[0].current = node; snapshot.generation = String(Number(snapshot.generation) + 1);
      return true;
    },
    bandwidth: { measure: async (_s, node, _settings, _signal, report) => { report(1000000); return { mbps: node === 'a' ? 2 : 8, delayMs: 50, bytes: 1000000 }; } },
  });
  for (let second = 0; second < 110; second++) {
    time = second * 1000;
    engine.observeUsage({ epoch: 'core', download: 0, upload: 0, connections: [] });
    await engine.tick(); await new Promise<void>(resolve => setImmediate(resolve));
    if (second === 1) assert.equal(engine.requestBandwidthCheck('group'), true);
  }
  assert.deepEqual(changes.map(c => c.reason), ['bandwidth-improvement', 'failure-recovery']);
  assert.equal(changes[1].node, 'a'); assert.ok(changes[1].at - changes[0].at < 20000);
  assert.ok(calls.some(c => c.node === 'b' && c.at > changes[0].at && c.at <= changes[0].at + 5000));
  const node = engine.status().groups[0].bandwidth!.pool.find(n => n.name === 'b')!;
  assert.equal(node.reason, 'post-switch-failure'); assert.ok(node.nextAt >= changes[0].at + 300000);
  await engine.close();
});


test('retry-after still maintains in-flight download business protection without starting new work', async () => {
  let now = 0, total = 0, started = false, aborted = false, retryAt = 0;
  const probes: number[] = [], changes: string[] = [];
  const snapshot: AutoSnapshot = { key: 'retry-protection', generation: '1', probes: DEFAULT_AUTO_PROBES,
    groups: [{ name: 'group', current: 'a', policy: { preferred: ['a', 'b'], fallback: [], returnToPreferred: false,
      bandwidth: { ...DEFAULT_BANDWIDTH_SETTINGS, enabled: true } } }] };
  const engine = createAutomaticSelector({ now: () => now, snapshot: async () => snapshot,
    probe: async () => {
      probes.push(now);
      if (started && !retryAt) { retryAt = now; return { ok: false, delay: null, retryAfterMs: 10000 }; }
      return good();
    }, switch: async (_s, _g, node) => { changes.push(node); return true; },
    bandwidth: { measure: async (_s, _n, _settings, signal, _report, _group, phase) => {
      started = true; phase('download');
      await new Promise<void>(resolve => signal.addEventListener('abort', () => { aborted = true; resolve(); }, { once: true }));
      return null;
    } },
  });
  for (let i = 0; i < 25 && !aborted; i++) {
    now = i * 1000;
    if (retryAt) total += 500000;
    engine.observeUsage({ epoch: 'retry', download: total, upload: 0, connections: [] });
    await engine.tick(); await new Promise<void>(resolve => setImmediate(resolve));
    if (i === 1) engine.requestBandwidthCheck('group');
  }
  assert.ok(retryAt > 0); assert.equal(aborted, true); assert.ok(now < retryAt + 10000);
  assert.equal(probes.at(-1), retryAt); assert.deepEqual(changes, []);
  await engine.close();
});
