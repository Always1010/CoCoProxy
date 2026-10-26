import { createECDH, createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { addressAllowed } from '../subscriptions/http.ts';

export type PushSubscription = { endpoint: string; keys: { p256dh: string; auth: string } };
export type PushKeys = { publicKey: string; privateKey: string };
export type PushReply = { status: number; retryAfterMs?: number; code?: string };
export type PushSend = (subscription: PushSubscription, payload: string, keys: PushKeys, subject: string, ttl: number, topic: string) => Promise<PushReply>;
const require = createRequire(import.meta.url);

export function pushEndpoint(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('PUSH_ENDPOINT_DENIED'); }
  const host = url.hostname;
  const allowed = host === 'fcm.googleapis.com' || host === 'updates.push.services.mozilla.com' ||
    host === 'web.push.apple.com' || host.endsWith('.push.apple.com') || host === 'wns.windows.com' || host.endsWith('.notify.windows.com');
  if (!allowed || url.protocol !== 'https:' || url.port || url.username || url.password || url.hash || value.length > 4096 || /[\s\\]/.test(value)) throw new Error('PUSH_ENDPOINT_DENIED');
  return url;
}

export function parsePushSubscription(value: unknown): PushSubscription {
  const input = value as PushSubscription;
  if (!input || typeof input.endpoint !== 'string' || !input.keys || typeof input.keys.p256dh !== 'string' || typeof input.keys.auth !== 'string') throw new Error('PUSH_SUBSCRIPTION_INVALID');
  pushEndpoint(input.endpoint);
  const bytes = (text: string, size: number) => /^[A-Za-z0-9_-]+$/.test(text) && Buffer.from(text, 'base64url').length === size && Buffer.from(text, 'base64url').toString('base64url') === text;
  if (!bytes(input.keys.p256dh, 65) || Buffer.from(input.keys.p256dh, 'base64url')[0] !== 4 || !bytes(input.keys.auth, 16)) throw new Error('PUSH_SUBSCRIPTION_INVALID');
  return { endpoint: input.endpoint, keys: { p256dh: input.keys.p256dh, auth: input.keys.auth } };
}

export function generatePushKeys(): PushKeys {
  const key = createECDH('prime256v1'); key.generateKeys();
  return { publicKey: key.getPublicKey().toString('base64url'), privateKey: key.getPrivateKey().toString('base64url') };
}
export const pushTopic = (scope: string, group: string) => createHash('sha256').update(JSON.stringify([scope, group])).digest('base64url').slice(0, 32);

export function createPushRequest(subscription: PushSubscription, payload: string, keys: PushKeys, subject: string, ttl: number, topic: string): { headers: Record<string, string | number>; body: Buffer } {
  let library;
  try { const loaded = require('web-push'); library = loaded.default ?? loaded; }
  catch { throw new Error('PUSH_LIBRARY_UNAVAILABLE'); }
  try { return library.generateRequestDetails(subscription, payload, { vapidDetails: { ...keys, subject }, TTL: ttl, topic, urgency: 'normal' }); }
  catch { throw new Error('PUSH_CONFIGURATION_ERROR'); }
}

/** Library handles RFC encryption/signing; our transport pins checked public DNS and bounds all I/O. */
export const sendWebPush: PushSend = async (subscription, payload, keys, subject, ttl, topic) => {
  const url = pushEndpoint(subscription.endpoint);
  let details;
  try { details = createPushRequest(subscription, payload, keys, subject, ttl, topic); }
  catch (error) { return { status: 0, code: (error as Error).message }; }
  const signal = AbortSignal.timeout(5000);
  const addresses = await new Promise<Awaited<ReturnType<typeof lookup>> | { address: string; family: number }[]>((resolve, reject) => {
    const abort = () => reject(new Error('PUSH_TIMEOUT'));
    signal.addEventListener('abort', abort, { once: true });
    lookup(url.hostname, { all: true, verbatim: true }).then(values => { signal.removeEventListener('abort', abort); resolve(values); }, reject);
  }) as { address: string; family: number }[];
  if (signal.aborted || !addresses.length || addresses.some(address => !addressAllowed(address, false))) throw new Error('PUSH_DNS_DENIED');
  const pinned = addresses[0];
  return await new Promise<PushReply>((resolve, reject) => {
    const req = request(url, { method: 'POST', headers: details.headers, agent: false, signal,
      lookup: (_hostname, options, callback) => {
        if (options.all) (callback as unknown as (error: null, addresses: { address: string; family: number }[]) => void)(null, [pinned]);
        else callback(null, pinned.address, pinned.family);
      },
    }, response => {
      let size = 0;
      response.on('data', chunk => { size += chunk.length; if (size > 4096) response.destroy(new Error('PUSH_REPLY_LIMIT')); });
      response.on('error', reject);
      response.on('end', () => {
        const raw = response.headers['retry-after'];
        const delay = typeof raw === 'string' ? /^\d+$/.test(raw) ? Number(raw) * 1000 : Date.parse(raw) - Date.now() : 0;
        resolve({ status: response.statusCode ?? 0, ...(Number.isFinite(delay) && delay > 0 ? { retryAfterMs: Math.min(delay, 15 * 60_000) } : {}) });
      });
    });
    req.on('error', reject); req.end(details.body);
  });
};
