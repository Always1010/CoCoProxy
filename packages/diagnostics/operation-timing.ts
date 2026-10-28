import { AsyncLocalStorage } from 'node:async_hooks';

type Phase = 'lock' | 'held' | 'validate' | 'activate' | 'confirm' | 'restore' | 'commit' | 'readback' | 'network' | 'observe';
export type OperationTiming = {
  operation: 'select' | 'reconcile';
  outcome: 'ok' | 'failed';
  totalMs: number;
  phases: Partial<Record<Phase, number>>;
};
export type TimingObserver = (timing: OperationTiming) => void;
const current = new AsyncLocalStorage<Partial<Record<Phase, number>>>();
const milliseconds = (value: number) => Math.round(Math.max(0, value) * 10) / 10;

/** Fixed phase names and durations only: never accept paths, nodes, IDs or errors. */
export function recordOperationTiming(phase: Phase, duration: number): void {
  const phases = current.getStore();
  if (phases) phases[phase] = (phases[phase] ?? 0) + duration;
}

export async function measurePhase<T>(phase: Phase, operation: () => Promise<T>): Promise<T> {
  if (!current.getStore()) return operation();
  const started = performance.now();
  try { return await operation(); }
  finally { recordOperationTiming(phase, performance.now() - started); }
}

export async function withOperationTiming<T>(operation: OperationTiming['operation'], observer: TimingObserver | undefined,
  work: () => Promise<T>): Promise<T> {
  if (!observer) return work();
  return current.run({}, async () => {
    const started = performance.now();
    let outcome: OperationTiming['outcome'] = 'failed';
    try { const result = await work(); outcome = 'ok'; return result; }
    finally {
      const phases = Object.fromEntries(Object.entries(current.getStore()!).map(([phase, value]) => [phase, milliseconds(value)]));
      try { observer({ operation, outcome, totalMs: milliseconds(performance.now() - started), phases }); }
      catch { /* Diagnostics cannot change a committed outcome or mask an error. */ }
    }
  });
}
