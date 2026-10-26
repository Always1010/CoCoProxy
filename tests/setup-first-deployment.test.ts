import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFirstDeploymentObservations, createFirstDeploymentReport, type FirstDeploymentHost } from '../packages/setup/first-deployment.ts';

const deployment = JSON.parse(await readFile(new URL('../examples/automatic-gateway-deployment.json', import.meta.url), 'utf8'));
const now = 2_000_000_000_000, generation = 'a'.repeat(64), administrator = 'b'.repeat(64);
const installed: any = { input: deployment, inputBytes: Buffer.from(JSON.stringify(deployment)), receiptBytes: Buffer.from('synthetic complete receipt'), receipt: {} };
function fixture(options: { installed?: boolean; credential?: string | null; active?: string | null; core?: boolean; enabled?: boolean; paused?: boolean;
  interrupted?: boolean; drift?: boolean; fault?: boolean; changed?: boolean; unavailable?: string; managementActive?: boolean; lifecycleClaim?: boolean } = {}) {
  const calls: string[] = [];
  const host: FirstDeploymentHost = {
    now: () => now,
    inspect: async () => { calls.push('inspect'); return options.installed === false ? { installed: false, readOnly: true, findings: [] } as any
      : { installed: true, receipt: { status: options.interrupted ? 'pending' : 'complete' }, lock: { present: options.interrupted ?? false }, lifecycleClaimPresent: options.lifecycleClaim } as any; },
    load: async () => { calls.push('load'); if (options.drift) throw new Error('private file path'); return installed; },
    credential: async () => { calls.push('credential'); if (options.unavailable === 'credential') throw new Error('secret'); return options.credential === undefined ? administrator : options.credential; },
    units: async () => { calls.push('units'); return { active: options.managementActive ?? true, enabled: options.enabled ?? true }; },
    runtime: async (_, command) => {
      calls.push(command); if (options.unavailable === command) throw new Error('private controller secret');
      const state = { active: options.active === undefined ? generation : options.active, desired: generation, transaction: null, fault: options.fault ? 'RESTORE_FAILED' : null };
      if (command === 'status') return state;
      if (command === 'runtime-lifecycle-status') return { lifecycle: { schemaVersion: 1, enabled: options.enabled ?? true, paused: options.paused ?? false } };
      return { ...state, core: state.active === null ? null : { ready: options.core ?? true, generation: state.active, checkedAt: new Date(now).toISOString(), reason: null } };
    },
    unchanged: async () => !options.changed,
  };
  return { host, calls };
}
const report = (host: FirstDeploymentHost, evidence?: unknown) => createFirstDeploymentReport(deployment, { inputPath: '/synthetic/deployment.json', evidence }, host);
const by = (result: Awaited<ReturnType<typeof report>>, id: string) => result.checks.find(check => check.id === id)!;
async function evidence() {
  const initial = await report(fixture().host);
  return { schemaVersion: 1, binding: initial.binding, recordedAt: now - 1,
    router: { scope: 'configured-lan', observedAt: now - 5, parametersMatched: true, deliveryEnabled: true, independentDisableVerified: true },
    terminal: { scope: 'managed-clients', terminalIds: ['terminalA', 'terminalB'], observedAt: now - 4, proxy: true, direct: true, dns: true, localAccess: true },
    management: { schemaVersion: 1, binding: initial.managementBinding, recordedAt: now - 2, terminalId: 'terminalA', notifications: 'declined',
      https: { observedAt: now - 5, pageLoaded: true },
      login: { observedAt: now - 5, authenticated: true, logoutCompleted: true, anonymousApiDenied: true },
      certificate: { observedAt: now - 5, warningShown: false, exceptionUsed: false } } };
}

test('first deployment reports each independent step, waits for manual evidence, and never treats persistence alone as completion', async () => {
  const { host, calls } = fixture(); const result = await report(host);
  assert.equal(result.readOnly, true); assert.equal(result.evidenceComplete, false);
  assert.equal(result.checks.length, 13); assert.equal(by(result, 'persistence').status, 'pass');
  assert.deepEqual(result.currentWait, { step: 'https-reachable', code: 'SETUP_MANAGEMENT_NOT_RUN', kind: 'operator' });
  assert.equal(result.next.step, 'https-reachable');
  for (const id of ['router', 'terminal', 'https-reachable', 'login', 'terminal-certificate-trust']) assert.equal(by(result, id).status, 'not-run');
  assert.ok(calls.includes('runtime-status') && calls.includes('runtime-lifecycle-status'));
  assert.equal(JSON.stringify(result).includes(deployment.management.origin), false);
  assert.equal(JSON.stringify(result).includes(deployment.management.deployment.controllerSecret), false);
});

test('complete bound operator records retain scope, times and five management results without claiming physical acceptance', async () => {
  const raw = await evidence(); const result = await report(fixture().host, raw);
  assert.equal(result.evidenceComplete, true); assert.equal(result.currentWait, null);
  assert.equal(result.next.step, 'external-acceptance'); assert.equal(by(result, 'router').source, 'operator-record');
  assert.equal(by(result, 'router').scope, 'configured-lan'); assert.equal(by(result, 'router').observedAt, now - 5);
  assert.deepEqual(by(result, 'terminal').subjects, ['terminalA', 'terminalB']);
  assert.equal(by(result, 'test-notification-displayed').status, 'not-applicable');
  assert.deepEqual(result.operatorRecord?.binding, raw.binding);
  // Older records remain explicitly historical; age alone does not invent a daily acceptance requirement.
  const older = structuredClone(raw); older.recordedAt -= 10 * 86400000;
  older.router.observedAt -= 10 * 86400000; older.terminal.observedAt -= 10 * 86400000;
  older.management.recordedAt -= 10 * 86400000;
  for (const value of [older.management.https, older.management.login, older.management.certificate]) value.observedAt -= 10 * 86400000;
  assert.equal((await report(fixture().host, older)).evidenceComplete, true);
});

test('missing installation, pending transaction and file drift have actionable different next steps while independent checks remain visible', async () => {
  const samples: [NonNullable<Parameters<typeof fixture>[0]>, string, string][] = [[{ installed: false }, 'SETUP_FIRST_INSTALL_REQUIRED', 'not-run'],
    [{ interrupted: true }, 'SETUP_FIRST_INSTALL_INTERRUPTED', 'unknown'], [{ lifecycleClaim: true }, 'SETUP_FIRST_INSTALL_INTERRUPTED', 'unknown'],
    [{ drift: true }, 'SETUP_FIRST_INSTALL_MISMATCH', 'fail']];
  for (const [options, code, status] of samples) {
    const { host, calls } = fixture(options); const result = await report(host);
    assert.equal(by(result, 'installation').code, code); assert.equal(by(result, 'installation').status, status);
    assert.equal(result.currentWait?.step, 'installation'); assert.ok(result.next.action.includes('inspect'));
    if (options.installed === false) assert.ok(result.next.action.includes('install'));
    if (options.interrupted) assert.ok(result.next.action.includes('recover'));
    assert.equal(calls.includes('runtime-status'), false); assert.equal(result.checks.length, 13);
  }
});

test('management evidence can pass before the first active candidate and points to configuration next', async () => {
  const { host } = fixture({ active: null, enabled: false }); const initial = await report(host);
  const raw = await evidence(); raw.binding = initial.binding;
  const result = await report(host, raw);
  for (const id of ['https-reachable', 'login', 'terminal-certificate-trust']) assert.equal(by(result, id).status, 'pass');
  assert.equal(result.next.step, 'configuration');
  assert.equal(by(result, 'router').status, 'unknown'); assert.equal(by(result, 'terminal').status, 'unknown');
  const applied = await report(fixture().host, raw);
  assert.equal(by(applied, 'login').code, 'SETUP_FIRST_EVIDENCE_BINDING_CHANGED');
});

test('administrator, current candidate, core and persistent intent are separate and failures do not suppress later observations', async () => {
  const first = await report(fixture({ credential: null, active: null, enabled: false }).host);
  assert.equal(by(first, 'administrator').code, 'SETUP_FIRST_ADMIN_REQUIRED');
  assert.equal(by(first, 'configuration').status, 'not-run'); assert.equal(by(first, 'core').status, 'not-run');
  assert.equal(by(first, 'persistence').status, 'not-run');
  const { host, calls } = fixture({ unavailable: 'runtime-status', paused: true }); const partial = await report(host);
  assert.equal(by(partial, 'configuration').status, 'pass'); assert.equal(by(partial, 'core').status, 'unknown');
  assert.equal(by(partial, 'persistence').status, 'not-run'); assert.ok(calls.includes('runtime-lifecycle-status'));
  const fault = await report(fixture({ fault: true, core: true }).host);
  assert.equal(by(fault, 'configuration').status, 'fail'); assert.notEqual(by(fault, 'core').status, 'pass');
  const enabled = await report(fixture({ managementActive: false }).host);
  assert.equal(enabled.next.step, 'management-service'); assert.ok(enabled.next.action.includes('pause-maintenance'));
  const paused = await report(fixture({ managementActive: false, paused: true }).host);
  assert.equal(paused.next.step, 'management-service'); assert.ok(paused.next.action.includes('start-management'));
  assert.equal(paused.next.action.includes('pause-maintenance'), false);
  const undecided = await evidence(); undecided.management.notifications = 'undecided';
  const optional = await report(fixture().host, undecided);
  assert.equal(optional.next.step, 'browser-notification-capability'); assert.ok(optional.next.action.includes('declined'));
});

test('any deployment, configuration, active candidate or administrator binding change requires manual revalidation', async () => {
  const original = await evidence();
  for (const key of ['deploymentSha256', 'configurationSha256', 'activeGeneration', 'administratorSha256'] as const) {
    const stale = structuredClone(original); stale.binding[key] = 'f'.repeat(64);
    const result = await report(fixture().host, stale);
    for (const id of ['router', 'terminal', 'login', 'test-notification-displayed']) {
      assert.equal(by(result, id).status, 'unknown'); assert.equal(by(result, id).code, 'SETUP_FIRST_EVIDENCE_BINDING_CHANGED');
    }
    assert.equal(by(result, 'core').status, 'pass'); assert.equal(result.evidenceComplete, false);
  }
  const changed = await report(fixture({ changed: true }).host, original);
  assert.equal(changed.completed.length, 0); assert.ok(changed.checks.every(check => check.code === 'SETUP_FIRST_SNAPSHOT_CHANGED'));
});

test('manual records reject arbitrary pass flags, secrets, wrong scopes, missing aliases and inconsistent timestamps', async () => {
  const raw = await evidence();
  for (const invalid of [{ ...raw, complete: true }, { ...raw, token: 'secret' }, { ...raw, router: false },
    { ...raw, recordedAt: now + 1 }, { ...raw, terminal: { ...raw.terminal, scope: 'all-networks' } },
    { ...raw, terminal: { ...raw.terminal, terminalIds: [] } }, { ...raw, terminal: { ...raw.terminal, terminalIds: ['real.host:123'] } },
    { ...raw, router: { ...raw.router, observedAt: now } },
    { ...raw, management: { ...raw.management, cookie: 'secret' } },
    { ...raw, management: { ...raw.management, recordedAt: now, https: { observedAt: now, pageLoaded: true } } }]) {
    await assert.rejects(report(fixture().host, invalid));
  }
});

test('status CLI consumes private input, returns fixed observation errors off Linux and rejects mutations or arbitrary probes', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cocoproxy-first-status-')); t.after(() => rm(root, { recursive: true, force: true }));
  const inputPath = join(root, 'deployment.json'); await writeFile(inputPath, JSON.stringify(deployment), { mode: 0o600 });
  const call = (...args: string[]) => spawnSync(process.execPath, ['--experimental-strip-types', 'apps/setup/main.ts', ...args],
    { cwd: new URL('..', import.meta.url), encoding: 'utf8', windowsHide: true });
  if (process.platform !== 'linux') {
    const result = call('status', '--input', inputPath); assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout); assert.equal(parsed.next.step, 'installation');
    assert.equal(parsed.checks[0].code, 'SETUP_FIRST_INSTALL_OBSERVATION_UNAVAILABLE');
    assert.equal(result.stdout.includes(deployment.management.origin), false);
    assert.equal(result.stdout.includes(deployment.management.deployment.controllerSecret), false);
  }
  for (const args of [['--apply'], ['--probe-https'], ['--terminal-path-verified'], ['--password', 'secret'], ['--action', 'initialize']]) {
    const result = call('status', '--input', inputPath, ...args);
    assert.equal(result.status, 1); assert.equal(result.stdout, ''); assert.equal(result.stderr.trim(), 'SETUP_ARGUMENTS_INVALID');
  }
});

test('recording facts derives current internal bindings and timestamps, preserves failures, and leaves omitted observations unverified', async () => {
  const observedAt = new Date(now - 1000).toISOString();
  const facts = { schemaVersion: 1, observedAt, management: { terminalId: 'terminalA', notifications: 'declined', https: { pageLoaded: false } },
    router: { parametersMatched: true, deliveryEnabled: false, independentDisableVerified: true },
    terminal: { terminalIds: ['terminalA'], proxy: false, direct: true, dns: true, localAccess: true } };
  const generated = await createFirstDeploymentObservations(deployment, { inputPath: '/synthetic/deployment.json', facts }, fixture().host);
  const consumed = await report(fixture().host, generated);
  assert.deepEqual(generated.binding, consumed.binding); assert.equal(generated.recordedAt, now);
  assert.equal(generated.router?.observedAt, now - 1000); assert.equal(generated.router?.scope, 'configured-lan');
  assert.equal(by(consumed, 'https-reachable').status, 'fail'); assert.equal(by(consumed, 'router').status, 'fail');
  assert.equal(by(consumed, 'terminal').status, 'fail'); assert.equal(by(consumed, 'login').status, 'not-run');
  assert.equal(by(consumed, 'test-notification-displayed').status, 'not-applicable');
  const blank = await createFirstDeploymentObservations(deployment, { inputPath: '/synthetic/deployment.json', facts: { schemaVersion: 1 } }, fixture().host);
  assert.equal(Object.hasOwn(blank, 'management'), false); assert.equal(Object.hasOwn(blank, 'router'), false);
  assert.equal(by(await report(fixture().host, blank), 'login').status, 'not-run');
  const first = await createFirstDeploymentObservations(deployment, { inputPath: '/synthetic/deployment.json', facts: {
    schemaVersion: 1, observedAt, management: { terminalId: 'terminalA', notifications: 'undecided', https: { pageLoaded: true } } } }, fixture({ active: null }).host);
  assert.equal(first.binding.activeGeneration, null);
  assert.equal(by(await report(fixture({ active: null }).host, first), 'https-reachable').status, 'pass');
});

test('recording preserves actual notification event times independently of recording and accepts explicit timezone offsets', async () => {
  const facts = { schemaVersion: 1, observedAt: new Date(now - 1000).toISOString(), management: { terminalId: 'terminalA', notifications: 'selected',
    notification: { testRequestedAt: new Date(now - 4000).toISOString(), providerAccepted: true,
      displayedAt: new Date(now - 2000).toISOString(), notDisplayed: false } } };
  const generated = await createFirstDeploymentObservations(deployment, { inputPath: '/synthetic/deployment.json', facts }, fixture().host);
  const notification = (generated.management as any).notification;
  assert.equal(notification.testRequestedAt, now - 4000); assert.equal(notification.displayedAt, now - 2000);
  assert.equal(notification.observedAt, now - 1000); assert.equal(generated.recordedAt, now);
  const zoned = { schemaVersion: 1, observedAt: '2033-05-18T11:33:19+08:00', router: { parametersMatched: true, deliveryEnabled: true, independentDisableVerified: true } };
  const timezone = await createFirstDeploymentObservations(deployment, { inputPath: '/synthetic/deployment.json', facts: zoned }, fixture().host);
  assert.equal(timezone.router?.observedAt, Date.parse(zoned.observedAt));
  const pending: any = structuredClone(facts); pending.management.notification.displayedAt = null;
  const waiting = await createFirstDeploymentObservations(deployment, { inputPath: '/synthetic/deployment.json', facts: pending }, fixture().host);
  assert.equal(by(await report(fixture().host, waiting), 'test-notification-displayed').status, 'unknown');
});

test('recording rejects prior envelopes, internal metadata, guessed times, impossible events, unverified deployment and concurrent rebinding', async () => {
  const raw = await evidence();
  const base = { schemaVersion: 1, observedAt: new Date(now - 1000).toISOString(), router: { parametersMatched: true, deliveryEnabled: true, independentDisableVerified: true } };
  for (const facts of [raw, { ...base, binding: raw.binding }, { ...base, recordedAt: now }, { ...base, status: 'pass' },
    { ...base, observedAt: now }, { ...base, observedAt: '2033-02-31T00:00:00Z' }, { ...base, observedAt: '2033-05-18T03:33:19' },
    { ...base, observedAt: new Date(now + 1).toISOString() }, { ...base, observedAt: undefined },
    { ...base, router: { ...base.router, observedAt: now - 1000 } },
    { ...base, management: { terminalId: 'terminalA', notifications: 'selected', notification: {
      testRequestedAt: new Date(now - 1000).toISOString(), providerAccepted: true, displayedAt: new Date(now - 2000).toISOString(), notDisplayed: false } } }]) {
    await assert.rejects(createFirstDeploymentObservations(deployment, { inputPath: '/synthetic/deployment.json', facts }, fixture().host));
  }
  await assert.rejects(createFirstDeploymentObservations(deployment, { inputPath: '/synthetic/deployment.json', facts: base }, fixture({ installed: false }).host),
    { code: 'SETUP_FIRST_RECORD_DEPLOYMENT_UNVERIFIED' });
  await assert.rejects(createFirstDeploymentObservations(deployment, { inputPath: '/synthetic/deployment.json', facts: base }, fixture({ credential: null }).host),
    { code: 'SETUP_FIRST_RECORD_DEPLOYMENT_UNVERIFIED' });
  const { host } = fixture(); let reads = 0; const stable = host.credential;
  host.credential = async installed => ++reads === 1 ? stable(installed) : 'f'.repeat(64);
  await assert.rejects(createFirstDeploymentObservations(deployment, { inputPath: '/synthetic/deployment.json', facts: base }, host),
    { code: 'SETUP_FIRST_RECORD_BINDING_CHANGED' });
});

test('recording CLI refuses unverified hosts and mutating flags without creating an evidence file or echoing facts', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cocoproxy-record-observations-')); t.after(() => rm(root, { recursive: true, force: true }));
  const input = join(root, 'deployment.json'), facts = join(root, 'facts.json'), output = join(root, 'observations.json');
  await writeFile(input, JSON.stringify(deployment), { mode: 0o600 }); await writeFile(facts, JSON.stringify({ schemaVersion: 1 }), { mode: 0o600 });
  const call = (...args: string[]) => spawnSync(process.execPath, ['--experimental-strip-types', 'apps/setup/main.ts', 'record-observations',
    '--input', input, '--facts', facts, '--output', output, ...args], { cwd: new URL('..', import.meta.url), encoding: 'utf8', windowsHide: true });
  if (process.platform !== 'linux') {
    const result = call(); assert.equal(result.status, 1); assert.equal(result.stdout, '');
    assert.equal(result.stderr.trim(), 'SETUP_FIRST_RECORD_DEPLOYMENT_UNVERIFIED');
    await assert.rejects(readFile(output), { code: 'ENOENT' });
  }
  for (const flag of ['--apply', '--probe-https', '--terminal-path-verified']) {
    const result = call(flag); assert.equal(result.status, 1); assert.equal(result.stdout, ''); assert.equal(result.stderr.trim(), 'SETUP_ARGUMENTS_INVALID');
  }
  await writeFile(output, 'preserve existing private evidence', { mode: 0o600 });
  const existing = call(); assert.equal(existing.status, 1); assert.equal(existing.stdout, ''); assert.equal(existing.stderr.trim(), 'SETUP_OUTPUT_EXISTS');
  assert.equal(await readFile(output, 'utf8'), 'preserve existing private evidence');
});
