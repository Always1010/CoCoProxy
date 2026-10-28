import { FileTransactionStore, TransactionError, TransactionManager } from '../transaction/index.ts';
import type { PublicStatus, RuntimeAdapter } from '../transaction/index.ts';
import { readRuntimeLifecycle } from '../runtime/lifecycle.ts';

export type StartupRecovery = { attempted: boolean; recovered: boolean; reason: string | null; status: PublicStatus };

/** One awaited recovery pass, never a watchdog or an implicit new apply. */
export async function recoverManagementStartup(stateDirectory: string, runtime: RuntimeAdapter): Promise<StartupRecovery> {
  const store = new FileTransactionStore(stateDirectory);
  const exclusive = store.exclusive.bind(store);
  store.exclusive = operation => exclusive(async token => {
    if ((await readRuntimeLifecycle(stateDirectory)).paused) throw new TransactionError('RUNTIME_LIFECYCLE_PAUSED');
    return operation(token);
  });
  const before = await store.status();
  // A fresh/settled store remains read-only, including on first service start.
  if (before.transaction === null && before.fault === null) return { attempted: false, recovered: true, reason: null, status: before };
  try {
    const status = await new TransactionManager(store, runtime).recover();
    return { attempted: true, recovered: true, reason: null, status };
  } catch (error) {
    // Keep management reachable to inspect and explicitly retry the preserved
    // transaction. Contention does not authorize a parallel recovery attempt.
    const status = await store.status();
    return { attempted: true, recovered: false,
      reason: error instanceof TransactionError ? error.code : 'STARTUP_RECOVERY_UNAVAILABLE', status };
  }
}

type PersistentRuntime = RuntimeAdapter & {
  needsReconcile?(generation: string): Promise<boolean>;
  reconcile(path: string, generation: string): Promise<boolean>;
};

/** No drafts or desired targets are consulted: only the transaction's committed active. */
export async function reconcileManagementRuntime(stateDirectory: string, runtime: PersistentRuntime): Promise<void> {
  const lifecycle = await readRuntimeLifecycle(stateDirectory);
  if (!lifecycle.enabled || lifecycle.paused) return;
  const recovered = await recoverManagementStartup(stateDirectory, runtime);
  if (!recovered.recovered) throw new TransactionError(recovered.reason ?? 'STARTUP_RECOVERY_UNAVAILABLE');
  const store = new FileTransactionStore(stateDirectory);
  const observed = await store.status();
  if (observed.transaction || observed.fault || observed.active === null) return;
  // Healthy observations do not exclude a user's apply. This is only a hint:
  // every repair still reloads lifecycle and committed state under the lock.
  if (runtime.needsReconcile && !await runtime.needsReconcile(observed.active)) return;
  await store.exclusive(async () => {
    const current = await readRuntimeLifecycle(stateDirectory);
    if (!current.enabled || current.paused) return;
    const state = await store.readState();
    if (state.pending || state.fault || state.active === null || state.active !== observed.active) return;
    const path = await store.readCandidate(state.active);
    await runtime.reconcile(path, state.active);
  });
}

/** One serialized manager timer; systemd remains the only process supervisor. */
export function createManagementLifecycle(stateDirectory: string, runtime: PersistentRuntime,
  onError: () => void = () => {}, intervalMs = 5000) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | undefined;
  let stopped = false;
  const tick = () => {
    if (stopped || running) return;
    running = reconcileManagementRuntime(stateDirectory, runtime).catch(onError).finally(() => {
      running = undefined;
      if (!stopped) { timer = setTimeout(tick, intervalMs); timer.unref(); }
    });
  };
  return {
    async start() {
      try { return await recoverManagementStartup(stateDirectory, runtime); }
      finally { tick(); }
    },
    async close() { stopped = true; clearTimeout(timer); await running; },
  };
}
