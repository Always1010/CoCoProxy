import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
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
  f.advance(USAGE_DAILY_RETENTION);
  assert.throws(() => f.store.query(query(start - 60_000, start + 60_000)), { code: 'USAGE_RANGE_EXPIRED' });
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
