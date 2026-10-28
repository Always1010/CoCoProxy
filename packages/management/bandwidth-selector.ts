import type { AutoSnapshot, ProbeResult } from './automatic-selector.ts';
import type { UsageSnapshot } from './usage.ts';
import { bandwidthDecision, bandwidthGuard, bandwidthInterval, bandwidthSamples, bandwidthThreshold,
  type BandwidthSettings, type BandwidthSample } from './bandwidth-policy.ts';

const MiB = 1048576, HOUR = 3600000, DAY = 24 * HOUR, PROBE_FRESH = 30000, UNKNOWN_WAIT = 30000;
const ACTIVE_CANDIDATES = 3;
export type BandwidthLedger = { version: 1; charges: { at: number; bytes: number }[];
  switches: { at: number; scope: string; group: string; from: string; to: string }[] };
export function parseBandwidthLedger(input: unknown): BandwidthLedger {
  const value = input as BandwidthLedger;
  const integer = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0;
  const text = (s: unknown): s is string => typeof s === 'string' && s.length <= 4096;
  if (!value || value.version !== 1 || !Array.isArray(value.charges) || value.charges.length > 4096 || !Array.isArray(value.switches)
      || value.switches.length > 4096 || value.charges.some(c => !c || !integer(c.at) || !integer(c.bytes))
      || value.switches.some(s => !s || !integer(s.at) || !text(s.scope) || !text(s.group) || !text(s.from) || !text(s.to))) throw new Error('BANDWIDTH_LEDGER_INVALID');
  return value;
}
type Context = { name: string; ready: boolean; degraded?: boolean };
type Observation = { at: number; elapsed: number; bytes: number };
type Trigger = 'traffic' | 'manual' | 'latency' | 'return';
type NodeState = 'pending' | 'confirming' | 'verified' | 'backoff' | 'unavailable';
type Node = { name: string; preferred: boolean; samples: BandwidthSample[];
  probe: { at: number; delay: number | null; ok: boolean } | null;
  state: NodeState; reason: string; nextAt: number; checkedAt: number | null; measuredAt: number | null;
  failures: number; misses: number; earlyFailures: number; activeMs: number; useSince: number };
type Pool = { name: string; current: string; nodes: Map<string, Node>; active: string[];
  trigger: Trigger | null; urgentUntil: number; positiveUntil: number; pauseUntil: number;
  started: number | null; spent: number; candidateDownloads: number;
  lastSwitch: { at: number; from: string; to: string } | null;
  phase: string; reason: string; candidate: string | null; testingNode: string | null; nextAt: number | null;
  decision: ReturnType<typeof bandwidthDecision> };

/** Low-priority, single-flight pool: a node's failed comparison never cools down its group. */
export function createBandwidthSelector(options: {
  now: () => number;
  measure?: (snapshot: AutoSnapshot, node: string, settings: BandwidthSettings, signal: AbortSignal,
    bytes: (used: number) => void) => Promise<{ delayMs: number; mbps: number; bytes: number } | null>;
  probe: (snapshot: AutoSnapshot, node: string, signal: AbortSignal) => Promise<ProbeResult>;
  select: (snapshot: AutoSnapshot, group: string, node: string) => Promise<boolean>;
  busy?: () => boolean;
  load?: () => Promise<BandwidthLedger>;
  save?: (value: BandwidthLedger) => Promise<void>;
}) {
  let snapshot: AutoSnapshot | null = null, closed = false, loaded = false, storageFailed = false, fairCursor = 0;
  let flight: { abort: AbortController; done: Promise<void>; pool?: Pool; node?: Node; kind: 'load' | 'probe' | 'download' | 'select' } | undefined;
  let ledger: BandwidthLedger = { version: 1, charges: [], switches: [] };
  let previous: { at: number; snapshot: UsageSnapshot } | undefined;
  let pressure: { group: string; baseline?: number; count: number } | undefined;
  let expected: { key: string; until: number; currents: Map<string, string> } | undefined;
  let lastIdentity = '', lastGeneration: string | undefined;
  const pools = new Map<string, Pool>(), observations = new Map<string, Observation[]>(), positives = new Map<string, number>();
  const enabled = (s: AutoSnapshot | null) => s?.groups.filter(g => g.policy.bandwidth?.enabled) ?? [];
  const settingsFor = (p: Pool) => snapshot?.groups.find(g => g.name === p.name)?.policy.bandwidth;
  const alive = (p: Pool, s: AutoSnapshot, signal: AbortSignal) => !closed && !signal.aborted && pools.get(p.name) === p
    && snapshot?.key === s.key && snapshot.generation === s.generation
    && snapshot.groups.find(g => g.name === p.name)?.current === s.groups.find(g => g.name === p.name)?.current;
  const note = (p: Pool, phase: string, reason: string, nextAt: number | null = null) => {
    p.phase = phase; p.reason = reason; p.nextAt = nextAt;
  };
  const recent = (p: Pool) => ledger.switches.filter(s => s.scope === (snapshot?.scope ?? snapshot?.key) && s.group === p.name && s.at > options.now() - HOUR);
  function prune() {
    const at = options.now();
    // A backwards clock cannot replenish quotas.
    ledger.charges = ledger.charges.filter(c => c.at > at - DAY);
    ledger.switches = ledger.switches.filter(s => s.at > at - HOUR);
  }
  function budget() {
    prune();
    const settings = enabled(snapshot).map(g => g.policy.bandwidth!);
    return { hourBytes: ledger.charges.filter(c => c.at > options.now() - HOUR).reduce((n, c) => n + c.bytes, 0),
      dayBytes: ledger.charges.reduce((n, c) => n + c.bytes, 0),
      hourLimit: Math.min(...settings.map(s => s.hourMiB)) * MiB, dayLimit: Math.min(...settings.map(s => s.dayMiB)) * MiB,
      hourReserve: Math.max(0, ...settings.map(s => s.reserveHourMiB)) * MiB,
      dayReserve: Math.max(0, ...settings.map(s => s.reserveDayMiB)) * MiB };
  }
  function allowance(urgent: boolean) {
    const b = budget();
    return Math.max(0, Math.min(b.hourLimit - b.hourBytes - (urgent ? 0 : b.hourReserve),
      b.dayLimit - b.dayBytes - (urgent ? 0 : b.dayReserve)));
  }
  function budgetDue(urgent: boolean, bytes: number) {
    const b = budget(), at = options.now(), events = ledger.charges.flatMap(c => [c.at + HOUR, c.at + DAY]).filter(t => t > at).sort((a, b) => a - b);
    return events.find(t => ledger.charges.filter(c => c.at > t - HOUR).reduce((n, c) => n + c.bytes, 0) + bytes <= b.hourLimit - (urgent ? 0 : b.hourReserve)
      && ledger.charges.filter(c => c.at > t - DAY).reduce((n, c) => n + c.bytes, 0) + bytes <= b.dayLimit - (urgent ? 0 : b.dayReserve)) ?? null;
  }
  async function store() {
    try { await options.save?.(structuredClone(ledger)); }
    catch { storageFailed = true; throw new Error('BANDWIDTH_LEDGER_UNAVAILABLE'); }
  }
  function launch(kind: NonNullable<typeof flight>['kind'], run: (signal: AbortSignal) => Promise<void>, pool?: Pool, node?: Node) {
    const job = { abort: new AbortController(), done: Promise.resolve(), kind, pool, node };
    flight = job;
    job.done = run(job.abort.signal).catch(() => {
      if (pool && pools.get(pool.name) === pool) {
        if (node && !storageFailed) unknown(pool, node, 'sample-unknown');
        note(pool, 'waiting', storageFailed ? 'storage-unavailable' : 'sample-unknown', options.now() + UNKNOWN_WAIT);
      }
    }).finally(() => {
      if (pool) pool.testingNode = null;
      if (flight === job) flight = undefined;
    });
  }
  function interrupt(reason: string) {
    if (!flight?.pool || !['probe', 'download'].includes(flight.kind)) return;
    flight.abort.abort();
    if (flight.node) unknown(flight.pool, flight.node, reason);
    note(flight.pool, 'waiting', reason, options.now() + UNKNOWN_WAIT);
  }
  function clearEvidence(p: Pool) {
    p.active = []; p.decision = null; p.candidate = null; p.testingNode = null;
    for (const n of p.nodes.values()) { n.samples = []; n.probe = null; if (n.nextAt <= options.now()) n.state = 'pending'; }
  }
  function update(next: AutoSnapshot | null) {
    const identity = (s: AutoSnapshot | null) => JSON.stringify([s?.key, s?.scope, s?.probes, enabled(s).map(g => [g.name, g.policy])]);
    if (!next) {
      interrupt('suspended'); for (const p of pools.values()) clearEvidence(p);
      snapshot = null; previous = undefined; observations.clear(); positives.clear(); return;
    }
    const changed = lastIdentity !== identity(next);
    const generation = lastGeneration !== next.generation;
    const own = !changed && !!next && !!expected && expected.key === next.key && options.now() <= expected.until
      && next.groups.every(g => expected!.currents.get(g.name) === g.current);
    if (changed || generation) {
      interrupt('configuration-changed'); previous = undefined; observations.clear(); positives.clear();
      if (changed || !own) pools.clear();
      else for (const p of pools.values()) { clearEvidence(p); p.trigger = null; p.started = null; p.positiveUntil = 0; }
      expected = undefined;
    }
    lastIdentity = identity(next); lastGeneration = next.generation; snapshot = structuredClone(next);
    for (const name of pools.keys()) if (!enabled(next).some(g => g.name === name)) pools.delete(name);
    for (const g of enabled(next)) {
      let p = pools.get(g.name);
      if (!p) {
        p = { name: g.name, current: g.current, nodes: new Map(), active: [], trigger: null, urgentUntil: 0, positiveUntil: 0, pauseUntil: 0,
          started: null, spent: 0, candidateDownloads: 0, lastSwitch: null, phase: 'observing', reason: 'waiting-traffic',
          candidate: null, testingNode: null, nextAt: null, decision: null };
        pools.set(g.name, p);
      }
      if (p.current !== g.current) { interrupt('selection-conflict'); clearEvidence(p); p.current = g.current; p.trigger = null; }
      for (const name of [...g.policy.preferred, ...g.policy.fallback]) if (!p.nodes.has(name)) p.nodes.set(name,
        { name, preferred: g.policy.preferred.includes(name), samples: [], probe: null, state: 'pending', reason: 'waiting-evidence',
          nextAt: 0, checkedAt: null, measuredAt: null, failures: 0, misses: 0, earlyFailures: 0, activeMs: 0, useSince: 0 });
    }
  }
  function observe(sample: UsageSnapshot) {
    if (closed || !enabled(snapshot).length) return;
    const at = options.now(), old = previous;
    previous = { at, snapshot: sample };
    if (!old || old.snapshot.epoch !== sample.epoch || at - old.at > 5000 || at <= old.at) { observations.clear(); positives.clear(); return; }
    const prior = new Map(old.snapshot.connections.map(c => [c.id, c])), bytes = new Map<string, number>();
    for (const c of sample.connections) {
      const p = prior.get(c.id);
      if (!p || p.outbound !== c.outbound || c.download < p.download) continue;
      bytes.set(c.outbound, (bytes.get(c.outbound) ?? 0) + c.download - p.download);
    }
    const elapsed = at - old.at;
    bytes.set('\0total', Math.max(0, sample.download - old.snapshot.download));
    for (const node of new Set(['\0total', ...enabled(snapshot).flatMap(g => [g.current, ...g.policy.preferred, ...g.policy.fallback])])) {
      const rows = observations.get(node) ?? [];
      rows.push({ at, elapsed, bytes: bytes.get(node) ?? 0 });
      observations.set(node, rows.filter(r => r.at > at - 90000).slice(-100));
      if (node === '\0total') continue;
      const recent = rows.filter(r => r.at > at - 10000), duration = recent.reduce((n, r) => n + r.elapsed, 0);
      for (const g of enabled(snapshot)) {
        if (duration >= 5000 && recent.reduce((n, r) => n + r.bytes, 0) * 8 / duration / 1000 >= g.policy.bandwidth!.targetMbps) positives.set(g.name + '\0' + node, at);
        const p = pools.get(g.name), n = p?.nodes.get(node);
        // Only real traffic on the actual current outbound builds familiarity; idle time does not.
        if (p?.current === node && n && (bytes.get(node) ?? 0) > 0 && n.probe?.ok && at - n.probe.at <= 60000) {
          if (at - n.useSince >= DAY) n.activeMs = 0;
          if (!n.activeMs) n.useSince = at;
          n.activeMs = Math.min(600000, n.activeMs + elapsed);
        }
      }
    }
  }
  function quiet(s: BandwidthSettings) {
    const rows = observations.get('\0total')?.filter(r => r.at > options.now() - s.quietSeconds * 1000) ?? [];
    return !!previous && options.now() - previous.at < 3000 && rows.reduce((n, r) => n + r.elapsed, 0) >= s.quietSeconds * 1000 - 1500
      && rows.every(r => r.bytes * 8 / r.elapsed / 1000 < s.busyStartMbps);
  }
  function suspect(p: Pool, s: BandwidthSettings) {
    if (options.now() < p.positiveUntil || options.now() - (positives.get(p.name + '\0' + p.current) ?? -Infinity) < s.positiveSeconds * 1000) return false;
    const active = (observations.get(p.current) ?? []).filter(r => r.bytes > 0);
    const elapsed = active.reduce((n, r) => n + r.elapsed, 0), bytes = active.reduce((n, r) => n + r.bytes, 0);
    return elapsed >= s.activeSeconds * 1000 && bytes >= s.minTrafficMiB * MiB && bytes * 8 / elapsed / 1000 < s.targetMbps * s.suspectRatio;
  }
  function unknown(p: Pool, n: Node, reason: string) {
    n.reason = reason; n.nextAt = Math.max(n.nextAt, options.now() + UNKNOWN_WAIT);
    n.state = 'backoff'; p.active = p.active.filter(name => name !== n.name);
  }
  function reject(p: Pool, n: Node, s: BandwidthSettings, reason: string, unavailable = false) {
    const steps = unavailable ? [30000, 60000, 120000, 300000] : [120000, 300000, 900000, s.cooldownSeconds * 1000];
    const count = unavailable ? n.failures++ : n.misses++;
    const delay = steps[Math.min(count, steps.length - 1)];
    n.nextAt = options.now() + (unavailable ? delay : Math.min(delay, s.cooldownSeconds * 1000));
    n.reason = reason; n.state = unavailable ? 'unavailable' : 'backoff'; n.samples = [];
    if (unavailable) n.activeMs = 0;
    p.active = p.active.filter(name => name !== n.name);
  }
  function observeProbe(name: string, node: string, result: ProbeResult) {
    const n = pools.get(name)?.nodes.get(node);
    if (!n || result.retryAfterMs) return;
    n.probe = { at: options.now(), ok: result.ok && result.delay !== null && Number.isFinite(result.delay) && result.delay >= 0,
      delay: result.delay };
  }
  function values(n: Node, s: BandwidthSettings) {
    n.samples = bandwidthSamples(n.samples, s, options.now());
    if (!n.samples.length && n.nextAt <= options.now()) n.state = 'pending';
    return n.samples;
  }
  function preferences(p: Pool, n: Node) {
    return { currentPreferred: p.nodes.get(p.current)!.preferred, candidatePreferred: n.preferred,
      unfamiliar: n.activeMs < 600000 || options.now() - n.useSince >= DAY };
  }
  function comparison(p: Pool, n: Node, s: BandwidthSettings) {
    const switches = recent(p), reverse = switches.some(e => e.from === n.name && e.at > options.now() - s.reverseWindowSeconds * 1000);
    const evidence = (node: Node, current: boolean) => values(node, s).map(sample => {
      if (!node.probe?.ok || node.probe.delay === null || options.now() - node.probe.at > PROBE_FRESH) return sample;
      // A recovered incumbent or newly slower candidate must reduce, never inflate, expected gain.
      return { ...sample, delayMs: (current ? Math.min : Math.max)(sample.delayMs, node.probe.delay) };
    });
    return bandwidthDecision(evidence(p.nodes.get(p.current)!, true), evidence(n, false), s, options.now(), switches.length, reverse, preferences(p, n));
  }
  function potential(p: Pool, n: Node, s: BandwidthSettings) {
    const current = bandwidthInterval(values(p.nodes.get(p.current)!, s), s, options.now(), false);
    if (!current || !n.probe?.ok || n.probe.delay === null) return true;
    if (n.probe.delay > Math.max(s.delayReferenceMs, current.delay * (1 + s.tradeoffRatio))) return false;
    const switches = recent(p), preference = preferences(p, n);
    const { threshold } = bandwidthThreshold(current.low, s, switches.length,
      switches.some(e => e.from === n.name && e.at > options.now() - s.reverseWindowSeconds * 1000), preference);
    const uncertainty = preference.unfamiliar ? s.unfamiliarPenaltyMs / 1000 : 0;
    return current.low - n.probe.delay / 1000 - s.marginMs / 1000 - uncertainty > threshold;
  }
  function urgent(p: Pool, s: BandwidthSettings) {
    if (options.now() < p.urgentUntil) return true;
    const samples = values(p.nodes.get(p.current)!, s);
    return samples.length >= s.confirmRounds && samples.every(v => v.mbps < s.targetMbps * s.suspectRatio);
  }
  function severe(p: Pool, s: BandwidthSettings) {
    const samples = values(p.nodes.get(p.current)!, s);
    return options.now() < p.urgentUntil || (samples.length >= s.confirmRounds && samples.every(v => v.mbps < s.targetMbps * 0.5));
  }
  function holding(p: Pool, s: BandwidthSettings) {
    const switches = recent(p), last = switches.at(-1);
    if (!last) return false;
    return severe(p, s) ? options.now() - last.at < 60000
      : options.now() - last.at < s.holdSeconds * 1000 || switches.length >= s.maxSwitches;
  }
  function fill(p: Pool, s: BandwidthSettings) {
    const at = options.now();
    p.active = p.active.filter(name => name !== p.current && p.nodes.get(name)!.nextAt <= at);
    const candidates = [...p.nodes.values()].filter(n => n.name !== p.current && n.nextAt <= at && !p.active.includes(n.name));
    candidates.sort((a, b) => Number(b.preferred) - Number(a.preferred) || (a.checkedAt ?? -1) - (b.checkedAt ?? -1)
      || (a.probe?.delay ?? Infinity) - (b.probe?.delay ?? Infinity));
    for (const n of candidates) { if (p.active.length >= ACTIVE_CANDIDATES) break; values(n, s); p.active.push(n.name); }
    return p.active.map(name => p.nodes.get(name)!);
  }
  function sampleDue(n: Node, s: BandwidthSettings) {
    const samples = values(n, s), last = samples.at(-1);
    return Math.max(n.nextAt, last ? (last.startedAt ?? last.at) + s.roundIntervalSeconds * 1000 : 0);
  }
  function missing(n: Node, s: BandwidthSettings) {
    const samples = values(n, s);
    return Math.max(samples.at(-1) && options.now() - samples.at(-1)!.at > s.latestSeconds * 1000 ? 1 : 0, s.confirmRounds - samples.length);
  }
  function yieldSearch(p: Pool, s: BandwidthSettings, reason: string) {
    p.pauseUntil = options.now() + s.yieldSeconds * 1000; p.started = null;
    note(p, 'waiting', reason, p.pauseUntil);
  }
  async function measure(p: Pool, n: Node, s: BandwidthSettings, snap: AutoSnapshot, signal: AbortSignal) {
    const charge = { at: options.now(), bytes: s.taskMiB * MiB };
    ledger.charges.push(charge); await store(); // Durable maximum before any network I/O.
    let used = 0;
    pressure = { group: p.name, count: 0 };
    try {
      if (signal.aborted) return null;
      return await options.measure!(snap, n.name, s, signal, bytes => {
        if (Number.isFinite(bytes) && bytes >= 0) used = Math.min(charge.bytes, Math.max(used, bytes));
      });
    } finally { pressure = undefined; charge.bytes = used; p.spent += used; await store(); }
  }
  function request(name: string, _node?: string, reason: Trigger = 'latency') {
    const p = pools.get(name);
    if (!p || closed) return false;
    if (reason === 'latency') { p.urgentUntil = options.now() + 90000; p.positiveUntil = 0; }
    if (!p.trigger || reason === 'manual' || reason === 'latency') p.trigger = reason;
    return true;
  }
  function selected(name: string, from: string, to: string, reason: string, source = snapshot) {
    const p = pools.get(name);
    if (!p || !source || from === to) return;
    expected = { key: source.key, until: options.now() + 30000, currents: new Map(source.groups.map(g => [g.name, g.name === name ? to : g.current])) };
    if (p.current === to) return;
    p.current = to; p.trigger = null; p.urgentUntil = 0; p.started = null; p.pauseUntil = 0;
    p.active = p.active.filter(n => n !== to);
    if (reason === 'bandwidth-improvement') p.lastSwitch = { at: options.now(), from, to };
  }
  function failure(name: string, node: string) {
    const p = pools.get(name), n = p?.nodes.get(node), s = p && settingsFor(p);
    if (!p || !n || !s) return;
    if (flight?.pool === p) interrupt('latency-priority');
    reject(p, n, s, 'candidate-unavailable', true);
    if (p.lastSwitch?.to === node && options.now() - p.lastSwitch.at <= 120000) {
      n.nextAt = Math.max(n.nextAt, options.now() + [300000, 900000, 1800000][Math.min(n.earlyFailures++, 2)]);
      n.reason = 'post-switch-failure';
    }
  }
  function tick(contexts: Context[]) {
    if (closed || !snapshot) { interrupt('suspended'); return; }
    const at = options.now();
    if (flight?.pool && ['probe', 'download'].includes(flight.kind)) {
      const p = flight.pool, s = settingsFor(p);
      if (!s || !contexts.find(c => c.name === p.name)?.ready || !previous || at - previous.at > 3000) interrupt('latency-priority');
      else if (flight.kind === 'download') {
        const rows = observations.get('\0total')?.filter(r => r.at > at - 2000) ?? [];
        if (rows.length >= 2 && rows.every(r => r.bytes * 8 / r.elapsed / 1000 > s.busyStopMbps)) interrupt('business-busy');
      }
    }
    if (flight) return;
    if (storageFailed) { for (const p of pools.values()) note(p, 'waiting', 'storage-unavailable'); return; }
    if (!loaded) {
      if (pools.size) launch('load', async () => {
        try { ledger = parseBandwidthLedger(await options.load?.() ?? ledger); loaded = true; prune(); }
        catch { storageFailed = true; }
      });
      return;
    }
    const names = [...pools.keys()];
    for (let i = 0; i < names.length; i++) {
      const index = (fairCursor + i) % names.length, p = pools.get(names[index])!, s = settingsFor(p)!;
      if (!options.measure) { note(p, 'waiting', 'measurement-unavailable'); continue; }
      if (!p.trigger && suspect(p, s)) p.trigger = 'traffic';
      if (!p.trigger) continue;
      if (contexts.find(c => c.name === p.name)?.degraded) p.urgentUntil = at + 90000;
      if (!contexts.find(c => c.name === p.name)?.ready) { note(p, 'waiting', 'latency-priority'); continue; }
      if (at < p.pauseUntil) { note(p, 'waiting', 'search-yield', p.pauseUntil); continue; }
      if (p.started === null) { p.started = at; p.spent = 0; }
      const current = p.nodes.get(p.current)!;
      const candidates = fill(p, s);
      const interval = bandwidthInterval(values(current, s), s, at, false);
      if (p.trigger === 'traffic' && interval && interval.mbps >= s.targetMbps && interval.delay <= s.delayReferenceMs) {
        p.trigger = null; p.started = null; p.positiveUntil = at + s.positiveSeconds * 1000;
        note(p, 'observing', 'current-sufficient', p.positiveUntil); continue;
      }
      // First choose among already confirmed nodes. Download permission is not required to use fresh evidence.
      const ready = candidates.map(n => ({ n, d: comparison(p, n, s) })).filter(e => e.d?.worthwhile)
        .sort((a, b) => a.d!.rank - b.d!.rank);
      if (ready.length && !holding(p, s)) {
        const { n, d } = ready[0]; p.decision = d; p.candidate = n.name;
        if (!n.probe || at - n.probe.at > PROBE_FRESH || !n.probe.ok) {
          launchProbe(p, n, s); fairCursor = (index + 1) % names.length; return;
        }
        if (!bandwidthGuard({ delay: interval!.delay, mbps: interval!.mbps }, { delay: n.probe.delay!, mbps: d!.candidate.mbps }, s)) {
          reject(p, n, s, 'shortfall-guard'); continue;
        }
        if (s.observeOnly) {
          p.trigger = null; p.started = null; p.positiveUntil = at + s.positiveSeconds * 1000;
          note(p, 'observing', 'would-switch', p.positiveUntil); continue;
        }
        const snap = structuredClone(snapshot);
        launch('select', async signal => {
          if (!alive(p, snap, signal)) return;
          const from = p.current;
          if (await options.select(snap, p.name, n.name)) {
            selected(p.name, from, n.name, 'bandwidth-improvement', snap);
            ledger.switches.push({ at: options.now(), scope: snap.scope ?? snap.key, group: p.name, from, to: n.name });
            await store(); note(p, 'holding', 'bandwidth-improvement', options.now() + s.holdSeconds * 1000);
          } else { unknown(p, n, 'selection-conflict'); note(p, 'waiting', 'selection-conflict', n.nextAt); }
        }, p);
        fairCursor = (index + 1) % names.length; return;
      }
      // While holding, only obtain current-node evidence needed to confirm a newly suspected deterioration.
      const held = holding(p, s);
      if (held && (p.trigger !== 'traffic' || values(current, s).length >= s.confirmRounds)) {
        note(p, 'holding', 'switch-limit', recent(p).at(-1)!.at + s.holdSeconds * 1000); continue;
      }
      if (!candidates.length && !held) {
        const due = [...p.nodes.values()].filter(n => n.name !== p.current).map(n => n.nextAt).filter(t => t > at);
        note(p, 'waiting', due.length ? 'pool-backoff' : 'no-candidate', due.length ? Math.min(...due) : null); continue;
      }
      if (p.spent + s.taskMiB * MiB > s.searchMiB * MiB || at - p.started > s.campaignSeconds * 1000) {
        yieldSearch(p, s, 'search-yield'); continue;
      }
      if (allowance(urgent(p, s)) < s.taskMiB * MiB) {
        note(p, 'waiting', 'budget-exhausted', budgetDue(urgent(p, s), s.taskMiB * MiB)); continue;
      }
      // Lightweight screening of the small active queue precedes bandwidth ranking.
      const unprobed = interval ? candidates.find(n => !n.probe || at - n.probe.at > PROBE_FRESH) : current;
      if (unprobed && (!unprobed.probe || at - unprobed.probe.at > PROBE_FRESH) && unprobed.nextAt <= at) {
        launchProbe(p, unprobed, s); fairCursor = (index + 1) % names.length; return;
      }
      for (const n of candidates) {
        if (n.probe?.ok && !potential(p, n, s)) reject(p, n, s, 'no-potential-gain');
        const d = comparison(p, n, s);
        if (d && !d.worthwhile) { p.decision = d; reject(p, n, s, d.guard ? 'no-clear-gain' : 'shortfall-guard'); }
        else if (interval && n.samples.length) {
          const c = bandwidthInterval(n.samples, s, at, false)!;
          if (!bandwidthGuard(interval, c, s)) reject(p, n, s, 'shortfall-guard');
        }
      }
      const eligible = candidates.filter(n => n.nextAt <= at && p.active.includes(n.name));
      const explored = eligible.filter(n => !values(n, s).length).sort((a, b) => Number(b.preferred) - Number(a.preferred)
        || (a.measuredAt ?? -1) - (b.measuredAt ?? -1) || (a.probe?.delay ?? Infinity) - (b.probe?.delay ?? Infinity));
      const promising = eligible.filter(n => values(n, s).length).sort((a, b) =>
        bandwidthInterval(a.samples, s, at, false)!.high + (a.preferred ? 0 : s.fallbackPenaltyMs / 1000)
        - bandwidthInterval(b.samples, s, at, false)!.high - (b.preferred ? 0 : s.fallbackPenaltyMs / 1000));
      const candidate = (p.candidateDownloads >= 2 ? explored[0] : promising[0]) ?? explored[0] ?? promising[0];
      // Do not repeatedly refresh the current node when every candidate is in backoff.
      let node = !interval || held ? current : candidate;
      if (candidate && missing(current, s) && (values(candidate, s).length || missing(current, s) > 1)) node = current;
      if (!node) continue;
      const due = sampleDue(node, s);
      if (at < due) { note(p, 'confirming', 'waiting-sample', due); continue; }
      if (!quiet(s) || options.busy?.()) { note(p, 'waiting', 'waiting-idle'); continue; }
      const isUrgent = urgent(p, s);
      // Reserve the missing current/candidate confirmation tasks before exploring a new candidate.
      const needed = candidate ? Math.max(1, missing(current, s) + missing(candidate, s)) * s.taskMiB * MiB : s.taskMiB * MiB;
      if (ledger.charges.length > 4000 || allowance(isUrgent) < needed) {
        note(p, 'waiting', 'budget-exhausted', budgetDue(isUrgent, needed)); continue;
      }
      if (p.spent + needed > s.searchMiB * MiB) { yieldSearch(p, s, 'search-yield'); continue; }
      if (!node.probe || at - node.probe.at > PROBE_FRESH) {
        launchProbe(p, node, s); fairCursor = (index + 1) % names.length; return;
      }
      if (!node.probe.ok || node.probe.delay === null) { reject(p, node, s, 'candidate-unavailable', true); continue; }
      const snap = structuredClone(snapshot), delayMs = node.probe.delay, selectedNode = node, startedAt = at;
      const wasExploration = !values(node, s).length;
      p.candidate = candidate?.name ?? null; p.testingNode = node.name;
      note(p, 'testing', 'collecting');
      launch('download', async signal => {
        const result = await measure(p, selectedNode, s, snap, signal);
        if (!alive(p, snap, signal)) return;
        selectedNode.measuredAt = options.now();
        if (!result || !Number.isFinite(result.mbps) || result.mbps <= 0) { unknown(p, selectedNode, 'sample-unknown'); return; }
        // All scores and screening use the same automatic probe target, not the transfer service's RTT.
        selectedNode.samples.push({ at: options.now(), startedAt, delayMs, mbps: result.mbps });
        values(selectedNode, s); selectedNode.reason = 'evidence-ready'; selectedNode.nextAt = 0;
        selectedNode.state = selectedNode.samples.length >= s.confirmRounds ? 'verified' : 'confirming';
        if (selectedNode.name !== p.current) p.candidateDownloads = wasExploration && p.candidateDownloads >= 2 ? 0 : p.candidateDownloads + 1;
        note(p, 'confirming', 'waiting-sample', sampleDue(selectedNode, s));
      }, p, node);
      fairCursor = (index + 1) % names.length; return;
    }
  }
  function launchProbe(p: Pool, n: Node, s: BandwidthSettings) {
    const snap = structuredClone(snapshot!);
    p.testingNode = n.name; note(p, 'screening', 'screening-latency');
    launch('probe', async signal => {
      const result = await options.probe(snap, n.name, signal);
      if (!alive(p, snap, signal)) return;
      if (result.retryAfterMs) { n.nextAt = options.now() + Math.max(1000, result.retryAfterMs); return; }
      observeProbe(p.name, n.name, result); n.checkedAt = options.now();
      if (!n.probe?.ok) reject(p, n, s, 'candidate-unavailable', true);
      else if (n.name !== p.current && !potential(p, n, s)) reject(p, n, s, 'no-potential-gain');
    }, p, n);
  }
  return { update, observe, tick, request, observeProbe, selected, failure,
    requestCheck(name: string) {
      const p = pools.get(name);
      if (!p || !options.measure || closed || p.nodes.size < 2) return false;
      return request(name, undefined, 'manual');
    },
    isMeasuring(group: string) { return pressure?.group === group; },
    isComparing(group: string) { return !!pools.get(group)?.trigger; },
    recoveryOrder(group: string, nodes: string[]) {
      const p = pools.get(group);
      return p ? [...nodes].sort((a, b) => Number((p.nodes.get(a)?.nextAt ?? 0) > options.now()) - Number((p.nodes.get(b)?.nextAt ?? 0) > options.now())
        || Number(b === p.lastSwitch?.from) - Number(a === p.lastSwitch?.from)) : nodes;
    },
    noteLatency(group: string, delay: number | null, baseline: number) {
      if (pressure?.group !== group || !flight) return;
      pressure.baseline ??= baseline;
      pressure.count = delay === null || delay - pressure.baseline > Math.max(50, pressure.baseline * 0.5) ? pressure.count + 1 : 0;
      if (pressure.count >= 2) interrupt('latency-pressure');
    },
    invalidateProbeTarget() {
      interrupt('configuration-changed');
      for (const p of pools.values()) clearEvidence(p);
    },
    status(name: string) {
      const p = pools.get(name), s = p && settingsFor(p);
      if (!p || !s) return undefined;
      return { phase: p.phase, reason: p.reason, candidate: p.candidate, testingNode: p.testingNode,
        round: p.candidate ? values(p.nodes.get(p.candidate)!, s).length : 0, nextAt: p.nextAt, decision: p.decision,
        ...budget(), searchBytes: p.spent, searchLimit: s.searchMiB * MiB, urgent: urgent(p, s),
        pool: [...p.nodes.values()].map(n => { const samples = values(n, s); return { name: n.name, preferred: n.preferred, current: n.name === p.current,
          state: n.state, reason: n.reason, samples: samples.length, delayMs: n.probe?.delay ?? null,
          mbps: bandwidthInterval(n.samples, s, options.now(), false)?.mbps ?? null,
          measuredAt: n.samples.at(-1)?.at ?? null, nextAt: n.nextAt, active: p.active.includes(n.name) }; }) };
    },
    async close() { closed = true; flight?.abort.abort(); await flight?.done; },
  };
}
