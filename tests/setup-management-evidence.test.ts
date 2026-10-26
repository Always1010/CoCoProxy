import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { request } from 'node:https';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createManagementHttpsReport, probeManagementHttps, type ManagementHttpsHost } from '../packages/setup/management-evidence.ts';

const now = 2_000_000_000_000;
const deployment = JSON.parse(await readFile(new URL('../examples/automatic-gateway-deployment.json', import.meta.url), 'utf8'));
const offlineHost: ManagementHttpsHost = { now: () => now, probeHttps: async () => { throw new Error('must not probe by default'); } };

test('management report only probes HTTPS when explicitly requested and never claims browser acceptance', async () => {
  const offline = await createManagementHttpsReport(deployment, {}, offlineHost);
  assert.equal(offline.readOnly, true);
  assert.equal(offline.checks.length, 1);
  assert.equal(offline.checks[0].status, 'not-run');
  assert.equal(offline.checks[0].source, 'none');
  const machine = await createManagementHttpsReport(deployment, { probeHttps: true }, {
    now: () => now, probeHttps: async origin => { assert.equal(origin, deployment.management.origin); return 'SETUP_MANAGEMENT_HTTPS_REACHABLE'; },
  });
  assert.equal(machine.checks[0].status, 'pass');
  assert.equal(machine.checks[0].scope, 'invoking-node');
  assert.equal(machine.checks[0].source, 'node-https-probe');
  assert.equal(Object.hasOwn(machine, 'binding'), false);
  const failed = await createManagementHttpsReport(deployment, { probeHttps: true }, offlineHost);
  assert.equal(failed.checks[0].code, 'SETUP_MANAGEMENT_HTTPS_FAILED');
});

test('native HTTPS probe fixes method/path/TLS and rejects redirects, oversized or unrelated responses without exposing bytes', async () => {
  let calls = 0, status = 200, body = JSON.stringify({ responding: true, scope: 'management_only' });
  const transport = ((url: URL, options: any, callback: (response: any) => void) => {
    calls++; assert.equal(url.href, 'https://gateway.example:13443/api/cocoproxy/health');
    assert.equal(options.method, 'GET'); assert.equal(options.rejectUnauthorized, true); assert.equal(options.agent, false);
    assert.deepEqual(options.headers, { accept: 'application/json' });
    const response: any = new EventEmitter(); response.statusCode = status; response.destroy = () => {};
    const outgoing: any = new EventEmitter(); outgoing.destroy = () => {};
    outgoing.end = () => queueMicrotask(() => { callback(response); response.emit('data', Buffer.from(body)); response.emit('end'); });
    return outgoing;
  }) as unknown as typeof request;
  assert.equal(await probeManagementHttps('https://gateway.example:13443', transport), 'SETUP_MANAGEMENT_HTTPS_REACHABLE');
  status = 302;
  assert.equal(await probeManagementHttps('https://gateway.example:13443', transport), 'SETUP_MANAGEMENT_HTTPS_RESPONSE_INVALID');
  status = 200; body = 'private-response'.repeat(200);
  assert.equal(await probeManagementHttps('https://gateway.example:13443', transport), 'SETUP_MANAGEMENT_HTTPS_RESPONSE_INVALID');
  body = JSON.stringify({ responding: true, scope: 'wrong' });
  assert.equal(await probeManagementHttps('https://gateway.example:13443', transport), 'SETUP_MANAGEMENT_HTTPS_RESPONSE_INVALID');
  assert.equal(await probeManagementHttps('http://127.0.0.1:13000', transport), 'SETUP_MANAGEMENT_HTTPS_REQUIRED');
  assert.equal(calls, 4);
});

test('native HTTPS probe clears synchronous transport failures and bounds even a silent request', async () => {
  let expiry: () => void = () => {}, cleared = 0, destroyed = 0;
  const timers = {
    setTimeout: ((callback: () => void, delay: number) => { assert.equal(delay, 5000); expiry = callback; return {} as any; }) as typeof setTimeout,
    clearTimeout: (() => { cleared++; }) as typeof clearTimeout,
  };
  const throwing = (() => { throw new Error('private TLS diagnostic'); }) as unknown as typeof request;
  assert.equal(await probeManagementHttps('https://gateway.example:13443', throwing, timers), 'SETUP_MANAGEMENT_HTTPS_FAILED');
  assert.equal(cleared, 1);
  expiry(); // A queued timer callback after cleanup must not reference an uninitialized request.
  const silent = (() => {
    const outgoing: any = new EventEmitter(); outgoing.end = () => {}; outgoing.destroy = () => { destroyed++; }; return outgoing;
  }) as unknown as typeof request;
  const pending = probeManagementHttps('https://gateway.example:13443', silent, timers);
  expiry();
  assert.equal(await pending, 'SETUP_MANAGEMENT_HTTPS_TIMEOUT'); assert.equal(cleared, 2); assert.equal(destroyed, 1);
});

test('setup CLI keeps the private HTTPS check and rejects removed evidence and mutation flags', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cocoproxy-management-report-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = join(root, 'deployment.json'); await writeFile(input, JSON.stringify(deployment), { mode: 0o600 });
  const call = (...args: string[]) => spawnSync(process.execPath, ['--experimental-strip-types', 'apps/setup/main.ts', ...args],
    { cwd: new URL('..', import.meta.url), encoding: 'utf8', windowsHide: true });
  const result = call('management-report', '--input', input);
  assert.equal(result.status, 0, result.stderr); assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout).checks.map((item: any) => item.status), ['not-run']);
  assert.equal(result.stdout.includes(deployment.management.origin), false);
  assert.equal(result.stdout.includes(deployment.management.deployment.controllerSecret), false);
  for (const args of [['management-report', '--input', input, '--evidence', input],
    ['management-report', '--input', input, '--apply'], ['doctor', '--probe-https'],
    ['management-report', '--input', input, '--probe-https', '--probe-https'], ['management-report', '--password', 'private-secret']]) {
    const rejected = call(...args); assert.equal(rejected.status, 1); assert.equal(rejected.stdout, '');
    assert.equal(rejected.stderr.trim(), 'SETUP_ARGUMENTS_INVALID');
  }
});
