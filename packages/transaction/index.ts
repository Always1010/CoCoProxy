import { createHash, randomUUID } from 'node:crypto';
import { PrivateFileError, privateDirectory, inspectPrivateDirectory, privateRead, atomicWrite, syncDirectory } from '../storage/private-files.ts';
import { mkdir, readFile, rename, unlink, rmdir, lstat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { canonicalJson } from '../config/index.ts';
import type { Candidate } from '../config/index.ts';

export interface RuntimeAdapter {
  validate(candidatePath: string): Promise<void>;
  activate(candidatePath: string, generation: string): Promise<void>;
  confirm(generation: string): Promise<boolean>;
  restore(previousPath: string | null, previousGeneration: string | null): Promise<void>;
}

export type TransactionPhase = 'validating' | 'activating' | 'confirming' | 'restoring' | 'recovering-target' | 'fault' | 'committed';
export type PublicStatus = {
  desired: string | null;
  active: string | null;
  transaction: { id: string; phase: TransactionPhase } | null;
  fault: string | null;
  checkedAt: string | null;
  /** Persisted success is never an observation of current runtime health. */
  readiness: 'unknown' | 'fault';
};

export class TransactionError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = 'TransactionError';
    this.code = code;
  }
}

type Pending = { id: string; previous: string | null; target: string; phase: TransactionPhase; ownerToken?: string };
type State = {
  version: 1;
  desired: string | null;
  active: string | null;
  pending: Pending | null;
  fault: string | null;
  checkedAt: string | null;
};
type LockOwner = { pid: number; token: string; bootId: string | null; startTime: string | null };
const digestPattern = /^[a-f0-9]{64}$/;
const phases = new Set(['validating', 'activating', 'confirming', 'restoring', 'recovering-target', 'fault', 'committed']);
const emptyState = (): State => ({ version: 1, desired: null, active: null, pending: null, fault: null, checkedAt: null });
const errno = (error: unknown): string | undefined => (error as NodeJS.ErrnoException)?.code;
const validId = (value: unknown): value is string => typeof value === 'string' && digestPattern.test(value);
const optionalId = (value: unknown): value is string | null => value === null || validId(value);
const fail: (code: string) => never = code => { throw new TransactionError(code); };

function publicStatus(state: State): PublicStatus {
  return {
    desired: state.desired, active: state.active,
    transaction: state.pending ? { id: state.pending.id, phase: state.pending.phase } : null,
    fault: state.fault, checkedAt: state.checkedAt,
    readiness: state.fault === 'RESTORE_FAILED' ? 'fault' : 'unknown',
  };
}

async function linuxIdentity(pid: number): Promise<{ bootId: string; startTime: string; alive: boolean }> {
  const bootId = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
  const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
  // comm may contain spaces and parentheses. Field 22 follows the last ')'.
  const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
  const startTime = fields[19];
  if (!bootId || !/^\d+$/.test(startTime ?? '')) fail('STORE_LOCKED');
  return { bootId, startTime, alive: !['Z', 'X', 'x'].includes(fields[0]) };
}

/** Private file store. POSIX permissions are enforced; Windows requires a private parent ACL. */
export class FileTransactionStore {
  readonly root: string;
  constructor(root: string) {
    if (!isAbsolute(root)) fail('INVALID_STORE_PATH');
    this.root = resolve(root);
  }

  private async initialize(): Promise<void> {
    await privateDirectory(this.root);
    await privateDirectory(join(this.root, 'candidates'));
  }

  private async reclaimDeadLock(): Promise<boolean> {
    if (process.platform !== 'linux') return false;
    const guard = join(this.root, '.lock-recovery');
    try { await mkdir(guard, { mode: 0o700 }); }
    catch (error) { if (errno(error) === 'EEXIST') return false; throw error; }
    try {
      let owner: LockOwner;
      try {
        const lockStat = await lstat(join(this.root, '.lock'));
        if (!lockStat.isDirectory() || lockStat.isSymbolicLink()) return false;
        owner = JSON.parse(await privateRead(join(this.root, '.lock', 'owner.json'), 4096));
      }
      catch { return false; }
      if (!Number.isSafeInteger(owner.pid) || owner.pid < 1 || typeof owner.token !== 'string' ||
          typeof owner.bootId !== 'string' || typeof owner.startTime !== 'string') return false;
      const boot = (await linuxIdentity(process.pid)).bootId;
      let dead = owner.bootId !== boot;
      if (!dead) {
        try {
          const identity = await linuxIdentity(owner.pid);
          dead = !identity.alive || identity.startTime !== owner.startTime;
        }
        catch (error) { if (errno(error) === 'ENOENT') dead = true; else return false; }
      }
      if (!dead) return false;
      // The recovery guard serializes reclaimers. No writer can own a lock
      // whose recorded process identity is known to have exited.
      const tombstone = join(this.root, `.dead-lock-${randomUUID()}`);
      await rename(join(this.root, '.lock'), tombstone);
      await syncDirectory(this.root);
      await unlink(join(tombstone, 'owner.json'));
      await rmdir(tombstone);
      return true;
    } finally { await rmdir(guard); }
  }

  /** Serializes all mutations across managers and processes; live contention fails closed. */
  async exclusive<T>(operation: (ownerToken: string) => Promise<T>): Promise<T> {
    try {
      await this.initialize();
      const lock = join(this.root, '.lock');
      try { await mkdir(lock, { mode: 0o700 }); }
      catch (error) {
        if (errno(error) !== 'EEXIST') throw error;
        if (!await this.reclaimDeadLock()) fail('STORE_LOCKED');
        try { await mkdir(lock, { mode: 0o700 }); }
        catch (retryError) { if (errno(retryError) === 'EEXIST') fail('STORE_LOCKED'); throw retryError; }
      }
      const identity = process.platform === 'linux' ? await linuxIdentity(process.pid) : { bootId: null, startTime: null };
      const owner: LockOwner = { pid: process.pid, token: randomUUID(), bootId: identity.bootId, startTime: identity.startTime };
      await atomicWrite(lock, 'owner.json', JSON.stringify(owner));
      try { return await operation(owner.token); }
      finally {
        await unlink(join(lock, 'owner.json'));
        await rmdir(lock);
        await syncDirectory(this.root);
      }
    } catch (error) {
      if (error instanceof PrivateFileError) throw new TransactionError(error.code); if (error instanceof TransactionError) throw error;
      throw new TransactionError('STORE_IO');
    }
  }

  /** Read-only Linux proof; a stale intent cannot borrow an unrelated writer's lock. */
  async hasLiveLockOwner(token: string | undefined): Promise<boolean> {
    if (process.platform !== 'linux' || typeof token !== 'string' ||
        !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(token)) return false;
    try {
      await inspectPrivateDirectory(this.root);
      const lock = join(this.root, '.lock');
      await inspectPrivateDirectory(lock);
      const path = join(lock, 'owner.json');
      const bytes = await privateRead(path, 4096);
      const owner = JSON.parse(bytes) as LockOwner;
      if (owner.token !== token || !Number.isSafeInteger(owner.pid) || owner.pid < 1 ||
          typeof owner.bootId !== 'string' || typeof owner.startTime !== 'string') return false;
      const identity = await linuxIdentity(owner.pid);
      if (!identity.alive || identity.bootId !== owner.bootId || identity.startTime !== owner.startTime) return false;
      // Reclamation/replacement during the process observation revokes this proof.
      return await privateRead(path, 4096) === bytes;
    } catch { return false; }
  }

  candidatePath(id: string): string {
    if (!validId(id)) fail('INVALID_CANDIDATE_ID');
    return join(this.root, 'candidates', `${id}.json`);
  }

  async readCandidate(id: string): Promise<string> {
    const path = this.candidatePath(id);
    let bytes: string;
    try { bytes = await privateRead(path); }
    catch (error) { if (errno(error) === 'ENOENT') fail('CANDIDATE_NOT_FOUND'); throw error; }
    if (createHash('sha256').update(bytes).digest('hex') !== id) fail('CANDIDATE_TAMPERED');
    let value: unknown;
    try { value = JSON.parse(bytes); } catch { fail('CANDIDATE_TAMPERED'); }
    if (value === null || typeof value !== 'object' || Array.isArray(value) || canonicalJson(value as Candidate['config']) !== bytes) fail('CANDIDATE_TAMPERED');
    return path;
  }

  async readState(): Promise<State> {
    let value: State;
    try { value = JSON.parse(await privateRead(join(this.root, 'state.json'), 64 * 1024)); }
    catch (error) { if (errno(error) === 'ENOENT') return emptyState(); if (error instanceof PrivateFileError) throw new TransactionError(error.code); if (error instanceof TransactionError) throw error; fail('STATE_CORRUPT'); }
    if (!value || value.version !== 1 || !optionalId(value.desired) || !optionalId(value.active) ||
        !(value.fault === null || value.fault === 'RESTORE_FAILED') ||
        !(value.checkedAt === null || (typeof value.checkedAt === 'string' && Number.isFinite(Date.parse(value.checkedAt))))) fail('STATE_CORRUPT');
    if (value.pending !== null) {
      const pending = value.pending;
      if (!pending || typeof pending.id !== 'string' || !/^[a-f0-9-]{36}$/.test(pending.id) ||
          (pending.ownerToken !== undefined && (typeof pending.ownerToken !== 'string' ||
            !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(pending.ownerToken))) ||
          !optionalId(pending.previous) || !validId(pending.target) || !phases.has(pending.phase) ||
          value.desired !== pending.target ||
          (pending.phase === 'committed' ? value.active !== pending.target : value.active !== pending.previous &&
            !((pending.phase === 'fault' || pending.phase === 'restoring' || pending.phase === 'recovering-target') && value.active === null && value.fault === 'RESTORE_FAILED'))) fail('STATE_CORRUPT');
    }
    if (value.fault !== null && value.pending?.phase !== 'fault' && value.pending?.phase !== 'restoring' && value.pending?.phase !== 'recovering-target') fail('STATE_CORRUPT');
    if (value.pending?.phase === 'recovering-target' && (value.active !== null || value.fault !== 'RESTORE_FAILED')) fail('STATE_CORRUPT');
    return value;
  }

  async writeState(state: State): Promise<void> {
    await atomicWrite(this.root, 'state.json', JSON.stringify(state));
  }

  async stage(candidate: Candidate): Promise<{ id: string; path: string }> {
    return this.exclusive(async () => {
      if (!candidate || !validId(candidate.id) || candidate.sha256 !== candidate.id) fail('INVALID_CANDIDATE_DIGEST');
      let contents: string;
      try {
        if (!candidate.config || typeof candidate.config !== 'object' || Array.isArray(candidate.config)) fail('INVALID_CANDIDATE_DIGEST');
        contents = canonicalJson(candidate.config);
        if (canonicalJson(JSON.parse(contents)) !== contents) fail('INVALID_CANDIDATE_DIGEST');
      } catch { fail('INVALID_CANDIDATE_DIGEST'); }
      if (Buffer.byteLength(contents, 'utf8') > 4 * 1024 * 1024) fail('STORE_LIMIT');
      if (createHash('sha256').update(contents).digest('hex') !== candidate.sha256) fail('INVALID_CANDIDATE_DIGEST');
      const path = this.candidatePath(candidate.id);
      try {
        const existing = await privateRead(path);
        if (existing !== contents) fail('CANDIDATE_COLLISION');
      } catch (error) {
        if (errno(error) !== 'ENOENT') throw error;
        await atomicWrite(join(this.root, 'candidates'), `${candidate.id}.json`, contents);
      }
      await this.readCandidate(candidate.id);
      return { id: candidate.id, path };
    });
  }

  async status(): Promise<PublicStatus> {
    try {
      try { await inspectPrivateDirectory(this.root); }
      catch (error) { if (errno(error) === 'ENOENT') return publicStatus(emptyState()); throw error; }
      return publicStatus(await this.readState());
    }
    catch (error) { if (error instanceof PrivateFileError) throw new TransactionError(error.code); if (error instanceof TransactionError) throw error; throw new TransactionError('STORE_IO'); }
  }
}

export class TransactionManager {
  readonly store: FileTransactionStore;
  readonly runtime: RuntimeAdapter;
  constructor(store: FileTransactionStore, runtime: RuntimeAdapter) { this.store = store; this.runtime = runtime; }

  async stage(candidate: Candidate): Promise<{ id: string; path: string }> { return this.store.stage(candidate); }
  async status(): Promise<PublicStatus> { return this.store.status(); }

  private async restore(state: State, ownerToken: string): Promise<void> {
    const pending = state.pending!;
    pending.phase = 'restoring';
    pending.ownerToken = ownerToken;
    await this.store.writeState(state);
    try {
      const path = pending.previous === null ? null : await this.store.readCandidate(pending.previous);
      await this.runtime.restore(path, pending.previous);
    } catch {
      pending.phase = 'fault';
      state.active = null;
      state.fault = 'RESTORE_FAILED';
      state.checkedAt = new Date().toISOString();
      await this.store.writeState(state);
      fail('RESTORE_FAILED');
    }
    state.active = pending.previous;
    state.pending = null;
    state.fault = null;
    state.checkedAt = new Date().toISOString();
    await this.store.writeState(state);
  }

  async apply(id: string, expectedActive: string | null, precondition?: () => Promise<void>): Promise<PublicStatus> {
    return this.store.exclusive(async ownerToken => {
      if (!validId(id)) fail('INVALID_CANDIDATE_ID');
      if (!optionalId(expectedActive)) fail('INVALID_EXPECTED_ACTIVE');
      const state = await this.store.readState();
      if (state.pending) fail('RECOVERY_REQUIRED');
      if (state.active !== expectedActive) fail('ACTIVE_CONFLICT');
      const path = await this.store.readCandidate(id);
      // Application-specific revisions must be checked under this same lock,
      // before any persisted intent or runtime operation is started.
      await precondition?.();
      state.desired = id;
      state.pending = { id: randomUUID(), previous: state.active, target: id, phase: 'validating',
        ownerToken };
      await this.store.writeState(state);
      try { await this.runtime.validate(path); }
      catch {
        state.pending = null;
        state.checkedAt = new Date().toISOString();
        await this.store.writeState(state);
        fail('VALIDATION_FAILED');
      }
      // Recheck immutable bytes after validation before the runtime can activate.
      await this.store.readCandidate(id);
      state.pending!.phase = 'activating';
      await this.store.writeState(state);
      try { await this.runtime.activate(path, id); }
      catch { await this.restore(state, ownerToken); fail('ACTIVATION_FAILED'); }
      state.pending!.phase = 'confirming';
      await this.store.writeState(state);
      let confirmed = false;
      try { confirmed = await this.runtime.confirm(id) === true; } catch { /* opaque runtime failure */ }
      if (!confirmed) { await this.restore(state, ownerToken); fail('CONFIRM_FAILED'); }
      // The atomic state replacement is the sole commit point. A crash before
      // cleanup must retain the confirmed target, never restore the predecessor.
      state.active = id;
      state.fault = null;
      state.checkedAt = new Date().toISOString();
      state.pending!.phase = 'committed';
      await this.store.writeState(state);
      state.pending = null;
      await this.store.writeState(state);
      return publicStatus(state);
    });
  }

  async recover(): Promise<PublicStatus> {
    return this.store.exclusive(async ownerToken => {
      const state = await this.store.readState();
      if (!state.pending) return publicStatus(state);
      if (state.pending.phase === 'committed' && state.active === state.pending.target) {
        await this.store.readCandidate(state.active);
        state.pending = null;
        await this.store.writeState(state);
      } else {
        await this.restore(state, ownerToken);
      }
      return publicStatus(state);
    });
  }

  /** Explicit operator recovery when the predecessor no longer matches a
   * reviewed deployment. Never infer success from selection or persisted intent. */
  async recoverTarget(expectedTransaction: string, generation: string): Promise<PublicStatus> {
    return this.store.exclusive(async ownerToken => {
      const state = await this.store.readState();
      if (!state.pending || state.pending.id !== expectedTransaction || state.pending.target !== generation ||
          state.desired !== generation) fail('ACTIVE_CONFLICT');
      if (!['fault', 'recovering-target'].includes(state.pending.phase) || state.fault !== 'RESTORE_FAILED' || state.active !== null) fail('RECOVERY_REQUIRED');
      const path = await this.store.readCandidate(generation);
      const stopUnconfirmed = async () => {
        try { await this.runtime.restore(null, null); } catch { /* The durable fault remains authoritative. */ }
        state.pending!.phase = 'fault';
        await this.store.writeState(state);
      };
      // Retain the durable fault throughout the attempt. An interruption or
      // failure must remain recoverable and must never commit an unready core.
      try { await this.runtime.validate(path); } catch { await stopUnconfirmed(); fail('VALIDATION_FAILED'); }
      await this.store.readCandidate(generation);
      state.pending.phase = 'recovering-target';
      state.pending.ownerToken = ownerToken;
      await this.store.writeState(state);
      try { await this.runtime.activate(path, generation); } catch { await stopUnconfirmed(); fail('ACTIVATION_FAILED'); }
      let confirmed = false;
      try { confirmed = await this.runtime.confirm(generation) === true; } catch { /* Preserve the fault. */ }
      if (!confirmed) { await stopUnconfirmed(); fail('CONFIRM_FAILED'); }
      await this.store.readCandidate(generation);
      state.active = generation;
      state.fault = null;
      state.checkedAt = new Date().toISOString();
      state.pending.phase = 'committed';
      await this.store.writeState(state);
      state.pending = null;
      await this.store.writeState(state);
      return publicStatus(state);
    });
  }
}
