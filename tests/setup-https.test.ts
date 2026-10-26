import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { renderManagedWeb, verifyManagedWeb, type ManagedWebHost, type ManagedWebStat } from '../packages/setup/https.ts';

const input = () => ({ web: { schemaVersion: 1, nginxPath: '/usr/sbin/nginx',
  certificatePath: '/etc/cocoproxy/tls/server.crt', privateKeyPath: '/etc/cocoproxy/tls/server.key' },
  gatewayIPv4: '192.0.2.2', origin: 'https://gateway.example:13443', listenPort: 13000, serviceUid: 12345 });

test('managed HTTPS rejects low ports, non-HTTPS, injection, private sandbox paths and unknown fields', () => {
  const original = input();
  for (const value of [
    { ...original, origin: 'https://gateway.example' }, { ...original, origin: 'http://gateway.example:13443' },
    { ...original, origin: 'https://gateway.example:13000' }, { ...original, origin: 'https://gateway.example:13443/path' },
    { ...original, origin: 'https://gateway.example;bad:13443' }, { ...original, origin: 'https://[::1]:13443' },
    { ...original, web: { ...original.web, privateKeyPath: '/etc/key";include.conf' } },
    { ...original, web: { ...original.web, certificatePath: '/tmp/cert.pem' } },
    { ...original, web: { ...original.web, nginxPath: '/etc/cocoproxy/web/nginx.conf' } },
    { ...original, web: { ...original.web, unknown: true } }, { ...original, serviceUid: 0 },
  ]) assert.throws(() => renderManagedWeb(value));
  assert.deepEqual(renderManagedWeb(original), renderManagedWeb(original));
});

test('managed HTTPS validates real SAN, validity and key identity with mocked read-only Linux ownership', {
  skip: !process.env.COCOPROXY_TEST_OPENSSL,
}, async t => {
  const openssl = process.env.COCOPROXY_TEST_OPENSSL!;
  assert.ok(isAbsolute(openssl));
  const directory = await mkdtemp(join(tmpdir(), 'cocoproxy-managed-https-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await promisify(execFile)(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2',
    '-keyout', join(directory, 'key.pem'), '-out', join(directory, 'cert.pem'),
    '-subj', '/CN=gateway.example', '-addext', 'subjectAltName=DNS:gateway.example,IP:192.0.2.2'],
  { timeout: 15_000, maxBuffer: 65_536, windowsHide: true });
  const cert = await readFile(join(directory, 'cert.pem')), key = await readFile(join(directory, 'key.pem'));
  const spec = input();
  const directoryStat: ManagedWebStat = { directory: true, file: false, link: false, uid: 0, mode: 0o755, nlink: 1 };
  const fileStat: ManagedWebStat = { directory: false, file: true, link: false, uid: 0, mode: 0o644, nlink: 1 };
  const stats = new Map<string, ManagedWebStat>([
    [spec.web.nginxPath, { ...fileStat, mode: 0o755 }], [spec.web.certificatePath, { ...fileStat }],
    [spec.web.privateKeyPath, { ...fileStat, uid: spec.serviceUid, mode: 0o600 }],
  ]);
  const reads: string[] = [];
  const host: ManagedWebHost = { platform: 'linux', uid: 0,
    stat: async path => stats.get(path) ?? directoryStat,
    read: async (path, limit) => { reads.push(path); const bytes = path === spec.web.certificatePath ? cert : key; assert.ok(bytes.length <= limit); return bytes; } };
  await verifyManagedWeb(spec, { host });
  await verifyManagedWeb({ ...spec, origin: 'https://192.0.2.2:13443' }, { host });
  await assert.rejects(verifyManagedWeb({ ...spec, origin: 'https://wrong.example:13443' }, { host }), { code: 'SETUP_HTTPS_CERTIFICATE_NAME_MISMATCH' });
  await promisify(execFile)(openssl, ['req', '-x509', '-key', join(directory, 'key.pem'), '-days', '2',
    '-out', join(directory, 'cn-only.pem'), '-subj', '/CN=gateway.example'],
  { timeout: 15_000, maxBuffer: 65_536, windowsHide: true });
  const cnOnly = await readFile(join(directory, 'cn-only.pem'));
  await assert.rejects(verifyManagedWeb(spec, { host: { ...host, read: async path => path === spec.web.certificatePath ? cnOnly : key } }),
    { code: 'SETUP_HTTPS_CERTIFICATE_NAME_MISMATCH' });
  await assert.rejects(verifyManagedWeb(spec, { host, now: Date.now() + 7 * 86400_000 }), { code: 'SETUP_HTTPS_CERTIFICATE_EXPIRED' });
  await assert.rejects(verifyManagedWeb(spec, { host, now: Date.now() - 7 * 86400_000 }), { code: 'SETUP_HTTPS_CERTIFICATE_EXPIRED' });
  const wrongKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
  await assert.rejects(verifyManagedWeb(spec, { host: { ...host, read: async path => path === spec.web.certificatePath ? cert : Buffer.from(wrongKey) } }), { code: 'SETUP_HTTPS_KEY_MISMATCH' });
  for (const patch of [{ mode: 0o644 }, { uid: 0 }, { nlink: 2 }, { link: true }]) {
    const saved = stats.get(spec.web.privateKeyPath)!;
    stats.set(spec.web.privateKeyPath, { ...saved, ...patch });
    await assert.rejects(verifyManagedWeb(spec, { host }), { code: 'SETUP_HTTPS_FILE_UNTRUSTED' });
    stats.set(spec.web.privateKeyPath, saved);
  }
  stats.set('/etc/cocoproxy/tls', { ...directoryStat, mode: 0o777 });
  await assert.rejects(verifyManagedWeb(spec, { host }), { code: 'SETUP_HTTPS_PATH_UNTRUSTED' });
  stats.delete('/etc/cocoproxy/tls');
  stats.set('/etc/cocoproxy/tls', { ...directoryStat, link: true });
  await assert.rejects(verifyManagedWeb(spec, { host }), { code: 'SETUP_HTTPS_PATH_UNTRUSTED' });
  stats.delete('/etc/cocoproxy/tls');
  stats.set(spec.web.certificatePath, { ...fileStat, mode: 0o664 });
  await assert.rejects(verifyManagedWeb(spec, { host }), { code: 'SETUP_HTTPS_FILE_UNTRUSTED' });
  stats.set(spec.web.certificatePath, fileStat);
  await assert.rejects(verifyManagedWeb(spec, { host: { ...host, platform: 'win32' } }), { code: 'SETUP_HTTPS_LINUX_ROOT_REQUIRED' });
  assert.ok(reads.every(path => [spec.web.certificatePath, spec.web.privateKeyPath].includes(path)));
});
