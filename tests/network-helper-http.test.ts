import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { request } from 'node:http';
import { connect } from 'node:net';
import test from 'node:test';
import { serveGatewayHelper, serveGatewayHelperFixture, type GatewayHelperHandler } from '../packages/network/helper-http.ts';

const token = 'a'.repeat(64);
const tokenSha256 = createHash('sha256').update(token).digest('hex');
const generation = 'b'.repeat(64);
function handler(overrides: Partial<GatewayHelperHandler> = {}): GatewayHelperHandler {
  return { async status() { return { scope: 'synthetic' }; }, async stage() { return { generation }; },
    async apply() { return { revision: 1 }; }, async recover() { return { recovered: true }; }, ...overrides };
}
function call(port: number, path = '/v1/status', method = 'GET', raw?: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; body: string; headers: import('node:http').IncomingHttpHeaders }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, agent: false,
      headers: { authorization: `Bearer ${token}`, ...(raw === undefined ? {} : { 'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(raw)) }), ...headers } }, res => {
      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode!, body: Buffer.concat(chunks).toString(), headers: res.headers }));
    });
    req.on('error', reject); req.end(raw);
  });
}
function rawCall(port: number, lines: string, payload: string | Buffer = ''): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1');
    let response = '';
    socket.setTimeout(6000, () => { socket.destroy(); reject(new Error('FIXTURE_TIMEOUT')); });
    socket.on('connect', () => { socket.write(`${lines}\r\n\r\n`); socket.write(payload); });
    socket.on('data', chunk => { response += chunk.toString(); });
    socket.on('end', () => resolve(response)); socket.on('error', reject);
  });
}
const authLines = (port: number, path = '/v1/status', method = 'GET') =>
  `${method} ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAuthorization: Bearer ${token}`;

test('helper binds IPv4 loopback, dispatches precise payloads and leaves scope to backend', async t => {
  const calls: unknown[] = [];
  const server = await serveGatewayHelperFixture({ port: 0, tokenSha256 }, handler({
    async stage(policy, sources) { calls.push({ policy, sources }); return { generation, scope: 'synthetic' }; },
    async apply(value, revision) { calls.push({ value, revision }); return { revision: revision + 1 }; },
  }));
  t.after(() => server.close());
  const status = await call(server.port);
  assert.equal(status.status, 200); assert.deepEqual(JSON.parse(status.body), { scope: 'synthetic' });
  assert.equal(status.headers['cache-control'], 'no-store'); assert.equal(status.headers['access-control-allow-origin'], undefined);
  assert.equal((await call(server.port, '/v1/candidates', 'POST', '{"policy":{},"sources":[]}')).status, 200);
  assert.equal((await call(server.port, '/v1/apply', 'POST', JSON.stringify({ generation, expectedRevision: 0 }))).status, 200);
  assert.equal((await call(server.port, '/v1/recover', 'POST', '{}')).status, 200);
  assert.deepEqual(calls, [{ policy: {}, sources: [] }, { value: generation, revision: 0 }]);
  for (const port of [0, 80, 65536, NaN]) await assert.rejects(serveGatewayHelper({ port, tokenSha256 }, handler()), /NETWORK_HELPER_CONFIG_INVALID/);
  await assert.rejects(serveGatewayHelperFixture({ port: 0, tokenSha256: tokenSha256.toUpperCase() }, handler()), /NETWORK_HELPER_CONFIG_INVALID/);
});

test('helper authenticates exact authority and excludes browser and ambiguous headers', async t => {
  let entered = 0;
  const server = await serveGatewayHelperFixture({ port: 0, tokenSha256 }, handler({ async status() { entered++; return {}; } }));
  t.after(() => server.close());
  const authCases: Record<string, string>[] = [{ authorization: '' }, { authorization: `Bearer ${'c'.repeat(64)}` }, { authorization: `bearer ${token}` }];
  for (const headers of authCases) {
    assert.equal((await call(server.port, '/v1/status', 'GET', undefined, headers)).status, 401);
  }
  const authorityCases: Record<string, string>[] = [{ host: `localhost:${server.port}` }, { host: `127.0.0.1:${server.port + 1}` },
    { origin: 'null' }, { referer: 'https://example.invalid/' }, { 'sec-fetch-site': 'none' }];
  for (const headers of authorityCases) {
    assert.ok([400, 403].includes((await call(server.port, '/v1/status', 'GET', undefined, headers)).status));
  }
  for (const extra of [`Authorization: Bearer ${token}`, `Host: 127.0.0.1:${server.port}`, 'Transfer-Encoding: chunked', 'Content-Encoding: identity']) {
    assert.match(await rawCall(server.port, `${authLines(server.port)}\r\n${extra}`), /^HTTP\/1.1 400/);
  }
  assert.equal(entered, 0);
});

test('helper rejects route variants, duplicate JSON keys and noncanonical or excessive request bodies', async t => {
  let entered = 0;
  const server = await serveGatewayHelperFixture({ port: 0, tokenSha256 }, handler({ async stage() { entered++; return {}; } }));
  t.after(() => server.close());
  for (const path of ['/v1/status?x=1', '/v1/status/', '/v1/%73tatus', `http://127.0.0.1:${server.port}/v1/status`]) {
    assert.equal((await call(server.port, path)).status, 404);
  }
  assert.equal((await call(server.port, '/v1/status', 'DELETE')).status, 404);
  for (const value of ['{ "policy":{}}', '{"policy":{},"policy":{}}', '{"policy":{},"deployment":{}}', '[]', '{"policy":', '{"policy":{},"network":{}}']) {
    assert.equal((await call(server.port, '/v1/candidates', 'POST', value)).status, 400);
  }
  for (const value of [{ generation, expectedRevision: -1 }, { generation, expectedRevision: 0.5 },
    { generation: generation.toUpperCase(), expectedRevision: 0 }, { generation, expectedRevision: 0, extra: true }]) {
    assert.equal((await call(server.port, '/v1/apply', 'POST', JSON.stringify(value))).status, 400);
  }
  assert.equal((await call(server.port, '/v1/recover', 'POST', '{"extra":1}')).status, 400);
  assert.equal((await call(server.port, '/v1/candidates', 'POST', '{"policy":{}}', { 'content-type': 'application/json; charset=utf-8' })).status, 400);
  assert.match(await rawCall(server.port, `${authLines(server.port, '/v1/candidates', 'POST')}\r\nContent-Type: application/json\r\nContent-Length: 1048577`), /^HTTP\/1.1 413/);
  assert.match(await rawCall(server.port, `${authLines(server.port, '/v1/candidates', 'POST')}\r\nContent-Type: application/json`), /^HTTP\/1.1 411/);
  for (const bytes of [Buffer.from('\uFEFF{"policy":{}}'), Buffer.concat([Buffer.from('{"policy":"'), Buffer.from([0xff]), Buffer.from('"}')])]) {
    assert.match(await rawCall(server.port, `${authLines(server.port, '/v1/candidates', 'POST')}\r\nContent-Type: application/json\r\nContent-Length: ${bytes.length}`, bytes), /^HTTP\/1.1 400/);
  }
  assert.equal(entered, 0);
});

test('helper uses a fixed body deadline without entering backend', { timeout: 8000 }, async t => {
  let entered = false;
  const server = await serveGatewayHelperFixture({ port: 0, tokenSha256 }, handler({ async recover() { entered = true; return {}; } }));
  t.after(() => server.close());
  const start = Date.now();
  const response = await rawCall(server.port, `${authLines(server.port, '/v1/recover', 'POST')}\r\nContent-Type: application/json\r\nContent-Length: 2`, '{');
  assert.match(response, /^HTTP\/1.1 408/); assert.match(response, /NETWORK_HELPER_REQUEST_TIMEOUT/);
  assert.ok(Date.now() - start >= 2800); assert.equal(entered, false);
});

test('helper bounds inflight requests and close waits for accepted backend transactions', { timeout: 5000 }, async t => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let ready!: () => void;
  const started = new Promise<void>(resolve => { ready = resolve; });
  let entered = 0;
  const server = await serveGatewayHelperFixture({ port: 0, tokenSha256 }, handler({ async status() {
    if (++entered === 8) ready(); await gate; return { completed: true };
  } }));
  t.after(async () => { release(); await server.close(); });
  const requests = Array.from({ length: 8 }, () => call(server.port));
  await started;
  const excess = await call(server.port);
  assert.equal(excess.status, 503); assert.match(excess.body, /NETWORK_HELPER_OVERLOADED/);
  let closed = false;
  const closing = server.close().then(() => { closed = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(closed, false);
  release();
  assert.ok((await Promise.all(requests)).every(response => response.status === 200));
  await closing; assert.equal(closed, true);
});

test('helper continues accepted apply after client disconnect and redacts backend exceptions', async t => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let ready!: () => void;
  const started = new Promise<void>(resolve => { ready = resolve; });
  let completed = false;
  const server = await serveGatewayHelperFixture({ port: 0, tokenSha256 }, handler({ async apply() {
    ready(); await gate; completed = true; return { completed };
  }, async status() { throw Object.assign(new Error(`private-${token}`), { code: 'UNKNOWN_PRIVATE_CODE' }); } }));
  t.after(async () => { release(); await server.close(); });
  const response = await call(server.port);
  assert.equal(response.status, 500); assert.deepEqual(JSON.parse(response.body), { error: { code: 'NETWORK_HELPER_FAILED' } });
  const payload = JSON.stringify({ generation, expectedRevision: 0 });
  const req = request({ host: '127.0.0.1', port: server.port, path: '/v1/apply', method: 'POST', headers: {
    authorization: `Bearer ${token}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload),
  } });
  req.on('error', () => {}); req.end(payload); await started; req.destroy();
  const closing = server.close();
  release(); await closing; assert.equal(completed, true);
});

test('helper exposes only allowlisted errors and bounded data-only JSON responses', async t => {
  let mode = 0;
  let getterRead = false;
  const server = await serveGatewayHelperFixture({ port: 0, tokenSha256 }, handler({ async status() {
    if (mode === 0) throw Object.assign(new Error('private details'), { code: 'NETWORK_REVISION_CONFLICT' });
    if (mode === 1) throw Object.defineProperty({}, 'code', { get() { getterRead = true; return 'NETWORK_BUSY'; } });
    if (mode === 2) return Object.defineProperty({}, 'private', { enumerable: true, get() { getterRead = true; return token; } });
    return { data: 'x'.repeat(1024 * 1024) };
  } }));
  t.after(() => server.close());
  const conflict = await call(server.port); assert.equal(conflict.status, 409);
  assert.deepEqual(JSON.parse(conflict.body), { error: { code: 'NETWORK_REVISION_CONFLICT' } });
  for (mode = 1; mode <= 3; mode++) {
    const response = await call(server.port); assert.equal(response.status, 500);
    assert.deepEqual(JSON.parse(response.body), { error: { code: 'NETWORK_HELPER_FAILED' } });
  }
  assert.equal(getterRead, false);
});
