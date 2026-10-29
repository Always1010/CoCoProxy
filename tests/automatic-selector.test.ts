import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_AUTO_PROBES, parseAutoGroupPolicy, parseAutoProbeSettings } from '../packages/management/automatic-policy.ts';
import { DEFAULT_BANDWIDTH_SETTINGS } from '../packages/management/bandwidth-policy.ts';
import { createAutomaticSelector, type AutoSnapshot, type ProbeResult } from '../packages/management/automatic-selector.ts';
import { ManagementError } from '../packages/management/http.ts';

const good = (delay = 100): ProbeResult => ({ ok: true, delay });
const bad = (): ProbeResult => ({ ok: false, delay: null });

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
  bandwidth?: boolean;
  probe?: (node: string, secondary: boolean, at: number) => ProbeResult | Promise<ProbeResult> } = {}) {
  let time = 0;
  const policy = { preferred: options.preferred ?? ['primary', 'alternate'], fallback: options.fallback ?? ['backup'], returnToPreferred: true,
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
  for (const url of ['http://example.test/', 'https://user:SECRET@example.test/', 'https://example.test/?token=SECRET', 'https://example.test/#SECRET']) {
    invalid(() => parseAutoProbeSettings({ ...DEFAULT_AUTO_PROBES, primary: { url, expectedStatus: 204 } }));
  }
});

test('healthy monitoring measures only unique current nodes every 30 seconds and coalesces shared results', async () => {
  const h = harness({ names: ['one', 'two'] });
  await h.at(0); await h.at(29_999);
  assert.deepEqual(h.calls.map(call => call.node), ['primary']);
  await h.at(30_000);
  assert.deepEqual(h.calls.map(call => call.node), ['primary', 'primary']);
  assert.equal(h.switches.length, 0);
  assert.ok(h.engine.status().groups.every(group => group.phase === 'monitoring'));
  await h.engine.close();
});

test('failure requires delayed secondary evidence; candidates confirm in preferred order and stop before fallback', async () => {
  let firstCalls = 0;
  const h = harness({ preferred: ['primary', 'first', 'second'], probe: node => {
    if (node === 'primary') throw new Error('ACTIVE_CONFLICT'); // A matching message alone is still a real failure.
    return node === 'first' && ++firstCalls > 1 ? bad() : good();
  } });
  await h.at(0); await h.at(1999);
  assert.equal(h.calls.length, 1);
  await h.at(2000); await h.at(2001);
  assert.deepEqual(h.calls.map(call => [call.node, call.secondary]), [['primary', false], ['primary', true], ['first', false], ['second', false]]);
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
  await h.at(0); await h.at(300_000); await h.at(899_999);
  assert.deepEqual(h.calls.filter(call => call.node !== 'backup').map(call => call.node), ['one', 'two']);
  await h.at(900_000); await h.at(1_800_000); await h.at(2_700_000);
  assert.deepEqual(h.calls.filter(call => call.node !== 'backup').map(call => [call.node, call.at]), [
    ['one', 300_000], ['two', 300_000], ['three', 900_000], ['one', 900_000],
    ['two', 1_800_000], ['three', 1_800_000], ['one', 2_700_000], ['two', 2_700_000],
  ]);
  await h.engine.close();
});

test('return accepts slower preferred only after stable +30/+60 second evidence; early relapse postpones another return', async () => {
  let failPreferred = false;
  const h = harness({ current: 'backup', preferred: ['primary'], probe: node => node === 'backup' ? good(50) : failPreferred ? bad() : good(900) });
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
  const h = harness({ current: 'backup', preferred: ['primary'], probe: node => good(node === 'backup' ? 50 : slowPreferred ? 2000 : 900) });
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
  assert.equal(h.calls.length, 24); assert.equal(maximum, 2);
  await h.at(59_999); assert.equal(h.calls.length, 24);
  await h.at(60_000);
  assert.ok(h.calls.some(call => call.node === 'node-29'));
  assert.equal(h.calls.length, 48);
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
        if (time === 35_000 && node === 'b-next') {
          await committed;
          if (result === 'conflict') throw new ManagementError('ACTIVE_CONFLICT', 409);
        }
        return time >= 30_000 && time <= 35_000 && !node.endsWith('-next') ? bad() : good();
      },
      switch: async (_s, group, node) => {
        changes.push(group); snapshot.groups.find(item => item.name === group)!.current = node;
        snapshot.generation = '2'; switched(); return true;
      } });
    for (const at of [0, 30_000, 32_000, 33_000, 35_000]) { time = at; await engine.tick(); }
    assert.deepEqual(changes, ['a']);
    assert.ok(!calls.some(call => call.at === 35_000 && call.node === 'c-next'));
    for (const at of [36_000, 38_000]) { time = at; await engine.tick(); }
    assert.deepEqual(changes, ['a']);
    assert.equal(engine.status().groups[0].nextAt, 65_000);
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

test('a failing primary target changes the global active target and recovers through only one current node every 15 minutes', async () => {
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
  await h.at(1_802_000); await h.at(1_832_000);
  assert.equal(h.calls.at(-1)!.secondary, false);
  assert.equal(h.switches.length, 0);
  await h.engine.close();
});

test('turning off bandwidth enhancement immediately restores the original latency-only switching path', async () => {
  const h = harness({ bandwidth: true, fallback: [], probe: node => good(node === 'primary' ? 2000 : 1000) });
  await h.at(0); await h.at(30000); await h.at(60000);
  assert.equal(h.switches.length, 0);
  assert.ok(h.engine.status().groups[0].bandwidth);
  h.snapshot!.groups[0].policy.bandwidth!.enabled = false;
  await h.at(60001); await h.at(90001); await h.at(120001); await h.at(120002); await h.at(122002);
  assert.deepEqual(h.switches.map(s => s.reason), ['faster-candidate']);
  assert.equal(h.engine.status().groups[0].bandwidth, undefined);
  await h.engine.close();
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
