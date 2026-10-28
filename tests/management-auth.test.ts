import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  AuthError, createAdminCredential, loadAdminCredential, parseAdminCredential,
  SessionStore, verifyAdminCredential,
} from '../packages/management/auth.ts';
import { TrustedDeviceStore } from '../packages/management/trusted-devices.ts';
import { normalizeIP, recordRequestAddress, requestAddress } from '../packages/management/request-address.ts';

const password = 'synthetic-password-for-tests';
const login = { username: 'example-admin', password };
const code = (expected: string) => (error: unknown): boolean => {
  assert.ok(error instanceof AuthError);
  assert.equal(error.code, expected);
  assert.equal(error.message, expected);
  assert.ok(!JSON.stringify(error).includes(password));
  return true;
};

test('real scrypt credentials authenticate only the matching username and password', async () => {
  const first = await createAdminCredential(login);
  const second = await createAdminCredential(login);
  assert.deepEqual(Object.keys(first).sort(), ['algorithm', 'hash', 'salt', 'schemaVersion', 'username']);
  assert.equal(first.algorithm, 'scrypt-v1');
  assert.equal(Buffer.from(first.salt, 'base64url').length, 16);
  assert.equal(Buffer.from(first.hash, 'base64url').length, 64);
  assert.notEqual(first.salt, second.salt);
  assert.notEqual(first.hash, second.hash);
  assert.equal(await verifyAdminCredential(first, login), true);
  assert.equal(await verifyAdminCredential(first, { ...login, username: 'unknown-user' }), false);
  assert.equal(await verifyAdminCredential(first, { ...login, password: 'different-valid-password' }), false);
  assert.equal(JSON.stringify(first).includes(password), false);
  for (const field of ['salt', 'hash'] as const) {
    const bytes = Buffer.from(first[field], 'base64url');
    bytes[0] ^= 1;
    assert.equal(await verifyAdminCredential({ ...first, [field]: bytes.toString('base64url') }, login), false);
  }
});

test('credential creation validates exact inputs, UTF-8 byte bounds and Unicode', async () => {
  for (const value of [
    null, [], { ...login, extra: true }, { username: login.username },
    { ...login, username: '' }, { ...login, username: 'admin\n' }, { ...login, username: 'not safe' },
    { ...login, username: 'a'.repeat(65) }, { ...login, username: '管理员' },
    { ...login, password: 'short' }, { ...login, password: 'a'.repeat(9) },
    { ...login, password: 'a'.repeat(1025) },
    { ...login, password: '密'.repeat(342) }, { ...login, password: 'long-password\0' },
    { ...login, password: 'long-password\ud800' }, { ...login, password: 'long-password\udfff' },
  ]) await assert.rejects(createAdminCredential(value), code('AUTH_INPUT_INVALID'));
  const input = Object.defineProperty({ username: login.username }, 'password', {
    enumerable: true, get() { throw new Error(password); },
  });
  await assert.rejects(createAdminCredential(input), code('AUTH_INPUT_INVALID'));
  const unicode = { ...login, password: '😀'.repeat(256) };
  assert.equal(await verifyAdminCredential(await createAdminCredential(unicode), unicode), true);
  const minimum = { ...login, password: '密'.repeat(4) };
  assert.equal(await verifyAdminCredential(await createAdminCredential(minimum), minimum), true);
  const asciiMinimum = { ...login, password: 'test-pass!' };
  assert.equal(await verifyAdminCredential(await createAdminCredential(asciiMinimum), asciiMinimum), true);
});

test('credential parser refuses extensions, accessors and noncanonical encodings', async () => {
  const credential = await createAdminCredential(login);
  assert.deepEqual(parseAdminCredential(credential), credential);
  const parsed = parseAdminCredential(credential);
  parsed.username = 'changed';
  assert.equal(credential.username, login.username);
  const accessor = Object.defineProperty({ ...credential }, 'hash', {
    enumerable: true, get() { throw new Error(password); },
  });
  const symbol = { ...credential, [Symbol('hidden')]: true };
  const inherited = Object.assign(Object.create({ marker: true }), credential);
  const nonenumerable = Object.defineProperty({ ...credential }, 'hash', { enumerable: false });
  const noncanonicalSalt = credential.salt.slice(0, -1) + 'B';
  for (const value of [
    null, [], accessor, symbol, inherited, nonenumerable,
    { ...credential, schemaVersion: 2 }, { ...credential, algorithm: 'scrypt' },
    { ...credential, N: 2 }, { ...credential, password }, { ...credential, hash: '' },
    { ...credential, salt: credential.salt + '==' }, { ...credential, salt: noncanonicalSalt },
    { ...credential, hash: Buffer.alloc(63).toString('base64url') },
  ]) assert.throws(() => parseAdminCredential(value), code('AUTH_CREDENTIAL_INVALID'));
  assert.equal(await verifyAdminCredential(credential, { ...login, extra: password }), false);
  assert.equal(await verifyAdminCredential(credential, { ...login, password: '\ud800'.repeat(12) }), false);
  await assert.rejects(verifyAdminCredential({ ...credential, hash: password }, login), code('AUTH_CREDENTIAL_INVALID'));
});

test('loading credentials requires an existing private bounded regular file and hides diagnostics', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'cocoproxy-management-auth-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'admin.json');
  const credential = await createAdminCredential(login);
  await writeFile(path, JSON.stringify(credential), { mode: 0o600 });
  assert.deepEqual(await loadAdminCredential(path), credential);
  assert.equal((await readFile(path, 'utf8')).includes(password), false);
  await assert.rejects(loadAdminCredential('relative-admin.json'), code('AUTH_CREDENTIAL_INVALID'));
  await assert.rejects(loadAdminCredential(join(directory, 'missing')), code('AUTH_CREDENTIAL_INVALID'));
  await assert.rejects(loadAdminCredential(directory), code('AUTH_CREDENTIAL_INVALID'));
  if (process.platform !== 'win32') {
    const linked = join(directory, 'linked.json');
    await symlink(path, linked);
    await assert.rejects(loadAdminCredential(linked), code('AUTH_CREDENTIAL_INVALID'));
    await chmod(path, 0o644);
    await assert.rejects(loadAdminCredential(path), code('AUTH_CREDENTIAL_INVALID'));
    await chmod(path, 0o600);
  }
  await writeFile(path, Buffer.from([0xff]));
  await assert.rejects(loadAdminCredential(path), code('AUTH_CREDENTIAL_INVALID'));
  await writeFile(path, '{"schemaVersion":');
  await assert.rejects(loadAdminCredential(path), code('AUTH_CREDENTIAL_INVALID'));
  await writeFile(path, ' '.repeat(16 * 1024 + 1));
  await assert.rejects(loadAdminCredential(path), code('AUTH_CREDENTIAL_INVALID'));
});

test('sessions use canonical random tokens, absolute expiry and idempotent revocation', () => {
  let now = 100;
  const store = new SessionStore({ ttlMs: 1000, now: () => now });
  const first = store.issue('example-admin');
  const second = store.issue('example-admin');
  assert.match(first.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(Buffer.from(first.token, 'base64url').length, 32);
  assert.notEqual(first.token, second.token);
  assert.deepEqual(store.check(first.token), { username: 'example-admin', expiresAt: 1100 });
  assert.equal(JSON.stringify(store).includes(first.token), false);
  now = 1000;
  const returned = store.check(first.token)!;
  returned.expiresAt = 9999;
  assert.equal(store.check(first.token)?.expiresAt, 1100);
  now = 1100;
  assert.equal(store.check(first.token), null);
  store.revoke(first.token);
  const third = store.issue('another-admin');
  store.revoke(third.token);
  store.revoke(third.token);
  assert.equal(store.check(third.token), null);
  for (const token of [null, 123, '', first.token + '=', first.token + '\n', 'a'.repeat(42), 'a'.repeat(44), '!'.repeat(43)]) {
    assert.equal(store.check(token), null);
    assert.doesNotThrow(() => store.revoke(token));
  }
});

test('session capacity rejects excess issuance, reclaims expiry and enforces bounded options', () => {
  let now = 0;
  const store = new SessionStore({ ttlMs: 10, maxSessions: 1, now: () => now });
  const first = store.issue('example-admin');
  assert.throws(() => store.issue('second-admin'), code('AUTH_SESSION_LIMIT'));
  assert.ok(store.check(first.token));
  now = 10;
  const second = store.issue('second-admin');
  assert.equal(store.check(first.token), null);
  assert.ok(store.check(second.token));
  store.revoke(second.token);
  assert.ok(store.issue('third-admin'));
  const defaults = new SessionStore({ now: () => 0 });
  assert.equal(defaults.issue('example-admin').expiresAt, 8 * 60 * 60 * 1000);
  for (const options of [
    { ttlMs: 0 }, { ttlMs: -1 }, { ttlMs: Infinity }, { ttlMs: NaN }, { ttlMs: 8 * 60 * 60 * 1000 + 1 },
    { maxSessions: 0 }, { maxSessions: 257 }, { maxSessions: 1.5 },
  ]) assert.throws(() => new SessionStore(options), code('AUTH_INPUT_INVALID'));
  assert.throws(() => store.issue('admin\n'), code('AUTH_INPUT_INVALID'));
});

test('trusted device grants survive restart, renew after use and revoke durably without storing tokens', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cocoproxy-device-auth-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const state = join(root, 'state');
  const credential = await createAdminCredential(login);
  const origin = 'https://management.example';
  const day = 24 * 60 * 60 * 1000;
  let clock = day;
  let devices = await TrustedDeviceStore.load(state, credential, origin, () => clock);
  await assert.rejects(readFile(join(state, 'auth', 'trusted-devices.json')), { code: 'ENOENT' });
  const limited = await devices.issue('90days', '合成设备甲');
  const permanent = await devices.issue('until-revoked', '合成设备乙');
  const saved = await readFile(join(state, 'auth', 'trusted-devices.json'), 'utf8');
  assert.ok(!saved.includes(limited.token) && !saved.includes(permanent.token) && !saved.includes(password));
  assert.ok(!JSON.stringify(devices.list()).includes('tokenDigest'));
  devices = await TrustedDeviceStore.load(state, credential, origin, () => clock);
  assert.equal(devices.check(permanent.token)?.expiresAt, null);
  assert.equal(devices.check(limited.token)?.expiresAt, 91 * day);
  assert.equal((await devices.renew(limited.token))?.renewed, false);
  clock += 89 * day;
  assert.equal((await devices.renew(limited.token))?.device.expiresAt, 180 * day);
  // A queued renewal can never put a revoked grant back in the file.
  await Promise.all([devices.renew(permanent.token), devices.revoke(permanent.device.id)]);
  devices = await TrustedDeviceStore.load(state, credential, origin, () => clock);
  assert.equal(devices.check(permanent.token), null);
  assert.ok(devices.check(limited.token));
  clock = 180 * day;
  assert.equal(devices.check(limited.token), null);
  assert.equal(await devices.renew(limited.token), null);
  assert.equal(devices.check('x'.repeat(43)), null);
});

test('credential/origin changes invalidate remembered devices and corrupt or linked files fail closed', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cocoproxy-device-binding-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const credential = await createAdminCredential(login);
  const origin = 'https://management.example';
  const devices = await TrustedDeviceStore.load(root, credential, origin);
  const issued = await devices.issue('until-revoked', '合成浏览器');
  const replacement = await createAdminCredential({ ...login, password: 'replacement-synthetic-password' });
  assert.equal((await TrustedDeviceStore.load(root, replacement, origin)).check(issued.token), null);
  assert.equal((await TrustedDeviceStore.load(root, credential, 'https://other.example')).check(issued.token), null);
  assert.ok((await TrustedDeviceStore.load(root, credential, origin)).check(issued.token));
  const path = join(root, 'auth', 'trusted-devices.json');
  const saved = await readFile(path, 'utf8');
  const malformed = JSON.parse(saved);
  malformed.devices.push(malformed.devices[0]);
  await writeFile(path, JSON.stringify(malformed));
  await assert.rejects(TrustedDeviceStore.load(root, credential, origin), code('AUTH_TRUST_UNAVAILABLE'));
  await writeFile(path, saved);
  if (process.platform !== 'win32') {
    await chmod(path, 0o644);
    await assert.rejects(TrustedDeviceStore.load(root, credential, origin), code('AUTH_TRUST_UNAVAILABLE'));
    await chmod(path, 0o600);
    const target = join(root, 'synthetic-target.json');
    await writeFile(target, saved, { mode: 0o600 });
    await rm(path);
    await symlink(target, path);
    await assert.rejects(TrustedDeviceStore.load(root, credential, origin), code('AUTH_TRUST_UNAVAILABLE'));
  }
});

test('browser labels serialize uniqueness, rename independently, and migrate legacy duplicates without revoking tokens', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cocoproxy-labels-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const credential = await createAdminCredential(login), origin = 'https://management.example';
  let store = await TrustedDeviceStore.load(root, credential, origin);
  const concurrent = await Promise.allSettled([store.issue('until-revoked', ' PC '), store.issue('until-revoked', 'pc')]);
  assert.equal(concurrent.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal((concurrent.find(result => result.status === 'rejected') as PromiseRejectedResult).reason.code, 'AUTH_DEVICE_LABEL_DUPLICATE');
  const first = (concurrent.find(result => result.status === 'fulfilled') as PromiseFulfilledResult<Awaited<ReturnType<typeof store.issue>>>).value;
  const second = await store.issue('90days', 'PC Edge', undefined, '192.0.2.20');
  await store.rename(first.device.id, 'PC Chrome');
  assert.equal(store.check(first.token)?.label, 'PC Chrome');
  await assert.rejects(store.rename(second.device.id, ' pc chrome '), code('AUTH_DEVICE_LABEL_DUPLICATE'));
  const path = join(root, 'auth', 'trusted-devices.json');
  const legacy = JSON.parse(await readFile(path, 'utf8'));
  legacy.schemaVersion = 1;
  for (const item of legacy.devices) { item.label = '浏览器设备'; delete item.lastIP; delete item.lastSeenAt; }
  await writeFile(path, JSON.stringify(legacy));
  store = await TrustedDeviceStore.load(root, credential, origin);
  assert.equal(store.list().length, 2);
  assert.equal(new Set(store.list().map(item => item.label)).size, 2);
  assert.ok(store.check(first.token) && store.check(second.token));
  assert.equal(JSON.parse(await readFile(path, 'utf8')).schemaVersion, 2);
});

test('request IP uses adapter socket evidence and ignores untrusted forwarded headers', () => {
  const request = new Request('https://management.example', { headers: { 'x-real-ip': '192.0.2.20' } });
  assert.equal(requestAddress(request), null);
  recordRequestAddress(request, '192.0.2.30');
  assert.equal(requestAddress(request), '192.0.2.30');
  recordRequestAddress(request, '::ffff:127.0.0.1');
  assert.equal(requestAddress(request), '192.0.2.20');
  assert.equal(normalizeIP('2001:0db8::1'), '2001:db8::1');
  assert.equal(normalizeIP('192.0.2.20, 192.0.2.30'), null);
});
