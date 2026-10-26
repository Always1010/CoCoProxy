import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { request as requestHttp } from 'node:http';
import { BlockList, isIP } from 'node:net';
import { checkServerIdentity } from 'node:tls';
import type { IncomingHttpHeaders } from 'node:http';
import type { SnapshotClient, SubscriptionUsage } from './index.ts';

export class SnapshotHttpError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.name = 'SnapshotHttpError'; this.code = code; }
}

type Address = { address: string; family: number };
export interface HttpsClientOptions {
  /** Deployment-approved exact HTTPS origins, no wildcard or URL credentials. */
  allowedOrigins: readonly string[];
  /** Optional exact HTTP origins explicitly approved in private deployment settings. */
  allowedHttpOrigins?: readonly string[];
  allowPrivateAddresses?: boolean;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  ca?: string | Buffer;
  resolve?: (hostname: string) => Promise<Address[]>;
}

const fail: (code: string) => never = code => { throw new SnapshotHttpError(code); };
const v4Restricted = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) v4Restricted.addSubnet(network, prefix, 'ipv4');
const v6Global = new BlockList();
v6Global.addSubnet('2000::', 3, 'ipv6');
const v6Restricted = new BlockList();
for (const [network, prefix] of [
  ['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20],
] as const) v6Restricted.addSubnet(network, prefix, 'ipv6');
const alwaysDenied = new BlockList();
alwaysDenied.addSubnet('0.0.0.0', 8, 'ipv4');
alwaysDenied.addSubnet('224.0.0.0', 4, 'ipv4');
alwaysDenied.addSubnet('240.0.0.0', 4, 'ipv4');
alwaysDenied.addAddress('::', 'ipv6');
alwaysDenied.addSubnet('ff00::', 8, 'ipv6');

function checkedUrl(text: string, allowHttp = false): URL {
  if (typeof text !== 'string' || text.length > 8192 || /[\u0000-\u0020\u007f]/.test(text)) fail('SOURCE_URL_DENIED');
  let url: URL;
  try { url = new URL(text); } catch { fail('SOURCE_URL_DENIED'); }
  if (!(url.protocol === 'https:' || (allowHttp && url.protocol === 'http:')) ||
      url.username || url.password || url.hash || text.includes('#') || text.includes('\\')) fail('SOURCE_URL_DENIED');
  return url;
}

export function addressAllowed(address: Address, privateAllowed: boolean): boolean {
  const family = isIP(address.address);
  if (family !== address.family || (family !== 4 && family !== 6) || address.address.includes('%')) return false;
  const type = family === 4 ? 'ipv4' : 'ipv6';
  if (alwaysDenied.check(address.address, type)) return false;
  if (privateAllowed) return true;
  return family === 4 ? !v4Restricted.check(address.address, 'ipv4')
    : v6Global.check(address.address, 'ipv6') && !v6Restricted.check(address.address, 'ipv6');
}

function bounded<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new SnapshotHttpError('SOURCE_FETCH_TIMEOUT'));
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    promise.then(value => {
      signal.removeEventListener('abort', abort);
      if (signal.aborted) abort(); else resolve(value);
    }, () => {
      signal.removeEventListener('abort', abort);
      reject(new SnapshotHttpError(signal.aborted ? 'SOURCE_FETCH_TIMEOUT' : 'SOURCE_DNS_FAILED'));
    });
  });
}

type Reply = { status: number; headers: IncomingHttpHeaders; text?: string };

/** Ignore malformed optional accounting instead of exposing upstream headers. */
function subscriptionUsage(header: string | string[] | undefined): SubscriptionUsage | undefined {
  if (typeof header !== 'string' || header.length > 512) return undefined;
  const result: SubscriptionUsage = {};
  for (const part of header.split(';')) {
    const match = /^\s*(upload|download|total|expire)\s*=\s*(\d+)\s*$/.exec(part);
    if (!match) return undefined;
    const key = match[1] as keyof SubscriptionUsage;
    const value = Number(match[2]);
    if (!Number.isSafeInteger(value) || Object.hasOwn(result, key)) return undefined;
    result[key] = value;
  }
  return Object.keys(result).length ? result : undefined;
}

/** Restricted transport; HTTP requires its own exact deployment allowlist. */
export class HttpsSnapshotClient implements SnapshotClient {
  private readonly origins: Set<string>;
  private readonly httpOrigins: Set<string>;
  private readonly privateAllowed: boolean;
  private readonly timeout: number;
  private readonly maxBytes: number;
  private readonly redirects: number;
  private readonly ca: string | Buffer | undefined;
  private readonly resolveAddress: (hostname: string) => Promise<Address[]>;

  constructor(options: HttpsClientOptions) {
    if (!options || !Array.isArray(options.allowedOrigins) ||
        (options.allowedHttpOrigins !== undefined && !Array.isArray(options.allowedHttpOrigins)) ||
        options.allowedOrigins.length + (options.allowedHttpOrigins?.length ?? 0) < 1 ||
        options.allowedOrigins.length + (options.allowedHttpOrigins?.length ?? 0) > 100) fail('SOURCE_ORIGIN_POLICY_REQUIRED');
    this.origins = new Set(options.allowedOrigins.map(value => {
      const url = checkedUrl(value);
      if (url.pathname !== '/' || url.search) fail('SOURCE_URL_DENIED');
      return url.origin;
    }));
    this.httpOrigins = new Set((options.allowedHttpOrigins ?? []).map(value => {
      const url = checkedUrl(value, true);
      if (url.protocol !== 'http:' || url.pathname !== '/' || url.search) fail('SOURCE_URL_DENIED');
      return url.origin;
    }));
    this.privateAllowed = options.allowPrivateAddresses === true;
    this.timeout = options.timeoutMs ?? 15_000;
    this.maxBytes = options.maxBytes ?? 1_048_576;
    this.redirects = options.maxRedirects ?? 3;
    if (!Number.isSafeInteger(this.timeout) || this.timeout < 1 || this.timeout > 120_000
        || !Number.isSafeInteger(this.maxBytes) || this.maxBytes < 1 || this.maxBytes > 4 * 1024 * 1024
        || !Number.isSafeInteger(this.redirects) || this.redirects < 0 || this.redirects > 5) fail('SOURCE_INVALID_LIMIT');
    this.ca = Buffer.isBuffer(options.ca) ? Buffer.from(options.ca) : options.ca;
    this.resolveAddress = options.resolve ?? (hostname => lookup(hostname, { all: true, verbatim: true }));
  }

  async fetch(text: string, previous?: { etag?: string }): ReturnType<SnapshotClient['fetch']> {
    let url = checkedUrl(text, true);
    const initialOrigin = url.origin;
    if (url.protocol === 'http:' && !this.httpOrigins.has(initialOrigin)) fail('SOURCE_URL_DENIED');
    if (!this.origins.has(initialOrigin) && !this.httpOrigins.has(initialOrigin)) fail('SOURCE_ORIGIN_DENIED');
    let etag = previous?.etag;
    if (etag !== undefined && (typeof etag !== 'string' || etag.length > 512 || /[^\x20-\x7e]/.test(etag))) fail('SOURCE_INVALID_ETAG');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);
    try {
      for (let count = 0; count <= this.redirects; count++) {
        const hostname = url.hostname.replace(/^\[|\]$/g, '');
        const family = isIP(hostname);
        const addresses = family ? [{ address: hostname, family }]
          : await bounded(this.resolveAddress(hostname), controller.signal);
        if (!Array.isArray(addresses) || addresses.length < 1 || addresses.length > 32) fail('SOURCE_DNS_FAILED');
        if (addresses.some(address => !addressAllowed(address, this.privateAllowed))) fail('SOURCE_ADDRESS_DENIED');
        let reply: Reply | undefined;
        let last: unknown;
        // Connect only to the addresses just checked. No second DNS lookup.
        for (const address of addresses) {
          if (controller.signal.aborted) fail('SOURCE_FETCH_TIMEOUT');
          try { reply = await this.requestAddress(url, address, etag, controller.signal); break; }
          catch (error) {
            last = error;
            if (!(error instanceof SnapshotHttpError) || error.code !== 'SOURCE_FETCH_FAILED') throw error;
          }
        }
        if (!reply) throw last ?? new SnapshotHttpError('SOURCE_FETCH_FAILED');
        if ([301, 302, 303, 307, 308].includes(reply.status)) {
          if (count === this.redirects || typeof reply.headers.location !== 'string') fail('SOURCE_REDIRECT_DENIED');
          const next = checkedUrl(new URL(reply.headers.location, url).href, true);
          if (next.origin !== initialOrigin) fail('SOURCE_REDIRECT_DENIED');
          url = next;
          etag = undefined;
          continue;
        }
        if (reply.status === 304) {
          if (!etag) fail('SOURCE_UNEXPECTED_NOT_MODIFIED');
          const usage = subscriptionUsage(reply.headers['subscription-userinfo']);
          return { status: 'not-modified', ...(usage ? { usage } : {}) };
        }
        if (reply.status !== 200 || reply.text === undefined) fail('SOURCE_HTTP_REJECTED');
        const value = reply.headers.etag;
        const nextEtag = typeof value === 'string' && value.length <= 512 && !/[^\x20-\x7e]/.test(value) ? value : undefined;
        const usage = subscriptionUsage(reply.headers['subscription-userinfo']);
        return { status: 'modified', text: reply.text, ...(nextEtag ? { etag: nextEtag } : {}), ...(usage ? { usage } : {}) };
      }
      fail('SOURCE_REDIRECT_DENIED');
    } catch (error) {
      if (error instanceof SnapshotHttpError) throw error;
      fail(controller.signal.aborted ? 'SOURCE_FETCH_TIMEOUT' : 'SOURCE_FETCH_FAILED');
    } finally { clearTimeout(timer); }
  }

  private requestAddress(url: URL, address: Address, etag: string | undefined, signal: AbortSignal): Promise<Reply> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (error?: SnapshotHttpError, reply?: Reply) => {
        if (settled) return;
        settled = true;
        if (error) reject(error); else resolve(reply!);
      };
      const hostname = url.hostname.replace(/^\[|\]$/g, '');
      const plaintext = url.protocol === 'http:';
      const req = (plaintext ? requestHttp : request)({
        protocol: url.protocol, hostname: address.address, family: address.family,
        port: url.port || (plaintext ? 80 : 443), path: url.pathname + url.search, method: 'GET',
        ...(plaintext ? {} : { servername: isIP(hostname) ? '' : hostname,
          checkServerIdentity: (_name: string, cert: Parameters<typeof checkServerIdentity>[1]) => checkServerIdentity(hostname, cert),
          ...(this.ca === undefined ? {} : { ca: this.ca }), rejectUnauthorized: true }),
        agent: false, signal,
        // Advertise the accepted subscription format without claiming a core version.
        headers: { Host: url.host, 'Accept-Encoding': 'identity', 'User-Agent': 'clash.meta CoCoProxy/0.1', ...(etag ? { 'If-None-Match': etag } : {}) },
      }, res => {
        const status = res.statusCode ?? 0;
        if (status !== 200) {
          done(undefined, { status, headers: res.headers });
          res.destroy();
          return;
        }
        const encoding = res.headers['content-encoding'];
        if (encoding && encoding !== 'identity') {
          done(new SnapshotHttpError('SOURCE_ENCODING_UNSUPPORTED')); res.destroy(); return;
        }
        const length = res.headers['content-length'];
        if (length && Number(length) > this.maxBytes) {
          done(new SnapshotHttpError('SOURCE_BODY_LIMIT')); res.destroy(); return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.byteLength;
          if (size > this.maxBytes) { done(new SnapshotHttpError('SOURCE_BODY_LIMIT')); res.destroy(); }
          else chunks.push(chunk);
        });
        res.on('aborted', () => done(new SnapshotHttpError(signal.aborted ? 'SOURCE_FETCH_TIMEOUT' : 'SOURCE_FETCH_FAILED')));
        res.on('error', () => done(new SnapshotHttpError(signal.aborted ? 'SOURCE_FETCH_TIMEOUT' : 'SOURCE_FETCH_FAILED')));
        res.on('end', () => {
          if (settled) return;
          try {
            const body = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size));
            done(undefined, { status, headers: res.headers, text: body });
          } catch { done(new SnapshotHttpError('SOURCE_BODY_INVALID')); }
        });
      });
      req.on('error', () => done(new SnapshotHttpError(signal.aborted ? 'SOURCE_FETCH_TIMEOUT' : 'SOURCE_FETCH_FAILED')));
      req.end();
    });
  }
}
