import { join } from 'node:path';
import { privateRead, atomicWrite } from '../storage/private-files.ts';
import { WorkspaceError } from './workspace.ts';

export type AutomaticEvent = { id?: string; at: number; group: string; from: string; to: string; reason: string };
export type AutomaticBindings = {
  version: 1;
  scope: string;
  targets: Record<string, { signature: string; target: string }>;
  events: AutomaticEvent[];
  pendingEvent?: AutomaticEvent & { id: string; signature: string; revision: number };
};

/** Runtime choices are private and separate from the user's manual settings. */
export async function readAutomaticBindings(root: string): Promise<AutomaticBindings | null> {
  try {
    const value = JSON.parse(await privateRead(join(root, 'automatic-selections.json'), 262144));
    const name = (input: unknown) => typeof input === 'string' && input.length > 0 && input.length <= 1024 && !/[\x00-\x1f\x7f]/.test(input);
    if (!value || value.version !== 1 || typeof value.scope !== 'string' || value.scope.length > 16384 ||
        !value.targets || typeof value.targets !== 'object' || Array.isArray(value.targets) || Object.keys(value.targets).length > 100 ||
        Object.entries(value.targets).some(([key, target]) => !name(key) || ['__proto__', 'constructor', 'prototype'].includes(key) ||
          !target || typeof target !== 'object' || !/^[a-f0-9]{64}$/.test(String((target as { signature?: unknown }).signature)) || !name((target as { target?: unknown }).target)) ||
        !Array.isArray(value.events) || value.events.length > 50 || value.events.some((event: AutomaticEvent) => !event ||
          !Number.isFinite(event.at) || event.at < 0 || !name(event.group) || !name(event.from) || !name(event.to) || !name(event.reason))) {
      throw new Error();
    }
    if (value.events.some((e: AutomaticEvent) => e.id !== undefined && (typeof e.id !== 'string' || !/^[a-f0-9-]{36}$/.test(e.id)))) throw new Error();
    if (value.pendingEvent !== undefined) {
      const e = value.pendingEvent;
      if (!e || !/^[a-f0-9-]{36}$/.test(e.id) || !Number.isSafeInteger(e.at) || e.at < 0 || !name(e.group) || !name(e.from) || !name(e.to) || !name(e.reason) ||
          !/^[a-f0-9]{64}$/.test(e.signature) || !Number.isSafeInteger(e.revision) || e.revision < 0) throw new Error();
    }
    return value as AutomaticBindings;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new WorkspaceError('AUTO_STATE_CORRUPT');
  }
}

/** Caller holds the common transaction lock. No controller secrets are stored. */
export async function writeAutomaticBindings(root: string, value: AutomaticBindings): Promise<void> {
  await atomicWrite(root, 'automatic-selections.json', JSON.stringify(value));
}
