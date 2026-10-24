import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { privateRead } from '../storage/private-files.ts';

export type AdminCredential = {
  schemaVersion: 1;
  algorithm: 'scrypt-v1';
  username: string;
  salt: string;
  hash: string;
};

/** Public errors contain neither supplied values nor filesystem diagnostics. */
export class AuthError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.name = 'AuthError'; this.code = code; }
}

const MAX_TTL_MS = 8 * 60 * 60 * 1000;
const MAX_SESSIONS = 256;
const USERNAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}(?![\s\S])/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const fail: (code: string) => never = code => { throw new AuthError(code); };

/** Inspect descriptors before reading values, so accessors never execute. */
function exactRecord(input: unknown, keys: string[], code: string): Record<string, unknown> {
  try {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) fail(code);
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) fail(code);
    const descriptors = Object.getOwnPropertyDescriptors(input);
    if (Reflect.ownKeys(descriptors).length !== keys.length ||
        keys.some(key => !Object.hasOwn(descriptors, key))) fail(code);
    const values: Record<string, unknown> = Object.create(null);
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (!Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) fail(code);
      values[key] = descriptor.value;
    }
    return values;
  } catch { fail(code); }
}

function validUsername(value: unknown): value is string {
  return typeof value === 'string' && USERNAME.test(value);
}

function validPassword(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 1024 || value.includes('\0')) return false;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  const bytes = Buffer.byteLength(value, 'utf8');
  return bytes >= 12 && bytes <= 1024;
}

function loginInput(input: unknown): { username: string; password: string } {
  const value = exactRecord(input, ['username', 'password'], 'AUTH_INPUT_INVALID');
  if (!validUsername(value.username) || !validPassword(value.password)) fail('AUTH_INPUT_INVALID');
  return { username: value.username, password: value.password };
}

function canonicalBytes(value: unknown, bytes: number): value is string {
  if (typeof value !== 'string' || value.length !== Math.ceil(bytes * 4 / 3) || !/^[A-Za-z0-9_-]+$/.test(value)) return false;
  const decoded = Buffer.from(value, 'base64url');
  return decoded.length === bytes && decoded.toString('base64url') === value;
}

async function derive(password: string, salt: string): Promise<Buffer> {
  const bytes = Buffer.from(password, 'utf8');
  try {
    return await new Promise<Buffer>((resolve, reject) => {
      scrypt(bytes, Buffer.from(salt, 'base64url'), 64,
        { N: 16384, r: 8, p: 5, maxmem: 64 * 1024 * 1024 },
        (error, result) => { if (error) reject(new AuthError('AUTH_CREDENTIAL_INVALID')); else resolve(result); });
    });
  } catch { fail('AUTH_CREDENTIAL_INVALID'); }
  finally { bytes.fill(0); }
}

export async function createAdminCredential(input: unknown): Promise<AdminCredential> {
  const { username, password } = loginInput(input);
  let salt: string;
  try { salt = randomBytes(16).toString('base64url'); }
  catch { fail('AUTH_CREDENTIAL_INVALID'); }
  const hash = await derive(password, salt);
  try { return { schemaVersion: 1, algorithm: 'scrypt-v1', username, salt, hash: hash.toString('base64url') }; }
  finally { hash.fill(0); }
}

export function parseAdminCredential(input: unknown): AdminCredential {
  const value = exactRecord(input, ['schemaVersion', 'algorithm', 'username', 'salt', 'hash'], 'AUTH_CREDENTIAL_INVALID');
  if (value.schemaVersion !== 1 || value.algorithm !== 'scrypt-v1' || !validUsername(value.username) ||
      !canonicalBytes(value.salt, 16) || !canonicalBytes(value.hash, 64)) fail('AUTH_CREDENTIAL_INVALID');
  return { schemaVersion: 1, algorithm: 'scrypt-v1', username: value.username, salt: value.salt, hash: value.hash };
}

/** Reads only an existing private regular file; caller selects trusted ancestors. */
export async function loadAdminCredential(path: string): Promise<AdminCredential> {
  try {
    if (typeof path !== 'string' || !isAbsolute(path)) fail('AUTH_CREDENTIAL_INVALID');
    return parseAdminCredential(JSON.parse(await privateRead(path, 16 * 1024)));
  } catch { fail('AUTH_CREDENTIAL_INVALID'); }
}

export async function verifyAdminCredential(credential: unknown, input: unknown): Promise<boolean> {
  const stored = parseAdminCredential(credential);
  let login: { username: string; password: string };
  try { login = loginInput(input); } catch { return false; }
  // Unknown users still pay the same fixed scrypt cost and hash comparison.
  const actual = await derive(login.password, stored.salt);
  const expected = Buffer.from(stored.hash, 'base64url');
  try {
    const matches = timingSafeEqual(actual, expected);
    return matches && login.username === stored.username;
  } finally { actual.fill(0); expected.fill(0); }
}

export type Session = { username: string; expiresAt: number };
export type IssuedSession = Session & { token: string };
export type SessionStoreOptions = { ttlMs?: number; maxSessions?: number; now?: () => number };

/** Process-local, absolute-expiry sessions. Only SHA-256 token digests are retained. */
export class SessionStore {
  private readonly sessions = new Map<string, Session>();
  private readonly ttlMs: number;
  private readonly maxSessions: number;
  private readonly now: () => number;

  constructor(options: SessionStoreOptions = {}) {
    const { ttlMs = MAX_TTL_MS, maxSessions = MAX_SESSIONS, now = Date.now } = options;
    if (!Number.isFinite(ttlMs) || ttlMs <= 0 || ttlMs > MAX_TTL_MS ||
        !Number.isSafeInteger(maxSessions) || maxSessions < 1 || maxSessions > MAX_SESSIONS || typeof now !== 'function') fail('AUTH_INPUT_INVALID');
    this.ttlMs = ttlMs; this.maxSessions = maxSessions; this.now = now;
  }

  private time(): number {
    let time: number;
    try { time = this.now(); } catch { fail('AUTH_INPUT_INVALID'); }
    if (!Number.isFinite(time) || !Number.isFinite(time + this.ttlMs)) fail('AUTH_INPUT_INVALID');
    return time;
  }

  private digest(token: unknown): string | null {
    if (typeof token !== 'string' || !TOKEN.test(token) || !canonicalBytes(token, 32)) return null;
    return createHash('sha256').update(token, 'ascii').digest('hex');
  }

  issue(username: string): IssuedSession {
    if (!validUsername(username)) fail('AUTH_INPUT_INVALID');
    const time = this.time();
    for (const [digest, session] of this.sessions) if (session.expiresAt <= time) this.sessions.delete(digest);
    if (this.sessions.size >= this.maxSessions) fail('AUTH_SESSION_LIMIT');
    const expiresAt = time + this.ttlMs;
    let token: string;
    let digest: string;
    try {
      do { token = randomBytes(32).toString('base64url'); digest = this.digest(token)!; }
      while (this.sessions.has(digest));
    } catch { fail('AUTH_CREDENTIAL_INVALID'); }
    this.sessions.set(digest, { username, expiresAt });
    return { token, username, expiresAt };
  }

  check(token: unknown): Session | null {
    const digest = this.digest(token);
    if (digest === null) return null;
    const session = this.sessions.get(digest);
    if (!session) return null;
    if (session.expiresAt <= this.time()) { this.sessions.delete(digest); return null; }
    return { ...session };
  }

  revoke(token: unknown): void {
    const digest = this.digest(token);
    if (digest !== null) this.sessions.delete(digest);
  }
}
