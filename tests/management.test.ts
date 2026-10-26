import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createAdminCredential, SessionStore } from '../packages/management/auth.ts';
import { TrustedDeviceStore } from '../packages/management/trusted-devices.ts';
import { createManagementHandler, createManagementGateway, managementOrigin, readJsonBody } from '../packages/management/http.ts';
import { createManagementApplication } from '../packages/management/application.ts';
import { loadManagementService, stripControllerMount } from '../packages/management/service.ts';
import { FileTransactionStore } from '../packages/transaction/index.ts';
import { canonicalJson, compileConfig } from '../packages/config/index.ts';
import type { JsonObject } from '../packages/config/index.ts';
import { SubscriptionStore } from '../packages/subscriptions/index.ts';
import type { AutomaticGatewaySettings } from '../packages/gateway/profile.ts';

const origin = 'https://management.example';
const username = 'synthetic-admin';
const password = 'synthetic-password-for-tests';
const secret = 'synthetic-core-secret-never-in-browser';
const deployment = { mixedPort: 17890, controllerPort: 19090, dnsPort: 15353,
  controllerSecret: secret, bootstrapResolvers: ['192.0.2.53'] };
const credential = await createAdminCredential({ username, password });
const policy = { proxies: [], 'proxy-groups': [], rules: ['MATCH,DIRECT'], 'log-level': 'warning' };

test('controller HTTP responses and WebSocket checks share the same revocable cookie session', async () => {
  const gateway = createManagementGateway({ origin, credential }, async input => {
    const stripped = stripControllerMount(input);
    assert.equal(new URL(stripped.url).pathname, '/proxies/%E8%8A%82%E7%82%B9');
    assert.equal(stripped.method, 'DELETE');
    return new Response(null, { status: 204, headers: { 'x-cocoproxy-generation': 'a'.repeat(64) } });
  });
  const cookie = await login(gateway.fetch);
  const input = request('/api/clash/proxies/%E8%8A%82%E7%82%B9', 'DELETE', undefined, cookie);
  const response = await gateway.fetch(input);
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('x-cocoproxy-generation'), 'a'.repeat(64));
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const ws = request('/api/clash/logs?level=info', 'GET', undefined, cookie, { origin });
  assert.equal(gateway.authorize(ws, true).username, username);
  assert.throws(() => gateway.authorize(request('/api/clash/traffic', 'GET', undefined, cookie), true), { code: 'ORIGIN_DENIED' });
  assert.throws(() => gateway.authorize(request('/api/clash/traffic', 'GET', undefined, cookie, { origin: 'https://other.example' }), true), { code: 'ORIGIN_DENIED' });
  await gateway.fetch(request('/api/session/logout', 'POST', {}, cookie));
  assert.throws(() => gateway.authorize(ws, true), { code: 'UNAUTHORIZED' });
  assert.equal((await gateway.fetch(input)).status, 401);
});

function request(path: string, method = 'GET', body?: unknown, cookie?: string, headers: Record<string, string> = {}): Request {
  return new Request(origin + path, { method, headers: { ...(method === 'GET' ? {} : { origin, 'content-type': 'application/json' }),
    ...(cookie ? { cookie } : {}), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function login(handler: (r: Request) => Promise<Response>) {
  const response = await handler(request('/api/session/login', 'POST', { username, password }));
  assert.equal(response.status, 200, await response.clone().text());
  const cookie = response.headers.get('set-cookie')!;
  assert.match(cookie, /^__Host-cocoproxy_session=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Strict; Secure; Max-Age=/);
  assert.ok(!(await response.clone().text()).includes(cookie.split(';')[0].split('=')[1]));
  assert.equal(response.headers.get('cache-control'), 'no-store');
  return cookie.split(';')[0];
}

test('remembered browsers reauthenticate after expiry and restart; logout and device revocation invalidate HTTP and WS', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cocoproxy-remember-http-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let clock = 1_000_000;
  const makeGateway = async () => createManagementGateway({ origin, credential, now: () => clock,
    sessions: new SessionStore({ now: () => clock, ttlMs: 2000 }),
    trustedDevices: await TrustedDeviceStore.load(root, credential, origin, () => clock),
  }, async () => ({ ok: true }));
  let gateway = await makeGateway();
  const signIn = async (trust: string, label: string, cookie?: string) => {
    const response = await gateway.fetch(request('/api/session/login', 'POST', { username, password, trust, deviceLabel: label }, cookie));
    assert.equal(response.status, 200, await response.clone().text());
    const cookies = response.headers.getSetCookie();
    assert.equal(cookies.length, 2);
    for (const value of cookies) assert.match(value, /HttpOnly; SameSite=Strict; Secure; Max-Age=/);
    return cookies.map(value => value.split(';')[0]).join('; ');
  };
  const first = await signIn('until-revoked', '合成手机');
  const second = await signIn('90days', '合成电脑');
  const firstToken = first.split('; ')[1];
  const responseText = await (await gateway.fetch(request('/api/session/devices', 'GET', undefined, first))).text();
  assert.ok(!responseText.includes('tokenDigest') && !responseText.includes(firstToken.split('=')[1]));
  const listed = JSON.parse(responseText).devices;
  const phone = listed.find((item: { label: string }) => item.label === '合成手机');
  assert.equal(phone.current, true);
  assert.equal(phone.expiresAt, null);
  clock += 2000;
  const renewed = await gateway.fetch(request('/api/session', 'GET', undefined, first));
  assert.equal(renewed.status, 200);
  assert.match(renewed.headers.getSetCookie()[0], /^__Host-cocoproxy_session=/);
  gateway = await makeGateway();
  const restored = await gateway.fetch(request('/api/session', 'GET', undefined, firstToken));
  assert.equal(restored.status, 200);
  const restoredSession = restored.headers.getSetCookie()[0].split(';')[0];
  const ws = request('/api/clash/traffic', 'GET', undefined, restoredSession, { origin });
  assert.equal(gateway.authorize(ws, true).username, username);
  assert.equal((await gateway.fetch(request('/api/session/devices/revoke', 'POST', { id: phone.id }, second, { origin: 'https://other.example' }))).status, 403);
  assert.equal((await gateway.fetch(request('/api/session/devices/revoke', 'POST', { id: phone.id }, second))).status, 200);
  assert.throws(() => gateway.authorize(ws, true), { code: 'UNAUTHORIZED' });
  assert.equal((await gateway.fetch(request('/api/session', 'GET', undefined, restoredSession))).status, 401);
  assert.equal((await gateway.fetch(request('/api/session', 'GET', undefined, first))).status, 401);
  const logout = await gateway.fetch(request('/api/session/logout', 'POST', {}, second));
  assert.equal(logout.status, 200);
  assert.equal(logout.headers.getSetCookie().length, 2);
  for (const value of logout.headers.getSetCookie()) assert.match(value, /Max-Age=0$/);
  gateway = await makeGateway();
  assert.equal((await gateway.fetch(request('/api/session', 'GET', undefined, second))).status, 401);
  const third = await signIn('until-revoked', '合成设备丙');
  const duplicateDevice = third + '; ' + third.split('; ')[1];
  assert.equal((await gateway.fetch(request('/api/session', 'GET', undefined, duplicateDevice))).status, 401);
  const current = (await (await gateway.fetch(request('/api/session/devices', 'GET', undefined, third))).json()).devices[0];
  const revokeCurrent = await gateway.fetch(request('/api/session/devices/revoke', 'POST', { id: current.id }, third));
  assert.deepEqual(await revokeCurrent.json(), { revoked: true, current: true });
  assert.equal((await gateway.fetch(request('/api/session', 'GET', undefined, third))).status, 401);
  const fourth = await signIn('until-revoked', '合成设备丁');
  const temporary = await gateway.fetch(request('/api/session/login', 'POST', { username, password, trust: 'none' }, fourth));
  assert.equal(temporary.status, 200);
  assert.match(temporary.headers.getSetCookie()[1], /^__Host-cocoproxy_device=;.*Max-Age=0$/);
  gateway = await makeGateway();
  assert.equal((await gateway.fetch(request('/api/session', 'GET', undefined, fourth))).status, 401);
});
async function fixture(t: test.TestContext, automaticGateway?: AutomaticGatewaySettings) {
  const root = await mkdtemp(join(tmpdir(), 'cocoproxy-management-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const state = join(root, 'state');
  const events: string[] = [];
  let fails = false;
  const runtime = { validate: async () => { events.push('validate'); }, activate: async () => { events.push('activate'); if (fails) throw new Error(secret); },
    confirm: async () => { events.push('confirm'); return true; }, restore: async () => { events.push('restore'); },
    observe: async (generation: string) => ({ ready: true, generation, checkedAt: new Date().toISOString(), reason: null }) };
  const sourceClient = { fetch: async () => ({ status: 'modified' as const, text: JSON.stringify({ proxies: [{ name: 'synthetic-node', type: 'socks5', server: '192.0.2.10', port: 1080 }] }) }) };
  const action = createManagementApplication({ stateDirectory: state, deployment, runtime, sourceClient, automaticGateway });
  return { root, state, events, handler: createManagementHandler({ origin, credential }, action), setFailure: () => { fails = true; } };
}

test('cookie session gates every action and rejects cross-origin, URL tokens and legacy bearer credentials', async () => {
  let actions = 0;
  const handler = createManagementHandler({ origin, credential }, async () => { actions++; return { ok: true }; });
  assert.equal((await handler(request('/api/cocoproxy/status'))).status, 401);
  assert.equal((await handler(request('/config.js'))).status, 401);
  const publicHealth = await handler(request('/api/cocoproxy/health'));
  assert.deepEqual(await publicHealth.json(), { responding: true, scope: 'management_only' });
  const cookie = await login(handler);
  assert.equal((await handler(request('/api/session', 'GET', undefined, cookie))).status, 200);
  for (const bad of [request('/api/cocoproxy/apply', 'POST', {}, cookie, { origin: 'https://other.example' }),
    new Request(origin + '/api/cocoproxy/apply', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{}' }),
    request('/api/cocoproxy/status?token=' + password, 'GET', undefined, cookie),
    request('/api/cocoproxy/status', 'GET', undefined, cookie, { authorization: 'Bearer ' + password }),
    request('/api/cocoproxy/status', 'GET', undefined, cookie, { 'sec-fetch-site': 'cross-site' }),
    new Request('https://other.example/api/cocoproxy/status', { headers: { cookie } }),
    request('/api/cocoproxy/status', 'GET', undefined, cookie + '; ' + cookie)]) {
    const response = await handler(bad);
    assert.ok([400, 401, 403, 421].includes(response.status));
    assert.ok(!(await response.text()).includes(password));
  }
  assert.equal(actions, 0);
  assert.equal((await handler(request('/api/cocoproxy/status', 'GET', undefined, cookie))).status, 200);
  assert.equal(actions, 1);
  const logout = await handler(request('/api/session/logout', 'POST', {}, cookie));
  assert.match(logout.headers.get('set-cookie')!, /Max-Age=0$/);
  assert.equal((await handler(request('/api/cocoproxy/status', 'GET', undefined, cookie))).status, 401);
});

test('login limits attempts and concurrent password work, expiry is absolute and bad deployment origins fail closed', async () => {
  let clock = 1_000_000;
  const sessions = new SessionStore({ now: () => clock, ttlMs: 2000 });
  const handler = createManagementHandler({ origin, credential, sessions, now: () => clock }, async () => ({}));
  const cookie = await login(handler);
  clock += 2000;
  assert.equal((await handler(request('/api/session', 'GET', undefined, cookie))).status, 401);
  for (let index = 0; index < 7; index++) assert.equal((await handler(request('/api/session/login', 'POST', { username, password: 'wrong-but-valid-password' }))).status, 401);
  assert.equal((await handler(request('/api/session/login', 'POST', { username, password }))).status, 429);
  clock += 60_001;
  assert.equal((await handler(request('/api/session/login', 'POST', { username, password }))).status, 200);
  const controllers: ReadableStreamDefaultController<Uint8Array>[] = [];
  const occupied = () => new Request(origin + '/api/session/login', { method: 'POST', headers: { origin, 'content-type': 'application/json' },
    body: new ReadableStream<Uint8Array>({ start(controller) { controllers.push(controller); } }), duplex: 'half' } as RequestInit);
  const first = handler(occupied()); const second = handler(occupied());
  const response = await handler(request('/api/session/login', 'POST', { username, password }));
  assert.equal(response.status, 429);
  // Explicitly finish the two held body reads; a disconnected request must not dispatch work.
  for (const controller of controllers) controller.close();
  await Promise.all([first, second]);
  for (const invalid of ['http://management.example', 'https://management.example/', 'https://user:pass@management.example', 'https://management.example/path']) {
    assert.throws(() => managementOrigin(invalid), { code: 'MANAGEMENT_ORIGIN_INVALID' });
  }
  assert.equal(managementOrigin('http://127.0.0.1:18080'), 'http://127.0.0.1:18080');
});

test('credential passwords within the byte limit remain usable after JSON escaping', async () => {
  const escapedPassword = '\u0001'.repeat(1024);
  const escapedCredential = await createAdminCredential({ username, password: escapedPassword });
  const handler = createManagementHandler({ origin, credential: escapedCredential }, async () => ({}));
  assert.equal((await handler(request('/api/session/login', 'POST', { username, password: escapedPassword }))).status, 200);
});

test('JSON transport rejects oversize, invalid encoding, conflicting length and stalled reads before dispatch', async () => {
  await assert.rejects(readJsonBody(request('/api/test', 'POST', { value: 'x'.repeat(100) }), 16), { code: 'BODY_LIMIT' });
  await assert.rejects(readJsonBody(request('/api/test', 'POST', {}, undefined, { 'content-type': 'text/plain' })), { code: 'JSON_REQUIRED' });
  await assert.rejects(readJsonBody(request('/api/test', 'POST', {}, undefined, { 'content-encoding': 'gzip' })), { code: 'JSON_REQUIRED' });
  await assert.rejects(readJsonBody(request('/api/test', 'POST', {}, undefined, { 'content-length': '1' })), { code: 'INVALID_BODY' });
  await assert.rejects(readJsonBody(new Request(origin, { method: 'POST', headers: { 'content-type': 'application/json' }, body: Buffer.from([255]) })), { code: 'INVALID_JSON' });
  let cancelled = false;
  const pending = new Request(origin, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: new ReadableStream({ cancel() { cancelled = true; } }), duplex: 'half' } as RequestInit);
  await assert.rejects(readJsonBody(pending, 128, 20), { code: 'BODY_TIMEOUT' });
  assert.equal(cancelled, true);
});

for (const profile of ['explicit', 'automatic'] as const) test(`authenticated ${profile} saves pin deployment and apply through the same transaction`, async t => {
  const automaticGateway: AutomaticGatewaySettings | undefined = profile === 'explicit' ? undefined : {
    schemaVersion: 1, ingressInterface: 'lan-test', gatewayIPv4: '192.0.2.2', routerIPv4: '192.0.2.1',
    routerMAC: '02:00:00:00:00:01', clientIPv4: '192.0.2.3', prefixLength: 24, dnsPort: 15353,
    egressMark: 65536, egressTable: 2024, egressPriority: 8000, tunMtu: 1500 };
  const f = await fixture(t, automaticGateway);
  const cookie = await login(f.handler);
  const call = async (path: string, method = 'GET', body?: unknown) => f.handler(request(path, method, body, cookie));
  assert.equal((await call('/api/cocoproxy/status')).status, 200);
  await assert.rejects(stat(f.state), { code: 'ENOENT' });
  const injected = await call('/api/cocoproxy/draft', 'PUT', { expectedRevision: 0, policy, deployment: { ...deployment, controllerSecret: 'attacker' } });
  assert.equal(injected.status, 400);
  const protectedPolicy = await call('/api/cocoproxy/draft', 'PUT', { expectedRevision: 0, policy: { ...policy, tun: { enable: true } } });
  assert.equal(protectedPolicy.status, 400);
  const networkBypass = await call('/api/cocoproxy/draft', 'PUT', { expectedRevision: 0, policy: { ...policy,
    iptables: { enable: true, 'inbound-interface': 'synthetic0', 'dns-redirect': true } } });
  assert.equal(networkBypass.status, 400);
  const saved = await call('/api/cocoproxy/draft', 'PUT', { expectedRevision: 0, policy });
  const metadata = await saved.json();
  assert.equal(metadata.revision, 1);
  assert.deepEqual(f.events, []);
  const draftText = await (await call('/api/cocoproxy/draft')).text();
  assert.ok(!draftText.includes(secret) && !draftText.includes('deployment'));
  assert.deepEqual(JSON.parse(draftText).draft.policy, policy);
  const staged = await (await call('/api/cocoproxy/stage', 'POST', { expectedRevision: 1 })).json();
  assert.equal(staged.stagedRevision, 1);
  if (profile === 'explicit') assert.equal(staged.generation, metadata.generation);
  else assert.notEqual(staged.generation, metadata.generation);
  assert.deepEqual(f.events, []);
  const conflict = await call('/api/cocoproxy/draft', 'PUT', { expectedRevision: 0, policy });
  assert.equal(conflict.status, 409);
  const applied = await call('/api/cocoproxy/apply', 'POST', { generation: staged.generation, expectedActive: null });
  assert.equal(applied.status, 200, await applied.clone().text());
  assert.deepEqual(f.events, ['validate', 'activate', 'confirm']);
  const status = await (await call('/api/cocoproxy/status')).json();
  assert.equal(status.active, staged.generation);
  assert.equal(status.core.ready, true);
  assert.equal(status.gateway.ready, false);
  if (automaticGateway) assert.equal(status.gateway.reason, 'GATEWAY_PATH_UNVERIFIED');
  assert.equal(status.readiness, 'unknown');
  assert.ok(!JSON.stringify(status).includes(secret));
  const wrongCAS = await call('/api/cocoproxy/apply', 'POST', { generation: staged.generation, expectedActive: null });
  assert.equal(wrongCAS.status, 409);
  // A CLI-staged candidate still cannot change this service's private deployment.
  const foreign = compileConfig({ schemaVersion: 1, deployment: { ...deployment, controllerPort: 19091 }, policy });
  await new FileTransactionStore(f.state).stage(foreign);
  const mismatch = await call('/api/cocoproxy/apply', 'POST', { generation: foreign.id, expectedActive: staged.generation });
  assert.equal(mismatch.status, 409);
  assert.equal((await mismatch.json()).error.code, 'DEPLOYMENT_MISMATCH');
  const bypasses: JsonObject[] = [{ listeners: [] }, { iptables: { enable: true } }];
  for (const bypass of bypasses) {
    const invalidConfig = { ...compileConfig({ schemaVersion: 1, deployment, policy }).config, ...bypass };
    const invalidDigest = createHash('sha256').update(canonicalJson(invalidConfig)).digest('hex');
    await new FileTransactionStore(f.state).stage({ id: invalidDigest, sha256: invalidDigest, config: invalidConfig });
    assert.equal((await call('/api/cocoproxy/apply', 'POST', { generation: invalidDigest, expectedActive: staged.generation })).status, 400);
  }
  assert.deepEqual(f.events, ['validate', 'activate', 'confirm']);
  const privateConfig = JSON.parse(await readFile(join(f.state, 'candidates', staged.generation + '.json'), 'utf8'));
  assert.equal(privateConfig.secret, secret);
  assert.equal(privateConfig.tun.enable, automaticGateway !== undefined);
});

test('browser source updates expose metadata and capture exact snapshots without URLs or automatic apply', async t => {
  const f = await fixture(t);
  const cookie = await login(f.handler);
  const call = async (path: string, method = 'GET', body?: unknown) => f.handler(request(path, method, body, cookie));
  assert.deepEqual(await (await call('/api/cocoproxy/sources')).json(), { sources: [] });
  await assert.rejects(stat(f.state), { code: 'ENOENT' });
  const configured = await call('/api/cocoproxy/sources/primary', 'PUT', { expectedRevision: 0, url: 'https://subscription.example/feed?token=' + password });
  assert.equal(configured.status, 200);
  assert.ok(!(await configured.text()).includes(password));
  assert.equal((await call('/api/cocoproxy/sources/primary/refresh', 'POST', { expectedRevision: 1 })).status, 200);
  const inventory = await (await call('/api/cocoproxy/sources')).text();
  assert.ok(!inventory.includes(password) && !inventory.includes('https://'));
  assert.equal(JSON.parse(inventory).sources[0].revision, 2);
  await call('/api/cocoproxy/draft', 'PUT', { expectedRevision: 0, policy });
  const stale = await call('/api/cocoproxy/stage', 'POST', { expectedRevision: 1, sources: [{ id: 'primary', expectedRevision: 1 }] });
  assert.equal(stale.status, 409);
  const staged = await call('/api/cocoproxy/stage', 'POST', { expectedRevision: 1, sources: [{ id: 'primary', expectedRevision: 2 }] });
  assert.equal(staged.status, 200, await staged.clone().text());
  const receipt = await staged.json();
  assert.equal(receipt.sources[0].expectedRevision, 2);
  assert.equal(receipt.sources[0].snapshotRevision, 2);
  const config = JSON.parse(await readFile(join(f.state, 'candidates', receipt.generation + '.json'), 'utf8'));
  assert.equal(config.proxies[0].name, 'synthetic-node');
  assert.deepEqual(f.events, []);
  await writeFile(join(f.state, 'subscriptions', '.write-00000000-0000-4000-8000-000000000001'), '', { mode: 0o600 });
  assert.equal((await new SubscriptionStore(f.state).list()).length, 1);
  assert.equal((await f.handler(request('/api/cocoproxy/sources/primary', 'DELETE', { expectedRevision: 2 }, cookie,
    { origin: 'https://other.example' }))).status, 403);
  assert.equal((await call('/api/cocoproxy/sources/primary', 'DELETE', { expectedRevision: 1 })).status, 409);
  const inUse = await call('/api/cocoproxy/sources/primary', 'DELETE', { expectedRevision: 2 });
  assert.equal(inUse.status, 409);
  assert.equal((await inUse.json()).error.code, 'SOURCE_IN_USE');
  assert.equal((await call('/api/cocoproxy/sources/secondary', 'PUT', {
    expectedRevision: 0, url: 'https://subscription.example/secondary',
  })).status, 200);
  assert.equal((await call('/api/cocoproxy/sources/secondary/refresh', 'POST', { expectedRevision: 1 })).status, 200);
  const { revision, ...settings } = (await (await call('/api/cocoproxy/workspace')).json()).workspace;
  assert.equal((await call('/api/cocoproxy/workspace', 'PUT', {
    expectedRevision: revision, settings: { ...settings, sourceIds: ['secondary'] },
  })).status, 200);
  assert.equal((await call('/api/cocoproxy/sources/primary', 'DELETE', { expectedRevision: 2 })).status, 200);
  assert.equal(await new SubscriptionStore(f.state).status('primary'), null);
  assert.equal((await call('/api/cocoproxy/status', 'DELETE', {})).status, 405);
  await writeFile(join(f.state, 'subscriptions', 'unexpected.txt'), '', { mode: 0o600 });
  await assert.rejects(new SubscriptionStore(f.state).list(), { code: 'SOURCE_CORRUPT' });
});

test('subscription editor reads current private URL only through an authenticated non-cacheable detail', async t => {
  const f = await fixture(t);
  const cookie = await login(f.handler);
  const path = '/api/cocoproxy/sources/primary';
  const url = 'https://subscription.example/feed?token=synthetic-editor-token';
  const call = async (suffix = '', method = 'GET', body?: unknown) => f.handler(request(path + suffix, method, body, cookie));
  assert.equal((await call('', 'PUT', { expectedRevision: 0, name: '示例订阅', url })).status, 200);
  assert.equal((await call('/refresh', 'POST', { expectedRevision: 1 })).status, 200);
  assert.equal((await f.handler(request(path + '/edit'))).status, 401);
  assert.equal((await f.handler(request(path + '/edit', 'GET', undefined, cookie, { origin: 'https://other.example' }))).status, 403);
  const detail = await call('/edit');
  assert.equal(detail.status, 200);
  assert.equal(detail.headers.get('cache-control'), 'no-store');
  const { source } = await detail.json();
  assert.equal(source.name, '示例订阅');
  assert.equal(source.url, url);
  assert.equal(source.revision, 2);
  assert.equal(source.proxies, undefined);
  assert.equal(source.etag, undefined);
  const saved = await call('', 'PUT', { expectedRevision: source.revision, name: '已修改名称', url: source.url });
  assert.equal(saved.status, 200);
  const renamed = await saved.json();
  assert.equal(renamed.snapshotCurrent, true);
  assert.equal(renamed.snapshotDigest, source.snapshotDigest);
  assert.equal((await (await call('/edit')).json()).source.name, '已修改名称');
  for (const endpoint of [path, '/api/cocoproxy/sources', '/api/cocoproxy/workspace']) {
    const response = await f.handler(request(endpoint, 'GET', undefined, cookie));
    assert.equal(response.status, 200);
    assert.ok(!(await response.text()).includes('synthetic-editor-token'));
  }
  assert.equal((await f.handler(request('/api/cocoproxy/sources/missing/edit', 'GET', undefined, cookie))).status, 404);
  assert.equal((await call('/edit', 'POST', { expectedRevision: 3 })).status, 404);
  assert.deepEqual(f.events, []);
});

test('failed runtime application is restored and never leaks diagnostics or enables legacy upstream operations', async t => {
  const f = await fixture(t);
  const cookie = await login(f.handler);
  const call = async (path: string, method = 'GET', body?: unknown) => f.handler(request(path, method, body, cookie));
  await call('/api/cocoproxy/draft', 'PUT', { expectedRevision: 0, policy });
  const staged = await (await call('/api/cocoproxy/stage', 'POST', { expectedRevision: 1 })).json();
  f.setFailure();
  const response = await call('/api/cocoproxy/apply', 'POST', { generation: staged.generation, expectedActive: null });
  assert.equal(response.status, 503);
  assert.ok(!(await response.clone().text()).includes(secret));
  assert.equal((await response.json()).error.code, 'ACTIVATION_FAILED');
  assert.deepEqual(f.events, ['validate', 'activate', 'restore']);
  assert.equal((await (await call('/api/cocoproxy/status')).json()).active, null);
  for (const path of ['/api/control/kernel/start', '/api/control/config', '/api/control/geo/update', '/config.js']) {
    assert.equal((await call(path, 'POST', {})).status, 404);
  }
});

test('production factory reads private deployment settings and never creates state or controls a service on load', {
  skip: process.platform !== 'linux' ? 'Production runtime settings require Linux and canonical POSIX paths' : false,
}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'cocoproxy-management-load-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const state = join(root, 'absent');
  const credentialPath = join(root, 'admin.json');
  const runtimeSettingsPath = join(root, 'runtime.json');
  const configPath = join(root, 'management.json');
  await writeFile(credentialPath, JSON.stringify(credential), { mode: 0o600 });
  await writeFile(runtimeSettingsPath, JSON.stringify({ schemaVersion: 1, stateDirectory: state,
    binaryPath: '/synthetic/not-installed', binarySha256: 'a'.repeat(64), systemctlPath: '/synthetic/not-systemctl',
    unitPath: '/synthetic/cocoproxy-mihomo.service', unitSha256: 'b'.repeat(64), serviceUid: 12345 }), { mode: 0o600 });
  const settings = { schemaVersion: 1, origin, credentialPath, runtimeSettingsPath, deployment,
    controllerPolicy: { allowedProbeOrigins: ['https://www.gstatic.com'] } };
  await writeFile(configPath, JSON.stringify(settings), { mode: 0o600 });
  const handler = await loadManagementService(configPath);
  const cookie = await login(handler);
  const response = await handler(request('/api/cocoproxy/status', 'GET', undefined, cookie));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).core, null);
  await assert.rejects(stat(state), { code: 'ENOENT' });
  const catalog = await handler(request('/api/cocoproxy/workspace/sites', 'GET', undefined, cookie));
  assert.equal(catalog.status, 200);
  const sites = await catalog.json();
  assert.ok(sites.targets.length > 2 && sites.targets.every((target: { permitted: boolean }) => target.permitted));
  const rememberedLogin = await handler(request('/api/session/login', 'POST', { username, password, trust: 'until-revoked', deviceLabel: '合成浏览器' }));
  assert.equal(rememberedLogin.status, 200);
  const rememberedCookie = rememberedLogin.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  const restarted = await loadManagementService(configPath);
  assert.equal((await restarted(request('/api/session', 'GET', undefined, rememberedCookie))).status, 200);
  assert.equal((await restarted(request('/api/cocoproxy/status', 'GET', undefined, rememberedCookie))).status, 200);
  await writeFile(configPath, JSON.stringify({ ...settings, controllerPolicy: { allowedProbeOrigins: [] } }), { mode: 0o600 });
  const disabled = await loadManagementService(configPath);
  const disabledCookie = await login(disabled);
  const disabledCatalog = await disabled(request('/api/cocoproxy/workspace/sites', 'GET', undefined, disabledCookie));
  assert.equal(disabledCatalog.status, 200);
  assert.ok((await disabledCatalog.json()).targets.every((target: { permitted: boolean }) => !target.permitted));
  await writeFile(configPath, JSON.stringify({ ...settings, subscriptionPolicy: { allowedOrigins: [], resolve: 'not-code' } }));
  await assert.rejects(loadManagementService(configPath), { code: 'MANAGEMENT_SETTINGS_INVALID' });
});
