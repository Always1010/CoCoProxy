import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { request } from 'node:https';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createManagementEvidenceReport, probeManagementHttps, type ManagementEvidenceHost } from '../packages/setup/management-evidence.ts';
import { EVIDENCE_STATUSES } from '../packages/setup/check-result.ts';

const now = 2_000_000_000_000;
const deployment = JSON.parse(await readFile(new URL('../examples/automatic-gateway-deployment.json', import.meta.url), 'utf8'));
const offlineHost: ManagementEvidenceHost = { now: () => now, probeHttps: async () => { throw new Error('must not probe by default'); } };
const initial = await createManagementEvidenceReport(deployment, {}, offlineHost);
const evidence = () => ({ schemaVersion: 1, binding: initial.binding, terminalId: 'terminalA', recordedAt: now - 1, notifications: 'selected',
  https: { observedAt: now - 2, pageLoaded: true },
  login: { observedAt: now - 2, authenticated: true, logoutCompleted: true, anonymousApiDenied: true },
  certificate: { observedAt: now - 2, warningShown: false, exceptionUsed: false },
  browser: { observedAt: now - 2, secureContext: true, notificationApi: true, serviceWorker: true, pushManager: true,
    permission: 'granted', requiresInstalledApp: true, installedApp: true },
  notification: { observedAt: now - 2, testRequestedAt: now - 10, providerAccepted: true, displayedAt: now - 3, notDisplayed: false } });

test('management report is consumed as five independent checks and never probes or infers missing terminal evidence', async () => {
  assert.equal(initial.readOnly, true);
  assert.equal(initial.checks.length, 5);
  assert.deepEqual(initial.checks.map(check => check.status), Array(5).fill('not-run'));
  assert.ok(initial.checks.every(check => EVIDENCE_STATUSES.includes(check.status) && check.source === 'none' && check.observedAt === null));
  const report = await createManagementEvidenceReport(deployment, { evidence: evidence() }, offlineHost);
  assert.ok(report.checks.every(check => check.status === 'pass' && check.source === 'operator-record' && check.scope === 'terminal' && check.subject === 'terminalA'));
  const raw = evidence(); raw.certificate.exceptionUsed = true; raw.browser.permission = 'default';
  const failed = await createManagementEvidenceReport(deployment, { evidence: raw }, offlineHost);
  assert.deepEqual(failed.checks.map(check => check.status), ['pass', 'pass', 'fail', 'fail', 'pass']);
});

test('push accepted never proves display and not-applicable only records an explicit unused optional feature', async () => {
  const raw: any = evidence(); raw.notification.displayedAt = null;
  let report = await createManagementEvidenceReport(deployment, { evidence: raw }, offlineHost);
  assert.equal(report.checks[4].status, 'unknown');
  assert.equal(report.checks[4].code, 'SETUP_MANAGEMENT_DISPLAY_NOT_CONFIRMED');
  raw.notification.notDisplayed = true;
  report = await createManagementEvidenceReport(deployment, { evidence: raw }, offlineHost);
  assert.equal(report.checks[4].status, 'fail');
  delete raw.notification; delete raw.browser; raw.notifications = 'declined';
  report = await createManagementEvidenceReport(deployment, { evidence: raw }, offlineHost);
  assert.deepEqual(report.checks.slice(3).map(check => check.status), ['not-applicable', 'not-applicable']);
  assert.ok(report.checks.slice(3).every(check => check.source === 'operator-record' && check.observedAt === raw.recordedAt));
});

test('machine HTTPS and terminal observations retain their separate scope even when results disagree', async () => {
  const report = await createManagementEvidenceReport(deployment, { evidence: evidence(), probeHttps: true }, {
    now: () => now, probeHttps: async origin => { assert.equal(origin, deployment.management.origin); return 'SETUP_MANAGEMENT_HTTPS_FAILED'; },
  });
  const check = report.checks[0];
  assert.equal(check.status, 'fail'); assert.equal(check.scope, 'invoking-node'); assert.equal(check.source, 'node-https-probe');
  assert.equal(check.additionalObservations?.[0].status, 'pass'); assert.equal(check.additionalObservations?.[0].scope, 'terminal');
  assert.equal(report.checks[2].status, 'pass'); assert.equal(report.checks[2].source, 'operator-record');
  const machineOnly = await createManagementEvidenceReport(deployment, { probeHttps: true }, { now: () => now, probeHttps: async () => 'SETUP_MANAGEMENT_HTTPS_REACHABLE' });
  assert.deepEqual(machineOnly.checks.map(item => item.status), ['pass', 'not-run', 'not-run', 'not-run', 'not-run']);
});

test('observations are bound to origin and full deployment, with exact shapes, bounded aliases and consistent nonfuture times', async () => {
  const changed = structuredClone(evidence()); changed.binding = { ...changed.binding, configurationSha256: 'a'.repeat(64) };
  const stale = await createManagementEvidenceReport(deployment, { evidence: changed, probeHttps: true }, { now: () => now, probeHttps: async () => 'SETUP_MANAGEMENT_HTTPS_REACHABLE' });
  assert.equal(stale.checks[0].status, 'pass'); assert.equal(stale.checks[0].binding.configurationSha256, initial.binding.configurationSha256);
  assert.ok(stale.checks.slice(1).every(item => item.status === 'unknown' && item.binding.configurationSha256 === changed.binding.configurationSha256));
  for (const patch of [
    { ...evidence(), cookie: 'secret' }, { ...evidence(), status: 'pass' }, { ...evidence(), serviceActive: true },
    { ...evidence(), certificate: { observedAt: now - 2, sanMatches: true, keyMatches: true } },
    { ...evidence(), terminalId: 'real.host:port' }, { ...evidence(), recordedAt: now + 1 },
    { ...evidence(), browser: { ...evidence().browser, observedAt: now } },
    { ...evidence(), notification: { ...evidence().notification, notDisplayed: true } },
    { ...evidence(), notification: { ...evidence().notification, providerAccepted: false } },
    { ...evidence(), notification: { ...evidence().notification, displayedAt: now - 11 } },
    { ...evidence(), notifications: 'declined' },
  ]) await assert.rejects(createManagementEvidenceReport(deployment, { evidence: patch }, offlineHost));
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

test('existing setup CLI consumes private inputs without networking by default and rejects unsafe flags without echo', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cocoproxy-management-report-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = join(root, 'deployment.json'); await writeFile(input, JSON.stringify(deployment), { mode: 0o600 });
  const call = (...args: string[]) => spawnSync(process.execPath, ['--experimental-strip-types', 'apps/setup/main.ts', ...args],
    { cwd: new URL('..', import.meta.url), encoding: 'utf8', windowsHide: true });
  const result = call('management-report', '--input', input);
  assert.equal(result.status, 0, result.stderr); assert.equal(result.stderr, '');
  const report = JSON.parse(result.stdout); assert.deepEqual(report.checks.map((item: any) => item.status), Array(5).fill('not-run'));
  assert.equal(result.stdout.includes(deployment.management.origin), false);
  assert.equal(result.stdout.includes(deployment.management.deployment.controllerSecret), false);
  const observedAt = Date.now() - 1000, manual = evidence(); manual.recordedAt = observedAt;
  for (const value of [manual.https, manual.login, manual.certificate, manual.browser, manual.notification]) value.observedAt = observedAt;
  manual.notification.testRequestedAt = observedAt - 10; manual.notification.displayedAt = observedAt - 5;
  const observedPath = join(root, 'observations.json'); await writeFile(observedPath, JSON.stringify(manual), { mode: 0o600 });
  const consumed = call('management-report', '--input', input, '--evidence', observedPath);
  assert.equal(consumed.status, 0, consumed.stderr);
  assert.ok(JSON.parse(consumed.stdout).checks.every((item: any) => item.status === 'pass' && item.source === 'operator-record'));
  await writeFile(observedPath, JSON.stringify({ ...manual, cookie: 'private-secret' }));
  const invalidEvidence = call('management-report', '--input', input, '--evidence', observedPath);
  assert.equal(invalidEvidence.status, 1); assert.equal(invalidEvidence.stdout, '');
  assert.equal(invalidEvidence.stderr.trim(), 'SETUP_MANAGEMENT_EVIDENCE_INVALID');
  for (const args of [['management-report', '--input', input, '--apply'], ['doctor', '--probe-https'],
    ['management-report', '--input', input, '--probe-https', '--probe-https'], ['management-report', '--password', 'private-secret']]) {
    const rejected = call(...args); assert.equal(rejected.status, 1); assert.equal(rejected.stdout, ''); assert.equal(rejected.stderr.trim(), 'SETUP_ARGUMENTS_INVALID');
  }
});
