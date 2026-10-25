import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, stat, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SubscriptionStore, SubscriptionError } from '../packages/subscriptions/index.ts';
import type { SnapshotClient, SnapshotResponse, SnapshotDecoder } from '../packages/subscriptions/index.ts';
import { decodeSubscriptionProfile } from '../packages/subscriptions/yaml.ts';

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
  const root = await mkdtemp(join(tmpdir(), 'cocoproxy-subscriptions-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const client = new Client();
  const store = new SubscriptionStore(root, client, decoder);
  return { root, client, store };
}

test('source registration and immutable snapshots expose only safe status metadata', async t => {
  const { root, client, store } = await fixture(t);
  const configured = await store.configure({ id: 'primary', url: sourceUrl }, 0);
  assert.deepEqual(configured, { id: 'primary', host: 'subscription.example', revision: 1, snapshotDigest: null,
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
  for (const url of ['http://user:secret@subscription.example/x', 'https://user:secret@subscription.example/x',
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

test('complete inline policy survives storage and rename with accounting and deployment disclosure', async t => {
  const { root, client, store } = await fixture(t, decodeSubscriptionProfile);
  await store.configure({ id: 'primary', url: sourceUrl, name: 'Primary' }, 0);
  const policy = { ...JSON.parse(text), 'proxy-groups': [{ name: 'Choose', type: 'select', proxies: ['example-node', 'DIRECT'] }],
    rules: ['DOMAIN,example.test,Choose', 'SUB-RULE,(NETWORK,TCP),nested', 'MATCH,REJECT'],
    'sub-rules': { nested: ['DOMAIN-SUFFIX,example.test,Choose', 'MATCH,DIRECT'] }, 'log-level': 'warning' };
  const usage = { upload: 100, download: 200, total: 10_000, expire: 2_000_000_000 };
  client.response = { status: 'modified', text: JSON.stringify({ ...policy, 'mixed-port': 9999,
    'external-controller': '0.0.0.0:9090', secret: privateValue, dns: { listen: '0.0.0.0:53' } }), etag: '"profile"', usage };
  const accepted = await store.refresh('primary', 1);
  assert.equal(accepted.kind, 'profile');
  assert.equal(accepted.nodeCount, 1);
  assert.deepEqual(accepted.usage, usage);
  assert.deepEqual(accepted.unsupportedFields, ['dns', 'external-controller', 'mixed-port', 'secret']);
  assert.ok(!JSON.stringify(accepted).includes(privateValue));
  assert.deepEqual((await store.snapshot('primary')).policy, policy);
  const renamed = await store.configure({ id: 'primary', name: 'Renamed', url: '' }, 2);
  assert.equal(renamed.name, 'Renamed');
  assert.equal(renamed.snapshotCurrent, true);
  assert.equal(renamed.snapshotDigest, accepted.snapshotDigest);
  assert.deepEqual((await new SubscriptionStore(root).snapshot('primary')).policy, policy);
  client.response = { status: 'not-modified' };
  await store.refresh('primary', 3);
  assert.equal(client.calls.at(-1)!.url, sourceUrl);
  assert.deepEqual((await store.status('primary'))!.usage, usage);
  const path = join(root, 'subscriptions', 'primary.json');
  const corrupt = JSON.parse(await readFile(path, 'utf8'));
  corrupt.snapshot.policy.rules.reverse();
  await writeFile(path, JSON.stringify(corrupt));
  await assert.rejects(store.status('primary'), code('SOURCE_CORRUPT'));
});

test('profile scripts, file and egress fields and external providers fail without replacing accepted policy', async t => {
  const { client, store } = await fixture(t, decodeSubscriptionProfile);
  await store.configure({ id: 'primary', url: sourceUrl }, 0);
  await store.refresh('primary', 1);
  const accepted = await store.snapshot('primary');
  let revision = 2;
  for (const extra of [
    { script: { code: privateValue } },
    { 'proxy-groups': [{ name: 'unsafe', type: 'select', use: ['remote'] }] },
    { 'sub-rules': { nested: ['GEOIP,CN,DIRECT'] } },
    { proxies: [{ name: 'unsafe', type: 'ss', 'interface-name': privateValue }] },
    { proxies: [{ name: 'unsafe', type: 'ss', 'ca-file': privateValue }] },
  ]) {
    client.response = { status: 'modified', text: JSON.stringify({ ...JSON.parse(text), ...extra }) };
    await assert.rejects(store.refresh('primary', revision++), code('SNAPSHOT_INVALID'));
    assert.deepEqual(await store.snapshot('primary'), accepted);
  }
  for (const field of ['proxy-providers', 'rule-providers']) {
    client.response = { status: 'modified', text: JSON.stringify({ ...JSON.parse(text), [field]: { remote: { type: 'http', url: sourceUrl } } }) };
    await assert.rejects(store.refresh('primary', revision++), code('SNAPSHOT_UNSUPPORTED'));
  }
});

test('CAS deletion cannot be undone by an in-flight refresh, including delete and recreate at the same revision', async t => {
  const { root } = await fixture(t);
  let complete!: (value: SnapshotResponse) => void;
  let entered!: () => void;
  const entry = new Promise<void>(resolve => { entered = resolve; });
  const store = new SubscriptionStore(root, { fetch: async () => new Promise<SnapshotResponse>(resolve => { complete = resolve; entered(); }) });
  await store.configure({ id: 'primary', url: sourceUrl }, 0);
  await assert.rejects(store.remove('primary', 0), code('SOURCE_CONFLICT'));
  const pending = store.refresh('primary', 1);
  await entry;
  await store.remove('primary', 1);
  assert.equal(await store.status('primary'), null);
  assert.deepEqual(await store.list(), []);
  await store.configure({ id: 'primary', url: sourceUrl }, 0);
  const rejected = assert.rejects(pending, code('SOURCE_CONFLICT'));
  complete({ status: 'modified', text });
  await rejected;
  assert.equal((await store.status('primary'))!.snapshotDigest, null);
  await store.remove('primary', 1);
  await assert.rejects(store.remove('primary', 1), code('SOURCE_NOT_FOUND'));
});

test('pre-profile version-one records remain readable and retain their original snapshot digest', async t => {
  const { root, store } = await fixture(t);
  await store.configure({ id: 'primary', url: sourceUrl }, 0);
  const accepted = await store.refresh('primary', 1);
  const path = join(root, 'subscriptions', 'primary.json');
  const legacy = JSON.parse(await readFile(path, 'utf8'));
  delete legacy.generation;
  await writeFile(path, JSON.stringify(legacy));
  assert.equal((await store.status('primary'))!.snapshotDigest, accepted.snapshotDigest);
  await store.configure({ id: 'primary', name: 'Legacy renamed' }, 2);
  assert.equal((await store.snapshot('primary')).sha256, accepted.snapshotDigest);
});

test('restricted provider downloads materialize group membership and rule order into one offline profile', async t => {
  const { root } = await fixture(t);
  const proxy = (name: string) => ({ name, type: 'socks5', server: '192.0.2.1', port: 1080 });
  const profile = {
    proxies: [proxy('base')],
    'proxy-providers': { remote: { type: 'http', url: 'https://provider.example/nodes', path: './cache/nodes.yaml' },
      embedded: { type: 'inline', payload: [proxy('HK-two')], override: { udp: true } } },
    'proxy-groups': [
      { name: 'Choose', type: 'select', proxies: ['DIRECT'], use: ['remote', 'embedded'], filter: '^HK' },
      { name: 'All', type: 'select', 'include-all': true, 'exclude-filter': '^US', 'exclude-type': 'ss|http' },
    ],
    'rule-providers': {
      domains: { type: 'http', behavior: 'domain', url: 'https://provider.example/domains' },
      cidrs: { type: 'http', behavior: 'ipcidr', format: 'text', url: 'https://provider.example/cidrs' },
      classical: { type: 'inline', behavior: 'classical', payload: ['DOMAIN-SUFFIX,internal.test', 'IP-CIDR,192.0.2.0/24,no-resolve'] },
    },
    rules: ['DOMAIN,first.test,DIRECT', 'RULE-SET,domains,Choose', 'RULE-SET,cidrs,REJECT,no-resolve',
      'RULE-SET,classical,All', 'MATCH,DIRECT'],
    'sub-rules': { nested: ['RULE-SET,classical,Choose', 'MATCH,REJECT'] },
  };
  const replies = new Map<string, string>([
    [sourceUrl, JSON.stringify(profile)],
    ['https://provider.example/nodes', JSON.stringify({ proxies: [proxy('HK-one'), proxy('US-one')] })],
    ['https://provider.example/domains', 'payload:\n  - +.example.test\n  - exact.test\n'],
    ['https://provider.example/cidrs', '# synthetic networks\n192.0.2.0/24\n2001:db8::/32\n'],
  ]);
  const calls: { url: string; previous?: { etag?: string } }[] = [];
  const client: SnapshotClient = { fetch: async (url, previous) => {
    calls.push({ url, previous });
    const body = replies.get(url);
    if (body === undefined) throw new Error('unapproved ' + privateValue);
    return { status: 'modified', text: body, etag: '"provider-version"' };
  } };
  const store = new SubscriptionStore(root, client, decodeSubscriptionProfile);
  await store.configure({ id: 'primary', url: sourceUrl }, 0);
  await store.refresh('primary', 1);
  const snapshot = await store.snapshot('primary');
  assert.deepEqual(snapshot.proxies.map(node => node.name), ['base', 'HK-one', 'US-one', 'HK-two']);
  assert.deepEqual(snapshot.policy!['proxy-groups'], [
    { name: 'Choose', type: 'select', proxies: ['DIRECT', 'HK-one', 'HK-two'] },
    { name: 'All', type: 'select', proxies: ['base', 'HK-one', 'HK-two'] },
  ]);
  assert.deepEqual(snapshot.policy!.rules, ['DOMAIN,first.test,DIRECT', 'DOMAIN-SUFFIX,example.test,Choose',
    'DOMAIN,exact.test,Choose', 'IP-CIDR,192.0.2.0/24,REJECT,no-resolve', 'IP-CIDR6,2001:db8::/32,REJECT,no-resolve',
    'DOMAIN-SUFFIX,internal.test,All', 'IP-CIDR,192.0.2.0/24,All,no-resolve', 'MATCH,DIRECT']);
  assert.deepEqual(snapshot.policy!['sub-rules'], { nested: ['DOMAIN-SUFFIX,internal.test,Choose',
    'IP-CIDR,192.0.2.0/24,Choose,no-resolve', 'MATCH,REJECT'] });
  assert.equal(snapshot.policy!['proxy-providers'], undefined);
  assert.equal(snapshot.policy!['rule-providers'], undefined);
  assert.equal(snapshot.proxies.at(-1)!.udp, true);
  assert.deepEqual(await new SubscriptionStore(root).snapshot('primary'), snapshot);
  assert.deepEqual(calls.map(call => call.url), [sourceUrl, 'https://provider.example/nodes', 'https://provider.example/domains', 'https://provider.example/cidrs']);
  // Refresh cannot trust the parent's ETag while provider content can change.
  await store.refresh('primary', 2);
  assert.equal(calls[4].previous, undefined);
  assert.ok(calls.every(call => call.previous === undefined));
});

test('provider fetch policy, unavailable cache and unsupported forms retain the accepted snapshot', async t => {
  const { root } = await fixture(t);
  let document = text;
  let provider: SnapshotResponse | Error = new Error('denied ' + privateValue);
  let fetches = 0;
  const store = new SubscriptionStore(root, { fetch: async url => {
    if (url === sourceUrl) return { status: 'modified', text: document };
    fetches++;
    if (provider instanceof Error) throw provider;
    return provider;
  } }, decodeSubscriptionProfile);
  await store.configure({ id: 'primary', url: sourceUrl }, 0);
  await store.refresh('primary', 1);
  const accepted = await store.snapshot('primary');
  const remote = { type: 'http', url: 'https://unapproved.example/nodes' };
  document = JSON.stringify({ 'proxy-providers': { remote }, 'proxy-groups': [{ name: 'Choose', type: 'select', use: ['remote'] }] });
  await assert.rejects(store.refresh('primary', 2), code('SOURCE_FETCH_FAILED'));
  assert.deepEqual(await store.snapshot('primary'), accepted);
  provider = { status: 'not-modified' };
  await assert.rejects(store.refresh('primary', 3), code('SNAPSHOT_UNSUPPORTED'));
  assert.deepEqual(await store.snapshot('primary'), accepted);
  let revision = 4;
  for (const profile of [
    { 'proxy-providers': { remote: { type: 'file', path: './private.yaml' } } },
    { 'rule-providers': { remote: { type: 'http', behavior: 'domain', format: 'mrs', url: remote.url } } },
    { 'rule-providers': { remote: { type: 'inline', behavior: 'classical', payload: ['RULE-SET,unknown'] } }, rules: ['RULE-SET,remote,DIRECT'] },
    { 'proxy-providers': {}, 'proxy-groups': [{ name: 'Choose', type: 'select', use: ['unknown'] }] },
    { 'proxy-providers': { remote: { type: 'inline', payload: [], filter: '(nested+)+' } } },
    { 'rule-providers': {}, rules: ['GEOIP,CN,DIRECT'] },
  ]) {
    document = JSON.stringify(profile);
    await assert.rejects(store.refresh('primary', revision++), code('SNAPSHOT_UNSUPPORTED'));
    assert.deepEqual(await store.snapshot('primary'), accepted);
  }
  document = JSON.stringify({ 'proxy-providers': { remote: { type: 'inline',
    payload: [{ name: 'unsafe', type: 'ss', 'interface-name': privateValue }] } } });
  await assert.rejects(store.refresh('primary', revision++), code('SNAPSHOT_INVALID'));
  assert.deepEqual(await store.snapshot('primary'), accepted);
  assert.equal(fetches, 2);
});
