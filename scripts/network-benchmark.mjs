import { spawn, execFile } from 'node:child_process';
import { mkdir, mkdtemp, writeFile, appendFile, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { networkInterfaces, platform } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { createInterface } from 'node:readline/promises';
import { promisify } from 'node:util';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const execute = promisify(execFile);
const curl = platform() === 'win32' ? 'curl.exe' : 'curl';
const nullDevice = platform() === 'win32' ? 'NUL' : '/dev/null';
const usage = `Usage: node scripts/network-benchmark.mjs [options]
  --interactive             Ask for a scenario label before starting
  --label TEXT              Scenario description (does not change routing)
  --duration-seconds N      Each loaded phase, 5..120 (default 20)
  --idle-seconds N          Idle phase, 5..120 (default 15)
  --parallel N              Parallel workers, 2..8 (default 4)
  --rounds N                Repeat complete sequence, 1..3 (default 1)
  --download-url URL        GET endpoint supporting a bytes query parameter
  --upload-url URL          POST endpoint accepting a binary request body
  --latency-url URL         Small GET endpoint (default: download URL, bytes=0)
  --allow-http              Allow HTTP only for loopback synthetic checks
  --output-dir PATH         Private output parent (default .local/reports/network-benchmark)
  --help                    Show help without network traffic
Requires existing Node.js >=22.18 and curl >=7.70. No installation or network changes.
Defaults use speed.cloudflare.com. Running a test uses Internet bandwidth.\n`;

export function parseOptions(args) {
  const flags = new Map();
  const booleans = new Set(['interactive', 'allow-http']);
  const allowed = new Set([...booleans, 'label', 'duration-seconds', 'idle-seconds', 'parallel', 'rounds',
    'download-url', 'upload-url', 'latency-url', 'output-dir']);
  for (let i = 0; i < args.length; i++) {
    const key = args[i].startsWith('--') ? args[i].slice(2) : '';
    if (!allowed.has(key) || flags.has(key)) throw new Error('INVALID_ARGUMENT');
    const value = booleans.has(key) ? true : args[++i];
    if (value === undefined || value === '' || String(value).startsWith('--')) throw new Error('INVALID_ARGUMENT');
    flags.set(key, value);
  }
  const integer = (key, fallback, min, max) => {
    const raw = flags.get(key) ?? String(fallback);
    const value = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < min || value > max) throw new Error('INVALID_ARGUMENT');
    return value;
  };
  const url = value => {
    let parsed;
    try { parsed = new URL(value); } catch { throw new Error('INVALID_URL'); }
    const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(parsed.hostname);
    if (parsed.username || parsed.password || parsed.hash ||
      !(parsed.protocol === 'https:' || (flags.has('allow-http') && loopback && parsed.protocol === 'http:'))) {
      throw new Error('INVALID_URL');
    }
    return parsed.href;
  };
  const downloadUrl = url(flags.get('download-url') ?? 'https://speed.cloudflare.com/__down');
  const probe = new URL(downloadUrl);
  probe.searchParams.set('bytes', '0');
  const label = flags.get('label') ?? 'current-network';
  if (label.length > 160 || /[\x00-\x1f\x7f]/.test(label)) throw new Error('INVALID_ARGUMENT');
  return {
    interactive: flags.has('interactive'), label,
    durationSeconds: integer('duration-seconds', 20, 5, 120), idleSeconds: integer('idle-seconds', 15, 5, 120),
    parallel: integer('parallel', 4, 2, 8), rounds: integer('rounds', 1, 1, 3),
    downloadUrl, uploadUrl: url(flags.get('upload-url') ?? 'https://speed.cloudflare.com/__up'),
    latencyUrl: url(flags.get('latency-url') ?? probe.href),
    outputDir: resolve(flags.get('output-dir') ?? join(root, '.local', 'reports', 'network-benchmark')),
  };
}

export function distribution(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  const at = fraction => sorted.length ? rounded(sorted[Math.ceil(sorted.length * fraction) - 1]) : null;
  return { samples: sorted.length, min: sorted.length ? rounded(sorted[0]) : null, p50: at(0.5), p95: at(0.95),
    max: sorted.length ? rounded(sorted.at(-1)) : null };
}

function rounded(value) { return Math.round(value * 1000) / 1000; }
function endpoint(value) { const url = new URL(value); return `${url.origin}${url.pathname}`; }
function downloadUrl(base, bytes) {
  const url = new URL(base);
  url.searchParams.set('bytes', String(bytes));
  url.searchParams.set('benchmark', randomBytes(6).toString('hex'));
  return url.href;
}

// Explicit fields avoid curl's full JSON, which also contains URLs and certificates.
const format = JSON.stringify(Object.fromEntries(['http_code', 'size_download', 'size_upload', 'time_namelookup',
  'time_connect', 'time_appconnect', 'time_starttransfer', 'time_total', 'local_ip', 'remote_ip']
  .map(key => [key, `%{${key}}`])));

export function createRunner({ children = new Set(), cancelled = () => false } = {}) {
  return (url, { timeoutSeconds = 5, uploadFile, bytes, phaseDeadline } = {}) => new Promise(resolveResult => {
    if (cancelled()) return resolveResult({ exitCode: null, failure: 'CANCELLED', successful: false });
    const begin = performance.now();
    const args = ['-q', '--silent', '--ipv4', '--http1.1', '--globoff', '--noproxy', '*',
      '--connect-timeout', String(Math.min(4, timeoutSeconds)), '--max-time', String(timeoutSeconds),
      '--output', nullDevice, '--write-out', format, '--header', 'Accept-Encoding: identity',
      '--header', 'Cache-Control: no-cache'];
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
      const okStatus = status >= 200 && status < 300;
      const downloaded = number('size_download') ?? 0, uploaded = number('size_upload') ?? 0;
      const deadlineTimeout = exitCode === 28 && phaseDeadline !== undefined && end >= phaseDeadline - 150;
      const completeBody = bytes === undefined || (uploadFile ? uploaded === bytes : downloaded === bytes);
      const successful = exitCode === 0 && okStatus && completeBody;
      const failure = successful ? null : cancelled() ? 'CANCELLED' : failed ? 'CURL_UNAVAILABLE' : forced ? 'WATCHDOG' :
        exitCode === 28 ? 'TIMEOUT' : !okStatus && status ? 'HTTP_STATUS' : exitCode === 0 ? 'BODY_SIZE' : 'CURL_ERROR';
      const ms = key => number(key) === null ? null : rounded(number(key) * 1000);
      resolveResult({ exitCode, httpStatus: status, successful, failure, deadlineTimeout, completeBody,
        elapsedMs: rounded(end - begin), downloadedBytes: downloaded, uploadedBytes: uploaded,
        // Download bytes after 2xx, including the bounded final partial transfer.
        countedDownloadBytes: okStatus && (exitCode === 0 || deadlineTimeout) ? downloaded : 0,
        // Upload is client-side bytes sent; no receiver goodput claim for an unfinished POST.
        countedUploadBytes: (okStatus && exitCode === 0) || (deadlineTimeout && (okStatus || status === 0)) ? uploaded : 0,
        acknowledgedUploadBytes: successful ? uploaded : 0,
        dnsMs: ms('time_namelookup'), connectCumulativeMs: ms('time_connect'), tlsCumulativeMs: ms('time_appconnect'),
        ttfbMs: ms('time_starttransfer'), totalMs: ms('time_total'),
        localIp: raw.local_ip || null, remoteIp: raw.remote_ip || null,
        fullyWithinPhase: phaseDeadline === undefined || end <= phaseDeadline,
      });
    });
  });
}

export function summarizePhase(phase, records) {
  const probes = records.filter(row => row.kind === 'probe');
  const comparable = probes.filter(row => row.fullyWithinPhase);
  const successful = comparable.filter(row => row.successful);
  const transfers = records.filter(row => row.kind === 'transfer');
  const downloadBytes = transfers.reduce((n, row) => n + row.countedDownloadBytes, 0);
  const uploadBytes = transfers.reduce((n, row) => n + row.countedUploadBytes, 0);
  const acknowledgedUploadBytes = transfers.reduce((n, row) => n + row.acknowledgedUploadBytes, 0);
  const bytes = phase.direction === 'download' ? downloadBytes : uploadBytes;
  const failures = {};
  for (const row of transfers.filter(row => !row.successful && !row.deadlineTimeout)) {
    failures[row.failure] = (failures[row.failure] ?? 0) + 1;
  }
  const warnings = [];
  if (successful.length < 40) warnings.push('LOW_LATENCY_SAMPLE_COUNT_P95_EXPLORATORY');
  if (!successful.length) warnings.push('NO_VALID_LATENCY');
  if (phase.direction && !transfers.some(row => row.successful)) warnings.push('NO_COMPLETED_LOAD_REQUEST');
  if (phase.direction && !bytes) warnings.push('NO_VALID_THROUGHPUT');
  if (comparable.some(row => !row.successful)) warnings.push('LATENCY_REQUEST_FAILURES');
  if (Object.keys(failures).length) warnings.push('LOAD_REQUEST_FAILURES');
  return { ...phase, downloadBytes, uploadBytes, acknowledgedUploadBytes,
    averageMbps: phase.direction && bytes ? rounded(bytes * 8 / (phase.elapsedMs / 1000) / 1e6) : null,
    transferRequests: transfers.length, completedTransfers: transfers.filter(row => row.successful).length,
    deadlineTimeouts: transfers.filter(row => row.deadlineTimeout).length, transferFailures: failures,
    latency: { attempts: comparable.length, excludedBoundarySamples: probes.length - comparable.length,
      successes: successful.length, failures: comparable.length - successful.length,
      successRate: comparable.length ? rounded(successful.length / comparable.length) : null,
      httpsColdTtfbMs: distribution(successful.map(row => row.ttfbMs)),
      httpsColdTotalMs: distribution(successful.map(row => row.totalMs)),
      dnsMs: distribution(successful.map(row => row.dnsMs)) }, warnings };
}

async function networkSnapshot() {
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

export async function runBenchmark(options, { log = console.log, captureNetwork = true } = {}) {
  const children = new Set();
  let cancelled = false;
  const stop = () => { cancelled = true; for (const child of children) child.kill(); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  let directory, uploadFile;
  const report = { schemaVersion: 1, startedAt: new Date().toISOString(), status: 'running', label: options.label,
    method: { transport: 'curl IPv4 HTTP/1.1; fresh connection per request; system DNS cache retained',
      routing: 'Current system routing; curl config and environment proxies bypassed; path NOT automatically verified',
      latency: 'Cold HTTPS TTFB includes DNS, TCP, TLS, server and network time; not ICMP RTT or packet loss',
      throughput: 'Application payload / whole load-phase wall time, including connection overhead and idle gaps',
      upload: 'Client-side sent bytes; acknowledgedUploadBytes includes only completed successful POSTs',
      downloadRequestBytes: 100_000_000, uploadRequestBytes: 10_000_000, probeIntervalMs: 1000,
      durationSeconds: options.durationSeconds, idleSeconds: options.idleSeconds, parallel: options.parallel, rounds: options.rounds },
    endpoints: { download: endpoint(options.downloadUrl), upload: endpoint(options.uploadUrl), latency: endpoint(options.latencyUrl) },
    phases: [], warnings: ['Internet target, Wi-Fi, uplink and proxy node can limit results; this is not an isolated gateway capacity test.'] };
  try {
    const version = await execute(curl, ['-q', '--version'], { timeout: 5000, windowsHide: true });
    report.curlVersion = version.stdout.split(/\r?\n/)[0];
    const match = /^curl (\d+)\.(\d+)/.exec(report.curlVersion);
    if (!match || Number(match[1]) < 7 || (Number(match[1]) === 7 && Number(match[2]) < 70)) throw new Error('CURL_TOO_OLD');
    await mkdir(options.outputDir, { recursive: true });
    directory = await mkdtemp(join(options.outputDir, `${new Date().toISOString().replace(/[:.]/g, '-')}-`));
    uploadFile = join(directory, 'upload-payload.tmp');
    await writeFile(uploadFile, randomBytes(report.method.uploadRequestBytes), { flag: 'wx' });
    report.nodeVersion = process.version;
    report.networkBefore = captureNetwork ? await networkSnapshot() : null;
    const persist = () => writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    const run = createRunner({ children, cancelled: () => cancelled });
    const record = async row => { await appendFile(join(directory, 'samples.jsonl'), JSON.stringify(row) + '\n'); };
    log(`Results: ${directory}`);
    log('Checking small download, latency and upload requests before load...');
    await persist();
    // Use a separate small POST so preflight cannot upload the full load payload.
    const smallFile = join(directory, 'preflight-payload.tmp');
    await writeFile(smallFile, randomBytes(65536), { flag: 'wx' });
    try {
      report.preflight = [];
      for (const [kind, url, extra] of [
        ['download', downloadUrl(options.downloadUrl, 65536), { bytes: 65536 }],
        ['probe', options.latencyUrl, {}],
        ['upload', options.uploadUrl, { uploadFile: smallFile, bytes: 65536 }],
      ]) {
        const result = await run(url, { timeoutSeconds: 8, ...extra });
        report.preflight.push({ kind, ...result });
        await persist();
        if (!result.successful) { report.status = cancelled ? 'cancelled' : 'preflight-failed'; return { directory, report }; }
      }
    } finally { await rm(smallFile, { force: true }); }

    let index = 0;
    for (let round = 1; round <= options.rounds && !cancelled; round++) {
      const phases = [
        { name: 'idle', direction: null, workers: 0, seconds: options.idleSeconds },
        { name: 'download-single', direction: 'download', workers: 1, seconds: options.durationSeconds },
        { name: 'upload-single', direction: 'upload', workers: 1, seconds: options.durationSeconds },
        { name: 'download-parallel', direction: 'download', workers: options.parallel, seconds: options.durationSeconds },
        { name: 'upload-parallel', direction: 'upload', workers: options.parallel, seconds: options.durationSeconds },
      ];
      for (const definition of phases) {
        if (cancelled) break;
        if (index > 0) await delay(2000);
        if (cancelled) break;
        const started = performance.now(), deadline = started + definition.seconds * 1000;
        const phase = { id: ++index, round, ...definition, startedAt: new Date().toISOString() };
        const records = [];
        log(`[${index}/${options.rounds * 5}] ${definition.name}: ${definition.seconds}s, workers=${definition.workers}`);
        const save = async row => {
          const result = { phaseId: phase.id, atMs: rounded(performance.now() - started), ...row };
          records.push(result);
          await record(result);
        };
        const probe = async () => {
          while (!cancelled && performance.now() < deadline - 100) {
            const at = performance.now();
            await save({ kind: 'probe', ...await run(options.latencyUrl, { timeoutSeconds: 4, phaseDeadline: deadline }) });
            await delay(Math.max(0, Math.min(1000 - (performance.now() - at), deadline - performance.now())));
          }
        };
        const worker = async workerId => {
          let consecutiveFailures = 0;
          while (!cancelled && performance.now() < deadline - 100) {
            const remaining = (deadline - performance.now()) / 1000;
            const up = definition.direction === 'upload';
            const bytes = up ? report.method.uploadRequestBytes : report.method.downloadRequestBytes;
            const result = await run(up ? options.uploadUrl : downloadUrl(options.downloadUrl, bytes), {
              timeoutSeconds: remaining, phaseDeadline: deadline, bytes, ...(up ? { uploadFile } : {}) });
            await save({ kind: 'transfer', workerId, ...result });
            consecutiveFailures = result.successful || result.deadlineTimeout ? 0 : consecutiveFailures + 1;
            if (consecutiveFailures >= 2) break;
            if (!result.successful && !result.deadlineTimeout) await delay(500);
          }
        };
        // Whole load window is the denominator even if a worker exits early on failure.
        const load = Promise.all(Array.from({ length: definition.workers }, (_, i) => worker(i + 1)))
          .then(() => performance.now());
        const latency = probe();
        while (!cancelled && performance.now() < deadline) await delay(Math.min(200, deadline - performance.now()));
        const windowEnded = performance.now();
        const [loadEnded] = await Promise.all([load, latency]);
        phase.elapsedMs = rounded(Math.max(windowEnded, loadEnded) - started);
        const summary = summarizePhase(phase, records);
        report.phases.push(summary);
        await persist();
        log(`  ${summary.averageMbps === null ? 'No throughput measurement' : `${summary.averageMbps} Mbps`}; HTTPS TTFB p50/p95 = ${summary.latency.httpsColdTtfbMs.p50 ?? '-'} / ${summary.latency.httpsColdTtfbMs.p95 ?? '-'} ms; failures=${summary.latency.failures}`);
      }
    }
    report.status = cancelled ? 'cancelled' : report.phases.some(row => row.warnings.includes('NO_VALID_THROUGHPUT') ||
      row.warnings.includes('LOAD_REQUEST_FAILURES') || row.warnings.includes('LATENCY_REQUEST_FAILURES') ||
      row.warnings.includes('NO_VALID_LATENCY') || row.warnings.includes('NO_COMPLETED_LOAD_REQUEST')) ? 'completed-with-warnings' : 'completed';
    return { directory, report };
  } catch (error) {
    report.status = cancelled ? 'cancelled' : 'error';
    report.error = ['CURL_TOO_OLD'].includes(error.message) ? error.message : 'LOCAL_EXECUTION_FAILED';
    if (!directory) throw new Error(report.error);
    return { directory, report };
  } finally {
    for (const child of children) child.kill();
    if (directory) {
      report.completedAt = new Date().toISOString();
      if (captureNetwork) report.networkAfter = await networkSnapshot();
      if (uploadFile) await rm(uploadFile, { force: true });
      await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
      const rows = report.phases.map(row => `${row.round},${row.name},${row.workers},${row.averageMbps ?? ''},${row.latency.httpsColdTtfbMs.p50 ?? ''},${row.latency.httpsColdTtfbMs.p95 ?? ''},${row.latency.attempts},${row.latency.failures},${row.warnings.join('|')}`);
      await writeFile(join(directory, 'summary.csv'), '\ufeffround,phase,workers,average_mbps,https_ttfb_p50_ms,https_ttfb_p95_ms,probe_attempts,probe_failures,warnings\n' + rows.join('\n') + '\n');
      const summary = [`Status: ${report.status}`, `Scenario: ${report.label}`, '',
        ...report.phases.map(row => `${row.name}: ${row.averageMbps ?? '-'} Mbps; HTTPS TTFB p50/p95 ${row.latency.httpsColdTtfbMs.p50 ?? '-'} / ${row.latency.httpsColdTtfbMs.p95 ?? '-'} ms; failed probes ${row.latency.failures}/${row.latency.attempts}`),
        '', 'Upload Mbps is client-side sent bytes. HTTPS TTFB is a new connection request time, not ping RTT.',
        'P95 with fewer than 40 successful samples is exploratory. Routing/proxy selection was not verified.',
        'Send report.json and samples.jsonl for analysis. Outputs contain local network addresses; keep private.'];
      await writeFile(join(directory, 'summary.txt'), summary.join('\r\n') + '\r\n');
    }
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') && args.every(arg => ['--interactive', '--help'].includes(arg))) { console.log(usage); return; }
  const options = parseOptions(args);
  if (options.interactive) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      console.log('请先连接要测试的网络，保持当前节点不变，暂停其他下载和构建。');
      console.log('不会切换网络、代理或路由。默认访问 Cloudflare 测速端点；会占用带宽，可能消耗数 GB 流量。');
      const answer = (await rl.question('填写场景（例如 4A-WiFi-代理开启），按回车开始；Ctrl+C 取消：')).trim();
      if (answer) {
        if (answer.length > 160 || /[\x00-\x1f\x7f]/.test(answer)) throw new Error('INVALID_ARGUMENT');
        options.label = answer;
      }
    } finally { rl.close(); }
  }
  console.log(`预计约 ${Math.ceil((options.idleSeconds + options.durationSeconds * 4 + 12) * options.rounds / 60)} 分钟，另加端点检查时间。Ctrl+C 可停止并保存已采集数据。`);
  const { directory, report } = await runBenchmark(options);
  console.log(`\n${report.status}\n结果目录：${directory}\n先看 summary.txt；分析时提供 report.json 和 samples.jsonl。`);
  process.exitCode = ['completed', 'completed-with-warnings'].includes(report.status) ? 0 : report.status === 'cancelled' ? 130 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(['INVALID_ARGUMENT', 'INVALID_URL', 'CURL_TOO_OLD', 'LOCAL_EXECUTION_FAILED'].includes(error.message) ? error.message : 'BENCHMARK_FAILED');
    process.exitCode = 1;
  });
}
