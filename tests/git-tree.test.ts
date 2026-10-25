import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { GitTreeError, verifyGitTree } from '../scripts/verify-git-tree.mjs';

type Mode = '100644' | '100755' | '120000';
type Manifest = { commit: string; truncated: false; files: Array<{ path: string; sha: string; mode: Mode }> };

const commit = '0123456789abcdef0123456789abcdef01234567';

function blobSha(content: string | Buffer): string {
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

function manifest(files: Manifest['files']): Manifest {
  return { commit, truncated: false, files };
}

async function fixture(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'cocoproxy-git-tree-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function expectCode(action: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(action, (error: unknown) => {
    assert.ok(error instanceof GitTreeError);
    assert.equal(error.code, code);
    assert.ok(!error.message.includes(tmpdir()));
    return true;
  });
}

test('accepts exact regular and executable Git blobs while ignoring only root Git metadata', async t => {
  const root = await fixture(t);
  await mkdir(join(root, 'bin'), { recursive: true });
  await mkdir(join(root, '.git'), { recursive: true });
  await writeFile(join(root, 'README.md'), 'synthetic source\n');
  await writeFile(join(root, 'bin', 'run.sh'), '#!/bin/sh\nexit 0\n');
  await chmod(join(root, 'README.md'), 0o644);
  await chmod(join(root, 'bin', 'run.sh'), 0o755);
  await writeFile(join(root, '.git', 'index'), 'ignored metadata');
  const input = manifest([
    { path: 'README.md', sha: blobSha('synthetic source\n'), mode: '100644' },
    { path: 'bin/run.sh', sha: blobSha('#!/bin/sh\nexit 0\n'), mode: '100755' },
  ]);
  assert.deepEqual(await verifyGitTree(root, input), { verified: true, commit, fileCount: 2 });
});

test('rejects changed content, extra files, and mismatched executable mode', async t => {
  await t.test('changed content', async t => {
    const root = await fixture(t);
    await writeFile(join(root, 'source.txt'), 'changed');
    await expectCode(verifyGitTree(root, manifest([{ path: 'source.txt', sha: blobSha('original'), mode: '100644' }])), 'TREE_MISMATCH');
  });
  await t.test('extra file', async t => {
    const root = await fixture(t);
    await writeFile(join(root, 'source.txt'), 'source');
    await writeFile(join(root, 'extra.txt'), 'extra');
    await expectCode(verifyGitTree(root, manifest([{ path: 'source.txt', sha: blobSha('source'), mode: '100644' }])), 'TREE_MISMATCH');
  });
  await t.test('wrong mode', async t => {
    const root = await fixture(t);
    await writeFile(join(root, 'run.sh'), '#!/bin/sh\n');
    await chmod(join(root, 'run.sh'), 0o644);
    await expectCode(verifyGitTree(root, manifest([{ path: 'run.sh', sha: blobSha('#!/bin/sh\n'), mode: '100755' }])), 'TREE_MISMATCH');
  });
});

test('rejects traversal, duplicate paths, and non-lowercase or malformed object ids in manifests', async t => {
  const root = await fixture(t);
  const valid = { path: 'source.txt', sha: blobSha('source'), mode: '100644' as const };
  for (const input of [
    manifest([{ ...valid, path: '../source.txt' }]),
    manifest([valid, { ...valid }]),
    manifest([{ ...valid, sha: valid.sha.toUpperCase() }]),
    { ...manifest([valid]), commit: 'not-an-object-id' },
  ]) {
    await expectCode(verifyGitTree(root, input), 'MANIFEST_INVALID');
  }
});

test('never follows a file or directory symlink and rejects links escaping the source tree', async t => {
  const outside = await fixture(t);
  await writeFile(join(outside, 'outside.txt'), 'outside content');

  await t.test('regular blob replaced by symlink', async t => {
    const root = await fixture(t);
    await symlink(join(outside, 'outside.txt'), join(root, 'source.txt'));
    await expectCode(verifyGitTree(root, manifest([{ path: 'source.txt', sha: blobSha('outside content'), mode: '100644' }])), 'TREE_MISMATCH');
  });
  await t.test('directory replaced by symlink', async t => {
    const root = await fixture(t);
    await symlink(outside, join(root, 'nested'), 'dir');
    await expectCode(verifyGitTree(root, manifest([{ path: 'nested/outside.txt', sha: blobSha('outside content'), mode: '100644' }])), 'TREE_MISMATCH');
  });
  await t.test('Git symlink target escapes root', async t => {
    const root = await fixture(t);
    await symlink('../outside.txt', join(root, 'link'));
    await expectCode(verifyGitTree(root, manifest([{ path: 'link', sha: blobSha('../outside.txt'), mode: '120000' }])), 'TREE_MISMATCH');
  });
});
