import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:https';
import { createServer as createHttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { HttpsSnapshotClient, SnapshotHttpError } from '../packages/subscriptions/http.ts';
import type { HttpsClientOptions } from '../packages/subscriptions/http.ts';
import { SubscriptionStore } from '../packages/subscriptions/index.ts';
import { runCli } from '../apps/cli/main.ts';

const execute = promisify(execFile);
const sensitive = 'synthetic-query-token';

async function fixture(run: (origin: string, options: HttpsClientOptions, hits: string[]) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'coproxy-https-test-'));
  const hits: string[] = [];
  let server: ReturnType<typeof createServer> | undefined;
  try {
    // Disposable test-only credentials; no private key is checked into Git.
    await execute('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'), '-days', '1',
      '-subj', '/CN=snapshot.test', '-addext', 'subjectAltName=DNS:snapshot.test,IP:127.0.0.1'], {
      timeout: 15_000, maxBuffer: 65_536, windowsHide: true,
    });
    const cert = await readFile(join(dir, 'cert.pem'));
    server = createServer({ key: await readFile(join(dir, 'key.pem')), cert }, (req, res) => {
      hits.push(req.url!);
      if (req.url!.startsWith('/cross')) { res.writeHead(302, { location: 'https://other.test/private' }); res.end(); }
      else if (req.url!.startsWith('/redirect')) { res.writeHead(302, { location: '/snapshot' }); res.end(); }
      else if (req.url!.startsWith('/loop')) { res.writeHead(302, { location: '/loop' }); res.end(); }
      else if (req.url!.startsWith('/large')) { res.end('x'.repeat(8192)); }
      else if (req.url!.startsWith('/compressed')) { res.writeHead(200, { 'content-encoding': 'gzip' }); res.end('not-gzip'); }
      else if (req.url!.startsWith('/bad-utf8')) { res.end(Buffer.from([0xff])); }
      else if (req.url!.startsWith('/stall')) { res.writeHead(200); res.write('{'); }
      else if (req.headers['if-none-match'] === '"v1"') { res.writeHead(304); res.end(); }
      else if (req.url!.startsWith('/nodes')) {
        res.writeHead(200, { etag: '"v1"', 'content-type': 'application/json',
          'subscription-userinfo': 'upload=100; download=200; total=10000; expire=2000000000' });
        res.end(JSON.stringify({ proxies: [{ name: 'Fetched', type: 'socks5', server: '192.0.2.10', port: 1080, password: sensitive }] }));
      }
      else { res.writeHead(200, { etag: '"v1"', 'content-type': 'application/json' }); res.end(JSON.stringify({ host: req.headers.host, proxies: [] })); }
    });
    await new Promise<void>((resolve, reject) => { server!.once('error', reject); server!.listen(0, '127.0.0.1', resolve); });
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const origin = 'https://snapshot.test:' + address.port;
    await run(origin, {
      allowedOrigins: [origin], ca: cert, allowPrivateAddresses: true,
      resolve: async () => [{ address: '127.0.0.1', family: 4 }],
    }, hits);
  } finally {
    if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); }
    await rm(dir, { recursive: true, force: true });
  }
}

const code = (expected: string) => (error: unknown) => {
  assert.ok(error instanceof SnapshotHttpError);
  assert.equal(error.code, expected);
  assert.ok(!String(error).includes(sensitive));
  return true;
};

test('HTTPS pins approved DNS, preserves Host and validates a trusted certificate', async () => {
  await fixture(async (origin, options) => {
    let resolutions = 0;
    const client = new HttpsSnapshotClient({ ...options, resolve: async hostname => {
      assert.equal(hostname, 'snapshot.test'); resolutions++;
      return [{ address: '127.0.0.1', family: 4 }];
    } });
    const result = await client.fetch(origin + '/snapshot?token=' + sensitive);
    assert.equal(result.status, 'modified');
    if (result.status !== 'modified') return;
    assert.equal(JSON.parse(result.text).host, new URL(origin).host);
    assert.equal(result.etag, '"v1"');
    assert.equal(resolutions, 1);
    assert.deepEqual(await client.fetch(origin + '/snapshot', { etag: result.etag }), { status: 'not-modified' });
  });
});

test('TLS trust and original hostname checks cannot be bypassed by pinned IP', async () => {
  await fixture(async (origin, options) => {
    const untrusted = new HttpsSnapshotClient({ ...options, ca: undefined });
    await assert.rejects(untrusted.fetch(origin + '/snapshot'), code('SOURCE_FETCH_FAILED'));
    const wrongOrigin = origin.replace('snapshot.test', 'wrong.test');
    const wrongName = new HttpsSnapshotClient({ ...options, allowedOrigins: [wrongOrigin] });
    await assert.rejects(wrongName.fetch(wrongOrigin + '/snapshot'), code('SOURCE_FETCH_FAILED'));
  });
});

test('optional subscription accounting is parsed into bounded public numeric data', async () => {
  await fixture(async (origin, options) => {
    const response = await new HttpsSnapshotClient(options).fetch(origin + '/nodes');
    assert.equal(response.status, 'modified');
    assert.deepEqual(response.usage, { upload: 100, download: 200, total: 10000, expire: 2000000000 });
  });
});

test('default origin/address policy rejects local targets before connecting', async () => {
  const client = new HttpsSnapshotClient({ allowedOrigins: ['https://subscription.example'],
    resolve: async () => [{ address: '127.0.0.1', family: 4 }] });
  await assert.rejects(client.fetch('https://subscription.example/?token=' + sensitive), code('SOURCE_ADDRESS_DENIED'));
  await assert.rejects(client.fetch('https://unapproved.example/'), code('SOURCE_ORIGIN_DENIED'));
  await assert.rejects(client.fetch('http://subscription.example/'), code('SOURCE_URL_DENIED'));
  await assert.rejects(client.fetch('https://user:secret@subscription.example/'), code('SOURCE_URL_DENIED'));
  assert.throws(() => new HttpsSnapshotClient({ allowedOrigins: [] }), code('SOURCE_ORIGIN_POLICY_REQUIRED'));
});

test('HTTP subscriptions require an exact explicit origin and retain address, redirect and size restrictions', async t => {
  let hits = 0;
  const server = createHttpServer((req, res) => {
    hits++;
    if (req.url === '/redirect') res.writeHead(302, { location: '/nodes' }).end();
    else if (req.url === '/cross') res.writeHead(302, { location: 'http://unapproved.example/nodes' }).end();
    else if (req.url === '/large') res.end('x'.repeat(512));
    else if (req.headers['if-none-match'] === '"v1"') res.writeHead(304).end();
    else res.writeHead(200, { etag: '"v1"' }).end('{"proxies":[]}');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;
  const denied = new HttpsSnapshotClient({ allowedOrigins: ['https://subscription.example'] });
  await assert.rejects(denied.fetch(origin + '/nodes'), code('SOURCE_URL_DENIED'));
  const localDenied = new HttpsSnapshotClient({ allowedOrigins: [], allowedHttpOrigins: [origin] });
  await assert.rejects(localDenied.fetch(origin + '/nodes'), code('SOURCE_ADDRESS_DENIED'));
  assert.equal(hits, 0);
  const options = { allowedOrigins: [], allowedHttpOrigins: [origin], allowPrivateAddresses: true, maxBytes: 128 };
  const client = new HttpsSnapshotClient(options);
  const result = await client.fetch(origin + '/redirect');
  assert.equal(result.status, 'modified');
  assert.deepEqual(await client.fetch(origin + '/nodes', { etag: '"v1"' }), { status: 'not-modified' });
  await assert.rejects(client.fetch(origin + '/cross'), code('SOURCE_REDIRECT_DENIED'));
  await assert.rejects(client.fetch(origin + '/large'), code('SOURCE_BODY_LIMIT'));
  assert.equal(hits, 5);
  assert.throws(() => new HttpsSnapshotClient({ allowedOrigins: [origin] }), code('SOURCE_URL_DENIED'));
  const root = await mkdtemp(join(tmpdir(), 'coproxy-http-source-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new SubscriptionStore(root, client);
  await store.configure({ id: 'legacy', url: origin + '/nodes?token=' + sensitive }, 0);
  assert.equal((await store.refresh('legacy', 1)).snapshotCurrent, true);
  assert.ok(!JSON.stringify(await store.list()).includes(sensitive));
});

test('same-origin redirects are bounded and cannot redirect tokens across origins', async () => {
  await fixture(async (origin, options, hits) => {
    const client = new HttpsSnapshotClient(options);
    assert.equal((await client.fetch(origin + '/redirect')).status, 'modified');
    await assert.rejects(client.fetch(origin + '/cross?token=' + sensitive), code('SOURCE_REDIRECT_DENIED'));
    assert.ok(!hits.includes('/private'));
    await assert.rejects(new HttpsSnapshotClient({ ...options, maxRedirects: 1 }).fetch(origin + '/loop'), code('SOURCE_REDIRECT_DENIED'));
  });
});

test('response size, encoding, UTF-8 and total read deadline are bounded', async () => {
  await fixture(async (origin, options) => {
    const client = new HttpsSnapshotClient({ ...options, maxBytes: 128 });
    await assert.rejects(client.fetch(origin + '/large'), code('SOURCE_BODY_LIMIT'));
    await assert.rejects(client.fetch(origin + '/compressed'), code('SOURCE_ENCODING_UNSUPPORTED'));
    await assert.rejects(client.fetch(origin + '/bad-utf8'), code('SOURCE_BODY_INVALID'));
    await assert.rejects(new HttpsSnapshotClient({ ...options, timeoutMs: 300 }).fetch(origin + '/stall'), code('SOURCE_FETCH_TIMEOUT'));
  });
});

test('total deadline also bounds DNS and late resolution never starts a request', async () => {
  let finish!: (value: { address: string; family: number }[]) => void;
  const pending = new Promise<{ address: string; family: number }[]>(resolve => { finish = resolve; });
  const client = new HttpsSnapshotClient({ allowedOrigins: ['https://subscription.example'], timeoutMs: 30,
    resolve: () => pending });
  await assert.rejects(client.fetch('https://subscription.example/?token=' + sensitive), code('SOURCE_FETCH_TIMEOUT'));
  finish([{ address: '127.0.0.1', family: 4 }]);
});

test('CLI refresh captures a real HTTPS node snapshot into an immutable candidate without starting runtime', async () => {
  await fixture(async (origin, options) => {
    const dir = await mkdtemp(join(tmpdir(), 'coproxy-source-cli-'));
    try {
      const directOrigin = origin.replace('snapshot.test', '127.0.0.1');
      const definition = join(dir, 'definition.json');
      const policy = join(dir, 'policy.json');
      const base = join(dir, 'base.json');
      const state = join(dir, 'store');
      await writeFile(definition, JSON.stringify({ id: 'primary', url: directOrigin + '/nodes?token=' + sensitive }), { mode: 0o600 });
      await writeFile(policy, JSON.stringify({ allowedOrigins: [directOrigin], allowPrivateAddresses: true, ca: options.ca!.toString() }), { mode: 0o600 });
      await writeFile(base, JSON.stringify({ schemaVersion: 1, deployment: {
        mixedPort: 17890, controllerPort: 19090, dnsPort: 15353,
        controllerSecret: 'synthetic-control-secret', bootstrapResolvers: ['192.0.2.53'],
      }, policy: { rules: ['MATCH,Fetched'] } }), { mode: 0o600 });
      const configured = await runCli(['source-configure', '--input', definition, '--state-dir', state, '--expected-revision', '0']);
      assert.equal((configured as Record<string, unknown>).revision, 1);
      const refreshed = await runCli(['source-refresh', '--source-id', 'primary', '--state-dir', state, '--expected-revision', '1', '--policy', policy]);
      assert.equal((refreshed as Record<string, unknown>).revision, 2);
      assert.ok(!JSON.stringify(refreshed).includes(sensitive));
      const staged = await runCli(['source-stage', '--source-id', 'primary', '--input', base, '--state-dir', state, '--expected-revision', '2']) as Record<string, unknown>;
      assert.equal(staged.runtime, 'not_started');
      assert.equal(staged.snapshotRevision, 2);
      const compiled = JSON.parse(await readFile(join(state, 'candidates', staged.generation + '.json'), 'utf8'));
      assert.equal(compiled.proxies[0].name, 'Fetched');
      assert.equal(compiled.proxies[0].password, sensitive);
      assert.equal((await runCli(['status', '--state-dir', state]) as Record<string, unknown>).active, null);
      const unchanged = await runCli(['source-refresh', '--source-id', 'primary', '--state-dir', state, '--expected-revision', '2', '--policy', policy]);
      assert.equal((unchanged as Record<string, unknown>).revision, 3);
      assert.equal((unchanged as Record<string, unknown>).snapshotRevision, 2);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
