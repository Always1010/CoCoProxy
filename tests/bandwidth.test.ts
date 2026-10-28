import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setImmediate as nextTurn } from 'node:timers/promises';
import test from 'node:test';
import { createBandwidthService, type BandwidthTarget } from '../packages/management/bandwidth.ts';
import type { runBandwidthTransfer } from '../packages/management/bandwidth-transport.ts';
import { createAdminCredential } from '../packages/management/auth.ts';
import { createManagementGateway, type Principal } from '../packages/management/http.ts';

const origin = 'https://management.example';
const generation = 'a'.repeat(64);
const clientA = randomUUID(), clientB = randomUUID();
const principal: Principal = { username: 'synthetic-admin', expiresAt: Date.now() + 60_000 };
const target: BandwidthTarget = { config: { proxies: [{ name: 'node-b', type: 'socks5', server: '192.0.2.2', port: 1080, password: 'synthetic-private-secret' }] },
  binaryPath: '/synthetic/core', stateDirectory: '/synthetic/state' };
function request(method = 'GET', body?: unknown, client = clientA, cookie = 'synthetic-session=a', path = '/api/cocoproxy/bandwidth') {
  return new Request(origin + path, { method, headers: { origin, cookie, 'x-cocoproxy-bandwidth-client': client,
    ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
const success = { status: 'success' as const, mbps: 123, liveMbps: null, bytes: 1_000_000 };

test('bandwidth task reserves globally before snapshot awaits and binds cancellation to the authenticated browser', async t => {
  const snapshot = deferred(), entered = deferred(), cleanup = deferred();
  let aborted = false;
  const service = createBandwidthService({ snapshot: async (node, active) => { assert.equal(node, 'node-b'); assert.equal(active, generation); await snapshot.promise; return target; },
    isCurrent: async () => true, transfer: async input => {
      entered.resolve();
      await new Promise<void>(resolve => input.signal.addEventListener('abort', () => { aborted = true; resolve(); }, { once: true }));
      await cleanup.promise;
      throw new Error('BANDWIDTH_CANCELLED');
    } });
  t.after(() => service.close());
  const first = await service.fetch(request('POST', { node: 'node-b', expectedActive: generation }), principal);
  assert.equal(first.task?.phase, 'preparing'); assert.equal(first.task?.owned, true);
  await assert.rejects(service.fetch(request('POST', { node: 'node-b', expectedActive: generation }, clientB), principal), { code: 'BANDWIDTH_BUSY' });
  const observer = await service.fetch(request('GET', undefined, clientB), principal);
  assert.equal(observer.task?.owned, false);
  // Knowing the other tab id is insufficient when its authenticated browser differs.
  await assert.rejects(service.fetch(request('POST', { id: first.task!.id }, clientA, 'synthetic-session=b', '/api/cocoproxy/bandwidth/cancel'), principal), { code: 'BANDWIDTH_NOT_OWNER' });
  snapshot.resolve(); await entered.promise;
  const cancelling = await service.fetch(request('POST', { id: first.task!.id }, clientA, undefined, '/api/cocoproxy/bandwidth/cancel'), principal);
  assert.equal(cancelling.task?.phase, 'cancelling'); assert.equal(cancelling.task?.running, true); assert.equal(aborted, true);
  await assert.rejects(service.fetch(request('POST', { node: 'node-b', expectedActive: generation }), principal), { code: 'BANDWIDTH_BUSY' });
  cleanup.resolve(); await nextTurn();
  const done = await service.fetch(request(), principal);
  assert.equal(done.task?.phase, 'cancelled'); assert.equal(done.task?.running, false);
  assert.equal(done.task?.download.mbps, null); assert.equal(done.task?.download.status, 'cancelled');
  assert(!JSON.stringify(done).includes('synthetic-private-secret'));
  assert(!JSON.stringify(done).includes('synthetic-session'));
});

test('bandwidth task preserves valid partial measurements and never reports pending or failed upload as zero', async t => {
  const transfer: typeof runBandwidthTransfer = async input => {
    input.report({ phase: 'download', download: success, bytesUsed: 1_000_000, latency: { idle: 42, download: 70, upload: null } });
    input.report({ phase: 'upload', upload: { status: 'running', mbps: null, liveMbps: 7, bytes: 1024 } });
    throw Object.assign(new Error('private remote detail'), { code: 'BANDWIDTH_UPLOAD_FAILED' });
  };
  const service = createBandwidthService({ snapshot: async () => target, isCurrent: async () => true, transfer });
  t.after(() => service.close());
  await service.fetch(request('POST', { node: 'node-b', expectedActive: generation }), principal); await nextTurn();
  const result = (await service.fetch(request(), principal)).task!;
  assert.equal(result.phase, 'partial'); assert.equal(result.download.mbps, 123);
  assert.equal(result.upload.status, 'failed'); assert.equal(result.upload.mbps, null); assert.equal(result.upload.liveMbps, null);
  assert.equal(result.reason, 'BANDWIDTH_UPLOAD_FAILED'); assert.equal(result.latency.idle, 42);
});

test('configuration changes invalidate a finished measurement and explicit probe opt-out prevents task creation', async t => {
  const service = createBandwidthService({ snapshot: async () => target, isCurrent: async () => false,
    transfer: async input => { input.report({ download: success, upload: success }); return { reason: null }; } });
  t.after(() => service.close());
  await service.fetch(request('POST', { node: 'node-b', expectedActive: generation }), principal); await nextTurn();
  const result = (await service.fetch(request(), principal)).task!;
  assert.equal(result.phase, 'failed'); assert.equal(result.reason, 'ACTIVE_CONFLICT');
  const disabled = createBandwidthService({ snapshot: async () => { throw new Error('must not start'); }, isCurrent: async () => true, enabled: false });
  t.after(() => disabled.close());
  assert.equal((await disabled.fetch(request(), principal)).available, false);
  await assert.rejects(disabled.fetch(request('POST', { node: 'node-b', expectedActive: generation }), principal), { code: 'BANDWIDTH_DISABLED' });
  assert.equal((await disabled.fetch(request(), principal)).task, null);
});

test('bandwidth routes use management authentication and exact Origin protection, without accepting endpoints from browsers', async t => {
  const service = createBandwidthService({ snapshot: async () => target, isCurrent: async () => true,
    transfer: async input => { input.report({ download: success, upload: success }); return { reason: null }; } });
  t.after(() => service.close());
  const password = 'synthetic-bandwidth-test-password';
  const credential = await createAdminCredential({ username: principal.username, password });
  const gateway = createManagementGateway({ origin, credential }, (input, actor) => service.fetch(input, actor));
  assert.equal((await gateway.fetch(request())).status, 401);
  const login = await gateway.fetch(new Request(origin + '/api/session/login', { method: 'POST', headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ username: principal.username, password }) }));
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie')!.split(';')[0];
  const forbidden = request('POST', { node: 'node-b', expectedActive: generation }, clientA, cookie);
  forbidden.headers.set('origin', 'https://other.example');
  assert.equal((await gateway.fetch(forbidden)).status, 403);
  const arbitrary = await gateway.fetch(request('POST', { node: 'node-b', expectedActive: generation, url: 'https://other.example' }, clientA, cookie));
  assert.equal(arbitrary.status, 400);
  const started = await gateway.fetch(request('POST', { node: 'node-b', expectedActive: generation }, clientA, cookie));
  assert.equal(started.status, 200); assert.equal(started.headers.get('cache-control'), 'no-store');
  await nextTurn();
  const response = await gateway.fetch(request('GET', undefined, clientA, cookie));
  assert.equal((await response.json()).task.phase, 'complete');
});
