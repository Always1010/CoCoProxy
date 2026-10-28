import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { Agent, request } from 'node:https';
import { connect, createServer, type Socket } from 'node:net';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { connect as connectTls } from 'node:tls';
import type { Duplex } from 'node:stream';
import type { JsonObject } from '../config/index.ts';

export type BandwidthPhase = 'preparing' | 'latency' | 'download' | 'upload' | 'finishing';
export type BandwidthDirection = { status: 'pending' | 'running' | 'success' | 'insufficient' | 'failed' | 'cancelled'; mbps: number | null; liveMbps: number | null; bytes: number };
export type BandwidthReport = { phase?: BandwidthPhase; bytesUsed?: number; download?: BandwidthDirection; upload?: BandwidthDirection;
  latency?: { idle: number | null; download: number | null; upload: number | null }; reason?: string };
type TransferInput = { config: JsonObject; node: string; binaryPath: string; stateDirectory: string; signal: AbortSignal;
  limits: { durationMs: number; maxBytes: number; timeoutMs: number }; report: (update: BandwidthReport) => void;
  verification?: { targetMbps: number; warmupMs: number; minSampleMs: number } };
type TransportRuntime = { start: (binary: string, args: string[]) => ChildProcess };
const failure = (code = 'BANDWIDTH_UNAVAILABLE') => Object.assign(new Error(code), { code });
const object = (value: unknown): value is JsonObject => value !== null && typeof value === 'object' && !Array.isArray(value);
const builtins = new Set(['DIRECT', 'REJECT', 'REJECT-DROP', 'PASS', 'COMPATIBLE', 'GLOBAL']);

/** Only the selected compiled leaf and resolver settings enter the private task directory. */
export function buildBandwidthConfig(config: JsonObject, node: string, port: number): JsonObject {
  const leaf = Array.isArray(config.proxies) ? config.proxies.find(value => object(value) && value.name === node) : undefined;
  if (!object(leaf) || builtins.has(node.toUpperCase()) || typeof leaf.type !== 'string' ||
      ['direct', 'reject', 'pass', 'select', 'url-test', 'fallback', 'load-balance', 'relay'].includes(leaf.type.toLowerCase()) ||
      leaf['dialer-proxy'] !== undefined || leaf.dialer !== undefined || !Number.isInteger(port) || port < 1024 || port > 65535) throw failure();
  const dns: JsonObject = {};
  if (object(config.dns)) for (const [key, value] of Object.entries(config.dns)) {
    if (key !== 'listen' && key !== 'listen-routing-mark') dns[key] = structuredClone(value);
  }
  if (Object.keys(dns).length) dns['respect-rules'] = false;
  // DNS policies are still parsed with respect-rules disabled. Carry only their
  // referenced inline providers, without importing production routing/groups.
  const providers: JsonObject = {};
  for (const field of ['nameserver-policy', 'proxy-server-nameserver-policy']) {
    const policy = dns[field];
    if (!object(policy)) continue;
    for (const key of Object.keys(policy)) {
      if (!key.startsWith('rule-set:')) continue;
      for (const name of key.slice('rule-set:'.length).split(',').map(value => value.trim())) {
        const provider = object(config['rule-providers']) ? config['rule-providers'][name] : undefined;
        if (!name || !object(provider) || provider.type !== 'inline') throw failure('BANDWIDTH_CONFIG_INVALID');
        providers[name] = structuredClone(provider);
      }
    }
  }
  return { port, 'allow-lan': false, 'bind-address': '127.0.0.1', mode: 'rule', 'log-level': 'silent', ipv6: config.ipv6 === true,
    'geo-auto-update': false, profile: { 'store-selected': false, 'store-fake-ip': false }, tun: { enable: false },
    // Native TUN excludes all local UIDs. The unprivileged manager uses host routes;
    // copying the production SO_MARK would require capabilities its unit deliberately lacks.
    proxies: [{ ...structuredClone(leaf), name: 'BANDWIDTH-TARGET' }], rules: ['MATCH,BANDWIDTH-TARGET'],
    ...(Object.keys(providers).length ? { 'rule-providers': providers } : {}), ...(Object.keys(dns).length ? { dns } : {}) };
}

/** Counts application body bytes, including probes and unacknowledged upload writes. */
export class BandwidthByteBudget {
  used = 0;
  readonly maximum: number;
  constructor(maximum: number) { this.maximum = maximum; }
  get remaining(): number { return Math.max(0, this.maximum - this.used); }
  take(bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > this.remaining) throw failure('BANDWIDTH_BYTE_LIMIT');
    this.used += bytes;
  }
}

/** Private loopback CONNECT; TLS always verifies the fixed external origin. */
function proxyAgent(port: number, authentication: string, signal: AbortSignal): { agent: Agent; close: () => Promise<void> } {
  const sockets = new Set<Socket>();
  const agent = new Agent({ keepAlive: true, maxSockets: 3, maxFreeSockets: 3 });
  const track = (socket: Socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); return socket; };
  agent.createConnection = (_options, callback) => {
    let called = false;
    const done = (error: Error | null, socket?: Duplex) => { if (!called) { called = true; callback?.(error, socket!); } };
    const raw = track(connect({ host: '127.0.0.1', port }));
    raw.once('error', () => done(failure()));
    raw.once('close', () => done(failure()));
    let header = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      header = Buffer.concat([header, chunk]);
      if (header.length > 8192) { raw.destroy(); done(failure()); return; }
      const end = header.indexOf('\r\n\r\n');
      if (end < 0) return;
      raw.off('data', onData);
      if (!/^HTTP\/1\.[01] 200(?: |\r)/.test(header.subarray(0, end).toString('ascii')) || header.length !== end + 4) {
        raw.destroy(); done(failure()); return;
      }
      const tls = track(connectTls({ socket: raw, servername: 'speed.cloudflare.com', rejectUnauthorized: true, ALPNProtocols: ['http/1.1'] }));
      // TLS now owns the raw socket; its close event is the lifecycle boundary.
      sockets.delete(raw);
      tls.once('error', () => done(failure()));
      tls.once('close', () => done(failure()));
      tls.once('secureConnect', () => done(null, tls));
    };
    raw.on('data', onData);
    raw.once('connect', () => raw.write(`CONNECT speed.cloudflare.com:443 HTTP/1.1\r\nHost: speed.cloudflare.com:443\r\nProxy-Authorization: Basic ${Buffer.from(authentication).toString('base64')}\r\n\r\n`));
    return undefined as unknown as Duplex;
  };
  const close = () => { agent.destroy(); for (const socket of sockets) socket.destroy(); };
  signal.addEventListener('abort', close, { once: true });
  return { agent, close: async () => {
    signal.removeEventListener('abort', close);
    const closed = [...sockets].map(socket => socket.closed ? Promise.resolve() : new Promise<void>(resolve => socket.once('close', () => resolve())));
    close(); await Promise.all(closed);
  } };
}

type BodyRequest = { agent: Agent; signal: AbortSignal; budget: BandwidthByteBudget; method: 'GET' | 'POST'; size: number;
  onBytes?: (bytes: number) => void };
/** The helper accepts no URL, redirects, decompression, or alternate TLS identity. */
export function bandwidthBodyRequest(input: BodyRequest): Promise<{ bytes: number; elapsedMs: number }> {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    let received = 0, sent = 0, finished = false;
    const upload = input.method === 'POST';
    const maximumResponse = upload ? Math.min(65_536, input.budget.remaining - input.size) : input.size;
    if (maximumResponse < 0 || (!upload && input.size > input.budget.remaining) || input.signal.aborted) {
      reject(failure(input.signal.aborted ? 'BANDWIDTH_CANCELLED' : 'BANDWIDTH_BYTE_LIMIT')); return;
    }
    const req = request({ hostname: 'speed.cloudflare.com', port: 443, agent: input.agent, signal: input.signal,
      method: input.method, path: upload ? '/__up' : `/__down?bytes=${input.size}`,
      headers: { 'accept-encoding': 'identity', 'cache-control': 'no-cache, no-store', pragma: 'no-cache',
        ...(upload ? { 'content-type': 'application/octet-stream', 'content-length': input.size } : {}) } });
    const fail = (code = 'BANDWIDTH_UNAVAILABLE') => { if (!finished) { finished = true; req.destroy(); reject(failure(code)); } };
    req.once('error', () => fail(input.signal.aborted ? 'BANDWIDTH_CANCELLED' : 'BANDWIDTH_UNAVAILABLE'));
    req.once('response', response => {
      const encoding = response.headers['content-encoding'];
      const length = response.headers['content-length'];
      if (response.statusCode !== 200 || (encoding !== undefined && encoding !== 'identity') || response.headers.location !== undefined ||
          /^(?:HIT|STALE|UPDATING|REVALIDATED)$/i.test(String(response.headers['cf-cache-status'] ?? '')) ||
          (response.headers.age !== undefined && response.headers.age !== '0') ||
          (!upload && Number(length) !== input.size) || (length !== undefined && (!/^\d+$/.test(length) || Number(length) > maximumResponse))) {
        response.destroy(); fail(); return;
      }
      response.on('data', (chunk: Buffer) => {
        if (received + chunk.length > maximumResponse || chunk.length > input.budget.remaining) { response.destroy(); fail('BANDWIDTH_BYTE_LIMIT'); return; }
        input.budget.take(chunk.length); received += chunk.length;
        if (!upload) input.onBytes?.(chunk.length);
      });
      response.once('error', () => fail());
      response.once('end', () => {
        if (finished) return;
        if (!response.complete || (upload ? sent !== input.size || !req.writableFinished : received !== input.size)) { fail(); return; }
        finished = true;
        resolve({ bytes: upload ? sent : received, elapsedMs: performance.now() - started });
      });
    });
    if (!upload) { req.end(); return; }
    const write = () => {
      if (finished || input.signal.aborted) return;
      try {
        while (sent < input.size) {
          const body = randomBytes(Math.min(65_536, input.size - sent));
          input.budget.take(body.length); sent += body.length; input.onBytes?.(body.length);
          if (!req.write(body)) { req.once('drain', write); return; }
        }
        req.end();
      } catch { fail('BANDWIDTH_BYTE_LIMIT'); }
    };
    write();
  });
}

async function availablePort(): Promise<number> {
  const server = createServer();
  return await new Promise((resolve, reject) => {
    server.once('error', () => reject(failure()));
    server.listen(0, '127.0.0.1', () => { const address = server.address(); const port = typeof address === 'object' && address ? address.port : 0;
      server.close(error => error || port < 1024 ? reject(failure()) : resolve(port)); });
  });
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>(resolve => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 1000);
    child.once('close', () => { clearTimeout(timer); resolve(); });
    child.kill('SIGTERM');
  });
}

/** Validate the exact task file before opening a listener; expose only fixed error codes. */
async function validateChild(child: ChildProcess, signal: AbortSignal): Promise<void> {
  let stopping: Promise<void> | undefined;
  const stop = () => { stopping ??= stopChild(child); };
  const timer = setTimeout(stop, 5000);
  signal.addEventListener('abort', stop, { once: true });
  const valid = await new Promise<boolean>(resolve => {
    let failed = false;
    child.once('error', () => { failed = true; });
    child.once('close', code => resolve(!failed && code === 0));
    if (signal.aborted) stop();
  });
  clearTimeout(timer); signal.removeEventListener('abort', stop);
  await stopping;
  if (!valid) throw failure('BANDWIDTH_CONFIG_INVALID');
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise(resolve => { const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, ms); signal.addEventListener('abort', done, { once: true }); });
}

export async function runBandwidthTransfer(input: TransferInput, runtime: TransportRuntime = {
  start: (binary, args) => spawn(binary, args, { stdio: 'ignore', windowsHide: true }),
}): Promise<{ reason: string | null }> {
  if (!Number.isSafeInteger(input.limits.maxBytes) || input.limits.maxBytes < 8192 || input.limits.maxBytes > 200_000_000 ||
      !Number.isSafeInteger(input.limits.durationMs) || input.limits.durationMs < 1 || input.limits.durationMs > (input.verification ? 15000 : 6000) ||
      !Number.isSafeInteger(input.limits.timeoutMs) || input.limits.timeoutMs < 1 || input.limits.timeoutMs > 30_000) throw failure();
  if (input.verification && (!Number.isFinite(input.verification.targetMbps) || input.verification.targetMbps < 1 || input.verification.targetMbps > 100
      || !Number.isSafeInteger(input.verification.warmupMs) || input.verification.warmupMs < 1000
      || !Number.isSafeInteger(input.verification.minSampleMs) || input.verification.minSampleMs < 3000
      || input.verification.warmupMs + input.verification.minSampleMs > input.limits.durationMs)) throw failure();
  const lifetime = new AbortController();
  let timedOut = false, directory: string | undefined, child: ChildProcess | undefined, proxy: ReturnType<typeof proxyAgent> | undefined;
  const cancel = () => lifetime.abort();
  input.signal.addEventListener('abort', cancel, { once: true });
  if (input.signal.aborted) cancel();
  const hardTimeout = setTimeout(() => { timedOut = true; lifetime.abort(); }, input.limits.timeoutMs);
  const budget = new BandwidthByteBudget(input.limits.maxBytes);
  let reason: string | null = null;
  const latency: { idle: number | null; download: number | null; upload: number | null } = { idle: null, download: null, upload: null };
  const check = () => { if (lifetime.signal.aborted) throw failure(timedOut ? 'BANDWIDTH_TIMEOUT' : 'BANDWIDTH_CANCELLED'); };
  const emit = (value: BandwidthReport) => { try { input.report({ ...value, bytesUsed: budget.used }); } catch { /* Observers cannot interrupt cleanup. */ } };
  try {
    emit({ phase: 'preparing' }); check();
    const port = await availablePort(); check();
    const config = buildBandwidthConfig(input.config, input.node, port);
    const authentication = `task:${randomBytes(24).toString('hex')}`;
    config.authentication = [authentication];
    directory = await mkdtemp(join(input.stateDirectory, 'bandwidth-'));
    await chmod(directory, 0o700);
    await writeFile(join(directory, 'config.json'), JSON.stringify(config), { mode: 0o600, flag: 'wx' }); check();
    child = runtime.start(input.binaryPath, ['-t', '-d', directory, '-f', join(directory, 'config.json')]);
    await validateChild(child, lifetime.signal); check();
    child = runtime.start(input.binaryPath, ['-d', directory, '-f', join(directory, 'config.json')]);
    let exited = false;
    child.once('error', () => { exited = true; lifetime.abort(); });
    child.once('exit', () => { exited = true; lifetime.abort(); });
    // A task port is never used until the isolated process is observed alive and accepting connections.
    const readyBy = performance.now() + Math.min(5000, input.limits.timeoutMs);
    while (true) {
      check(); if (exited) throw failure();
      const ready = await new Promise<boolean>(resolve => {
        const socket = connect({ host: '127.0.0.1', port });
        let connected = false;
        const abort = () => socket.destroy();
        lifetime.signal.addEventListener('abort', abort, { once: true });
        const done = (value: boolean) => { connected ||= value; socket.destroy(); };
        socket.setTimeout(150, () => done(false)); socket.once('connect', () => done(true)); socket.once('error', () => done(false));
        socket.once('close', () => { lifetime.signal.removeEventListener('abort', abort); resolve(connected); });
      });
      if (ready) break;
      if (performance.now() >= readyBy) throw failure();
      await pause(75, lifetime.signal);
    }
    proxy = proxyAgent(port, authentication, lifetime.signal);
    emit({ phase: 'latency' });
    const ping = async (signal: AbortSignal) => (await bandwidthBodyRequest({ agent: proxy!.agent, signal, budget, method: 'GET', size: 1024 })).elapsedMs;
    const initial = AbortSignal.any([lifetime.signal, AbortSignal.timeout(3000)]);
    await ping(initial); // Warm the tunnel/TLS connection before comparable RTT samples.
    const baseline: number[] = [];
    for (let index = 0; index < 3; index++) baseline.push(await ping(AbortSignal.any([lifetime.signal, AbortSignal.timeout(3000)])));
    latency.idle = Math.round(baseline.sort((a, b) => a - b)[1]); emit({ latency: { ...latency } });
    if (input.verification) {
      const result = await runDownloadVerification({ ...input.verification, durationMs: input.limits.durationMs,
        signal: lifetime.signal, budget, request: (size, signal, onBytes) => bandwidthBodyRequest({
          agent: proxy!.agent, signal, budget, method: 'GET', size, onBytes }),
        report: bytes => emit({ phase: 'download', download: { status: 'running', bytes, mbps: null, liveMbps: null } }),
      });
      emit({ download: result }); check();
      return { reason: result.status === 'success' ? null : 'BANDWIDTH_SAMPLE_INSUFFICIENT' };
    }
    for (const name of ['download', 'upload'] as const) {
      check();
      const phase = new AbortController();
      const signal = AbortSignal.any([lifetime.signal, phase.signal]);
      const timer = setTimeout(() => phase.abort(), input.limits.durationMs);
      const started = performance.now();
      let bytes = 0, acknowledged = 0, failed = false, capped = false, sampleBytes = 0, sampleAt = started;
      let chunkSize = 16 * 1024;
      const result: BandwidthDirection = { status: 'running', mbps: null, liveMbps: null, bytes: 0 };
      emit({ phase: name, [name]: { ...result } });
      // Downloads consume at most 45%, leaving an upload budget and probe/response allowance.
      const limit = name === 'download' ? Math.floor(input.limits.maxBytes * 0.45) : input.limits.maxBytes;
      const progress = (count: number) => {
        bytes += count;
        const now = performance.now();
        if (now - sampleAt >= 250) {
          result.liveMbps = Math.round((bytes - sampleBytes) * 8 / (now - sampleAt) / 1000 * 100) / 100;
          sampleAt = now; sampleBytes = bytes;
          emit({ [name]: { ...result, bytes } });
        }
      };
      const probes = (async () => {
        while (!signal.aborted && budget.remaining > 8192) {
          await pause(800, signal); if (signal.aborted) break;
          try { const measured = await ping(AbortSignal.any([signal, AbortSignal.timeout(2000)])); latency[name] = Math.round(measured); emit({ latency: { ...latency } }); }
          catch { /* A failed loaded probe does not invent a latency value or fail a transfer. */ }
        }
      })();
      try {
        while (!signal.aborted && bytes < limit) {
          // Start small so slow links can complete a sample within the deadline.
          const size = Math.min(chunkSize, limit - bytes, budget.remaining - 131_072);
          if (size < 1024) { capped = true; break; }
          const response = await bandwidthBodyRequest({ agent: proxy.agent, signal, budget, method: name === 'download' ? 'GET' : 'POST', size, onBytes: progress });
          acknowledged += response.bytes;
          chunkSize = Math.max(16 * 1024, Math.min(2 * 1024 * 1024, Math.floor(response.bytes / Math.max(1, response.elapsedMs) * 500)));
        }
      } catch { failed = !signal.aborted; }
      finally { clearTimeout(timer); phase.abort(); await probes; }
      const elapsed = performance.now() - started;
      capped ||= bytes >= limit && elapsed < input.limits.durationMs;
      result.bytes = bytes;
      result.status = lifetime.signal.aborted ? 'cancelled' : failed ? 'failed' : acknowledged < 1024 || elapsed < 500 ? 'insufficient' : 'success';
      result.mbps = result.status === 'success' ? Math.round((name === 'download' ? bytes : acknowledged) * 8 / elapsed / 1000 * 100) / 100 : null;
      result.liveMbps = null;
      if (failed) reason = 'BANDWIDTH_UNAVAILABLE';
      else if (capped && reason !== 'BANDWIDTH_UNAVAILABLE') reason = 'BANDWIDTH_BYTE_LIMIT';
      emit({ [name]: { ...result } }); check();
    }
    return { reason };
  } catch (error) {
    const code = timedOut ? 'BANDWIDTH_TIMEOUT' : input.signal.aborted ? 'BANDWIDTH_CANCELLED' :
      error instanceof Error && 'code' in error && ['BANDWIDTH_BYTE_LIMIT', 'BANDWIDTH_CONFIG_INVALID'].includes(String(error.code))
        ? String(error.code) : 'BANDWIDTH_UNAVAILABLE';
    throw failure(code);
  } finally {
    emit({ phase: 'finishing' });
    clearTimeout(hardTimeout); input.signal.removeEventListener('abort', cancel);
    lifetime.abort(); const socketsClosed = proxy?.close();
    if (child) await stopChild(child);
    await socketsClosed;
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}

/** Known offered load, one bounded request at a time. A paced result proves at most targetMbps. */
export async function runDownloadVerification(input: {
  targetMbps: number; warmupMs: number; minSampleMs: number; durationMs: number; signal: AbortSignal;
  budget: BandwidthByteBudget;
  request: (size: number, signal: AbortSignal, onBytes: (bytes: number) => void) => Promise<{ bytes: number; elapsedMs: number }>;
  report: (bytes: number) => void;
}): Promise<BandwidthDirection> {
  const phase = new AbortController(), signal = AbortSignal.any([input.signal, phase.signal]);
  const timer = setTimeout(() => phase.abort(), input.durationMs);
  const started = performance.now();
  let bytes = 0, sampleBytes = 0, sampleAt = 0, failed = false;
  const offeredBytesPerMs = input.targetMbps * 125 * 1.25;
  const chunk = Math.max(16384, Math.min(1048576, Math.floor(offeredBytesPerMs * 500)));
  try {
    while (!signal.aborted && input.budget.remaining > 131072) {
      const size = Math.min(chunk, input.budget.remaining - 65536), slot = performance.now();
      await input.request(size, signal, count => {
        bytes += count;
        const at = performance.now();
        if (!sampleAt && at - started >= input.warmupMs) { sampleAt = at; sampleBytes = bytes; }
        input.report(bytes);
      });
      await pause(Math.max(0, size / offeredBytesPerMs - (performance.now() - slot)), signal);
    }
  } catch { failed = !signal.aborted; }
  finally { clearTimeout(timer); phase.abort(); }
  const elapsed = sampleAt ? performance.now() - sampleAt : 0;
  const status = input.signal.aborted ? 'cancelled' : failed ? 'failed'
    : elapsed < input.minSampleMs || bytes - sampleBytes < 1024 ? 'insufficient' : 'success';
  return { status, bytes, liveMbps: null,
    mbps: status === 'success' ? Math.min(input.targetMbps, (bytes - sampleBytes) * 8 / elapsed / 1000) : null };
}
