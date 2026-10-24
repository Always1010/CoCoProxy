import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createSocket } from 'node:dgram';
import { readFile, readdir, readlink, realpath, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { createConnection, createServer, type Socket } from 'node:net';
import { isAbsolute } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export async function privateJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(value), { mode: 0o600 });
}

export async function reviewedBinary(input: string, expected: string): Promise<string> {
  assert.ok(isAbsolute(input), 'live binaries require explicit absolute paths');
  const path = await realpath(input);
  assert.match(expected, /^[a-f0-9]{64}$/);
  assert.equal(createHash('sha256').update(await readFile(path)).digest('hex'), expected, 'binary does not match reviewed artifact');
  return path;
}

export async function freePort(used: Set<number>): Promise<number> {
  for (;;) {
    const server = createServer();
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const port = (server.address() as { port: number }).port;
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    if (port >= 1024 && !used.has(port)) { used.add(port); return port; }
  }
}

export function managedProcess(binary: string, args: string[], cwd: string) {
  const child = spawn(binary, args, { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: '/usr/bin:/bin', LANG: 'C', HOME: cwd } });
  let outputBytes = 0;
  let overflow = false;
  let spawnFailed = false;
  let stopped = false;
  const kill = (signal: NodeJS.Signals) => { try { if (child.pid) process.kill(-child.pid, signal); } catch { /* already reaped */ } };
  child.once('error', () => { spawnFailed = true; });
  const closed = new Promise<number | null>(resolve => child.once('close', code => { stopped = true; resolve(code); }));
  const consume = (chunk: Buffer) => { outputBytes += chunk.length; if (outputBytes > 65_536) { overflow = true; kill('SIGKILL'); } };
  // Never print protocol credentials, certificate material, or raw core logs.
  child.stdout.on('data', consume); child.stderr.on('data', consume);
  return {
    pid: child.pid,
    healthy: () => !spawnFailed && !stopped && !overflow,
    async stop() {
      if (!stopped) kill('SIGTERM');
      const timer = setTimeout(() => kill('SIGKILL'), 1500);
      try { await closed; } finally { clearTimeout(timer); }
      assert.equal(overflow, false, 'child exceeded bounded diagnostic budget');
    },
    async success() {
      const timer = setTimeout(() => kill('SIGKILL'), 10_000);
      try { assert.equal(await closed, 0, 'reviewed tool exited unsuccessfully'); assert.equal(spawnFailed || overflow, false); }
      finally { clearTimeout(timer); }
    },
  };
}

export async function ownNetworkBindings(pid: number, listenerPorts: readonly number[] = []): Promise<{ port: number; family: string; address: string; state: string }[]> {
  const descriptors = await readdir(`/proc/${pid}/fd`);
  const links = await Promise.all(descriptors.map(fd => readlink(`/proc/${pid}/fd/${fd}`).catch(() => '')));
  const inodes = new Set(links.map(link => /^socket:\[(\d+)\]$/.exec(link)?.[1]).filter(Boolean));
  const bindings = [];
  for (const family of ['tcp', 'tcp6', 'udp', 'udp6']) {
    const table = await readFile(`/proc/${pid}/net/${family}`, 'utf8');
    for (const line of table.trim().split('\n').slice(1)) {
      const fields = line.trim().split(/\s+/);
      if (!inodes.has(fields[9])) continue;
      const [address, port] = fields[1].split(':');
      // Go cores can bind ephemeral UDP egress sockets to an unspecified local
      // address. This is not a configured public protocol listener. Actual
      // listener ports are separately checked below; every destination in both
      // generated configurations is restricted to the synthetic loopback peers.
      const loopback = (family === 'tcp' || family === 'udp') && address === '0100007F';
      const ephemeralUdp = (family === 'udp' && address === '00000000') || (family === 'udp6' && address === '0'.repeat(32));
      assert.ok(loopback || ephemeralUdp, 'child opened an unexpected network socket');
      if (listenerPorts.includes(Number.parseInt(port, 16))) assert.ok(loopback, 'configured listener is not IPv4 loopback');
      bindings.push({ port: Number.parseInt(port, 16), family, address, state: fields[3] });
    }
  }
  return bindings;
}

export async function waitBindings(child: ReturnType<typeof managedProcess>, ports: { port: number; udp?: boolean }[]): Promise<void> {
  const deadline = performance.now() + 10_000;
  while (child.healthy() && performance.now() < deadline) {
    if (child.pid) {
      const bindings = await ownNetworkBindings(child.pid, ports.map(binding => binding.port)).catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw error;
      });
      if (ports.every(({ port, udp }) => bindings.some(binding => binding.port === port && binding.family === (udp ? 'udp' : 'tcp') && (udp || binding.state === '0A')))) return;
    }
    await delay(75);
  }
  assert.fail('reviewed child did not open the expected loopback listeners');
}

export async function httpNonce(mixedPort: number, targetPort: number, nonce: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: mixedPort, path: `http://127.0.0.1:${targetPort}/${nonce}`,
      agent: false, headers: { Host: `127.0.0.1:${targetPort}`, Connection: 'close' } }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; if (body.length > 128) req.destroy(new Error('HTTP_RESPONSE_LIMIT')); });
      response.once('error', reject);
      response.once('end', () => response.statusCode === 200 && body === nonce ? resolve() : reject(new Error('HTTP_PROXY_FAILURE')));
    });
    const timer = setTimeout(() => req.destroy(new Error('HTTP_PROXY_TIMEOUT')), 5000);
    req.once('close', () => clearTimeout(timer)); req.once('error', reject); req.end();
  });
}

// RFC 1928 client framing only: the protocols under test are implemented solely
// by the reviewed official Mihomo client and official sing-box server.
export function socketReader(socket: Socket) {
  let buffered = Buffer.alloc(0);
  let pending: { count: number; resolve: (bytes: Buffer) => void; reject: (error: Error) => void } | undefined;
  let failure: Error | undefined;
  const flush = () => {
    if (!pending) return;
    if (failure) { const current = pending; pending = undefined; current.reject(failure); }
    else if (buffered.length >= pending.count) { const current = pending; pending = undefined; const result = buffered.subarray(0, current.count); buffered = buffered.subarray(current.count); current.resolve(result); }
  };
  socket.on('data', chunk => { buffered = Buffer.concat([buffered, chunk]); if (buffered.length > 4096) failure = new Error('SOCKS_RESPONSE_LIMIT'); flush(); });
  socket.on('error', error => { failure = error; flush(); });
  socket.on('close', () => { failure ??= new Error('SOCKS_CLOSED'); flush(); });
  return (count: number) => new Promise<Buffer>((resolve, reject) => { assert.equal(pending, undefined); pending = { count, resolve, reject }; flush(); });
}

export async function udpNonce(mixedPort: number, targetPort: number, payload: Buffer, timeout = 5000): Promise<void> {
  const control = createConnection({ host: '127.0.0.1', port: mixedPort });
  const read = socketReader(control);
  const socket = createSocket('udp4');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([(async () => {
      await new Promise<void>((resolve, reject) => { control.once('connect', resolve); control.once('error', reject); });
      control.write(Buffer.from([5, 1, 0]));
      assert.deepEqual(await read(2), Buffer.from([5, 0]));
      await new Promise<void>((resolve, reject) => { socket.once('error', reject); socket.bind(0, '127.0.0.1', resolve); });
      const clientPort = socket.address().port;
      const association = Buffer.from([5, 3, 0, 1, 127, 0, 0, 1, clientPort >> 8, clientPort & 255]);
      control.write(association);
      const prefix = await read(4);
      assert.deepEqual(prefix, Buffer.from([5, 0, 0, 1]));
      const endpoint = await read(6);
      assert.ok(endpoint.subarray(0, 4).equals(Buffer.from([127, 0, 0, 1])) || endpoint.subarray(0, 4).equals(Buffer.alloc(4)));
      const relayPort = endpoint.readUInt16BE(4);
      const packet = Buffer.concat([Buffer.from([0, 0, 0, 1, 127, 0, 0, 1, targetPort >> 8, targetPort & 255]), payload]);
      await new Promise<void>((resolve, reject) => {
        socket.once('error', reject);
        socket.once('message', (message, peer) => {
          try {
            assert.equal(peer.address, '127.0.0.1'); assert.equal(peer.port, relayPort);
            assert.ok(message.subarray(0, 10).equals(packet.subarray(0, 10)), 'UDP relay returned unexpected source framing');
            assert.ok(message.subarray(10).equals(payload), 'UDP nonce did not traverse protocol node'); resolve();
          } catch (error) { reject(error); }
        });
        socket.send(packet, relayPort, '127.0.0.1', error => { if (error) reject(error); });
      });
    })(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('UDP_TIMEOUT')), timeout); })]);
  } finally { clearTimeout(timer); control.destroy(); try { socket.close(); } catch { /* not yet bound */ } }
}
