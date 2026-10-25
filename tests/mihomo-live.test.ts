import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createSocket } from 'node:dgram';
import { createServer as httpServer, request } from 'node:http';
import { createConnection, createServer } from 'node:net';
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { createControllerProxy } from '../packages/management/controller.ts';
import { compileConfig } from '../packages/config/index.ts';
import { validateWithMihomo } from '../packages/mihomo/validator.ts';
import { observeCore } from '../packages/runtime/observer.ts';
import { verifyBinary } from '../packages/runtime/settings.ts';
import type { RuntimeSettings, RuntimeUnitState } from '../packages/runtime/types.ts';
import { FileTransactionStore } from '../packages/transaction/index.ts';

const binaryInput = process.env.COCOPROXY_TEST_MIHOMO;

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

function dnsQuery(domain: string): Buffer {
  const header = Buffer.alloc(12);
  randomBytes(2).copy(header); header.writeUInt16BE(0x0100, 2); header.writeUInt16BE(1, 4);
  const labels = domain.split('.').flatMap(label => [Buffer.from([label.length]), Buffer.from(label)]);
  return Buffer.concat([header, ...labels, Buffer.from([0, 0, 1, 0, 1])]);
}

function checkDns(response: Buffer, query: Buffer): void {
  assert.ok(response.length >= 12 && response.length <= 4096);
  assert.equal(response.readUInt16BE(0), query.readUInt16BE(0));
  assert.equal(response.readUInt16BE(2) & 0x800f, 0x8000);
  assert.equal(response.readUInt16BE(4), 1);
  const answers = response.readUInt16BE(6);
  assert.ok(answers >= 1 && answers <= 16);
  assert.ok(response.subarray(12, query.length).equals(query.subarray(12)));
  let offset = query.length;
  let found = false;
  for (let index = 0; index < answers; index++) {
    let labels = 0;
    for (;;) {
      assert.ok(++labels <= 128 && offset < response.length);
      if (response[offset] === 0) { offset++; break; }
      if ((response[offset] & 0xc0) === 0xc0) { offset += 2; break; }
      const size = response[offset];
      assert.ok(size <= 63); offset += size + 1;
    }
    assert.ok(offset + 10 <= response.length);
    const type = response.readUInt16BE(offset), cls = response.readUInt16BE(offset + 2), length = response.readUInt16BE(offset + 8);
    offset += 10; assert.ok(offset + length <= response.length);
    if (type === 1 && cls === 1 && length === 4 && response.subarray(offset, offset + 4).equals(Buffer.from([127, 0, 0, 1]))) found = true;
    offset += length;
  }
  assert.ok(found, 'localhost hosts answer was not returned');
}

async function dnsRequest(port: number, query: Buffer, tcp: boolean): Promise<Buffer> {
  if (!tcp) return new Promise((resolve, reject) => {
    const socket = createSocket('udp4');
    const timer = setTimeout(() => { socket.close(); reject(new Error('DNS_UDP_TIMEOUT')); }, 2000);
    socket.once('error', error => { clearTimeout(timer); socket.close(); reject(error); });
    socket.once('message', (message, remote) => { clearTimeout(timer); socket.close();
      if (remote.address !== '127.0.0.1' || remote.port !== port) reject(new Error('DNS_WRONG_PEER')); else resolve(message); });
    socket.send(query, port, '127.0.0.1');
  });
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    let bytes = Buffer.alloc(0);
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('DNS_TCP_TIMEOUT')); }, 2000);
    const finish = (error?: Error, response?: Buffer) => {
      clearTimeout(timer); socket.destroy(); if (error) reject(error); else resolve(response!);
    };
    socket.once('error', error => finish(error));
    socket.once('connect', () => { const length = Buffer.alloc(2); length.writeUInt16BE(query.length); socket.write(Buffer.concat([length, query])); });
    socket.on('data', chunk => {
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length > 4098) { finish(new Error('DNS_TCP_LIMIT')); return; }
      if (bytes.length >= 2 && bytes.length >= bytes.readUInt16BE(0) + 2) finish(undefined, bytes.subarray(2, 2 + bytes.readUInt16BE(0)));
    });
  });
}

test('reviewed real Mihomo validates and serves loopback HTTP proxy plus UDP/TCP localhost DNS',
  { skip: !binaryInput || process.platform !== 'linux' || process.geteuid!() === 0 }, async t => {
    assert.ok(isAbsolute(binaryInput!));
    const binary = await realpath(binaryInput!);
    const review = JSON.parse(await readFile(new URL('../integrations/metacubexd/review.json', import.meta.url), 'utf8'));
    const hash = createHash('sha256').update(await readFile(binary)).digest('hex');
    // The live command must select the reviewed artifact, never an arbitrary substitute.
    assert.equal(hash, review.coreCandidate.binarySha256);
    const root = await mkdtemp(join(tmpdir(), 'cocoproxy-real-core-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const ports = new Set<number>();
    while (ports.size < 3) ports.add(await freePort());
    const [mixedPort, controllerPort, dnsPort] = [...ports];
    const nonce = randomBytes(8).toString('hex');
    const domain = 'localhost';
    const candidate = compileConfig({ schemaVersion: 1, deployment: { mixedPort, controllerPort, dnsPort,
      controllerSecret: randomBytes(32).toString('hex'), bootstrapResolvers: ['127.0.0.1'] },
    policy: { rules: ['MATCH,DIRECT'], 'log-level': 'error',
      'proxy-groups': [{ name: 'synthetic-select', type: 'select', proxies: ['DIRECT', 'REJECT'] }] } });
    const stateDirectory = join(root, 'state');
    const staged = await new FileTransactionStore(stateDirectory).stage(candidate);
    const home = join(stateDirectory, 'core-home');
    await mkdir(home, { mode: 0o700 });
    const settings: RuntimeSettings = { schemaVersion: 1, stateDirectory, binaryPath: binary, binarySha256: hash,
      systemctlPath: '/usr/bin/systemctl', unitPath: '/synthetic/cocoproxy-mihomo.service', unitSha256: 'a'.repeat(64), serviceUid: process.geteuid!() };
    assert.equal(await verifyBinary(settings), binary);
    await validateWithMihomo(candidate, { binaryPath: binary });
    const child = spawn(binary, ['-d', home, '-f', staged.path], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let logBytes = 0;
    let logLimit = false;
    let exited = false;
    let spawnFailed = false;
    child.once('error', () => { spawnFailed = true; });
    const closed = new Promise<void>(resolve => child.once('close', () => { exited = true; resolve(); }));
    const kill = (signal: NodeJS.Signals) => { try { if (child.pid) process.kill(-child.pid, signal); } catch { /* already gone */ } };
    const consume = (bytes: Buffer) => { logBytes += bytes.length; if (logBytes > 65_536) { logLimit = true; kill('SIGKILL'); } };
    child.stdout.on('data', consume); child.stderr.on('data', consume);
    t.after(async () => { kill('SIGTERM'); const timer = setTimeout(() => kill('SIGKILL'), 2000); try { await closed; } finally { clearTimeout(timer); } });
    assert.ok(child.pid);
    // This descriptor identifies a direct test process. It is not evidence of
    // a deployed or authorized systemd service and never invokes systemctl.
    const unit: RuntimeUnitState = { loadState: 'loaded', activeState: 'active', subState: 'running', mainPid: child.pid!, jobPending: false,
      fragmentPath: settings.unitPath, hasDropIns: false, needsReload: false, user: String(settings.serviceUid) };
    const deadline = performance.now() + 10_000;
    let ready = false;
    while (!exited && !spawnFailed && performance.now() < deadline) {
      if ((await observeCore(settings, candidate.id, unit)).ready) { ready = true; break; }
      await delay(100);
    }
    assert.equal(logLimit, false, 'core exceeded the bounded diagnostic budget');
    assert.ok(ready, 'reviewed core did not become ready');
    const controller = createControllerProxy({
      target: async () => ({ generation: candidate.id, port: controllerPort, secret: candidate.config.secret as string }),
      isCurrent: async generation => generation === candidate.id && !exited,
      mutate: async operation => operation(),
    });
    for (const route of ['/version', '/configs', '/proxies', '/rules', '/connections']) {
      const response = await controller.fetch(new Request('https://management.example' + route));
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('x-cocoproxy-generation'), candidate.id);
      assert.ok(!(await response.text()).includes(candidate.config.secret as string));
    }
    const selected = await controller.fetch(new Request('https://management.example/proxies/synthetic-select', {
      method: 'PUT', headers: { 'content-type': 'application/json', 'if-match': candidate.id }, body: JSON.stringify({ name: 'REJECT' }),
    }));
    assert.equal(selected.status, 204);
    const selection = await controller.fetch(new Request('https://management.example/proxies/synthetic-select'));
    assert.equal((await selection.json()).now, 'REJECT');
    let firstFrame!: (text: string) => void;
    const received = new Promise<string>(resolve => { firstFrame = resolve; });
    const cleanup = await controller.relay(new Request('https://management.example/traffic?interval=0.1'), {
      send: text => firstFrame(text), close: () => {},
    }, () => true);
    let frameTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const traffic = JSON.parse(await Promise.race([received, new Promise<never>((_, reject) => {
        frameTimer = setTimeout(() => reject(new Error('CORE_STREAM_TIMEOUT')), 3000);
      })]));
      assert.equal(typeof traffic.up, 'number'); assert.equal(typeof traffic.down, 'number');
    } finally { clearTimeout(frameTimer); cleanup(); }
    const fixture = httpServer((_req, res) => { res.writeHead(200); res.end(nonce); });
    await new Promise<void>(resolve => fixture.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise<void>((resolve, reject) => fixture.close(error => error ? reject(error) : resolve())));
    const targetPort = (fixture.address() as { port: number }).port;
    const proxied = await new Promise<string>((resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', port: mixedPort, path: `http://127.0.0.1:${targetPort}/synthetic`,
        agent: false, headers: { Host: `127.0.0.1:${targetPort}`, Connection: 'close' } }, response => {
        let body = ''; response.setEncoding('utf8'); response.on('data', chunk => { body += chunk; if (body.length > 128) req.destroy(); });
        response.on('error', reject); response.on('end', () => { if (response.statusCode === 200) resolve(body); else reject(new Error('PROXY_STATUS_' + response.statusCode)); });
      });
      req.setTimeout(2000, () => req.destroy(new Error('PROXY_TIMEOUT'))); req.once('error', reject); req.end();
    });
    assert.equal(proxied, nonce);
    const query = dnsQuery(domain);
    checkDns(await dnsRequest(dnsPort, query, false), query);
    checkDns(await dnsRequest(dnsPort, query, true), query);
  });
