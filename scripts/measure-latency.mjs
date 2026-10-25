import { lookup } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const METRICS = ['dnsMs', 'tcpMs', 'tlsMs', 'ttfbMs', 'totalMs'];
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const usage = 'node scripts/measure-latency.mjs --url HTTPS_URL [--samples 20] [--warmup 2] [--concurrency 1] [--timeout-ms 10000] [--mode cold|reuse] [--interval-ms 0] [--allow-http]';
const invalid = () => { throw new Error('INVALID_ARGUMENT'); };

export function parseOptions(args) {
  const flags = new Map();
  const allowed = new Set(['url', 'samples', 'warmup', 'concurrency', 'timeout-ms', 'mode', 'interval-ms', 'allow-http']);
  for (let index = 0; index < args.length; index++) {
    const key = args[index].startsWith('--') ? args[index].slice(2) : '';
    if (!allowed.has(key) || flags.has(key)) invalid();
    const value = key === 'allow-http' ? true : args[++index];
    if (value === undefined || value === '' || (typeof value === 'string' && value.startsWith('--'))) invalid();
    flags.set(key, value);
  }
  const integer = (key, fallback, minimum, maximum) => {
    const value = flags.get(key);
    if (value === undefined) return fallback;
    if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value)) invalid();
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < minimum || number > maximum) invalid();
    return number;
  };
  let url;
  try { url = new URL(flags.get('url')); } catch { invalid(); }
  if (url.username || url.password || url.hash || !['http:', 'https:'].includes(url.protocol) ||
    (url.protocol === 'http:' && flags.get('allow-http') !== true)) invalid();
  const mode = flags.get('mode') ?? 'cold';
  if (mode !== 'cold' && mode !== 'reuse') invalid();
  return { url, mode, samples: integer('samples', 20, 1, 10_000), warmup: integer('warmup', 2, 0, 1_000),
    concurrency: integer('concurrency', 1, 1, 32), timeoutMs: integer('timeout-ms', 10_000, 1, 120_000),
    intervalMs: integer('interval-ms', 0, 0, 60_000) };
}

function failureCode(error) {
  const code = error?.code;
  if (code === 'BASELINE_TIMEOUT') return 'TIMEOUT';
  if (['ENOTFOUND', 'EAI_AGAIN', 'EAI_FAIL'].includes(code)) return 'DNS_FAILED';
  if (['ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH'].includes(code)) return 'CONNECT_FAILED';
  if (typeof code === 'string' && /^(?:ERR_TLS_|ERR_SSL_|CERT_|DEPTH_|UNABLE_TO_|SELF_SIGNED_)/.test(code)) return 'TLS_FAILED';
  return 'REQUEST_FAILED';
}

function sample(options, agent, index) {
  return new Promise(resolve => {
    const start = performance.now(), timings = { dnsMs: null, tcpMs: null, tlsMs: null, ttfbMs: null, totalMs: null };
    let request, timer, dnsEnd, tcpEnd, done = false, reusedSocket = false;
    const finish = (success, failure) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      timings.totalMs = performance.now() - start;
      for (const key of METRICS) if (timings[key] !== null) timings[key] = Math.round(timings[key] * 1000) / 1000;
      resolve({ index, success, reusedSocket, ...(failure ? { failure } : {}), ...timings });
    };
    try {
      const transport = options.url.protocol === 'https:' ? https : http;
      request = transport.request(options.url, { method: 'GET', agent,
        lookup(host, lookupOptions, callback) {
          const begin = performance.now();
          lookup(host, lookupOptions, (...args) => {
            dnsEnd = performance.now(); timings.dnsMs = dnsEnd - begin; callback(...args);
          });
        },
      }, response => {
        timings.ttfbMs = performance.now() - start;
        let bytes = 0;
        response.on('data', chunk => {
          bytes += chunk.length;
          if (bytes > MAX_BODY_BYTES) { finish(false, 'RESPONSE_LIMIT'); response.destroy(); request.destroy(); }
        });
        response.once('end', () => finish(response.statusCode >= 200 && response.statusCode < 300,
          response.statusCode >= 200 && response.statusCode < 300 ? undefined : 'HTTP_STATUS'));
        response.once('error', () => finish(false, 'RESPONSE_FAILED'));
        response.once('aborted', () => finish(false, 'RESPONSE_FAILED'));
      });
      request.once('socket', socket => {
        reusedSocket = request.reusedSocket === true;
        const assigned = performance.now();
        if (!socket.connecting) return;
        socket.once('connect', () => { tcpEnd = performance.now(); timings.tcpMs = tcpEnd - (dnsEnd ?? assigned); });
        if (options.url.protocol === 'https:') socket.once('secureConnect', () => {
          timings.tlsMs = performance.now() - (tcpEnd ?? assigned);
        });
      });
      request.once('error', error => finish(false, failureCode(error)));
      timer = setTimeout(() => {
        const error = new Error('TIMEOUT'); error.code = 'BASELINE_TIMEOUT'; request.destroy(error);
      }, options.timeoutMs);
      request.end();
    } catch { finish(false, 'REQUEST_FAILED'); request?.destroy(); }
  });
}

function distribution(values) {
  values.sort((a, b) => a - b);
  const percentile = fraction => values.length ? values[Math.ceil(values.length * fraction) - 1] : null;
  return { count: values.length, p50: percentile(0.50), p95: percentile(0.95), p99: percentile(0.99) };
}

function timingSummary(results) {
  return Object.fromEntries(METRICS.map(key => [key, distribution(results.filter(result => result.success && result[key] !== null).map(result => result[key]))]));
}

export async function measureBaseline(options) {
  const transport = options.url.protocol === 'https:' ? https : http;
  const agent = options.mode === 'reuse' ? new transport.Agent({ keepAlive: true, maxSockets: options.concurrency, maxFreeSockets: options.concurrency }) : false;
  const batch = async count => {
    const results = new Array(count);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(options.concurrency, count) }, async () => {
      while (next < count) {
        const index = next++;
        results[index] = await sample(options, agent, index);
        if (options.intervalMs && next < count) await delay(options.intervalMs);
      }
    }));
    return results;
  };
  try {
    await batch(options.warmup);
    const results = await batch(options.samples), successes = results.filter(result => result.success).length;
    const failuresByCode = {};
    for (const result of results) if (!result.success) failuresByCode[result.failure] = (failuresByCode[result.failure] ?? 0) + 1;
    return { schemaVersion: 1, mode: options.mode, warmup: options.warmup, concurrency: options.concurrency,
      timeoutMs: options.timeoutMs, intervalMs: options.intervalMs, summary: { samples: results.length, successes,
        failures: results.length - successes, successRate: successes / results.length, failuresByCode,
        connections: { cold: results.filter(result => !result.reusedSocket).length, reused: results.filter(result => result.reusedSocket).length },
        timings: timingSummary(results), byConnection: {
          cold: timingSummary(results.filter(result => !result.reusedSocket)), reused: timingSummary(results.filter(result => result.reusedSocket)),
        } }, results };
  } finally { if (agent) agent.destroy(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length === 3 && process.argv[2] === '--help') console.log(usage);
  else {
    try {
      const result = await measureBaseline(parseOptions(process.argv.slice(2)));
      console.log(JSON.stringify(result, null, 2));
      if (result.summary.failures) process.exitCode = 1;
    } catch { console.error('INVALID_ARGUMENT'); process.exitCode = 2; }
  }
}
