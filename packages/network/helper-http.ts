import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { types } from 'node:util';

export interface GatewayHelperHandler {
  status(): Promise<unknown>;
  stage(policy: unknown, sources?: unknown): Promise<unknown>;
  apply(generation: string, expectedRevision: number): Promise<unknown>;
  recover(): Promise<unknown>;
}

export interface GatewayHelperHttpOptions { port: number; tokenSha256: string }
export interface GatewayHelperHttpServer { port: number; close(): Promise<void> }

const maxBytes = 1024 * 1024;
const bodyTimeoutMs = 3000;
const hex = /^[a-f0-9]{64}$/;
const safeErrors = new Map<string, number>([
  ['NETWORK_BUSY', 409], ['NETWORK_REVISION_CONFLICT', 409], ['NETWORK_RECOVERY_REQUIRED', 409],
  ['NETWORK_APPLY_FAILED', 500], ['NETWORK_COMMAND_UNSETTLED', 503], ['NETWORK_STORE_IO', 500],
  ['NETWORK_HELPER_POLICY_INVALID', 400], ['NETWORK_HELPER_CANDIDATE_INVALID', 400],
  ['NETWORK_HELPER_CANDIDATE_NOT_FOUND', 404], ['NETWORK_HELPER_STATE_INVALID', 500],
]);

class RequestFailure extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string) { super(code); this.status = status; this.code = code; }
}
function reject(status: number, code = 'NETWORK_HELPER_REQUEST_INVALID'): never {
  throw new RequestFailure(status, code);
}

// Only data properties are inspected: backend errors must never run a code getter.
function publicError(error: unknown): { status: number; code: string } {
  if (types.isProxy(error)) return { status: 500, code: 'NETWORK_HELPER_FAILED' };
  if (error instanceof RequestFailure) return { status: error.status, code: error.code };
  try {
    if (typeof error === 'object' && error !== null && !types.isProxy(error)) {
      const descriptor = Object.getOwnPropertyDescriptor(error, 'code');
      const code = descriptor && 'value' in descriptor ? descriptor.value : undefined;
      if (typeof code === 'string' && safeErrors.has(code)) return { status: safeErrors.get(code)!, code };
    }
  } catch { /* Unknown errors have one fixed public representation. */ }
  return { status: 500, code: 'NETWORK_HELPER_FAILED' };
}

function send(res: ServerResponse, status: number, body: string): void {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store', 'connection': 'close', 'x-content-type-options': 'nosniff' });
  res.end(body);
}

function encodeResponse(value: unknown): string {
  if (types.isProxy(value)) throw new Error();
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error();
  const seen = new Set<object>();
  let items = 0;
  function inspect(current: unknown, depth: number): void {
    if (++items > 100_000 || depth > 64) throw new Error();
    if (current === null || typeof current === 'string' || typeof current === 'boolean') return;
    if (typeof current === 'number' && Number.isFinite(current)) return;
    if (typeof current !== 'object' || current === null || types.isProxy(current) || seen.has(current)) throw new Error();
    const prototype = Object.getPrototypeOf(current);
    if (prototype !== Object.prototype && prototype !== null && !(Array.isArray(current) && prototype === Array.prototype)) throw new Error();
    seen.add(current);
    for (const key of Reflect.ownKeys(current)) {
      if (Array.isArray(current) && key === 'length') continue;
      if (typeof key !== 'string' || key === 'toJSON') throw new Error();
      const descriptor = Object.getOwnPropertyDescriptor(current, key)!;
      if (!('value' in descriptor) || !descriptor.enumerable) throw new Error();
      inspect(descriptor.value, depth + 1);
    }
    seen.delete(current);
  }
  inspect(value, 0);
  const body = JSON.stringify(value);
  if (Buffer.byteLength(body) > maxBytes) throw new Error();
  return body;
}

function headers(req: IncomingMessage, port: number, expectedToken: Buffer): number {
  const counts = new Map<string, number>();
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    const name = req.rawHeaders[i]!.toLowerCase();
    counts.set(name, (counts.get(name) ?? 0) + 1);
    if (name === 'origin' || name === 'referer' || name.startsWith('sec-fetch-')) reject(403);
  }
  for (const name of ['host', 'authorization', 'content-type', 'content-length']) {
    if ((counts.get(name) ?? 0) > 1) reject(400);
  }
  if (req.headers.host !== `127.0.0.1:${port}` || req.httpVersion !== '1.1') reject(400);
  if (req.headers['transfer-encoding'] !== undefined || req.headers['content-encoding'] !== undefined ||
      req.headers.expect !== undefined || req.headers.upgrade !== undefined) reject(400);
  const auth = req.headers.authorization;
  if (typeof auth !== 'string' || !/^Bearer [a-f0-9]{64}$/.test(auth) ||
      !timingSafeEqual(createHash('sha256').update(auth.slice(7), 'utf8').digest(), expectedToken)) {
    reject(401, 'NETWORK_HELPER_UNAUTHORIZED');
  }
  const contentLength = req.headers['content-length'];
  if (contentLength === undefined) {
    if (req.method === 'POST') reject(411);
    return 0;
  }
  if (!/^(0|[1-9][0-9]*)$/.test(contentLength)) reject(400);
  const length = Number(contentLength);
  if (!Number.isSafeInteger(length) || length > maxBytes) reject(413);
  if (req.method === 'GET' && length !== 0) reject(400);
  return length;
}

async function body(req: IncomingMessage, length: number): Promise<Record<string, unknown>> {
  if (req.headers['content-type'] !== 'application/json' || length === 0) reject(400);
  const raw = await new Promise<Buffer>((resolve, rejectBody) => {
    const chunks: Buffer[] = [];
    let received = 0;
    const cleanup = () => {
      clearTimeout(timer); req.off('data', data); req.off('end', end); req.off('error', failed); req.off('aborted', failed);
    };
    const failed = () => { cleanup(); rejectBody(new RequestFailure(400, 'NETWORK_HELPER_REQUEST_INVALID')); };
    const data = (chunk: Buffer) => {
      received += chunk.length;
      if (received > maxBytes || received > length) {
        cleanup(); req.pause(); rejectBody(new RequestFailure(413, 'NETWORK_HELPER_REQUEST_INVALID')); return;
      }
      chunks.push(chunk);
    };
    const end = () => { cleanup(); resolve(Buffer.concat(chunks, received)); };
    const timer = setTimeout(() => {
      cleanup(); req.pause(); rejectBody(new RequestFailure(408, 'NETWORK_HELPER_REQUEST_TIMEOUT'));
    }, bodyTimeoutMs);
    req.on('data', data); req.once('end', end); req.once('error', failed); req.once('aborted', failed);
  });
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw);
    const parsed: unknown = JSON.parse(text);
    if (raw.length !== length || JSON.stringify(parsed) !== text || parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) reject(400);
    return parsed as Record<string, unknown>;
  } catch { return reject(400); }
}

function exactKeys(value: Record<string, unknown>, expected: string[]): void {
  const keys = Object.keys(value);
  if (keys.length !== expected.length || keys.some(key => !expected.includes(key))) reject(400);
}

async function serve(options: GatewayHelperHttpOptions, handler: GatewayHelperHandler, fixture: boolean): Promise<GatewayHelperHttpServer> {
  if (!Number.isInteger(options.port) || (fixture && options.port === 0 ? false : options.port < 1024 || options.port > 65535) || !hex.test(options.tokenSha256)) {
    throw new Error('NETWORK_HELPER_CONFIG_INVALID');
  }
  const expectedToken = Buffer.from(options.tokenSha256, 'hex');
  let port = 0;
  let closing = false;
  const active = new Set<Promise<void>>();
  const server = createServer({ maxHeaderSize: 16 * 1024, headersTimeout: 5000, requestTimeout: 5000, keepAliveTimeout: 1000 }, (req, res) => {
    const work = (async () => {
      try {
        if (closing || active.size >= 8) reject(503, 'NETWORK_HELPER_OVERLOADED');
        const length = headers(req, port, expectedToken);
        if (req.method === 'GET' && req.url === '/v1/status') {
          send(res, 200, encodeResponse(await handler.status())); return;
        }
        if (req.method !== 'POST' || !['/v1/candidates', '/v1/apply', '/v1/recover'].includes(req.url ?? '')) reject(404);
        const parsed = await body(req, length);
        let result: unknown;
        if (req.url === '/v1/candidates') {
          exactKeys(parsed, Object.hasOwn(parsed, 'sources') ? ['policy', 'sources'] : ['policy']);
          result = await handler.stage(parsed.policy, parsed.sources);
        } else if (req.url === '/v1/apply') {
          exactKeys(parsed, ['generation', 'expectedRevision']);
          if (typeof parsed.generation !== 'string' || !hex.test(parsed.generation) ||
              typeof parsed.expectedRevision !== 'number' || !Number.isSafeInteger(parsed.expectedRevision) || parsed.expectedRevision < 0) reject(400);
          result = await handler.apply(parsed.generation, parsed.expectedRevision);
        } else { exactKeys(parsed, []); result = await handler.recover(); }
        send(res, 200, encodeResponse(result));
      } catch (error) {
        const failure = publicError(error);
        send(res, failure.status, JSON.stringify({ error: { code: failure.code } }));
      }
    })();
    active.add(work);
    void work.finally(() => { active.delete(work); if (closing) server.closeIdleConnections(); });
  });
  server.on('checkContinue', (_req, res) => send(res, 400, '{"error":{"code":"NETWORK_HELPER_REQUEST_INVALID"}}'));
  server.on('checkExpectation', (_req, res) => send(res, 400, '{"error":{"code":"NETWORK_HELPER_REQUEST_INVALID"}}'));
  server.on('upgrade', (_req, socket) => socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'));
  server.on('connect', (_req, socket) => socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'));
  server.on('clientError', (_error, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    else socket.destroy();
  });
  await new Promise<void>((resolve, rejectListen) => {
    const failed = () => rejectListen(new Error('NETWORK_HELPER_LISTEN_FAILED'));
    server.once('error', failed);
    server.listen(options.port, '127.0.0.1', () => { server.off('error', failed); resolve(); });
  });
  port = (server.address() as { port: number }).port;
  let closePromise: Promise<void> | undefined;
  return { port, close() {
    closePromise ??= (async () => {
      closing = true;
      const stopped = new Promise<void>((resolve, rejectClose) => server.close(error => error ? rejectClose(new Error('NETWORK_HELPER_CLOSE_FAILED')) : resolve()));
      server.closeIdleConnections();
      await Promise.all([...active]);
      server.closeIdleConnections();
      await stopped;
    })();
    return closePromise;
  } };
}

/** Production listener: root configuration must supply a nonprivileged fixed port. */
export function serveGatewayHelper(options: GatewayHelperHttpOptions, handler: GatewayHelperHandler): Promise<GatewayHelperHttpServer> {
  return serve(options, handler, false);
}

/** Synthetic loopback transport tests only; this does not attest a production backend. */
export function serveGatewayHelperFixture(options: GatewayHelperHttpOptions, handler: GatewayHelperHandler): Promise<GatewayHelperHttpServer> {
  return serve(options, handler, true);
}
