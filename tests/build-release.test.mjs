import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { executeBuildCommand, runBuildRelease } from '../scripts/build-release.mjs';

const exec = promisify(execFile);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
async function write(path, bytes, mode = 0o644) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, bytes); await chmod(path, mode); }
async function fixture(t, failure) {
  const workspace = await realpath(await mkdtemp(join(tmpdir(), 'cocoproxy-build-test-')));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const config = { workspace };
  for (const key of ['source', 'mirror', 'snapshot', 'runtimeDependencies', 'toolingDependencies', 'upstreamDependencies', 'releases']) {
    config[key] = join(workspace, key); await mkdir(config[key]);
  }
  config.core = join(workspace, 'reviewed-core'); await write(config.core, 'synthetic core');
  config.upstreamArchive = join(workspace, 'upstream.tar.gz'); await write(config.upstreamArchive, 'synthetic archive');
  const lock = 'synthetic upstream lock\n';
  await write(join(config.upstreamDependencies, 'pnpm-lock.yaml'), lock);
  await write(join(config.toolingDependencies, 'pnpm/package.json'), JSON.stringify({ version: '10.34.1' }));
  for (const path of ['node_modules', 'packages/ui/node_modules', 'packages/agent/node_modules', 'packages/config-editor/node_modules', 'apps/server/node_modules']) await mkdir(join(config.upstreamDependencies, path), { recursive: true });
  const files = new Map([
    ['package.json', '{}\n'],
    ['tooling/package.json', JSON.stringify({ dependencies: { pnpm: '10.34.1' } })],
    ['integrations/metacubexd/components.json', JSON.stringify({ management: { packageManager: 'pnpm@10.34.1', sourceArchiveSha256: sha256('synthetic archive'), lockfileSha256: sha256(lock) } })],
  ]);
  for (const root of [config.source, config.mirror, config.snapshot]) for (const [path, bytes] of files) await write(join(root, path), bytes);
  const git = args => exec('git', ['-C', config.snapshot, ...args], { windowsHide: true });
  await git(['-c', 'init.defaultBranch=main', 'init']);
  await git(['-c', 'core.autocrlf=false', 'add', '.']);
  await git(['-c', 'user.name=Synthetic Test', '-c', 'user.email=test@example.test', '-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'synthetic input']);
  const commit = (await git(['rev-parse', 'HEAD'])).stdout.trim();
  config.expected = { commit, files: [...files].map(([path, bytes]) => [path, Buffer.byteLength(bytes), sha256(bytes), false]),
    dirs: ['tooling', 'integrations', 'integrations/metacubexd'] };
  const commands = []; let stagedOutput;
  const execute = async (command, args, options) => {
    commands.push({ command, args, cwd: options?.cwd, env: options?.env });
    if (command === 'git') return executeBuildCommand(command, args, options);
    if (command === 'tar') {
      const upstream = args[args.indexOf('-C') + 1];
      await write(join(upstream, 'pnpm-lock.yaml'), lock);
      for (const path of ['packages/ui', 'packages/agent', 'packages/config-editor', 'apps/server']) await mkdir(join(upstream, path), { recursive: true });
    }
    if (command === 'npm') {
      if (failure === 'typecheck') throw Object.assign(new Error('synthetic failure'), { code: 'BUILD_COMMAND_FAILED' });
      if (failure === 'source-drift') await write(join(config.mirror, 'package.json'), 'changed\n');
    }
    if (args[0]?.endsWith('stage-explicit-release.mjs')) {
      stagedOutput = args[args.indexOf('--output') + 1];
      const path = 'source/scripts/deploy-ssh.mjs'; const bytes = 'synthetic deploy entry\n';
      await write(join(stagedOutput, path), bytes);
      const manifest = Buffer.from(JSON.stringify({ schemaVersion: 1, commit, files: [{ path, size: Buffer.byteLength(bytes), sha256: sha256(bytes), mode: '0644' }] }));
      await write(join(stagedOutput, 'manifest.json'), manifest, 0o600);
      if (failure === 'payload-drift') await write(join(stagedOutput, path), 'altered payload');
      return JSON.stringify({ staged: true, commit, manifestSha256: sha256(manifest), fileCount: 1 });
    }
    return '';
  };
  return { config, commands, execute, output: () => stagedOutput };
}

test('build or source verification failures stop before staging and privilege elevation', async t => {
  for (const failure of ['typecheck', 'source-drift']) await t.test(failure, async t => {
    const state = await fixture(t, failure);
    await assert.rejects(runBuildRelease(state.config, { deploy: true, execute: state.execute }), { code: failure === 'typecheck' ? 'BUILD_COMMAND_FAILED' : 'BUILD_SOURCE_CHANGED' });
    assert.equal(state.commands.some(({ args }) => args[0]?.endsWith('stage-explicit-release.mjs')), false);
    assert.equal(state.commands.some(({ command }) => command === 'sudo'), false);
  });
});

test('changed payload cannot deploy even when a previous release exists', async t => {
  const state = await fixture(t, 'payload-drift');
  await mkdir(join(state.config.releases, 'old-release'));
  await assert.rejects(runBuildRelease(state.config, { deploy: true, execute: state.execute }), { code: 'BUILD_SOURCE_CHANGED' });
  assert.equal(state.commands.some(({ command }) => command === 'sudo'), false);
});

test('successful deployment passes only the current verified output and manifest digest', async t => {
  const originalUiDist = process.env.UI_DIST;
  process.env.UI_DIST = join(tmpdir(), 'synthetic-stale-ui');
  t.after(() => { if (originalUiDist === undefined) delete process.env.UI_DIST; else process.env.UI_DIST = originalUiDist; });
  const state = await fixture(t);
  const result = await runBuildRelease(state.config, { deploy: true, execute: state.execute });
  assert.equal(result.output, state.output()); assert.equal(result.deployed, true);
  assert.equal(result.manifestSha256, sha256(await readFile(join(result.output, 'manifest.json'))));
  const deploy = state.commands.filter(({ command }) => command === 'sudo');
  assert.equal(deploy.length, 1);
  assert.deepEqual(deploy[0].args, [process.execPath, join(result.output, 'source/scripts/deploy-ssh.mjs'), '--local', '--payload', result.output, '--manifest-sha256', result.manifestSha256]);
  assert.ok(state.commands.filter(({ command }) => command !== 'git').every(({ cwd }) => cwd === state.config.source));
  const extraction = state.commands.find(({ command }) => command === 'tar');
  const upstream = extraction.args[extraction.args.indexOf('-C') + 1];
  assert.ok(state.commands.filter(({ command }) => command !== 'git').every(({ env }) => env.UI_DIST === join(upstream, 'packages/ui/.output/public')));
});

test('Linux CLI refuses a busy workspace lock before any build work', { skip: process.platform !== 'linux' }, async t => {
  const state = await fixture(t);
  const configPath = join(state.config.workspace, 'build-config.json');
  await write(configPath, JSON.stringify(state.config), 0o600);
  const holder = spawn('flock', ['--no-fork', '--exclusive', join(state.config.workspace, '.workspace-sync.lock'), process.execPath,
    '-e', 'process.stdout.write("locked\\n"); setInterval(() => {}, 1000)'], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => {
    if (holder.pid && holder.exitCode === null && holder.signalCode === null) { const closed = once(holder, 'close'); holder.kill(); await closed; }
  });
  await Promise.race([once(holder.stdout, 'data'), once(holder, 'error').then(([error]) => { throw error; }), once(holder, 'exit').then(() => { throw new Error('Lock holder exited early'); })]);
  await assert.rejects(exec(process.execPath, [fileURLToPath(new URL('../scripts/build-release.mjs', import.meta.url)), '--config', configPath], { timeout: 10000 }), error => {
    assert.equal(error.code, 1); assert.match(error.stderr, /BUILD_LOCK_BUSY/u); return true;
  });
  assert.deepEqual(await readFile(join(state.config.mirror, 'package.json'), 'utf8'), '{}\n');
});
