import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { deployLocal, parseLocalOptions, parseRemoteOptions, payloadPath, quoteRemote, verifyTransportPayload } from '../scripts/deploy-ssh.mjs';
import { releaseLauncher } from '../scripts/release-layout.mjs';

async function payloadFixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cocoproxy-deploy-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'source/scripts'), { recursive: true });
  const bytes = Buffer.from('synthetic helper\n');
  const entry = { path: 'source/scripts/remote-deploy.py', mode: '0644', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  await writeFile(join(root, entry.path), bytes);
  const manifest = JSON.stringify({ schemaVersion: 1, commit: 'a'.repeat(40), files: [entry] });
  await writeFile(join(root, 'manifest.json'), manifest);
  return { root, entry, sha: createHash('sha256').update(manifest).digest('hex') };
}

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

test('remote transport hashes the exact release list and rejects changed bytes before SSH transfer', async t => {
  const { root, entry, sha } = await payloadFixture(t);
  assert.deepEqual((await verifyTransportPayload(root, sha)).names, ['manifest.json', entry.path]);
  await assert.rejects(verifyTransportPayload(root, 'b'.repeat(64)), { code: 'REMOTE_MANIFEST_MISMATCH' });
  await writeFile(join(root, entry.path), 'changed bytes');
  await assert.rejects(verifyTransportPayload(root, sha));
  await writeFile(join(root, 'manifest.json'), JSON.stringify({ schemaVersion: 1, files: [{ ...entry, path: 'source/.local/private' }] }));
  await assert.rejects(verifyTransportPayload(root), { code: 'REMOTE_PAYLOAD_PATH_INVALID' });
});

test('local deployment requires an explicit local target and refuses SSH or ambiguous options', () => {
  assert.equal(parseLocalOptions(['--local']).local, true);
  assert.equal(parseLocalOptions(['--local', '--preview']).preview, true);
  for (const args of [[], ['--local', '127.0.0.1'], ['--local', '--user', 'root'], ['--local', '--port', '22'],
    ['--local', '--check', '--preview'], ['--local', '--local'], ['--local', '--router-hook'],
    ['--local', '--web-unit', 'one', '--web-unit', 'two']]) {
    assert.throws(() => parseLocalOptions(args), { code: 'LOCAL_ARGUMENTS_INVALID' });
  }
  assert.throws(() => parseLocalOptions(['--local', '--payload', '/synthetic/release']), { code: 'REMOTE_TRUSTED_MANIFEST_REQUIRED' });
});

test('local check is read-only and non-root deployment or unsupported hosts never enter maintenance', async t => {
  t.mock.method(console, 'log', () => {});
  const inventory = { platform: 'Linux', architecture: 'aarch64', root: false, node: true, systemd: true };
  const commands = [];
  const execute = async (command, args) => { commands.push([command, ...args]); return JSON.stringify(inventory); };
  await deployLocal(['--local', '--check'], execute);
  assert.equal(commands.length, 1);
  await assert.rejects(deployLocal(['--local'], execute), { code: 'LOCAL_DEPLOY_ROOT_REQUIRED' });
  inventory.platform = 'Darwin';
  await assert.rejects(deployLocal(['--local', '--check'], execute), { code: 'LOCAL_TARGET_PREREQUISITES_MISSING' });
  assert.ok(commands.every(args => args[0] === 'python3' && args[1] === '-c'));
});

test('local install and preview call the shared coordinator directly and stop on payload drift or coordinator failure', async t => {
  t.mock.method(console, 'log', () => {});
  const { root, entry, sha } = await payloadFixture(t);
  const input = join(root, 'private-input.json');
  await writeFile(input, '{}', { mode: 0o600 });
  const commands = [];
  const execute = async (command, args) => {
    commands.push([command, ...args]);
    return JSON.stringify({ platform: 'Linux', architecture: 'aarch64', root: true, node: true, systemd: true });
  };
  const base = ['--local', '--payload', root, '--manifest-sha256', sha];
  // First install and upgrade share the coordinator; it selects the operation from the receipt.
  await deployLocal([...base, '--environment', input, '--admin-input', input, '--router-config', input], execute);
  assert.deepEqual(commands[1], ['python3', join(root, entry.path), '--payload', root, '--manifest-sha256', sha,
    '--environment', input, '--admin-input', input, '--router-config', input]);
  await deployLocal([...base, '--input', input, '--preview'], execute);
  assert.deepEqual(commands[3], ['python3', join(root, entry.path), '--payload', root, '--manifest-sha256', sha, '--input', input, '--preview']);
  const failure = Object.assign(new Error('synthetic failure'), { code: 'REMOTE_COMMAND_FAILED' });
  await assert.rejects(deployLocal(base, async (command, args) => {
    if (args[0] !== '-c') throw failure;
    return execute(command, args);
  }), error => error === failure);
  await writeFile(join(root, entry.path), 'tampered coordinator');
  const count = commands.length;
  await assert.rejects(deployLocal(base, execute));
  assert.equal(commands.length, count + 1);
  assert.ok(commands.every(args => args[0] === 'python3'));
});

test('packaged shell entry discovers local deployment from another directory without connecting to any host', { skip: process.platform === 'win32' && !process.env.COCOPROXY_TEST_SH }, async t => {
  const { root } = await payloadFixture(t);
  for (const name of ['cocoproxy-setup.sh', 'deploy-ssh.mjs']) {
    await copyFile(new URL('../scripts/' + name, import.meta.url), join(root, 'source/scripts', name));
  }
  const entry = join(root, 'cocoproxy');
  await writeFile(entry, releaseLauncher);
  const output = execFileSync(process.env.COCOPROXY_TEST_SH || 'sh', [entry, 'deploy', '--local', '--help'], {
    cwd: tmpdir(), encoding: 'utf8', windowsHide: true,
  });
  assert.match(output, /sudo cocoproxy deploy --local/);
  assert.match(output, /不通过 SSH 连接本机/);
  // A target IP mixed into local mode must fail before any inventory or SSH call.
  assert.throws(() => execFileSync(process.execPath, [join(root, 'source/scripts/deploy-ssh.mjs'), '--local', '127.0.0.1'], {
    encoding: 'utf8', windowsHide: true, stdio: 'pipe',
  }), error => error.status === 1 && error.stderr.trim() === 'LOCAL_ARGUMENTS_INVALID');
});
