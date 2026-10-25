import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseOptions, createRunner, summarizePhase, runBenchmark } from '../scripts/network-benchmark.mjs';

async function fixture(t) {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname === '/stall') return;
    if (url.pathname === '/failed') { response.writeHead(503); response.end('SYNTHETIC_RESPONSE_SECRET'); return; }
    if (request.method === 'POST') {
      request.on('data', () => { request.pause(); setTimeout(() => request.resume(), 3); });
      request.on('end', () => { response.writeHead(200); response.end('ok'); });
      return;
    }
    const bytes = Number(url.searchParams.get('bytes') ?? 0);
    response.writeHead(200, { 'Content-Length': bytes });
    if (!bytes) { response.end(); return; }
    const chunk = Buffer.alloc(256 * 1024, 42);
    let remaining = bytes;
    const timer = setInterval(() => {
      if (response.writableNeedDrain) return;
      const size = Math.min(remaining, chunk.length);
      response.write(chunk.subarray(0, size));
      remaining -= size;
      if (!remaining) { clearInterval(timer); response.end(); }
    }, 10);
    response.on('close', () => clearInterval(timer));
  });
  await new Promise(resolveReady => server.listen(0, '127.0.0.1', resolveReady));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolveClosed => server.close(resolveClosed)); });
  return `http://127.0.0.1:${server.address().port}`;
}

test('safe defaults and endpoint validation prevent ambiguous or credential-bearing tests', () => {
  const defaults = parseOptions([]);
  assert.equal(defaults.parallel, 4);
  assert.equal(defaults.durationSeconds, 20);
  assert.ok(defaults.outputDir.startsWith(resolve('.local/reports')));
  for (const args of [['--duration-seconds', '0'], ['--parallel', '99'], ['--rounds', '2', '--rounds', '3'],
    ['--download-url', 'http://example.invalid/', '--allow-http'],
    ['--upload-url', 'https://user:SYNTHETIC_PASSWORD@example.invalid/'],
    ['--label', 'bad\nlabel'], ['--download-url', 'file:///tmp/test'], ['--unknown']]) {
    assert.throws(() => parseOptions(args));
  }
});

test('curl rejects HTTP errors, bounds stalls and ignores environment proxies without leaking bodies', async t => {
  const base = await fixture(t);
  const run = createRunner();
  const prior = process.env.http_proxy;
  process.env.http_proxy = 'http://127.0.0.1:1';
  try {
    const ok = await run(`${base}/down?bytes=65536`, { bytes: 65536, timeoutSeconds: 2 });
    assert.equal(ok.successful, true);
    assert.equal(ok.downloadedBytes, 65536);
    const failed = await run(`${base}/failed?token=SYNTHETIC_QUERY_SECRET`, { timeoutSeconds: 2 });
    assert.equal(failed.failure, 'HTTP_STATUS');
    assert.equal(failed.countedDownloadBytes, 0);
    assert.ok(!JSON.stringify(failed).includes('SYNTHETIC_'));
    const stalled = await run(`${base}/stall`, { timeoutSeconds: 0.1 });
    assert.equal(stalled.failure, 'TIMEOUT');
    assert.equal(stalled.deadlineTimeout, false);
    assert.ok(stalled.elapsedMs < 2000);
  } finally {
    if (prior === undefined) delete process.env.http_proxy; else process.env.http_proxy = prior;
  }
});

test('partial uploads and boundary probes cannot silently become receiver goodput or successful latency', () => {
  const transfer = { kind: 'transfer', successful: false, deadlineTimeout: true, countedDownloadBytes: 0,
    countedUploadBytes: 1000, acknowledgedUploadBytes: 0 };
  const summary = summarizePhase({ direction: 'upload', elapsedMs: 1000 }, [transfer,
    { kind: 'probe', successful: true, fullyWithinPhase: false, ttfbMs: 1 }]);
  assert.equal(summary.averageMbps, 0.008);
  assert.equal(summary.acknowledgedUploadBytes, 0);
  assert.equal(summary.latency.attempts, 0);
  assert.equal(summary.latency.httpsColdTtfbMs.p50, null);
  assert.equal(summary.latency.excludedBoundarySamples, 1);
  assert.ok(summary.warnings.includes('NO_COMPLETED_LOAD_REQUEST'));
  assert.ok(summary.warnings.includes('NO_VALID_LATENCY'));
});

test('one complete synthetic run overlaps probes with load, saves bounded results and removes payloads', { timeout: 55000 }, async t => {
  const base = await fixture(t);
  const parent = resolve('.local/experiments');
  await mkdir(parent, { recursive: true });
  const output = await mkdtemp(join(parent, 'network-benchmark-test-'));
  t.after(() => rm(output, { recursive: true, force: true }));
  const options = parseOptions(['--allow-http', '--download-url', `${base}/down?token=SYNTHETIC_QUERY_SECRET`,
    '--upload-url', `${base}/up`, '--latency-url', `${base}/probe`, '--duration-seconds', '5', '--idle-seconds', '5',
    '--output-dir', output]);
  const { directory, report } = await runBenchmark(options, { log: () => {}, captureNetwork: false });
  assert.ok(['completed', 'completed-with-warnings'].includes(report.status));
  assert.equal(report.phases.length, 5);
  assert.equal(report.preflight.length, 3);
  for (const phase of report.phases) {
    assert.ok(phase.elapsedMs >= 4900 && phase.elapsedMs < 8000);
    assert.ok(phase.latency.successes >= 3);
    if (phase.direction) assert.ok(phase.averageMbps > 0);
  }
  const files = await readdir(directory);
  assert.deepEqual(files.sort(), ['report.json', 'samples.jsonl', 'summary.csv', 'summary.txt']);
  const serialized = await readFile(join(directory, 'report.json'), 'utf8');
  assert.ok(!serialized.includes('SYNTHETIC_QUERY_SECRET'));
  assert.equal(JSON.parse(serialized).status, report.status);
  const records = (await readFile(join(directory, 'samples.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  for (const phase of report.phases.filter(row => row.direction)) {
    const samples = records.filter(row => row.phaseId === phase.id);
    assert.ok(samples.some(row => row.kind === 'probe' && row.atMs < phase.elapsedMs));
    const transfers = samples.filter(row => row.kind === 'transfer');
    const bytes = transfers.reduce((n, row) => n + (phase.direction === 'download' ? row.countedDownloadBytes : row.countedUploadBytes), 0);
    assert.equal(phase.averageMbps, Math.round(bytes * 8 / (phase.elapsedMs / 1000) / 1e6 * 1000) / 1000);
  }
});

test('preflight failure stops before load and cancellation preserves partial records without payloads', { timeout: 10000 }, async t => {
  const base = await fixture(t);
  const parent = resolve('.local/experiments');
  await mkdir(parent, { recursive: true });
  const output = await mkdtemp(join(parent, 'network-benchmark-stop-test-'));
  t.after(() => rm(output, { recursive: true, force: true }));
  const flags = ['--allow-http', '--download-url', `${base}/down`, '--upload-url', `${base}/up`,
    '--latency-url', `${base}/probe`, '--duration-seconds', '5', '--idle-seconds', '5', '--output-dir', output];
  const failedOptions = parseOptions(flags);
  failedOptions.uploadUrl = `${base}/failed`;
  const failed = await runBenchmark(failedOptions, { log: () => {}, captureNetwork: false });
  assert.equal(failed.report.status, 'preflight-failed');
  assert.equal(failed.report.phases.length, 0);
  assert.equal(failed.report.preflight.at(-1).httpStatus, 503);
  assert.ok(!(await readdir(failed.directory)).some(name => name.endsWith('.tmp')));
  let signalled = false;
  const stopped = await runBenchmark(parseOptions(flags), { captureNetwork: false, log: message => {
    if (message.startsWith('[1/')) {
      setTimeout(() => { signalled = true; process.emit('SIGINT'); }, 100);
    }
  } });
  assert.equal(signalled, true);
  assert.equal(stopped.report.status, 'cancelled');
  assert.equal(JSON.parse(await readFile(join(stopped.directory, 'report.json'), 'utf8')).status, 'cancelled');
  assert.ok(!(await readdir(stopped.directory)).some(name => name.endsWith('.tmp')));
  assert.ok((await readFile(join(stopped.directory, 'samples.jsonl'), 'utf8')).length > 0);
});
