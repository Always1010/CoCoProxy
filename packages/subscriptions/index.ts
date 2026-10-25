import { createHash, randomUUID } from 'node:crypto';
import { opendir, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { canonicalJson, compileConfig } from '../config/index.ts';
import type { JsonObject } from '../config/index.ts';
import { FileTransactionStore, TransactionError } from '../transaction/index.ts';
import { PrivateFileError, privateDirectory, inspectPrivateDirectory, privateRead, atomicWrite } from '../storage/private-files.ts';
import { decodeNodeSnapshot, decodeSubscriptionProfile, resolveSubscriptionProfile, SnapshotDecodeError } from './yaml.ts';
import { validateNodeDnsPolicy } from './node-dns.ts';

export type SubscriptionUsage = { upload?: number; download?: number; total?: number; expire?: number };

export type SnapshotResponse =
  | { status: 'modified'; text: string; etag?: string; usage?: SubscriptionUsage }
  | { status: 'not-modified'; usage?: SubscriptionUsage };
export interface SnapshotClient {
  fetch(url: string, previous?: { etag?: string }): Promise<SnapshotResponse>;
}
export type SnapshotDecoder = (text: string) => unknown;
export type SnapshotFailure = 'SOURCE_FETCH_FAILED' | 'SNAPSHOT_DECODE_FAILED' |
  'SNAPSHOT_UNSUPPORTED' | 'SNAPSHOT_INVALID' | 'SNAPSHOT_LIMIT' | 'SOURCE_NOT_MODIFIED_WITHOUT_SNAPSHOT';
export type SourceMetadata = {
  id: string;
  revision: number;
  snapshotDigest: string | null;
  snapshotRevision: number | null;
  snapshotCurrent: boolean;
  lastAttempt: string | null;
  lastError: SnapshotFailure | null;
  name?: string;
  host?: string;
  kind?: 'nodes' | 'profile';
  nodeCount?: number;
  usage?: SubscriptionUsage;
  unsupportedFields?: string[];
};
export type SourceSnapshot = { id: string; proxies: JsonObject[]; policy?: JsonObject; nodeDnsPolicy?: JsonObject; unsupportedFields?: string[]; sha256: string; sourceRevision: number };

/** Public errors deliberately omit URLs, upstream diagnostics and node fields. */
export class SubscriptionError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.name = 'SubscriptionError'; this.code = code; }
}

type StoredSnapshot = { proxies: JsonObject[]; policy?: JsonObject; nodeDnsPolicy?: JsonObject; unsupportedFields?: string[]; materializedProviders?: true; sha256: string; sourceRevision: number; definitionRevision: number };
type SourceRecord = {
  version: 1;
  id: string;
  url: string;
  revision: number;
  definitionRevision: number;
  snapshot: StoredSnapshot | null;
  etag: string | null;
  lastAttempt: string | null;
  lastError: SnapshotFailure | null;
  name?: string;
  generation?: string;
  usage?: SubscriptionUsage;
};
type SnapshotData = { proxies: JsonObject[]; policy?: JsonObject; nodeDnsPolicy?: JsonObject; unsupportedFields?: string[]; materializedProviders?: true };
type RefreshResult = ({ status: 'modified'; sha256: string; etag: string | null; usage?: SubscriptionUsage } & SnapshotData) |
  { status: 'not-modified'; usage?: SubscriptionUsage } | { status: 'failed'; code: SnapshotFailure };
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_SOURCES = 100;
const digestPattern = /^[a-f0-9]{64}$/;
const sourcePattern = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
const validEtag = (value: unknown): value is string => typeof value === 'string' && value.length <= 512 && !/[^\x20-\x7e]/.test(value);
const failureCodes = new Set<SnapshotFailure>([
  'SOURCE_FETCH_FAILED', 'SNAPSHOT_DECODE_FAILED', 'SNAPSHOT_UNSUPPORTED',
  'SNAPSHOT_INVALID', 'SNAPSHOT_LIMIT', 'SOURCE_NOT_MODIFIED_WITHOUT_SNAPSHOT',
]);
const fail: (code: string) => never = code => { throw new TransactionError(code); };
const errno = (error: unknown): string | undefined => (error as NodeJS.ErrnoException)?.code;
const revision = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 1;
const hash = (data: SnapshotData): string => createHash('sha256').update(canonicalJson({ proxies: data.proxies,
  ...(data.policy ? { policy: data.policy } : {}), ...(data.unsupportedFields ? { unsupportedFields: data.unsupportedFields } : {}),
  ...(data.nodeDnsPolicy ? { nodeDnsPolicy: data.nodeDnsPolicy } : {}),
  ...(data.materializedProviders ? { materializedProviders: true } : {}) }), 'utf8').digest('hex');
const timestamp = (value: unknown): value is string | null => value === null ||
  (typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)));

function checkId(id: unknown): asserts id is string {
  if (typeof id !== 'string' || !sourcePattern.test(id)) fail('INVALID_SOURCE_ID');
}

function checkRevision(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) >= Number.MAX_SAFE_INTEGER) fail('INVALID_SOURCE_REVISION');
}

function checkUrl(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length > 8192 || /[\s\u0000-\u001f\u007f\\]/.test(value)) fail('INVALID_SOURCE_URL');
  let url: URL;
  try { url = new URL(value); } catch { fail('INVALID_SOURCE_URL'); }
  if (!['https:', 'http:'].includes(url.protocol) || !url.hostname || url.username || url.password || value.includes('#') ||
      !/^https?:\/\//i.test(value) || value.slice(value.indexOf('//') + 2).split(/[/?]/, 1)[0].includes('@')) fail('INVALID_SOURCE_URL');
}

function checkName(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 128 || /[\u0000-\u001f\u007f]/.test(value)) fail('INVALID_SOURCE_NAME');
}

function validUsage(value: unknown): value is SubscriptionUsage {
  return !!value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length > 0 && Object.entries(value).every(([key, entry]) =>
      ['upload', 'download', 'total', 'expire'].includes(key) && Number.isSafeInteger(entry) && entry >= 0);
}

function sourceDefinition(input: unknown): Readonly<{ id: string; url?: string; name?: string }> {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null)) fail('INVALID_SOURCE_INPUT');
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (Reflect.ownKeys(descriptors).some(key => key !== 'id' && key !== 'url' && key !== 'name')) fail('INVALID_SOURCE_INPUT');
  const id = descriptors.id;
  const url = descriptors.url;
  const name = descriptors.name;
  if (!id?.enumerable || !('value' in id) || [url, name].some(entry => entry && (!entry.enumerable || !('value' in entry)))) fail('INVALID_SOURCE_INPUT');
  checkId(id.value);
  if (url?.value !== undefined && url.value !== '') checkUrl(url.value);
  if (name) checkName(name.value);
  return Object.freeze({ id: id.value, ...(url?.value ? { url: url.value } : {}), ...(name ? { name: name.value } : {}) });
}

function metadata(record: SourceRecord): SourceMetadata {
  return {
    id: record.id, revision: record.revision,
    snapshotDigest: record.snapshot?.sha256 ?? null,
    snapshotRevision: record.snapshot?.sourceRevision ?? null,
    snapshotCurrent: record.snapshot !== null && record.snapshot.definitionRevision === record.definitionRevision,
    lastAttempt: record.lastAttempt, lastError: record.lastError,
    host: new URL(record.url).hostname,
    ...(record.name ? { name: record.name } : {}),
    ...(record.snapshot ? { kind: record.snapshot.policy ? 'profile' as const : 'nodes' as const, nodeCount: record.snapshot.proxies.length } : {}),
    ...(record.usage ? { usage: { ...record.usage } } : {}),
    ...(record.snapshot?.unsupportedFields ? { unsupportedFields: [...record.snapshot.unsupportedFields] } : {}),
  };
}

/** Validate node snapshots or an explicitly selected full inline policy. */
function validateSnapshot(value: unknown, allowProfile = false): SnapshotData {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) fail('SNAPSHOT_INVALID');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some(key => key !== 'proxies' && key !== 'nodeDnsPolicy' && !(allowProfile && ['policy', 'unsupportedFields'].includes(key as string)))) fail('SNAPSHOT_UNSUPPORTED');
  const entry = descriptors.proxies;
  if (!entry || !entry.enumerable || !('value' in entry) || !Array.isArray(entry.value)) fail('SNAPSHOT_INVALID');
  try {
    // This offline safety candidate is neither staged nor applied.
    const profile = descriptors.policy;
    const nodeDns = descriptors.nodeDnsPolicy;
    const unsupported = descriptors.unsupportedFields;
    if (profile && (!profile.enumerable || !('value' in profile) || !profile.value || typeof profile.value !== 'object' || Array.isArray(profile.value))) fail('SNAPSHOT_INVALID');
    if (unsupported && (!unsupported.enumerable || !('value' in unsupported) || !Array.isArray(unsupported.value) ||
        unsupported.value.some((key: unknown) => typeof key !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(key)))) fail('SNAPSHOT_INVALID');
    if (profile && canonicalJson(profile.value.proxies) !== canonicalJson(entry.value)) fail('SNAPSHOT_INVALID');
    if (nodeDns && (!nodeDns.enumerable || !('value' in nodeDns))) fail('SNAPSHOT_INVALID');
    const candidate = compileConfig({
      schemaVersion: 1,
      deployment: { mixedPort: 18080, controllerPort: 18081, dnsPort: 18053,
        controllerSecret: 'offline-subscription-validation', bootstrapResolvers: ['192.0.2.53'] },
      policy: profile?.value ?? { rules: ['MATCH,REJECT'] },
      ...(profile ? {} : { sources: [{ id: 'subscription', proxies: entry.value }] }),
    });
    return { proxies: candidate.config.proxies as JsonObject[],
      ...(profile ? { policy: JSON.parse(canonicalJson(profile.value)) as JsonObject } : {}),
      ...(nodeDns ? { nodeDnsPolicy: validateNodeDnsPolicy(nodeDns.value, candidate.config.proxies as JsonObject[]) } : {}),
      ...(unsupported ? { unsupportedFields: [...unsupported.value] as string[] } : {}) };
  } catch { fail('SNAPSHOT_INVALID'); }
}

function exactKeys(value: object, keys: string[], optional: string[] = []): boolean {
  const actual = Object.keys(value);
  return keys.every(key => actual.includes(key)) && actual.every(key => keys.includes(key) || optional.includes(key));
}

/** One private atomic record per source; mutations share the runtime store lock. */
export class SubscriptionStore {
  readonly root: string;
  private readonly files: FileTransactionStore;
  private readonly client: SnapshotClient | undefined;
  private readonly decoder: SnapshotDecoder;

  constructor(root: string, client?: SnapshotClient, decoder: SnapshotDecoder = JSON.parse) {
    try { this.files = new FileTransactionStore(root); }
    catch { throw new SubscriptionError('INVALID_STORE_PATH'); }
    this.root = this.files.root;
    this.client = client;
    this.decoder = decoder;
  }

  private async protect<T>(operation: () => Promise<T>): Promise<T> {
    try { return await operation(); }
    catch (error) {
      if (error instanceof TransactionError || error instanceof PrivateFileError) throw new SubscriptionError(error.code);
      throw new SubscriptionError('STORE_IO');
    }
  }

  private async read(id: string): Promise<SourceRecord | null> {
    checkId(id);
    try {
      await inspectPrivateDirectory(this.root);
      await inspectPrivateDirectory(join(this.root, 'subscriptions'));
    } catch (error) { if (errno(error) === 'ENOENT') return null; throw error; }
    let record: SourceRecord;
    try { record = JSON.parse(await privateRead(join(this.root, 'subscriptions', `${id}.json`), MAX_BYTES)); }
    catch (error) {
      if (errno(error) === 'ENOENT') return null;
      if (error instanceof PrivateFileError) throw error;
      fail('SOURCE_CORRUPT');
    }
    try {
      if (!record || !exactKeys(record, ['version', 'id', 'url', 'revision', 'definitionRevision', 'snapshot', 'etag', 'lastAttempt', 'lastError'], ['name', 'generation', 'usage']) ||
          record.version !== 1 || record.id !== id || !revision(record.revision) || !revision(record.definitionRevision) ||
          record.definitionRevision > record.revision || !timestamp(record.lastAttempt) ||
          !(record.lastError === null || failureCodes.has(record.lastError)) ||
          !(record.etag === null || validEtag(record.etag))) fail('SOURCE_CORRUPT');
      checkUrl(record.url);
      if (record.name !== undefined) checkName(record.name);
      if (record.generation !== undefined && (typeof record.generation !== 'string' || !/^[a-f0-9-]{36}$/.test(record.generation))) fail('SOURCE_CORRUPT');
      if (record.usage !== undefined && !validUsage(record.usage)) fail('SOURCE_CORRUPT');
      if (record.snapshot !== null) {
        const snapshot = record.snapshot;
        if (!snapshot || !exactKeys(snapshot, ['proxies', 'sha256', 'sourceRevision', 'definitionRevision'], ['policy', 'nodeDnsPolicy', 'unsupportedFields', 'materializedProviders']) ||
            !Array.isArray(snapshot.proxies) || !digestPattern.test(snapshot.sha256) ||
            !revision(snapshot.sourceRevision) || snapshot.sourceRevision > record.revision ||
            !revision(snapshot.definitionRevision) || snapshot.definitionRevision > snapshot.sourceRevision ||
            snapshot.definitionRevision > record.definitionRevision || hash(snapshot) !== snapshot.sha256) fail('SOURCE_CORRUPT');
        if (snapshot.materializedProviders !== undefined && snapshot.materializedProviders !== true) fail('SOURCE_CORRUPT');
        validateSnapshot({ proxies: snapshot.proxies, ...(snapshot.policy ? { policy: snapshot.policy } : {}),
          ...(Object.hasOwn(snapshot, 'nodeDnsPolicy') ? { nodeDnsPolicy: snapshot.nodeDnsPolicy } : {}),
          ...(snapshot.unsupportedFields ? { unsupportedFields: snapshot.unsupportedFields } : {}) }, true);
      }
      if (record.etag !== null && !metadata(record).snapshotCurrent) fail('SOURCE_CORRUPT');
      return record;
    } catch { fail('SOURCE_CORRUPT'); }
  }

  private async write(record: SourceRecord): Promise<void> {
    const contents = JSON.stringify(record);
    if (Buffer.byteLength(contents, 'utf8') > MAX_BYTES) fail('SNAPSHOT_LIMIT');
    await privateDirectory(join(this.root, 'subscriptions'));
    await atomicWrite(join(this.root, 'subscriptions'), `${record.id}.json`, contents);
  }

  async configure(input: { id: string; url?: string; name?: string }, expectedRevision: number): Promise<SourceMetadata> {
    return this.protect(async () => {
      // Capture validated primitives before the first asynchronous boundary.
      const definition = sourceDefinition(input);
      checkRevision(expectedRevision);
      return this.files.exclusive(async () => {
        const previous = await this.read(definition.id);
        if ((previous?.revision ?? 0) !== expectedRevision) fail('SOURCE_CONFLICT');
        if (!previous) {
          await privateDirectory(join(this.root, 'subscriptions'));
          const entries = await readdir(join(this.root, 'subscriptions'));
          if (entries.length >= MAX_SOURCES) fail('SOURCE_LIMIT');
        }
        const url = definition.url ?? previous?.url;
        checkUrl(url);
        const changed = previous?.url !== url;
        const record: SourceRecord = {
          version: 1, id: definition.id, url, revision: expectedRevision + 1,
          generation: previous?.generation ?? randomUUID(),
          ...(definition.name ?? previous?.name ? { name: definition.name ?? previous?.name } : {}),
          ...(!changed && previous?.usage ? { usage: previous.usage } : {}),
          definitionRevision: changed ? expectedRevision + 1 : previous!.definitionRevision,
          snapshot: previous?.snapshot ?? null, etag: changed ? null : previous!.etag,
          lastAttempt: changed ? null : previous!.lastAttempt, lastError: changed ? null : previous!.lastError,
        };
        if (Buffer.byteLength(JSON.stringify(record), 'utf8') > MAX_BYTES - 256) fail('SNAPSHOT_LIMIT');
        await this.write(record);
        return metadata(record);
      });
    });
  }

  /** Compare-and-delete under the same lock used by configure and refresh. */
  async remove(id: string, expectedRevision: number, mayRemove?: () => Promise<boolean>): Promise<void> {
    return this.protect(async () => {
      checkId(id); checkRevision(expectedRevision);
      await this.files.exclusive(async () => {
        const current = await this.read(id);
        if (!current) fail('SOURCE_NOT_FOUND');
        if (current.revision !== expectedRevision) fail('SOURCE_CONFLICT');
        // The application can protect its current source under the same lock
        // used by workspace saves, closing the check/delete race.
        if (mayRemove && !await mayRemove()) fail('SOURCE_IN_USE');
        await unlink(join(this.root, 'subscriptions', `${id}.json`));
      });
    });
  }

  async status(id: string): Promise<SourceMetadata | null> {
    return this.protect(async () => {
      const record = await this.read(id);
      return record ? metadata(record) : null;
    });
  }

  /** Read-only inventory; public metadata never includes subscription URLs. */
  async list(): Promise<SourceMetadata[]> {
    return this.protect(async () => {
      try {
        await inspectPrivateDirectory(this.root);
        await inspectPrivateDirectory(join(this.root, 'subscriptions'));
      } catch (error) { if (errno(error) === 'ENOENT') return []; throw error; }
      const result: SourceMetadata[] = [];
      let inspected = 0;
      for await (const entry of await opendir(join(this.root, 'subscriptions'))) {
        if (++inspected > MAX_SOURCES + 16) fail('SOURCE_LIMIT');
        const name = entry.name;
        // Atomic writers may have a private temporary file while a refresh
        // commits. Ignore only their known temporary naming convention.
        if (/^\.write-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(name)) continue;
        if (!entry.isFile() || !name.endsWith('.json') || !sourcePattern.test(name.slice(0, -5))) fail('SOURCE_CORRUPT');
        const record = await this.read(name.slice(0, -5));
        if (record !== null) result.push(metadata(record));
        if (result.length > MAX_SOURCES) fail('SOURCE_LIMIT');
      }
      return result.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    });
  }

  /** Private compiler input; callers must protect these credentials from logs. */
  async snapshot(id: string, expectedRevision?: number): Promise<SourceSnapshot> {
    return this.protect(async () => {
      if (expectedRevision !== undefined) checkRevision(expectedRevision);
      const record = await this.read(id);
      if (!record) fail('SOURCE_NOT_FOUND');
      if (expectedRevision !== undefined && record.revision !== expectedRevision) fail('SOURCE_CONFLICT');
      if (!record.snapshot || !metadata(record).snapshotCurrent) fail('SOURCE_PENDING');
      return { id, proxies: record.snapshot.proxies,
        ...(record.snapshot.policy ? { policy: record.snapshot.policy } : {}),
        ...(record.snapshot.nodeDnsPolicy ? { nodeDnsPolicy: record.snapshot.nodeDnsPolicy } : {}),
        ...(record.snapshot.unsupportedFields ? { unsupportedFields: record.snapshot.unsupportedFields } : {}),
        sha256: record.snapshot.sha256, sourceRevision: record.snapshot.sourceRevision };
    });
  }

  private async download(record: SourceRecord, nodesOnly = false): Promise<RefreshResult> {
    let response: SnapshotResponse;
    // A cached parent document cannot prove that its remote providers are current.
    const conditional = record.etag !== null && !record.snapshot?.materializedProviders;
    try { response = await this.client!.fetch(record.url, conditional ? { etag: record.etag! } : undefined); }
    catch { return { status: 'failed', code: 'SOURCE_FETCH_FAILED' }; }
    if (!response || typeof response !== 'object') return { status: 'failed', code: 'SOURCE_FETCH_FAILED' };
    if (response.status === 'not-modified') {
      if (!record.snapshot || !metadata(record).snapshotCurrent || !conditional) {
        return { status: 'failed', code: 'SOURCE_NOT_MODIFIED_WITHOUT_SNAPSHOT' };
      }
      return { status: 'not-modified', ...(validUsage(response.usage) ? { usage: { ...response.usage } } : {}) };
    }
    if (response.status !== 'modified' || typeof response.text !== 'string') {
      return { status: 'failed', code: 'SOURCE_FETCH_FAILED' };
    }
    if (Buffer.byteLength(response.text, 'utf8') > MAX_BYTES) return { status: 'failed', code: 'SNAPSHOT_LIMIT' };
    let decoded: unknown;
    let materializedProviders = false;
    try {
      if (nodesOnly) decoded = decodeNodeSnapshot(response.text);
      else if (this.decoder === decodeSubscriptionProfile) {
        const resolved = await resolveSubscriptionProfile(response.text, async url => {
          try { return await this.client!.fetch(url); }
          catch { throw new TransactionError('SOURCE_FETCH_FAILED'); }
        });
        decoded = resolved.value;
        materializedProviders = resolved.materializedProviders;
      } else decoded = this.decoder(response.text);
    }
    catch (error) { return { status: 'failed', code: error instanceof SnapshotDecodeError ? error.code :
      error instanceof TransactionError && error.code === 'SOURCE_FETCH_FAILED' ? 'SOURCE_FETCH_FAILED' : 'SNAPSHOT_DECODE_FAILED' }; }
    try {
      const data = validateSnapshot(decoded, this.decoder === decodeSubscriptionProfile);
      if (materializedProviders) data.materializedProviders = true;
      // An unusable cache validator must not discard an otherwise valid body.
      return { status: 'modified', ...data, sha256: hash(data), etag: validEtag(response.etag) ? response.etag : null,
        ...(validUsage(response.usage) ? { usage: { ...response.usage } } : {}) };
    } catch (error) {
      return { status: 'failed', code: error instanceof TransactionError && error.code === 'SNAPSHOT_UNSUPPORTED' ? 'SNAPSHOT_UNSUPPORTED' : 'SNAPSHOT_INVALID' };
    }
  }

  async refresh(id: string, expectedRevision: number, options: { nodesOnly?: boolean } = {}): Promise<SourceMetadata> {
    return this.protect(async () => {
      checkId(id); checkRevision(expectedRevision);
      if (!this.client) fail('SOURCE_CLIENT_REQUIRED');
      const captured = await this.read(id);
      if (!captured) fail('SOURCE_NOT_FOUND');
      if (captured.revision !== expectedRevision) fail('SOURCE_CONFLICT');
      // Download and decoding never occupy the shared transaction lock.
      const result = await this.download(captured, options.nodesOnly === true);
      const committed = await this.files.exclusive(async () => {
        const current = await this.read(id);
        if (!current || current.revision !== captured.revision || current.generation !== captured.generation) fail('SOURCE_CONFLICT');
        current.revision++;
        current.lastAttempt = new Date().toISOString();
        current.lastError = result.status === 'failed' ? result.code : null;
        if (result.status !== 'failed' && result.usage) current.usage = result.usage;
        if (result.status === 'modified') {
          const updated: SourceRecord = {
            ...current,
            snapshot: { proxies: result.proxies, sha256: result.sha256, sourceRevision: current.revision,
              ...(result.policy ? { policy: result.policy } : {}),
              ...(result.nodeDnsPolicy ? { nodeDnsPolicy: result.nodeDnsPolicy } : {}),
              ...(result.unsupportedFields ? { unsupportedFields: result.unsupportedFields } : {}),
              ...(result.materializedProviders ? { materializedProviders: true as const } : {}),
              definitionRevision: current.definitionRevision },
            etag: result.etag,
          };
          // Reserve room for a later fixed failure code without dropping the
          // accepted snapshot merely to record that an upstream refresh failed.
          if (Buffer.byteLength(JSON.stringify(updated), 'utf8') <= MAX_BYTES - 256) {
            await this.write(updated);
            return { metadata: metadata(updated), failure: null };
          }
          current.lastError = 'SNAPSHOT_LIMIT';
        }
        await this.write(current);
        return { metadata: metadata(current), failure: current.lastError };
      });
      if (committed.failure) fail(committed.failure);
      return committed.metadata;
    });
  }
}
