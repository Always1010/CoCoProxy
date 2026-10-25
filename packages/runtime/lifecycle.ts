import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { atomicWrite, inspectPrivateDirectory, privateRead } from '../storage/private-files.ts';
import { FileTransactionStore, TransactionError } from '../transaction/index.ts';
import { RuntimeError } from './types.ts';

export type RuntimeLifecycle = { schemaVersion: 1; enabled: boolean; paused: boolean };

/** Missing means the operator has never enabled persistent reconciliation. */
export async function readRuntimeLifecycle(stateDirectory: string): Promise<RuntimeLifecycle> {
  try {
    await inspectPrivateDirectory(stateDirectory);
    const value = JSON.parse(await privateRead(join(stateDirectory, 'lifecycle.json'), 4096));
    if (!value || Object.keys(value).sort().join(',') !== 'enabled,paused,schemaVersion' ||
        value.schemaVersion !== 1 || typeof value.enabled !== 'boolean' || typeof value.paused !== 'boolean') throw new Error();
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return { schemaVersion: 1, enabled: false, paused: false };
    throw new RuntimeError('RUNTIME_LIFECYCLE_INVALID');
  }
}

/** A completed pause has drained any reconciler/apply sharing the transaction lock. */
export async function setRuntimeLifecycle(stateDirectory: string, input: Pick<RuntimeLifecycle, 'enabled' | 'paused'>,
  options: { timeoutMs?: number; retryMs?: number } = {}): Promise<RuntimeLifecycle> {
  if (!input || typeof input.enabled !== 'boolean' || typeof input.paused !== 'boolean' ||
      Object.keys(input).some(key => key !== 'enabled' && key !== 'paused')) throw new RuntimeError('RUNTIME_LIFECYCLE_INVALID');
  const value: RuntimeLifecycle = { schemaVersion: 1, enabled: input.enabled, paused: input.paused };
  const timeoutMs = options.timeoutMs ?? 60_000, retryMs = options.retryMs ?? 200;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 60_000 ||
      !Number.isSafeInteger(retryMs) || retryMs < 1 || retryMs > 1000) throw new RuntimeError('RUNTIME_LIFECYCLE_INVALID');
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    try {
      await new FileTransactionStore(stateDirectory).exclusive(async () => {
        await readRuntimeLifecycle(stateDirectory); // A corrupt marker requires explicit repair.
        await atomicWrite(stateDirectory, 'lifecycle.json', JSON.stringify(value));
      });
      return value;
    } catch (error) {
      if (!(error instanceof TransactionError) || error.code !== 'STORE_LOCKED' || performance.now() >= deadline) throw error;
      await delay(Math.min(retryMs, Math.max(1, deadline - performance.now())));
    }
  }
}
