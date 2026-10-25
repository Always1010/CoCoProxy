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
    // The generated core configuration disables IPv6. Do not wait for an AAAA
    // lookup that the core cannot use (and that may take the entire deadline).
    return await resolver.resolve4(host);
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
  resolveHost = resolveAddresses, connectAddress = connect): Promise<TcpDelayResult> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  const cancel = () => controller.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  const combined = controller.signal;
  let result: TcpDelayResult = { status: 'unreachable', delay: null };
  try {
    combined.throwIfAborted();
    // Enforce the overall budget even for an injected resolver that ignores
    // cancellation. The production resolver also cancels its DNS work.
    const addresses = await new Promise<string[]>((resolve, reject) => {
      const abort = () => reject(combined.reason);
      combined.addEventListener('abort', abort, { once: true });
      Promise.resolve().then(() => resolveHost(target.host, combined)).then(resolve, reject)
        .finally(() => combined.removeEventListener('abort', abort));
    });
    if (!addresses.length) result = { status: 'dns-failed', delay: null };
    else result = await new Promise<TcpDelayResult>(resolve => {
      const candidates = [...new Set(addresses.filter(address => isIP(address)))].slice(0, 4);
      let next = 0;
      let active = 0;
      let settled = false;
      let stagger: ReturnType<typeof setTimeout> | undefined;
      let last: TcpDelayResult = { status: 'unreachable', delay: null };
      const finish = (value: TcpDelayResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(stagger);
        combined.removeEventListener('abort', abort);
        resolve(value);
      };
      const abort = () => finish({ status: 'cancelled', delay: null });
      const launch = () => {
        if (settled || combined.aborted) return;
        clearTimeout(stagger);
        if (next < candidates.length && active < 2) {
          const address = candidates[next++]!;
          active++;
          Promise.resolve().then(() => connectAddress(address, target.port, combined)).then(value => {
            active--;
            last = value;
            if (value.status === 'success') finish(value);
            else if (!settled) launch();
          }, () => { active--; last = { status: 'unreachable', delay: null }; launch(); });
        }
        if (!active && next >= candidates.length) finish(last);
        else if (active < 2 && next < candidates.length) stagger = setTimeout(launch, 150);
      };
      combined.addEventListener('abort', abort, { once: true });
      if (combined.aborted) abort();
      else launch();
    });
  } catch {
    result = { status: 'dns-failed', delay: null };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
    // Close losing sockets and stop residual DNS as soon as one address wins.
    controller.abort();
  }
  if (signal?.aborted) return { status: 'cancelled', delay: null };
  if (timedOut) return { status: 'timeout', delay: null };
  return result;
}
