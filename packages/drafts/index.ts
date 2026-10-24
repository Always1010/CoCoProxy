import { join } from 'node:path';
import { compileConfig, ConfigError } from '../config/index.ts';
import type { JsonObject } from '../config/index.ts';
import { atomicWrite, inspectPrivateDirectory, privateRead, PrivateFileError } from '../storage/private-files.ts';
import { FileTransactionStore, TransactionError } from '../transaction/index.ts';

export type DraftMetadata = { revision: number; generation: string; updatedAt: string };
export type LoadedDraft = { revision: number; input: JsonObject; generation: string };
type DraftDocument = DraftMetadata & { version: 1; input: JsonObject };

/** Public errors deliberately contain neither configuration values nor OS paths. */
export class DraftError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.name = 'DraftError'; this.code = code; }
}

const MAX_DOCUMENT_BYTES = 4 * 1024 * 1024;
const DIGEST = /^[a-f0-9]{64}$/;
const DOCUMENT_KEYS = new Set(['version', 'revision', 'input', 'generation', 'updatedAt']);
const errno = (error: unknown): string | undefined => (error as NodeJS.ErrnoException)?.code;
const fail: (code: string) => never = code => { throw new DraftError(code); };

function expectedRevision(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) fail('INVALID_DRAFT_REVISION');
}

function publicError(error: unknown): DraftError {
  if (error instanceof DraftError) return error;
  if (error instanceof ConfigError || error instanceof TransactionError || error instanceof PrivateFileError) {
    return new DraftError(error.code === 'STORE_CORRUPT' ? 'DRAFT_CORRUPT' : error.code);
  }
  return new DraftError('STORE_IO');
}

function metadata(document: DraftDocument): DraftMetadata {
  return { revision: document.revision, generation: document.generation, updatedAt: document.updatedAt };
}

/**
 * A mutable private draft, independent of immutable candidates and runtime state.
 * Uses the transaction store's process lock without nesting exclusive operations.
 */
export class DraftStore {
  readonly root: string;
  private readonly transactions: FileTransactionStore;

  constructor(root: string) {
    try { this.transactions = new FileTransactionStore(root); this.root = this.transactions.root; }
    catch (error) { throw publicError(error); }
  }

  private async readDocument(): Promise<DraftDocument | null> {
    try { await inspectPrivateDirectory(this.root); }
    catch (error) { if (errno(error) === 'ENOENT') return null; throw error; }
    let contents: string;
    try { contents = await privateRead(join(this.root, 'draft.json'), MAX_DOCUMENT_BYTES); }
    catch (error) { if (errno(error) === 'ENOENT') return null; throw error; }
    let value: unknown;
    try { value = JSON.parse(contents); } catch { fail('DRAFT_CORRUPT'); }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('DRAFT_CORRUPT');
    const document = value as DraftDocument;
    if (Object.keys(document).length !== DOCUMENT_KEYS.size || Object.keys(document).some(key => !DOCUMENT_KEYS.has(key)) ||
        document.version !== 1 || !Number.isSafeInteger(document.revision) || document.revision < 1 ||
        typeof document.generation !== 'string' || !DIGEST.test(document.generation) ||
        typeof document.updatedAt !== 'string' || !Number.isFinite(Date.parse(document.updatedAt)) ||
        new Date(document.updatedAt).toISOString() !== document.updatedAt) fail('DRAFT_CORRUPT');
    try { if (compileConfig(document.input).sha256 !== document.generation) fail('DRAFT_CORRUPT'); }
    catch { fail('DRAFT_CORRUPT'); }
    return document;
  }

  async metadata(): Promise<DraftMetadata | null> {
    try {
      const document = await this.readDocument();
      return document === null ? null : metadata(document);
    } catch (error) { throw publicError(error); }
  }

  /** Returned input contains secrets and must never be printed as CLI output. */
  async load(revision: number): Promise<LoadedDraft> {
    try {
      expectedRevision(revision);
      const document = await this.readDocument();
      if (document === null) fail('DRAFT_NOT_FOUND');
      if (document.revision !== revision) fail('DRAFT_CONFLICT');
      return { revision: document.revision, input: document.input, generation: document.generation };
    } catch (error) { throw publicError(error); }
  }

  async save(input: unknown, revision: number): Promise<DraftMetadata> {
    try {
      expectedRevision(revision);
      // First validate the caller's data without invoking accessors or toJSON.
      compileConfig(input);
      let snapshot: JsonObject;
      try { snapshot = structuredClone(input) as JsonObject; }
      catch { fail('INVALID_INPUT'); }
      const generation = compileConfig(snapshot).sha256;
      return await this.transactions.exclusive(async () => {
        // exclusive preserves TransactionError codes only; translate business
        // failures before they cross that boundary.
        try {
          const current = await this.readDocument();
          if ((current?.revision ?? 0) !== revision) fail('DRAFT_CONFLICT');
          if (revision === Number.MAX_SAFE_INTEGER) fail('DRAFT_REVISION_LIMIT');
          const document: DraftDocument = {
            version: 1, revision: revision + 1, input: snapshot, generation, updatedAt: new Date().toISOString(),
          };
          const contents = JSON.stringify(document);
          if (Buffer.byteLength(contents, 'utf8') > MAX_DOCUMENT_BYTES) fail('STORE_LIMIT');
          await atomicWrite(this.root, 'draft.json', contents);
          return metadata(document);
        } catch (error) { throw new TransactionError(publicError(error).code); }
      });
    } catch (error) { throw publicError(error); }
  }
}
