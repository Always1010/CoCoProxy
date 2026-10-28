import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { lstat, open } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { privateDirectory, syncDirectory } from '../storage/private-files.ts';
import { ManagementError, exactRecord, readJsonBody } from './http.ts';
import { normalizeIP } from './request-address.ts';

export const USAGE_DATABASE = 'usage.sqlite';
export const USAGE_SCHEMA = 1;
const APPLICATION_ID = 0x43435055;
const DAY = 86_400_000, MINUTE = 60_000;
export const USAGE_DETAIL_RETENTION = 30 * DAY, USAGE_DAILY_RETENTION = 365 * DAY;
const dimensions = ['sourceIP', 'host', 'outbound', 'process', 'inboundUser'] as const;
export type UsageDimension = typeof dimensions[number];
type Counters = { upload: number; download: number };
export type UsageConnection = Counters & { id: string; sourceIP: string; host: string; outbound: string; process: string; inboundUser: string };
export type UsageSnapshot = Counters & { epoch: string; connections: UsageConnection[] };
type Checkpoint = Counters & { epoch: string; at: number; connections: Record<string, Counters> };
type Entry = UsageConnection & { at: number };
type Gap = { start: number; end: number; reason: string };
const fail: (code?: string) => never = (code = 'USAGE_UNAVAILABLE') => { throw new ManagementError(code, 503); };
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const text = (value: unknown, maximum = 512): value is string => typeof value === 'string' && value.length > 0 && value.length <= maximum && !/[\u0000-\u001f\u007f]/.test(value);

/** Only normalized, bounded accounting metadata is retained, never the raw controller frame. */
export function parseUsageSnapshot(value: unknown, epoch: string): UsageSnapshot {
  const snapshot = value as { uploadTotal?: unknown; downloadTotal?: unknown; connections?: unknown };
  if (!snapshot || !integer(snapshot.uploadTotal) || !integer(snapshot.downloadTotal) || !Array.isArray(snapshot.connections) || snapshot.connections.length > 10_000 || !text(epoch)) fail('USAGE_SAMPLE_INVALID');
  const ids = new Set<string>();
  const connections = snapshot.connections.map((input: unknown): UsageConnection => {
    const row = input as { id?: unknown; upload?: unknown; download?: unknown; metadata?: Record<string, unknown>; chains?: unknown[] };
    if (!row || !text(row.id, 160) || ids.has(row.id) || !integer(row.upload) || !integer(row.download) || !row.metadata || typeof row.metadata !== 'object') fail('USAGE_SAMPLE_INVALID');
    ids.add(row.id);
    const field = (value: unknown, fallback: string) => text(value) ? value : fallback;
    return { id: row.id, upload: row.upload, download: row.download, sourceIP: normalizeIP(row.metadata.sourceIP) ?? 'Inner',
      host: field(row.metadata.host, field(row.metadata.destinationIP, 'Unknown')), outbound: field(row.chains?.[0], 'DIRECT'),
      process: field(row.metadata.process, 'Unknown'), inboundUser: field(row.metadata.inboundUser, 'Unknown') };
  });
  return { epoch, upload: snapshot.uploadTotal, download: snapshot.downloadTotal, connections };
}

function parseCheckpoint(input: string): Checkpoint {
  const value = JSON.parse(input) as Checkpoint;
  if (!value || !integer(value.at) || !integer(value.upload) || !integer(value.download) || !text(value.epoch) || !value.connections || typeof value.connections !== 'object' || Array.isArray(value.connections) || Object.keys(value.connections).length > 10_000) fail();
  for (const [id, row] of Object.entries(value.connections)) if (!text(id, 160) || !integer(row.upload) || !integer(row.download)) fail();
  return value;
}

export async function inspectUsageFiles(directory: string, owner = process.geteuid?.()): Promise<boolean> {
  const parent = await lstat(directory);
  if (!parent.isDirectory() || parent.isSymbolicLink() || (process.platform !== 'win32' && ((parent.mode & 0o077) !== 0 || parent.uid !== owner))) fail();
  let present = false;
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    try {
      const info = await lstat(join(directory, USAGE_DATABASE + suffix));
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || (process.platform !== 'win32' && ((info.mode & 0o077) !== 0 || info.uid !== owner))) fail();
      if (!suffix) { if (info.size === 0) fail(); present = true; }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  if (!present) {
    for (const suffix of ['-wal', '-shm', '-journal']) {
      try { await lstat(join(directory, USAGE_DATABASE + suffix)); fail(); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
  }
  return present;
}

function validateDatabase(db: DatabaseSync): void {
  if (db.prepare('PRAGMA application_id').get()?.application_id !== APPLICATION_ID || db.prepare('PRAGMA user_version').get()?.user_version !== USAGE_SCHEMA) fail('USAGE_SCHEMA_UNSUPPORTED');
  if (db.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok') fail();
  for (const table of ['metadata', 'minute_usage', 'daily_usage', 'source_aliases', 'gaps']) db.prepare(`SELECT * FROM ${table} LIMIT 0`).all();
}

/** Single management process owns this connection and its bounded in-memory batch. */
export class UsageStore {
  private checkpoint: Checkpoint | null = null;
  private entries = new Map<string, Entry>();
  private gaps: Gap[] = [];
  private flushedAt = 0;
  private cleanedAt = 0;
  private failed = false;
  private closed = false;
  private readonly db: DatabaseSync;
  private readonly now: () => number;
  private constructor(db: DatabaseSync, now: () => number) {
    this.db = db; this.now = now;
    const saved = db.prepare("SELECT value FROM metadata WHERE key='checkpoint'").get()?.value;
    if (typeof saved === 'string') this.checkpoint = parseCheckpoint(saved);
    this.flushedAt = this.now();
  }

  static async open(directory: string, now = Date.now): Promise<UsageStore> {
    if (!isAbsolute(directory)) fail();
    await privateDirectory(directory);
    const present = await inspectUsageFiles(directory);
    const path = join(directory, USAGE_DATABASE);
    if (!present) { const file = await open(path, 'wx', 0o600); await file.close(); await syncDirectory(directory); }
    const db = new DatabaseSync(path);
    try {
      if (!present) {
        db.exec(`BEGIN IMMEDIATE;
          PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=${USAGE_SCHEMA};
          CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
          CREATE TABLE minute_usage(at INTEGER NOT NULL, sourceIP TEXT NOT NULL, host TEXT NOT NULL, outbound TEXT NOT NULL, process TEXT NOT NULL, inboundUser TEXT NOT NULL, upload INTEGER NOT NULL, download INTEGER NOT NULL,
            PRIMARY KEY(at,sourceIP,host,outbound,process,inboundUser));
          CREATE INDEX minute_source_time ON minute_usage(sourceIP,at);
          CREATE INDEX minute_host_time ON minute_usage(host,at);
          CREATE INDEX minute_outbound_time ON minute_usage(outbound,at);
          CREATE TABLE daily_usage(at INTEGER NOT NULL, sourceIP TEXT NOT NULL, upload INTEGER NOT NULL, download INTEGER NOT NULL, PRIMARY KEY(at,sourceIP));
          CREATE TABLE source_aliases(sourceIP TEXT PRIMARY KEY, label TEXT NOT NULL);
          CREATE TABLE gaps(start INTEGER NOT NULL, end INTEGER NOT NULL, reason TEXT NOT NULL, PRIMARY KEY(start,end,reason));
          `);
        db.prepare('INSERT INTO metadata VALUES(?,?)').run('identity', randomUUID());
        db.exec('COMMIT');
      }
      validateDatabase(db);
      // FULL commits preserve the last completed batch across power loss; no unsafe speed pragmas.
      db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=1000;');
      return new UsageStore(db, now);
    } catch { db.close(); fail(); }
  }

  private guard(): void { if (this.failed || this.closed) fail(); }
  status() {
    this.guard();
    return { startedAt: Number(this.db.prepare("SELECT value FROM metadata WHERE key='startedAt'").get()?.value) || null,
      lastSampleAt: this.checkpoint?.at ?? null, lastCommittedAt: Number(this.db.prepare("SELECT value FROM metadata WHERE key='committedAt'").get()?.value) || null,
      detailAvailableFrom: this.now() - USAGE_DETAIL_RETENTION, dailyAvailableFrom: this.now() - USAGE_DAILY_RETENTION,
      detailRetentionDays: 30, dailyRetentionDays: 365 };
  }

  private add(at: number, connection: UsageConnection, upload: number, download: number) {
    if (!upload && !download) return;
    const row = { ...connection, at: Math.floor(at / MINUTE) * MINUTE, upload, download };
    const key = JSON.stringify([row.at, row.sourceIP, row.host, row.outbound, row.process, row.inboundUser]);
    const old = this.entries.get(key);
    if (old) { old.upload += upload; old.download += download; } else this.entries.set(key, row);
  }

  ingest(snapshot: UsageSnapshot): void {
    this.guard();
    const at = this.now(), previous = this.checkpoint;
    if (!integer(at) || (previous && at < previous.at)) fail('USAGE_CLOCK_INVALID');
    const connections: Record<string, Counters> = Object.create(null);
    for (const row of snapshot.connections) connections[row.id] = { upload: row.upload, download: row.download };
    if (previous) {
      const sameEpoch = snapshot.epoch === previous.epoch;
      const reset = !sameEpoch || snapshot.upload < previous.upload || snapshot.download < previous.download;
      if (reset || at - previous.at > 5000) this.gaps.push({ start: previous.at, end: at, reason: reset ? 'core-reset' : 'collection-gap' });
      const totalUpload = snapshot.upload - (reset ? 0 : previous.upload), totalDownload = snapshot.download - (reset ? 0 : previous.download);
      const deltas = snapshot.connections.map(row => {
        const old = reset ? undefined : previous.connections[row.id];
        return { row, upload: Math.max(0, row.upload - (old?.upload ?? 0)), download: Math.max(0, row.download - (old?.download ?? 0)) };
      });
      const sumUpload = deltas.reduce((sum, row) => sum + row.upload, 0), sumDownload = deltas.reduce((sum, row) => sum + row.download, 0);
      // Core counters and connection snapshots are not atomic together. Never assign more than the known total.
      const validUpload = sumUpload <= totalUpload, validDownload = sumDownload <= totalDownload;
      for (const row of deltas) this.add(at, row.row, validUpload ? row.upload : 0, validDownload ? row.download : 0);
      this.add(at, { id: '', sourceIP: 'Unattributed', host: 'Unattributed', outbound: 'Unknown', process: 'Unknown', inboundUser: 'Unknown', upload: 0, download: 0 },
        totalUpload - (validUpload ? sumUpload : 0), totalDownload - (validDownload ? sumDownload : 0));
    }
    this.checkpoint = { epoch: snapshot.epoch, at, upload: snapshot.upload, download: snapshot.download, connections };
    if (!previous || at - this.flushedAt >= 5000 || this.entries.size >= 10_000 || this.gaps.length >= 100) this.flush();
  }

  flush(): void {
    this.guard();
    if (!this.checkpoint) return;
    try {
      this.db.exec('BEGIN IMMEDIATE');
      const minute = this.db.prepare(`INSERT INTO minute_usage VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(at,sourceIP,host,outbound,process,inboundUser) DO UPDATE SET upload=upload+excluded.upload, download=download+excluded.download`);
      const daily = this.db.prepare(`INSERT INTO daily_usage VALUES(?,?,?,?) ON CONFLICT(at,sourceIP) DO UPDATE SET upload=upload+excluded.upload, download=download+excluded.download`);
      for (const row of this.entries.values()) {
        minute.run(row.at, row.sourceIP, row.host, row.outbound, row.process, row.inboundUser, row.upload, row.download);
        daily.run(Math.floor(row.at / DAY) * DAY, row.sourceIP, row.upload, row.download);
      }
      const gap = this.db.prepare('INSERT OR IGNORE INTO gaps VALUES(?,?,?)');
      for (const row of this.gaps) gap.run(row.start, row.end, row.reason);
      const metadata = this.db.prepare('INSERT INTO metadata VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
      metadata.run('checkpoint', JSON.stringify(this.checkpoint));
      metadata.run('committedAt', String(this.checkpoint.at));
      this.db.prepare("INSERT OR IGNORE INTO metadata VALUES('startedAt',?)").run(String(this.checkpoint.at));
      if (this.now() - this.cleanedAt >= 3_600_000) {
        this.db.prepare('DELETE FROM minute_usage WHERE at<?').run(Math.floor((this.now() - USAGE_DETAIL_RETENTION) / MINUTE) * MINUTE);
        this.db.prepare('DELETE FROM daily_usage WHERE at<?').run(Math.floor((this.now() - USAGE_DAILY_RETENTION) / DAY) * DAY);
        this.db.prepare('DELETE FROM gaps WHERE end<?').run(this.now() - USAGE_DAILY_RETENTION);
      }
      this.db.exec('COMMIT');
      this.entries.clear(); this.gaps = []; this.flushedAt = this.now();
      if (this.now() - this.cleanedAt >= 3_600_000) this.cleanedAt = this.now();
    } catch {
      try { this.db.exec('ROLLBACK'); } catch { /* preserve original fixed failure */ }
      this.failed = true; fail();
    }
  }

  aliases(): Record<string, string> {
    this.guard();
    return Object.fromEntries(this.db.prepare('SELECT sourceIP,label FROM source_aliases').all().map(row => [String(row.sourceIP), String(row.label)]));
  }
  setAlias(ip: unknown, label: unknown): void {
    this.guard();
    const address = normalizeIP(ip);
    if (!address || typeof label !== 'string' || label.length > 40 || /[\u0000-\u001f\u007f]/.test(label)) throw new ManagementError('USAGE_ALIAS_INVALID');
    const normalized = label.trim();
    if (!normalized) this.db.prepare('DELETE FROM source_aliases WHERE sourceIP=?').run(address);
    else {
      if (!this.db.prepare('SELECT 1 FROM source_aliases WHERE sourceIP=?').get(address) && Number(this.db.prepare('SELECT count(*) AS n FROM source_aliases').get()?.n) >= 4096) throw new ManagementError('USAGE_ALIAS_LIMIT', 409);
      this.db.prepare('INSERT INTO source_aliases VALUES(?,?) ON CONFLICT(sourceIP) DO UPDATE SET label=excluded.label').run(address, normalized);
    }
  }

  query(input: unknown) {
    this.guard();
    const value = exactRecord(input, ['startTime', 'endTime', 'dimension'], ['filters', 'sort', 'order', 'search', 'page', 'pageSize', 'overview']);
    const { startTime: start, endTime: end, dimension } = value;
    if (!integer(start) || !integer(end) || end <= start || end - start > USAGE_DAILY_RETENTION || !dimensions.includes(dimension as UsageDimension)) throw new ManagementError('USAGE_QUERY_INVALID');
    if (start < Math.floor((this.now() - USAGE_DAILY_RETENTION) / DAY) * DAY) throw new ManagementError('USAGE_RANGE_EXPIRED', 409);
    const page = value.page ?? 0, size = value.pageSize ?? 50, sort = value.sort ?? 'total', order = value.order ?? 'desc', search = value.search ?? '';
    if (!integer(page) || page > 100_000 || !integer(size) || size < 1 || size > 200 || !['label', 'upload', 'download', 'total', 'count'].includes(String(sort)) ||
        !['asc', 'desc'].includes(String(order)) || typeof search !== 'string' || search.length > 160 || (value.overview !== undefined && typeof value.overview !== 'boolean')) throw new ManagementError('USAGE_QUERY_INVALID');
    const filters = value.filters === undefined ? {} : exactRecord(value.filters, [], dimensions);
    if (Object.values(filters).some(item => !text(item))) throw new ManagementError('USAGE_QUERY_INVALID');
    const daily = start < Math.floor((this.now() - USAGE_DETAIL_RETENTION) / MINUTE) * MINUTE;
    if (daily && (dimension !== 'sourceIP' || Object.keys(filters).some(key => key !== 'sourceIP'))) throw new ManagementError('USAGE_DETAIL_EXPIRED', 409);
    const table = daily ? 'daily_usage' : 'minute_usage';
    const interval = daily ? DAY : MINUTE;
    // Buckets overlap the selected interval; UTC storage is independent of the browser timezone.
    const where = ['u.at>=?', 'u.at<?'], params: SQLInputValue[] = [Math.floor(start / interval) * interval, end];
    for (const [key, field] of Object.entries(filters)) { where.push(`u.${key}=?`); params.push(field as string); }
    if (search) { where.push(`(instr(lower(u.${dimension}),lower(?))>0${dimension === 'sourceIP' ? " OR instr(lower(coalesce(a.label,'')),lower(?))>0" : ''})`); params.push(search); if (dimension === 'sourceIP') params.push(search); }
    const base = `FROM ${table} u LEFT JOIN source_aliases a ON a.sourceIP=u.sourceIP WHERE ${where.join(' AND ')}`;
    const group = `SELECT u.${dimension} AS label, sum(u.upload) AS upload, sum(u.download) AS download, sum(u.upload+u.download) AS total, count(*) AS count ${base} GROUP BY u.${dimension}`;
    const totalRows = Number(this.db.prepare(`SELECT count(*) AS n FROM (${group})`).get(...params)?.n);
    const rows = this.db.prepare(`${group} ORDER BY ${sort} ${order},label ASC LIMIT ? OFFSET ?`).all(...params, size as number, (page as number) * (size as number)).map(row => ({ ...row, kind: dimension }));
    const result = { rows, totalRows, page, pageSize: size, resolution: daily ? 'day' : 'minute', aliases: this.aliases(), status: this.status() };
    if (!value.overview) return result;
    const summary = this.db.prepare(`SELECT coalesce(sum(u.upload),0) AS upload, coalesce(sum(u.download),0) AS download, coalesce(sum(CASE WHEN u.sourceIP='Unattributed' THEN u.upload+u.download ELSE 0 END),0) AS unattributed, count(DISTINCT CASE WHEN u.sourceIP NOT IN ('Unattributed','Inner') THEN u.sourceIP END) AS sources ${base}`).get(...params);
    const span = end - start, bucket = daily || span > 7 * DAY ? DAY : span > DAY ? 3_600_000 : span > 3_600_000 ? 300_000 : MINUTE;
    const found = this.db.prepare(`SELECT (u.at / ${bucket}) * ${bucket} AS timestamp, sum(u.upload) AS upload, sum(u.download) AS download ${base} GROUP BY timestamp ORDER BY timestamp`).all(...params);
    const points = new Map(found.map(row => [Number(row.timestamp), row]));
    const trend = [];
    for (let at = Math.floor(start / bucket) * bucket; at < end; at += bucket) trend.push(points.get(at) ?? { timestamp: at, upload: 0, download: 0 });
    const gapCount = Number(this.db.prepare('SELECT count(*) AS n FROM gaps WHERE end>=? AND start<?').get(start, end)?.n);
    return { ...result, summary, trend, gapCount };
  }

  close(): void {
    if (this.closed) return;
    try { if (!this.failed) this.flush(); }
    finally { this.closed = true; this.db.close(); }
  }
}

/** Starts only with the existing lifecycle; no listener, browser session or second core supervisor. */
export function createUsageService(options: { directory: string; sample: () => Promise<UsageSnapshot>; now?: () => number; intervalMs?: number;
  observe?: (snapshot: UsageSnapshot) => void }) {
  let store: UsageStore | undefined, opening: Promise<UsageStore> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined, pending: Promise<void> | undefined;
  let stopped = true, unavailable = false, sampleError = false;
  const get = async () => {
    if (unavailable) fail();
    if (store) return store;
    opening ??= UsageStore.open(options.directory, options.now).then(value => store = value).catch(() => { unavailable = true; return fail(); });
    return opening;
  };
  const tick = async () => {
    try { const current = await get(); const sample = await options.sample(); current.ingest(sample); options.observe?.(sample); sampleError = false; }
    catch { sampleError = true; try { store?.flush(); } catch { /* status exposes the persistent failure */ } }
    finally { if (!stopped) { timer = setTimeout(() => { pending = tick(); }, options.intervalMs ?? 1000); timer.unref(); } }
  };
  return {
    start() { if (!stopped) return; stopped = false; pending = tick(); },
    async close() { stopped = true; clearTimeout(timer); await pending; if (opening) await opening.catch(() => {}); store?.close(); },
    async fetch(request: Request) {
      try {
        const current = await get(), path = new URL(request.url).pathname;
        if (path === '/api/cocoproxy/usage/status' && request.method === 'GET') return { ...current.status(), collecting: !stopped, sampleError };
        if (path === '/api/cocoproxy/usage/query' && request.method === 'POST') return { ...current.query(await readJsonBody(request, 4096)), sampleError, collecting: !stopped };
        if (path === '/api/cocoproxy/usage/alias' && request.method === 'PUT') {
          const { sourceIP, label } = exactRecord(await readJsonBody(request, 1024), ['sourceIP', 'label']);
          current.setAlias(sourceIP, label); return { aliases: current.aliases() };
        }
        throw new ManagementError('NOT_FOUND', 404);
      } catch (error) { if (error instanceof ManagementError) throw error; fail(); }
    },
  };
}

/** Read-only, complete integrity check for stopped deployment and preservation checks. */
export async function inspectUsageDatabase(directory: string, owner = process.geteuid?.()) {
  let present: boolean;
  try { present = await inspectUsageFiles(directory, owner); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  if (!present) return null;
  const path = join(directory, USAGE_DATABASE);
  let wal = false;
  for (const suffix of ['-wal', '-journal']) {
    try {
      const info = await lstat(path + suffix);
      if (suffix === '-journal' && info.size > 0) fail();
      if (suffix === '-wal') wal = info.size > 0;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  // Immutable reads avoid creating sidecars in a stopped store. A live WAL must
  // already have its shared-memory index; an inspection never creates one as root.
  if (wal) { try { await lstat(path + '-shm'); } catch { fail(); } }
  const db = new DatabaseSync(wal ? path : pathToFileURL(path).href + '?immutable=1', { readOnly: true });
  try {
    validateDatabase(db);
    const metadata = db.prepare("SELECT value FROM metadata WHERE key='checkpoint'").get()?.value;
    if (typeof metadata === 'string') parseCheckpoint(metadata);
    const detail = db.prepare('SELECT count(*) AS detailRows, coalesce(sum(upload),0) AS upload, coalesce(sum(download),0) AS download FROM minute_usage').get()!;
    const daily = db.prepare('SELECT count(*) AS dailyRows, coalesce(sum(upload),0) AS dailyUpload, coalesce(sum(download),0) AS dailyDownload FROM daily_usage').get()!;
    const identity = db.prepare("SELECT value FROM metadata WHERE key='identity'").get()?.value;
    if (typeof identity !== 'string' || !/^[a-f0-9-]{36}$/.test(identity)) fail();
    const aliasDigest = createHash('sha256').update(JSON.stringify(db.prepare('SELECT sourceIP,label FROM source_aliases ORDER BY sourceIP').all())).digest('hex');
    return { schemaVersion: USAGE_SCHEMA, integrity: 'ok' as const, identity: createHash('sha256').update(identity).digest('hex'), aliasDigest,
      detailRows: Number(detail.detailRows), upload: Number(detail.upload), download: Number(detail.download),
      dailyRows: Number(daily.dailyRows), dailyUpload: Number(daily.dailyUpload), dailyDownload: Number(daily.dailyDownload),
      aliases: Number(db.prepare('SELECT count(*) AS n FROM source_aliases').get()?.n) };
  } finally { db.close(); }
}
