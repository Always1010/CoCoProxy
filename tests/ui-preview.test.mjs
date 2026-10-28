import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { WebSocket } from 'ws';
import { createFixtures } from '../scripts/ui-preview/fixtures.mjs';
import { createPreviewServer } from '../scripts/ui-preview/server.mjs';
import { createUiSync, parseOptions } from '../scripts/dev-ui.mjs';

test('preview selection uses real revision receipts and scenario reset discards mutations', () => {
  const fixtures = createFixtures();
  const before = fixtures.respond('GET', '/api/cocoproxy/workspace').data;
  const body = { group: 'Proxy', name: before.nodes[1], expectedRevision: before.workspace.revision, expectedActive: before.active };
  const result = fixtures.respond('POST', '/api/cocoproxy/workspace/select', body);
  assert.equal(result.status, 200);
  assert.equal(result.data.view.groups[0].activeSelected, body.name);
  assert.equal(result.data.view.workspace.revision, body.expectedRevision + 1);
  assert.notEqual(result.data.active, before.active);
  assert.equal(fixtures.respond('POST', '/api/cocoproxy/workspace/select', body).status, 409);
  fixtures.respond('POST', '/api/__preview/scenario', { scenario: 'normal' });
  assert.deepEqual(fixtures.respond('GET', '/api/cocoproxy/workspace').data.workspace, before.workspace);
  assert.equal(fixtures.respond('POST', '/api/cocoproxy/unimplemented', {}).status, 501);
});

test('empty/error/timeout scenarios preserve authentication and expose the intended UI state', () => {
  for (const scenario of ['empty', 'error', 'timeout']) {
    const fixtures = createFixtures(scenario);
    assert.equal(fixtures.respond('GET', '/api/session').data.authenticated, true);
    if (scenario === 'empty') assert.equal(fixtures.respond('GET', '/api/cocoproxy/workspace').data.nodes.length, 0);
    if (scenario === 'error') assert.equal(fixtures.respond('GET', '/api/cocoproxy/workspace').status, 503);
    if (scenario === 'timeout') assert.equal(fixtures.respond('GET', '/api/clash/proxies/sample/delay').data.error.code, 'CONTROLLER_PROBE_TIMEOUT');
  }
});

test('preview HTTP/WS serve synthetic data and reject foreign origins and unknown operations', async t => {
  const preview = createPreviewServer();
  const pageOrigin = 'http://127.0.0.1:3000';
  const origin = await preview.listen(pageOrigin);
  const streamOrigin = origin.replace('http:', 'ws:');
  t.after(async () => { await preview.close(); });
  const session = await fetch(origin + '/api/session', { headers: { Origin: pageOrigin } });
  assert.equal(session.headers.get('X-CoCoProxy-UI-Preview'), 'synthetic');
  assert.equal(session.headers.get('Access-Control-Allow-Origin'), pageOrigin);
  assert.equal((await session.json()).authenticated, true);
  assert.equal((await fetch(origin + '/api/cocoproxy/workspace', { method: 'OPTIONS', headers: {
    Origin: pageOrigin, 'Access-Control-Request-Method': 'PUT', 'Access-Control-Request-Headers': 'content-type,if-match',
  } })).status, 204);
  assert.equal((await fetch(origin + '/api/__preview/scenario', { method: 'POST', headers: { Origin: 'https://foreign.example', 'Content-Type': 'application/json' }, body: '{"scenario":"empty"}' })).status, 403);
  assert.equal((await fetch(origin + '/api/cocoproxy/apply', { method: 'POST', body: '{}' })).status, 501);
  await assert.rejects(fetch(origin + '/api/cocoproxy/workspace/tcp-delay', {
    method: 'POST', body: '{}', signal: AbortSignal.timeout(20),
  }));
  assert.equal((await fetch(origin + '/api/session')).status, 200);
  const ws = new WebSocket(streamOrigin + '/api/clash/traffic', { origin: pageOrigin });
  const sample = await new Promise((accept, reject) => { ws.once('message', data => accept(JSON.parse(data))); ws.once('error', reject); });
  assert.equal(typeof sample.down, 'number');
  ws.close();
  const rejected = new WebSocket(streamOrigin + '/api/clash/traffic', { origin: 'https://foreign.example' });
  await new Promise(accept => rejected.once('error', accept));
});

test('UI sync updates, adds, and restores overrides while leaving unrelated development files alone', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ui-preview-'));
  try {
    const overlay = join(root, 'overlay'), destination = join(root, 'ui');
    await mkdir(overlay); await mkdir(destination);
    const original = Buffer.from('upstream');
    await writeFile(join(overlay, 'page.vue'), 'first'); await writeFile(join(destination, 'page.vue'), 'first');
    await writeFile(join(destination, 'unrelated.vue'), 'keep');
    const sync = createUiSync(overlay, destination, new Map([['page.vue', original]]), new Map([['page.vue', Buffer.from('first')]]));
    await writeFile(join(overlay, 'page.vue'), 'edited'); await writeFile(join(overlay, 'new.vue'), 'new');
    assert.equal(await sync(), 2);
    assert.equal(await readFile(join(destination, 'page.vue'), 'utf8'), 'edited');
    await rm(join(overlay, 'page.vue')); await rm(join(overlay, 'new.vue'));
    assert.equal(await sync(), 2);
    assert.equal(await readFile(join(destination, 'page.vue'), 'utf8'), 'upstream');
    await assert.rejects(readFile(join(destination, 'new.vue')), { code: 'ENOENT' });
    assert.equal(await readFile(join(destination, 'unrelated.vue'), 'utf8'), 'keep');
  } finally { await rm(root, { recursive: true, force: true }); }
  assert.throws(() => parseOptions(['--port', '80']));
  assert.throws(() => parseOptions(['--dependencies', 'relative']));
});
