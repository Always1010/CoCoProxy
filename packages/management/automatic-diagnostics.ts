export type AutoSuspensionReason = 'initializing' | 'inactive' | 'paused' | 'direct' | 'disabled' | 'runtime-unavailable'
  | 'transaction' | 'fault' | 'pending' | 'switching' | 'stopped';
export type AutoPhase = 'snapshot' | 'probe' | 'switch' | 'tick';
const codes = {
  snapshot: 'AUTO_SNAPSHOT_UNAVAILABLE', probe: 'AUTO_PROBE_UNAVAILABLE',
  switch: 'AUTO_SWITCH_UNAVAILABLE', tick: 'AUTO_INTERNAL_ERROR',
} as const;
type Fault = { phase: AutoPhase; code: typeof codes[AutoPhase]; since: number; at: number; count: number };
export type AutoDiagnostic = Fault & { event: 'failure' | 'recovered' };
export type AutoEngineStatus = {
  state: 'running' | 'suspended' | 'error';
  reason: AutoSuspensionReason | 'quota' | 'retry-after' | 'queued' | null;
  lastStartedAt: number | null; lastCompletedAt: number | null; lastSnapshotAt: number | null;
  error: Fault | null; pendingProbes: number; nextStartAt: number | null;
};

/** Fixed codes only. Raw exceptions, configuration and node identities never enter diagnostics. */
export function createAutomaticDiagnostics(now: () => number, observer?: (event: AutoDiagnostic) => void) {
  const faults = new Map<AutoPhase, Fault & { loggedAt: number }>();
  let lastStartedAt: number | null = null, lastCompletedAt: number | null = null, lastSnapshotAt: number | null = null;
  function emit(event: AutoDiagnostic['event'], fault: Fault) {
    try { observer?.({ event, phase: fault.phase, code: fault.code, since: fault.since, at: fault.at, count: fault.count }); }
    catch { /* Diagnostics must never affect a probe or a committed switch. */ }
  }
  return {
    start() { lastStartedAt = now(); },
    complete() { lastCompletedAt = now(); },
    snapshot() { lastSnapshotAt = now(); },
    fail(phase: AutoPhase) {
      const at = now(), old = faults.get(phase);
      const fault = old ?? { phase, code: codes[phase], since: at, at, count: 0, loggedAt: at };
      fault.at = at; fault.count++; faults.set(phase, fault);
      if (!old || at - fault.loggedAt >= 60_000) { emit('failure', fault); fault.loggedAt = at; }
    },
    success(phase: AutoPhase) {
      const fault = faults.get(phase);
      if (fault) { emit('recovered', { ...fault, at: now() }); faults.delete(phase); }
    },
    status(active: boolean, reason: AutoEngineStatus['reason'], pendingProbes: number, nextStartAt: number | null): AutoEngineStatus {
      const fault = [...faults.values()].sort((a, b) => b.at - a.at)[0];
      return { state: fault ? 'error' : active ? 'running' : 'suspended', reason,
        lastStartedAt, lastCompletedAt, lastSnapshotAt, pendingProbes, nextStartAt,
        error: fault ? { phase: fault.phase, code: fault.code, since: fault.since, at: fault.at, count: fault.count } : null };
    },
  };
}
