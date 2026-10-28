import type { AutoSnapshot, ProbeResult } from './automatic-selector.ts';
import type { UsageSnapshot } from './usage.ts';
import { bandwidthDecision, bandwidthLoss, type BandwidthSettings, type BandwidthSample } from './bandwidth-policy.ts';

const MiB = 1048576, HOUR = 3600000, DAY = 24 * HOUR;
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
type Context = { name: string; ready: boolean };
type Observation = { at: number; elapsed: number; bytes: number };
type Campaign = { snapshot: AutoSnapshot; group: string; from: string; candidate: string | null; settings: BandwidthSettings;
  started: number; due: number; roundAt: number; stage: 'current' | 'candidate'; current: BandwidthSample[]; samples: BandwidthSample[]; hint: boolean };
type View = { phase: string; reason: string; candidate: string | null; round: number; nextAt: number | null;
  decision: ReturnType<typeof bandwidthDecision>; hourBytes: number; dayBytes: number; hourLimit: number; dayLimit: number; testingNode: string | null };

/** Low-priority sidecar: downloads never hold the latency scheduler or the configuration lock. */
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
  let snapshot: AutoSnapshot | null = null, campaign: Campaign | undefined, closed = false;
  let flight: { abort: AbortController; done: Promise<void> } | undefined;
  let ledger: BandwidthLedger = { version: 1, charges: [], switches: [] }, loaded = false, storageFailed = false;
  let previous: { at: number; snapshot: UsageSnapshot } | undefined;
  let pressure: { group: string; baseline?: number; count: number } | undefined;
  const observations = new Map<string, Observation[]>(), positives = new Map<string, number>();
  const hints = new Map<string, string>(), cooldowns = new Map<string, number>(), cursors = new Map<string, number>(), views = new Map<string, View>();
  const enabled = (s: AutoSnapshot | null) => s?.groups.filter(g => g.policy.bandwidth?.enabled) ?? [];
  const key = (group: string) => `${snapshot?.scope ?? snapshot?.key}\0${group}`;
  const view = (name: string) => {
    let state = views.get(name);
    if (!state) { state = { phase: 'observing', reason: 'waiting-traffic', candidate: null, round: 0, nextAt: null,
      decision: null, hourBytes: 0, dayBytes: 0, hourLimit: 0, dayLimit: 0, testingNode: null }; views.set(name, state); }
    return state;
  };
  const prune = () => {
    const at = options.now();
    // Future timestamps are retained: a backwards clock must not replenish quotas.
    ledger.charges = ledger.charges.filter(c => c.at > at - DAY);
    ledger.switches = ledger.switches.filter(s => s.at > at - HOUR);
  };
  const budget = () => {
    prune();
    const settings = enabled(snapshot).map(g => g.policy.bandwidth!);
    return { hourBytes: ledger.charges.filter(c => c.at > options.now() - HOUR).reduce((sum, c) => sum + c.bytes, 0),
      dayBytes: ledger.charges.reduce((sum, c) => sum + c.bytes, 0),
      hourLimit: Math.min(...settings.map(s => s.hourMiB)) * MiB, dayLimit: Math.min(...settings.map(s => s.dayMiB)) * MiB };
  };
  const finish = (reason: string) => {
    if (!campaign) return;
    const state = view(campaign.group);
    Object.assign(state, { phase: 'cooldown', reason, testingNode: null, nextAt: options.now() + campaign.settings.cooldownSeconds * 1000 });
    cooldowns.set(key(campaign.group), state.nextAt!); hints.delete(campaign.group); campaign = undefined;
  };
  const cancel = (reason: string) => { flight?.abort.abort(); finish(reason); };
  const store = async () => { try { await options.save?.(structuredClone(ledger)); } catch { storageFailed = true; throw new Error('BANDWIDTH_LEDGER_UNAVAILABLE'); } };
  function launch(run: (signal: AbortSignal) => Promise<void>) {
    const job = { abort: new AbortController(), done: Promise.resolve() };
    flight = job;
    job.done = run(job.abort.signal).catch(() => { finish(storageFailed ? 'storage-unavailable' : 'sample-unknown'); })
      .finally(() => { if (flight === job) flight = undefined; });
  }
  function update(next: AutoSnapshot | null) {
    if (snapshot?.key !== next?.key || snapshot?.generation !== next?.generation) {
      cancel('configuration-changed'); hints.clear(); observations.clear(); positives.clear(); previous = undefined;
      views.clear();
    }
    snapshot = next;
    for (const name of views.keys()) if (!enabled(next).some(g => g.name === name)) views.delete(name);
    if (campaign && !enabled(next).some(g => g.name === campaign!.group)) cancel('disabled');
  }
  function observe(sample: UsageSnapshot) {
    if (closed || !enabled(snapshot).length) return;
    const at = options.now(), old = previous;
    previous = { at, snapshot: sample };
    if (!old || old.snapshot.epoch !== sample.epoch || at - old.at > 5000 || at <= old.at) {
      observations.clear(); positives.clear(); return;
    }
    const prior = new Map(old.snapshot.connections.map(c => [c.id, c]));
    const bytes = new Map<string, number>();
    for (const c of sample.connections) {
      const p = prior.get(c.id);
      if (!p || p.outbound !== c.outbound || c.download < p.download) continue;
      bytes.set(c.outbound, (bytes.get(c.outbound) ?? 0) + c.download - p.download);
    }
    const elapsed = at - old.at;
    const total = Math.max(0, sample.download - old.snapshot.download);
    bytes.set('\0total', total);
    for (const node of new Set(['\0total', ...enabled(snapshot).flatMap(g => [g.current, ...g.policy.preferred, ...g.policy.fallback])])) {
      const rows = observations.get(node) ?? [];
      rows.push({ at, elapsed, bytes: bytes.get(node) ?? 0 });
      observations.set(node, rows.filter(r => r.at > at - 90000).slice(-100));
      if (node === '\0total') continue;
      const recent = rows.filter(r => r.at > at - 10000);
      const duration = recent.reduce((sum, r) => sum + r.elapsed, 0);
      if (duration >= 5000) {
        const mbps = recent.reduce((sum, r) => sum + r.bytes, 0) * 8 / duration / 1000;
        for (const g of enabled(snapshot)) if (mbps >= g.policy.bandwidth!.targetMbps) positives.set(`${g.name}\0${node}`, at);
      }
    }
  }
  function quiet(settings: BandwidthSettings) {
    const rows = observations.get('\0total')?.filter(r => r.at > options.now() - settings.quietSeconds * 1000) ?? [];
    const elapsed = rows.reduce((sum, r) => sum + r.elapsed, 0);
    return previous && options.now() - previous.at < 3000 && elapsed >= settings.quietSeconds * 1000 - 1500
      && rows.every(r => r.bytes * 8 / r.elapsed / 1000 < settings.busyStartMbps);
  }
  function suspect(name: string, node: string, settings: BandwidthSettings) {
    if (options.now() - (positives.get(`${name}\0${node}`) ?? -Infinity) < settings.positiveSeconds * 1000) return false;
    const rows = observations.get(node) ?? [];
    const active = rows.filter(r => r.bytes > 0), elapsed = active.reduce((sum, r) => sum + r.elapsed, 0);
    const bytes = active.reduce((sum, r) => sum + r.bytes, 0);
    return elapsed >= settings.activeSeconds * 1000 && bytes >= settings.minTrafficMiB * MiB
      && bytes * 8 / elapsed / 1000 < settings.targetMbps * settings.suspectRatio;
  }
  async function measure(c: Campaign, node: string, signal: AbortSignal) {
    const charge = { at: options.now(), bytes: c.settings.taskMiB * MiB };
    ledger.charges.push(charge); // Durable full charge before network I/O; a crash cannot refund unknown traffic.
    await store();
    let used = 0;
    pressure = { group: c.group, count: 0 };
    try {
      if (signal.aborted) return null;
      return await options.measure!(c.snapshot, node, c.settings, signal, bytes => { if (Number.isFinite(bytes) && bytes >= 0) used = Math.min(charge.bytes, Math.max(used, bytes)); });
    } finally { pressure = undefined; charge.bytes = used; await store(); }
  }
  function recent(name: string) { return ledger.switches.filter(s => s.scope === (snapshot?.scope ?? snapshot?.key) && s.group === name && s.at > options.now() - HOUR); }
  function decision(c: Campaign) {
    const switches = recent(c.group);
    const reverse = switches.some(s => s.from === c.candidate && s.at > options.now() - c.settings.reverseWindowSeconds * 1000);
    return bandwidthDecision(c.current, c.samples, c.settings, options.now(), switches.length, reverse);
  }
  function tick(contexts: Context[]) {
    if (closed || !snapshot) { cancel('suspended'); return; }
    const groups = enabled(snapshot), at = options.now();
    for (const g of groups) Object.assign(view(g.name), budget());
    if (campaign) {
      const context = contexts.find(g => g.name === campaign!.group);
      if (!context?.ready || !previous || at - previous.at > 3000) cancel('latency-priority');
      else if (at - campaign.started > campaign.settings.campaignSeconds * 1000) cancel('evidence-timeout');
      else if (flight) {
        const rows = observations.get('\0total')?.filter(r => r.at > at - 2000) ?? [];
        if (rows.length >= 2 && rows.every(r => r.bytes * 8 / r.elapsed / 1000 > campaign!.settings.busyStopMbps)) cancel('business-busy');
      }
    }
    if (flight || storageFailed) return;
    if (!loaded) {
      if (!groups.length) return;
      launch(async () => { try { ledger = parseBandwidthLedger(await options.load?.() ?? ledger); loaded = true; prune(); }
        catch { storageFailed = true; for (const g of groups) Object.assign(view(g.name), { reason: 'storage-unavailable' }); } });
      return;
    }
    if (!campaign) {
      for (const g of groups) {
        const settings = g.policy.bandwidth!, state = view(g.name), switches = recent(g.name);
        if (!settings.activeProbes || !options.measure) { state.reason = 'passive-only'; continue; }
        const last = switches.at(-1);
        if (switches.length >= settings.maxSwitches || (last && at - last.at < settings.holdSeconds * 1000)) { state.phase = 'holding'; state.reason = 'switch-limit'; continue; }
        if (at < (cooldowns.get(key(g.name)) ?? 0)) continue;
        if (!contexts.find(c => c.name === g.name)?.ready) continue;
        if (!hints.has(g.name) && !suspect(g.name, g.current, settings)) { state.phase = 'observing'; state.reason = 'waiting-traffic'; continue; }
        if (!quiet(settings) || options.busy?.()) { state.phase = 'waiting'; state.reason = 'waiting-idle'; continue; }
        const b = budget(), reserved = settings.taskMiB * MiB * settings.confirmRounds * 2;
        if (b.hourBytes + reserved > b.hourLimit || b.dayBytes + reserved > b.dayLimit || ledger.charges.length > 4000) { state.phase = 'waiting'; state.reason = 'budget-exhausted'; continue; }
        const hint = hints.get(g.name);
        campaign = { snapshot: structuredClone(snapshot), group: g.name, from: g.current, candidate: hint ?? null,
          settings, started: at, due: at, roundAt: at, stage: 'current', current: [], samples: [], hint: !!hint };
        Object.assign(state, { candidate: campaign.candidate, decision: null, round: 0 });
        break;
      }
    }
    const c = campaign;
    if (!c || at < c.due || options.busy?.() || !quiet(c.settings)) return;
    const state = view(c.group), b = budget();
    if (b.hourBytes + c.settings.taskMiB * MiB > b.hourLimit || b.dayBytes + c.settings.taskMiB * MiB > b.dayLimit) { cancel('budget-exhausted'); return; }
    launch(async signal => {
      const node = c.stage === 'current' ? c.from : c.candidate!;
      Object.assign(state, { phase: 'testing', reason: 'collecting', testingNode: node });
      const result = await measure(c, node, signal);
      if (campaign !== c || signal.aborted) return;
      state.testingNode = null;
      if (!result || result.mbps <= 0) { finish('sample-unknown'); return; }
      const sample = { ...result, at: options.now() };
      if (c.stage === 'current') {
        c.current.push(sample); c.roundAt = at;
        if (!c.hint && bandwidthLoss(result.delayMs, result.mbps, c.settings) <= c.settings.minGainMs / 1000 + c.settings.switchCostSeconds / c.settings.horizonSeconds) { finish('current-sufficient'); return; }
        if (!c.candidate) {
          const group = c.snapshot.groups.find(g => g.name === c.group)!;
          const nodes = [...group.policy.preferred, ...group.policy.fallback].filter(n => n !== c.from);
          const cursor = cursors.get(key(c.group)) ?? 0;
          c.candidate = nodes[cursor % Math.max(1, nodes.length)] ?? null;
          cursors.set(key(c.group), cursor + 1);
        }
        if (!c.candidate) { finish('no-candidate'); return; }
        const probe = await options.probe(c.snapshot, c.candidate, signal);
        if (campaign !== c || signal.aborted) return;
        if (!probe.ok || probe.delay === null || probe.delay > c.snapshot.probes.slowMs) { finish('candidate-unavailable'); return; }
        if (bandwidthLoss(result.delayMs, result.mbps, c.settings) - probe.delay / 1000
            <= c.settings.minGainMs / 1000 + c.settings.switchCostSeconds / c.settings.horizonSeconds + c.settings.marginMs * 2 / 1000) {
          finish('no-clear-gain'); return;
        }
        c.stage = 'candidate'; c.due = options.now(); state.candidate = c.candidate;
      } else {
        c.samples.push(sample); state.round = c.samples.length;
        const from = c.current.at(-1)!;
        const oldLoss = bandwidthLoss(from.delayMs, from.mbps, c.settings), newLoss = bandwidthLoss(sample.delayMs, sample.mbps, c.settings);
        const switches = recent(c.group), reverse = switches.some(s => s.from === c.candidate && s.at > options.now() - c.settings.reverseWindowSeconds * 1000);
        const roundThreshold = Math.max(c.settings.minGainMs / 1000, c.settings.minGainRatio * Math.max(0, oldLoss - c.settings.marginMs / 1000))
          + (c.settings.switchCostSeconds + switches.length * c.settings.recentCostSeconds + (reverse ? c.settings.reverseCostSeconds : 0)) / c.settings.horizonSeconds;
        if (sample.at - from.at > c.settings.freshSeconds * 1000 || oldLoss - newLoss - c.settings.marginMs * 2 / 1000 <= roundThreshold) { finish('no-clear-gain'); return; }
        if (c.samples.length < c.settings.confirmRounds) {
          c.stage = 'current'; c.due = Math.max(options.now(), c.roundAt + c.settings.roundIntervalSeconds * 1000);
          Object.assign(state, { phase: 'confirming', testingNode: null, nextAt: c.due }); return;
        }
        state.decision = decision(c);
        if (!state.decision?.worthwhile) { finish('no-clear-gain'); return; }
        if (c.settings.observeOnly) { finish('would-switch'); return; }
        // Recheck the live policy/current node in the selector's existing transactional path.
        if (await options.select(c.snapshot, c.group, c.candidate!)) {
          ledger.switches.push({ at: options.now(), scope: c.snapshot.scope ?? c.snapshot.key, group: c.group, from: c.from, to: c.candidate! });
          await store(); finish('bandwidth-improvement');
        } else finish('selection-conflict');
      }
    });
  }
  return { update, observe, tick,
    requestCheck(name: string) {
      const g = enabled(snapshot).find(g => g.name === name);
      if (!g?.policy.bandwidth?.activeProbes || campaign || flight || closed) return false;
      const node = [...g.policy.preferred, ...g.policy.fallback].find(n => n !== g.current);
      if (!node) return false;
      hints.set(name, node); cooldowns.delete(key(name)); return true;
    },
    isMeasuring(group: string) { return pressure?.group === group; },
    isComparing(group: string) { return campaign?.group === group; },
    request(group: string, node: string) { if (!campaign && !hints.has(group)) hints.set(group, node); },
    noteLatency(group: string, delay: number | null, baseline: number) {
      if (pressure?.group !== group || !flight) return;
      pressure.baseline ??= baseline;
      pressure.count = delay === null || delay - pressure.baseline > Math.max(50, pressure.baseline * 0.5) ? pressure.count + 1 : 0;
      if (pressure.count >= 2) cancel('latency-pressure');
    },
    status(name: string) { return snapshot?.groups.find(g => g.name === name)?.policy.bandwidth?.enabled ? { ...view(name), ...budget() } : undefined; },
    async close() { closed = true; cancel('closed'); await flight?.done; },
  };
}
