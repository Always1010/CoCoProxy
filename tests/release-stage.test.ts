import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { ReleaseStageError, stageExplicitRelease, type StageExplicitReleaseOptions } from '../scripts/stage-explicit-release.mjs';
import { DEPLOYMENT_STATE_COMPATIBILITY } from '../packages/deployment/state-compatibility.mjs';

const execute = promisify(execFile);
const digest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
async function fixture(t: test.TestContext): Promise<StageExplicitReleaseOptions> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cocoproxy-release-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceDir = join(root, 'repo'); const serverDir = join(root, 'nitro');
  const runtimeDependencies = join(root, 'dependencies'); const core = join(root, 'approved-core');
  const put = async (path: string, text: string) => { await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, text); };
  await put(join(sourceDir, 'apps/cli/main.ts'), 'console.log("synthetic");\n');
  await put(join(sourceDir, 'apps/setup/main.ts'), 'console.log("synthetic setup");\n');
  await put(join(sourceDir, 'packages/runtime/start.ts'), 'export const fixture = true;\n');
  await put(join(sourceDir, 'packages/deployment/state-compatibility.mjs'), await readFile(new URL('../packages/deployment/state-compatibility.mjs', import.meta.url), 'utf8'));
  await put(join(sourceDir, 'docs/deployment.md'), 'Synthetic role deployment instructions\n');
  await put(join(sourceDir, 'docs/cooperating-router-requirements.md'), 'Synthetic independent product and router capabilities\n');
  await put(join(sourceDir, 'docs/release-notes.md'), 'Synthetic fixed-version release scope and known limitations\n');
  for (const name of ['setup.md', 'getting-started.md', 'usage.md', 'notifications.md', 'architecture.md', 'development.md']) {
    await put(join(sourceDir, 'docs', name), 'Synthetic documentation\n');
  }
  for (const name of ['architecture-overview.svg', 'runtime-relations.svg', 'proxy-traffic-flow.svg']) {
    await put(join(sourceDir, 'docs/images', name), '<svg xmlns="http://www.w3.org/2000/svg"/>\n');
  }
  await put(join(sourceDir, 'examples/nginx-management.conf'), '# Synthetic HTTPS role template\n');
  await put(join(sourceDir, 'examples/deployment-options.md'), 'Synthetic trusted performance options\n');
  await put(join(sourceDir, 'scripts/measure-latency.mjs'), 'console.log("synthetic latency baseline");\n');
  await put(join(sourceDir, 'scripts/cocoproxy-setup.sh'), '#!/bin/sh\nexit 0\n');
  await put(join(sourceDir, '.gitignore'), '.local/\n');
  const dependencies = { 'web-push': '1.0.0', ws: '1.0.0', yaml: '1.0.0' };
  const pkg = { name: 'synthetic-cocoproxy', version: '0.0.0', dependencies };
  const packages: Record<string, unknown> = { '': pkg };
  for (const name of ['web-push', 'ws', 'yaml']) {
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
  const catalog = JSON.parse(await readFile(new URL('../integrations/metacubexd/components.json', import.meta.url), 'utf8'));
  Object.assign(catalog.management, { tag: 'v1.2.3', commit: '1'.repeat(40) });
  Object.assign(catalog.mihomo, { tag: 'v4.5.6', commit: '2'.repeat(40) });
  for (const [platform, value] of Object.entries(catalog.mihomo.platforms) as Array<[string, any]>) {
    value.asset = `mihomo-${platform}-v4.5.6.gz`;
    value.downloadUrl = `${catalog.mihomo.repository}/releases/download/v4.5.6/${value.asset}`;
  }
  await put(join(sourceDir, 'integrations/metacubexd/components.json'), JSON.stringify(catalog));
  await put(join(sourceDir, 'integrations/metacubexd/review.json'), JSON.stringify({ schemaVersion: 1,
    management: { ...catalog.management, sourceTreeVerified: true, sourceFileCount: 1 },
    coreCandidate: { ...catalog.mihomo, ...catalog.mihomo.platforms['linux-arm64'],
      platforms: Object.fromEntries(Object.entries(catalog.mihomo.platforms).map(([name, entry]) => [name, { ...(entry as any), downloadedAssetVerified: true }])) } }));
  await put(join(sourceDir, 'integrations/metacubexd/source-tree.json'), JSON.stringify({commit: catalog.management.commit,
    truncated: false, files: [{path: 'synthetic.ts', sha: '3'.repeat(40), mode: '100644'}] }));
  for (const name of ['LICENSE', 'README.md']) await put(join(sourceDir, 'integrations/metacubexd', name), `synthetic ${name}`);
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
  const manifest = JSON.parse(bytes.toString()) as { commit: string; compatibility: unknown; files: Array<{path: string; sha256: string; size: number; mode: string}> };
  assert.deepEqual(manifest.compatibility, DEPLOYMENT_STATE_COMPATIBILITY);
  assert.equal(receipt.manifestSha256, digest(bytes));
  assert.equal(manifest.commit, receipt.commit);
  assert.equal(receipt.fileCount, manifest.files.length);
  assert.ok(manifest.files.some(file => file.path === 'source/node_modules/yaml/dist/index.js'));
  assert.ok(manifest.files.some(file => file.path === 'server/.output/server/node_modules/web-push/dist/index.js'));
  assert.ok(manifest.files.some(file => file.path === 'source/integrations/mihomo/LICENSE'));
  assert.ok(manifest.files.some(file => file.path === 'source/docs/deployment.md'));
  assert.ok(manifest.files.some(file => file.path === 'source/docs/cooperating-router-requirements.md'));
  assert.ok(manifest.files.some(file => file.path === 'source/docs/release-notes.md'));
  for (const path of ['getting-started.md', 'usage.md', 'notifications.md', 'architecture.md', 'development.md', 'images/architecture-overview.svg',
    'images/runtime-relations.svg', 'images/proxy-traffic-flow.svg']) {
    assert.ok(manifest.files.some(file => file.path === `source/docs/${path}`));
  }
  assert.ok(manifest.files.some(file => file.path === 'source/examples/nginx-management.conf'));
  assert.ok(manifest.files.some(file => file.path === 'source/examples/deployment-options.md'));
  assert.ok(manifest.files.some(file => file.path === 'source/scripts/measure-latency.mjs'));
  assert.ok(manifest.files.some(file => file.path === 'cocoproxy' && file.mode === '0755'));
  assert.ok(manifest.files.some(file => file.path === 'README.md'));
  assert.ok(manifest.files.some(file => file.path === 'source/integrations/metacubexd/components.json'));
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

test('real built server traces the complete locked push dependency closure for release assembly', {
  skip: !process.env.COCOPROXY_TEST_RUNTIME_DEPENDENCIES || !process.env.COCOPROXY_TEST_SERVER_OUTPUT,
}, async t => {
  const options = await fixture(t);
  options.runtimeDependencies = process.env.COCOPROXY_TEST_RUNTIME_DEPENDENCIES!;
  options.serverDir = process.env.COCOPROXY_TEST_SERVER_OUTPUT!;
  for (const name of ['package.json', 'package-lock.json']) {
    await writeFile(join(options.sourceDir, name), await readFile(new URL(`../${name}`, import.meta.url)));
  }
  await mkdir(join(options.sourceDir, 'integrations/http-ece'), { recursive: true });
  for (const name of ['LICENSE', 'README.md']) await writeFile(join(options.sourceDir, 'integrations/http-ece', name), await readFile(new URL(`../integrations/http-ece/${name}`, import.meta.url)));
  await execute('git', ['-C', options.sourceDir, 'add', 'package.json', 'package-lock.json', 'integrations/http-ece']);
  await execute('git', ['-C', options.sourceDir, '-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'locked production fixture']);
  await stageExplicitRelease(options);
  const manifest = JSON.parse(await readFile(join(options.output, 'manifest.json'), 'utf8'));
  assert.ok(manifest.files.some((file: { path: string }) => file.path === 'server/.output/server/node_modules/web-push/src/index.js'));
  assert.ok(manifest.files.some((file: { path: string }) => file.path === 'server/.output/server/node_modules/http_ece/ece.js'));
  assert.equal(digest(await readFile(join(options.output, 'server/.output/server/node_modules/http_ece/LICENSE'))), '7d71f48c474da1de82fbdaac7fea5a1eaa41e4ac998dd44fd2897812812138d9');
  assert.ok(manifest.files.every((file: { path: string }) => !file.path.endsWith('.yml')));
  const push = createRequire(join(options.output, 'server/.output/server/package.json'))('web-push');
  const keys = push.generateVAPIDKeys();
  const encrypted = push.generateRequestDetails({ endpoint: 'https://fcm.googleapis.com/wp/synthetic-release', keys: {
    p256dh: keys.publicKey, auth: Buffer.alloc(16, 3).toString('base64url') } }, '合成发行测试', {
    vapidDetails: { ...keys, subject: 'https://management.example' }, TTL: 300 });
  assert.ok(encrypted.body.length > 0);
  await writeFile(join(options.sourceDir, 'integrations/http-ece/LICENSE'), 'tampered synthetic license');
  await execute('git', ['-C', options.sourceDir, 'add', 'integrations/http-ece/LICENSE']);
  await execute('git', ['-C', options.sourceDir, '-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'tampered license fixture']);
  await rejects(stageExplicitRelease({ ...options, output: options.output + '-rejected' }), 'DEPENDENCY_LICENSE_MISSING');
});

test('rejects source drift and nonignored untracked input while leaving ignored local material outside the payload', async t => {
  const options = await fixture(t);
  await writeFile(join(options.sourceDir, 'apps/cli/main.ts'), 'drift');
  await rejects(stageExplicitRelease(options), 'SOURCE_DIRTY');
  await execute('git', ['-C', options.sourceDir, 'checkout', '--', 'apps/cli/main.ts']);
  await writeFile(join(options.sourceDir, 'unexpected.txt'), 'extra');
  await rejects(stageExplicitRelease(options), 'SOURCE_DIRTY');
});

test('rejects mismatched release metadata, missing bootstrap and broken offline navigation before publishing output', async t => {
  for (const [variant, expected] of [
    ['metadata', 'COMPONENT_REVIEW_MISMATCH'], ['compatibility', 'COMPATIBILITY_SOURCE_MISMATCH'],
    ['bootstrap', 'SOURCE_REQUIRED_FILE_MISSING'], ['documentation', 'DOCUMENT_LINK_MISSING'],
  ] as const) {
    await t.test(variant, async t => {
      const options = await fixture(t);
      if (variant === 'metadata') {
        const path = join(options.sourceDir, 'integrations/metacubexd/review.json');
        const review = JSON.parse(await readFile(path, 'utf8'));
        review.management.lockfileSha256 = 'f'.repeat(64);
        await writeFile(path, JSON.stringify(review));
      }
      if (variant === 'compatibility') await writeFile(join(options.sourceDir, 'packages/deployment/state-compatibility.mjs'), 'export const unsupported = true;\n');
      if (variant === 'bootstrap') await rm(join(options.sourceDir, 'scripts/cocoproxy-setup.sh'));
      if (variant === 'documentation') await writeFile(join(options.sourceDir, 'docs/deployment.md'), '[missing](private-not-shipped.md)\n');
      await execute('git', ['-C', options.sourceDir, 'add', '-u']);
      await execute('git', ['-C', options.sourceDir, '-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'invalid release fixture']);
      await rejects(stageExplicitRelease(options), expected);
      await assert.rejects(lstat(options.output), { code: 'ENOENT' });
      assert.ok((await readdir(join(options.output, '..'))).every(name => !name.startsWith('.cocoproxy-stage-')));
    });
  }
});

test('accepts pruned Nitro traces with semantically unchanged package metadata and restores full locked packages', async t => {
  const options = await fixture(t);
  for (const name of ['web-push', 'ws', 'yaml']) {
    const directory = join(options.serverDir, 'server/node_modules', name);
    await rm(join(directory, 'LICENSE'));
    await rm(join(directory, 'dist'), { recursive: true });
    await writeFile(join(directory, 'package.json'), `${JSON.stringify({ version: '1.0.0', name }, null, 2)}\n`);
  }
  await stageExplicitRelease(options);
  const manifest = JSON.parse(await readFile(join(options.output, 'manifest.json'), 'utf8')) as { files: Array<{path: string; sha256: string}> };
  for (const name of ['web-push', 'ws', 'yaml']) {
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
  assert.ok((await readdir(join(options.output, '..'))).every(name => !name.startsWith('.cocoproxy-stage-')));
  assert.equal(await readFile(options.core, 'utf8'), 'unapproved core');
});

test('fixed platform catalog selects both reviewed ELF architectures and refuses a mislabeled binary', async t => {
  for (const [platform, architecture, machine] of [['linux-arm64', 'arm64', 183], ['linux-amd64-v1', 'x64', 62]] as const) {
    await t.test(platform, async t => {
      const options = await fixture(t);
      delete options.reviewedCoreSha256;
      const core = Buffer.alloc(20); Buffer.from([127, 69, 76, 70, 2, 1]).copy(core); core.writeUInt16LE(machine, 18);
      await writeFile(options.core, core);
      const path = join(options.sourceDir, 'integrations/metacubexd/review.json');
      const review = JSON.parse(await readFile(path, 'utf8'));
      review.coreCandidate.platforms[platform].binarySha256 = digest(core);
      if (platform === 'linux-arm64') review.coreCandidate.binarySha256 = digest(core);
      await writeFile(path, JSON.stringify(review));
      const catalogPath = join(options.sourceDir, 'integrations/metacubexd/components.json');
      const catalog = JSON.parse(await readFile(catalogPath, 'utf8'));
      catalog.mihomo.platforms[platform].binarySha256 = digest(core);
      await writeFile(catalogPath, JSON.stringify(catalog));
      await execute('git', ['-C', options.sourceDir, 'add', 'integrations/metacubexd/review.json', 'integrations/metacubexd/components.json']);
      await execute('git', ['-C', options.sourceDir, '-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'platform fixture']);
      await stageExplicitRelease(options);
      const manifest = JSON.parse(await readFile(join(options.output, 'manifest.json'), 'utf8'));
      assert.equal(manifest.components.mihomo.platform, platform);
      assert.equal(manifest.components.mihomo.binarySha256, digest(core));
      assert.equal(manifest.components.mihomo.commit, '2'.repeat(40));
    });
  }
  await t.test('ELF machine must match the fixed reviewed platform', async t => {
    const options = await fixture(t); delete options.reviewedCoreSha256;
    const core = Buffer.alloc(20); Buffer.from([127, 69, 76, 70, 2, 1]).copy(core); core.writeUInt16LE(62, 18);
    await writeFile(options.core, core);
    const path = join(options.sourceDir, 'integrations/metacubexd/review.json');
    const review = JSON.parse(await readFile(path, 'utf8'));
    review.coreCandidate.platforms['linux-arm64'].binarySha256 = digest(core);
    review.coreCandidate.binarySha256 = digest(core);
    await writeFile(path, JSON.stringify(review));
    const catalogPath = join(options.sourceDir, 'integrations/metacubexd/components.json');
    const catalog = JSON.parse(await readFile(catalogPath, 'utf8'));
    catalog.mihomo.platforms['linux-arm64'].binarySha256 = digest(core);
    await writeFile(catalogPath, JSON.stringify(catalog));
    await execute('git', ['-C', options.sourceDir, 'add', 'integrations/metacubexd/review.json', 'integrations/metacubexd/components.json']);
    await execute('git', ['-C', options.sourceDir, '-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'mislabeled platform fixture']);
    await rejects(stageExplicitRelease(options), 'CORE_ARCH_MISMATCH');
    await assert.rejects(lstat(options.output), { code: 'ENOENT' });
  });
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
