import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile, appendFile, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { createRunner, distribution, networkSnapshot, root, endpoint } from './network-benchmark.mjs';

export const defaultTargets = [
  { id: 'baidu', name: '百度', region: 'domestic', probeUrl: 'https://www.baidu.com/' },
  { id: 'tencent', name: '腾讯／微信', region: 'domestic', probeUrl: 'https://www.qq.com/',
    download: { mode: 'range', url: 'https://dldir1v6.qq.com/weixin/Windows/WeChatSetup_x86.exe' } },
  { id: 'bilibili', name: '哔哩哔哩', region: 'domestic', probeUrl: 'https://www.bilibili.com/',
    download: { mode: 'range', url: 'https://dl.hdslb.com/mobile/fixed/bili_win/bili_win-install.exe' } },
  { id: 'netease', name: '网易', region: 'domestic', probeUrl: 'https://www.163.com/' },
  { id: 'google', name: 'Google', region: 'overseas', probeUrl: 'https://www.google.com/generate_204',
    download: { mode: 'range', url: 'https://dl.google.com/android/repository/platform-tools-latest-windows.zip' } },
  { id: 'github', name: 'GitHub', region: 'overseas', probeUrl: 'https://github.com/' },
  { id: 'youtube', name: 'YouTube', region: 'overseas', probeUrl: 'https://www.youtube.com/generate_204' },
  { id: 'wikipedia', name: 'Wikipedia', region: 'overseas', probeUrl: 'https://en.wikipedia.org/wiki/Main_Page' },
  { id: 'cloudflare', name: 'Cloudflare 专用测速（补充）', region: 'overseas',
    probeUrl: 'https://speed.cloudflare.com/__down?bytes=0',
    download: { mode: 'bytes', url: 'https://speed.cloudflare.com/__down' }, uploadUrl: 'https://speed.cloudflare.com/__up' },
];

const help = `Windows common-site benchmark (existing Node.js >=22.18 + curl >=8.4)
  --interactive             Enter a label before running
  --config PATH             Private JSON target list and optional read-only SSH observer
  --label TEXT              Label only; never changes routing
  --duration-seconds N      Load phase 5..120 seconds (default 15)
  --idle-seconds N          Baseline 5..120 seconds (default 15)
  --parallel N              Download connections per site, 2..4 (default 2)
  --rounds N                Repeat sequence 1..3 (default 1)
  --max-mib N               Total load payload budget 16..8192 MiB (default 2048)
  --output-dir PATH         Private results parent
  --allow-http              Loopback synthetic tests only
  --help                    No network traffic
Default: domestic/overseas common-site probes, per-site public-file downloads,
multi-site current-routing download, optional supported upload. Failed sites are skipped.
Local config: .local/environments/network-benchmark.json, when present.
No rule/node/network changes. Regions and labels do not prove direct/proxy routing.\n`;

function validUrl(value, allowHttp) {
  let url;
  try { url = new URL(value); } catch { throw new Error('INVALID_TARGET_URL'); }
  if (url.username || url.password || url.hash || !(url.protocol === 'https:' || allowHttp &&
    url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) throw new Error('INVALID_TARGET_URL');
  return url.href;
}

export function validateConfig(config, allowHttp = false) {
  if (!config || config.schemaVersion !== 1 || !Array.isArray(config.targets) || !config.targets.length || config.targets.length > 16) throw new Error('INVALID_CONFIG');
  const ids = new Set();
  const targets = config.targets.map(t => {
    if (!t || !/^[a-z0-9-]{1,40}$/.test(t.id) || ids.has(t.id) || typeof t.name !== 'string' ||
      t.name.length > 80 || /[\r\n\x00]/.test(t.name) || !['domestic', 'overseas', 'custom'].includes(t.region)) throw new Error('INVALID_CONFIG');
    ids.add(t.id);
    const value = { id: t.id, name: t.name, region: t.region, probeUrl: validUrl(t.probeUrl, allowHttp) };
    if (t.download) {
      if (!['range', 'bytes'].includes(t.download.mode)) throw new Error('INVALID_CONFIG');
      value.download = { mode: t.download.mode, url: validUrl(t.download.url, allowHttp) };
    }
    if (t.uploadUrl) value.uploadUrl = validUrl(t.uploadUrl, allowHttp);
    return value;
  });
  if (config.observer && (typeof config.observer.sshHost !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._@-]{0,159}$/.test(config.observer.sshHost) ||
    typeof config.observer.runtimeSettingsPath !== 'string' || !config.observer.runtimeSettingsPath.startsWith('/') ||
    /[\r\n\x00]/.test(config.observer.runtimeSettingsPath))) throw new Error('INVALID_OBSERVER');
  return { targets, observer: config.observer ?? null };
}

export async function suiteOptions(args) {
  const flags = new Map(), booleans = new Set(['interactive', 'allow-http']);
  const allowed = new Set([...booleans, 'config', 'label', 'duration-seconds', 'idle-seconds', 'parallel', 'rounds', 'max-mib', 'output-dir']);
  for (let i = 0; i < args.length; i++) {
    const key = args[i].startsWith('--') ? args[i].slice(2) : '';
    if (!allowed.has(key) || flags.has(key)) throw new Error('INVALID_ARGUMENT');
    const value = booleans.has(key) ? true : args[++i];
    if (!value || String(value).startsWith('--')) throw new Error('INVALID_ARGUMENT');
    flags.set(key, value);
  }
  const integer = (key, defaultValue, min, max) => {
    const value = String(flags.get(key) ?? defaultValue);
    if (!/^\d+$/.test(value) || Number(value) < min || Number(value) > max) throw new Error('INVALID_ARGUMENT');
    return Number(value);
  };
  let config = { schemaVersion: 1, targets: defaultTargets };
  const configPath = resolve(flags.get('config') ?? join(root, '.local', 'environments', 'network-benchmark.json'));
  try { const saved = JSON.parse(await readFile(configPath, 'utf8')); config = { ...saved, targets: saved.targets ?? defaultTargets }; }
  catch (error) { if (flags.has('config') || error.code !== 'ENOENT') throw new Error('CONFIG_UNREADABLE'); }
  const label = flags.get('label') ?? 'current-network';
  if (label.length > 160 || /[\x00-\x1f\x7f]/.test(label)) throw new Error('INVALID_ARGUMENT');
  return { ...validateConfig(config, flags.has('allow-http')), label, interactive: flags.has('interactive'),
    durationSeconds: integer('duration-seconds', 15, 5, 120), idleSeconds: integer('idle-seconds', 15, 5, 120),
    parallel: integer('parallel', 2, 2, 4), rounds: integer('rounds', 1, 1, 3),
    maxBytes: integer('max-mib', 2048, 16, 8192) * 1024 * 1024,
    outputDir: resolve(flags.get('output-dir') ?? join(root, '.local', 'reports', 'network-benchmark')) };
}

export function requestForDownload(target, bytes) {
  if (target.download.mode === 'range') return { url: target.download.url,
    args: { range: { start: 0, end: bytes - 1 }, bytes, binary: true, expectedStatus: 206 } };
  const url = new URL(target.download.url);
  url.searchParams.set('bytes', String(bytes));
  url.searchParams.set('benchmark', randomBytes(6).toString('hex'));
  return { url: url.href, args: { bytes, binary: true, expectedStatus: 200 } };
}

export function summarizeSiteProbes(records, phase) {
  return Object.fromEntries([...new Set(records.filter(r => r.kind === 'probe').map(r => r.targetId))].map(id => {
    const attempts = records.filter(r => r.kind === 'probe' && r.targetId === id);
    const within = attempts.filter(r => r.successful && r.endedAtMs <= phase.endedAtMs);
    const failures = attempts.filter(r => !r.successful);
    const stages = {};
    for (const row of failures) stages[row.failureStage ?? row.failure ?? 'unknown'] = (stages[row.failureStage ?? row.failure ?? 'unknown'] ?? 0) + 1;
    return [id, { attempts: attempts.length, successesWithinWindow: within.length, failures: failures.length,
      boundaryCensored: attempts.length - failures.length - within.length,
      attemptsOverlappingRequestsWithPayload: attempts.filter(row => row.loadOverlap === true).length,
      successRate: attempts.length ? within.length / attempts.length : null,
      coldTtfbMs: distribution(within.map(r => r.ttfbMs)), totalMs: distribution(within.map(r => r.totalMs)), failureStages: stages }];
  }));
}

const unknown = () => ({ status: 'unverified', route: 'unknown' });
export function routeSummary(records, classify = unknown) {
  const counts = { direct: 0, proxy: 0, reject: 0, unknown: 0 }, bytes = { direct: 0, proxy: 0, reject: 0, unknown: 0 };
  const fingerprints = new Set();
  let ambiguous = false;
  for (const row of records) {
    const evidence = classify(row);
    row.pathEvidence = evidence;
    const route = evidence.status === 'verified' && Object.hasOwn(counts, evidence.route) ? evidence.route : 'unknown';
    counts[route]++;
    bytes[route] += row.countedDownloadBytes ?? 0;
    if (evidence.fingerprint) fingerprints.add(evidence.fingerprint);
    if (evidence.status === 'ambiguous') ambiguous = true;
  }
  const known = Object.entries(counts).filter(([key, count]) => key !== 'unknown' && count > 0).map(([key]) => key);
  const route = known.length > 1 ? 'mixed' : known.length === 1 ? `${counts.unknown ? 'partial-' : ''}${known[0]}` : 'unknown';
  return { route, counts, downloadBytes: bytes,
    coverage: records.length ? 1 - counts.unknown / records.length : 0, configurationChanged: fingerprints.size > 1 || ambiguous };
}

export async function runSuite(options, { log = console.log, captureNetwork = true, observerFactory, appendSample = appendFile } = {}) {
  const children = new Set(), records = [];
  let cancelled = false, faulted = false, directory, observer, payload;
  const pending = new Set();
  const stop = () => { cancelled = true; for (const child of children) child.kill(); };
  const guard = task => {
    const promise = Promise.resolve().then(task).catch(() => { faulted = true; stop(); });
    pending.add(promise); void promise.then(() => pending.delete(promise));
    return promise;
  };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  const run = createRunner({ children, cancelled: () => cancelled });
  const report = { schemaVersion: 2, startedAt: new Date().toISOString(), label: options.label, status: 'running',
    method: { focus: 'Multi-site current-routing business download throughput; verified DIRECT aggregate when available',
      transport: 'curl IPv4 HTTP/1.1; fresh connections; system DNS cache retained; no environment proxy',
      latency: 'Cold request TTFB includes DNS/TCP/TLS/server; not ping RTT or packet loss',
      throughput: 'Valid payload / actual load window; successful and final partial transfers counted; not physical link capacity',
      upload: 'Client-side sent bytes; successful POST client bytes are not server-reported received bytes',
      rounds: options.rounds, durationSeconds: options.durationSeconds, idleSeconds: options.idleSeconds,
      parallel: options.parallel, probeIntervalMs: 4000, maxBytes: options.maxBytes },
    targets: options.targets.map(t => ({ ...t, probeUrl: endpoint(t.probeUrl),
      ...(t.download ? { download: { mode: t.download.mode, url: endpoint(t.download.url) } } : {}),
      ...(t.uploadUrl ? { uploadUrl: endpoint(t.uploadUrl) } : {}) })), capabilities: {}, phases: [],
    observer: { configured: Boolean(options.observer), available: false }, loadBytes: 0, warnings: [] };
  let reserved = 0;
  let phaseByteLimit = options.maxBytes;
  const reserve = wanted => { const size = Math.max(0, Math.min(wanted, options.maxBytes - report.loadBytes - reserved)); reserved += size; return size; };
  const release = (size, actual) => {
    reserved -= size; report.loadBytes += actual ?? 0;
    if (actual > size) { report.warnings.push('PAYLOAD_BUDGET_EXCEEDED_LOAD_STOPPED'); faulted = true; stop(); }
  };
  try {
    const { stdout } = await promisify(execFile)(process.platform === 'win32' ? 'curl.exe' : 'curl', ['-q', '--version'], { timeout: 5000, windowsHide: true });
    report.curlVersion = stdout.split(/\r?\n/)[0];
    const version = /^curl (\d+)\.(\d+)/.exec(stdout);
    if (!version || Number(version[1]) < 8 || Number(version[1]) === 8 && Number(version[2]) < 4) throw new Error('CURL_8_4_REQUIRED');
    await mkdir(options.outputDir, { recursive: true });
    directory = await mkdtemp(join(options.outputDir, `${new Date().toISOString().replace(/[:.]/g, '-')}-`));
    const persist = () => writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    const save = async row => { records.push(row); await appendSample(join(directory, 'samples.jsonl'), JSON.stringify(row) + '\n'); };
    log(`结果目录：${directory}`);
    report.networkBefore = captureNetwork ? await networkSnapshot() : null;
    if (options.observer) {
      try {
        const start = observerFactory ?? (await import('./benchmark-observer.mjs')).startObserver;
        const hosts = options.targets.flatMap(t => [t.probeUrl, t.download?.url, t.uploadUrl].filter(Boolean).map(url => new URL(url).hostname));
        observer = await start(options.observer, { sourceIps: report.networkBefore?.interfaces.map(i => i.address) ?? ['127.0.0.1'],
          hosts, seconds: Math.min(3600, options.rounds * (options.targets.length * (options.durationSeconds * 3 + 30) + options.idleSeconds + 60)), log });
        report.observer.available = observer.available;
      } catch { report.warnings.push('OBSERVER_UNAVAILABLE_PATHS_WILL_BE_UNVERIFIED'); }
    }
    await persist();
    log('逐站检查下载／上传能力；单站失败会跳过，不终止其他站点。');
    for (const target of options.targets) {
      if (cancelled) break;
      const capability = report.capabilities[target.id] = { download: { status: 'not-provided' }, upload: { status: 'not-provided' } };
      if (target.download) {
        const request = requestForDownload(target, 65536, true);
        const result = await run(request.url, { ...request.args, timeoutSeconds: 8 });
        await save({ kind: 'preflight-download', targetId: target.id, host: new URL(request.url).hostname, ...result });
        const total = target.download.mode === 'range' ? Number(result.contentRange?.split('/')[1]) : 32 * 1024 * 1024;
        capability.download = { status: result.successful && total >= 1024 * 1024 ? 'available' : 'failed',
          failure: result.successful && total < 1024 * 1024 ? 'OBJECT_TOO_SMALL_OR_RANGE_INVALID' : result.failure,
          failureStage: result.failureStage, httpStatus: result.httpStatus, objectBytes: Number.isFinite(total) ? total : null };
        log(`  ${target.name} 下载：${capability.download.status}${capability.download.failure ? ` (${capability.download.failure})` : ''}`);
      }
      if (target.uploadUrl && !cancelled) {
        payload = join(directory, 'upload.tmp');
        await writeFile(payload, randomBytes(65536));
        const result = await run(target.uploadUrl, { uploadFile: payload, bytes: 65536, timeoutSeconds: 8 });
        await save({ kind: 'preflight-upload', targetId: target.id, host: new URL(target.uploadUrl).hostname, ...result });
        capability.upload = { status: result.successful ? 'available' : 'failed', failure: result.failure, failureStage: result.failureStage };
        await rm(payload, { force: true }); payload = undefined;
      }
      await persist();
    }

    const classify = request => observer?.classify(request) ?? unknown();
    const downloadSites = options.targets.filter(t => report.capabilities[t.id]?.download.status === 'available').length;
    const uploadSites = options.targets.filter(t => report.capabilities[t.id]?.upload.status === 'available').length;
    // Reserve a fair share for later sites and the aggregate, including on fast links.
    phaseByteLimit = Math.floor(options.maxBytes / Math.max(1, options.rounds * (downloadSites * 2 + uploadSites + 1)));
    report.method.perLoadPhaseByteLimit = phaseByteLimit;
    const phase = async (name, jobs = [], round = 1) => {
      if (cancelled) return;
      if (report.phases.length) await delay(2000);
      if (cancelled) return;
      const duration = jobs.length ? options.durationSeconds : options.idleSeconds;
      const startedAtMs = Date.now(), started = performance.now(), deadline = started + duration * 1000;
      const id = report.phases.length + 1, rows = [];
      let ended = false, active = 0, phaseUsed = 0, phaseReserved = 0;
      log(`[第 ${round} 轮] ${name}，最多 ${duration} 秒`);
      const store = async row => { const value = { phaseId: id, ...row }; rows.push(value); await save(value); };
      const probes = options.targets.map((t, i) => guard(async () => {
        await delay(i * 120);
        while (!cancelled && !ended && performance.now() < deadline - 100) {
          const start = performance.now();
          const underLoadAtStart = active > 0;
          const result = await run(t.probeUrl, { timeoutSeconds: 5 });
          await store({ kind: 'probe', targetId: t.id, host: new URL(t.probeUrl).hostname, underLoadAtStart, ...result });
          const until = performance.now() + Math.max(0, 4000 - (performance.now() - start));
          while (!cancelled && !ended && performance.now() < Math.min(until, deadline)) await delay(Math.min(100, Math.max(1, Math.min(until, deadline) - performance.now())));
        }
      }));
      const workers = jobs.map((job, workerIndex) => guard(async () => {
        let failures = 0, workerUsed = 0;
        const workerLimit = Math.floor(phaseByteLimit / Math.max(1, jobs.length));
        while (!cancelled && performance.now() < deadline - 100 && failures < 2) {
          const target = job.target;
          const desired = job.direction === 'upload' ? 4 * 1024 * 1024 : Math.min(32 * 1024 * 1024, report.capabilities[target.id].download.objectBytes);
          const size = reserve(Math.max(0, Math.min(desired, workerLimit - workerUsed, phaseByteLimit - phaseUsed - phaseReserved)));
          if (size < 65536) { release(size, 0); break; }
          const request = job.direction === 'upload' ? { url: target.uploadUrl, args: { uploadFile: payload, bytes: size } } : requestForDownload(target, size);
          // Upload payload has a fixed size; a smaller remaining budget cannot start another POST.
          if (job.direction === 'upload' && size !== 4 * 1024 * 1024) { release(size, 0); break; }
          phaseReserved += size;
          active++;
          const result = await run(request.url, { ...request.args, timeoutSeconds: Math.max(0.1, (deadline - performance.now()) / 1000), phaseDeadline: started + duration * 1000 });
          active--;
          const actualBytes = (job.direction === 'upload' ? result.uploadedBytes : result.downloadedBytes) ?? 0;
          phaseReserved -= size; phaseUsed += actualBytes; workerUsed += actualBytes;
          release(size, actualBytes);
          await store({ kind: 'transfer', workerId: workerIndex + 1, targetId: target.id, direction: job.direction, host: new URL(request.url).hostname, ...result });
          failures = result.successful || result.deadlineTimeout ? 0 : failures + 1;
          if (failures) await delay(250);
        }
      }));
      if (jobs.length) await Promise.all(workers);
      else while (!cancelled && performance.now() < deadline) await delay(Math.min(100, Math.max(1, deadline - performance.now())));
      ended = true;
      const endedAtMs = Date.now(), elapsedMs = Math.max(1, performance.now() - started);
      await Promise.all(probes);
      if (faulted) throw new Error('LOCAL_EXECUTION_FAILED');
      const transfers = rows.filter(r => r.kind === 'transfer');
      for (const row of rows.filter(r => r.kind === 'probe')) {
        row.loadOverlap = transfers.some(r => (r.countedDownloadBytes > 0 || r.countedUploadBytes > 0) &&
          row.startedAtMs >= r.startedAtMs && row.startedAtMs < r.endedAtMs);
      }
      const bytes = transfers.reduce((sum, r) => sum + (r.direction === 'upload' ? r.countedUploadBytes ?? 0 : r.countedDownloadBytes ?? 0), 0);
      const result = { id, name, round, startedAtMs, endedAtMs, elapsedMs, workers: jobs.length,
        loadMbps: jobs.length && bytes ? bytes * 8 / elapsedMs / 1000 : null,
        loadBytes: bytes, loadRequests: transfers.length,
        startedWorkers: new Set(transfers.map(r => r.workerId)).size,
        targetIdsUsed: [...new Set(transfers.map(r => r.targetId))],
        failureCount: transfers.filter(r => !r.successful && !r.deadlineTimeout).length,
        timedOutAtBoundary: transfers.filter(r => r.deadlineTimeout).length,
        loadEndedEarly: jobs.length > 0 && elapsedMs < duration * 1000 - 500, phasePayloadBytes: phaseUsed,
        phaseByteLimit, byteLimitReached: phaseUsed >= phaseByteLimit - 65536,
        hasTransferredLoad: transfers.some(r => r.countedDownloadBytes > 0 || r.countedUploadBytes > 0),
        probes: summarizeSiteProbes(rows, { endedAtMs }), path: routeSummary(transfers, classify) };
      report.phases.push(result);
      await persist();
      log(`  ${result.loadMbps === null ? '仅时延／无有效吞吐' : `${result.loadMbps.toFixed(2)} Mbps`}；路径=${result.path.route}，失败请求=${result.failureCount}`);
    };

    for (let round = 1; round <= options.rounds && !cancelled; round++) {
      await phase('idle', [], round);
      const available = options.targets.filter(t => report.capabilities[t.id]?.download.status === 'available');
      for (const target of available) {
        if (cancelled || report.loadBytes >= options.maxBytes - 65536) break;
        await phase(`${target.id}-download-single`, [{ target, direction: 'download' }], round);
        await phase(`${target.id}-download-parallel`, Array.from({ length: options.parallel }, () => ({ target, direction: 'download' })), round);
      }
      // Prefer fully observed DIRECT sites; a regional fallback is explicitly current-routing only.
      const direct = available.filter(target => {
        const rows = records.filter(r => r.targetId === target.id && r.kind === 'transfer' && r.direction === 'download');
        const path = routeSummary(rows, classify);
        return path.route === 'direct' && path.counts.direct > 0 && !path.configurationChanged;
      });
      const aggregate = direct.length >= 2 ? direct : available.filter(t => t.region === 'domestic');
      if (aggregate.length >= 2 && !cancelled && report.loadBytes < options.maxBytes - 65536) {
        await phase(direct.length >= 2 ? 'direct-candidates-multi-site' : 'current-routing-multi-site',
          aggregate.slice(0, 4).map(target => ({ target, direction: 'download' })), round);
      } else report.warnings.push(`ROUND_${round}_MULTI_SITE_AGGREGATE_SKIPPED_NEEDS_TWO_AVAILABLE_SITES_AND_BUDGET`);
      const uploads = options.targets.filter(t => report.capabilities[t.id]?.upload.status === 'available');
      if (uploads.length && phaseByteLimit >= 4 * 1024 * 1024 && !cancelled && report.loadBytes < options.maxBytes - 4 * 1024 * 1024) {
        payload = join(directory, 'upload.tmp'); await writeFile(payload, randomBytes(4 * 1024 * 1024));
        for (const target of uploads) await phase(`${target.id}-upload`, [{ target, direction: 'upload' }], round);
        await rm(payload, { force: true }); payload = undefined;
      } else if (uploads.length && phaseByteLimit < 4 * 1024 * 1024) report.warnings.push('UPLOAD_SKIPPED_PHASE_BUDGET_TOO_SMALL');
    }
    report.status = cancelled ? 'cancelled' : report.phases.some(p => p.loadBytes > 0) ? 'completed-with-limitations' : 'no-valid-throughput';
    return { directory, report };
  } catch (error) {
    report.status = cancelled && !faulted ? 'cancelled' : 'error'; report.error = error.message === 'CURL_8_4_REQUIRED' ? error.message : 'LOCAL_EXECUTION_FAILED';
    if (!directory) throw new Error(report.error);
    return { directory, report };
  } finally {
    cancelled = true;
    for (const child of children) child.kill();
    await Promise.allSettled([...pending]);
    if (observer) {
      await observer.stop();
      report.observer.available = observer.available;
      if (directory) await writeFile(join(directory, 'path-evidence.jsonl'), observer.events.map(row => JSON.stringify(row)).join('\n') + '\n');
    }
    if (directory) {
      for (const p of report.phases) {
        const rows = records.filter(r => r.phaseId === p.id);
        p.path = routeSummary(rows.filter(r => r.kind === 'transfer'), r => observer?.classify(r) ?? unknown());
        p.verifiedDirectMbps = p.path.route === 'direct' && !p.path.configurationChanged ? p.loadMbps : null;
        p.observedDirectPayloadMbps = p.path.downloadBytes.direct * 8 / p.elapsedMs / 1000;
        p.probePaths = Object.fromEntries(options.targets.map(t => [t.id, routeSummary(rows.filter(r => r.kind === 'probe' && r.targetId === t.id), r => observer?.classify(r) ?? unknown())]));
        const baseline = report.phases.find(b => b.round === p.round && b.name === 'idle');
        for (const [id, stats] of Object.entries(p.probes)) {
          const idle = baseline?.probes[id];
          stats.addedP50VsIdleMs = stats.coldTtfbMs.p50 !== null && idle?.coldTtfbMs.p50 != null ? stats.coldTtfbMs.p50 - idle.coldTtfbMs.p50 : null;
        }
      }
      if (payload) await rm(payload, { force: true });
      report.completedAt = new Date().toISOString();
      report.networkAfter = captureNetwork ? await networkSnapshot() : null;
      report.warnings.push('Regions do not establish routing; unresolved paths cannot be counted as verified DIRECT.',
        'Website/CDN/server limitations remain; these results do not establish the device processing ceiling.',
        'Low sample count: P95 is exploratory. Empty windows and failures are not zero latency or zero capacity.');
      await writeFile(join(directory, 'samples.jsonl'), records.map(row => JSON.stringify(row)).join('\n') + '\n');
      await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
      const lines = [`状态：${report.status}`, `场景：${report.label}`, `负载流量：${(report.loadBytes / 1024 / 1024).toFixed(1)} MiB`, '', '逐站能力检查：',
        ...options.targets.map(t => `${t.name}：下载 ${report.capabilities[t.id]?.download.status ?? '未测试'}；上传 ${report.capabilities[t.id]?.upload.status ?? '未测试'}`), '', '负载阶段：',
        ...report.phases.filter(p => p.workers).map(p => `${p.name}：${p.loadMbps?.toFixed(2) ?? '无有效数据'} Mbps；实际观测 ${p.path.route}；连接证据覆盖 ${(p.path.coverage * 100).toFixed(0)}%；请求失败 ${p.failureCount}`),
        '', '逐站时延（冷连接 TTFB p50/p95；不是 ping）：',
        ...report.phases.flatMap(p => Object.entries(p.probes).map(([id, s]) => `${p.name} / ${id}：${s.coldTtfbMs.p50 ?? '-'} / ${s.coldTtfbMs.p95 ?? '-'} ms；失败 ${s.failures}/${s.attempts}；跨界 ${s.boundaryCensored}；较空闲增量 ${s.addedP50VsIdleMs?.toFixed(1) ?? '-'} ms`)),
        '', ...report.warnings, '', '分析时提供本目录 report.json、samples.jsonl 及存在的 path-evidence.jsonl。保留原始地址信息，请勿公开发布。'];
      await writeFile(join(directory, 'summary.txt'), '\ufeff' + lines.join('\r\n') + '\r\n');
      await writeFile(join(directory, 'summary.csv'), '\ufeffphase,round,load_mbps,observed_route,evidence_coverage,load_failures\n' +
        report.phases.map(p => `${p.name},${p.round},${p.loadMbps ?? ''},${p.path.route},${p.path.coverage},${p.failureCount}`).join('\n') + '\n');
    }
    process.off('SIGINT', stop); process.off('SIGTERM', stop);
  }
}

export async function runCli(args) {
  if (args.includes('--help') && args.every(a => ['--interactive', '--help'].includes(a))) { console.log(help); return; }
  const options = await suiteOptions(args);
  if (options.interactive) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      console.log('国内／国外常用网站：逐站时延、公开文件下载、负载下各站访问表现。不会改规则或节点。');
      console.log(`最多 ${(options.maxBytes / 1024 / 1024).toFixed(0)} MiB 负载流量；站点失败会跳过；路径无法观察时明确标为未验证。`);
      const answer = (await rl.question('填写本轮场景后回车开始；Ctrl+C 取消：')).trim();
      if (answer) { if (answer.length > 160 || /[\x00-\x1f\x7f]/.test(answer)) throw new Error('INVALID_ARGUMENT'); options.label = answer; }
    } finally { rl.close(); }
  }
  const result = await runSuite(options);
  console.log(`\n${result.report.status}\n结果：${result.directory}\n先看 summary.txt，分析时提供 report.json、samples.jsonl 和 path-evidence.jsonl（如有）。`);
  process.exitCode = result.report.status === 'cancelled' ? 130 : ['error', 'no-valid-throughput'].includes(result.report.status) ? 1 : 0;
}
