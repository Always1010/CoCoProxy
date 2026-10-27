#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants, fstatSync } from 'node:fs';
import { cp, lstat, mkdir, open, readFile, readdir, realpath, rm, symlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { backendInputSha256, reusedInputSha256, parseComponents } from '../packages/deployment/update-scope.mjs';

export function readBuildSelection(args) {
  const rest = []; let components = 'all'; let baseRelease; let preview = false; const seen = new Set();
  for (let index = 0; index < args.length; index++) {
    const option = args[index];
    if (!['--components', '--base-release', '--preview'].includes(option)) { rest.push(option); continue; }
    if (seen.has(option)) fail('BUILD_ARGUMENTS_INVALID');
    seen.add(option);
    if (option === '--preview') { preview = true; continue; }
    const value = args[++index];
    if (!value || value.startsWith('--')) fail('BUILD_ARGUMENTS_INVALID');
    if (option === '--components') components = parseComponents(value);
    else { if (!isAbsolute(value)) fail('BUILD_ARGUMENTS_INVALID'); baseRelease = value; }
  }
  if (baseRelease && components === 'all') fail('BUILD_ARGUMENTS_INVALID');
  return { rest, components, baseRelease, preview };
}

const pathKeys = ['workspace', 'source', 'mirror', 'snapshot', 'runtimeDependencies', 'toolingDependencies', 'upstreamArchive', 'upstreamDependencies', 'core', 'releases'];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = code => { throw Object.assign(new Error(code), { code }); };
export function buildFailureMessage(error) {
  const code = error.code?.startsWith('BUILD_') ? error.code : 'BUILD_FAILED';
  const guidance = {
    BUILD_FRONTEND_BASE_UPGRADE_REQUIRED: '旧安装缺少局部更新基线。请先不带 --components frontend 完成一次全量构建部署。',
    BUILD_FRONTEND_BACKEND_CHANGED: '前端以外的构建输入已变化，不能局部更新；请使用默认全量构建部署。',
    BUILD_FRONTEND_BASE_REQUIRED: '未找到可核验的管理服务基线；核对安装，或使用 --base-release 指定已有发行目录。',
    BUILD_COMPONENTS_UNSUPPORTED: '当前支持 --components all、frontend 或 backend。',
    BUILD_COMPONENT_BASE_UPGRADE_REQUIRED: '基线缺少组件复用摘要，请先完成一次全量构建部署。',
    BUILD_REUSED_INPUT_CHANGED: '本次未选择的组件输入已变化，请使用全量构建部署。',
  };
  return `${code}${guidance[code] ? '\n' + guidance[code] : ''}`;
}
const inside = (parent, child) => { const part = relative(parent, child); return part !== '' && part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part); };
const json = async path => JSON.parse((await regular(path)).toString('utf8'));
function relativePath(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || isAbsolute(value)
    || /[\x00-\x1f\x7f:]/u.test(value) || value.split('/').some(part => !part || ['.', '..', '.git', '.local', 'node_modules'].includes(part))) fail('BUILD_SELECTION_INVALID');
  return value;
}
async function stat(path) { try { return await lstat(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }
async function canonical(path, directory = true) {
  if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path || path === parse(path).root) fail('BUILD_PATH_INVALID');
  let current = parse(path).root;
  for (const part of relative(current, path).split(sep)) {
    current = join(current, part);
    const info = await lstat(current);
    if (info.isSymbolicLink() || (current !== path && !info.isDirectory())) fail('BUILD_PATH_LINK');
  }
  const info = await lstat(path);
  if (directory ? !info.isDirectory() : !info.isFile()) fail('BUILD_PATH_TYPE');
  if (await realpath(path) !== path) fail('BUILD_PATH_LINK');
}
async function regular(path) {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 256 * 1024 * 1024) fail('BUILD_FILE_INVALID');
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (opened.ino !== before.ino || opened.dev !== before.dev) fail('BUILD_FILE_CHANGED');
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (bytes.length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) fail('BUILD_FILE_CHANGED');
    return bytes;
  } finally { await handle.close(); }
}
export async function validateBuildConfig(config) {
  if (!config || typeof config !== 'object' || Object.keys(config).sort().join(',') !== [...pathKeys, 'expected'].sort().join(',')) fail('BUILD_CONFIG_INVALID');
  for (const key of pathKeys) await canonical(config[key], !['upstreamArchive', 'core'].includes(key));
  for (const key of ['source', 'mirror', 'snapshot', 'releases']) if (!inside(config.workspace, config[key])) fail('BUILD_PATH_SCOPE');
  for (const left of ['source', 'mirror', 'snapshot', 'releases']) {
    for (const right of pathKeys.filter(key => key !== 'workspace' && key !== left)) {
      if (config[left] === config[right] || inside(config[left], config[right]) || inside(config[right], config[left])) fail('BUILD_PATH_OVERLAP');
    }
  }
  const expected = config.expected;
  if (!expected || Object.keys(expected).sort().join(',') !== 'commit,dirs,files' || !/^[a-f0-9]{40}$/u.test(expected.commit)
    || !Array.isArray(expected.files) || !expected.files.length || !Array.isArray(expected.dirs)) fail('BUILD_SELECTION_INVALID');
  const files = new Set(); const dirs = new Set();
  for (const entry of expected.files) {
    if (!Array.isArray(entry) || entry.length !== 4) fail('BUILD_SELECTION_INVALID');
    const [path, size, sha256, executable] = entry;
    relativePath(path);
    if (!Number.isSafeInteger(size) || size < 0 || !/^[a-f0-9]{64}$/u.test(sha256) || typeof executable !== 'boolean' || files.has(path)) fail('BUILD_SELECTION_INVALID');
    files.add(path);
  }
  for (const path of expected.dirs) { relativePath(path); if (dirs.has(path) || files.has(path)) fail('BUILD_SELECTION_INVALID'); dirs.add(path); }
  const parents = new Set();
  for (const path of files) { let parent = dirname(path).replaceAll('\\', '/'); while (parent !== '.') { parents.add(parent); parent = dirname(parent).replaceAll('\\', '/'); } }
  if (parents.size !== dirs.size || [...parents].some(path => !dirs.has(path))) fail('BUILD_SELECTION_INVALID');
  return config;
}

/** Commands stream diagnostics to stderr, leaving stdout for the final receipt. */
export function executeBuildCommand(command, args, options = {}) {
  return new Promise((resolveCommand, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env ?? process.env, windowsHide: true,
      stdio: [options.input === undefined ? 'inherit' : 'pipe', options.capture ? 'pipe' : 2, 'inherit'] });
    const chunks = []; let bytes = 0;
    child.stdout?.on('data', chunk => { bytes += chunk.length; if (bytes > 32 * 1024 * 1024) child.kill(); else chunks.push(chunk); });
    child.on('error', () => reject(Object.assign(new Error('BUILD_COMMAND_FAILED'), { code: 'BUILD_COMMAND_FAILED' })));
    child.on('close', code => code === 0 ? resolveCommand(Buffer.concat(chunks).toString('utf8')) : reject(Object.assign(new Error('BUILD_COMMAND_FAILED'), { code: 'BUILD_COMMAND_FAILED' })));
    if (options.input !== undefined) { child.stdin.on('error', () => {}); child.stdin.end(options.input); }
  });
}
async function selection(root, expected, exemptions = new Map()) {
  const wanted = new Map(expected.files.map(entry => [entry[0], entry])); const dirs = new Set(expected.dirs); const seen = new Set();
  async function walk(prefix = '') {
    for (const name of await readdir(join(root, prefix))) {
      const path = prefix ? `${prefix}/${name}` : name; const target = join(root, path); const info = await lstat(target);
      if (exemptions.has(path)) {
        const expectedTarget = exemptions.get(path);
        if (expectedTarget === null) { if (!info.isDirectory() || info.isSymbolicLink()) fail('BUILD_SOURCE_CHANGED'); }
        else if (!info.isSymbolicLink() || await realpath(target) !== expectedTarget) fail('BUILD_DEPENDENCY_LINK_INVALID');
        continue;
      }
      if (info.isSymbolicLink()) fail('BUILD_SOURCE_LINK');
      if (info.isDirectory()) { if (!dirs.has(path)) fail('BUILD_SOURCE_CHANGED'); await walk(path); }
      else {
        const entry = wanted.get(path);
        if (!entry || !info.isFile() || info.size !== entry[1] || hash(await regular(target)) !== entry[2]
          || (process.platform !== 'win32' && Boolean(info.mode & 0o111) !== entry[3])) fail('BUILD_SOURCE_CHANGED');
        seen.add(path);
      }
    }
  }
  await canonical(root); await walk();
  if (seen.size !== wanted.size) fail('BUILD_SOURCE_CHANGED');
}
async function snapshot(config, execute) {
  const git = (args, options = {}) => execute('git', ['-C', config.snapshot, ...args], { capture: true, ...options });
  if (resolve((await git(['rev-parse', '--show-toplevel'])).trim()) !== config.snapshot
    || (await git(['status', '--porcelain=v1', '--untracked-files=all'])).length
    || (await git(['rev-parse', 'HEAD'])).trim() !== config.expected.commit) fail('BUILD_SNAPSHOT_CHANGED');
  const tree = new Map((await git(['ls-tree', '-rz', '--full-tree', 'HEAD'])).split('\0').filter(Boolean).map(line => {
    const match = /^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/u.exec(line);
    if (!match) fail('BUILD_SNAPSHOT_INVALID');
    return [match[3], { mode: match[1], oid: match[2] }];
  }));
  if (tree.size !== config.expected.files.length) fail('BUILD_SNAPSHOT_CHANGED');
  for (const [path, , , executable] of config.expected.files) {
    const entry = tree.get(path);
    if (!entry || entry.mode !== (executable ? '100755' : '100644')) fail('BUILD_SNAPSHOT_CHANGED');
    // Ask Git to apply the snapshot's clean rules, including reviewed CRLF normalization.
    const oid = (await git(['hash-object', '--path', path, '--stdin'], { input: await regular(join(config.source, path)) })).trim();
    if (oid !== entry.oid) fail('BUILD_SNAPSHOT_CHANGED');
  }
}
export async function verifyBuildInputs(config, execute = executeBuildCommand, workName) {
  const exemptions = new Map([['node_modules', config.runtimeDependencies], ['tooling/node_modules', config.toolingDependencies]]);
  if (workName) exemptions.set(workName, null);
  await selection(config.mirror, config.expected);
  await selection(config.source, config.expected, exemptions);
  await snapshot(config, execute);
}
async function dependencyLink(target, existing) {
  const info = await stat(target);
  if (info) {
    if (!info.isSymbolicLink() || await realpath(target) !== existing) fail('BUILD_DEPENDENCY_LINK_INVALID');
  } else await symlink(existing, target, process.platform === 'win32' ? 'junction' : 'dir');
}
export async function verifyBuiltRelease(output, receipt, expectedCommit) {
  await canonical(output);
  const bytes = await regular(join(output, 'manifest.json')); const manifest = JSON.parse(bytes.toString('utf8'));
  if (receipt?.staged !== true || receipt.commit !== expectedCommit || receipt.manifestSha256 !== hash(bytes)
    || manifest.schemaVersion !== 1 || manifest.commit !== expectedCommit || !Array.isArray(manifest.files) || !manifest.files.length
    || receipt.fileCount !== manifest.files.length) fail('BUILD_RECEIPT_INVALID');
  const expected = { files: [], dirs: [] }; const dirs = new Set();
  for (const entry of manifest.files) {
    const path = entry.path;
    // Runtime dependencies are permitted in an already assembled payload.
    if (typeof path !== 'string' || !path || isAbsolute(path) || path.includes('\\') || /[\x00-\x1f\x7f:]/u.test(path)
      || path.split('/').some(part => !part || ['.', '..', '.git', '.local'].includes(part))
      || !['0644', '0755'].includes(entry.mode) || !/^[a-f0-9]{64}$/u.test(entry.sha256)
      || !Number.isSafeInteger(entry.size) || entry.size < 0 || expected.files.some(file => file[0] === path) || path === 'manifest.json') fail('BUILD_MANIFEST_INVALID');
    expected.files.push([path, entry.size, entry.sha256, entry.mode === '0755']);
    let parent = dirname(path); while (parent !== '.') { dirs.add(parent); parent = dirname(parent); }
    const info = await lstat(join(output, path));
    if (process.platform !== 'win32' && (info.mode & 0o777) !== parseInt(entry.mode, 8)) fail('BUILD_PAYLOAD_MODE_INVALID');
  }
  expected.files.push(['manifest.json', bytes.length, hash(bytes), false]); expected.dirs = [...dirs];
  await selection(output, expected);
  return { ...receipt, output, components: manifest.frontendUpdate ? 'frontend' : manifest.componentUpdate?.components ?? 'all' };
}

export async function componentBaseline(config, baseRelease, execute, components) {
  if (!baseRelease) {
    const command = await execute('systemctl', ['show', 'cocoproxy-management.service', '--property=ExecStart', '--value'], { capture: true });
    const match = /path=\S+ ; argv\[\]=\S+ (\/[^\s;]+)\/server\/\.output\/server\/index\.mjs ;/u.exec(command);
    if (!match) fail('BUILD_FRONTEND_BASE_REQUIRED');
    baseRelease = match[1];
  }
  await canonical(baseRelease);
  const bytes = await regular(join(baseRelease, 'manifest.json')); const manifest = JSON.parse(bytes.toString('utf8'));
  const baseManifestSha256 = hash(bytes);
  await verifyBuiltRelease(baseRelease, { staged: true, commit: manifest.commit, manifestSha256: baseManifestSha256, fileCount: manifest.files?.length }, manifest.commit);
  const raw = await execute('git', ['-C', config.snapshot, 'ls-tree', '-rz', '--full-tree', 'HEAD'], { capture: true });
  const entries = raw.split('\0').filter(Boolean).map(line => {
    const match = /^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/u.exec(line);
    if (!match) fail('BUILD_SNAPSHOT_INVALID');
    return { mode: match[1] === '100755' ? '0755' : '0644', oid: match[2], path: match[3] };
  });
  if (components === 'frontend') {
    const backendSHA = backendInputSha256(entries);
    if (!manifest.buildInputs?.backendInputSha256) fail('BUILD_FRONTEND_BASE_UPGRADE_REQUIRED');
    if (manifest.buildInputs.backendInputSha256 !== backendSHA) fail('BUILD_FRONTEND_BACKEND_CHANGED');
    return { baseRelease, frontendUpdate: { schemaVersion: 1, baseManifestSha256, backendInputSha256: backendSHA } };
  }
  const reusedSHA = reusedInputSha256(entries, components);
  if (!manifest.buildInputs?.frontendInputSha256) fail('BUILD_COMPONENT_BASE_UPGRADE_REQUIRED');
  if (manifest.buildInputs.frontendInputSha256 !== reusedSHA) fail('BUILD_REUSED_INPUT_CHANGED');
  return { baseRelease, componentUpdate: { schemaVersion: 1, components, baseManifestSha256, reusedInputSha256: reusedSHA } };
}

/** The CLI holds the shared workspace lock for this entire operation. Injection is for synthetic orchestration tests. */
export async function runBuildRelease(config, { deploy = false, execute = executeBuildCommand, components = 'all', baseRelease, preview = false } = {}) {
  parseComponents(components);
  await validateBuildConfig(config);
  await verifyBuildInputs(config, execute);
  const baseline = components !== 'all' ? await componentBaseline(config, baseRelease, execute, components) : undefined;
  const { frontendUpdate, componentUpdate } = baseline ?? {};
  if (preview) return { preview: true, components, commit: config.expected.commit,
    build: components === 'frontend' ? ['frontend', 'server-public-assets'] : components === 'backend' ? ['backend', 'release'] : ['frontend', 'backend', 'release'],
    deployment: components === 'frontend' ? 'restart-management-and-dependent-https; preserve-core-and-network' : 'full-maintenance',
    ...(frontendUpdate ? { frontendUpdate } : {}), ...(componentUpdate ? { componentUpdate } : {}) };
  const catalog = await json(join(config.source, 'integrations/metacubexd/components.json'));
  const tooling = await json(join(config.source, 'tooling/package.json'));
  const installedPnpm = await json(join(config.toolingDependencies, 'pnpm/package.json'));
  const management = catalog.management;
  if (!management || !/^[a-f0-9]{64}$/u.test(management.sourceArchiveSha256) || !/^[a-f0-9]{64}$/u.test(management.lockfileSha256)
    || management.packageManager !== `pnpm@${tooling.dependencies?.pnpm}` || installedPnpm.version !== tooling.dependencies.pnpm
    || hash(await regular(config.upstreamArchive)) !== management.sourceArchiveSha256
    || hash(await regular(join(config.upstreamDependencies, 'pnpm-lock.yaml'))) !== management.lockfileSha256) fail('BUILD_DEPENDENCIES_MISMATCH');
  await dependencyLink(join(config.source, 'node_modules'), config.runtimeDependencies);
  await dependencyLink(join(config.source, 'tooling/node_modules'), config.toolingDependencies);
  const workName = `.build-release-${randomUUID()}`; const work = join(config.source, workName); const upstream = join(work, 'upstream');
  const output = join(config.releases, `${config.expected.commit.slice(0, 12)}-${randomUUID()}`);
  await mkdir(work, { mode: 0o700 });
  try {
    await mkdir(upstream);
    const env = { ...process.env, CI: 'true', NUXT_TELEMETRY_DISABLED: '1', UV_THREADPOOL_SIZE: '2', RAYON_NUM_THREADS: '2',
      NODE_OPTIONS: '--max-old-space-size=3072', UI_DIST: join(upstream, 'packages/ui/.output/public'),
      COCOPROXY_SOURCE_DIR: config.source, COCOPROXY_RUNTIME_DEPENDENCIES: config.runtimeDependencies };
    const command = (name, args, options = {}) => execute(name, args, { cwd: config.source, env, ...options });
    const node = (args, options) => command(process.execPath, args, options);
    const pnpm = args => node([join(config.toolingDependencies, 'pnpm/bin/pnpm.cjs'), '--dir', upstream, ...args]);
    await command('tar', ['-xzf', config.upstreamArchive, '--strip-components=1', '-C', upstream]);
    await node(['scripts/verify-git-tree.mjs', '--directory', upstream, '--manifest', join(config.source, 'integrations/metacubexd/source-tree.json')]);
    if (hash(await regular(join(upstream, 'pnpm-lock.yaml'))) !== management.lockfileSha256) fail('BUILD_UPSTREAM_LOCK_CHANGED');
    await node(['scripts/apply-metacubexd-overlay.mjs', '--directory', upstream]);
    for (const path of ['node_modules', 'packages/ui/node_modules', 'packages/agent/node_modules', 'packages/config-editor/node_modules', 'apps/server/node_modules']) {
      const existing = join(config.upstreamDependencies, path);
      if (!(await lstat(existing)).isDirectory()) fail('BUILD_DEPENDENCY_MISSING');
      await dependencyLink(join(upstream, path), existing);
    }
    if (components !== 'frontend') await command('npm', ['run', 'typecheck']);
    if (components === 'backend') await cp(join(baseline.baseRelease, 'server/.output/public'), env.UI_DIST, { recursive: true });
    else {
      await pnpm(['--filter', '@metacubexd/ui', 'generate']);
      await node(['scripts/typecheck-metacubexd-ui.mjs', '--directory', upstream]);
    }
    await pnpm(['--filter', '@metacubexd/server', 'build']);
    if (hash(await regular(join(upstream, 'pnpm-lock.yaml'))) !== management.lockfileSha256
      || hash(await regular(join(config.upstreamDependencies, 'pnpm-lock.yaml'))) !== management.lockfileSha256) fail('BUILD_UPSTREAM_LOCK_CHANGED');
    await verifyBuildInputs(config, execute, workName);
    const receipt = JSON.parse(await node([join(config.snapshot, 'scripts/stage-explicit-release.mjs'), '--source-dir', config.snapshot,
      '--server-dir', join(upstream, 'apps/server/.output'), '--runtime-dependencies', config.runtimeDependencies, '--core', config.core, '--output', output,
      ...(frontendUpdate ? ['--frontend-update', JSON.stringify(frontendUpdate)] : []),
      ...(componentUpdate ? ['--component-update', JSON.stringify(componentUpdate)] : [])], { capture: true }));
    const result = await verifyBuiltRelease(output, receipt, config.expected.commit);
    await verifyBuildInputs(config, execute, workName);
    if (deploy) {
      await command('sudo', [process.execPath, join(output, 'source/scripts/deploy-ssh.mjs'), '--local', '--payload', output,
        '--manifest-sha256', result.manifestSha256]);
    }
    return { ...result, deployed: deploy };
  } finally { await rm(work, { recursive: true, force: true }); }
}

export async function buildReleaseMain(deploy = false) {
  let lock;
  try {
    if (process.argv.slice(2).includes('--help')) {
      console.log('已准备工作区：node scripts/build-release.mjs --config ABSOLUTE_JSON [--components all|frontend|backend] [--base-release ABSOLUTE_RELEASE] [--preview]\n一步构建部署：node scripts/build-deploy.mjs，参数相同。普通克隆仓库使用 bash scripts/build-release.sh。'); return;
    }
    const { rest: args, ...selection } = readBuildSelection(process.argv.slice(2));
    const internal = args.length === 4 && args[2] === '--internal-lock' && args[3] === process.env.COCOPROXY_BUILD_LOCK_TOKEN;
    if ((!internal && args.length !== 2) || args[0] !== '--config' || !isAbsolute(args[1] ?? '') || process.platform !== 'linux') fail('BUILD_ARGUMENTS_INVALID');
    await canonical(args[1], false);
    const config = await validateBuildConfig(await json(args[1]));
    const lockPath = join(config.workspace, '.workspace-sync.lock');
    if (internal) {
      delete process.env.COCOPROXY_BUILD_LOCK_TOKEN;
      const inherited = fstatSync(3); const current = await lstat(lockPath);
      if (!current.isFile() || current.isSymbolicLink() || inherited.dev !== current.dev || inherited.ino !== current.ino) fail('BUILD_LOCK_INVALID');
      // Lock the inherited open file description itself. Even a direct internal
      // invocation must acquire the real workspace lock before doing any work.
      const acquire = spawn('flock', ['--nonblock', '3'], { stdio: ['ignore', 2, 2, 3], windowsHide: true });
      await new Promise((resolveLock, reject) => { acquire.on('error', reject); acquire.on('close', code => code === 0 ? resolveLock() : reject(Object.assign(new Error('BUILD_LOCK_BUSY'), { code: 'BUILD_LOCK_BUSY' }))); });
      process.stdout.write(`${JSON.stringify(await runBuildRelease(config, { deploy, ...selection }))}\n`);
    } else {
      lock = await open(lockPath, constants.O_CREAT | constants.O_RDWR | (constants.O_NOFOLLOW ?? 0), 0o600);
      if (!(await lock.stat()).isFile()) fail('BUILD_LOCK_INVALID');
      const token = randomUUID();
      const child = spawn(process.execPath, [fileURLToPath(new URL(deploy ? './build-deploy.mjs' : './build-release.mjs', import.meta.url)),
        '--config', args[1], '--internal-lock', token, '--components', selection.components,
        ...(selection.baseRelease ? ['--base-release', selection.baseRelease] : []), ...(selection.preview ? ['--preview'] : [])], { stdio: ['inherit', 'inherit', 'inherit', lock.fd],
        env: { ...process.env, COCOPROXY_BUILD_LOCK_TOKEN: token }, windowsHide: true });
      const code = await new Promise((resolveChild, reject) => { child.on('error', reject); child.on('close', code => resolveChild(code)); });
      if (code !== 0) process.exitCode = Number.isInteger(code) && code > 0 ? code : 1;
    }
  } catch (error) {
    process.stderr.write(`${buildFailureMessage(error)}\n`); process.exitCode = 1;
  } finally { await lock?.close(); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildReleaseMain();
