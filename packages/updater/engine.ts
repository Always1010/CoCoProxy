import { randomUUID } from 'node:crypto';
import { DEFAULT_UPDATE_SETTINGS, parseUpdateSettings, nextUpdateWindow, addDays, scheduleChanged } from './policy.ts';
import type { UpdateSettings } from './policy.ts';
import { UpdateError } from './types.ts';
import type { UpdateCommand, UpdateJob, UpdateView } from './types.ts';
import type { VerifiedUpdate } from './release.ts';

export interface UpdateState {
  schemaVersion: 1; settings: UpdateSettings; revision: number; dueDate: string | null; scheduledAt: number | null;
  lastCheckedAt: number | null; lastResult: string | null; latestVersion: string | null;
  blockedVersion: string | null; attempts: number; job: UpdateJob | null; needsReview: boolean;
}
export interface InstalledUpdate { version: string; manifestSha256: string }
export interface UpdaterHost {
  now(): number;
  save(state: UpdateState): Promise<void>;
  installed(): Promise<InstalledUpdate>;
  configured(): Promise<boolean>;
  find(currentVersion: string, signal: AbortSignal): Promise<VerifiedUpdate | null>;
  download(update: VerifiedUpdate, id: string, signal: AbortSignal): Promise<string>;
  prepare(payload: string, update: VerifiedUpdate, original: InstalledUpdate, signal: AbortSignal): Promise<void>;
  apply(payload: string, update: VerifiedUpdate, original: InstalledUpdate): Promise<'updated' | 'recovered' | 'manual-review-required'>;
  cleanup(id: string): Promise<void>;
  jitter?(): number;
}
export function initialUpdateState(): UpdateState {
  return { schemaVersion: 1, settings: { ...DEFAULT_UPDATE_SETTINGS }, revision: 0, dueDate: null, scheduledAt: null,
    lastCheckedAt: null, lastResult: null, latestVersion: null, blockedVersion: null, attempts: 0, job: null, needsReview: false };
}
const time = (value: unknown) => value === null || typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const version = (value: unknown) => value === null || typeof value === 'string' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value) && value.length <= 100;
const phases = ['checking', 'downloading', 'preparing', 'installing', 'completed', 'failed', 'interrupted', 'cancelled'];
const results = ['up-to-date', 'update-available', 'manual-update-required', 'updated', 'cancelled', 'failed', 'recovered', 'manual-review-required'];

/** A corrupt journal is never silently replaced with a fresh enabled schedule. */
export function parseUpdateState(input: unknown): UpdateState {
  const fail = (): never => { throw new UpdateError('UPDATER_STATE_INVALID', 503); };
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail();
  const state = input as UpdateState;
  if (Object.keys(state).sort().join(',') !== Object.keys(initialUpdateState()).sort().join(',') || state.schemaVersion !== 1
    || !Number.isSafeInteger(state.revision) || state.revision < 0 || !time(state.scheduledAt) || !time(state.lastCheckedAt)
    || !version(state.latestVersion) || !version(state.blockedVersion) || !Number.isInteger(state.attempts) || state.attempts < 0 || state.attempts > 3
    || typeof state.needsReview !== 'boolean' || state.lastResult !== null && !results.includes(state.lastResult)) fail();
  state.settings = parseUpdateSettings(state.settings);
  if (state.dueDate !== null) addDays(state.dueDate, 0);
  if (state.job !== null && (!state.job || typeof state.job !== 'object' || Object.keys(state.job).sort().join(',') !== 'error,id,phase,version'
    || !/^[a-f0-9-]{36}$/.test(state.job.id) || !phases.includes(state.job.phase) || !version(state.job.version)
    || state.job.error !== null && !/^UPDATER_[A-Z_]+$/.test(state.job.error))) fail();
  return state;
}

function errorCode(error: unknown): string {
  const value = error instanceof Error ? (error as Error & { code?: string }).code ?? error.message : '';
  if (/^(?:UPDATE|UPDATER)_[A-Z_]+$/.test(value)) return value.replace(/^UPDATE_/, 'UPDATER_');
  return 'UPDATER_OPERATION_FAILED';
}

export class UpdateEngine {
  private readonly host: UpdaterHost;
  private state: UpdateState;
  private writing = Promise.resolve();
  private active: { controller: AbortController; automatic: boolean; installing: boolean } | null = null;
  private task: Promise<void> = Promise.resolve();
  private closed = false;
  constructor(host: UpdaterHost, input: UpdateState = initialUpdateState()) {
    this.host = host;
    this.state = parseUpdateState(structuredClone(input));
    if (this.state.job && !['completed', 'failed', 'cancelled', 'interrupted'].includes(this.state.job.phase)) {
      // Installation owns external effects; power-loss recovery requires existing deployment evidence and operator review.
      this.state.needsReview = this.state.job.phase === 'installing';
      this.state.job.phase = 'interrupted';
      this.state.job.error = 'UPDATER_INTERRUPTED';
      this.state.lastResult = this.state.needsReview ? 'manual-review-required' : 'cancelled';
      this.state.scheduledAt = null;
    }
  }
  get busy(): boolean { return this.active !== null; }
  get installing(): boolean { return this.active?.installing === true; }
  cancelAutomaticPreparation(): void {
    if (this.active?.automatic && !this.active.installing) this.active.controller.abort();
  }
  async initialize(): Promise<void> {
    if (this.state.job?.phase === 'interrupted' && !this.state.needsReview) await this.host.cleanup(this.state.job.id);
    this.plan(); await this.persist();
  }
  private persist(): Promise<void> {
    const snapshot = structuredClone(this.state);
    const saving = this.writing.then(() => this.host.save(snapshot));
    this.writing = saving.catch(() => {});
    return saving;
  }
  private plan(): void {
    if (!this.state.settings.enabled) { this.state.scheduledAt = null; return; }
    const now = this.host.now();
    const window = nextUpdateWindow(now, this.state.dueDate, this.state.settings);
    if (this.state.scheduledAt === null || this.state.scheduledAt < window.start || this.state.scheduledAt >= window.end) {
      const jitter = Math.max(0, Math.min(0.999, this.host.jitter?.() ?? Math.random()));
      this.state.scheduledAt = Math.max(now, window.start + Math.floor(jitter * Math.min(300_000, (window.end - window.start) / 4)));
    }
  }
  async view(): Promise<UpdateView> {
    const [installed, configured] = await Promise.all([this.host.installed().catch(() => null), this.host.configured().catch(() => false)]);
    let nextCheckAt = this.state.scheduledAt;
    if (nextCheckAt !== null) {
      const window = nextUpdateWindow(this.host.now(), this.state.dueDate, this.state.settings);
      if (nextCheckAt < window.start || nextCheckAt >= window.end) nextCheckAt = window.start;
    }
    return { available: installed !== null, configured, unavailableReason: this.state.needsReview ? 'UPDATER_REVIEW_REQUIRED'
      : !installed ? 'UPDATER_INSTALLATION_INVALID' : !configured ? 'UPDATER_PLATFORM_UNSUPPORTED' : null,
      settings: { ...this.state.settings }, revision: this.state.revision, currentVersion: installed?.version ?? null,
      latestVersion: this.state.latestVersion, nextCheckAt: this.state.needsReview ? null : nextCheckAt,
      lastCheckedAt: this.state.lastCheckedAt, lastResult: this.state.lastResult, job: this.state.job ? { ...this.state.job } : null };
  }
  async handle(command: UpdateCommand): Promise<UpdateView> {
    if (this.closed) throw new UpdateError('UPDATER_UNAVAILABLE', 503);
    if (command.action === 'status') return this.view();
    if (command.action === 'configure') {
      const settings = parseUpdateSettings(command.settings);
      if (!Number.isSafeInteger(command.expectedRevision) || command.expectedRevision !== this.state.revision) throw new UpdateError('UPDATER_CONFLICT', 409);
      const changed = scheduleChanged(this.state.settings, settings);
      this.state.settings = settings; this.state.revision++;
      if (changed) { this.state.dueDate = null; this.state.scheduledAt = null; this.state.attempts = 0; this.plan(); }
      if (this.active?.automatic && !this.active.installing && changed) this.active.controller.abort();
      await this.persist(); return this.view();
    }
    if (!await this.host.configured()) throw new UpdateError('UPDATER_PLATFORM_UNSUPPORTED', 503);
    if (this.state.needsReview) throw new UpdateError('UPDATER_REVIEW_REQUIRED', 409);
    if (command.action === 'install' && (!version(command.expectedVersion) || !command.expectedVersion)) throw new UpdateError('UPDATER_VERSION_INVALID');
    await this.launch(false, command.action === 'install' ? command.expectedVersion : null);
    return this.view();
  }
  async tick(): Promise<void> {
    if (this.closed || this.active || !this.state.settings.enabled || this.state.needsReview) return;
    if (!await this.host.configured()) return;
    if (this.closed || this.active || !this.state.settings.enabled) return;
    const previous = this.state.scheduledAt; this.plan();
    if (previous !== this.state.scheduledAt) await this.persist();
    if (this.state.scheduledAt! > this.host.now()) return;
    await this.launch(true, null);
  }
  private async launch(automatic: boolean, expectedVersion: string | null): Promise<void> {
    if (this.closed) throw new UpdateError('UPDATER_UNAVAILABLE', 503);
    if (this.active) throw new UpdateError('UPDATER_BUSY', 409);
    const task = { controller: new AbortController(), automatic, installing: false };
    this.active = task;
    const id = randomUUID(), revision = this.state.revision;
    this.state.job = { id, phase: 'checking', version: null, error: null };
    const persisted = this.persist();
    this.task = persisted.then(() => this.run(id, revision, expectedVersion, task)).finally(() => { this.active = null; });
    // The persisted job is observed through the API; native errors never become unhandled rejections.
    this.task.catch(() => {});
    await persisted;
  }
  private async run(id: string, revision: number, expectedVersion: string | null,
    task: { controller: AbortController; automatic: boolean; installing: boolean }): Promise<void> {
    const signal = task.controller.signal;
    let checkSucceeded = false;
    let retryAt: number | null = null;
    const window = nextUpdateWindow(this.host.now(), this.state.dueDate, this.state.settings);
    const phase = async (next: string) => { this.state.job!.phase = next; await this.persist(); };
    try {
      signal.throwIfAborted();
      const original = await this.host.installed();
      signal.throwIfAborted();
      const update = await this.host.find(original.version, signal);
      signal.throwIfAborted();
      this.state.lastCheckedAt = this.host.now(); checkSucceeded = true;
      this.state.latestVersion = update?.version ?? null;
      if (!update) { this.state.lastResult = 'up-to-date'; await phase('completed'); return; }
      this.state.job!.version = update.version;
      if (expectedVersion && update.version !== expectedVersion) throw new UpdateError('UPDATER_VERSION_CHANGED', 409);
      if (!task.automatic && !expectedVersion) { this.state.lastResult = update.automatic ? 'update-available' : 'manual-update-required'; await phase('completed'); return; }
      if (!update.automatic || task.automatic && (this.state.blockedVersion === update.version || original.version.split('.')[0] !== update.version.split('.')[0])) {
        this.state.lastResult = 'manual-update-required'; await phase('completed'); return;
      }
      await phase('downloading');
      const payload = await this.host.download(update, id, signal);
      signal.throwIfAborted(); await phase('preparing');
      await this.host.prepare(payload, update, original, signal);
      signal.throwIfAborted();
      const current = await this.host.installed();
      signal.throwIfAborted();
      if (current.manifestSha256 !== original.manifestSha256) throw new UpdateError('UPDATER_INSTALLATION_CHANGED', 409);
      if (task.automatic && (!this.state.settings.enabled || this.state.revision !== revision || this.host.now() >= window.end)) {
        this.state.lastResult = 'cancelled'; await phase('cancelled'); return;
      }
      // Set boundary synchronously before yielding: disabling can no longer interrupt deployment recovery.
      task.installing = true; await phase('installing');
      const outcome = await this.host.apply(payload, update, original);
      this.state.lastResult = outcome;
      if (outcome !== 'updated') { this.state.blockedVersion = update.version; this.state.needsReview = outcome === 'manual-review-required'; }
      else this.state.latestVersion = null;
      await phase(outcome === 'updated' ? 'completed' : 'failed');
    } catch (error) {
      this.state.job!.error = signal.aborted && !task.installing ? 'UPDATER_CANCELLED' : errorCode(error);
      this.state.job!.phase = signal.aborted && !task.installing ? 'cancelled' : 'failed';
      const manualRequired = ['UPDATER_METADATA_UNAVAILABLE', 'UPDATER_MANUAL_MIGRATION_REQUIRED'].includes(this.state.job!.error);
      this.state.lastResult = this.state.job!.phase === 'cancelled' ? 'cancelled' : manualRequired ? 'manual-update-required' : 'failed';
      if (manualRequired) { checkSucceeded = true; this.state.lastCheckedAt = this.host.now(); }
      const releaseError = error as { retryAt?: unknown; version?: unknown } | null;
      if (releaseError && typeof releaseError.retryAt === 'number' && Number.isSafeInteger(releaseError.retryAt)
        && releaseError.retryAt > this.host.now()) retryAt = releaseError.retryAt;
      if (this.state.job!.error === 'UPDATER_METADATA_UNAVAILABLE' && version(releaseError?.version) && releaseError?.version) this.state.latestVersion = releaseError.version as string;
      if (task.installing) { this.state.needsReview = true; this.state.lastResult = 'manual-review-required'; }
      // Download/network failures may retry; failed application must never loop on the same release.
      if (!task.installing && !signal.aborted && !manualRequired) checkSucceeded = false;
      if ((task.installing || manualRequired) && this.state.job!.version) this.state.blockedVersion = this.state.job!.version;
    } finally {
      if (task.automatic && this.state.revision === revision) {
        if (checkSucceeded) { this.state.dueDate = addDays(window.date, this.state.settings.intervalDays); this.state.attempts = 0; this.state.scheduledAt = null; }
        else {
          this.state.attempts = Math.min(3, this.state.attempts + 1);
          this.state.scheduledAt = Math.max(retryAt ?? 0, this.host.now() + [60_000, 300_000, 900_000][this.state.attempts - 1]);
          if (this.state.attempts >= 3 || this.state.scheduledAt >= window.end) {
            const next = nextUpdateWindow(Math.max(window.end, retryAt ?? 0), addDays(window.date, 1), this.state.settings);
            this.state.dueDate = next.date; this.state.scheduledAt = Math.max(next.start, retryAt ?? 0); this.state.attempts = 0;
          }
        }
        this.plan();
      }
      if (!this.state.needsReview) {
        try { await this.host.cleanup(id); } catch { /* Only private download scratch, never deployment evidence. */ }
      }
      await this.persist();
    }
  }
  async idle(): Promise<void> { await this.task; await this.writing; }
  async close(): Promise<void> {
    this.closed = true;
    if (this.active && !this.active.installing) this.active.controller.abort();
    await this.idle();
  }
}
