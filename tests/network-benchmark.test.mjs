import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, rm, appendFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createRunner } from '../scripts/network-benchmark.mjs';
import { defaultTargets, validateConfig, runSuite, summarizeSiteProbes, routeSummary } from '../scripts/network-benchmark-suite.mjs';

async function outputDirectory(t) {
  const parent = resolve('.local/experiments');
  await mkdir(parent, { recursive: true });
  const path = await mkdtemp(join(parent, 'network-benchmark-test-'));
  t.after(async () => {
    assert.ok(resolve(path).startsWith(parent + sep));
    await rm(path, { recursive: true, force: true });
  });
  return path;
}

async function fixture(t, onRequest = () => {}) {
  const server = http.createServer((request, response) => {
    onRequest();
    if (request.url.startsWith('/stall')) return;
    if (request.url.startsWith('/failed')) { response.writeHead(503); response.end('SYNTHETIC_SECRET'); return; }
    if (request.url.startsWith('/html')) { response.writeHead(200, { 'Content-Type': 'text/html' }); response.end('not data'); return; }
    if (request.method === 'POST') { request.resume(); request.on('end', () => response.end('ok')); return; }
    if (request.url.startsWith('/probe')) { response.writeHead(204); response.end(); return; }
    const range = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range ?? '');
    const bytes = range ? Number(range[2]) - Number(range[1]) + 1 : Number(new URL(request.url, 'http://localhost').searchParams.get('bytes') ?? 0);
    response.writeHead(range ? 206 : 200, { 'Content-Type': 'application/octet-stream', 'Content-Length': bytes,
      ...(range ? { 'Content-Range': `bytes ${range[1]}-${range[2]}/8388608` } : {}) });
    let left = bytes;
    if (!left) { response.end(); return; }
    const buffer = Buffer.alloc(65536, 42);
    const timer = setInterval(() => {
      if (response.writableNeedDrain) return;
      const size = Math.min(left, buffer.length);
      response.write(buffer.subarray(0, size)); left -= size;
      if (!left) { clearInterval(timer); response.end(); }
    }, 8);
    response.on('close', () => clearInterval(timer));
  });
  await new Promise(resolveReady => server.listen(0, '127.0.0.1', resolveReady));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolveClosed => server.close(resolveClosed)); });
  return `http://127.0.0.1:${server.address().port}`;
}

test('multi-site config never equates geography to routing or permits credential-bearing endpoints', () => {
  const config = validateConfig({ schemaVersion: 1, targets: defaultTargets });
  assert.ok(config.targets.filter(t => t.region === 'domestic').length >= 3);
  assert.ok(config.targets.filter(t => t.region === 'overseas').length >= 3);
  for (const bad of [[], [{ id: 'bad', name: 'bad', region: 'domestic', probeUrl: 'https://user:SECRET@example.invalid/' }],
    [{ id: 'bad', name: 'bad', region: 'domestic', probeUrl: 'http://example.invalid/' }], [defaultTargets[0], defaultTargets[0]]]) {
    assert.throws(() => validateConfig({ schemaVersion: 1, targets: bad }, true));
  }
  assert.equal(routeSummary([{ region: 'domestic', countedDownloadBytes: 100 }]).route, 'unknown');
  const partial = routeSummary([{ countedDownloadBytes: 100, known: true }, { countedDownloadBytes: 200 }],
    r => r.known ? { status: 'verified', route: 'direct', fingerprint: 'stable' } : { status: 'unverified', route: 'unknown' });
  assert.equal(partial.route, 'partial-direct');
  assert.equal(partial.downloadBytes.direct, 100);
  assert.equal(partial.downloadBytes.unknown, 200);
});

test('HTTP errors, false binary bodies, wrong lengths and zero-progress deadline failures are excluded', async t => {
  const base = await fixture(t), run = createRunner();
  const failed = await run(`${base}/failed?token=SYNTHETIC_QUERY_SECRET`, { timeoutSeconds: 1 });
  assert.equal(failed.countedDownloadBytes, 0);
  assert.ok(!JSON.stringify(failed).includes('SYNTHETIC_'));
  const html = await run(`${base}/html`, { binary: true });
  assert.equal(html.failure, 'CONTENT_TYPE');
  assert.equal(html.countedDownloadBytes, 0);
  const wrongLength = await run(`${base}/data?bytes=64`, { bytes: 128 });
  assert.equal(wrongLength.successful, false);
  assert.equal(wrongLength.countedDownloadBytes, 0);
  const timeout = await run(`${base}/stall`, { timeoutSeconds: 0.1, phaseDeadline: performance.now() + 100 });
  assert.equal(timeout.failure, 'TIMEOUT');
  assert.equal(timeout.deadlineTimeout, false);
  const partial = await run(`${base}/data`, { range: { start: 0, end: 8388607 }, bytes: 8388608,
    binary: true, expectedStatus: 206, timeoutSeconds: 0.15, phaseDeadline: performance.now() + 150 });
  assert.equal(partial.deadlineTimeout, true);
  assert.ok(partial.countedDownloadBytes > 0);
  assert.ok(partial.localPort > 0 && partial.remotePort > 0 && partial.endedAtMs >= partial.startedAtMs);
});

test('slow boundary probes remain in attempts and failures instead of vanishing from the denominator', () => {
  const stats = summarizeSiteProbes([
    { kind: 'probe', targetId: 'site', successful: true, endedAtMs: 90, ttfbMs: 10, totalMs: 20 },
    { kind: 'probe', targetId: 'site', successful: false, endedAtMs: 110, failureStage: 'tcp' },
    { kind: 'probe', targetId: 'site', successful: true, endedAtMs: 120, ttfbMs: 80, totalMs: 90 },
  ], { endedAtMs: 100 }).site;
  assert.equal(stats.attempts, 3);
  assert.equal(stats.failures, 1);
  assert.equal(stats.boundaryCensored, 1);
  assert.equal(stats.successRate, 1 / 3);
  assert.equal(stats.coldTtfbMs.p50, 10);
});

test('a failed first site and unsupported upload do not stop other downloads, probes or DIRECT aggregate', { timeout: 30000 }, async t => {
  const base = await fixture(t), outputDir = await outputDirectory(t);
  const target = (id, url) => ({ id, name: id, region: 'domestic', probeUrl: `${base}/probe`, download: { mode: 'range', url } });
  const targets = [target('first-fails', `${base}/failed`), target('first-good', `${base}/data`),
    { ...target('second-good', `${base}/data`), uploadUrl: `${base}/failed` },
    { id: 'overseas-probe', name: 'probe', region: 'overseas', probeUrl: `${base}/probe` }];
  let stopped = false;
  const observer = { available: true, events: [], stop: async () => { stopped = true; },
    classify: () => ({ status: 'verified', route: 'direct', fingerprint: 'synthetic' }) };
  const { directory, report } = await runSuite({ targets, observer: {}, outputDir, label: 'synthetic', rounds: 1,
    idleSeconds: 0.5, durationSeconds: 0.6, parallel: 2, maxBytes: 64 * 1024 * 1024 },
  { captureNetwork: false, observerFactory: async () => observer, log: () => {} });
  assert.equal(stopped, true);
  assert.equal(report.status, 'completed-with-limitations');
  assert.equal(report.capabilities['first-fails'].download.status, 'failed');
  assert.equal(report.capabilities['second-good'].upload.status, 'failed');
  assert.ok(report.phases.some(p => p.name === 'first-good-download-single' && p.loadMbps > 0));
  assert.ok(report.phases.some(p => p.name === 'second-good-download-single' && p.loadMbps > 0));
  assert.ok(report.phases.some(p => p.name === 'direct-candidates-multi-site' && p.loadMbps > 0));
  const parallel = report.phases.find(p => p.name === 'first-good-download-parallel');
  assert.equal(parallel.startedWorkers, 2);
  const aggregate = report.phases.find(p => p.name === 'direct-candidates-multi-site');
  assert.equal(aggregate.targetIdsUsed.length, 2);
  assert.ok(aggregate.verifiedDirectMbps > 0);
  assert.ok(report.loadBytes <= 64 * 1024 * 1024);
  assert.ok(report.phases.every(p => p.probes['overseas-probe']?.attempts >= 1));
  const rows = (await readFile(join(directory, 'samples.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(rows.some(r => r.kind === 'probe' && r.underLoadAtStart));
  assert.ok(!(await readdir(directory)).some(name => name.endsWith('.tmp')));
  assert.equal(JSON.parse(await readFile(join(directory, 'report.json'), 'utf8')).status, report.status);
});

test('a sample write failure stops and settles all schedulers before final output', { timeout: 8000 }, async t => {
  let calls = 0;
  const base = await fixture(t, () => calls++), outputDir = await outputDirectory(t);
  const { report } = await runSuite({ targets: [{ id: 'site', name: 'site', region: 'custom',
    probeUrl: `${base}/probe`, download: { mode: 'range', url: `${base}/data` } }], outputDir,
    label: 'io-failure', idleSeconds: 0.2, durationSeconds: 5, parallel: 2, rounds: 1, maxBytes: 16 * 1024 * 1024 },
  { captureNetwork: false, log: () => {}, appendSample: async (path, text) => {
    const row = JSON.parse(text);
    if (row.phaseId === 2 && row.kind === 'probe') throw new Error('SYNTHETIC_WRITE_FAILURE');
    await appendFile(path, text);
  } });
  assert.equal(report.status, 'error');
  const atCompletion = calls;
  await new Promise(resolveDone => setTimeout(resolveDone, 300));
  assert.equal(calls, atCompletion);
});

test('cancellation during preflight preserves results and leaves no load process', { timeout: 5000 }, async t => {
  const base = await fixture(t), outputDir = await outputDirectory(t);
  let signalled = false;
  const { report, directory } = await runSuite({ targets: [{ id: 'stall', name: 'stall', region: 'custom',
    probeUrl: `${base}/probe`, download: { mode: 'range', url: `${base}/stall` } }], outputDir,
    label: 'cancel', idleSeconds: 5, durationSeconds: 5, parallel: 2, rounds: 1, maxBytes: 16 * 1024 * 1024 },
  { captureNetwork: false, log: text => { if (text.startsWith('逐站检查')) setTimeout(() => { signalled = true; process.emit('SIGINT'); }, 100); } });
  assert.equal(signalled, true);
  assert.equal(report.status, 'cancelled');
  assert.equal(report.phases.length, 0);
  assert.equal(JSON.parse(await readFile(join(directory, 'report.json'), 'utf8')).status, 'cancelled');
});
