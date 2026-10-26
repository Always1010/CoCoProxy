import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { lstat, unlink } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { atomicWrite, inspectPrivateDirectory, privateRead, syncDirectory } from '../storage/private-files.ts';
import { cloneConfigJson } from '../config/index.ts';
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

export type MaintenanceRestore = { schemaVersion: 1; previous: { present: boolean; enabled: boolean; paused: boolean }; pausedSha256: string };

async function exclusiveRuntimeIntent<T>(stateDirectory: string, operation: () => Promise<T>): Promise<T> {
  const outcome = await new FileTransactionStore(stateDirectory).exclusive(async () => {
    try { return { value: await operation() }; }
    catch (error) { if (error instanceof RuntimeError) return { error }; throw error; }
  });
  if (outcome.error) throw outcome.error;
  return outcome.value as T;
}

/** Bind the receipt to this exact marker write, including replacements with identical JSON. */
async function lifecycleIdentity(stateDirectory: string): Promise<string> {
  const path = join(stateDirectory, 'lifecycle.json');
  const before = await lstat(path, { bigint: true });
  const bytes = await privateRead(path, 4096);
  const after = await lstat(path, { bigint: true });
  const identity = (stat: typeof before) => [stat.dev, stat.ino, stat.ctimeNs, stat.mtimeNs, stat.size, stat.uid, stat.mode].join(':');
  if (identity(before) !== identity(after)) throw new RuntimeError('RUNTIME_MAINTENANCE_CONFLICT');
  return createHash('sha256').update(identity(after)).update('\0').update(bytes).digest('hex');
}

/** A maintenance pause captures absent/disabled states as well as enabled intent, under the common lock. */
export async function pauseRuntimeForMaintenance(stateDirectory: string): Promise<{ lifecycle: RuntimeLifecycle; maintenanceRestore: MaintenanceRestore }> {
  const deadline = performance.now() + 60_000;
  for (;;) {
    try {
      return await exclusiveRuntimeIntent(stateDirectory, async () => {
        const previous = await readRuntimeLifecycle(stateDirectory);
        let present = true;
        try { await lstat(join(stateDirectory, 'lifecycle.json')); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') present = false; else throw error; }
        const lifecycle: RuntimeLifecycle = { schemaVersion: 1, enabled: previous.enabled, paused: true };
        await atomicWrite(stateDirectory, 'lifecycle.json', JSON.stringify(lifecycle));
        return { lifecycle, maintenanceRestore: { schemaVersion: 1, previous: { present, enabled: previous.enabled, paused: previous.paused },
          pausedSha256: await lifecycleIdentity(stateDirectory) } };
      });
    } catch (error) {
      if (!(error instanceof TransactionError) || error.code !== 'STORE_LOCKED' || performance.now() >= deadline) throw error;
      await delay(200);
    }
  }
}

/** Explicit maintenance completion only; a newer pause/disable invalidates the captured marker identity. */
export async function restoreRuntimeAfterMaintenance(stateDirectory: string, input: unknown): Promise<RuntimeLifecycle> {
  let value: MaintenanceRestore;
  try {
    const parsed = cloneConfigJson(input) as any;
    if (!parsed || Array.isArray(parsed) || Object.keys(parsed).sort().join(',') !== 'pausedSha256,previous,schemaVersion' ||
        parsed.schemaVersion !== 1 || !/^[a-f0-9]{64}$/.test(parsed.pausedSha256) || !parsed.previous || Array.isArray(parsed.previous) ||
        Object.keys(parsed.previous).sort().join(',') !== 'enabled,paused,present' ||
        ['present', 'enabled', 'paused'].some(key => typeof parsed.previous[key] !== 'boolean') ||
        !parsed.previous.present && (parsed.previous.enabled || parsed.previous.paused)) throw new Error();
    value = parsed;
  } catch { throw new RuntimeError('RUNTIME_MAINTENANCE_RESTORE_INVALID'); }
  return exclusiveRuntimeIntent(stateDirectory, async () => {
    const current = await readRuntimeLifecycle(stateDirectory);
    if (!current.paused || current.enabled !== value.previous.enabled ||
        await lifecycleIdentity(stateDirectory) !== value.pausedSha256) throw new RuntimeError('RUNTIME_MAINTENANCE_CONFLICT');
    const previous: RuntimeLifecycle = { schemaVersion: 1, enabled: value.previous.enabled, paused: value.previous.paused };
    if (value.previous.present) await atomicWrite(stateDirectory, 'lifecycle.json', JSON.stringify(previous));
    else { await unlink(join(stateDirectory, 'lifecycle.json')); await syncDirectory(stateDirectory); }
    return previous;
  });
}
