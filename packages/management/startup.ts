import { FileTransactionStore, TransactionError, TransactionManager } from '../transaction/index.ts';
import type { PublicStatus, RuntimeAdapter } from '../transaction/index.ts';

export type StartupRecovery = { attempted: boolean; recovered: boolean; reason: string | null; status: PublicStatus };

/** One awaited recovery pass, never a watchdog or an implicit new apply. */
export async function recoverManagementStartup(stateDirectory: string, runtime: RuntimeAdapter): Promise<StartupRecovery> {
  const store = new FileTransactionStore(stateDirectory);
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
