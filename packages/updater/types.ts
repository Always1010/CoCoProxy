import type { UpdateSettings } from './policy.ts';

export class UpdateError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status = 400) { super(code); this.name = 'UpdateError'; this.code = code; this.status = status; }
}

export interface UpdateJob {
  id: string;
  phase: string;
  version: string | null;
  error: string | null;
}

/** Browser-safe summary. No paths, credentials or native error messages. */
export interface UpdateView {
  available: boolean;
  configured: boolean;
  unavailableReason: string | null;
  settings: UpdateSettings;
  revision: number;
  currentVersion: string | null;
  latestVersion: string | null;
  nextCheckAt: number | null;
  lastCheckedAt: number | null;
  lastResult: string | null;
  job: UpdateJob | null;
}

export type UpdateCommand = { action: 'status' } | { action: 'configure'; expectedRevision: number; settings: UpdateSettings }
  | { action: 'check' } | { action: 'install'; expectedVersion: string };
