import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compileConfig } from '../packages/config/index.ts';
import type { JsonObject } from '../packages/config/index.ts';
import { DraftStore, DraftError } from '../packages/drafts/index.ts';
import { FileTransactionStore } from '../packages/transaction/index.ts';

function input(label = 'first'): JsonObject {
  return {
    schemaVersion: 1,
    deployment: {
      mixedPort: 17890, controllerPort: 17891, dnsPort: 17892,
      controllerSecret: 'synthetic-private-value', bootstrapResolvers: ['192.0.2.53'],
    },
    policy: {
      rules: ['MATCH,DIRECT'], description: label,
      proxies: [{ name: 'synthetic-node', type: 'ss', server: 'node.example.invalid', port: 443, password: 'synthetic-private-value' }],
      custom: { url: 'https://source.example.invalid/synthetic-private-value', nested: [true, null, 123] },
    },
  };
}

async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'cocoproxy-drafts-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, 'store');
  return { root, store: new DraftStore(root), transactions: new FileTransactionStore(root) };
}

const code = (expected: string) => (error: unknown): boolean => {
  assert.ok(error instanceof DraftError);
  assert.equal(error.code, expected);
  assert.equal(error.message, expected);
  assert.ok(!String(error).includes('synthetic-private-value'));
  assert.ok(!JSON.stringify(error).includes('example.invalid'));
  return true;
};

test('absent metadata and load are read-only; the initial save compares revision zero', async t => {
  const { root, store } = await fixture(t);
  assert.equal(await store.metadata(), null);
  await assert.rejects(store.load(0), code('DRAFT_NOT_FOUND'));
  await assert.rejects(stat(root), { code: 'ENOENT' });
  await assert.rejects(store.save(input(), 1), code('DRAFT_CONFLICT'));
  assert.equal(await store.metadata(), null);
  const saved = await store.save(input(), 0);
  assert.equal(saved.revision, 1);
  assert.equal(saved.generation, compileConfig(input()).sha256);
  assert.deepEqual(await store.metadata(), saved);
  assert.deepEqual(await store.load(1), { revision: 1, input: input(), generation: saved.generation });
});

test('CAS refuses stale saves and loads without changing the saved snapshot', async t => {
  const { store } = await fixture(t);
  await store.save(input('first'), 0);
  await assert.rejects(store.save(input('stale'), 0), code('DRAFT_CONFLICT'));
  const saved = await store.save(input('second'), 1);
  assert.equal(saved.revision, 2);
  await assert.rejects(store.load(1), code('DRAFT_CONFLICT'));
  assert.deepEqual((await store.load(2)).input, input('second'));
  for (const revision of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(store.save(input(), revision), code('INVALID_DRAFT_REVISION'));
    await assert.rejects(store.load(revision), code('INVALID_DRAFT_REVISION'));
  }
});

test('simultaneous writers cannot lose an update and a stale retry conflicts', async t => {
  const { root, store } = await fixture(t);
  await store.save(input('seed'), 0);
  const results = await Promise.allSettled([
    store.save(input('writer-a'), 1), new DraftStore(root).save(input('writer-b'), 1),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const failure = results.find(result => result.status === 'rejected') as PromiseRejectedResult;
  assert.ok(failure.reason instanceof DraftError);
  assert.ok(['STORE_LOCKED', 'DRAFT_CONFLICT'].includes(failure.reason.code));
  assert.equal((await store.metadata())?.revision, 2);
  const saved = (await store.load(2)).input;
  assert.ok(['writer-a', 'writer-b'].includes((saved.policy as JsonObject).description as string));
  await assert.rejects(store.save(input('retry'), 1), code('DRAFT_CONFLICT'));
});

test('saving is separate from staging, active generation and pending recovery', async t => {
  const { root, store, transactions } = await fixture(t);
  const saved = await store.save(input(), 0);
  assert.deepEqual(await readdir(join(root, 'candidates')), []);
  await assert.rejects(stat(join(root, 'state.json')), { code: 'ENOENT' });
  const pendingState = {
    version: 1 as const, desired: saved.generation, active: null,
    pending: { id: '00000000-0000-4000-8000-000000000000', previous: null, target: saved.generation, phase: 'activating' as const },
    fault: null, checkedAt: null,
  };
  await transactions.writeState(pendingState);
  const stateBefore = await readFile(join(root, 'state.json'), 'utf8');
  const statusBefore = await transactions.status();
  await store.save(input('newer-draft'), 1);
  assert.equal(await readFile(join(root, 'state.json'), 'utf8'), stateBefore);
  assert.deepEqual(await transactions.status(), statusBefore);
  assert.deepEqual(await readdir(join(root, 'candidates')), []);
});

test('draft input and metadata share no mutable references with callers', async t => {
  const { store } = await fixture(t);
  const original = input();
  const saving = store.save(original, 0);
  (original.policy as JsonObject).description = 'mutated-after-save-call';
  const metadata = await saving;
  const generation = metadata.generation;
  metadata.generation = 'changed-by-caller';
  const loaded = await store.load(1);
  assert.deepEqual(loaded.input, input());
  (loaded.input.policy as JsonObject).description = 'mutated-loaded-copy';
  assert.deepEqual((await store.load(1)).input, input());
  assert.equal((await store.metadata())?.generation, generation);
});

test('corrupt digest, invalid input and malformed document metadata are rejected', async t => {
  const { root, store } = await fixture(t);
  await store.save(input(), 0);
  const path = join(root, 'draft.json');
  const document = JSON.parse(await readFile(path, 'utf8'));
  const badDocuments = [
    { ...document, generation: '0'.repeat(64) },
    { ...document, revision: 0 },
    { ...document, revision: 1.5 },
    { ...document, updatedAt: 'invalid-synthetic-private-value' },
    { ...document, version: 2 },
    { ...document, input: { schemaVersion: 1 } },
    { ...document, extra: 'synthetic-private-value' },
  ];
  for (const bad of badDocuments) {
    await writeFile(path, JSON.stringify(bad), { mode: 0o600 });
    await assert.rejects(store.metadata(), code('DRAFT_CORRUPT'));
    await assert.rejects(store.load(1), code('DRAFT_CORRUPT'));
    await assert.rejects(store.save(input('replacement'), 1), code('DRAFT_CORRUPT'));
  }
  await writeFile(path, '{"synthetic-private-value":', { mode: 0o600 });
  await assert.rejects(store.metadata(), code('DRAFT_CORRUPT'));
});

test('public metadata and errors never expose input and invalid drafts are not written', async t => {
  const { root, store } = await fixture(t);
  const invalid = input();
  (invalid.policy as JsonObject)['external-ui-url'] = 'https://source.example.invalid/synthetic-private-value';
  await assert.rejects(store.save(invalid, 0), code('PROTECTED_FIELD'));
  await assert.rejects(stat(root), { code: 'ENOENT' });
  const saved = await store.save(input(), 0);
  assert.deepEqual(Object.keys(saved).sort(), ['generation', 'revision', 'updatedAt']);
  assert.ok(!JSON.stringify(await store.metadata()).includes('synthetic-private-value'));
  assert.ok(!JSON.stringify(await store.metadata()).includes('example.invalid'));
  assert.throws(() => new DraftStore('relative/synthetic-private-value'), code('INVALID_STORE_PATH'));
  const oversized = input();
  (oversized.policy as JsonObject).description = '\u0000'.repeat(800_000);
  await assert.rejects(store.save(oversized, 1), code('STORE_LIMIT'));
  assert.equal((await store.metadata())?.revision, 1);
});

test('drafts use private POSIX modes and reject broad permissions and symlinks', { skip: process.platform === 'win32' }, async t => {
  const { root, store } = await fixture(t);
  await store.save(input(), 0);
  const path = join(root, 'draft.json');
  assert.equal((await stat(root)).mode & 0o777, 0o700);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  await chmod(path, 0o644);
  await assert.rejects(store.metadata(), code('UNSAFE_STORE'));
  await chmod(path, 0o600);
  await chmod(root, 0o755);
  await assert.rejects(store.metadata(), code('UNSAFE_STORE'));
  assert.equal((await stat(root)).mode & 0o777, 0o755);
  await chmod(root, 0o700);
  const contents = await readFile(path, 'utf8');
  const target = join(root, 'private-target.json');
  await writeFile(target, contents, { mode: 0o600 });
  await rm(path);
  await symlink(target, path);
  await assert.rejects(store.metadata(), code('UNSAFE_STORE'));
  await assert.rejects(store.save(input('replacement'), 1), code('UNSAFE_STORE'));
  assert.equal(await readFile(target, 'utf8'), contents);
});
