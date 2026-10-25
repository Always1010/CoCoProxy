#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, realpath, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual, promisify } from 'node:util';

const execute = promisify(execFile);
const FILE_LIMIT = 256 * 1024 * 1024;
const TOTAL_LIMIT = 512 * 1024 * 1024;
const COUNT_LIMIT = 12000;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const dependenciesEqual = (a, b) => JSON.stringify(Object.entries(a ?? {}).sort()) === JSON.stringify(Object.entries(b ?? {}).sort());
const forbidden = new Set(['.local', '.git', '.links', '.cache', '.nuxt', '.output', 'coverage', 'dist', 'build', 'testfixtures', 'protocol-fixture']);
export class ReleaseStageError extends Error {
  constructor(code) { super(code); this.name = 'ReleaseStageError'; this.code = code; }
}
const fail = code => { throw new ReleaseStageError(code); };
const same = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
function safePath(value) {
  if (typeof value !== 'string' || !value || value.length > 1024 || isAbsolute(value) || value.includes('\\')) fail('UNSAFE_PATH');
  const parts = value.split('/');
  if (parts.length > 32 || parts.some(part => !part || part === '.' || part === '..'
    || /[\u0000-\u001f\u007f<>:"|?*]/u.test(part) || /[. ]$/u.test(part)
    || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part))) fail('UNSAFE_PATH');
  return parts;
}
function allowed(path) {
  return !safePath(path).some(part => forbidden.has(part.toLowerCase()) || part.toLowerCase() === 'node_modules');
}
function sensitive(path) {
  return safePath(path).some(part => /^\.env(?:\.|$)|^\.(?:npmrc|netrc|pypirc)$|\.(?:pem|key|p12|pfx|ya?ml)$/iu.test(part)
    || /^(?:credentials?|secrets?|admin|management|runtime|settings|config)\.json$/iu.test(part)
    || /sing[-_]?box/iu.test(part));
}
async function inspect(path) {
  try { return await lstat(path); } catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
}
async function noLinks(path, directory = true) {
  if (typeof path !== 'string' || !isAbsolute(path) || !same(resolve(path), path) || path === parse(path).root) fail('INPUT_PATH_INVALID');
  let current = parse(path).root;
  for (const part of relative(current, path).split(sep)) {
    current = join(current, part);
    const info = await inspect(current);
    if (!info || info.isSymbolicLink() || (!same(current, path) && !info.isDirectory())) fail('INPUT_LINK_OR_MISSING');
  }
  const info = await lstat(path);
  if (directory ? !info.isDirectory() : !info.isFile()) fail('INPUT_TYPE_INVALID');
  if (!same(await realpath(path), path)) fail('INPUT_LINK_OR_MISSING');
  return path;
}
async function regular(path, limit = FILE_LIMIT) {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > limit) fail('FILE_INVALID');
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const start = await handle.stat();
    if (!start.isFile() || start.ino !== before.ino || start.dev !== before.dev || start.size > limit) fail('FILE_CHANGED');
    const bytes = await handle.readFile();
    const end = await handle.stat();
    if (bytes.length !== start.size || end.size !== start.size || end.mtimeMs !== start.mtimeMs || end.ctimeMs !== start.ctimeMs) fail('FILE_CHANGED');
    return bytes;
  } finally { await handle.close(); }
}
async function git(root, args, binary = false) {
  const result = await execute('git', ['-C', root, ...args], { encoding: binary ? 'buffer' : 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 30000 });
  return result.stdout;
}
function json(bytes) { try { return JSON.parse(bytes.toString('utf8')); } catch { fail('JSON_INVALID'); } }
async function walk(root, prefix = '', result = []) {
  for (const name of (await readdir(prefix ? join(root, ...safePath(prefix)) : root)).sort()) {
    const path = prefix ? `${prefix}/${name}` : name;
    safePath(path);
    if (safePath(path).some(part => ['.local', '.git', '.links', '.cache', '.nuxt', '.output'].includes(part.toLowerCase())) || sensitive(path)) fail('RUNTIME_FILE_FORBIDDEN');
    const target = join(root, ...safePath(path));
    const info = await lstat(target);
    if (info.isSymbolicLink()) fail('INPUT_LINK_OR_MISSING');
    if (info.isDirectory()) await walk(root, path, result);
    else if (info.isFile()) result.push(path);
    else fail('FILE_INVALID');
    if (result.length > COUNT_LIMIT) fail('PAYLOAD_LIMIT');
  }
  return result;
}
function requireString(value, pattern) {
  if (typeof value !== 'string' || !pattern.test(value)) fail('REVIEW_INVALID');
  return value;
}

/** Assemble only a local payload. reviewedCoreSha256 is a code-only test seam; the CLI never accepts it. */
export async function stageExplicitRelease(options) {
  let staging;
  try {
    const { sourceDir, serverDir, runtimeDependencies, core, output } = options;
    await noLinks(sourceDir); await noLinks(serverDir); await noLinks(runtimeDependencies); await noLinks(core, false);
    if (typeof output !== 'string' || !isAbsolute(output) || !same(resolve(output), output) || output === parse(output).root) fail('OUTPUT_INVALID');
    const parent = await noLinks(dirname(output));
    safePath(relative(parent, output));
    if (await inspect(output)) fail('OUTPUT_EXISTS');
    for (const input of [sourceDir, serverDir, runtimeDependencies, core]) {
      const rel = relative(input, output);
      if (!rel || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))) fail('OUTPUT_OVERLAP');
    }
    if ((await git(sourceDir, ['rev-parse', '--show-toplevel'])).trim() !== sourceDir.replaceAll('\\', '/')) {
      const top = (await git(sourceDir, ['rev-parse', '--show-toplevel'])).trim();
      if (!same(resolve(top), sourceDir)) fail('SOURCE_ROOT_INVALID');
    }
    if ((await git(sourceDir, ['status', '--porcelain=v1', '--untracked-files=all'])).length) fail('SOURCE_DIRTY');
    const commit = requireString((await git(sourceDir, ['rev-parse', 'HEAD'])).trim(), /^[a-f0-9]{40,64}$/u);
    const tree = (await git(sourceDir, ['ls-tree', '-rz', '--full-tree', commit])).split('\0').filter(Boolean).map(line => {
      const match = /^(\d{6}) (blob|commit) ([a-f0-9]{40,64})\t(.+)$/u.exec(line);
      if (!match) fail('SOURCE_TREE_INVALID');
      safePath(match[4]);
      if (match[1] !== '100644' && match[1] !== '100755') fail('SOURCE_LINK_OR_SUBMODULE');
      return { mode: match[1] === '100755' ? '0755' : '0644', oid: match[3], path: match[4] };
    });
    if (tree.length > COUNT_LIMIT) fail('PAYLOAD_LIMIT');
    const entries = new Map(tree.map(entry => [entry.path, entry]));
    const blob = async path => {
      const entry = entries.get(path);
      if (!entry) fail('SOURCE_REQUIRED_FILE_MISSING');
      const bytes = await git(sourceDir, ['cat-file', 'blob', entry.oid], true);
      if (bytes.length > FILE_LIMIT) fail('PAYLOAD_LIMIT');
      return bytes;
    };
    const pkg = json(await blob('package.json'));
    const lockBytes = await blob('package-lock.json');
    const lock = json(lockBytes);
    const review = json(await blob('integrations/metacubexd/review.json'));
    if (review.schemaVersion !== 1) fail('REVIEW_INVALID');
    const coreReview = review.coreCandidate;
    const managementReview = review.management;
    const coreBytes = await regular(core);
    let reviewedHash = requireString(options.reviewedCoreSha256 ?? coreReview?.binarySha256, /^[a-f0-9]{64}$/u);
    let corePlatform;
    if (options.reviewedCoreSha256 === undefined && coreReview?.platforms !== undefined) {
      const catalog = coreReview.platforms;
      if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) fail('CORE_REVIEW_INVALID');
      const matches = Object.entries(catalog).filter(([, entry]) => entry?.binarySha256 === sha256(coreBytes));
      if (matches.length === 0) fail('CORE_HASH_MISMATCH');
      if (matches.length !== 1) fail('CORE_REVIEW_INVALID');
      const [name, entry] = matches[0];
      const expected = { 'linux-arm64': { architecture: 'arm64', machine: 183 }, 'linux-amd64-v1': { architecture: 'x64', machine: 62 } }[name];
      if (!expected || entry.architecture !== expected.architecture || entry.elfMachine !== expected.machine || entry.downloadedAssetVerified !== true) fail('CORE_REVIEW_INVALID');
      if (coreBytes.length < 20 || !coreBytes.subarray(0, 6).equals(Buffer.from([127, 69, 76, 70, 2, 1])) || coreBytes.readUInt16LE(18) !== expected.machine) fail('CORE_ARCH_MISMATCH');
      reviewedHash = requireString(entry.binarySha256, /^[a-f0-9]{64}$/u);
      corePlatform = name;
    }
    const coreCommit = requireString(coreReview?.commit, /^[a-f0-9]{40}$/u);
    const uiCommit = requireString(managementReview?.commit, /^[a-f0-9]{40}$/u);
    const coreTag = requireString(coreReview?.tag, /^v[0-9]+\.[0-9]+\.[0-9]+$/u);
    const uiTag = requireString(managementReview?.tag, /^v[0-9]+\.[0-9]+\.[0-9]+$/u);
    if (!/^[a-z0-9][a-z0-9._-]*$/u.test(pkg.name ?? '') || !/^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/u.test(pkg.version ?? '')
      || lock.lockfileVersion !== 3 || lock.name !== pkg.name || lock.version !== pkg.version
      || !dependenciesEqual(lock.packages?.['']?.dependencies, pkg.dependencies)
      || Object.keys(pkg.dependencies ?? {}).sort().join(',') !== 'ws,yaml') fail('LOCK_INVALID');
    const installed = json(await regular(join(runtimeDependencies, '.package-lock.json'), 1024 * 1024));
    const modules = new Map();
    const visit = name => {
      if (!/^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/u.test(name)) fail('DEPENDENCY_INVALID');
      if (modules.has(name)) return;
      const entry = lock.packages[`node_modules/${name}`];
      const snapshot = installed.packages?.[`node_modules/${name}`];
      if (!entry || entry.dev || entry.link || !/^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/u.test(entry.version)
        || !/^sha512-[a-zA-Z0-9+/]+=*$/u.test(entry.integrity ?? '')
        || snapshot?.version !== entry.version || snapshot?.integrity !== entry.integrity) fail('DEPENDENCY_LOCK_MISMATCH');
      modules.set(name, entry);
      for (const dependency of Object.keys(entry.dependencies ?? {})) visit(dependency);
      for (const peer of Object.keys(entry.peerDependencies ?? {})) if (!entry.peerDependenciesMeta?.[peer]?.optional) fail('DEPENDENCY_PEER_UNSUPPORTED');
      if (Object.keys(entry.optionalDependencies ?? {}).length) fail('DEPENDENCY_OPTIONAL_UNSUPPORTED');
    };
    for (const name of Object.keys(pkg.dependencies)) visit(name);
    async function moduleNames(root) {
      const names = [];
      for (const name of (await readdir(root)).sort()) {
        if (name === '.package-lock.json' || name === '.bin') continue;
        if (name.startsWith('@')) {
          await noLinks(join(root, name));
          for (const child of await readdir(join(root, name))) names.push(`${name}/${child}`);
        } else names.push(name);
      }
      return names;
    }
    for (const name of await moduleNames(runtimeDependencies)) {
      if (!lock.packages[`node_modules/${name}`]) fail('DEPENDENCY_UNKNOWN');
    }
    const serverModules = join(serverDir, 'server', 'node_modules');
    await noLinks(join(serverDir, 'server')); await noLinks(join(serverDir, 'public')); await noLinks(serverModules);
    if ((await moduleNames(serverModules)).sort().join(',') !== [...modules.keys()].sort().join(',')) fail('SERVER_DEPENDENCY_MISMATCH');
    staging = join(parent, `.coproxy-stage-${randomUUID()}`);
    await mkdir(staging, { mode: 0o700 });
    await chmod(staging, 0o700);
    const files = []; const names = new Set(); let total = 0;
    async function write(path, bytes, mode = '0644') {
      const parts = safePath(path); const key = path.toLowerCase();
      if (names.has(key)) fail('DUPLICATE_PATH');
      names.add(key); total += bytes.length;
      if (bytes.length > FILE_LIMIT || total > TOTAL_LIMIT || files.length >= COUNT_LIMIT) fail('PAYLOAD_LIMIT');
      const target = join(staging, ...parts);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      const handle = await open(target, 'wx', parseInt(mode, 8));
      try { await handle.writeFile(bytes); await handle.chmod(parseInt(mode, 8)); } finally { await handle.close(); }
      files.push({ path, sha256: sha256(bytes), size: bytes.length, mode });
    }
    for (const entry of tree) {
      if (!allowed(entry.path)) continue;
      const selected = /^(apps|packages)\//u.test(entry.path) || /^(package(?:-lock)?\.json|LICENSE(?:\.[A-Za-z0-9-]+)?|NOTICE(?:\.[A-Za-z0-9-]+)?)$/u.test(entry.path)
        || ['docs/deployment.md', 'docs/management-https.md', 'docs/release-staging.md', 'docs/router-cooperation.md',
          'docs/cooperating-router-requirements.md', 'docs/release-notes.md',
          'examples/deployment-plan.json', 'examples/automatic-gateway-deployment.json',
          'examples/nginx-management.conf', 'examples/coproxy-web.service'].includes(entry.path);
      if (selected) {
        if (sensitive(entry.path)) fail('SOURCE_FILE_FORBIDDEN');
        await write(`source/${entry.path}`, await blob(entry.path), entry.mode);
      }
    }
    for (const path of ['integrations/metacubexd/LICENSE', 'integrations/metacubexd/review.json', 'integrations/metacubexd/source-tree.json', 'integrations/metacubexd/README.md', 'integrations/mihomo/LICENSE']) {
      await write(`source/${path}`, await blob(path));
    }
    const dependencyVersions = {};
    for (const [name, entry] of modules) {
      const directory = await noLinks(join(runtimeDependencies, ...name.split('/')));
      const modulePackage = json(await regular(join(directory, 'package.json'), 1024 * 1024));
      if (modulePackage.name !== name || modulePackage.version !== entry.version
        || !dependenciesEqual(modulePackage.dependencies, entry.dependencies)) fail('DEPENDENCY_PACKAGE_MISMATCH');
      const paths = await walk(directory);
      if (!paths.some(path => /^(LICENSE|LICENCE|COPYING)(?:\.|$)/iu.test(path))) fail('DEPENDENCY_LICENSE_MISSING');
      const serverCopy = await noLinks(join(serverModules, ...name.split('/')));
      const tracedPaths = new Set(await walk(serverCopy));
      const rootPaths = new Set(paths);
      if (!tracedPaths.has('package.json') || [...tracedPaths].some(path => !rootPaths.has(path))) fail('SERVER_DEPENDENCY_MISMATCH');
      for (const path of paths) {
        const bytes = await regular(join(directory, ...safePath(path)));
        if (tracedPaths.has(path)) {
          const copied = await regular(join(serverCopy, ...safePath(path)));
          // Nitro trace prunes unused files and reformats package.json, but must
          // not alter any package metadata or the bytes of retained code.
          if (path === 'package.json' ? !isDeepStrictEqual(json(bytes), json(copied)) : sha256(bytes) !== sha256(copied)) fail('SERVER_DEPENDENCY_MISMATCH');
        }
        if (path.endsWith('.map')) continue;
        await write(`source/node_modules/${name}/${path}`, bytes);
        await write(`server/.output/server/node_modules/${name}/${path}`, bytes);
      }
      dependencyVersions[name] = { version: entry.version, integrity: entry.integrity };
    }
    for (const area of ['server', 'public']) {
      for (const path of await walk(join(serverDir, area))) {
        if (area === 'server' && path.startsWith('node_modules/')) continue;
        if (path.endsWith('.map')) continue;
        if (area === 'server' && !/\.(?:mjs|cjs|js|json|wasm)$/iu.test(path)
          && !/(?:^|\/)(?:LICENSE|LICENCE|COPYING|NOTICE|README)(?:\.|$)/iu.test(path)) fail('SERVER_FILE_UNEXPECTED');
        await write(`server/.output/${area}/${path}`, await regular(join(serverDir, area, ...safePath(path))));
      }
    }
    if (!files.some(file => file.path === 'server/.output/server/index.mjs')) fail('SERVER_ENTRY_MISSING');
    if (sha256(coreBytes) !== reviewedHash) fail('CORE_HASH_MISMATCH');
    await write('bin/mihomo', coreBytes, '0755');
    const manifest = {
      schemaVersion: 1, scope: 'local-explicit-proxy-payload', commit,
      components: { coproxy: { version: pkg.version, lockSha256: sha256(lockBytes) },
        metacubexd: { version: uiTag, commit: uiCommit }, mihomo: { version: coreTag, commit: coreCommit, binarySha256: reviewedHash, ...(corePlatform ? { platform: corePlatform } : {}) },
        runtimeDependencies: dependencyVersions },
      sourceSelection: 'HEAD blobs: apps, packages, selected deployment docs/examples, root package metadata and license/source notices; no links or local/build data',
      files: files.sort((a, b) => a.path.localeCompare(b.path, 'en')),
    };
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
    if (manifestBytes.length > 8 * 1024 * 1024 || total + manifestBytes.length > TOTAL_LIMIT) fail('MANIFEST_LIMIT');
    const handle = await open(join(staging, 'manifest.json'), 'wx', 0o600);
    try { await handle.writeFile(manifestBytes); await handle.chmod(0o600); } finally { await handle.close(); }
    if ((await git(sourceDir, ['status', '--porcelain=v1', '--untracked-files=all'])).length
      || (await git(sourceDir, ['rev-parse', 'HEAD'])).trim() !== commit) fail('SOURCE_CHANGED');
    await noLinks(parent);
    if (await inspect(output)) fail('OUTPUT_EXISTS');
    await rename(staging, output); staging = undefined;
    return { staged: true, commit, fileCount: files.length, totalBytes: total, manifestSha256: sha256(manifestBytes) };
  } catch (error) {
    if (staging) await rm(staging, { recursive: true, force: true });
    if (error instanceof ReleaseStageError) throw error;
    fail('RELEASE_STAGE_FAILED');
  }
}

if (process.argv[1] && same(resolve(process.argv[1]), fileURLToPath(import.meta.url))) {
  const flags = { '--source-dir': 'sourceDir', '--server-dir': 'serverDir', '--runtime-dependencies': 'runtimeDependencies', '--core': 'core', '--output': 'output' };
  try {
    const options = {};
    const args = process.argv.slice(2);
    for (let i = 0; i < args.length; i += 2) {
      const key = flags[args[i]];
      if (!key || options[key] || !args[i + 1] || args[i + 1].startsWith('--')) fail('CLI_ARGUMENTS_INVALID');
      options[key] = args[i + 1];
    }
    if (Object.keys(options).length !== 5) fail('CLI_ARGUMENTS_INVALID');
    process.stdout.write(`${JSON.stringify(await stageExplicitRelease(options))}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof ReleaseStageError ? error.code : 'RELEASE_STAGE_FAILED'}\n`);
    process.exitCode = 1;
  }
}
