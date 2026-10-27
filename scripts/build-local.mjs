#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { chmod, copyFile, lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { runBuildRelease, readBuildSelection, componentBaseline, buildFailureMessage } from './build-release.mjs';
import { validateReleaseMetadata, validateReleaseTooling } from './release-metadata.mjs';
import { canonicalLocalPath, cleanLocalCommit, localFail, readLocalJSON, resolveLocalPaths, runLocalCommand,
  within, withLocalBuildLock, writeLocalJSON } from './local-release-state.mjs';

const sha256 = data => createHash('sha256').update(data).digest('hex');
const absent = async path => { try { await lstat(path); return false; } catch (error) { if (error.code === 'ENOENT') return true; throw error; } };
const needPreparation = () => localFail('LOCAL_PREPARE_REQUIRED', '缺少或不匹配的构建依赖，请运行 bash scripts/build-release.sh --prepare。');

export async function checkLocalNpmTree(base) {
  try {
    await canonicalLocalPath(join(base, 'node_modules'));
    const expected = (await readLocalJSON(join(base, 'package-lock.json'))).packages;
    const actual = (await readLocalJSON(join(base, 'node_modules/.package-lock.json'))).packages;
    for (const [name, record] of Object.entries(expected)) {
      if (!name) continue;
      if (!name.startsWith('node_modules/') || !actual[name] || ['version', 'resolved', 'integrity'].some(key => record[key] !== actual[name][key])) return false;
      if ((await readLocalJSON(join(base, name, 'package.json'))).version !== record.version) return false;
    }
    return true;
  } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function asset(filename, url, digest, prepare, execute) {
  if (!(await absent(filename))) {
    await canonicalLocalPath(filename, false);
    if (sha256(await readFile(filename)) === digest) return;
    if (!prepare) localFail('LOCAL_ASSET_CHANGED', '缓存摘要不匹配，请使用 --prepare 重新准备。');
  } else if (!prepare) needPreparation();
  const temporary = filename + '.' + randomUUID();
  try {
    await execute('curl', ['--fail', '--location', '--silent', '--show-error', '--retry', '3', '--proto', '=https', '--proto-redir', '=https', '--output', temporary, url]);
    await canonicalLocalPath(temporary, false);
    if (sha256(await readFile(temporary)) !== digest) localFail('LOCAL_DOWNLOAD_DIGEST_MISMATCH');
    // Copy only our verified ordinary file, never follow a pre-existing output link.
    if (!(await absent(filename))) await canonicalLocalPath(filename, false);
    const { rename } = await import('node:fs/promises');
    await rename(temporary, filename);
  } finally { await rm(temporary, { force: true }); }
}

async function prepareLocalInputs(paths, catalog, prepare, execute) {
  const { source, workspace } = paths;
  for (const base of [source, join(source, 'tooling')]) {
    if (!await checkLocalNpmTree(base)) {
      if (!prepare) needPreparation();
      if (!(await absent(join(base, 'node_modules')))) await canonicalLocalPath(join(base, 'node_modules'));
      await execute('npm', ['ci', '--prefix', base, '--ignore-scripts', '--no-audit', '--no-fund']);
      if (!await checkLocalNpmTree(base)) localFail('LOCAL_DEPENDENCIES_MISMATCH');
    }
  }
  const cache = join(workspace, 'cache');
  await mkdir(cache, { recursive: true, mode: 0o700 }); await canonicalLocalPath(cache);
  const { management, mihomo } = catalog;
  const archive = join(cache, `metacubexd-${management.sourceArchiveSha256}.tar.gz`);
  await asset(archive, `https://codeload.github.com/MetaCubeX/metacubexd/tar.gz/${management.commit}`, management.sourceArchiveSha256, prepare, execute);
  const platform = process.arch === 'arm64' ? 'linux-arm64' : process.arch === 'x64' ? 'linux-amd64-v1' : localFail('LOCAL_ARCHITECTURE_UNSUPPORTED');
  const coreMetadata = mihomo.platforms[platform];
  const compressed = join(cache, `${coreMetadata.releaseReportedSha256}.gz`);
  await asset(compressed, coreMetadata.downloadUrl, coreMetadata.releaseReportedSha256, prepare, execute);
  const core = join(cache, `mihomo-${coreMetadata.binarySha256}`);
  if (await absent(core)) {
    const bytes = gunzipSync(await readFile(compressed), { maxOutputLength: 256 * 1024 * 1024 });
    if (sha256(bytes) !== coreMetadata.binarySha256) localFail('LOCAL_CORE_DIGEST_MISMATCH');
    await writeFile(core, bytes, { flag: 'wx', mode: 0o755 });
  }
  await canonicalLocalPath(core, false);
  if (sha256(await readFile(core)) !== coreMetadata.binarySha256) localFail('LOCAL_CORE_DIGEST_MISMATCH');

  // pnpm workspace links resolve to this cached tree. Keep its reviewed overlay
  // aligned too, rather than accidentally resolving an unadapted workspace package.
  const overlay = (await execute('git', ['-C', source, 'rev-parse', 'HEAD:integrations/metacubexd/overlay'], { capture: true })).trim();
  if (!/^[a-f0-9]{40}$/.test(overlay)) localFail('LOCAL_OVERLAY_IDENTITY_INVALID');
  const cacheKey = management.sourceArchiveSha256 + '-' + overlay;
  const upstreamDependencies = join(cache, `upstream-${cacheKey}`);
  const ready = join(cache, `upstream-${cacheKey}.ready.json`);
  let complete = false;
  if (!(await absent(ready))) {
    const record = await readLocalJSON(ready);
    complete = record.packageManager === management.packageManager && record.lockfileSha256 === management.lockfileSha256;
  }
  if (complete) {
    await canonicalLocalPath(upstreamDependencies);
    if (sha256(await readFile(join(upstreamDependencies, 'pnpm-lock.yaml'))) !== management.lockfileSha256) localFail('LOCAL_UPSTREAM_LOCK_CHANGED');
    for (const name of ['node_modules', 'packages/ui/node_modules', 'packages/agent/node_modules', 'packages/config-editor/node_modules', 'apps/server/node_modules']) {
      if (await absent(join(upstreamDependencies, name))) complete = false;
    }
  }
  if (!complete) {
    if (!prepare) needPreparation();
    if (!(await absent(upstreamDependencies))) {
      await canonicalLocalPath(upstreamDependencies);
      // This is an incomplete generated dependency cache, not a source checkout.
      if (!within(cache, upstreamDependencies)) localFail('LOCAL_CACHE_SCOPE');
      await rm(upstreamDependencies, { recursive: true });
    }
    await mkdir(upstreamDependencies, { mode: 0o700 });
    await execute('tar', ['-xzf', archive, '--strip-components=1', '-C', upstreamDependencies]);
    await execute(process.execPath, [join(source, 'scripts/verify-git-tree.mjs'), '--directory', upstreamDependencies, '--manifest', join(source, 'integrations/metacubexd/source-tree.json')]);
    await execute(process.execPath, [join(source, 'tooling/node_modules/pnpm/bin/pnpm.cjs'), '--dir', upstreamDependencies,
      '--filter', '@metacubexd/server...', '--filter', '@metacubexd/ui...', 'install', '--frozen-lockfile', '--ignore-scripts'],
    { env: { ...process.env, CI: 'true', NUXT_TELEMETRY_DISABLED: '1' } });
    await execute(process.execPath, [join(source, 'scripts/apply-metacubexd-overlay.mjs'), '--directory', upstreamDependencies]);
    if (sha256(await readFile(join(upstreamDependencies, 'pnpm-lock.yaml'))) !== management.lockfileSha256) localFail('LOCAL_UPSTREAM_LOCK_CHANGED');
    await writeLocalJSON(ready, { packageManager: management.packageManager, lockfileSha256: management.lockfileSha256 });
  }
  return { upstreamArchive: archive, upstreamDependencies, core, platform };
}

async function prepareSnapshot(paths, commit, run, execute) {
  const git = (args, extra = {}) => execute('git', ['-C', paths.source, ...args], { capture: true, ...extra });
  const entries = (await git(['ls-tree', '-r', '-t', '-z', commit])).split('\0').filter(Boolean).map(line => {
    const tab = line.indexOf('\t'); const [mode, type, oid] = line.slice(0, tab).split(' '); const name = line.slice(tab + 1);
    if (name.split('/').some(part => ['.local', '.git', 'node_modules'].includes(part.toLowerCase()))
      || !(type === 'tree' || type === 'blob' && ['100644', '100755'].includes(mode))) localFail('LOCAL_SOURCE_LINK_OR_PRIVATE_PATH');
    return { mode, type, oid, name };
  });
  const objects = new Set([commit, (await git(['rev-parse', commit + '^{tree}'])).trim(), ...entries.map(entry => entry.oid)]);
  const pack = await git(['pack-objects', '--stdout'], { input: [...objects].join('\n') + '\n', binary: true });
  const snapshot = join(run, 'snapshot'); await mkdir(snapshot);
  const snapGit = (args, extra = {}) => execute('git', ['-C', snapshot, '-c', 'core.hooksPath=/dev/null', ...args], { capture: true, ...extra });
  await snapGit(['init', '--quiet']); await snapGit(['unpack-objects', '-q'], { input: pack });
  await writeFile(join(snapshot, '.git/shallow'), commit + '\n');
  // These build copies come from Git blobs, not Windows working-tree bytes.
  // Preserve intentionally committed CRLF too; do not impose another clean policy.
  await snapGit(['config', 'core.autocrlf', 'false']);
  await snapGit(['update-ref', 'refs/heads/build', commit]);
  await snapGit(['symbolic-ref', 'HEAD', 'refs/heads/build']); await snapGit(['checkout', '--quiet']);
  const mirror = join(run, 'mirror'); const source = join(run, 'source');
  await mkdir(mirror); await mkdir(source);
  const files = []; const dirs = new Set();
  for (const { name, mode, type } of entries) {
    if (type !== 'blob') continue;
    const bytes = await readFile(join(snapshot, name));
    for (const target of [mirror, source]) {
      const output = join(target, name); await mkdir(dirname(output), { recursive: true });
      await copyFile(join(snapshot, name), output); await chmod(output, mode === '100755' ? 0o755 : 0o644);
    }
    files.push([name, bytes.length, sha256(bytes), mode === '100755']);
    let parent = dirname(name); while (parent !== '.') { dirs.add(parent); parent = dirname(parent); }
  }
  return { snapshot, mirror, source, expected: { commit, files, dirs: [...dirs] } };
}

export async function runLocalBuild({ source, workspace, prepare = false, components = 'all', baseRelease, preview = false, execute = runLocalCommand, build = runBuildRelease, inputs = prepareLocalInputs, prerequisites = async () => {} }) {
  const paths = await resolveLocalPaths(source, workspace, { create: !preview });
  return withLocalBuildLock(paths, async ({ signal, assertHeld }) => {
    if (preview) {
      const commit = await cleanLocalCommit(paths.source, execute);
      const baseline = components !== 'all' ? await componentBaseline({ snapshot: paths.source }, baseRelease, execute, components) : {};
      const { frontendUpdate, componentUpdate } = baseline;
      return { preview: true, components, commit, deployment: components === 'frontend' ? 'restart-management-and-dependent-https; preserve-core-and-network' : 'full-maintenance', ...(frontendUpdate ? { frontendUpdate } : {}), ...(componentUpdate ? { componentUpdate } : {}) };
    }
    await writeLocalJSON(paths.receipt, { schemaVersion: 1, status: 'building', source: paths.source });
    let run;
    const command = (name, args, options = {}) => execute(name, args, { cwd: paths.source, ...options, signal });
    try {
      await prerequisites(command);
      const commit = await cleanLocalCommit(paths.source, command);
      const catalog = validateReleaseMetadata(await readLocalJSON(join(paths.source, 'integrations/metacubexd/components.json')),
        await readLocalJSON(join(paths.source, 'integrations/metacubexd/review.json')), await readLocalJSON(join(paths.source, 'integrations/metacubexd/source-tree.json')));
      validateReleaseTooling(catalog, await readLocalJSON(join(paths.source, 'tooling/package.json')), await readLocalJSON(join(paths.source, 'tooling/package-lock.json')));
      const dependencies = await inputs(paths, catalog, prepare, command);
      const work = join(paths.workspace, 'work'); await mkdir(work, { recursive: true, mode: 0o700 }); await canonicalLocalPath(work);
      run = join(work, randomUUID()); await mkdir(run, { mode: 0o700 });
      const config = { workspace: paths.workspace, ...await prepareSnapshot(paths, commit, run, command),
        runtimeDependencies: join(paths.source, 'node_modules'), toolingDependencies: join(paths.source, 'tooling/node_modules'),
        upstreamArchive: dependencies.upstreamArchive, upstreamDependencies: dependencies.upstreamDependencies, core: dependencies.core,
        releases: join(paths.workspace, 'releases') };
      await mkdir(config.releases, { recursive: true, mode: 0o700 }); await canonicalLocalPath(config.releases);
      const result = await build(config, { execute: command, components, baseRelease });
      if (await cleanLocalCommit(paths.source, command) !== commit) localFail('LOCAL_SOURCE_CHANGED');
      assertHeld();
      const receipt = { ...result, schemaVersion: 1, status: 'ready', source: paths.source, platform: dependencies.platform };
      await writeLocalJSON(paths.receipt, receipt);
      return receipt;
    } catch (error) {
      if (!signal.aborted) await writeLocalJSON(paths.receipt, { schemaVersion: 1, status: 'failed', source: paths.source });
      throw error;
    } finally {
      if (run) {
        if (!within(join(paths.workspace, 'work'), run)) localFail('LOCAL_WORK_SCOPE');
        await rm(run, { recursive: true, force: true });
      }
    }
  });
}

export async function localBuildMain(args) {
  if (args.includes('--help')) {
    console.log('bash scripts/build-release.sh [--prepare] [--workspace /absolute/build-directory] [--components all|frontend|backend] [--base-release ABSOLUTE_RELEASE] [--preview]\n默认全量；frontend 要求可核验且后端输入一致的基线。预览不构建、不覆盖成功记录，需要已有构建工作区。首次 --prepare 允许按锁下载构建输入和安装项目依赖；不安装系统软件。'); return;
  }
  const { rest, ...selection } = readBuildSelection(args);
  args = rest;
  let prepare = false; let workspace;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--prepare' && !prepare) prepare = true;
    else if (args[index] === '--workspace' && args[index + 1] && !workspace) workspace = resolve(args[++index]);
    else localFail('LOCAL_ARGUMENTS_INVALID');
  }
  if (process.platform !== 'linux' || !['arm64', 'x64'].includes(process.arch)) localFail('LOCAL_LINUX_REQUIRED', '本地构建入口需要 ARM64 或 x86-64 Linux。');
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || major === 22 && minor < 18) localFail('LOCAL_NODE_VERSION_REQUIRED', '需要 Node.js >=22.18。');
  if (process.getuid?.() === 0) localFail('LOCAL_BUILD_AS_ROOT', '请使用普通用户构建，仅部署步骤使用 sudo。');
  const source = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const prerequisites = async execute => {
    for (const tool of ['git', 'npm', 'tar', 'python3', 'flock', ...(prepare ? ['curl'] : [])]) await execute(tool, ['--version'], { capture: true });
  };
  if (prepare && selection.preview) localFail('LOCAL_ARGUMENTS_INVALID');
  const result = await runLocalBuild({ source, workspace, prepare, prerequisites, ...selection });
  console.log(JSON.stringify(result));
  if (!selection.preview) console.error('构建与安装包校验成功。部署：sudo bash scripts/deploy-local.sh' + (workspace ? ` --workspace ${JSON.stringify(workspace)}` : ''));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  localBuildMain(process.argv.slice(2)).catch(error => { console.error(error.code?.startsWith('BUILD_') ? buildFailureMessage(error) : error.message); process.exitCode = 1; });
}
