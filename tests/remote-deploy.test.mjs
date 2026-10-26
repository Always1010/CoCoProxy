import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parseRemoteOptions, payloadPath, quoteRemote, verifyTransportPayload } from '../scripts/deploy-ssh.mjs';

test('remote deploy accepts only explicit IPs and keeps untrusted values out of shell syntax', () => {
  assert.equal(parseRemoteOptions(['192.0.2.2']).target, '192.0.2.2');
  assert.equal(parseRemoteOptions(['2001:db8::2', '--check']).check, true);
  for (const value of ['-oProxyCommand=bad', 'host.example', '192.0.2.2;bad']) assert.throws(() => parseRemoteOptions([value]));
  assert.throws(() => parseRemoteOptions(['192.0.2.2', '--user', 'root;bad']));
  assert.throws(() => parseRemoteOptions(['192.0.2.2', '--port', '0']));
  assert.equal(quoteRemote("a'b $(command)"), "'a'\\''b $(command)'");
  for (const value of ['../outside', '/absolute', 'source/.local/secret', '.git/config', '-Ibad', 'source\\bad', 'source/line\nbreak']) assert.throws(() => payloadPath(value));
  assert.equal(payloadPath('source/node_modules/ws/index.js'), 'source/node_modules/ws/index.js');
});

test('remote transport hashes the exact release list and rejects changed bytes before SSH transfer', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cocoproxy-remote-'));
  try {
    await mkdir(join(root, 'source/scripts'), { recursive: true });
    const bytes = Buffer.from('synthetic helper\n');
    const entry = { path: 'source/scripts/remote-deploy.py', mode: '0644', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
    await writeFile(join(root, entry.path), bytes);
    const manifest = JSON.stringify({ schemaVersion: 1, commit: 'a'.repeat(40), files: [entry] });
    await writeFile(join(root, 'manifest.json'), manifest);
    const sha = createHash('sha256').update(manifest).digest('hex');
    assert.deepEqual((await verifyTransportPayload(root, sha)).names, ['manifest.json', entry.path]);
    await assert.rejects(verifyTransportPayload(root, 'b'.repeat(64)), { code: 'REMOTE_MANIFEST_MISMATCH' });
    await writeFile(join(root, entry.path), 'changed bytes');
    await assert.rejects(verifyTransportPayload(root, sha));
    await writeFile(join(root, 'manifest.json'), JSON.stringify({ schemaVersion: 1, files: [{ ...entry, path: 'source/.local/private' }] }));
    await assert.rejects(verifyTransportPayload(root), { code: 'REMOTE_PAYLOAD_PATH_INVALID' });
  } finally { await rm(root, { recursive: true, force: true }); }
});
