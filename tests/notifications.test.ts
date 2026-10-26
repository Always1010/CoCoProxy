import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createECDH, createPublicKey, verify } from 'node:crypto';
import { createRequire } from 'node:module';
import { createAdminCredential } from '../packages/management/auth.ts';
import { TrustedDeviceStore } from '../packages/management/trusted-devices.ts';
import { createManagementGateway } from '../packages/management/http.ts';
import { createNotifications, type NotificationEvent } from '../packages/management/notifications.ts';
import { createPushRequest, generatePushKeys, parsePushSubscription, pushEndpoint, pushTopic, type PushReply } from '../packages/management/web-push.ts';

const origin = 'https://management.example';
const credential = await createAdminCredential({ username: 'synthetic-admin', password: 'synthetic-notification-password' });
const subscription = { endpoint: 'https://fcm.googleapis.com/wp/synthetic-subscription', keys: { p256dh: generatePushKeys().publicKey, auth: Buffer.alloc(16, 1).toString('base64url') } };
test('production request encrypts a decryptable RFC 8291 payload and signs a verifiable provider-bound VAPID token', t => {
  const require = createRequire(import.meta.url);
  let dependency: string;
  try { dependency = require.resolve('web-push'); }
  catch { t.skip('需要锁文件固定的 web-push 运行依赖'); return; }
  const ece = createRequire(dependency)('http_ece');
  const receiver = createECDH('prime256v1'); receiver.generateKeys();
  const sub = { ...subscription, keys: { ...subscription.keys, p256dh: receiver.getPublicKey().toString('base64url') } };
  const keys = generatePushKeys(), payload = JSON.stringify({ title: '合成通知', body: '恢复可用' });
  const topic = pushTopic('synthetic-scope', 'Proxy');
  const request = createPushRequest(sub, payload, keys, origin, 300, topic);
  assert.equal(request.headers['Content-Encoding'], 'aes128gcm');
  assert.equal(request.headers.TTL, 300); assert.equal(request.headers.Topic, topic);
  assert.equal(ece.decrypt(request.body, { version: 'aes128gcm', privateKey: receiver, authSecret: sub.keys.auth }).toString(), payload);
  const authorization = String(request.headers.Authorization);
  const token = /t=([^, ]+)/.exec(authorization)![1], [header, claims, signature] = token.split('.');
  const raw = Buffer.from(keys.publicKey, 'base64url');
  const publicKey = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: raw.subarray(1, 33).toString('base64url'), y: raw.subarray(33).toString('base64url') }, format: 'jwk' });
  assert.ok(verify('sha256', Buffer.from(`${header}.${claims}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url')));
  const claim = JSON.parse(Buffer.from(claims, 'base64url').toString());
  assert.equal(claim.aud, 'https://fcm.googleapis.com'); assert.equal(claim.sub, origin);
  assert.ok(claim.exp > Date.now() / 1000 && claim.exp <= Date.now() / 1000 + 86_400);
});
async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'cocoproxy-notifications-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let clock = 1_000_000;
  const devices = await TrustedDeviceStore.load(directory, credential, origin, () => clock);
  const grant = await devices.issue('until-revoked', '合成设备');
  const sent: unknown[] = [];
  let reply: PushReply = { status: 201 };
  const source = { scope: 'synthetic-scope', events: [] as (Omit<NotificationEvent, 'scope' | 'id'> & { id?: string })[], groups: [{ name: 'Proxy', current: 'A', phase: 'monitoring', reason: null as string | null, health: 'unknown' as 'unknown' | 'healthy' | 'unavailable' }] };
  const open = async (currentDevices = devices) => createNotifications({ stateDirectory: directory, origin, devices: currentDevices, now: () => clock,
    source: async () => source, send: async (_subscription, payload) => { sent.push(JSON.parse(payload)); return reply; } });
  let notifications = await open();
  t.after(() => notifications.close());
  const gateway = () => createManagementGateway({ origin, credential, trustedDevices: devices, now: () => clock }, notifications.route);
  const cookie = `__Host-cocoproxy_device=${grant.token}`;
  const call = (path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) => gateway().fetch(new Request(origin + '/api/cocoproxy/notifications/' + path, {
    method, headers: { cookie, ...(method !== 'GET' ? { origin, 'content-type': 'application/json' } : {}), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
  const enable = async () => {
    assert.equal((await call('initialize', 'POST', {})).status, 200);
    assert.equal((await call('subscription', 'POST', { subscription })).status, 200);
  };
  return { directory, devices, grant, source, sent, call, enable, advance(ms: number) { clock += ms; },
    event(reason = 'failure-recovery', to = 'B') { source.events.push({ id: `event-${source.events.length}`, at: clock, group: 'Proxy', from: 'A', to, reason }); },
    tick: () => notifications.tick(), setReply(value: PushReply) { reply = value; },
    async restart(currentDevices = devices) { await notifications.close(); notifications = await open(currentDevices); },
  };
}

test('subscriptions require authenticated trusted devices and validated providers; API never exposes subscription secrets', async t => {
  const f = await fixture(t);
  const untrusted = createManagementGateway({ origin, credential }, async (request, principal) => {
    const service = await createNotifications({ stateDirectory: f.directory, origin, devices: f.devices, source: async () => f.source });
    return service.route(request, principal);
  });
  assert.equal((await untrusted.fetch(new Request(origin + '/api/cocoproxy/notifications/status'))).status, 401);
  assert.equal((await f.call('initialize', 'POST', {}, { origin: 'https://other.example' })).status, 403);
  await f.enable();
  const body = await (await f.call('status')).text();
  assert.ok(!body.includes(subscription.endpoint) && !body.includes(subscription.keys.auth) && !body.includes('privateKey'));
  assert.equal(JSON.parse(body).subscribed, true);
  for (const endpoint of ['https://127.0.0.1/send', 'https://fcm.googleapis.com.evil.example/send', 'https://user:pass@fcm.googleapis.com/send', 'http://fcm.googleapis.com/send', 'https://fcm.googleapis.com:8443/send']) assert.throws(() => pushEndpoint(endpoint));
  assert.throws(() => parsePushSubscription({ ...subscription, keys: { ...subscription.keys, auth: 'bad' } }));
  const saved = await readFile(join(f.directory, 'notifications', 'state.json'), 'utf8');
  assert.ok(!saved.includes(f.grant.token));
});

test('confirmed events persist, coalesce, survive restart and expire; accepted does not mean delivered', async t => {
  const f = await fixture(t); await f.enable();
  f.event(); await f.tick();
  assert.equal(f.sent.length, 0);
  f.advance(1000); f.event('preferred-restored', 'A'); await f.tick();
  await f.restart(); f.advance(10_000); await f.tick();
  assert.equal(f.sent.length, 1);
  const message = f.sent[0] as { body: string; url: string };
  assert.match(message.body, /首选节点稳定恢复/);
  assert.equal(message.url, '/#/cocoproxy');
  assert.equal((await (await f.call('status')).json()).delivery, 'accepted');
  await f.tick(); assert.equal(f.sent.length, 1);
  f.event(); await f.tick(); f.advance(300_001); await f.tick(); assert.equal(f.sent.length, 1);
  assert.equal((await (await f.call('events')).json()).events.length, 3);
});

test('retry state is durable, invalid subscriptions stop retrying and device revocation cancels queued messages', async t => {
  const f = await fixture(t); await f.enable(); f.setReply({ status: 429, retryAfterMs: 60_000 });
  f.event(); await f.tick(); f.advance(10_000); await f.tick(); assert.equal(f.sent.length, 1);
  await f.restart(); f.advance(59_999); await f.tick(); assert.equal(f.sent.length, 1);
  f.setReply({ status: 410 }); f.advance(1); await f.tick(); assert.equal(f.sent.length, 2);
  assert.equal((await (await f.call('status')).json()).delivery, 'expired');
  f.event(); await f.tick(); f.advance(10_000); await f.tick(); assert.equal(f.sent.length, 2);
  await f.enable(); f.event(); await f.tick();
  await f.devices.revoke(f.grant.device.id); f.advance(10_000); await f.tick();
  assert.equal(f.sent.length, 2);
  assert.equal((await f.call('status')).status, 401);
});

test('per-device preferences filter groups and health transitions; removing notifications leaves management authorized', async t => {
  const f = await fixture(t); await f.enable();
  assert.equal((await f.call('preferences', 'PUT', { groups: ['Other'], switches: true, recovery: true, outage: true, showNodes: false })).status, 200);
  f.event(); await f.tick(); f.advance(10_000); await f.tick(); assert.equal(f.sent.length, 0);
  await f.call('preferences', 'PUT', { groups: null, switches: true, recovery: true, outage: true, showNodes: false });
  f.source.groups[0].phase = 'outage'; await f.tick(); f.advance(10_000); await f.tick();
  assert.equal(f.sent.length, 1); await f.tick(); assert.equal(f.sent.length, 1);
  f.source.groups[0].phase = 'monitoring'; f.source.groups[0].reason = 'failure-recovery'; f.source.groups[0].health = 'healthy'; await f.tick();
  f.advance(10_000); await f.tick(); assert.equal(f.sent.length, 2);
  await f.call('unsubscribe', 'POST', {}); assert.equal((await f.call('status')).status, 200);
  f.event(); await f.tick(); f.advance(10_000); await f.tick(); assert.equal(f.sent.length, 2);
});

test('credential changes invalidate persisted subscriptions and damaged state cannot enable sending', async t => {
  const f = await fixture(t); await f.enable();
  const replacement = await createAdminCredential({ username: 'synthetic-admin', password: 'replacement-synthetic-password' });
  const devices = await TrustedDeviceStore.load(f.directory, replacement, origin);
  await f.restart(devices); f.event(); await f.tick(); f.advance(10_000); await f.tick(); assert.equal(f.sent.length, 0);
  await writeFile(join(f.directory, 'notifications', 'state.json'), '{invalid', { mode: 0o600 });
  await f.restart();
  assert.equal((await (await f.call('status')).json()).supported, false);
  assert.equal((await f.call('initialize', 'POST', {})).status, 503);
});

test('restart waits for real healthy evidence before reporting recovery from a remembered outage', async t => {
  const f = await fixture(t); await f.enable();
  f.source.groups[0].phase = 'outage'; f.source.groups[0].health = 'unavailable';
  await f.tick(); f.advance(10_000); await f.tick(); assert.equal(f.sent.length, 1);
  await f.restart(); f.source.groups[0].phase = 'monitoring'; f.source.groups[0].reason = null; f.source.groups[0].health = 'unknown';
  await f.tick(); f.advance(10_000); await f.tick(); assert.equal(f.sent.length, 1);
  f.source.groups[0].health = 'healthy'; await f.tick(); f.advance(10_000); await f.tick();
  assert.equal(f.sent.length, 2); assert.match((f.sent[1] as { body: string }).body, /已恢复可用出口/);
  await f.tick(); assert.equal(f.sent.length, 2);
});
