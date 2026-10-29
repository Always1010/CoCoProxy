import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync, statSync } from 'node:fs';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Agent } from 'node:https';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import type { Duplex } from 'node:stream';
import type { JsonObject } from '../packages/config/index.ts';
import { BandwidthByteBudget, bandwidthBodyRequest, buildBandwidthConfig, runBandwidthTransfer, runDownloadVerification } from '../packages/management/bandwidth-transport.ts';
import { validateWithMihomo } from '../packages/mihomo/validator.ts';

const source = (): JsonObject => ({ proxies: [
  { name: 'Chosen,with punctuation', type: 'ss', server: 'chosen.example', port: 443, cipher: 'aes-128-gcm', password: 'synthetic-selected' },
  { name: 'Other', type: 'ss', server: 'other.example', port: 443, password: 'synthetic-other' },
], 'proxy-groups': [{ name: 'Group', type: 'select', proxies: ['Other'] }],
  'rule-providers': {
    'dns-fixture': { type: 'inline', behavior: 'domain', payload: ['+.fixture.example'] },
    'unused-routing': { type: 'inline', behavior: 'domain', payload: ['+.unused.example'] },
  },
  'external-controller': '127.0.0.1:12345', secret: 'synthetic-controller', 'mixed-port': 10000,
  'allow-lan': true, tun: { enable: true }, dns: { enable: true, listen: '127.0.0.1:12346', 'listen-routing-mark': 100,
    'respect-rules': true, 'default-nameserver': ['192.0.2.53'], nameserver: ['https://resolver.example/dns-query'],
    'proxy-server-nameserver': ['192.0.2.53'],
    'nameserver-policy': { 'rule-set:dns-fixture': ['192.0.2.53#DIRECT'] },
    'proxy-server-nameserver-policy': { 'chosen.example': ['9.9.9.9'] } }, 'interface-name': 'test-egress', 'routing-mark': 123 });

test('download verification paces only target demand, counts warmup and rejects undersized samples', async () => {
  const run = async (maximum: number) => {
    const budget = new BandwidthByteBudget(maximum);
    const result = await runDownloadVerification({ targetMbps: 8, warmupMs: 1000, minSampleMs: 3000, durationMs: 4500,
      signal: new AbortController().signal, budget, report: () => {},
      request: async (size, _signal, progress) => { budget.take(size); progress(size); return { bytes: size, elapsedMs: 1 }; } });
    assert.ok(budget.used <= maximum); assert.equal(result.bytes, budget.used); return result;
  };
  const full = await run(8 * 1048576);
  assert.equal(full.status, 'success'); assert.equal(full.mbps, 8);
  assert.ok(full.sampleMs! >= 3000); assert.ok(full.warmupMs! >= 1000);
  const short = await run(2 * 1048576);
  assert.equal(short.status, 'insufficient'); assert.equal(short.mbps, null);
});

test('isolated config retains exactly the selected leaf and resolvers without live controls or privileged marks', () => {
  const original = source(), before = structuredClone(original);
  const config = buildBandwidthConfig(original, 'Chosen,with punctuation', 23456);
  assert.deepEqual(original, before);
  assert.equal(config.port, 23456);
  assert.equal(config['bind-address'], '127.0.0.1'); assert.equal(config['allow-lan'], false);
  assert.deepEqual(config.tun, { enable: false });
  assert.deepEqual(config.rules, ['MATCH,BANDWIDTH-TARGET']);
  assert.deepEqual(config.proxies, [{ ...(original.proxies as JsonObject[])[0], name: 'BANDWIDTH-TARGET' }]);
  assert.equal(config['proxy-groups'], undefined); assert.equal(config['external-controller'], undefined);
  assert.equal(config.secret, undefined); assert.equal(config['mixed-port'], undefined);
  assert.equal(config['interface-name'], undefined); assert.equal(config['routing-mark'], undefined);
  assert.deepEqual(config['rule-providers'], { 'dns-fixture': (original['rule-providers'] as JsonObject)['dns-fixture'] });
  assert.deepEqual(config.dns, { enable: true, 'respect-rules': false, 'default-nameserver': ['192.0.2.53'], nameserver: ['https://resolver.example/dns-query'],
    'proxy-server-nameserver': ['192.0.2.53'],
    'nameserver-policy': { 'rule-set:dns-fixture': ['192.0.2.53#DIRECT'] },
    'proxy-server-nameserver-policy': { 'chosen.example': ['9.9.9.9'] } });
  const missing = source(); delete missing['rule-providers'];
  assert.throws(() => buildBandwidthConfig(missing, 'Chosen,with punctuation', 23456), { code: 'BANDWIDTH_CONFIG_INVALID' });
  assert.ok(!JSON.stringify(config).includes('synthetic-other'));
  for (const name of ['Group', 'DIRECT', 'Missing']) assert.throws(() => buildBandwidthConfig(original, name, 23456), { code: 'BANDWIDTH_UNAVAILABLE' });
  for (const leaf of [{ name: 'Bad', type: 'direct' }, { name: 'Bad', type: 'ss', 'dialer-proxy': 'Other' }] as JsonObject[]) {
    assert.throws(() => buildBandwidthConfig({ proxies: [leaf] }, 'Bad', 23456), { code: 'BANDWIDTH_UNAVAILABLE' });
  }
});

test('real core validates isolated DNS rule-set dependencies and rejects the former dangling reference',
  { skip: !process.env.COCOPROXY_TEST_MIHOMO, timeout: 20_000 }, async () => {
    const config = buildBandwidthConfig(source(), 'Chosen,with punctuation', 23456);
    const candidate = { id: 'a'.repeat(64), sha256: 'a'.repeat(64), config };
    const options = { binaryPath: process.env.COCOPROXY_TEST_MIHOMO!, timeoutMs: 5000 };
    await validateWithMihomo(candidate, options);
    const broken = structuredClone(config); delete broken['rule-providers'];
    await assert.rejects(validateWithMihomo({ ...candidate, config: broken }, options), { code: 'CORE_CONFIG_REJECTED' });
  });

async function localAgent(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const server = createServer(handler), sockets = new Set<Socket>();
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const agent = new Agent({ keepAlive: true });
  // Test seam exercises HTTP framing/limits without an external request; production always wraps CONNECT in verified TLS.
  agent.createConnection = () => connect(address.port, '127.0.0.1') as Duplex;
  return { agent, close: async () => { agent.destroy(); for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}

test('body accounting enforces byte cap and rejects redirects, compressed/cached or oversized responses', async () => {
  let kind = 'valid';
  const peer = await localAgent((req, response) => {
    assert.equal(req.headers.host, 'speed.cloudflare.com');
    assert.equal(req.url, '/__down?bytes=1024'); assert.equal(req.headers['accept-encoding'], 'identity');
    if (kind === 'redirect') { response.writeHead(302, { location: 'https://arbitrary.example/' }); response.end(); return; }
    response.writeHead(200, { 'content-length': kind === 'oversized' ? '2048' : '1024',
      ...(kind === 'compressed' ? { 'content-encoding': 'gzip' } : {}), ...(kind === 'cached' ? { 'cf-cache-status': 'HIT' } : {}) });
    response.end(Buffer.alloc(kind === 'oversized' ? 2048 : 1024));
  });
  try {
    const budget = new BandwidthByteBudget(1024);
    assert.equal((await bandwidthBodyRequest({ agent: peer.agent, signal: new AbortController().signal, budget, method: 'GET', size: 1024 })).bytes, 1024);
    assert.equal(budget.used, 1024); assert.equal(budget.remaining, 0);
    assert.throws(() => budget.take(1), { code: 'BANDWIDTH_BYTE_LIMIT' });
    for (kind of ['redirect', 'compressed', 'cached', 'oversized']) {
      await assert.rejects(bandwidthBodyRequest({ agent: peer.agent, signal: new AbortController().signal,
        budget: new BandwidthByteBudget(1024), method: 'GET', size: 1024 }), { code: 'BANDWIDTH_UNAVAILABLE' });
    }
  } finally { await peer.close(); }
});

test('upload success waits for complete server acknowledgement and abort retains all queued body bytes in budget', async () => {
  let reply: (() => void) | undefined, received = 0, began: (() => void) | undefined;
  const receivedBody = new Promise<void>(resolve => { began = resolve; });
  const peer = await localAgent((req, res) => {
    assert.equal(req.method, 'POST'); assert.equal(req.url, '/__up');
    req.on('data', (body: Buffer) => { received += body.length; });
    req.once('end', () => { reply = () => res.end('{}'); began!(); });
  });
  try {
    const budget = new BandwidthByteBudget(32768), controller = new AbortController();
    let complete = false;
    const transfer = bandwidthBodyRequest({ agent: peer.agent, signal: controller.signal, budget, method: 'POST', size: 8192 }).then(result => { complete = true; return result; });
    await receivedBody; await delay(20);
    assert.equal(received, 8192); assert.equal(budget.used, 8192); assert.equal(complete, false);
    reply!(); assert.equal((await transfer).bytes, 8192); assert.equal(budget.used, 8194);
    const abort = new AbortController();
    const pending = bandwidthBodyRequest({ agent: peer.agent, signal: abort.signal, budget, method: 'POST', size: 4096 });
    await delay(20); abort.abort();
    await assert.rejects(pending, { code: 'BANDWIDTH_CANCELLED' });
    assert.equal(budget.used, 12290);
  } finally { await peer.close(); }
});

test('isolated child and exact private task directory are cleaned before cancellation, TLS failure or timeout returns', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bandwidth-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const script = join(root, 'synthetic-core.cjs');
  await writeFile(script, `const net=require('node:net'),fs=require('node:fs');
const c=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
net.createServer(s=>{s.on('error',()=>{});s.once('data',b=>{
if(!b.toString().startsWith('CONNECT speed.cloudflare.com:443 HTTP/1.1\\r\\n'))return s.destroy();
s.write('HTTP/1.1 200 Connection established\\r\\n\\r\\n');
if(process.argv[3]==='tls-failure')setTimeout(()=>s.end('HTTP/1.1 200 not TLS\\r\\n\\r\\n'),10);
});}).listen(c.port,'127.0.0.1');`);
  const keep = join(root, 'keep.txt'); await writeFile(keep, 'keep');
  for (const mode of ['invalid-config', 'cancel', 'tls-failure', 'timeout']) {
    const controller = new AbortController(); let child: ChildProcess | undefined, configPath = '', seenLatency = false;
    const result = runBandwidthTransfer({ config: source(), node: 'Chosen,with punctuation', binaryPath: process.execPath,
      stateDirectory: root, signal: controller.signal, limits: { durationMs: 100, maxBytes: 1_000_000, timeoutMs: mode === 'timeout' ? 600 : 4000 },
      report: update => { if (update.phase === 'latency') { seenLatency = true; if (mode === 'cancel') setTimeout(() => controller.abort(), 25); } },
    }, { start: (binary, args) => {
      const validating = args[0] === '-t';
      configPath = args.at(-1)!;
      const config = JSON.parse(readFileSync(configPath, 'utf8'));
      assert.deepEqual(config.proxies.map((leaf: JsonObject) => leaf.server), ['chosen.example']);
      assert.equal(config.authentication.length, 1);
      if (process.platform !== 'win32') { assert.equal(statSync(configPath).mode & 0o777, 0o600); assert.equal(statSync(args[validating ? 2 : 1]).mode & 0o777, 0o700); }
      if (validating) {
        child = spawn(binary, ['-e', `process.exit(${mode === 'invalid-config' ? 1 : 0})`], { stdio: 'ignore', windowsHide: true }); return child;
      }
      child = spawn(binary, [script, configPath, mode], { stdio: 'ignore', windowsHide: true }); return child;
    } });
    await assert.rejects(result, { code: mode === 'invalid-config' ? 'BANDWIDTH_CONFIG_INVALID' : mode === 'cancel' ? 'BANDWIDTH_CANCELLED' : mode === 'timeout' ? 'BANDWIDTH_TIMEOUT' : 'BANDWIDTH_UNAVAILABLE' });
    assert.equal(seenLatency, mode !== 'invalid-config'); assert.ok(child && (child.exitCode !== null || child.signalCode !== null));
    assert.throws(() => statSync(configPath), { code: 'ENOENT' });
    assert.deepEqual((await readdir(root)).sort(), ['keep.txt', 'synthetic-core.cjs']);
  }
});
