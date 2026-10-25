import { createHash } from 'node:crypto';
import { Resolver } from 'node:dns/promises';
import { createConnection, isIP } from 'node:net';
import { performance } from 'node:perf_hooks';
import { canonicalJson, type JsonObject } from '../config/index.ts';

export type TcpEndpoint = { host: string; port: number };
export type TcpNode = { name: string; fingerprint: string; applicable: boolean };
export type TcpDelayResult = { status: 'success' | 'timeout' | 'dns-failed' | 'refused' | 'unreachable' | 'cancelled'; delay: number | null };
const tcpTypes = new Set(['ss', 'ssr', 'vmess', 'vless', 'trojan', 'socks5', 'http', 'snell', 'ssh', 'anytls']);

/** Only server endpoints already present in a validated node can be probed. */
export function tcpEndpoint(node: JsonObject): TcpEndpoint | null {
  if (!tcpTypes.has(String(node.type).toLowerCase()) || node.network === 'quic' || node['dialer-proxy']) return null;
  if (typeof node.server !== 'string' || !node.server || node.server.length > 253 || /[\s\u0000-\u001f]/u.test(node.server) ||
      typeof node.port !== 'number' || !Number.isInteger(node.port) || node.port < 1 || node.port > 65535) return null;
  const host = node.server.startsWith('[') && node.server.endsWith(']') ? node.server.slice(1, -1) : node.server;
  return { host, port: node.port };
}

export function describeTcpNode(node: JsonObject): TcpNode {
  return { name: String(node.name), fingerprint: createHash('sha256').update(canonicalJson(node)).digest('hex'), applicable: tcpEndpoint(node) !== null };
}

async function resolveAddresses(host: string, signal: AbortSignal): Promise<string[]> {
  if (isIP(host)) return [host];
  const resolver = new Resolver({ timeout: 2000, tries: 1 });
  const cancel = () => resolver.cancel();
  signal.addEventListener('abort', cancel, { once: true });
  try {
    signal.throwIfAborted();
    const results = await Promise.allSettled([resolver.resolve4(host), resolver.resolve6(host)]);
    return results.flatMap(result => result.status === 'fulfilled' ? result.value : []);
  } finally { signal.removeEventListener('abort', cancel); }
}

function connect(address: string, port: number, signal: AbortSignal): Promise<TcpDelayResult> {
  return new Promise(resolve => {
    if (signal.aborted) { resolve({ status: 'cancelled', delay: null }); return; }
    const start = performance.now();
    const socket = createConnection({ host: address, port, family: isIP(address) });
    let settled = false;
    const finish = (result: TcpDelayResult) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', cancel);
      socket.destroy();
      resolve(result);
    };
    const cancel = () => finish({ status: 'cancelled', delay: null });
    signal.addEventListener('abort', cancel, { once: true });
    socket.once('connect', () => finish({ status: 'success', delay: Math.max(0, Math.round(performance.now() - start)) }));
    socket.once('error', (error: NodeJS.ErrnoException) => finish({ status: error.code === 'ECONNREFUSED' ? 'refused' : 'unreachable', delay: null }));
  });
}

/** Raw TCP from the gateway; DNS is outside the measured connect interval. No HTTP, TLS or proxy credentials are sent. */
export async function probeTcpEndpoint(target: TcpEndpoint, signal?: AbortSignal, timeoutMs = 3000,
  resolveHost = resolveAddresses): Promise<TcpDelayResult> {
  const deadline = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
  let result: TcpDelayResult = { status: 'unreachable', delay: null };
  try {
    combined.throwIfAborted();
    const addresses = await resolveHost(target.host, combined);
    if (!addresses.length) result = { status: 'dns-failed', delay: null };
    for (const address of addresses) {
      combined.throwIfAborted();
      result = await connect(address, target.port, combined);
      if (result.status === 'success') break;
    }
  } catch {
    result = { status: 'dns-failed', delay: null };
  }
  if (signal?.aborted) return { status: 'cancelled', delay: null };
  if (deadline.aborted) return { status: 'timeout', delay: null };
  return result;
}
