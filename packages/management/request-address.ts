import { isIP } from 'node:net';

const addresses = new WeakMap<Request, string>();
export function normalizeIP(value: unknown): string | null {
  if (typeof value !== 'string' || !isIP(value)) return null;
  if (value.startsWith('::ffff:') && isIP(value.slice(7)) === 4) return value.slice(7);
  return isIP(value) === 6 ? new URL(`http://[${value}]/`).hostname.slice(1, -1) : value;
}

/** Only the native adapter supplies socket evidence; arbitrary Fetch headers are never trusted. */
export function recordRequestAddress(request: Request, peer: unknown): void {
  const address = normalizeIP(peer);
  if (!address) return;
  const forwarded = address === '127.0.0.1' || address === '::1'
    ? normalizeIP(request.headers.get('x-real-ip')) : null;
  addresses.set(request, forwarded ?? address);
}

export const requestAddress = (request: Request): string | null => addresses.get(request) ?? null;
