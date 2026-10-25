import { AuthError, parseAdminCredential, SessionStore, verifyAdminCredential } from './auth.ts';
import type { AdminCredential } from './auth.ts';

export class ManagementError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status = 400) { super(code); this.name = 'ManagementError'; this.code = code; this.status = status; }
}
export type Principal = { username: string; expiresAt: number };
export type ManagementAction = (request: Request, principal: Principal) => Promise<unknown>;
export type ManagementGateway = {
  fetch: (request: Request) => Promise<Response>;
  /** Rechecked for every WebSocket heartbeat, including after logout. */
  authorize: (request: Request, websocket?: boolean) => Principal;
};

export function exactRecord(input: unknown, keys: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw new ManagementError('INVALID_REQUEST');
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (Reflect.ownKeys(descriptors).some(key => typeof key !== 'string' || ![...keys, ...optional].includes(key)) ||
      keys.some(key => !Object.hasOwn(descriptors, key))) throw new ManagementError('INVALID_REQUEST');
  const result: Record<string, unknown> = Object.create(null);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!descriptor.enumerable || !('value' in descriptor)) throw new ManagementError('INVALID_REQUEST');
    result[key] = descriptor.value;
  }
  return result;
}

/** Reading may time out; no business operation is dispatched until it completes. */
export async function readJsonBody(request: Request, maximum = 1_048_576, timeoutMs = 5000): Promise<unknown> {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('content-type') ?? '') ||
      !['', 'identity'].includes(request.headers.get('content-encoding') ?? '')) throw new ManagementError('JSON_REQUIRED', 415);
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^(0|[1-9]\d*)$/.test(declared) || Number(declared) > maximum)) throw new ManagementError('BODY_LIMIT', 413);
  if (!request.body) throw new ManagementError('INVALID_JSON');
  const reader = request.body.getReader();
  let cancelled = false;
  let total = 0;
  const chunks: Uint8Array[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const reading = (async () => {
    while (!cancelled) {
      const { value, done } = await reader.read();
      if (cancelled) throw new ManagementError('BODY_TIMEOUT', 408);
      if (done) break;
      total += value.byteLength;
      if (total > maximum) throw new ManagementError('BODY_LIMIT', 413);
      chunks.push(value);
    }
    if (declared !== null && Number(declared) !== total) throw new ManagementError('INVALID_BODY');
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
    catch { throw new ManagementError('INVALID_JSON'); }
  })();
  try {
    return await Promise.race([reading, new Promise<never>((_, reject) => {
      timer = setTimeout(() => { cancelled = true; reject(new ManagementError('BODY_TIMEOUT', 408));
        void reader.cancel().catch(() => {}); }, timeoutMs);
    })]);
  } catch (error) {
    cancelled = true; void reader.cancel().catch(() => {});
    if (error instanceof ManagementError) throw error;
    throw new ManagementError('INVALID_BODY');
  } finally { clearTimeout(timer); try { reader.releaseLock(); } catch { /* cancelled pending read */ } }
}

export function managementOrigin(input: string): string {
  try {
    const url = new URL(input);
    if (url.origin !== input || url.username || url.password ||
        !(url.protocol === 'https:' || (url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)))) throw new Error();
    return url.origin;
  } catch { throw new ManagementError('MANAGEMENT_ORIGIN_INVALID'); }
}

function json(body: unknown, status = 200, cookie?: string): Response {
  const headers: Record<string, string> = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
    'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'content-security-policy': "default-src 'none'; frame-ancestors 'none'" };
  if (cookie !== undefined) headers['set-cookie'] = cookie;
  return new Response(JSON.stringify(body), { status, headers });
}

/** Cookie authentication for the Coproxy mount, independent of core credentials. */
export function createManagementHandler(options: { origin: string; credential: AdminCredential; sessions?: SessionStore; now?: () => number }, action: ManagementAction): (request: Request) => Promise<Response> {
  return createManagementGateway(options, action).fetch;
}

export function createManagementGateway(options: { origin: string; credential: AdminCredential; sessions?: SessionStore; now?: () => number }, action: ManagementAction): ManagementGateway {
  const origin = managementOrigin(options.origin);
  const credential = Object.freeze(parseAdminCredential(options.credential));
  const sessions = options.sessions ?? new SessionStore();
  const now = options.now ?? Date.now;
  const secure = origin.startsWith('https:');
  const name = secure ? '__Host-coproxy_session' : 'coproxy_session';
  const attributes = `Path=/; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;
  const attempts: number[] = [];
  let loggingIn = 0;
  function token(request: Request): string | undefined {
    const cookie = request.headers.get('cookie');
    if (!cookie) return undefined;
    if (cookie.length > 4096) throw new ManagementError('UNAUTHORIZED', 401);
    const values = cookie.split(';').map(part => part.trim()).filter(part => part.startsWith(name + '='));
    if (values.length > 1) throw new ManagementError('UNAUTHORIZED', 401);
    return values[0]?.slice(name.length + 1);
  }
  function validate(request: Request, websocket = false): URL {
      const url = new URL(request.url);
      if (url.origin !== origin || url.username || url.password || url.hash) throw new ManagementError('ORIGIN_DENIED', 421);
      // Only the controller allowlist interprets its encoded names and queries.
      const controller = url.pathname.startsWith('/api/clash/');
      if ((!controller && (url.search || url.pathname.includes('%'))) || request.headers.has('authorization')) throw new ManagementError('INVALID_REQUEST');
      const sourceDelete = request.method === 'DELETE' && /^\/api\/coproxy\/sources\/[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(url.pathname);
      if (!sourceDelete && !(controller ? ['GET', 'PUT', 'DELETE'] : ['GET', 'POST', 'PUT']).includes(request.method)) throw new ManagementError('METHOD_NOT_ALLOWED', 405);
      if (request.headers.get('sec-fetch-site') === 'cross-site') throw new ManagementError('ORIGIN_DENIED', 403);
      const suppliedOrigin = request.headers.get('origin');
      if ((suppliedOrigin !== null && suppliedOrigin !== origin) ||
          ((request.method !== 'GET' || websocket) && suppliedOrigin !== origin)) throw new ManagementError('ORIGIN_DENIED', 403);
      if (websocket && (!controller || request.method !== 'GET')) throw new ManagementError('INVALID_REQUEST');
      return url;
  }
  function authorize(request: Request, websocket = false): Principal {
    validate(request, websocket);
    const presented = token(request);
    const principal = presented ? sessions.check(presented) : null;
    if (principal === null) throw new ManagementError('UNAUTHORIZED', 401);
    return principal;
  }
  return { authorize, fetch: async request => {
    try {
      const url = validate(request);
      if (request.method === 'GET' && url.pathname === '/api/coproxy/health') return json({ responding: true, scope: 'management_only' });
      if (request.method === 'POST' && url.pathname === '/api/session/login') {
        const stamp = now();
        while (attempts.length && attempts[0] <= stamp - 60_000) attempts.shift();
        if (attempts.length >= 8 || loggingIn >= 2) throw new ManagementError('LOGIN_RATE_LIMIT', 429);
        attempts.push(stamp); loggingIn++;
        try {
          const input = await readJsonBody(request, 8192);
          if (!await verifyAdminCredential(credential, input)) throw new ManagementError('INVALID_CREDENTIALS', 401);
          const previous = token(request);
          if (previous) sessions.revoke(previous);
          const session = sessions.issue(credential.username);
          return json({ authenticated: true, username: session.username, expiresAt: session.expiresAt }, 200,
            `${name}=${session.token}; ${attributes}; Max-Age=${Math.max(0, Math.floor((session.expiresAt - now()) / 1000))}`);
        } finally { loggingIn--; }
      }
      const principal = authorize(request);
      if (url.pathname === '/api/session' && request.method === 'GET') return json({ authenticated: true, ...principal });
      if (url.pathname === '/api/session/logout' && request.method === 'POST') {
        exactRecord(await readJsonBody(request, 128), []);
        sessions.revoke(token(request)!);
        return json({ authenticated: false }, 200, `${name}=; ${attributes}; Max-Age=0`);
      }
      const result = await action(request, principal);
      if (result instanceof Response) {
        // The action is trusted server code; upstream cookies and headers never
        // enter this response (the controller adapter reconstructs both).
        const headers = new Headers(result.headers);
        headers.set('cache-control', 'no-store');
        headers.set('x-content-type-options', 'nosniff');
        headers.set('referrer-policy', 'no-referrer');
        headers.set('content-security-policy', "default-src 'none'; frame-ancestors 'none'");
        return new Response(result.body, { status: result.status, headers });
      }
      return json(result);
    } catch (error) {
      if (error instanceof ManagementError) return json({ error: { code: error.code } }, error.status);
      if (error instanceof AuthError) return json({ error: { code: error.code === 'AUTH_SESSION_LIMIT' ? 'SESSION_LIMIT' : 'AUTH_UNAVAILABLE' } }, 503);
      return json({ error: { code: 'MANAGEMENT_UNAVAILABLE' } }, 503);
    }
  } };
}
