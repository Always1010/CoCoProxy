import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { applyMetacubexdOverlay, OverlayError } from '../scripts/apply-metacubexd-overlay.mjs';

const commit = JSON.parse(await readFile(new URL('../integrations/metacubexd/components.json', import.meta.url), 'utf8')).management.commit;
const gitBlob = (text: string) => createHash('sha1').update(`blob ${Buffer.byteLength(text)}\0`).update(text).digest('hex');

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cocoproxy-overlay-')));
  const directory = join(root, 'upstream');
  const overlayDirectory = join(root, 'overlay');
  const manifestPath = join(root, 'source-tree.json');
  await mkdir(directory);
  await mkdir(overlayDirectory);
  const original = 'export const original = true;\n';
  const replacement = 'export const original = false;\n';
  await writeFile(join(directory, 'existing.ts'), original);
  await writeFile(join(overlayDirectory, 'existing.ts'), replacement);
  await writeFile(manifestPath, JSON.stringify({ commit, truncated: false, files: [
    { path: 'existing.ts', mode: '100644', sha: gitBlob(original) },
  ] }));
  return { root, directory, overlayDirectory, manifestPath, original, replacement };
}

const hasCode = (code: string) => (error: unknown) => error instanceof OverlayError && error.code === code;

test('overlay validates Git blobs, adds files, and is idempotent', async () => {
  const item = await fixture();
  try {
    await mkdir(join(item.overlayDirectory, 'pages'));
    await writeFile(join(item.overlayDirectory, 'pages', 'new.vue'), '<template>合成页面</template>\n');
    const first = await applyMetacubexdOverlay(item.directory, item);
    assert.equal(first.written, 2);
    assert.equal(await readFile(join(item.directory, 'existing.ts'), 'utf8'), item.replacement);
    assert.equal(await readFile(join(item.directory, 'pages', 'new.vue'), 'utf8'), '<template>合成页面</template>\n');
    const second = await applyMetacubexdOverlay(item.directory, item);
    assert.equal(second.written, 0);
    assert.equal(second.unchanged, 2);
  } finally { await rm(item.root, { recursive: true, force: true }); }
});

test('drift is rejected before any file in the batch changes', async () => {
  const item = await fixture();
  try {
    await writeFile(join(item.overlayDirectory, 'a-new.ts'), 'new\n');
    await writeFile(join(item.directory, 'existing.ts'), 'unrelated local edit\n');
    await assert.rejects(applyMetacubexdOverlay(item.directory, item), hasCode('SOURCE_DRIFT'));
    await assert.rejects(readFile(join(item.directory, 'a-new.ts')), { code: 'ENOENT' });
    assert.equal(await readFile(join(item.directory, 'existing.ts'), 'utf8'), 'unrelated local edit\n');
  } finally { await rm(item.root, { recursive: true, force: true }); }
});

test('unknown existing files cannot be overwritten by new overlay files', async () => {
  const item = await fixture();
  try {
    await writeFile(join(item.overlayDirectory, 'new.ts'), 'candidate\n');
    await writeFile(join(item.directory, 'new.ts'), 'unknown content\n');
    await assert.rejects(applyMetacubexdOverlay(item.directory, item), hasCode('SOURCE_DRIFT'));
    assert.equal(await readFile(join(item.directory, 'existing.ts'), 'utf8'), item.original);
    assert.equal(await readFile(join(item.directory, 'new.ts'), 'utf8'), 'unknown content\n');
  } finally { await rm(item.root, { recursive: true, force: true }); }
});

test('linked target directories cannot redirect writes outside the checkout', { skip: process.platform === 'win32' }, async () => {
  const item = await fixture();
  try {
    const outside = join(item.root, 'outside');
    await mkdir(outside);
    await mkdir(join(item.overlayDirectory, 'pages'));
    await writeFile(join(item.overlayDirectory, 'pages', 'new.vue'), 'new\n');
    await symlink(outside, join(item.directory, 'pages'));
    await assert.rejects(applyMetacubexdOverlay(item.directory, item), hasCode('UNSAFE_TARGET'));
    await assert.rejects(readFile(join(outside, 'new.vue')), { code: 'ENOENT' });
    assert.equal(await readFile(join(item.directory, 'existing.ts'), 'utf8'), item.original);
  } finally { await rm(item.root, { recursive: true, force: true }); }
});
