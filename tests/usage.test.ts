import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { UsageStore, parseUsageSnapshot, createUsageService, inspectUsageDatabase, USAGE_DETAIL_RETENTION, USAGE_DAILY_RETENTION, USAGE_DATABASE } from '../packages/management/usage.ts';
import { createManagementGateway } from '../packages/management/http.ts';
import { createAdminCredential } from '../packages/management/auth.ts';

const start = 2_000_000_000_000;
const frame = (upload: number, download: number, connections = true, epoch = 'synthetic-boot:1:100') => parseUsageSnapshot({ uploadTotal: upload, downloadTotal: download,
  connections: connections ? [{ id: 'synthetic-connection', upload, download, metadata: { sourceIP: '192.0.2.20', host: 'video.example', process: 'Unknown' }, chains: ['DIRECT'] }] : [] }, epoch);
const query = (startTime = start - 60_000, endTime = start + 60_000, extra = {}) => ({ startTime, endTime, dimension: 'sourceIP', overview: true, ...extra });
async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'cocoproxy-usage-'));
  let clock = start;
  let store = await UsageStore.open(root, () => clock);
  t.after(() => { store.close(); });
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, get store() { return store; }, advance(ms: number) { clock += ms; }, now: () => clock,
    async restart() { store.close(); store = await UsageStore.open(root, () => clock); return store; } };
}

test('usage transaction restores checkpoints, ignores duplicate frames, survives core resets and reconciles unattributed totals', async t => {
  const f = await fixture(t);
  f.store.ingest(frame(100, 1000)); // Baseline only: do not invent pre-collection history.
  f.advance(1000); f.store.ingest(frame(120, 1200));
  f.advance(5000); f.store.ingest(frame(120, 1200));
  assert.equal((f.store.query(query()) as any).summary.download, 200);
  await f.restart();
  f.advance(1000); f.store.ingest(frame(120, 1200));
  f.advance(1000); f.store.ingest(frame(150, 1500, false)); // Closed between snapshots.
  f.store.flush();
  let result = f.store.query(query()) as any;
  assert.equal(result.summary.upload, 50); assert.equal(result.summary.download, 500);
  assert.equal(result.summary.unattributed, 330);
  f.advance(1000); f.store.ingest(frame(10, 100, true, 'synthetic-boot:2:200')); f.store.flush();
  result = f.store.query(query()) as any;
  assert.equal(result.summary.download, 600); assert.equal(result.gapCount, 1);
  assert.equal(result.status.startedAt, start);
  assert.equal((await inspectUsageDatabase(f.root))?.download, 600);
});

test('source aliases remain IP annotations, search and pagination are server-side and queries reject injected identifiers', async t => {
  const f = await fixture(t);
  f.store.ingest(frame(0, 0)); f.advance(1000); f.store.ingest(frame(100, 1000)); f.store.flush();
  f.store.setAlias('192.0.2.20', '客厅设备');
  f.store.setAlias('192.0.2.30', '客厅设备'); // Notes are intentionally not device identities.
  let result = f.store.query(query(undefined, undefined, { search: '客厅', pageSize: 1 })) as any;
  assert.equal(result.totalRows, 1); assert.equal(result.rows[0].label, '192.0.2.20');
  assert.equal(result.summary.download, 1000);
  result = f.store.query(query(undefined, undefined, { page: 1, pageSize: 1 })) as any;
  assert.equal(result.rows.length, 0); assert.equal(result.totalRows, 1);
  for (const extra of [{ dimension: 'host;DROP TABLE metadata' }, { sort: 'total;DROP TABLE metadata' }, { filters: { password: 'bad' } }, { pageSize: 201 }])
    assert.throws(() => f.store.query(query(undefined, undefined, extra)));
  await f.restart(); assert.equal(f.store.aliases()['192.0.2.20'], '客厅设备');
  f.store.setAlias('192.0.2.20', ' '); assert.equal(f.store.aliases()['192.0.2.20'], undefined);
});

test('observed policy paths split identical exits without changing totals, including direct and missing evidence', async t => {
  const f = await fixture(t);
  const sample = (factor: number) => parseUsageSnapshot({ uploadTotal: factor * 10, downloadTotal: factor * 100,
    connections: [
      { id: 'a', upload: factor, download: factor * 10, chains: ['node-a', 'Proxy', 'Work'], rule: 'Domain', rulePayload: 'video.example' },
      { id: 'b', upload: factor * 2, download: factor * 20, chains: ['node-a', 'Proxy', 'Stream'], rule: 'DomainSuffix', rulePayload: 'example' },
      { id: 'c', upload: factor * 3, download: factor * 30, chains: ['DIRECT', 'Domestic'], rule: 'IPCIDR', rulePayload: '192.0.2.0/24' },
      { id: 'd', upload: factor * 4, download: factor * 40, chains: [] },
    ].map(row => ({ ...row, metadata: { host: 'video.example', sourceIP: '192.0.2.20' } })) }, 'synthetic-core');
  f.store.ingest(sample(0)); f.advance(1000); f.store.ingest(sample(1)); f.store.flush();
  const routes = () => f.store.query(query(undefined, undefined, { dimension: 'route', filters: { host: 'video.example' } })) as any;
  const result = routes();
  assert.equal(result.totalRows, 4); assert.equal(result.summary.download, 100);
  const paths = result.rows.filter((row: any) => row.label === 'node-a');
  assert.equal(paths.length, 2); assert.notEqual(paths[0].key, paths[1].key);
  assert.deepEqual(paths.map((row: any) => row.chain).sort(), [['Stream', 'Proxy', 'node-a'], ['Work', 'Proxy', 'node-a']]);
  const direct = result.rows.find((row: any) => row.label === 'DIRECT');
  assert.deepEqual(direct.chain, ['Domestic', 'DIRECT']); assert.equal(direct.rule, 'IPCIDR');
  const unknown = result.rows.find((row: any) => row.label === 'Unknown');
  assert.equal(unknown.recorded, false); assert.equal(unknown.chain, undefined);
  const page = f.store.query(query(undefined, undefined, { dimension: 'route', pageSize: 1, page: 1 })) as any;
  assert.equal(page.rows.length, 1); assert.equal(page.totalRows, 4);
  const exits = f.store.query(query(undefined, undefined, { dimension: 'outbound' })) as any;
  assert.equal(exits.rows.find((row: any) => row.label === 'node-a').download, 30);
  await f.restart(); assert.deepEqual(routes().rows, result.rows);
  f.advance(1000); f.store.ingest(sample(2)); f.store.flush();
  assert.equal(routes().summary.download, 200);
});

test('schema 1 migrates transactionally with old paths unknown, retaining counters, checkpoint, aliases and identity', async t => {
  const f = await fixture(t);
  f.store.ingest(frame(0, 0)); f.advance(1000); f.store.ingest(frame(10, 100)); f.store.flush();
  f.store.setAlias('192.0.2.20', '合成设备'); f.store.close();
  // The exact legacy table contract, without any path column.
  const db = new DatabaseSync(join(f.root, USAGE_DATABASE));
  db.exec(`BEGIN; ALTER TABLE minute_usage RENAME TO new_minute_usage;
    CREATE TABLE minute_usage(at INTEGER NOT NULL, sourceIP TEXT NOT NULL, host TEXT NOT NULL, outbound TEXT NOT NULL, process TEXT NOT NULL, inboundUser TEXT NOT NULL, upload INTEGER NOT NULL, download INTEGER NOT NULL,
      PRIMARY KEY(at,sourceIP,host,outbound,process,inboundUser));
    INSERT INTO minute_usage SELECT at,sourceIP,host,outbound,process,inboundUser,upload,download FROM new_minute_usage;
    DROP TABLE new_minute_usage;
    CREATE INDEX minute_source_time ON minute_usage(sourceIP,at);
    CREATE INDEX minute_host_time ON minute_usage(host,at);
    CREATE INDEX minute_outbound_time ON minute_usage(outbound,at);
    PRAGMA user_version=1; COMMIT;`); db.close();
  const before = (await inspectUsageDatabase(f.root))!;
  assert.equal(before.schemaVersion, 1); // Inspection must not migrate.
  await f.restart();
  const old = f.store.query(query(undefined, undefined, { dimension: 'route' })) as any;
  assert.equal(old.rows[0].recorded, false); assert.equal(old.rows[0].label, 'DIRECT');
  f.advance(1000); f.store.ingest(frame(15, 150)); f.store.flush();
  const after = (await inspectUsageDatabase(f.root))!;
  assert.equal(after.schemaVersion, 2); assert.equal(after.identity, before.identity); assert.equal(after.aliasDigest, before.aliasDigest);
  assert.equal(after.download, 150); assert.equal(after.dailyDownload, 150);
  assert.equal((f.store.query(query()) as any).status.startedAt, start);
  await f.restart(); assert.equal((await inspectUsageDatabase(f.root))!.download, 150);
});

test('expired domain details are unavailable while daily source totals and aliases survive retention', async t => {
  const f = await fixture(t);
  f.store.ingest(frame(0, 0)); f.advance(1000); f.store.ingest(frame(1, 10)); f.store.flush();
  f.store.setAlias('192.0.2.20', '来源备注');
  f.advance(USAGE_DETAIL_RETENTION + 120_000); f.store.ingest(frame(1, 10)); f.store.flush();
  const result = f.store.query(query(start - 60_000, f.now() + 1)) as any;
  assert.equal(result.resolution, 'day'); assert.equal(result.summary.download, 10);
  assert.equal(result.aliases['192.0.2.20'], '来源备注');
  assert.throws(() => f.store.query(query(start - 60_000, f.now() + 1, { dimension: 'host' })), { code: 'USAGE_DETAIL_EXPIRED' });
  assert.equal((await inspectUsageDatabase(f.root))?.detailRows, 0);
  const scope = { mode: 'range', startTime: start - 60_000, endTime: f.now() + 1, filters: { sourceIP: '192.0.2.20' } };
  assert.throws(() => f.store.previewDeletion({ ...scope, filters: { host: 'video.example' } }), { code: 'USAGE_DETAIL_EXPIRED' });
  const preview = f.store.previewDeletion(scope);
  assert.equal(preview.resolution, 'day'); assert.equal(preview.detailRows, 0); assert.equal(preview.download, 10);
  assert.equal(preview.scope.mode, 'range');
  if (preview.scope.mode === 'range') { assert.equal(preview.scope.startTime % 86_400_000, 0); assert.equal(preview.scope.endTime % 86_400_000, 0); }
  f.advance(1000); f.store.ingest(frame(2, 20));
  f.store.confirmDeletion(preview.token);
  assert.equal((f.store.query(query(start - 60_000, f.now() + 1)) as any).summary.download, 10);
  assert.equal((await inspectUsageDatabase(f.root))?.download, 10);
  assert.equal(f.store.aliases()['192.0.2.20'], '来源备注');
  f.advance(USAGE_DAILY_RETENTION);
  assert.throws(() => f.store.query(query(start - 60_000, start + 60_000)), { code: 'USAGE_RANGE_EXPIRED' });
});

test('usage deletion freezes exact scoped counters, keeps newer traffic and checkpoints, and retries without subtracting twice', async t => {
  const f = await fixture(t);
  const sample = (n: number) => parseUsageSnapshot({ uploadTotal: 6 * n, downloadTotal: 60 * n, connections: [
    { id: 'a', upload: n, download: 10 * n, metadata: { sourceIP: '192.0.2.20', host: 'video.example' } },
    { id: 'b', upload: 2 * n, download: 20 * n, metadata: { sourceIP: '192.0.2.20', host: 'keep.example' } },
    { id: 'c', upload: 3 * n, download: 30 * n, metadata: { sourceIP: '192.0.2.30', host: 'video.example' } },
  ] }, 'same-core');
  f.store.ingest(sample(0)); f.advance(1000); f.store.ingest(sample(1));
  f.store.setAlias('192.0.2.20', '保留备注');
  const scope = { mode: 'range', startTime: start - 60_000, endTime: f.now(), filters: { sourceIP: '192.0.2.20' }, selection: { dimension: 'host', values: ['video.example'] } };
  const preview = f.store.previewDeletion(scope);
  assert.equal(preview.download, 10); assert.equal(preview.detailRows, 1); assert.equal(preview.dailyRows, 1);
  f.advance(1000); f.store.ingest(sample(2)); // Same minute row changes after the preview.
  assert.equal(f.store.confirmDeletion(preview.token).download, 10);
  let info = (await inspectUsageDatabase(f.root))!;
  assert.equal(info.download, 110); assert.equal(info.dailyDownload, 110);
  assert.equal((f.store.query(query(undefined, undefined, { dimension: 'host', filters: { sourceIP: '192.0.2.30' } })) as any).summary.download, 60);
  f.advance(1000); f.store.ingest(sample(3));
  f.store.confirmDeletion(preview.token); f.store.flush();
  assert.equal((f.store.query(query()) as any).summary.download, 170);
  await f.restart(); f.advance(1000); f.store.ingest(sample(4)); f.store.flush();
  assert.equal((f.store.query(query()) as any).summary.download, 230);
  assert.equal(f.store.aliases()['192.0.2.20'], '保留备注');
  const replaced = f.store.previewDeletion(scope);
  const clear = f.store.previewDeletion({ mode: 'all' });
  assert.throws(() => f.store.confirmDeletion(replaced.token), { code: 'USAGE_DELETE_STALE' });
  f.advance(1000); f.store.ingest(sample(5));
  f.store.confirmDeletion(clear.token);
  info = (await inspectUsageDatabase(f.root))!;
  assert.equal(info.download, 60); assert.equal(info.dailyDownload, 60);
  const expired = f.store.previewDeletion(scope); f.advance(300_001);
  assert.throws(() => f.store.confirmDeletion(expired.token), { code: 'USAGE_DELETE_STALE' });
  const year = f.store.previewDeletion({ mode: 'range', startTime: Math.floor((f.now() - USAGE_DAILY_RETENTION) / 60_000) * 60_000, endTime: Math.ceil(f.now() / 60_000) * 60_000 });
  assert.equal(year.resolution, 'day'); assert.equal(year.download, 60);
  for (const invalid of [{ ...scope, selection: { dimension: 'host);DELETE FROM metadata', values: ['x'] } }, { ...scope, selection: { dimension: 'host', values: [] } }, { mode: 'all', filters: {} }]) assert.throws(() => f.store.previewDeletion(invalid));
});

test('usage deletion preserves expired parts of a daily bucket and rolls back both tables on failure', async t => {
  const f = await fixture(t);
  f.store.ingest(frame(0, 0)); f.advance(1000); f.store.ingest(frame(1, 10)); f.store.flush();
  f.advance(120_000); f.store.ingest(frame(3, 30)); f.store.flush();
  // The first detail expires within the same UTC day; its daily contribution remains.
  f.advance(USAGE_DETAIL_RETENTION - 60_000); f.store.ingest(frame(3, 30)); f.store.flush();
  const preview = f.store.previewDeletion({ mode: 'range', startTime: start + 100_000, endTime: start + 180_000, filters: { host: 'video.example' } });
  assert.equal(preview.download, 20);
  const db = new DatabaseSync(join(f.root, USAGE_DATABASE));
  try {
    db.exec("CREATE TRIGGER block_deletion BEFORE UPDATE ON daily_usage WHEN new.download < old.download BEGIN SELECT RAISE(ABORT, 'synthetic deletion failure'); END;");
    assert.throws(() => f.store.confirmDeletion(preview.token));
    const unchanged = (await inspectUsageDatabase(f.root))!;
    assert.equal(unchanged.download, 20); assert.equal(unchanged.dailyDownload, 30);
    db.exec('DROP TRIGGER block_deletion');
  } finally { db.close(); }
  f.store.confirmDeletion(preview.token);
  const info = (await inspectUsageDatabase(f.root))!;
  assert.equal(info.detailRows, 0); assert.equal(info.dailyDownload, 10);
  const stale = f.store.previewDeletion({ mode: 'all' });
  f.advance(USAGE_DAILY_RETENTION); f.store.ingest(frame(3, 30));
  assert.throws(() => f.store.confirmDeletion(stale.token), { code: 'USAGE_DELETE_STALE' });
});

test('background service collects without browser sessions, drains shutdown and retains the authentication/Origin boundary', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cocoproxy-collector-'));
  const service = createUsageService({ directory: root, intervalMs: 10, sample: async () => frame(0, 0) });
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => service.close());
  service.start();
  const credential = await createAdminCredential({ username: 'synthetic-admin', password: 'synthetic-usage-password' });
  const origin = 'https://management.example';
  const gateway = createManagementGateway({ origin, credential }, request => service.fetch(request));
  assert.equal((await gateway.fetch(new Request(origin + '/api/cocoproxy/usage/status'))).status, 401);
  const login = await gateway.fetch(new Request(origin + '/api/session/login', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ username: credential.username, password: 'synthetic-usage-password' }) }));
  const cookie = login.headers.getSetCookie()[0].split(';')[0];
  const status = await gateway.fetch(new Request(origin + '/api/cocoproxy/usage/status', { headers: { cookie } }));
  assert.equal((await status.json()).collecting, true);
  assert.equal((await gateway.fetch(new Request(origin + '/api/cocoproxy/usage/alias', { method: 'PUT', headers: { cookie, origin: 'https://other.example', 'content-type': 'application/json' }, body: '{}' }))).status, 403);
  for (const action of ['preview', 'confirm']) {
    const url = origin + '/api/cocoproxy/usage/deletion/' + action;
    assert.equal((await gateway.fetch(new Request(url, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: '{}' }))).status, 401);
    assert.equal((await gateway.fetch(new Request(url, { method: 'POST', headers: { cookie, origin: 'https://other.example', 'content-type': 'application/json' }, body: '{}' }))).status, 403);
  }
  const preview = await gateway.fetch(new Request(origin + '/api/cocoproxy/usage/deletion/preview', { method: 'POST', headers: { cookie, origin, 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'all' }) }));
  assert.equal(preview.status, 200);
  const { token } = await preview.json();
  assert.equal((await gateway.fetch(new Request(origin + '/api/cocoproxy/usage/deletion/confirm', { method: 'POST', headers: { cookie, origin, 'content-type': 'application/json' }, body: JSON.stringify({ token }) }))).status, 200);
  await service.close();
  assert.ok((await inspectUsageDatabase(root))?.schemaVersion);
});

test('corrupt or linked databases are preserved and fail closed rather than being recreated', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cocoproxy-corrupt-usage-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, USAGE_DATABASE);
  await writeFile(path, 'synthetic corruption', { mode: 0o600 });
  await assert.rejects(UsageStore.open(root));
  await assert.rejects(inspectUsageDatabase(root));
  if (process.platform !== 'win32') {
    await rm(path); const target = join(root, 'synthetic.sqlite'); await writeFile(target, 'synthetic corruption', { mode: 0o600 });
    await symlink(target, path); await assert.rejects(UsageStore.open(root));
  }
});

test('an interrupted process recovers only committed counters and replays the remaining delta once', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cocoproxy-usage-interrupted-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const module = new URL('../packages/management/usage.ts', import.meta.url).href;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { UsageStore, parseUsageSnapshot } from ${JSON.stringify(module)};
    let now=${start}; const store=await UsageStore.open(process.argv[1],()=>now);
    const sample=n=>parseUsageSnapshot({uploadTotal:0,downloadTotal:n,connections:[]},'same-physical-core');
    store.ingest(sample(0)); now+=5000; store.ingest(sample(100));
    now+=1000; store.ingest(sample(150)); process.exit(0);
  `, root], { encoding: 'utf8', windowsHide: true, timeout: 10_000 });
  assert.equal(child.status, 0, child.stderr);
  let now = start + 7000;
  const store = await UsageStore.open(root, () => now);
  try {
    const sample = parseUsageSnapshot({ uploadTotal: 0, downloadTotal: 175, connections: [] }, 'same-physical-core');
    store.ingest(sample); now += 5000; store.ingest(sample); store.flush();
    const result = store.query(query()) as any;
    assert.equal(result.summary.download, 175); assert.equal(result.summary.unattributed, 175);
  } finally { store.close(); }
});
