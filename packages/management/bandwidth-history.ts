import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { atomicWrite, privateRead } from '../storage/private-files.ts';
import { parseBandwidthSettings, type BandwidthSettings, type BandwidthSample, type bandwidthDecision } from './bandwidth-policy.ts';

export const BANDWIDTH_HISTORY_FILE = 'automatic-bandwidth-history.json';
export const BANDWIDTH_HISTORY_LIMIT = 8 * 1024 * 1024;
export const BANDWIDTH_HISTORY_AGE = 7 * 86400000;
export type BandwidthComparison = NonNullable<ReturnType<typeof bandwidthDecision>> & {
  currentNode: string; candidateNode: string; currentSamples: BandwidthSample[]; candidateSamples: BandwidthSample[];
  effectiveCurrent: BandwidthSample[]; effectiveCandidate: BandwidthSample[];
  recentSwitches: number; reverse: boolean; currentPreferred: boolean; candidatePreferred: boolean;
};
export type BandwidthTraceEvent = {
  at: number; until: number; kind: 'trigger' | 'state' | 'probe' | 'sample' | 'comparison' | 'excluded' | 'end'; reason: string;
  node?: string; nextAt?: number | null;
  probe?: { ok: boolean; delayMs: number | null; retryAfterMs?: number };
  observation?: { fresh: boolean; activeSeconds: number; trafficMiB: number; mbps: number | null;
    requiredActiveSeconds: number; requiredTrafficMiB: number; suspectMbps: number; positiveUntil: number };
  sample?: { startedAt: number; elapsedMs: number; delayMs: number | null; mbps: number | null; bytes: number; valid: boolean; sampleMs?: number; warmupMs?: number };
  comparison?: BandwidthComparison;
  screening?: { currentLow: number; bestCandidateLoss: number; uncertainty: number; threshold: number; delayLimit: number; delayMs: number };
  protection?: { recentSwitches: number; maxSwitches: number; holdUntil: number; limitUntil: number; severe: boolean };
  budget?: { hourBytes: number; dayBytes: number; hourLimit: number; dayLimit: number; hourReserve: number; dayReserve: number;
    urgent: boolean; searchBytes: number; searchLimit: number };
};
export type BandwidthRound = {
  id: string; scope: string; group: string; generation: string; startedAt: number; updatedAt: number; endedAt: number | null;
  current: string; trigger: 'traffic' | 'manual' | 'latency' | 'return'; reason: string; settings: BandwidthSettings;
  nodes: { name: string; preferred: boolean }[]; events: BandwidthTraceEvent[]; truncated: boolean;
};
export type BandwidthArchive = { version: 1; since: number; evicted: boolean; rounds: BandwidthRound[] };
export type BandwidthHistoryResult = { since: number | null; evicted: boolean; error: boolean; rounds: BandwidthRound[] };

/** Reject corrupt/unbounded records with a fixed error, never returning raw file contents. */
export function parseBandwidthHistory(input: unknown): BandwidthArchive {
  const value = input as BandwidthArchive;
  const number = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;
  const name = (s: unknown): s is string => typeof s === 'string' && s.length > 0 && s.length <= 16384 && !/[\x00-\x1f\x7f]/.test(s);
  const numbers = (values: unknown[]) => values.every(number);
  const sample = (s: BandwidthSample) => s && number(s.at) && number(s.delayMs) && number(s.mbps) && s.mbps > 0 && (s.startedAt === undefined || number(s.startedAt));
  const numericTree = (v: unknown, depth = 0): boolean => {
    if (depth > 8) return false;
    if (typeof v === 'number') return Number.isFinite(v);
    if (v === null || typeof v === 'boolean' || typeof v === 'string') return typeof v !== 'string' || name(v);
    if (Array.isArray(v)) return v.length <= 200 && v.every(x => numericTree(x, depth + 1));
    return !!v && typeof v === 'object' && Object.values(v).every(x => numericTree(x, depth + 1));
  };
  try {
    if (!value || value.version !== 1 || !number(value.since) || typeof value.evicted !== 'boolean' || !Array.isArray(value.rounds) || value.rounds.length > 10000) throw new Error();
    const ids = new Set<string>();
    for (const r of value.rounds) {
      if (!r || !/^[a-f0-9-]{36}$/.test(r.id) || !name(r.scope) || !name(r.group) || !name(r.generation) || !name(r.current)
          || !number(r.startedAt) || !number(r.updatedAt) || (r.endedAt !== null && !number(r.endedAt)) || !name(r.reason)
          || !['traffic', 'manual', 'latency', 'return'].includes(r.trigger) || typeof r.truncated !== 'boolean'
          || !Array.isArray(r.nodes) || r.nodes.length > 32 || r.nodes.some(n => !n || !name(n.name) || typeof n.preferred !== 'boolean')
          || !Array.isArray(r.events) || r.events.length > 200 || Buffer.byteLength(JSON.stringify(r)) > 524288) throw new Error();
      const settings = parseBandwidthSettings(r.settings);
      if (Object.keys(settings).some(key => !Object.hasOwn(r.settings, key))) throw new Error();
      if (ids.has(r.id)) throw new Error();
      ids.add(r.id);
      for (const e of r.events) {
        if (!e || !number(e.at) || !number(e.until) || !name(e.reason) || !['trigger', 'state', 'probe', 'sample', 'comparison', 'excluded', 'end'].includes(e.kind)
            || (e.node !== undefined && !name(e.node)) || (e.nextAt !== undefined && e.nextAt !== null && !number(e.nextAt)) || !numericTree(e)) throw new Error();
        if ((e.kind === 'sample' && !e.sample) || (e.kind === 'probe' && !e.probe) || (e.kind === 'comparison' && !e.comparison)) throw new Error();
        if (e.probe && (typeof e.probe.ok !== 'boolean' || (e.probe.delayMs !== null && !number(e.probe.delayMs))
            || (e.probe.retryAfterMs !== undefined && !number(e.probe.retryAfterMs)))) throw new Error();
        if (e.sample && (!number(e.sample.startedAt) || !number(e.sample.elapsedMs) || !number(e.sample.bytes) || typeof e.sample.valid !== 'boolean'
            || (e.sample.delayMs !== null && !number(e.sample.delayMs)) || (e.sample.mbps !== null && !number(e.sample.mbps))
            || (e.sample.valid && (e.sample.mbps === null || e.sample.mbps <= 0))
            || [e.sample.sampleMs, e.sample.warmupMs].some(n => n !== undefined && !number(n)))) throw new Error();
        const o = e.observation, b = e.budget, p = e.protection, s = e.screening;
        if (o && (typeof o.fresh !== 'boolean' || !numbers([o.activeSeconds, o.trafficMiB, o.requiredActiveSeconds, o.requiredTrafficMiB, o.suspectMbps, o.positiveUntil])
            || (o.mbps !== null && !number(o.mbps)))) throw new Error();
        if (b && (typeof b.urgent !== 'boolean' || !numbers([b.hourBytes, b.dayBytes, b.hourLimit, b.dayLimit, b.hourReserve, b.dayReserve, b.searchBytes, b.searchLimit]))) throw new Error();
        if (p && (typeof p.severe !== 'boolean' || !numbers([p.recentSwitches, p.maxSwitches, p.holdUntil, p.limitUntil]))) throw new Error();
        if (s && !numbers([s.currentLow, s.bestCandidateLoss, s.uncertainty, s.threshold, s.delayLimit, s.delayMs])) throw new Error();
        const d = e.comparison;
        if (d && (!name(d.currentNode) || !name(d.candidateNode) || !d.current || !d.candidate || typeof d.worthwhile !== 'boolean' || typeof d.guard !== 'boolean'
            || !number(d.recentSwitches) || [d.reverse, d.currentPreferred, d.candidatePreferred].some(v => typeof v !== 'boolean')
            || [d.gain, d.cost, d.threshold, d.uncertainty, d.rank, d.current.low, d.current.high, d.current.delay, d.current.mbps,
              d.candidate.low, d.candidate.high, d.candidate.delay, d.candidate.mbps].some(n => typeof n !== 'number' || !Number.isFinite(n))
            || [d.currentSamples, d.candidateSamples, d.effectiveCurrent, d.effectiveCandidate].some(a => !Array.isArray(a) || a.length < 2 || a.length > 5 || !a.every(sample)))) throw new Error();
      }
    }
    return value;
  } catch { throw new Error('BANDWIDTH_HISTORY_INVALID'); }
}

export function retainBandwidthHistory(archive: BandwidthArchive, now: number): BandwidthArchive {
  const counts = new Map<string, number>();
  const rounds = [...archive.rounds].sort((a, b) => b.startedAt - a.startedAt).filter(r => {
    const key = JSON.stringify([r.scope, r.group]), count = counts.get(key) ?? 0;
    counts.set(key, count + 1);
    return count < 100 && r.updatedAt > now - BANDWIDTH_HISTORY_AGE;
  }).slice(0, 10000);
  let bytes = Buffer.byteLength(JSON.stringify({ ...archive, rounds }));
  while (bytes > BANDWIDTH_HISTORY_LIMIT && rounds.length) bytes -= Buffer.byteLength(JSON.stringify(rounds.pop())) + 1;
  return { ...archive, evicted: archive.evicted || rounds.length < archive.rounds.length, rounds };
}

/** A trace is observational: snapshots before evidence is pruned; observers cannot affect selection. */
export function createBandwidthTrace(now: () => number, emit?: (round: BandwidthRound) => void) {
  const rounds = new Map<string, BandwidthRound>();
  const published = new Map<string, number>();
  const publish = (r: BandwidthRound) => { published.set(r.group, now()); try { emit?.(structuredClone(r)); } catch { /* Observer isolation. */ } };
  return {
    begin(scope: string, group: string, generation: string, current: string, trigger: BandwidthRound['trigger'], settings: BandwidthSettings, nodes: BandwidthRound['nodes'], observation?: BandwidthTraceEvent['observation']) {
      if (rounds.has(group)) return;
      const at = now(), round: BandwidthRound = { id: randomUUID(), scope, group, generation, current, trigger, settings: structuredClone(settings), nodes,
        startedAt: at, updatedAt: at, endedAt: null, reason: 'requested', events: [{ at, until: at, kind: 'trigger', reason: trigger,
          ...(observation ? { observation: structuredClone(observation) } : {}) }], truncated: false };
      rounds.set(group, round); publish(round);
    },
    event(group: string, event: Omit<BandwidthTraceEvent, 'at' | 'until'>) {
      const r = rounds.get(group);
      if (!r) return;
      if (event.comparison) {
        const previous = r.events.findLast(e => e.comparison?.candidateNode === event.node)?.comparison;
        const key = (d: BandwidthComparison) => JSON.stringify([d.effectiveCurrent, d.effectiveCandidate, d.recentSwitches, d.reverse,
          d.currentPreferred, d.candidatePreferred, d.uncertainty, d.worthwhile, d.guard]);
        if (previous && key(previous) === key(event.comparison)) return;
      }
      const at = now(), last = r.events.at(-1);
      r.updatedAt = at;
      if (event.kind === 'state') r.reason = event.reason;
      if (last?.kind === 'state' && event.kind === 'state' && last.reason === event.reason && last.node === event.node) {
        // Keep the first/last occurrence, with no per-tick I/O during unchanged waits.
        last.until = at; last.nextAt = event.nextAt;
        if (at - (published.get(group) ?? at) < 15000) return;
      } else {
        r.events.push({ ...structuredClone(event), at, until: at });
        if (r.events.length > 200 || Buffer.byteLength(JSON.stringify(r)) > 500000) {
          r.events.splice(1, Math.max(1, Math.floor(r.events.length / 4))); r.truncated = true;
        }
      }
      publish(r);
    },
    end(group: string, reason: string) {
      const r = rounds.get(group);
      if (!r) return;
      const at = now(); r.updatedAt = at; r.endedAt = at; r.reason = reason;
      r.events.push({ at, until: at, kind: 'end', reason });
      if (r.events.length > 200) { r.events.splice(1, 1); r.truncated = true; }
      publish(r); rounds.delete(group); published.delete(group);
    },
  };
}

/** Single writer, coalesced bounded queue. Uses the existing shared lock only when flushing. */
export class BandwidthHistoryStore {
  private archive?: BandwidthArchive;
  private loading?: Promise<void>;
  private pending = new Map<string, BandwidthRound>();
  private timer?: ReturnType<typeof setTimeout>;
  private writing: Promise<void> = Promise.resolve();
  private failed = false;
  private dirty = false;
  private closed = false;
  private readonly root: string;
  private readonly exclusive: <T>(run: () => Promise<T>) => Promise<T>;
  private readonly now: () => number;
  private readonly startedAt: number;
  constructor(root: string, exclusive: <T>(run: () => Promise<T>) => Promise<T>, now = Date.now) {
    this.root = root; this.exclusive = exclusive; this.now = now; this.startedAt = now();
  }

  private async load() {
    if (!this.loading) this.loading = (async () => {
      try {
        this.archive = parseBandwidthHistory(JSON.parse(await privateRead(join(this.root, BANDWIDTH_HISTORY_FILE), BANDWIDTH_HISTORY_LIMIT)));
        // No live evidence survives a manager restart. Do not label unfinished work as a result.
        for (const r of this.archive.rounds) if (r.endedAt === null) {
          this.dirty = true;
          r.endedAt = r.updatedAt; r.reason = 'service-restarted';
          if (r.events.length >= 200) { r.events.splice(1, 1); r.truncated = true; }
          r.events.push({ at: r.updatedAt, until: r.updatedAt, kind: 'end', reason: 'service-restarted' });
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { this.failed = true; throw new Error('BANDWIDTH_HISTORY_UNAVAILABLE'); }
        this.archive = { version: 1, since: this.startedAt, evicted: false, rounds: [] };
      }
    })();
    await this.loading;
  }

  record(round: BandwidthRound) {
    if (this.closed) return;
    this.pending.set(round.id, round);
    if (this.pending.size > 1000) { this.pending.delete(this.pending.keys().next().value!); this.failed = true; }
    this.schedule();
  }

  private schedule() {
    if (!this.closed && !this.timer) {
      this.timer = setTimeout(() => { this.timer = undefined; void this.flush(); }, 1000);
      this.timer.unref?.();
    }
  }

  async read(scope: string, group: string) {
    try {
      await this.load();
      const merged = new Map(this.archive!.rounds.map(r => [r.id, r]));
      for (const r of this.pending.values()) merged.set(r.id, r);
      const retained = retainBandwidthHistory({ ...this.archive!, rounds: [...merged.values()] }, this.now());
      if (retained.rounds.length !== merged.size) { this.archive = retained; this.dirty = true; }
      if (this.dirty) this.schedule();
      return { since: retained.since, evicted: retained.evicted, error: this.failed, rounds: structuredClone(retained.rounds.filter(r => r.scope === scope && r.group === group)) };
    } catch {
      const live = retainBandwidthHistory({ version: 1, since: this.startedAt, evicted: false, rounds: [...this.pending.values()] }, this.now());
      return { since: live.since, evicted: live.evicted, error: true, rounds: structuredClone(live.rounds.filter(r => r.scope === scope && r.group === group)) };
    }
  }

  async flush() {
    this.writing = this.writing.then(async () => {
      try {
        await this.load();
        if (!this.pending.size && !this.failed && !this.dirty) return;
        const batch = [...this.pending.values()]; this.pending.clear();
        const merged = new Map(this.archive!.rounds.map(r => [r.id, r]));
        for (const r of batch) merged.set(r.id, r);
        this.archive = retainBandwidthHistory({ ...this.archive!, rounds: [...merged.values()] }, this.now());
        const contents = JSON.stringify(this.archive); this.dirty = false;
        await this.exclusive(() => atomicWrite(this.root, BANDWIDTH_HISTORY_FILE, contents));
        this.failed = false;
      } catch { this.failed = true; this.dirty = true; }
    });
    await this.writing;
  }

  async close() { this.closed = true; if (this.timer) clearTimeout(this.timer); await this.flush(); }
}
