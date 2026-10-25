import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import http from 'node:http';
import test from 'node:test';
import { promisify } from 'node:util';
import { measureBaseline, parseOptions } from '../scripts/measure-latency.mjs';

const execute = promisify(execFile);
async function fixture(t) {
  let connections = 0;
  const server = http.createServer((request, response) => {
    if (request.url.startsWith('/timeout')) return;
    if (request.url.startsWith('/reset')) { request.socket.destroy(); return; }
    response.writeHead(request.url.startsWith('/failed') ? 503 : 200);
    response.end('SYNTHETIC_RESPONSE_SECRET');
  });
  server.on('connection', () => connections++);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { url: `http://127.0.0.1:${server.address().port}`, connections: () => connections };
}
const options = (url, extra = []) => parseOptions(['--url', url, '--allow-http', '--samples', '3', '--warmup', '1', ...extra]);

test('cold and warmed reuse report distributions without inventing reused DNS/TCP/TLS measurements', async t => {
  const f = await fixture(t);
  const cold = await measureBaseline(options(f.url));
  assert.equal(f.connections(), 4);
  assert.deepEqual(cold.summary.connections, { cold: 3, reused: 0 });
  assert.equal(cold.summary.successRate, 1);
  assert.equal(cold.summary.timings.totalMs.count, 3);
  assert.ok(cold.summary.timings.totalMs.p50 <= cold.summary.timings.totalMs.p95);
  assert.ok(cold.results.every(result => result.tcpMs !== null && result.tlsMs === null && result.dnsMs === null));
  const reused = await measureBaseline(options(f.url, ['--mode', 'reuse']));
  assert.equal(f.connections(), 5);
  assert.deepEqual(reused.summary.connections, { cold: 0, reused: 3 });
  assert.equal(reused.summary.byConnection.reused.tcpMs.count, 0);
  assert.equal(reused.summary.byConnection.reused.tcpMs.p50, null);
  assert.ok(reused.results.every(result => result.reusedSocket && result.dnsMs === null && result.tcpMs === null && result.tlsMs === null));
  assert.ok(!JSON.stringify([cold, reused]).includes('SYNTHETIC_RESPONSE_SECRET'));
  const named = await measureBaseline(options(f.url.replace('127.0.0.1', 'localhost')));
  assert.ok(named.results.every(result => result.success && result.dnsMs !== null && result.totalMs >= result.ttfbMs));
});

test('bounded concurrency, HTTP failures and whole-request timeouts clean up sockets', async t => {
  const f = await fixture(t);
  const parallel = await measureBaseline(options(f.url, ['--concurrency', '2', '--mode', 'reuse']));
  assert.equal(parallel.results.length, 3);
  assert.ok(f.connections() <= 2);
  const failed = await measureBaseline(options(`${f.url}/failed?token=SYNTHETIC_QUERY_SECRET`));
  assert.equal(failed.summary.successRate, 0);
  assert.deepEqual(failed.summary.failuresByCode, { HTTP_STATUS: 3 });
  assert.equal(failed.summary.timings.totalMs.p99, null);
  const reset = await measureBaseline(options(`${f.url}/reset`));
  assert.deepEqual(reset.summary.failuresByCode, { REQUEST_FAILED: 3 });
  const timeout = await measureBaseline(options(`${f.url}/timeout`, ['--timeout-ms', '30']));
  assert.deepEqual(timeout.summary.failuresByCode, { TIMEOUT: 3 });
  assert.ok(timeout.results.every(result => result.totalMs >= 20 && result.ttfbMs === null));
  assert.ok(!JSON.stringify(failed).includes('SYNTHETIC_QUERY_SECRET'));
});

test('CLI rejects unsafe or ambiguous arguments and never prints URL or response secrets', async t => {
  for (const args of [[], ['--url', 'http://example.invalid/'], ['--url', 'https://user:secret@example.invalid/'],
    ['--url', 'https://example.invalid/', '--samples', '-1'], ['--url', 'https://example.invalid/', '--samples', '1', '--samples', '2'],
    ['--url', 'https://example.invalid/', '--concurrency', '33'], ['--url', 'https://example.invalid/', '--mode', 'invalid']]) {
    assert.throws(() => parseOptions(args), /^Error: INVALID_ARGUMENT$/);
  }
  const f = await fixture(t);
  const result = await execute(process.execPath, ['scripts/measure-latency.mjs', '--url', `${f.url}/?token=SYNTHETIC_QUERY_SECRET`,
    '--allow-http', '--warmup', '0', '--samples', '1']);
  assert.equal(JSON.parse(result.stdout).summary.successes, 1);
  assert.equal(result.stderr, '');
  for (const secret of [f.url, 'SYNTHETIC_QUERY_SECRET', 'SYNTHETIC_RESPONSE_SECRET']) assert.ok(!result.stdout.includes(secret));
  await assert.rejects(execute(process.execPath, ['scripts/measure-latency.mjs', '--url', 'https://user:SYNTHETIC_CREDENTIAL_SECRET@example.invalid/']),
    error => error.code === 2 && error.stderr.trim() === 'INVALID_ARGUMENT' && !error.stderr.includes('SYNTHETIC_CREDENTIAL_SECRET'));
});
