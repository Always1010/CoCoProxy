import { AuthError, parseAdminCredential, SessionStore, verifyAdminCredential } from './auth.ts';
import type { AdminCredential } from './auth.ts';
import { TRUST_COOKIE_MAX_AGE, type TrustedDeviceStore } from './trusted-devices.ts';
import { requestAddress } from './request-address.ts';

export class ManagementError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status = 400) { super(code); this.name = 'ManagementError'; this.code = code; this.status = status; }
}
export type Principal = { username: string; expiresAt: number; deviceId?: string };
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

function json(body: unknown, status = 200, cookie?: string | string[]): Response {
  const headers: Record<string, string> = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
    'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'content-security-policy': "default-src 'none'; frame-ancestors 'none'" };
  const response = new Response(JSON.stringify(body), { status, headers });
  for (const value of cookie === undefined ? [] : Array.isArray(cookie) ? cookie : [cookie]) response.headers.append('set-cookie', value);
  return response;
}

type ManagementAuthOptions = { origin: string; credential: AdminCredential; sessions?: SessionStore; now?: () => number; trustedDevices?: TrustedDeviceStore };

/** Cookie authentication for the CoCoProxy mount, independent of core credentials. */
export function createManagementHandler(options: ManagementAuthOptions, action: ManagementAction): (request: Request) => Promise<Response> {
  return createManagementGateway(options, action).fetch;
}

export function createManagementGateway(options: ManagementAuthOptions, action: ManagementAction): ManagementGateway {
  const origin = managementOrigin(options.origin);
  const credential = Object.freeze(parseAdminCredential(options.credential));
  const now = options.now ?? Date.now;
  const sessions = options.sessions ?? new SessionStore({ now });
  const trustedDevices = options.trustedDevices;
  const secure = origin.startsWith('https:');
  const name = secure ? '__Host-cocoproxy_session' : 'cocoproxy_session';
  const deviceName = secure ? '__Host-cocoproxy_device' : 'cocoproxy_device';
  const attributes = `Path=/; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;
  const attempts: number[] = [];
  let loggingIn = 0;
  const sessionCookie = (session: { token: string; expiresAt: number }) => `${name}=${session.token}; ${attributes}; Max-Age=${Math.max(0, Math.floor((session.expiresAt - now()) / 1000))}`;
  const deviceCookie = (value: string, expiresAt: number | null) => `${deviceName}=${value}; ${attributes}; Max-Age=${expiresAt === null ? TRUST_COOKIE_MAX_AGE : Math.max(0, Math.floor((expiresAt - now()) / 1000))}`;
  const clearCookies = () => [name, deviceName].map(key => `${key}=; ${attributes}; Max-Age=0`);
  function token(request: Request, key = name): string | undefined {
    const cookie = request.headers.get('cookie');
    if (!cookie) return undefined;
    if (cookie.length > 4096) throw new ManagementError('UNAUTHORIZED', 401);
    const values = cookie.split(';').map(part => part.trim()).filter(part => part.startsWith(key + '='));
    if (values.length > 1) throw new ManagementError('UNAUTHORIZED', 401);
    return values[0]?.slice(key.length + 1);
  }
  function validate(request: Request, websocket = false): URL {
      const url = new URL(request.url);
      if (url.origin !== origin || url.username || url.password || url.hash) throw new ManagementError('ORIGIN_DENIED', 421);
      // Encoded path names belong to the controller. Decision history is the
      // only management query endpoint, with an exact, bounded read-only shape.
      const controller = url.pathname.startsWith('/api/clash/');
      const decisionHistory = request.method === 'GET' && url.pathname === '/api/cocoproxy/automatic/bandwidth/history';
      if ((!controller && ((url.search && !decisionHistory) || url.pathname.includes('%'))) || request.headers.has('authorization')) throw new ManagementError('INVALID_REQUEST');
      if (decisionHistory) {
        const query = url.searchParams;
        if (url.search.length > 65536 || ['scope', 'revision', 'group'].some(key => !query.get(key))
            || [...query.keys()].some(key => !['scope', 'revision', 'group', 'round'].includes(key) || query.getAll(key).length !== 1)
            || !/^(0|[1-9]\d{0,15})$/.test(query.get('revision')!)
            || query.get('scope')!.length > 16384 || query.get('group')!.length > 1024
            || (query.has('round') && (!query.get('round') || query.get('round')!.length > 128))) throw new ManagementError('INVALID_REQUEST');
      }
      const sourceDelete = request.method === 'DELETE' && /^\/api\/cocoproxy\/sources\/[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(url.pathname);
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
    const remembered = token(request, deviceName);
    const principal = presented ? sessions.check(presented) : null;
    if (principal && (!principal.deviceId || trustedDevices?.has(principal.deviceId))) return { username: principal.username, expiresAt: principal.expiresAt, ...(principal.deviceId ? { deviceId: principal.deviceId } : {}) };
    const device = trustedDevices?.check(remembered);
    if (!device) throw new ManagementError('UNAUTHORIZED', 401);
    return { username: credential.username, expiresAt: Math.min(now() + 8 * 60 * 60 * 1000, device.expiresAt ?? Infinity), deviceId: device.id };
  }
  return { authorize, fetch: async request => {
    try {
      const url = validate(request);
      if (request.method === 'GET' && url.pathname === '/api/cocoproxy/health') return json({ responding: true, scope: 'management_only' });
      if (request.method === 'POST' && url.pathname === '/api/session/login') {
        const stamp = now();
        while (attempts.length && attempts[0] <= stamp - 60_000) attempts.shift();
        if (attempts.length >= 8 || loggingIn >= 2) throw new ManagementError('LOGIN_RATE_LIMIT', 429);
        attempts.push(stamp); loggingIn++;
        try {
          const input = exactRecord(await readJsonBody(request, 8192), ['username', 'password'], ['trust', 'deviceLabel']);
          const trust = input.trust ?? 'none';
          if (typeof trust !== 'string' || !['none', '90days', 'until-revoked'].includes(trust) ||
              (input.deviceLabel !== undefined && (typeof input.deviceLabel !== 'string' || !input.deviceLabel.trim() || input.deviceLabel.length > 160 || /[\u0000-\u001f\u007f]/.test(input.deviceLabel)))) throw new ManagementError('INVALID_REQUEST');
          if (trust !== 'none' && input.deviceLabel === undefined) throw new ManagementError('DEVICE_LABEL_REQUIRED');
          if (!await verifyAdminCredential(credential, { username: input.username, password: input.password })) throw new ManagementError('INVALID_CREDENTIALS', 401);
          const previous = token(request);
          const previousDevice = token(request, deviceName);
          let deviceId: string | undefined;
          const cookies: string[] = [];
          if (trust !== 'none') {
            if (!trustedDevices) throw new ManagementError('DEVICE_TRUST_UNAVAILABLE', 503);
            const old = trustedDevices.check(previousDevice);
            const issued = await trustedDevices.issue(trust as '90days' | 'until-revoked', input.deviceLabel as string, previousDevice, requestAddress(request));
            if (old) sessions.revokeDevice(old.id);
            deviceId = issued.device.id;
            cookies.push(deviceCookie(issued.token, issued.device.expiresAt));
          } else if (previousDevice) {
            const old = trustedDevices?.check(previousDevice);
            if (old) { await trustedDevices!.revoke(old.id); sessions.revokeDevice(old.id); }
            cookies.push(`${deviceName}=; ${attributes}; Max-Age=0`);
          }
          if (previous) sessions.revoke(previous);
          const session = sessions.issue(credential.username, deviceId);
          // Keep the short session first for older HTTP clients; both are HttpOnly.
          cookies.unshift(sessionCookie(session));
          return json({ authenticated: true, username: session.username, expiresAt: session.expiresAt }, 200,
            cookies);
        } finally { loggingIn--; }
      }
      // Logout must revoke remembered credentials even after short-session expiry.
      if (url.pathname === '/api/session/logout' && request.method === 'POST') {
        exactRecord(await readJsonBody(request, 128), []);
        const presented = token(request);
        const remembered = trustedDevices?.check(token(request, deviceName));
        const session = sessions.check(presented);
        for (const id of new Set([remembered?.id, session?.deviceId])) if (id) {
          await trustedDevices?.revoke(id); sessions.revokeDevice(id);
        }
        sessions.revoke(presented);
        return json({ authenticated: false }, 200, clearCookies());
      }
      let principal = authorize(request);
      const cookies: string[] = [];
      const rememberedToken = token(request, deviceName);
      const remembered = trustedDevices ? await trustedDevices.renew(rememberedToken, requestAddress(request)) : null;
      // Serialize renewal before rechecking authorization, including concurrent revocation.
      principal = authorize(request);
      const session = sessions.check(token(request));
      if (remembered && (!session || (session.deviceId && !trustedDevices!.has(session.deviceId)))) {
        const issued = sessions.issue(credential.username, remembered.device.id);
        cookies.push(sessionCookie(issued));
        principal = { username: issued.username, expiresAt: issued.expiresAt, deviceId: remembered.device.id };
      }
      if (remembered?.renewed) cookies.push(deviceCookie(rememberedToken!, remembered.device.expiresAt));
      let result: unknown;
      if (url.pathname === '/api/session' && request.method === 'GET') result = { authenticated: true, ...principal };
      else if (url.pathname === '/api/session/devices' && request.method === 'GET') {
        const current = remembered?.device.id ?? session?.deviceId;
        result = { devices: (trustedDevices?.list() ?? []).map(device => ({ ...device, current: device.id === current })) };
      } else if (url.pathname === '/api/session/devices/rename' && request.method === 'POST') {
        const { id, label } = exactRecord(await readJsonBody(request, 1024), ['id', 'label']);
        if (typeof id !== 'string' || !/^[a-f0-9]{32}$/.test(id) || !trustedDevices) throw new ManagementError('INVALID_REQUEST');
        await trustedDevices.rename(id, label);
        result = { renamed: true };
      } else if (url.pathname === '/api/session/devices/revoke' && request.method === 'POST') {
        const { id } = exactRecord(await readJsonBody(request, 256), ['id']);
        if (typeof id !== 'string' || !/^[a-f0-9]{32}$/.test(id)) throw new ManagementError('INVALID_REQUEST');
        await trustedDevices?.revoke(id); sessions.revokeDevice(id);
        const current = id === remembered?.device.id || id === session?.deviceId;
        if (current) { sessions.revoke(token(request)); cookies.splice(0, cookies.length, ...clearCookies()); }
        result = { revoked: true, current };
      } else result = await action(request, principal);
      if (result instanceof Response) {
        // The action is trusted server code; upstream cookies and headers never
        // enter this response (the controller adapter reconstructs both).
        const headers = new Headers(result.headers);
        headers.set('cache-control', 'no-store');
        headers.set('x-content-type-options', 'nosniff');
        headers.set('referrer-policy', 'no-referrer');
        headers.set('content-security-policy', "default-src 'none'; frame-ancestors 'none'");
        for (const cookie of cookies) headers.append('set-cookie', cookie);
        return new Response(result.body, { status: result.status, headers });
      }
      return json(result, 200, cookies);
    } catch (error) {
      if (error instanceof ManagementError) return json({ error: { code: error.code } }, error.status);
      if (error instanceof AuthError && error.code.startsWith('AUTH_DEVICE_LABEL_')) return json({ error: { code: error.code.slice(5) } }, error.code.endsWith('DUPLICATE') ? 409 : 400);
      if (error instanceof AuthError && error.code === 'AUTH_DEVICE_NOT_FOUND') return json({ error: { code: 'DEVICE_NOT_FOUND' } }, 404);
      if (error instanceof AuthError) return json({ error: { code: error.code === 'AUTH_SESSION_LIMIT' ? 'SESSION_LIMIT' : error.code === 'AUTH_DEVICE_LIMIT' ? 'DEVICE_LIMIT' : 'AUTH_UNAVAILABLE' } }, 503);
      return json({ error: { code: 'MANAGEMENT_UNAVAILABLE' } }, 503);
    }
  } };
}
