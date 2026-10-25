import WebSocket from 'ws';
import { ManagementError, exactRecord, readJsonBody } from './http.ts';
import { singleFlight } from './shared-work.ts';

export type ControllerTarget = { generation: string; port: number; secret: string };
export type ControllerClient = { send: (text: string) => void; close: (code: number, reason: string) => void };
export type ControllerProxyOptions = {
  target: () => Promise<ControllerTarget>;
  isCurrent: (generation: string) => Promise<boolean>;
  mutate: <T>(action: () => Promise<T>) => Promise<T>;
  allowedProbeOrigins?: readonly string[];
};

export const DEFAULT_LATENCY_PROBE_ORIGIN = 'https://www.gstatic.com';

const HTTP_LIMIT = 2 * 1024 * 1024;
const RULES_LIMIT = 4 * 1024 * 1024;
const FRAME_LIMIT = 1024 * 1024;
const sensitiveKey = /secret|password|token|private[-_]?key/i;

function redact(value: unknown, secret: string, maximumValues = 100_000): unknown {
  let remaining = maximumValues;
  const visit = (input: unknown, depth: number): unknown => {
    // Bound recursion and total work before constructing the browser response.
    if (depth > 64 || --remaining < 0) throw new Error('JSON complexity limit');
    if (typeof input === 'string') return input.split(secret).join('[REDACTED]');
    if (Array.isArray(input)) return input.map(item => visit(item, depth + 1));
    if (input !== null && typeof input === 'object') {
      const output: Record<string, unknown> = Object.create(null);
      for (const [key, item] of Object.entries(input)) output[key.split(secret).join('[REDACTED]')] = sensitiveKey.test(key) ? '[REDACTED]' : visit(item, depth + 1);
      return output;
    }
    return input;
  };
  return visit(value, 0);
}

function validateTarget(target: ControllerTarget): ControllerTarget {
  if (!target || typeof target.generation !== 'string' || !/^[A-Za-z0-9._-]{1,160}$/.test(target.generation) ||
      !Number.isInteger(target.port) || target.port < 1 || target.port > 65535 ||
      typeof target.secret !== 'string' || !target.secret || /[\r\n]/.test(target.secret)) throw new ManagementError('CONTROLLER_UNAVAILABLE', 503);
  return { ...target };
}

function response(value: unknown, status: number, generation?: string): Response {
  return new Response(status === 204 || status === 205 || status === 304 ? null : JSON.stringify(value), { status, headers: {
    'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
    ...(generation === undefined ? {} : { 'x-coproxy-generation': generation })
  } });
}

function pathParts(request: Request): { parts: string[]; url: URL } {
  const url = new URL(request.url);
  if (request.headers.has('authorization') || url.username || url.password || url.hash || url.pathname.length > 4096) throw new ManagementError('CONTROLLER_REQUEST_DENIED');
  let parts: string[];
  try { parts = url.pathname.split('/').slice(1).map(part => decodeURIComponent(part)); }
  catch { throw new ManagementError('CONTROLLER_REQUEST_DENIED'); }
  if (parts.some(part => !part || /[%/\\\x00-\x1f\x7f]/.test(part) || part.includes('..'))) throw new ManagementError('CONTROLLER_REQUEST_DENIED');
  return { parts, url };
}

function query(url: URL, allowed: readonly string[]): void {
  const seen = new Set<string>();
  for (const [key] of url.searchParams) {
    if (!allowed.includes(key) || seen.has(key)) throw new ManagementError('CONTROLLER_QUERY_DENIED');
    seen.add(key);
  }
}

function httpRoute(request: Request, origins: ReadonlySet<string>): { path: string; mutation: boolean; deadlineMs: number; probe: boolean } {
  const { parts: p, url } = pathParts(request);
  const proxy = p[0] === 'proxies' && p.length === 2;
  const connection = p[0] === 'connections' && p.length <= 2;
  const delay = ((p[0] === 'proxies' || p[0] === 'group') && p.length === 3 && p[2] === 'delay') ||
    (p[0] === 'providers' && p[1] === 'proxies' && p.length === 5 && p[4] === 'healthcheck');
  const read = (p.length === 1 && ['version', 'configs', 'proxies', 'group', 'rules', 'connections'].includes(p[0])) || proxy ||
    (p[0] === 'group' && p.length === 2) || (p[0] === 'providers' && ['proxies', 'rules'].includes(p[1]) && [2, 3].includes(p.length));
  const mutation = (request.method === 'PUT' && proxy) || (request.method === 'DELETE' && (proxy || connection));
  if (!(request.method === 'GET' && (read || delay)) && !mutation) throw new ManagementError('CONTROLLER_ROUTE_DENIED', 405);
  if (request.method !== 'PUT' && request.body !== null) throw new ManagementError('CONTROLLER_REQUEST_DENIED');
  query(url, delay ? ['url', 'timeout'] : []);
  let deadlineMs = 5000;
  if (delay) {
    let probe: URL;
    try { probe = new URL(url.searchParams.get('url') ?? ''); } catch { throw new ManagementError('CONTROLLER_PROBE_DENIED'); }
    const timeout = url.searchParams.get('timeout') ?? '';
    if (probe.protocol !== 'https:' || probe.username || probe.password || probe.hash || !origins.has(probe.origin) ||
        !/^[1-9]\d{0,4}$/.test(timeout) || Number(timeout) > 10000) throw new ManagementError('CONTROLLER_PROBE_DENIED');
    // The controller deadline must outlive the core's requested probe budget.
    // A fixed 5s deadline raced the UI's 5s default and converted valid slow
    // measurements into an opaque controller failure.
    deadlineMs = Number(timeout) + 2000;
  }
  return { path: '/' + p.map(part => encodeURIComponent(part)).join('/') + url.search, mutation, deadlineMs, probe: delay };
}

async function upstream(target: ControllerTarget, path: string, method: string, deadlineMs: number, probe: boolean, body?: string, signal?: AbortSignal): Promise<Response> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), deadlineMs);
  try {
    const result = await fetch(`http://127.0.0.1:${target.port}${path}`, { method, redirect: 'manual', signal: signal ? AbortSignal.any([abort.signal, signal]) : abort.signal,
      headers: { authorization: `Bearer ${target.secret}`, accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body }) });
    if (result.status >= 300 || result.status < 200) {
      await result.body?.cancel();
      if (probe && result.status === 504)
        return response({ error: { code: 'CONTROLLER_PROBE_TIMEOUT' } }, 504, target.generation);
      return response({ error: { code: 'CONTROLLER_UPSTREAM_FAILED' } }, 502, target.generation);
    }
    const rules = method === 'GET' && path === '/rules';
    const reader = result.body?.getReader();
    let size = 0;
    const chunks: Uint8Array[] = [];
    if (reader) {
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          size += next.value.byteLength;
          if (size > (rules ? RULES_LIMIT : HTTP_LIMIT)) { await reader.cancel(); throw new Error('limit'); }
          chunks.push(next.value);
        }
      } finally { reader.releaseLock(); }
    }
    if (result.status === 204 || result.status === 205) return response(null, result.status, target.generation);
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
    return response(redact(value, target.secret, rules ? 250_000 : 100_000), result.status, target.generation);
  } catch (error) {
    const timedOut = probe && error !== null && typeof error === 'object' && (error as { name?: unknown }).name === 'AbortError';
    return response({ error: { code: timedOut ? 'CONTROLLER_PROBE_TIMEOUT' : 'CONTROLLER_UNAVAILABLE' } }, timedOut ? 504 : 502, target.generation);
  }
  finally { clearTimeout(timer); }
}

/** The caller supplies authenticated requests and serializes mutations with config apply. */
export function createControllerProxy(options: ControllerProxyOptions): {
  fetch: (request: Request) => Promise<Response>;
  relay: (request: Request, client: ControllerClient, authorized: () => boolean) => Promise<() => void>;
} {
  const readTarget = singleFlight(options.target);
  let probing = 0;
  const origins = new Set((options.allowedProbeOrigins ?? []).map(input => {
    const url = new URL(input);
    if (url.protocol !== 'https:' || url.origin !== input || url.username || url.password) throw new ManagementError('CONTROLLER_PROBE_ORIGIN_INVALID');
    return url.origin;
  }));
  return {
    async fetch(request) {
      let generation: string | undefined;
      let probeSlot = false;
      try {
        const route = httpRoute(request, origins);
        if (route.probe) {
          if (probing >= 16) throw new ManagementError('CONTROLLER_PROBE_BUSY', 429);
          probing++; probeSlot = true;
        }
        let body: string | undefined;
        if (request.method === 'PUT') {
          const record = exactRecord(await readJsonBody(request, 8192), ['name']);
          if (typeof record.name !== 'string' || !record.name || record.name.length > 1024 || /[\x00-\x1f\x7f]/.test(record.name)) throw new ManagementError('CONTROLLER_REQUEST_DENIED');
          body = JSON.stringify(record);
        }
        const current = validateTarget(await (route.mutation ? options.target() : readTarget()));
        generation = current.generation;
        if (!route.mutation) {
          request.signal.throwIfAborted();
          if (!await options.isCurrent(current.generation)) throw new ManagementError('CONTROLLER_GENERATION_CONFLICT', 409);
          return await upstream(current, route.path, request.method, route.deadlineMs, route.probe, body, request.signal);
        }
        const expected = request.headers.get('if-match');
        if (!expected || expected !== current.generation) throw new ManagementError('CONTROLLER_GENERATION_CONFLICT', 409);
        return await options.mutate(async () => {
          const locked = validateTarget(await options.target());
          generation = locked.generation;
          if (locked.generation !== expected) throw new ManagementError('CONTROLLER_GENERATION_CONFLICT', 409);
          return upstream(locked, route.path, request.method, route.deadlineMs, route.probe, body);
        });
      } catch (error) {
        return response({ error: { code: error instanceof ManagementError ? error.code : 'CONTROLLER_UNAVAILABLE' } }, error instanceof ManagementError ? error.status : 503, generation);
      } finally { if (probeSlot) probing--; }
    },
    async relay(request, client, authorized) {
      let socket: WebSocket | undefined;
      let timer: ReturnType<typeof setInterval> | undefined;
      let drain: ReturnType<typeof setImmediate> | undefined;
      let closed = false;
      let checking = false;
      let queuedBytes = 0;
      const queue: string[] = [];
      const permitted = () => { try { return authorized(); } catch { return false; } };
      let settleFailure: (() => void) | undefined;
      const stop = (code = 1000, reason = 'Controller closed') => {
        if (closed) return;
        closed = true;
        clearInterval(timer); clearImmediate(drain);
        queue.length = 0; queuedBytes = 0;
        if (socket && socket.readyState !== WebSocket.CLOSED) socket.terminate();
        try { client.close(code, reason); } catch { /* disconnected client */ }
        settleFailure?.();
      };
      try {
        if (!permitted()) throw new ManagementError('UNAUTHORIZED', 401);
        const { parts, url } = pathParts(request);
        if (request.method !== 'GET' || parts.length !== 1 || !['traffic', 'connections', 'memory', 'logs'].includes(parts[0])) throw new ManagementError('CONTROLLER_ROUTE_DENIED');
        query(url, parts[0] === 'logs' ? ['level'] : ['interval']);
        const interval = url.searchParams.get('interval');
        if (interval !== null && (!/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(interval) || Number(interval) < 0.1 || Number(interval) > 10)) throw new ManagementError('CONTROLLER_QUERY_DENIED');
        const level = url.searchParams.get('level');
        if (level !== null && !['debug', 'info', 'warning', 'error', 'silent'].includes(level)) throw new ManagementError('CONTROLLER_QUERY_DENIED');
        const target = validateTarget(await readTarget());
        if (!permitted() || !await options.isCurrent(target.generation)) throw new ManagementError('CONTROLLER_GENERATION_CONFLICT', 409);
        socket = new WebSocket(`ws://127.0.0.1:${target.port}/${parts[0]}${url.search}`, { headers: { authorization: `Bearer ${target.secret}` },
          handshakeTimeout: 5000, maxPayload: FRAME_LIMIT, followRedirects: false, perMessageDeflate: false });
        const opened = new Promise<void>((resolve, reject) => {
          settleFailure = () => reject(new ManagementError('CONTROLLER_UNAVAILABLE', 502));
          socket!.once('open', () => { settleFailure = undefined; resolve(); });
        });
        socket.on('error', () => stop(1011, 'Controller unavailable'));
        socket.on('close', () => stop(1000, 'Controller closed'));
        const flush = () => {
          drain = undefined;
          if (closed) return;
          if (!permitted()) { stop(1008, 'Session expired'); return; }
          const value = queue.shift();
          if (value === undefined) return;
          queuedBytes -= Buffer.byteLength(value);
          try {
            const started = performance.now();
            client.send(value);
            if (performance.now() - started > 100) { stop(1008, 'Client too slow'); return; }
          } catch { stop(1011, 'Client unavailable'); return; }
          if (queue.length) drain = setImmediate(flush);
        };
        socket.on('message', (data, binary) => {
          if (closed) return;
          if (!permitted()) { stop(1008, 'Session expired'); return; }
          try {
            if (binary) throw new Error('binary');
            const bytes = Array.isArray(data) ? Buffer.concat(data) : data instanceof ArrayBuffer ? new Uint8Array(data) : data;
            if (bytes.byteLength > FRAME_LIMIT) throw new Error('limit');
            const value = JSON.stringify(redact(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), target.secret));
            queuedBytes += Buffer.byteLength(value);
            if (Buffer.byteLength(value) > FRAME_LIMIT || queue.length >= 32 || queuedBytes > HTTP_LIMIT) throw new Error('queue');
            queue.push(value);
            if (!drain) drain = setImmediate(flush);
          } catch { stop(1008, 'Invalid controller frame'); }
        });
        timer = setInterval(() => {
          if (!permitted()) { stop(1008, 'Session expired'); return; }
          if (checking || closed) return;
          checking = true;
          void options.isCurrent(target.generation).then(current => { if (!current) stop(1008, 'Controller changed'); }, () => stop(1011, 'Controller unavailable'))
            .finally(() => { checking = false; });
        }, 1000);
        await opened;
        if (closed) throw new ManagementError('CONTROLLER_UNAVAILABLE', 502);
        return () => stop();
      } catch (error) {
        stop(1008, 'Controller unavailable');
        throw error instanceof ManagementError ? error : new ManagementError('CONTROLLER_UNAVAILABLE', 502);
      }
    }
  };
}
