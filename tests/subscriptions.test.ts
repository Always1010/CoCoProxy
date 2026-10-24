import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, stat, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SubscriptionStore, SubscriptionError } from '../packages/subscriptions/index.ts';
import type { SnapshotClient, SnapshotResponse, SnapshotDecoder } from '../packages/subscriptions/index.ts';

const privateValue = 'synthetic-private-value';
const sourceUrl = `https://subscription.example/snapshot?token=${privateValue}`;
const text = JSON.stringify({ proxies: [{ name: 'example-node', type: 'ss', server: '192.0.2.1',
  port: 443, cipher: 'aes-128-gcm', password: privateValue }] });
const code = (expected: string) => (error: unknown): boolean => {
  assert.ok(error instanceof SubscriptionError);
  assert.equal(error.code, expected);
  assert.equal(error.message, expected);
  assert.ok(!String(error).includes(privateValue));
  assert.ok(!JSON.stringify(error).includes(privateValue));
  return true;
};

class Client implements SnapshotClient {
  calls: { url: string; previous?: { etag?: string } }[] = [];
  response: SnapshotResponse = { status: 'modified', text, etag: '"synthetic-etag"' };
  fails = false;
  async fetch(url: string, previous?: { etag?: string }): Promise<SnapshotResponse> {
    this.calls.push({ url, previous });
    if (this.fails) throw new Error(`${sourceUrl}: ${privateValue}`);
    return this.response;
  }
}

async function fixture(t: test.TestContext, decoder?: SnapshotDecoder) {
  const root = await mkdtemp(join(tmpdir(), 'coproxy-subscriptions-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const client = new Client();
  const store = new SubscriptionStore(root, client, decoder);
  return { root, client, store };
}

test('source registration and immutable snapshots expose only safe status metadata', async t => {
  const { root, client, store } = await fixture(t);
  const configured = await store.configure({ id: 'primary', url: sourceUrl }, 0);
  assert.deepEqual(configured, { id: 'primary', revision: 1, snapshotDigest: null,
    snapshotRevision: null, snapshotCurrent: false, lastAttempt: null, lastError: null });
  await assert.rejects(store.snapshot('primary'), code('SOURCE_PENDING'));
  const refreshed = await store.refresh('primary', 1);
  assert.equal(refreshed.revision, 2);
  assert.match(refreshed.snapshotDigest!, /^[a-f0-9]{64}$/);
  assert.equal(refreshed.snapshotRevision, 2);
  assert.equal(refreshed.snapshotCurrent, true);
  assert.equal(refreshed.lastError, null);
  const withoutTransport = new SubscriptionStore(root);
  await assert.rejects(withoutTransport.refresh('primary', 2), code('SOURCE_CLIENT_REQUIRED'));
  assert.equal((await withoutTransport.status('primary'))!.revision, 2);
  assert.ok(refreshed.lastAttempt);
  assert.ok(!JSON.stringify(refreshed).includes(privateValue));
  assert.ok(!JSON.stringify(refreshed).includes('etag'));
  const snapshot = await store.snapshot('primary');
  assert.equal(snapshot.proxies[0].password, privateValue);
  assert.equal(snapshot.sha256, refreshed.snapshotDigest);
  assert.equal(snapshot.sourceRevision, 2);
  snapshot.proxies[0].password = 'caller-mutation';
  assert.equal((await store.snapshot('primary')).proxies[0].password, privateValue);
  assert.equal(client.calls[0].url, sourceUrl);
  await assert.rejects(access(join(root, 'state.json')));
  if (process.platform !== 'win32') {
    assert.equal((await stat(join(root, 'subscriptions'))).mode & 0o777, 0o700);
    assert.equal((await stat(join(root, 'subscriptions', 'primary.json'))).mode & 0o777, 0o600);
  }
});

test('failed fetch, decode, protected nodes and unsupported top-level fields preserve the accepted snapshot and ETag', async t => {
  const { client, store } = await fixture(t);
  await store.configure({ id: 'primary', url: sourceUrl }, 0);
  const accepted = await store.refresh('primary', 1);
  const expected = await store.snapshot('primary');
  const attempts: { result?: SnapshotResponse; fails?: boolean; error: string }[] = [
    { fails: true, error: 'SOURCE_FETCH_FAILED' },
    { result: { status: 'modified', text: `${privateValue} invalid JSON` }, error: 'SNAPSHOT_DECODE_FAILED' },
    { result: { status: 'modified', text: JSON.stringify({ proxies: [{ name: 'blocked', type: 'ss', 'interface-name': privateValue }] }) }, error: 'SNAPSHOT_INVALID' },
    { result: { status: 'modified', text: JSON.stringify({ proxies: [], 'external-controller': privateValue }) }, error: 'SNAPSHOT_UNSUPPORTED' },
  ];
  let revision = accepted.revision;
  for (const attempt of attempts) {
    client.fails = attempt.fails ?? false;
    if (attempt.result) client.response = attempt.result;
    await assert.rejects(store.refresh('primary', revision), code(attempt.error));
    revision++;
    const current = (await store.status('primary'))!;
    assert.equal(current.revision, revision);
    assert.equal(current.lastError, attempt.error);
    assert.equal(current.snapshotDigest, accepted.snapshotDigest);
    assert.equal(current.snapshotCurrent, true);
    assert.deepEqual(await store.snapshot('primary'), expected);
    assert.deepEqual(client.calls.at(-1)!.previous, { etag: '"synthetic-etag"' });
    assert.ok(!JSON.stringify(current).includes(privateValue));
  }
  client.response = { status: 'not-modified' };
  const unchanged = await store.refresh('primary', revision);
  assert.equal(unchanged.revision, revision + 1);
  assert.equal(unchanged.lastError, null);
  assert.equal(unchanged.snapshotRevision, accepted.snapshotRevision);
});

test('source URL changes clear ETags and block old snapshots until a new modified response succeeds', async t => {
  const { root, client, store } = await fixture(t);
  await store.configure({ id: 'primary', url: sourceUrl }, 0);
  const accepted = await store.refresh('primary', 1);
  const changed = await store.configure({ id: 'primary', url: 'https://other.example/new?token=synthetic-other' }, 2);
  assert.equal(changed.revision, 3);
  assert.equal(changed.snapshotCurrent, false);
  assert.equal(changed.snapshotDigest, accepted.snapshotDigest);
  await assert.rejects(store.snapshot('primary'), code('SOURCE_PENDING'));
  client.response = { status: 'not-modified' };
  await assert.rejects(store.refresh('primary', 3), code('SOURCE_NOT_MODIFIED_WITHOUT_SNAPSHOT'));
  assert.equal(client.calls.at(-1)!.previous, undefined);
  assert.equal((await store.status('primary'))!.snapshotCurrent, false);
  const retained = JSON.parse(await readFile(join(root, 'subscriptions', 'primary.json'), 'utf8'));
  assert.equal(retained.snapshot.proxies[0].password, privateValue);
  assert.equal(retained.etag, null);
  client.response = { status: 'modified', text };
  assert.equal((await store.refresh('primary', 4)).snapshotCurrent, true);
  assert.equal((await store.snapshot('primary')).sourceRevision, 5);
});

test('304 without a conditional snapshot cannot create accepted data', async t => {
  const { client, store } = await fixture(t);
  await store.configure({ id: 'primary', url: sourceUrl }, 0);
  client.response = { status: 'not-modified' };
  await assert.rejects(store.refresh('primary', 1), code('SOURCE_NOT_MODIFIED_WITHOUT_SNAPSHOT'));
  assert.equal((await store.status('primary'))!.revision, 2);
  await assert.rejects(store.snapshot('primary'), code('SOURCE_PENDING'));
});

test('CAS rejects stale configure and stale refresh before fetching', async t => {
  const { client, store } = await fixture(t);
  await store.configure({ id: 'primary', url: sourceUrl }, 0);
  await assert.rejects(store.configure({ id: 'primary', url: sourceUrl }, 0), code('SOURCE_CONFLICT'));
  await assert.rejects(store.refresh('primary', 0), code('SOURCE_CONFLICT'));
  assert.deepEqual(client.calls, []);
  const refreshed = await store.refresh('primary', 1);
  await assert.rejects(store.snapshot('primary', 1), code('SOURCE_CONFLICT'));
  assert.equal((await store.snapshot('primary', refreshed.revision)).sha256, refreshed.snapshotDigest);
  const reconfigured = await store.configure({ id: 'primary', url: sourceUrl }, refreshed.revision);
  await assert.rejects(store.snapshot('primary', refreshed.revision), code('SOURCE_CONFLICT'));
  assert.equal((await store.snapshot('primary', reconfigured.revision)).sourceRevision, refreshed.revision);
});

test('configure captures plain input before awaiting and rejects accessors without invoking them', async t => {
  const { client, store } = await fixture(t);
  const input = { id: 'primary', url: sourceUrl };
  const pending = store.configure(input, 0);
  input.id = 'changed';
  input.url = 'http://mutated.example/denied';
  const configured = await pending;
  assert.equal(configured.id, 'primary');
  assert.equal(await store.status('changed'), null);
  assert.equal(Object.isFrozen(input), false);
  await store.refresh('primary', 1);
  assert.equal(client.calls[0].url, sourceUrl);

  let invoked = false;
  const accessor = { id: 'accessor', get url() { invoked = true; return sourceUrl; } };
  await assert.rejects(store.configure(accessor, 0), code('INVALID_SOURCE_INPUT'));
  assert.equal(invoked, false);
  const inherited = Object.create({ id: 'inherited', url: sourceUrl });
  await assert.rejects(store.configure(inherited, 0), code('INVALID_SOURCE_INPUT'));
  assert.equal(await store.status('accessor'), null);
});

test('URL bounds match the HTTPS client and invalid response ETags are dropped without losing accepted bodies', async t => {
  const { client, store } = await fixture(t);
  const prefix = 'https://subscription.example/';
  const boundaryUrl = prefix + 'a'.repeat(8192 - prefix.length);
  await assert.rejects(store.configure({ id: 'oversized', url: boundaryUrl + 'a' }, 0), code('INVALID_SOURCE_URL'));
  await store.configure({ id: 'primary', url: boundaryUrl }, 0);
  const valid = 'v'.repeat(512);
  client.response = { status: 'modified', text, etag: valid };
  await store.refresh('primary', 1);
  client.response = { status: 'not-modified' };
  await store.refresh('primary', 2);
  assert.equal(client.calls.at(-1)!.previous?.etag, valid);
  let revision = 3;
  for (const invalid of ['x'.repeat(513), 'invalid\u0001tag', 'invalid\ntag', 'invalid\u007ftag', 'invalid非ASCII']) {
    client.response = { status: 'modified', text, etag: invalid };
    const accepted = await store.refresh('primary', revision++);
    assert.equal(accepted.lastError, null);
    assert.equal(accepted.snapshotCurrent, true);
    client.response = { status: 'modified', text };
    await store.refresh('primary', revision++);
    assert.equal(client.calls.at(-1)!.previous, undefined);
  }
});

test('downloads hold no lock and late responses cannot overwrite a newer definition or refresh', async t => {
  const { root } = await fixture(t);
  const calls: { resolve: (value: SnapshotResponse) => void }[] = [];
  let entered!: () => void;
  let entry = new Promise<void>(resolve => { entered = resolve; });
  const client: SnapshotClient = {
    fetch: async () => new Promise<SnapshotResponse>(resolve => { calls.push({ resolve }); entered(); }),
  };
  const store = new SubscriptionStore(root, client);
  await store.configure({ id: 'primary', url: sourceUrl }, 0);
  const late = store.refresh('primary', 1);
  await entry;
  await store.configure({ id: 'primary', url: 'https://other.example/snapshot' }, 1);
  const lateRejected = assert.rejects(late, code('SOURCE_CONFLICT'));
  calls[0].resolve({ status: 'modified', text });
  await lateRejected;
  assert.equal((await store.status('primary'))!.revision, 2);
  assert.equal((await store.status('primary'))!.snapshotDigest, null);

  entry = new Promise<void>(resolve => { entered = resolve; });
  const first = store.refresh('primary', 2);
  await entry;
  entry = new Promise<void>(resolve => { entered = resolve; });
  const second = store.refresh('primary', 2);
  await entry;
  calls[1].resolve({ status: 'modified', text });
  const winner = await first;
  const secondRejected = assert.rejects(second, code('SOURCE_CONFLICT'));
  calls[2].resolve({ status: 'modified', text: JSON.stringify({ proxies: [] }) });
  await secondRejected;
  assert.equal((await store.status('primary'))!.revision, 3);
  assert.equal((await store.snapshot('primary')).sha256, winner.snapshotDigest);
});

test('tampered snapshot hashes fail closed for status, compile input and further writes', async t => {
  const { root, store } = await fixture(t);
  await store.configure({ id: 'primary', url: sourceUrl }, 0);
  await store.refresh('primary', 1);
  const path = join(root, 'subscriptions', 'primary.json');
  const corrupt = JSON.parse(await readFile(path, 'utf8'));
  corrupt.snapshot.proxies[0].password = 'tampered';
  await writeFile(path, JSON.stringify(corrupt));
  await assert.rejects(store.status('primary'), code('SOURCE_CORRUPT'));
  await assert.rejects(store.snapshot('primary'), code('SOURCE_CORRUPT'));
  await assert.rejects(store.refresh('primary', 2), code('SOURCE_CORRUPT'));
  await assert.rejects(store.configure({ id: 'primary', url: sourceUrl }, 2), code('SOURCE_CORRUPT'));
});

test('invalid IDs and URLs reject traversal and credentials while status reads never initialize missing roots', async t => {
  const { root, client } = await fixture(t);
  const missing = join(root, 'missing');
  const store = new SubscriptionStore(missing, client);
  assert.equal(await store.status('primary'), null);
  await assert.rejects(store.snapshot('primary'), code('SOURCE_NOT_FOUND'));
  for (const id of ['../escape', 'a/b', 'a\\b', '.', '', '1source', 'a'.repeat(65)]) {
    await assert.rejects(store.configure({ id, url: sourceUrl }, 0), code('INVALID_SOURCE_ID'));
    await assert.rejects(store.status(id), code('INVALID_SOURCE_ID'));
  }
  for (const url of ['http://subscription.example/x', 'https://user:secret@subscription.example/x',
    'https://@subscription.example/x', 'https://subscription.example/x#secret', 'https://subscription.example/x#', 'file:///secret']) {
    await assert.rejects(store.configure({ id: 'primary', url }, 0), code('INVALID_SOURCE_URL'));
  }
  await assert.rejects(access(missing));
});

test('injected decoders still pass the strict offline safety boundary and response limits retain old data', async t => {
  let decoded: unknown = JSON.parse(text);
  const { client, store } = await fixture(t, () => decoded);
  await store.configure({ id: 'primary', url: sourceUrl }, 0);
  const accepted = await store.refresh('primary', 1);
  decoded = { proxies: [{ name: 'unsafe', type: 'ss', 'plugin-opts': { command: privateValue } }] };
  await assert.rejects(store.refresh('primary', 2), code('SNAPSHOT_INVALID'));
  client.response = { status: 'modified', text: 'x'.repeat(4 * 1024 * 1024 + 1) };
  await assert.rejects(store.refresh('primary', 3), code('SNAPSHOT_LIMIT'));
  assert.equal((await store.status('primary'))!.snapshotDigest, accepted.snapshotDigest);
  assert.equal((await store.status('primary'))!.revision, 4);
});
