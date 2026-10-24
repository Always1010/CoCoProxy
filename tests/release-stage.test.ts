import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { ReleaseStageError, stageExplicitRelease, type StageExplicitReleaseOptions } from '../scripts/stage-explicit-release.mjs';

const execute = promisify(execFile);
const digest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
async function fixture(t: test.TestContext): Promise<StageExplicitReleaseOptions> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'coproxy-release-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceDir = join(root, 'repo'); const serverDir = join(root, 'nitro');
  const runtimeDependencies = join(root, 'dependencies'); const core = join(root, 'approved-core');
  const put = async (path: string, text: string) => { await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, text); };
  await put(join(sourceDir, 'apps/cli/main.ts'), 'console.log("synthetic");\n');
  await put(join(sourceDir, 'packages/runtime/start.ts'), 'export const fixture = true;\n');
  await put(join(sourceDir, '.gitignore'), '.local/\n');
  const dependencies = { ws: '1.0.0', yaml: '1.0.0' };
  const pkg = { name: 'synthetic-coproxy', version: '0.0.0', dependencies };
  const packages: Record<string, unknown> = { '': pkg };
  for (const name of ['ws', 'yaml']) {
    packages[`node_modules/${name}`] = { version: '1.0.0', integrity: `sha512-${Buffer.from(name).toString('base64')}` };
    for (const base of [runtimeDependencies, join(serverDir, 'server/node_modules')]) {
      await put(join(base, name, 'package.json'), JSON.stringify({ name, version: '1.0.0' }));
      await put(join(base, name, 'LICENSE'), `Synthetic ${name} license\n`);
      await put(join(base, name, 'dist/index.js'), 'export const synthetic = true;\n');
    }
  }
  await put(join(sourceDir, 'package.json'), JSON.stringify(pkg));
  await put(join(sourceDir, 'package-lock.json'), JSON.stringify({ ...pkg, lockfileVersion: 3, packages }));
  await put(join(runtimeDependencies, '.package-lock.json'), JSON.stringify({ packages }));
  await put(join(serverDir, 'server/index.mjs'), 'console.log("synthetic server");\n');
  await put(join(serverDir, 'server/index.mjs.map'), '{"sources":["/synthetic/private/build"]}');
  await put(join(serverDir, 'public/index.html'), '<h1>Synthetic</h1>');
  await put(join(serverDir, 'nitro.json'), '{"ignored":"/synthetic/build"}');
  await put(join(sourceDir, 'integrations/metacubexd/review.json'), JSON.stringify({ schemaVersion: 1,
    management: { tag: 'v1.2.3', commit: '1'.repeat(40) },
    coreCandidate: { tag: 'v4.5.6', commit: '2'.repeat(40), binarySha256: '0'.repeat(64) } }));
  for (const name of ['LICENSE', 'README.md', 'source-tree.json']) await put(join(sourceDir, 'integrations/metacubexd', name), `synthetic ${name}`);
  await put(join(sourceDir, 'integrations/mihomo/LICENSE'), 'synthetic GPL license');
  await put(join(sourceDir, '.local/private.json'), 'SYNTHETIC_PRIVATE_VALUE');
  await writeFile(core, 'synthetic reviewed core');
  await execute('git', ['init', sourceDir]);
  await execute('git', ['-C', sourceDir, 'add', '.']);
  await execute('git', ['-C', sourceDir, '-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture']);
  return { sourceDir, serverDir, runtimeDependencies, core, output: join(root, 'release'), reviewedCoreSha256: digest('synthetic reviewed core') };
}
async function rejects(action: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(action, (error: unknown) => error instanceof ReleaseStageError && error.code === code);
}

test('stages fixed HEAD runtime, complete production dependencies and reviewed core with a reproducible manifest', async t => {
  const options = await fixture(t);
  const receipt = await stageExplicitRelease(options);
  const bytes = await readFile(join(options.output, 'manifest.json'));
  const manifest = JSON.parse(bytes.toString()) as { commit: string; files: Array<{path: string; sha256: string; size: number; mode: string}> };
  assert.equal(receipt.manifestSha256, digest(bytes));
  assert.equal(manifest.commit, receipt.commit);
  assert.equal(receipt.fileCount, manifest.files.length);
  assert.ok(manifest.files.some(file => file.path === 'source/node_modules/yaml/dist/index.js'));
  assert.ok(manifest.files.some(file => file.path === 'source/integrations/mihomo/LICENSE'));
  assert.ok(manifest.files.every(file => !file.path.includes('.local') && !file.path.endsWith('.map') && !file.path.endsWith('nitro.json')));
  assert.ok(!bytes.toString().includes(options.sourceDir) && !bytes.toString().includes('SYNTHETIC_PRIVATE_VALUE'));
  for (const file of manifest.files) {
    const content = await readFile(join(options.output, file.path));
    assert.equal(content.length, file.size); assert.equal(digest(content), file.sha256);
    if (process.platform !== 'win32') assert.equal((await lstat(join(options.output, file.path))).mode & 0o777, parseInt(file.mode, 8));
  }
  if (process.platform !== 'win32') assert.equal((await lstat(options.output)).mode & 0o777, 0o700);
  await rejects(stageExplicitRelease(options), 'OUTPUT_EXISTS');
  assert.equal(digest(await readFile(join(options.output, 'manifest.json'))), receipt.manifestSha256);
});

test('rejects source drift and nonignored untracked input while leaving ignored local material outside the payload', async t => {
  const options = await fixture(t);
  await writeFile(join(options.sourceDir, 'apps/cli/main.ts'), 'drift');
  await rejects(stageExplicitRelease(options), 'SOURCE_DIRTY');
  await execute('git', ['-C', options.sourceDir, 'checkout', '--', 'apps/cli/main.ts']);
  await writeFile(join(options.sourceDir, 'unexpected.txt'), 'extra');
  await rejects(stageExplicitRelease(options), 'SOURCE_DIRTY');
});

test('accepts pruned Nitro traces with semantically unchanged package metadata and restores full locked packages', async t => {
  const options = await fixture(t);
  for (const name of ['ws', 'yaml']) {
    const directory = join(options.serverDir, 'server/node_modules', name);
    await rm(join(directory, 'LICENSE'));
    await rm(join(directory, 'dist'), { recursive: true });
    await writeFile(join(directory, 'package.json'), `${JSON.stringify({ version: '1.0.0', name }, null, 2)}\n`);
  }
  await stageExplicitRelease(options);
  const manifest = JSON.parse(await readFile(join(options.output, 'manifest.json'), 'utf8')) as { files: Array<{path: string; sha256: string}> };
  for (const name of ['ws', 'yaml']) {
    for (const path of ['LICENSE', 'dist/index.js', 'package.json']) {
      const original = await readFile(join(options.runtimeDependencies, name, path));
      for (const base of ['source/node_modules', 'server/.output/server/node_modules']) {
        const target = `${base}/${name}/${path}`;
        assert.deepEqual(await readFile(join(options.output, target)), original);
        assert.equal(manifest.files.find(file => file.path === target)?.sha256, digest(original));
      }
    }
  }
});

test('rejects wrong reviewed binary and cleans only its temporary staging directory', async t => {
  const options = await fixture(t);
  await writeFile(options.core, 'unapproved core');
  await rejects(stageExplicitRelease(options), 'CORE_HASH_MISMATCH');
  await assert.rejects(lstat(options.output), { code: 'ENOENT' });
  assert.ok((await readdir(join(options.output, '..'))).every(name => !name.startsWith('.coproxy-stage-')));
  assert.equal(await readFile(options.core, 'utf8'), 'unapproved core');
});

test('rejects lock drift, unknown runtime modules and changed or unknown Nitro trace files', async t => {
  for (const variant of ['lock', 'unknown', 'server-extra', 'server-drift', 'server-unknown-file', 'server-metadata'] as const) {
    await t.test(variant, async t => {
      const options = await fixture(t);
      if (variant === 'lock') await writeFile(join(options.runtimeDependencies, '.package-lock.json'), '{"packages":{}}');
      if (variant === 'unknown') await mkdir(join(options.runtimeDependencies, 'unknown'));
      if (variant === 'server-extra') await mkdir(join(options.serverDir, 'server/node_modules/unknown'));
      if (variant === 'server-drift') await writeFile(join(options.serverDir, 'server/node_modules/ws/dist/index.js'), 'drift');
      if (variant === 'server-unknown-file') await writeFile(join(options.serverDir, 'server/node_modules/ws/unknown.js'), 'unknown');
      if (variant === 'server-metadata') await writeFile(join(options.serverDir, 'server/node_modules/ws/package.json'), JSON.stringify({ name: 'ws', version: '1.0.1' }));
      await rejects(stageExplicitRelease(options), variant === 'lock' ? 'DEPENDENCY_LOCK_MISMATCH' : variant === 'unknown' ? 'DEPENDENCY_UNKNOWN' : 'SERVER_DEPENDENCY_MISMATCH');
      await assert.rejects(lstat(options.output), { code: 'ENOENT' });
    });
  }
});

test('rejects a linked Nitro directory, runtime secrets and special Git entries', async t => {
  await t.test('directory link', async t => {
    const options = await fixture(t);
    const linked = join(options.serverDir, 'public/linked');
    await symlink(join(options.sourceDir, 'apps'), linked, 'junction');
    await rejects(stageExplicitRelease(options), 'INPUT_LINK_OR_MISSING');
  });
  await t.test('runtime secret', async t => {
    const options = await fixture(t);
    await writeFile(join(options.serverDir, 'public/.env.production'), 'synthetic secret');
    await rejects(stageExplicitRelease(options), 'RUNTIME_FILE_FORBIDDEN');
  });
  await t.test('Git symlink', async t => {
    const options = await fixture(t);
    // A tracked mode-120000 entry is rejected from Git metadata, without opening its target.
    const oid = (await execute('git', ['-C', options.sourceDir, 'rev-parse', 'HEAD:package.json'])).stdout.trim();
    await execute('git', ['-C', options.sourceDir, 'update-index', '--add', '--cacheinfo', `120000,${oid},link`]);
    await execute('git', ['-C', options.sourceDir, '-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'link']);
    await execute('git', ['-C', options.sourceDir, 'update-index', '--skip-worktree', 'link']);
    await rejects(stageExplicitRelease(options), 'SOURCE_LINK_OR_SUBMODULE');
  });
});
