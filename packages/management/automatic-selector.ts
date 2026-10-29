import type { AutoGroupPolicy, AutoProbeSettings, ProbeTarget } from './automatic-policy.ts';
import { createBandwidthSelector } from './bandwidth-selector.ts';
import { ManagementError } from './http.ts';
import { createAutomaticDiagnostics, type AutoDiagnostic, type AutoSuspensionReason } from './automatic-diagnostics.ts';

export type AutoSnapshot = {
  key: string; generation: string; probes: AutoProbeSettings; scope?: string;
  groups: { name: string; current: string; policy: AutoGroupPolicy }[];
};
export type ProbeResult = { ok: boolean; delay: number | null; retryAfterMs?: number };
export const AUTO_INTERVALS = {
  monitor: 30_000, confirmation: 2000, slowCooldown: 300_000, minimumResidence: 120_000,
  returnChecks: [300_000, 600_000, 900_000], returnConfirmation: 30_000,
  outage: [15_000, 30_000, 60_000, 120_000], maxConcurrency: 2, startsPerMinute: 24,
} as const;

type Search = {
  kind: 'failure' | 'slow' | 'outage'; queue: string[]; index: number; due: number; baseline: number;
  batch?: { nodes: string[]; results: Map<string, ProbeResult>; target: ProbeTarget; alternate?: boolean };
  confirming?: { node: string; delay: number; due: number; target: ProbeTarget };
};
type Returning = {
  due: number; index: number; nodes: string[]; results: Map<string, ProbeResult>;
  candidate?: { node: string; firstAt: number; checks: number };
};
type Group = {
  name: string; current: string; policy: AutoGroupPolicy; identity: string;
  monitorAt: number; secondaryAt: number | null; failureTarget: ProbeTarget | null; slowCount: number; slowDelay: number;
  slowCooldown: number; residenceUntil: number; reason: string | null; health: 'unknown' | 'healthy' | 'unavailable';
  search?: Search; returning?: Returning; returnAt: number | null; returnRound: number;
  returnCursor: number; outageRound: number; outageCursor: number;
  returnedAt: number | null; flapCount: number; returnNotBefore: number;
  bandwidthSwitchedAt?: number;
};
type Job = { group: Group; node: string; target: ProbeTarget; priority: number; auxiliary?: boolean; run: (result: ProbeResult, at: number) => Promise<void> | void };
type Event = { at: number; group: string; from: string; to: string; reason: string };
type Options = {
  snapshot: () => Promise<AutoSnapshot | null>;
  probe: (snapshot: AutoSnapshot, node: string, target: ProbeTarget) => Promise<ProbeResult>;
  switch: (snapshot: AutoSnapshot, group: string, node: string, reason: string) => Promise<boolean>;
  now?: () => number;
  suspensionReason?: () => AutoSuspensionReason;
  diagnostic?: (event: AutoDiagnostic) => void;
  bandwidth?: Pick<Parameters<typeof createBandwidthSelector>[0], 'measure' | 'busy' | 'load' | 'save' | 'trace'>;
};

/** All state advances through serialized ticks; deadlines never hold a worker or a timer open. */
export function createAutomaticSelector(options: Options) {
  const now = options.now ?? Date.now;
  const diagnostics = createAutomaticDiagnostics(now, options.diagnostic);
  let pendingProbes = 0;
  let suspension: AutoSuspensionReason = 'initializing';
  let groups = new Map<string, Group>();
  let snapshot: AutoSnapshot | null = null;
  let closed = false, timer: ReturnType<typeof setInterval> | undefined;
  let running: Promise<void> | null = null;
  let starts: number[] = [], blockedUntil = 0, fairCursor = 0;
  let targetIdentity: string | null = null, usePrimary = true, primaryRecoveryAt: number | null = null;
  const events: Event[] = [];
  let selecting = 0;
  let evidenceEpoch = 0, evidenceInvalid = false, lastGeneration: string | undefined;
  const selectedSinceSnapshot = new Set<Group>();
  const invalidConflict = (error: unknown) => error instanceof ManagementError && error.code === 'ACTIVE_CONFLICT';
  const invalidateEvidence = () => { evidenceInvalid = true; evidenceEpoch++; };
  function suspendEvidence() {
    invalidateEvidence(); snapshot = null; pendingProbes = 0;
    for (const g of groups.values()) g.health = 'unknown';
    bandwidth.update(null);
  }
  async function readSnapshot() {
    try {
      const value = await options.snapshot(); diagnostics.success('snapshot');
      if (value) diagnostics.snapshot();
      return { value, failed: false };
    } catch {
      diagnostics.fail('snapshot'); suspendEvidence();
      return { value: null, failed: true };
    }
  }
  const bandwidthProbes: { snapshot: AutoSnapshot; node: string; signal: AbortSignal; done: (result: ProbeResult) => void }[] = [];
  const safetyAt = new Map<string, number>();
  const bandwidth = createBandwidthSelector({ now, ...options.bandwidth,
    probe: (s, node, signal) => new Promise(resolve => {
      const entry = { snapshot: s, node, signal, done: (result: ProbeResult) => {
        const index = bandwidthProbes.indexOf(entry); if (index >= 0) bandwidthProbes.splice(index, 1);
        signal.removeEventListener('abort', abort); resolve(result);
      } };
      const abort = () => entry.done({ ok: false, delay: null });
      bandwidthProbes.push(entry); signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
    }),
    select: async (s, name, node) => {
      const g = groups.get(name);
      return !!g && !g.search && g.secondaryAt === null && await select(s, g, node, 'bandwidth-improvement', now());
    },
  });
  const identity = (s: AutoSnapshot, g: AutoSnapshot['groups'][number]) => JSON.stringify([s.key, s.probes, g.policy]);
  const healthy = (r: ProbeResult) => r.ok && r.delay !== null && Number.isFinite(r.delay) && r.delay >= 0;
  const retryAt = (r: ProbeResult, at: number) => typeof r.retryAfterMs === 'number' && Number.isFinite(r.retryAfterMs) && r.retryAfterMs > 0
    ? at + Math.max(1000, r.retryAfterMs) : null;
  const isBackup = (g: Group) => !g.policy.preferred.includes(g.current);
  const returnLimit = (s: AutoSnapshot) => s.probes.slowMs * 2 / 3;
  const activeTarget = (s: AutoSnapshot) => usePrimary ? s.probes.primary : s.probes.secondary;
  const sameTarget = (a: ProbeTarget, b: ProbeTarget) => a.url === b.url && a.expectedStatus === b.expectedStatus;
  const isPrimary = (s: AutoSnapshot, target: ProbeTarget) => sameTarget(target, s.probes.primary);

  function activateTarget(s: AutoSnapshot, target: ProbeTarget, at: number) {
    if (usePrimary !== isPrimary(s, target)) bandwidth.invalidateProbeTarget();
    usePrimary = isPrimary(s, target);
    primaryRecoveryAt = usePrimary ? null : at + 900_000;
  }

  function reconcile(s: AutoSnapshot | null, at: number) {
    const expired = evidenceInvalid || lastGeneration !== s?.generation;
    if (lastGeneration !== s?.generation) evidenceEpoch++;
    const targets = s ? JSON.stringify([s.key, s.probes]) : null;
    if (targets !== targetIdentity) { targetIdentity = targets; usePrimary = true; primaryRecoveryAt = null; }
    const next = new Map<string, Group>();
    for (const item of s?.groups ?? []) {
      const old = groups.get(item.name), id = identity(s!, item);
      if (old && old.identity === id && old.current === item.current) {
        if (expired && !selectedSinceSnapshot.has(old)) {
          old.monitorAt = at; old.secondaryAt = null; old.failureTarget = null;
          old.slowCount = 0; old.slowDelay = 0; old.returning = undefined; old.health = 'unknown';
          // An outage round keeps its three-node queue and backoff, but no old measurement.
          if (old.search?.kind === 'outage') { old.search.index = 0; old.search.batch = undefined; old.search.confirming = undefined; }
          else old.search = undefined;
        }
        next.set(item.name, old);
      }
      else next.set(item.name, {
        name: item.name, current: item.current, policy: item.policy, identity: id,
        monitorAt: at, secondaryAt: null, failureTarget: null, slowCount: 0, slowDelay: 0, slowCooldown: 0,
        residenceUntil: at, reason: null, health: 'unknown', returnAt: item.policy.returnToPreferred && !item.policy.preferred.includes(item.current) ? at + 300_000 : null,
        returnRound: 0, returnCursor: 0, outageRound: 0, outageCursor: 0,
        returnedAt: null, flapCount: 0, returnNotBefore: 0,
      });
    }
    lastGeneration = s?.generation; evidenceInvalid = false; selectedSinceSnapshot.clear();
    groups = next; snapshot = s ? structuredClone(s) : null; bandwidth.update(snapshot);
  }

  function scheduleReturn(g: Group, at: number) {
    g.returning = undefined;
    g.returnAt = g.policy.returnToPreferred && isBackup(g)
      ? Math.max(at + AUTO_INTERVALS.returnChecks[Math.min(g.returnRound, 2)], g.returnNotBefore, g.residenceUntil) : null;
  }

  async function select(s: AutoSnapshot, g: Group, node: string, reason: string, at: number): Promise<boolean> {
    if (closed || evidenceInvalid || groups.get(g.name) !== g) return false;
    const epoch = evidenceEpoch;
    if (g.policy.bandwidth?.enabled && ['faster-candidate', 'preferred-restored'].includes(reason)) {
      bandwidth.request(g.name, node, reason === 'faster-candidate' ? 'latency' : 'return'); return false;
    }
    if (reason === 'bandwidth-improvement' && selecting > 0) return false;
    selecting++;
    try {
    // A probe can outlive a configuration edit, selection edit, disconnect, or shutdown.
    const { value: live, failed } = await readSnapshot();
    if (failed) return false;
    const item = live?.groups.find(item => item.name === g.name);
    if (live?.generation !== s.generation) invalidateEvidence();
    if (closed || evidenceInvalid || epoch !== evidenceEpoch || !live || !item || identity(live, item) !== g.identity || item.current !== g.current || groups.get(g.name) !== g) return false;
    const from = g.current;
    let applied = node === from;
    if (!applied) {
      try { applied = await options.switch(s, g.name, node, reason); diagnostics.success('switch'); }
      catch (error) {
        if (invalidConflict(error)) invalidateEvidence(); else diagnostics.fail('switch');
        applied = false;
      }
      if (!applied && !evidenceInvalid && !closed) {
        const { value: after } = await readSnapshot();
        if (!after || after.generation !== s.generation) invalidateEvidence();
      }
    }
    if (!applied || closed) return false;
    at = now();
    if (node !== from) {
      events.push({ at, group: g.name, from, to: node, reason });
      if (events.length > 50) events.splice(0, events.length - 50);
      if (g.policy.bandwidth?.enabled) bandwidth.selected(g.name, from, node, reason, s);
    }
    g.current = node; g.search = undefined; g.returning = undefined; g.secondaryAt = null; g.failureTarget = null;
    g.slowCount = 0; g.monitorAt = at + 30_000; g.residenceUntil = at + 120_000;
    g.outageRound = 0; g.reason = reason; g.health = 'healthy'; g.returnRound = 0;
    if (reason === 'preferred-restored') g.returnedAt = at;
    if (reason === 'bandwidth-improvement') { g.bandwidthSwitchedAt = at; g.monitorAt = at + 5000; }
    scheduleReturn(g, at);
    if (node !== from) { selectedSinceSnapshot.add(g); invalidateEvidence(); }
    return true;
    } finally { selecting--; }
  }

  function beginSearch(g: Group, kind: Search['kind'], at: number) {
    g.returning = undefined; g.secondaryAt = null;
    if ((kind === 'failure' || kind === 'slow') && g.returnedAt !== null && at - g.returnedAt < 600_000) {
      g.flapCount++; g.returnNotBefore = at + (g.flapCount === 1 ? 900_000 : 1_800_000); g.returnedAt = null;
    }
    let all = [...g.policy.preferred, ...g.policy.fallback].filter(node => node !== g.current);
    if (kind === 'failure' && g.policy.bandwidth?.enabled) {
      bandwidth.failure(g.name, g.current);
      all = bandwidth.recoveryOrder(g.name, all);
    }
    g.search = { kind, queue: all, index: 0, due: at, baseline: g.slowDelay };
    g.reason = kind === 'slow' ? 'current-slow' : 'current-unavailable';
    if (kind === 'failure') g.health = 'unavailable';
  }

  function outage(g: Group, at: number) {
    const all = [...new Set([g.current, ...g.policy.preferred, ...g.policy.fallback])];
    const count = Math.min(3, all.length), queue: string[] = [];
    for (let i = 0; i < count; i++) queue.push(all[(g.outageCursor + i) % all.length]);
    g.outageCursor = (g.outageCursor + count) % all.length;
    const delay = AUTO_INTERVALS.outage[Math.min(g.outageRound++, 3)];
    g.search = { kind: 'outage', queue, index: 0, due: at + delay, baseline: 0 };
    g.returning = undefined; g.reason = 'all-unavailable'; g.health = 'unavailable';
  }

  function finishSearch(g: Group, at: number) {
    if (g.search?.kind === 'slow') {
      g.search = undefined; g.slowCooldown = at + 300_000; g.slowCount = 0; g.reason = 'no-better-candidate';
    } else outage(g, at);
  }

  function monitorJobs(s: AutoSnapshot, g: Group, at: number): Job[] {
    if (g.search?.kind === 'failure' || g.search?.kind === 'outage') return [];
    const secondary = g.secondaryAt !== null;
    if (at < (g.secondaryAt ?? g.monitorAt)) return [];
    const target = secondary ? g.failureTarget! : activeTarget(s);
    return [{ group: g, node: g.current, target,
      priority: secondary ? 0 : 1, run: (result, end) => {
        const retry = retryAt(result, end);
        if (retry !== null) { if (secondary) g.secondaryAt = retry; else g.monitorAt = retry; return; }
        if (!healthy(result)) {
          g.slowCount = 0;
          if (secondary) beginSearch(g, 'failure', end);
          else { g.secondaryAt = end + 2000; g.failureTarget = isPrimary(s, target) ? s.probes.secondary : s.probes.primary; }
          return;
        }
        g.secondaryAt = null; g.health = 'healthy';
        g.monitorAt = end + (g.policy.bandwidth?.enabled && g.bandwidthSwitchedAt !== undefined && end - g.bandwidthSwitchedAt < 30000 ? 5000 : 30000);
        if (secondary) {
          g.slowCount = 0; g.failureTarget = null;
          activateTarget(s, target, end);
          return;
        }
        g.slowCount = result.delay! > s.probes.slowMs ? g.slowCount + 1 : 0;
        g.slowDelay = result.delay!;
        if (g.slowCount >= 3 && end >= g.slowCooldown && end >= g.residenceUntil && !g.search) {
          if (g.policy.bandwidth?.enabled) {
            bandwidth.request(g.name, undefined, 'latency'); g.slowCooldown = end + AUTO_INTERVALS.slowCooldown;
          } else beginSearch(g, 'slow', end);
        }
      } }];
  }

  function searchJobs(s: AutoSnapshot, g: Group, at: number): Job[] {
    const search = g.search;
    if (!search || at < search.due) return [];
    const priority = search.kind === 'slow' ? 1 : 0;
    const better = (delay: number) => search.kind !== 'slow' || (delay <= search.baseline * 0.6 && search.baseline - delay >= 300);
    const exhaustedBatch = (end: number) => {
      const batch = search.batch!;
      // A dead current node cannot establish which endpoint is usable. Give each
      // recovery batch one alternate-target pass through the same shared budget.
      if (search.kind !== 'slow' && !batch.alternate && !sameTarget(s.probes.primary, s.probes.secondary)) {
        batch.alternate = true;
        batch.target = isPrimary(s, batch.target) ? s.probes.secondary : s.probes.primary;
        batch.results.clear();
      } else {
        search.batch = undefined;
        if (search.index >= search.queue.length) finishSearch(g, end);
      }
      search.due = end;
    };
    if (search.confirming) {
      const candidate = search.confirming;
      if (at < candidate.due) return [];
      return [{ group: g, node: candidate.node, target: candidate.target, priority, run: async (result, end) => {
        if (g.search !== search) return;
        const retry = retryAt(result, end);
        if (retry !== null) { candidate.due = retry; return; }
        if (healthy(result) && better(Math.max(candidate.delay, result.delay!))) {
          const selected = await select(s, g, candidate.node, search.kind === 'slow' ? 'faster-candidate' : 'failure-recovery', end);
          if (selected && search.kind !== 'slow') activateTarget(s, candidate.target, now());
          if (!selected && evidenceInvalid) return;
          // If the transactional adapter refuses, retry on a later round instead of spinning.
          if (g.search === search) finishSearch(g, end);
        } else {
          search.batch?.results.set(candidate.node, { ok: false, delay: null });
          const next = search.batch?.nodes.find(node => healthy(search.batch!.results.get(node)!) && better(search.batch!.results.get(node)!.delay!));
          search.confirming = next ? { node: next, delay: search.batch!.results.get(next)!.delay!, due: end + 2000, target: search.batch!.target } : undefined;
          search.due = end;
          if (!next) exhaustedBatch(end);
        }
      } }];
    }
    if (!search.batch) {
      if (search.index >= search.queue.length) { finishSearch(g, at); return []; }
      // Keep preferred and fallback in distinct batches, preserving preferred precedence.
      const first = search.queue[search.index];
      const tier = g.policy.preferred.includes(first);
      const nodes: string[] = [];
      while (search.index < search.queue.length && nodes.length < 2
        && (search.kind === 'outage' || g.policy.preferred.includes(search.queue[search.index]) === tier)) nodes.push(search.queue[search.index++]);
      search.batch = { nodes, results: new Map(), target: activeTarget(s) };
    }
    const batch = search.batch;
    return batch.nodes.filter(node => !batch.results.has(node)).map(node => ({ group: g, node, target: batch.target, priority,
      run: (result: ProbeResult, end: number) => {
        if (g.search !== search) return;
        const retry = retryAt(result, end);
        if (retry !== null) { search.due = retry; return; }
        batch.results.set(node, result);
        if (batch.results.size !== batch.nodes.length) return;
        const match = batch.nodes.find(node => healthy(batch.results.get(node)!) && better(batch.results.get(node)!.delay!));
        if (match) search.confirming = { node: match, delay: batch.results.get(match)!.delay!, due: end + 2000, target: batch.target };
        search.due = end;
        if (!match) exhaustedBatch(end);
      } }));
  }

  function returnFailed(g: Group, at: number) { g.returnRound++; g.reason = 'preferred-check-failed'; scheduleReturn(g, at); }

  function returnJobs(s: AutoSnapshot, g: Group, at: number): Job[] {
    if (g.policy.bandwidth?.enabled && bandwidth.isComparing(g.name)) return [];
    if (!g.policy.returnToPreferred || !isBackup(g) || g.search || g.secondaryAt !== null) return [];
    if (g.policy.bandwidth?.enabled) {
      if (g.returnAt !== null && at >= Math.max(g.returnAt, g.residenceUntil)) {
        bandwidth.request(g.name, undefined, 'return'); g.returnRound++; scheduleReturn(g, at);
      }
      return [];
    }
    if (!g.returning && g.returnAt !== null && at >= Math.max(g.returnAt, g.residenceUntil)) {
      const nodes: string[] = [], count = Math.min(2, g.policy.preferred.length);
      for (let i = 0; i < count; i++) nodes.push(g.policy.preferred[(g.returnCursor + i) % g.policy.preferred.length]);
      g.returnCursor = g.policy.preferred.length ? (g.returnCursor + count) % g.policy.preferred.length : 0;
      g.returning = { due: at, index: 0, nodes, results: new Map() };
      if (!nodes.length) { returnFailed(g, at); return []; }
    }
    const returning = g.returning;
    if (!returning || at < returning.due) return [];
    const candidate = returning.candidate;
    if (candidate) {
      return [{ group: g, node: candidate.node, target: activeTarget(s), priority: 2, run: async (result, end) => {
        if (g.returning !== returning || g.search || g.secondaryAt !== null) return;
        const retry = retryAt(result, end);
        if (retry !== null) { returning.due = retry; return; }
        if (!healthy(result) || result.delay! > returnLimit(s)) { returnFailed(g, end); return; }
        candidate.checks++;
        if (candidate.checks === 2) {
          if (!await select(s, g, candidate.node, 'preferred-restored', end) && !evidenceInvalid) returnFailed(g, end);
        } else returning.due = Math.max(candidate.firstAt + 60_000, end + 30_000);
      } }];
    }
    return returning.nodes.filter(node => !returning.results.has(node)).map(node => ({ group: g, node, target: activeTarget(s), priority: 2,
      run: (result: ProbeResult, end: number) => {
        if (g.returning !== returning || g.search || g.secondaryAt !== null) return;
        const retry = retryAt(result, end);
        if (retry !== null) { returning.due = retry; return; }
        returning.results.set(node, result);
        if (returning.results.size !== returning.nodes.length) return;
        const match = returning.nodes.find(node => healthy(returning.results.get(node)!) && returning.results.get(node)!.delay! <= returnLimit(s));
        if (!match) returnFailed(g, end);
        else { returning.candidate = { node: match, firstAt: end, checks: 0 }; returning.due = end + 30_000; }
      } }));
  }

  async function runTick() {
    if (closed) return;
    const { value: fresh, failed } = await readSnapshot();
    if (closed || failed) return;
    suspension = fresh ? 'inactive' : options.suspensionReason?.() ?? 'inactive';
    pendingProbes = 0;
    // A confirmed enhanced selection may briefly suspend runtime snapshots while its transaction applies.
    // Keep its post-switch/failure state, but discard measurement evidence during the suspension.
    if (!fresh && selecting && [...groups.values()].some(g => g.policy.bandwidth?.enabled)) { bandwidth.update(null); return; }
    reconcile(fresh, now());
    const s = snapshot;
    if (!s || now() < blockedUntil) return;
    const epoch = evidenceEpoch;
    // Rebuild priorities every tick; one batch must not drain an old queue while new faults wait.
    const at = now(), jobs: Job[] = [];
    for (const g of groups.values()) jobs.push(...monitorJobs(s, g, at), ...searchJobs(s, g, at), ...returnJobs(s, g, at));
    for (const g of groups.values()) if (bandwidth.isMeasuring(g.name) && at >= (safetyAt.get(g.name) ?? 0)) {
      jobs.push({ group: g, node: g.current, target: activeTarget(s), priority: 3, auxiliary: true, run: (result, end) => {
        safetyAt.set(g.name, end + 2000);
        bandwidth.noteLatency(g.name, healthy(result) ? result.delay : null, g.slowDelay || result.delay || 0);
      } });
    }
    for (const entry of [...bandwidthProbes]) {
      const g = [...groups.values()].find(g => g.policy.bandwidth?.enabled && [g.current, ...g.policy.preferred, ...g.policy.fallback].includes(entry.node));
      if (!g || entry.signal.aborted || entry.snapshot.key !== s.key || entry.snapshot.generation !== s.generation) entry.done({ ok: false, delay: null });
      else jobs.push({ group: g, node: entry.node, target: activeTarget(s), priority: 4, auxiliary: true, run: result => entry.done(result) });
    }
    // Target recovery shares the same scheduler/budget and uses only one already-current node.
    if (!usePrimary && primaryRecoveryAt !== null && at >= primaryRecoveryAt) {
      const eligible = [...groups.values()].filter(g => !g.search && g.secondaryAt === null);
      const g = eligible[fairCursor % Math.max(1, eligible.length)];
      if (g) jobs.push({ group: g, node: g.current, target: s.probes.primary, priority: 3, run: (result, end) => {
        const retry = retryAt(result, end);
        if (retry !== null) { primaryRecoveryAt = retry; return; }
        if (healthy(result)) { bandwidth.invalidateProbeTarget(); usePrimary = true; primaryRecoveryAt = null; }
        else primaryRecoveryAt = end + 900_000;
      } });
    }
    const names = [...groups.keys()];
    const fairness = (g: Group) => (names.indexOf(g.name) - fairCursor + names.length) % names.length;
    jobs.sort((a, b) => a.priority - b.priority || fairness(a.group) - fairness(b.group));
    const shared = new Map<string, Job[]>();
    for (const job of jobs) {
      const key = JSON.stringify([job.node, job.target, s.probes]);
      const entries = shared.get(key) ?? [];
      // Each logical group observes a shared measurement only once.
      const duplicate = entries.find(existing => existing.group === job.group);
      if (!duplicate) entries.push(job);
      else {
        const previous = duplicate.run;
        duplicate.auxiliary = duplicate.auxiliary && job.auxiliary;
        duplicate.run = async (result, at) => { await previous(result, at); if (epoch === evidenceEpoch) await job.run(result, at); };
      }
      shared.set(key, entries);
    }
    const queue = [...shared.values()];
    pendingProbes = queue.length;
    if (!closed && epoch === evidenceEpoch) {
      starts = starts.filter(start => start > now() - 60_000);
      const allowance = Math.max(0, Math.min(AUTO_INTERVALS.maxConcurrency, AUTO_INTERVALS.startsPerMinute - starts.length));
      const batch = now() < blockedUntil ? [] : queue
        .filter(entries => !entries.every(job => job.auxiliary) || starts.length < 18).slice(0, allowance);
      let probeFailed = false, observed = false;
      await Promise.all(batch.map(async entries => {
        if (epoch !== evidenceEpoch) return;
        const first = entries[0];
        // Supplemental work may not consume the final six starts reserved for the original scheduler.
        if (entries.every(job => job.auxiliary) && starts.length >= 18) return;
        starts.push(now());
        pendingProbes--;
        fairCursor = (names.indexOf(first.group.name) + 1) % Math.max(1, names.length);
        let result: ProbeResult;
        try { result = await options.probe(s, first.node, first.target); observed = true; } catch (error) {
          if (invalidConflict(error)) { invalidateEvidence(); return; }
          probeFailed = true;
          result = { ok: false, delay: null };
        }
        const end = now();
        if (closed || epoch !== evidenceEpoch) return;
        const retry = retryAt(result, end);
        if (retry !== null) blockedUntil = Math.max(blockedUntil, retry);
        for (const job of entries) if (groups.get(job.group.name) === job.group) {
          if (epoch !== evidenceEpoch) break;
          await job.run(result, end);
          if ((!evidenceInvalid || selectedSinceSnapshot.has(job.group) && job.node === job.group.current)
            && job.group.policy.bandwidth?.enabled && sameTarget(job.target, activeTarget(s))) bandwidth.observeProbe(job.group.name, job.node, result);
        }
      }));
      if (probeFailed) diagnostics.fail('probe'); else if (observed) diagnostics.success('probe');
    }
    if (epoch !== evidenceEpoch) return;
    bandwidth.tick([...groups.values()].map(g => ({ name: g.name, degraded: g.slowCount >= 3,
      ready: g.health === 'healthy' && !g.search && !g.returning && g.secondaryAt === null
      && !selecting && starts.filter(start => start > now() - 60000).length < 18 })));
  }

  function tick(): Promise<void> {
    if (closed) return Promise.resolve();
    if (running) return running;
    diagnostics.start();
    running = runTick().then(() => diagnostics.success('tick'), error => {
      diagnostics.fail('tick'); suspendEvidence(); throw error;
    }).finally(() => { diagnostics.complete(); running = null; });
    return running;
  }
  return {
    tick,
    observeUsage: bandwidth.observe,
    requestBandwidthCheck: bandwidth.requestCheck,
    start() {
      if (closed || timer) return;
      // tick records failures before the background driver contains the rejection.
      timer = setInterval(() => { void tick().catch(() => {}); }, 1000);
      timer.unref?.();
      void tick().catch(() => {});
    },
    async close() { closed = true; if (timer) clearInterval(timer); const closing = bandwidth.close(); await running; await closing; },
    status() {
      return {
        engine: (() => {
          const recent = starts.filter(start => start > now() - 60_000);
          const quotaAt = recent.length >= AUTO_INTERVALS.startsPerMinute ? Math.min(...recent) + 60_000 : 0;
          const nextStartAt = Math.max(blockedUntil, quotaAt);
          return diagnostics.status(!closed && !!snapshot && !evidenceInvalid && !selecting, closed ? 'stopped' : !snapshot ? suspension
            : selecting ? 'switching' : evidenceInvalid ? 'pending'
            : now() < blockedUntil ? 'retry-after' : quotaAt > now() ? 'quota' : pendingProbes ? 'queued' : null,
          pendingProbes, !closed && snapshot && nextStartAt > now() ? nextStartAt : null);
        })(),
        scope: snapshot?.scope,
        groups: [...groups.values()].map(g => ({ name: g.name, current: g.current,
          health: g.health, phase: g.search?.kind === 'outage' ? 'outage' : g.search ? g.search.kind === 'slow' ? 'slow-search' : 'failure-search'
            : g.secondaryAt !== null ? 'failure-confirmation' : g.returning ? 'return-confirmation' : isBackup(g) ? 'backup' : 'monitoring',
          bandwidth: bandwidth.status(g.name),
          nextAt: g.search ? g.search.confirming?.due ?? g.search.due
            : Math.min(g.secondaryAt ?? g.monitorAt, g.returning?.due ?? g.returnAt ?? Infinity), reason: g.reason })),
        events: events.map(event => ({ ...event })),
      };
    },
  };
}
