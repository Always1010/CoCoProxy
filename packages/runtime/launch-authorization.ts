import type { FileTransactionStore } from '../transaction/index.ts';
import { RuntimeError } from './types.ts';

type LaunchStore = Pick<FileTransactionStore, 'readState' | 'hasLiveLockOwner'>;
type State = Awaited<ReturnType<LaunchStore['readState']>>;

function allowedGeneration(state: State): string | null {
  const pending = state.pending;
  if (pending === null || pending.phase === 'committed') return state.fault === null ? state.active : null;
  if (pending.phase === 'restoring') return pending.previous;
  return ['activating', 'confirming', 'recovering-target'].includes(pending.phase) ? pending.target : null;
}

/** Selection is an intent, not permission to restart an abandoned transaction. */
export async function assertRuntimeLaunch(store: LaunchStore, generation: string): Promise<void> {
  const denied = () => { throw new RuntimeError('RUNTIME_RECOVERY_REQUIRED'); };
  const state = await store.readState();
  const pending = state.pending;
  if (allowedGeneration(state) !== generation) denied();
  if (pending === null || pending.phase === 'committed') return;
  if (!await store.hasLiveLockOwner(pending.ownerToken)) denied();
  // The lock holder may have changed phase or completed while its identity was read.
  // Advancing activating -> confirming does not revoke the same target's permission.
  const after = await store.readState();
  if (allowedGeneration(after) !== generation) denied();
  if (after.pending !== null && after.pending.phase !== 'committed' &&
      (after.pending.id !== pending.id || after.pending.ownerToken !== pending.ownerToken)) denied();
}
