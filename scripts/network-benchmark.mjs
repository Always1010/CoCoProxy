import { spawn, execFile } from 'node:child_process';
import { networkInterfaces, platform } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const execute = promisify(execFile);
const curl = platform() === 'win32' ? 'curl.exe' : 'curl';
const nullDevice = platform() === 'win32' ? 'NUL' : '/dev/null';
export function distribution(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  const at = fraction => sorted.length ? rounded(sorted[Math.ceil(sorted.length * fraction) - 1]) : null;
  return { samples: sorted.length, min: sorted.length ? rounded(sorted[0]) : null, p50: at(0.5), p95: at(0.95),
    max: sorted.length ? rounded(sorted.at(-1)) : null };
}

function rounded(value) { return Math.round(value * 1000) / 1000; }
export function endpoint(value) { const url = new URL(value); return `${url.origin}${url.pathname}`; }
// Explicit fields avoid curl's full JSON, which also contains URLs and certificates.
const format = JSON.stringify(Object.fromEntries(['http_code', 'size_download', 'size_upload', 'time_namelookup',
  'time_connect', 'time_appconnect', 'time_starttransfer', 'time_total', 'local_ip', 'remote_ip', 'local_port', 'remote_port', 'content_type']
  .map(key => [key, `%{${key}}`]).concat([['content_range', '%header{content-range}']])));

export function createRunner({ children = new Set(), cancelled = () => false } = {}) {
  return (url, { timeoutSeconds = 5, uploadFile, bytes, phaseDeadline, range, expectedStatus, binary = false, head = false } = {}) => new Promise(resolveResult => {
    if (cancelled()) return resolveResult({ exitCode: null, failure: 'CANCELLED', successful: false });
    const begin = performance.now();
    const startedAtMs = Date.now();
    const args = ['-q', '--silent', '--ipv4', '--http1.1', '--globoff', '--noproxy', '*',
      '--connect-timeout', String(Math.min(4, timeoutSeconds)), '--max-time', String(timeoutSeconds),
      '--output', nullDevice, '--write-out', format, '--header', 'Accept-Encoding: identity',
      '--header', 'Cache-Control: no-cache'];
    if (range) args.push('--range', `${range.start}-${range.end}`, '--max-filesize', String(range.end - range.start + 1));
    else if (bytes !== undefined && !uploadFile) args.push('--max-filesize', String(bytes));
    if (head) args.push('--head');
    if (uploadFile) args.push('--request', 'POST', '--header', 'Content-Type: application/octet-stream',
      '--header', 'Expect:', '--data-binary', `@${uploadFile}`);
    args.push('--url', url);
    const child = spawn(curl, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    children.add(child);
    let stdout = '', failed = false, forced = false;
    child.stdout.on('data', chunk => { if (stdout.length < 16384) stdout += chunk; });
    child.on('error', () => { failed = true; });
    // curl has its own deadline; also bound OS/DNS stalls independently.
    const watchdog = setTimeout(() => { forced = true; child.kill(); }, timeoutSeconds * 1000 + 1500);
    child.on('close', exitCode => {
      clearTimeout(watchdog);
      children.delete(child);
      const end = performance.now();
      let raw = {};
      try { raw = JSON.parse(stdout); } catch { /* Killed curl may not emit statistics. */ }
      const number = key => {
        const value = Number(raw[key]);
        return raw[key] !== undefined && Number.isFinite(value) && value >= 0 ? value : null;
      };
      const status = number('http_code');
      const okStatus = status >= 200 && status < 300 && (expectedStatus === undefined || status === expectedStatus);
      const downloaded = number('size_download') ?? 0, uploaded = number('size_upload') ?? 0;
      const mimeOk = !binary || (typeof raw.content_type === 'string' && !/text\/|json|xml|javascript/i.test(raw.content_type));
      const parsedRange = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(raw.content_range ?? '');
      const rangeOk = !range || parsedRange && Number(parsedRange[1]) === range.start && Number(parsedRange[2]) === range.end && Number(parsedRange[3]) > range.end;
      const actualProgress = uploadFile ? uploaded > 0 : okStatus && mimeOk && rangeOk && downloaded > 0;
      const deadlineTimeout = exitCode === 28 && actualProgress && phaseDeadline !== undefined && end >= phaseDeadline - 150;
      const completeBody = bytes === undefined || (uploadFile ? uploaded === bytes : downloaded === bytes);
      const successful = exitCode === 0 && okStatus && completeBody && mimeOk && Boolean(rangeOk);
      const failure = successful ? null : cancelled() ? 'CANCELLED' : failed ? 'CURL_UNAVAILABLE' : forced ? 'WATCHDOG' :
        exitCode === 6 ? 'DNS_FAILED' : exitCode === 7 ? 'CONNECT_FAILED' : [35, 51, 60].includes(exitCode) ? 'TLS_FAILED' :
        exitCode === 28 ? 'TIMEOUT' : !okStatus && status ? 'HTTP_STATUS' : !mimeOk ? 'CONTENT_TYPE' : !rangeOk ? 'CONTENT_RANGE' : exitCode === 0 ? 'BODY_SIZE' : 'CURL_ERROR';
      const ms = key => number(key) === null ? null : rounded(number(key) * 1000);
      const failureStage = successful ? null : exitCode === 6 || !number('time_namelookup') && !number('time_connect') ? 'dns-or-connect' :
        !number('time_connect') ? 'tcp' : new URL(url).protocol === 'https:' && !number('time_appconnect') ? 'tls' : !status ? 'response' : 'body-or-status';
      resolveResult({ exitCode, httpStatus: status, successful, failure, failureStage, deadlineTimeout, completeBody,
        startedAtMs, endedAtMs: Date.now(),
        elapsedMs: rounded(end - begin), downloadedBytes: downloaded, uploadedBytes: uploaded,
        // Download bytes after 2xx, including the bounded final partial transfer.
        countedDownloadBytes: okStatus && mimeOk && rangeOk && ((exitCode === 0 && completeBody) || deadlineTimeout) ? downloaded : 0,
        // Upload is client-side bytes sent; no receiver goodput claim for an unfinished POST.
        countedUploadBytes: (okStatus && exitCode === 0) || (deadlineTimeout && (okStatus || status === 0)) ? uploaded : 0,
        successfulPostClientBytes: uploadFile && successful ? uploaded : 0,
        dnsMs: ms('time_namelookup'), connectCumulativeMs: ms('time_connect'), tlsCumulativeMs: ms('time_appconnect'),
        ttfbMs: ms('time_starttransfer'), totalMs: ms('time_total'),
        localIp: raw.local_ip || null, remoteIp: raw.remote_ip || null,
        localPort: number('local_port'), remotePort: number('remote_port'), contentType: raw.content_type || null,
        contentRange: /^bytes \d+-\d+\/\d+$/.test(raw.content_range ?? '') ? raw.content_range : null,
        fullyWithinPhase: phaseDeadline === undefined || end <= phaseDeadline,
      });
    });
  });
}

export async function networkSnapshot() {
  const interfaces = Object.entries(networkInterfaces()).flatMap(([name, entries]) =>
    entries.filter(row => !row.internal && row.family === 'IPv4').map(row => ({ name, address: row.address, cidr: row.cidr })));
  if (platform() !== 'win32') return { interfaces, defaultRoutes: null };
  try {
    const { stdout } = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      "Get-NetRoute -AddressFamily IPv4 -DestinationPrefix '0.0.0.0/0' -ErrorAction Stop | Select-Object InterfaceAlias,InterfaceIndex,NextHop,RouteMetric | ConvertTo-Json -Compress"],
    { timeout: 6000, windowsHide: true, maxBuffer: 65536 });
    return { interfaces, defaultRoutes: JSON.parse(stdout || 'null') };
  } catch { return { interfaces, defaultRoutes: null, warning: 'DEFAULT_ROUTE_SNAPSHOT_UNAVAILABLE' }; }
}

async function main() {
  const { runCli } = await import('./network-benchmark-suite.mjs');
  await runCli(process.argv.slice(2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(['INVALID_ARGUMENT', 'INVALID_TARGET_URL', 'INVALID_CONFIG', 'INVALID_OBSERVER', 'CONFIG_UNREADABLE',
      'CURL_8_4_REQUIRED', 'LOCAL_EXECUTION_FAILED'].includes(error.message) ? error.message : 'BENCHMARK_FAILED');
    process.exitCode = 1;
  });
}
