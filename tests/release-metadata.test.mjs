import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { validateReleaseMetadata, validateReleaseTooling, validateReleaseVersion } from '../scripts/release-metadata.mjs';
import { assertReleaseSourcePaths, releaseIntegrationFiles, releaseReadme, selectedReleaseSource, verifyDocumentationLinks } from '../scripts/release-layout.mjs';

const project = fileURLToPath(new URL('../', import.meta.url));
const metadata = async () => Promise.all(['components', 'review', 'source-tree'].map(name =>
  readFile(new URL(`../integrations/metacubexd/${name}.json`, import.meta.url), 'utf8').then(JSON.parse)));

test('fixed release component catalog agrees with evidence and the exact source tree', async () => {
  const inputs = await metadata();
  const catalog = validateReleaseMetadata(...inputs);
  assert.deepEqual(Object.keys(catalog.mihomo.platforms).sort(), ['linux-amd64-v1', 'linux-arm64']);
  for (const mutation of [
    values => { values[0].mihomo.platforms['linux-arm64'].downloadUrl += '?latest'; },
    values => { values[1].coreCandidate.platforms['linux-amd64-v1'].binarySha256 = 'f'.repeat(64); },
    values => { values[1].management.lockfileSha256 = 'e'.repeat(64); },
    values => { values[2].commit = '1'.repeat(40); },
    values => { values[2].truncated = true; },
    values => { values[0].management.runtimeVerified = true; },
  ]) {
    const changed = structuredClone(inputs);
    mutation(changed);
    assert.throws(() => validateReleaseMetadata(...changed), error => /^COMPONENT/u.test(error.code));
  }
});

test('release tag, package lock and build package manager cannot describe different versions', async () => {
  const pkg = { name: 'synthetic', version: '1.2.3-preview.1' };
  const lock = { ...pkg, lockfileVersion: 3, packages: { '': pkg } };
  validateReleaseVersion(pkg, lock, 'v1.2.3-preview.1');
  for (const value of ['v1.2.3', 'v01.2.3-preview.1', 'v1.2.3-preview.01', 'v1.2.3-preview.1+build']) {
    assert.throws(() => validateReleaseVersion(pkg, lock, value), { code: 'RELEASE_VERSION_MISMATCH' });
  }
  assert.throws(() => validateReleaseVersion(pkg, { ...lock, packages: { '': { ...pkg, version: '0.0.0' } } }, 'v1.2.3-preview.1'),
    { code: 'RELEASE_LOCK_MISMATCH' });
  const [catalog] = await metadata();
  const tooling = JSON.parse(await readFile(new URL('../tooling/package.json', import.meta.url), 'utf8'));
  const toolingLock = JSON.parse(await readFile(new URL('../tooling/package-lock.json', import.meta.url), 'utf8'));
  validateReleaseTooling(catalog, tooling, toolingLock);
  assert.throws(() => validateReleaseTooling(catalog, { dependencies: { pnpm: '0.0.0' } }, toolingLock),
    { code: 'COMPONENT_TOOLING_MISMATCH' });
});

test('documentation resolves inline, image and reference links and rejects escaping or missing files', () => {
  assertReleaseSourcePaths(['docs/guide.md']);
  for (const path of ['.local/private.json', 'nested/.LOCAL/private.json']) {
    assert.throws(() => assertReleaseSourcePaths([path]), { code: 'SOURCE_LOCAL_DATA' });
  }
  const files = new Map([
    ['README.md', Buffer.from('[guide](docs/guide.md)\n![image](docs/diagram.svg)\n[reference]: docs/guide.md\n[directory](docs/)\n[web](https://example.invalid/a)\n')],
    ['docs/guide.md', Buffer.from('[home](../README.md#heading)')], ['docs/diagram.svg', Buffer.alloc(0)],
  ]);
  assert.equal(verifyDocumentationLinks(files).checked, 5);
  for (const target of ['absent.md', '../README.md', '%2e%2e/README.md', '/README.md']) {
    assert.throws(() => verifyDocumentationLinks(new Map([['README.md', Buffer.from(`[bad](${target})`)]])),
      { code: 'DOCUMENT_LINK_MISSING' });
  }
  assert.equal(verifyDocumentationLinks(new Map([['README.md', Buffer.from('```sh\n[label](absent.md)\n```')]])).checked, 0);
});

test('runtime release excludes project documentation and examples while retaining its short install guide', () => {
  const names = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { cwd: project, encoding: 'utf8', windowsHide: true }).split('\0').filter(Boolean);
  const selected = names.filter(path => selectedReleaseSource(path) || releaseIntegrationFiles.includes(path));
  assert.ok(!selected.some(path => path.split('/').includes('.local')));
  assert.ok(!selected.some(path => /^(?:docs|examples)\//u.test(path) || /^(?:apps|packages)\/.*\.md$/iu.test(path)));
  assert.ok(selected.includes('apps/setup/main.ts') && selected.includes('scripts/cocoproxy-setup.sh'));
  const files = new Map(selected.map(path => [`source/${path}`, Buffer.alloc(0)]));
  files.set('README.md', releaseReadme('0.0.0', '1'.repeat(40)));
  assert.deepEqual(verifyDocumentationLinks(files), { checked: 0 });
});
