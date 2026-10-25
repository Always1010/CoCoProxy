import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import WebSocket, { WebSocketServer } from 'ws';
import { createControllerProxy } from '../packages/management/controller.ts';
import type { ControllerProxyOptions } from '../packages/management/controller.ts';

const secret = 'synthetic-controller-secret';
const origin = 'https://management.example';
function request(path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}): Request {
  return new Request(origin + path, { method, headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function until(predicate: () => boolean, maximum = 2500): Promise<void> {
  const deadline = Date.now() + maximum;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('fixture event timeout');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
async function fixture(t: test.TestContext, handler?: (request: IncomingMessage, response: ServerResponse) => void) {
  const calls: IncomingMessage[] = [];
  const server = createServer((req, res) => {
    calls.push(req);
    if (handler) { handler(req, res); return; }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true }));
  });
  const sockets = new WebSocketServer({ server });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  let generation = 'generation-1';
  const options: ControllerProxyOptions = { target: async () => ({ port: address.port, secret, generation }),
    isCurrent: async expected => expected === generation, mutate: async action => action() };
  t.after(async () => {
    for (const socket of sockets.clients) socket.terminate();
    await new Promise<void>(resolve => sockets.close(() => resolve()));
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  return { calls, sockets, options, changeGeneration: () => { generation = 'generation-2'; } };
}
function client() {
  const frames: string[] = [];
  const closes: { code: number; reason: string }[] = [];
  return { frames, closes, send: (text: string) => { frames.push(text); }, close: (code: number, reason: string) => { closes.push({ code, reason }); } };
}

test('concurrent reads share only the unfinished runtime verification and recheck each generation', async t => {
  const f = await fixture(t);
  const target = f.options.target;
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const proxy = createControllerProxy({ ...f.options, target: async () => { calls++; await gate; return target(); } });
  const first = proxy.fetch(request('/version'));
  const second = proxy.fetch(request('/proxies'));
  await until(() => calls === 1);
  release();
  assert.deepEqual((await Promise.all([first, second])).map(response => response.status), [200, 200]);
  assert.equal(calls, 1);
  f.changeGeneration();
  assert.equal((await proxy.fetch(request('/version'))).headers.get('x-coproxy-generation'), 'generation-2');
  assert.equal(calls, 2);
});

test('probe admission is bounded across clients and cancellation releases capacity', async t => {
  const f = await fixture(t, (req, response) => {
    if (req.url === '/version') response.end('{}');
    // Delay responses until their requesting clients abort.
  });
  const proxy = createControllerProxy({ ...f.options, allowedProbeOrigins: ['https://probe.example'] });
  const abort = new AbortController();
  const url = origin + '/proxies/node/delay?url=https%3A%2F%2Fprobe.example%2Fping&timeout=1000';
  const pending = Array.from({ length: 16 }, () => proxy.fetch(new Request(url, { signal: abort.signal })));
  await until(() => f.calls.length === 16);
  assert.equal((await proxy.fetch(new Request(url))).status, 429);
  assert.equal((await proxy.fetch(request('/version'))).status, 200);
  abort.abort();
  await Promise.all(pending);
  const cancelled = new AbortController(); cancelled.abort();
  assert.notEqual((await proxy.fetch(new Request(url, { signal: cancelled.signal }))).status, 429);
});

test('cancelled probe waiters release slots while another reader keeps shared verification alive', async t => {
  const f = await fixture(t), original = f.options.target;
  let checking = false, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const proxy = createControllerProxy({ ...f.options, allowedProbeOrigins: ['https://probe.example'],
    target: async () => { checking = true; await gate; return original(); } });
  const abort = new AbortController();
  const url = origin + '/proxies/node/delay?url=https%3A%2F%2Fprobe.example%2Fping&timeout=1000';
  const probes = Array.from({ length: 16 }, () => proxy.fetch(new Request(url, { signal: abort.signal })));
  const reader = proxy.fetch(request('/version'));
  await until(() => checking);
  abort.abort();
  await Promise.all(probes);
  const replacement = proxy.fetch(new Request(url));
  release();
  assert.equal((await replacement).status, 200);
  assert.equal((await reader).status, 200);
});

test('a generation changed while reading the upstream body cannot label new data with the old generation', async t => {
  let change!: () => void;
  const f = await fixture(t, (_request, response) => { change(); response.end('{"from":"new-generation"}'); });
  change = f.changeGeneration;
  const result = await createControllerProxy(f.options).fetch(request('/version'));
  assert.equal(result.status, 409);
  assert.deepEqual(await result.json(), { error: { code: 'CONTROLLER_GENERATION_CONFLICT' } });
});

test('HTTP reads redact nested credentials and actual secrets while isolating upstream and downstream headers', async t => {
  const f = await fixture(t, (_req, res) => {
    res.setHeader('set-cookie', 'upstream=private'); res.setHeader('location', '/private');
    res.setHeader('x-private', secret); res.setHeader('content-type', 'text/html');
    res.end(JSON.stringify({ secret, nested: [{ password: 'private', token: 'private', 'private-key': 'private', note: 'before ' + secret + ' after' }], normal: true }));
  });
  const proxy = createControllerProxy(f.options);
  const result = await proxy.fetch(request('/proxies/' + encodeURIComponent('节点 A'), 'GET', undefined,
    { cookie: 'session=browser', 'x-forwarded-host': 'attacker.example', 'x-private': 'browser' }));
  assert.equal(result.status, 200);
  const text = await result.text();
  assert.ok(!text.includes(secret) && !text.includes('"private"'));
  assert.match(text, /before \[REDACTED\] after/);
  assert.equal(f.calls[0].headers.authorization, 'Bearer ' + secret);
  assert.equal(f.calls[0].headers.cookie, undefined);
  assert.equal(f.calls[0].headers['x-private'], undefined);
  assert.equal(f.calls[0].headers['x-forwarded-host'], undefined);
  assert.match(f.calls[0].headers.host!, /^127\.0\.0\.1:\d+$/);
  assert.equal(result.headers.get('x-coproxy-generation'), 'generation-1');
  assert.deepEqual([...result.headers.keys()].sort(), ['cache-control', 'content-type', 'x-coproxy-generation']);
});

test('a complete domestic rules inventory fits its bounded route while other reads retain the smaller limit', async t => {
  const rules = Array.from({ length: 12_000 }, (_, index) => ({ index, type: 'DomainSuffix', payload: `synthetic-${index}.example`, proxy: 'Domestic',
    extra: { disabled: false, hitCount: 0, missCount: 0, hitAt: '', missAt: '', note: 'synthetic'.repeat(5) } }));
  const f = await fixture(t, (_request, response) => response.end(JSON.stringify({ rules })));
  const proxy = createControllerProxy(f.options);
  const result = await proxy.fetch(request('/rules'));
  assert.equal(result.status, 200);
  assert.equal((await result.json()).rules.length, rules.length);
  assert.equal((await proxy.fetch(request('/version'))).status, 502);
});

test('HTTP route and query allowlists reject core reconfiguration, token auth, and encoded traversal before any upstream call', async t => {
  const f = await fixture(t);
  const proxy = createControllerProxy(f.options);
  const forbidden = [request('/restart', 'POST', {}), request('/configs', 'PATCH', {}), request('/configs', 'PUT', {}),
    request('/providers/proxies/provider', 'PUT', {}), request('/scripts'), request('/upgrade', 'POST', {}),
    request('/version?token=private'), request('/version?target=http://example.com'), request('/version?url=https://example.com'),
    request('/proxies/a%2Fb'), request('/proxies/a%5Cb'), request('/proxies/a%00b'), request('/proxies/%252e%252e'),
    request('/proxies/a..b'), request('/version', 'GET', undefined, { authorization: 'Bearer browser' })];
  for (const input of forbidden) assert.ok((await proxy.fetch(input)).status >= 400, input.url);
  assert.equal(f.calls.length, 0);
  for (const path of ['/version', '/configs', '/rules', '/proxies', '/group', '/providers/proxies', '/providers/rules/provider', '/connections']) {
    assert.equal((await proxy.fetch(request(path))).status, 200, path);
  }
});

test('delay probes require an explicit HTTPS origin and a bounded timeout', async t => {
  const f = await fixture(t);
  const probe = (url: string, timeout = '1000') => request('/proxies/node/delay?url=' + encodeURIComponent(url) + '&timeout=' + timeout);
  const disabled = await createControllerProxy(f.options).fetch(probe('https://probe.example/ping'));
  assert.equal(disabled.status, 400);
  assert.deepEqual(await disabled.json(), { error: { code: 'CONTROLLER_PROBE_DENIED' } });
  const proxy = createControllerProxy({ ...f.options, allowedProbeOrigins: ['https://probe.example'] });
  for (const url of ['http://probe.example/ping', 'https://127.0.0.1/ping', 'https://probe.example.evil/ping', 'https://user:pass@probe.example/ping', 'https://probe.example/ping#fragment']) {
    assert.equal((await proxy.fetch(probe(url))).status, 400);
  }
  for (const timeout of ['0', '10001', '-1', '1e3', '1000&timeout=5']) assert.equal((await proxy.fetch(probe('https://probe.example/ping', timeout))).status, 400);
  assert.equal(f.calls.length, 0);
  assert.equal((await proxy.fetch(probe('https://probe.example/ping'))).status, 200);
  assert.equal((await proxy.fetch(request('/providers/proxies/provider/node/healthcheck?url=' +
    encodeURIComponent('https://probe.example/ping') + '&timeout=1000'))).status, 200);
  assert.equal(f.calls.at(-1)?.url, '/providers/proxies/provider/node/healthcheck?url=https%3A%2F%2Fprobe.example%2Fping&timeout=1000');
});

test('delay probe timeouts remain distinguishable without exposing upstream diagnostics', async t => {
  const f = await fixture(t, (_request, response) => {
    response.writeHead(504, { 'x-private-diagnostic': secret });
    response.end(JSON.stringify({ error: secret }));
  });
  const proxy = createControllerProxy({ ...f.options, allowedProbeOrigins: ['https://probe.example'] });
  const result = await proxy.fetch(request('/proxies/node/delay?url=' +
    encodeURIComponent('https://probe.example/ping') + '&timeout=1000'));
  assert.equal(result.status, 504);
  assert.deepEqual(await result.json(), { error: { code: 'CONTROLLER_PROBE_TIMEOUT' } });
  assert.equal(result.headers.has('x-private-diagnostic'), false);
});

test('temporary writes require If-Match and re-read the target inside the shared apply lock', async t => {
  const f = await fixture(t);
  const proxy = createControllerProxy(f.options);
  const missingHeaders: Record<string, string>[] = [{}, { 'if-match': 'generation-old' }];
  for (const headers of missingHeaders) assert.equal((await proxy.fetch(request('/proxies/group', 'PUT', { name: '节点' }, headers))).status, 409);
  assert.equal(f.calls.length, 0);
  assert.equal((await proxy.fetch(request('/proxies/group', 'PUT', { name: '节点' }, { 'if-match': 'generation-1' }))).status, 200);
  const racing = createControllerProxy({ ...f.options, mutate: async action => { f.changeGeneration(); return action(); } });
  const conflict = await racing.fetch(request('/connections', 'DELETE', undefined, { 'if-match': 'generation-1' }));
  assert.equal(conflict.status, 409);
  assert.equal(conflict.headers.get('x-coproxy-generation'), 'generation-2');
  assert.equal(f.calls.length, 1);
  assert.equal((await proxy.fetch(request('/connections/id', 'DELETE', undefined, { 'if-match': 'generation-2' }))).status, 200);
  assert.equal((await proxy.fetch(request('/proxies/group', 'PUT', { name: 'node', unexpected: true }, { 'if-match': 'generation-2' }))).status, 400);
});

test('upstream redirects, malformed UTF-8, invalid JSON, and oversized bodies return generic errors', async t => {
  const f = await fixture(t, (req, res) => {
    if (req.url === '/version') { res.writeHead(302, { location: 'http://192.0.2.1/' + secret }); res.end(); }
    else if (req.url === '/configs') res.end(Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]));
    else if (req.url === '/rules') res.end('not JSON ' + secret);
    else if (req.url === '/group') res.end('['.repeat(10_000) + '0' + ']'.repeat(10_000));
    else res.end(JSON.stringify({ data: 'x'.repeat(2 * 1024 * 1024) }));
  });
  const proxy = createControllerProxy(f.options);
  for (const path of ['/version', '/configs', '/rules', '/proxies', '/group']) {
    const result = await proxy.fetch(request(path));
    assert.equal(result.status, 502);
    assert.ok(!(await result.text()).includes(secret));
    assert.equal(result.headers.get('location'), null);
  }
  assert.equal(f.calls.length, 5);
});

test('real WebSocket relays inject private auth, redact text JSON, and cleanly close both ends', async t => {
  const f = await fixture(t);
  const connected = once(f.sockets, 'connection');
  const downstream = client();
  const cleanup = await createControllerProxy(f.options).relay(request('/traffic?interval=0.1'), downstream, () => true);
  const [socket, req] = await connected as [WebSocket, IncomingMessage];
  assert.equal(req.headers.authorization, 'Bearer ' + secret);
  assert.equal(req.headers.cookie, undefined);
  socket.send(JSON.stringify({ up: 42, nested: { token: 'private', note: secret } }));
  await until(() => downstream.frames.length === 1);
  assert.deepEqual(JSON.parse(downstream.frames[0]), { up: 42, nested: { token: '[REDACTED]', note: '[REDACTED]' } });
  cleanup(); cleanup();
  await until(() => socket.readyState === WebSocket.CLOSED);
  assert.equal(downstream.closes.length, 1);
});

test('WebSocket session revocation and generation changes close existing sockets within one second polling', async t => {
  for (const mode of ['session', 'generation']) {
    const f = await fixture(t);
    let authorized = true;
    let checking = 0;
    let maximumChecking = 0;
    const proxy = createControllerProxy({ ...f.options, isCurrent: async generation => {
      checking++; maximumChecking = Math.max(maximumChecking, checking);
      try { await new Promise(resolve => setTimeout(resolve, 30)); return f.options.isCurrent(generation); } finally { checking--; }
    } });
    const downstream = client();
    const connected = once(f.sockets, 'connection');
    await proxy.relay(request('/connections'), downstream, () => authorized);
    const [socket] = await connected as [WebSocket];
    const start = Date.now();
    if (mode === 'session') authorized = false; else f.changeGeneration();
    await until(() => downstream.closes.length > 0, 1600);
    assert.ok(Date.now() - start < 1500);
    await until(() => socket.readyState === WebSocket.CLOSED);
    assert.equal(downstream.closes[0].code, 1008);
    assert.equal(maximumChecking, 1);
  }
});

test('WebSocket rejects unsupported routes, binary/invalid frames, client send failures and early upstream closure', async t => {
  const f = await fixture(t);
  const proxy = createControllerProxy(f.options);
  for (const path of ['/version', '/logs?level=unknown', '/traffic?interval=0', '/memory?token=private']) {
    const downstream = client();
    await assert.rejects(proxy.relay(request(path), downstream, () => true));
    assert.equal(downstream.closes.length, 1);
  }
  for (const mode of ['binary', 'invalid', 'utf8', 'deep-json', 'send-failure', 'upstream-close']) {
    const connected = once(f.sockets, 'connection');
    const downstream = client();
    if (mode === 'send-failure') downstream.send = () => { throw new Error('private client error'); };
    const cleanup = await proxy.relay(request('/logs?level=warning'), downstream, () => true);
    const [socket] = await connected as [WebSocket];
    if (mode === 'binary') socket.send(Buffer.from('{}'));
    if (mode === 'invalid') socket.send('not JSON');
    if (mode === 'utf8') socket.send(Buffer.from([0xff]), { binary: false });
    if (mode === 'deep-json') socket.send('['.repeat(10_000) + '0' + ']'.repeat(10_000));
    if (mode === 'send-failure') socket.send('{}');
    if (mode === 'upstream-close') socket.close();
    await until(() => downstream.closes.length > 0);
    await until(() => socket.readyState === WebSocket.CLOSED);
    assert.equal(downstream.frames.length, 0);
    assert.ok(!downstream.closes[0].reason.includes(secret));
    cleanup();
  }
  // A failed handshake must reject the pending relay instead of leaving its caller suspended.
  f.sockets.options.verifyClient = () => false;
  const rejected = client();
  await assert.rejects(proxy.relay(request('/memory'), rejected, () => true));
  assert.equal(rejected.closes.length, 1);
});
