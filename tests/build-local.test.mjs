import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runLocalBuild } from '../scripts/build-local.mjs';
import { verifyBuildInputs } from '../scripts/build-release.mjs';
import { readLocalBuild, readLocalJSON, resolveLocalPaths, runLocalCommand, withLocalBuildLock } from '../scripts/local-release-state.mjs';

const repository = fileURLToPath(new URL('../', import.meta.url));
const sha = data => createHash('sha256').update(data).digest('hex');
async function fixture(t) {
  const temporary = await mkdtemp(join(tmpdir(), 'local-build-test-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const source = join(temporary, 'project'); await mkdir(source);
  for (const name of ['integrations/metacubexd/components.json', 'integrations/metacubexd/review.json', 'integrations/metacubexd/source-tree.json', 'tooling/package.json', 'tooling/package-lock.json']) {
    await mkdir(dirname(join(source, name)), { recursive: true }); await copyFile(join(repository, name), join(source, name));
  }
  await writeFile(join(source, '.gitignore'), 'node_modules/\n');
  const git = args => runLocalCommand('git', ['-C', source, '-c', 'core.hooksPath=/dev/null', ...args], { capture: true });
  await git(['init', '--quiet']); await git(['add', '.']);
  await git(['-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid', 'commit', '-qm', 'fixture']);
  let prepared = 0;
  const inputs = async () => { prepared++; return { upstreamArchive: '/synthetic/archive', upstreamDependencies: '/synthetic/deps', core: '/synthetic/core', platform: 'linux-arm64' }; };
  const build = async config => {
    await verifyBuildInputs(config);
    const output = join(config.releases, randomUUID()); await mkdir(output);
    await mkdir(join(output, 'source'));
    const bytes = Buffer.from('synthetic payload');
    await writeFile(join(output, 'source/main.mjs'), bytes); await chmod(join(output, 'source/main.mjs'), 0o644);
    const manifest = Buffer.from(JSON.stringify({ schemaVersion: 1, commit: config.expected.commit,
      files: [{ path: 'source/main.mjs', size: bytes.length, sha256: sha(bytes), mode: '0644' }] }));
    await writeFile(join(output, 'manifest.json'), manifest, { mode: 0o600 });
    return { staged: true, deployed: false, output, commit: config.expected.commit, fileCount: 1, manifestSha256: sha(manifest) };
  };
  return { source, inputs, build, prepared: () => prepared };
}

test('fresh Git clone needs no private workspace; a failed rebuild retires the old deploy receipt', { skip: process.platform !== 'linux' }, async t => {
  const state = await fixture(t);
  await assert.rejects(lstat(join(state.source, '.local')), { code: 'ENOENT' });
  const result = await runLocalBuild({ ...state, prepare: true });
  assert.equal(result.status, 'ready');
  assert.equal((await readLocalBuild({ source: state.source })).output, result.output);
  await assert.rejects(runLocalBuild({ ...state, build: async () => { throw new Error('synthetic build failure'); } }), /synthetic build failure/);
  await assert.rejects(readLocalBuild({ source: state.source }), { code: 'LOCAL_BUILD_NOT_READY' });
  const paths = await resolveLocalPaths(state.source);
  assert.equal((await readLocalJSON(paths.receipt)).status, 'failed');
  await lstat(result.output);
});

test('dirty source stops before dependency preparation', { skip: process.platform !== 'linux' }, async t => {
  const state = await fixture(t);
  await writeFile(join(state.source, 'uncommitted.txt'), 'must not build');
  await assert.rejects(runLocalBuild({ ...state, prepare: true }), { code: 'LOCAL_SOURCE_DIRTY' });
  assert.equal(state.prepared(), 0);
});

test('local build and deployment use the same nonblocking lock', { skip: process.platform !== 'linux' }, async t => {
  const state = await fixture(t);
  const paths = await resolveLocalPaths(state.source);
  await withLocalBuildLock(paths, async () => {
    await assert.rejects(withLocalBuildLock(paths, async () => assert.fail('busy lock entered')), { code: 'LOCAL_BUILD_LOCK_LOST' });
  });
});
