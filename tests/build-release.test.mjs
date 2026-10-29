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
import { buildFailureMessage, executeBuildCommand, runBuildRelease, readBuildSelection } from '../scripts/build-release.mjs';
import { createBuildInputs } from '../packages/deployment/update-scope.mjs';

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
      const frontendUpdate = args.includes('--frontend-update') ? JSON.parse(args[args.indexOf('--frontend-update') + 1]) : undefined;
      const componentUpdate = args.includes('--component-update') ? JSON.parse(args[args.indexOf('--component-update') + 1]) : undefined;
      const manifest = Buffer.from(JSON.stringify({ schemaVersion: 1, commit, ...(frontendUpdate ? { frontendUpdate } : {}), ...(componentUpdate ? { componentUpdate } : {}), files: [{ path, size: Buffer.byteLength(bytes), sha256: sha256(bytes), mode: '0644' }] }));
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

test('component selection rejects unsupported modes; a frontend base must match every backend input', async t => {
  assert.equal(readBuildSelection([]).components, 'all');
  assert.throws(() => readBuildSelection(['--components', 'unknown']), { code: 'BUILD_COMPONENTS_UNSUPPORTED' });
  assert.throws(() => readBuildSelection(['--components', 'frontend', '--components', 'all']), { code: 'BUILD_ARGUMENTS_INVALID' });
  const state = await fixture(t);
  const base = join(state.config.workspace, 'base'); await mkdir(base);
  const path = 'synthetic.txt'; await write(join(base, path), 'base');
  await write(join(base, 'bin/mihomo'), 'synthetic core', 0o755);
  const raw = await executeBuildCommand('git', ['-C', state.config.snapshot, 'ls-tree', '-rz', '--full-tree', 'HEAD'], { capture: true });
  const entries = raw.split('\0').filter(Boolean).map(line => { const match = /^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/u.exec(line); return { mode: match[1] === '100755' ? '0755' : '0644', oid: match[2], path: match[3] }; });
  const manifest = { schemaVersion: 1, commit: state.config.expected.commit, buildInputs: await createBuildInputs(entries, entry => readFile(join(state.config.snapshot, entry.path))),
    components: { mihomo: { binarySha256: sha256('synthetic core') } },
    files: [{ path, size: 4, sha256: sha256('base'), mode: '0644' }, { path: 'bin/mihomo', size: 14, sha256: sha256('synthetic core'), mode: '0755' }] };
  await write(join(base, 'manifest.json'), JSON.stringify(manifest));
  const plan = await runBuildRelease(state.config, { execute: state.execute, components: 'frontend', baseRelease: base, preview: true });
  assert.equal(plan.components, 'frontend'); assert.deepEqual(plan.inputComparison.changes, []);
  assert.equal(state.commands.some(item => item.command === 'tar'), false);
  const result = await runBuildRelease(state.config, { execute: state.execute, components: 'frontend', baseRelease: base });
  assert.equal(result.components, 'frontend');
  assert.equal(state.commands.some(item => item.command === 'npm'), false);
  await write(join(base, 'manifest.json'), JSON.stringify({ ...manifest, buildInputs: undefined }));
  await assert.rejects(runBuildRelease(state.config, { execute: state.execute, components: 'frontend', baseRelease: base }), { code: 'BUILD_FRONTEND_BASE_UPGRADE_REQUIRED' });
  await write(join(base, 'manifest.json'), JSON.stringify({ ...manifest, buildInputs: { backendInputSha256: manifest.buildInputs.backendInputSha256 } }));
  await assert.rejects(runBuildRelease(state.config, { execute: state.execute, components: 'frontend', baseRelease: base }), { code: 'BUILD_FRONTEND_BASE_UPGRADE_REQUIRED' });
  manifest.buildInputs = await createBuildInputs([...entries, { path: 'unknown-build-input.json', mode: '0644', oid: '0'.repeat(40) }], entry => readFile(join(state.config.snapshot, entry.path)));
  await write(join(base, 'manifest.json'), JSON.stringify(manifest));
  state.commands.length = 0;
  await assert.rejects(runBuildRelease(state.config, { execute: state.execute, components: 'frontend', baseRelease: base }), error => {
    assert.equal(error.code, 'BUILD_FRONTEND_BACKEND_CHANGED');
    assert.equal(error.inputComparison.recommendedComponents, 'management');
    assert.match(buildFailureMessage(error), /unknown-build-input.json.*removed/u);
    assert.match(buildFailureMessage(error), /--components management/u);
    assert.match(buildFailureMessage(error), /代理会短暂中断/u);
    return true;
  });
  assert.equal(state.commands.some(item => item.command === 'tar' || item.command === 'sudo'), false);
  await write(state.config.core, 'changed core');
  await assert.rejects(runBuildRelease(state.config, { execute: state.execute, components: 'frontend', baseRelease: base }), error => {
    assert.equal(error.inputComparison.recommendedComponents, 'all');
    return true;
  });
});

test('backend build reuses verified UI, skips UI generation and refuses UI drift before building', async t => {
  const state = await fixture(t); const base = join(state.config.workspace, 'base');
  const path = 'server/.output/public/index.html'; await write(join(base, path), 'synthetic UI');
  const raw = await executeBuildCommand('git', ['-C', state.config.snapshot, 'ls-tree', '-rz', '--full-tree', 'HEAD'], { capture: true });
  const entries = raw.split('\0').filter(Boolean).map(line => { const match = /^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/u.exec(line); return { mode: match[1] === '100755' ? '0755' : '0644', oid: match[2], path: match[3] }; });
  const manifest = { schemaVersion: 1, commit: state.config.expected.commit, buildInputs: await createBuildInputs(entries, entry => readFile(join(state.config.snapshot, entry.path))),
    files: [{ path, size: 12, sha256: sha256('synthetic UI'), mode: '0644' }] };
  await write(join(base, 'manifest.json'), JSON.stringify(manifest));
  const result = await runBuildRelease(state.config, { execute: state.execute, components: 'backend', baseRelease: base });
  assert.equal(result.components, 'backend');
  assert.equal(state.commands.some(item => item.args.includes('generate') || item.args[0] === 'scripts/typecheck-metacubexd-ui.mjs'), false);
  assert.ok(state.commands.some(item => item.args.includes('@metacubexd/server') && item.args.includes('build')));
  state.commands.length = 0;
  manifest.buildInputs = await createBuildInputs([...entries, { path: 'unknown-build-input.json', mode: '0644', oid: '0'.repeat(40) }], entry => readFile(join(state.config.snapshot, entry.path)));
  await write(join(base, 'manifest.json'), JSON.stringify(manifest));
  await assert.rejects(runBuildRelease(state.config, { execute: state.execute, components: 'backend', baseRelease: base }), { code: 'BUILD_REUSED_INPUT_CHANGED' });
  assert.equal(state.commands.some(item => item.command === 'tar' || item.command === 'sudo'), false);
});

test('core build reuses the complete server without UI/server compilation and rejects server input drift', async t => {
  const state = await fixture(t); const base = join(state.config.workspace, 'base');
  const path = 'server/.output/public/index.html'; await write(join(base, path), 'synthetic UI');
  const serverPath = 'server/.output/server/index.mjs'; await write(join(base, serverPath), 'server');
  const raw = await executeBuildCommand('git', ['-C', state.config.snapshot, 'ls-tree', '-rz', '--full-tree', 'HEAD'], { capture: true });
  const entries = raw.split('\0').filter(Boolean).map(line => { const match = /^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/u.exec(line); return { mode: match[1] === '100755' ? '0755' : '0644', oid: match[2], path: match[3] }; });
  const catalog = JSON.parse(await readFile(join(state.config.snapshot, 'integrations/metacubexd/components.json')));
  const buildInputs = await createBuildInputs(entries, entry => readFile(join(state.config.snapshot, entry.path)));
  const changedCatalog = async management => createBuildInputs(entries.map(entry => entry.path === 'integrations/metacubexd/components.json'
    ? { ...entry, oid: 'f'.repeat(40) } : entry), entry => entry.path === 'integrations/metacubexd/components.json'
      ? Promise.resolve(JSON.stringify({ ...catalog, management, mihomo: { version: 'new core' } })) : readFile(join(state.config.snapshot, entry.path)));
  assert.equal((await changedCatalog(catalog.management)).serverInputSha256, buildInputs.serverInputSha256);
  assert.notEqual((await changedCatalog({ ...catalog.management, commit: 'f'.repeat(40) })).serverInputSha256, buildInputs.serverInputSha256);
  const manifest = { schemaVersion: 1, commit: state.config.expected.commit, buildInputs,
    files: [{ path, size: 12, sha256: sha256('synthetic UI'), mode: '0644' }, { path: serverPath, size: 6, sha256: sha256('server'), mode: '0644' }] };
  await write(join(base, 'manifest.json'), JSON.stringify(manifest));
  const result = await runBuildRelease(state.config, { execute: state.execute, components: 'core', baseRelease: base });
  assert.equal(result.components, 'core');
  assert.equal(state.commands.some(item => ['tar', 'npm'].includes(item.command) || item.args.some(arg => ['generate', 'build', '@metacubexd/ui', '@metacubexd/server'].includes(arg))), false);
  manifest.buildInputs = await createBuildInputs([...entries, { path: 'unknown-build-input.json', mode: '0644', oid: '0'.repeat(40) }], entry => readFile(join(state.config.snapshot, entry.path)));
  await write(join(base, 'manifest.json'), JSON.stringify(manifest));
  await assert.rejects(runBuildRelease(state.config, { execute: state.execute, components: 'core', baseRelease: base }), { code: 'BUILD_REUSED_INPUT_CHANGED' });
});

test('management builds both frontend and backend, pins the installed core and refuses core drift before building', async t => {
  assert.equal(readBuildSelection(['--components', 'management']).components, 'management');
  const state = await fixture(t); const base = join(state.config.workspace, 'base');
  const path = 'bin/mihomo'; const bytes = 'synthetic core';
  await write(join(base, path), bytes, 0o755);
  await write(join(base, 'manifest.json'), JSON.stringify({ schemaVersion: 1, commit: state.config.expected.commit,
    components: { mihomo: { binarySha256: sha256(bytes) } },
    files: [{ path, size: Buffer.byteLength(bytes), sha256: sha256(bytes), mode: '0755' }] }));
  const options = { execute: state.execute, components: 'management', baseRelease: base };
  const plan = await runBuildRelease(state.config, { ...options, preview: true });
  assert.deepEqual(plan.build, ['frontend', 'backend', 'release']);
  assert.equal(plan.deployment, 'full-maintenance');
  assert.equal(plan.componentUpdate.reusedInputSha256, sha256(bytes));
  assert.equal(state.commands.some(item => item.command === 'tar'), false);
  const result = await runBuildRelease(state.config, { ...options, deploy: true });
  assert.equal(result.components, 'management'); assert.equal(result.deployed, true);
  assert.ok(state.commands.some(item => item.command === 'npm' && item.args.includes('typecheck')));
  assert.ok(state.commands.some(item => item.args.includes('@metacubexd/ui') && item.args.includes('generate')));
  assert.ok(state.commands.some(item => item.args[0] === 'scripts/typecheck-metacubexd-ui.mjs'));
  assert.ok(state.commands.some(item => item.args.includes('@metacubexd/server') && item.args.includes('build')));
  const stage = state.commands.find(item => item.args[0]?.endsWith('stage-explicit-release.mjs'));
  assert.equal(stage.args[stage.args.indexOf('--core') + 1], join(base, 'bin/mihomo'));
  assert.equal(JSON.parse(stage.args[stage.args.indexOf('--component-update') + 1]).reusedInputSha256, sha256(bytes));
  state.commands.length = 0;
  await write(state.config.core, 'changed core');
  await assert.rejects(runBuildRelease(state.config, { ...options, deploy: true }), { code: 'BUILD_MANAGEMENT_CORE_CHANGED' });
  assert.equal(state.commands.some(item => item.command === 'tar' || item.command === 'sudo'), false);
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
