import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { UpdateEngine, initialUpdateState, type UpdaterHost, type UpdateState } from '../packages/updater/engine.ts';
import { DEFAULT_UPDATE_SETTINGS, parseUpdateSettings, updateWindow, nextUpdateWindow } from '../packages/updater/policy.ts';
import { UpdateReleaseError, type VerifiedUpdate } from '../packages/updater/release.ts';

const settings = { ...DEFAULT_UPDATE_SETTINGS, enabled: true, timeZone: 'UTC' };
const candidate: VerifiedUpdate = { version: '1.1.0', tag: 'v1.1.0', commit: 'b'.repeat(40), platform: 'linux-arm64',
  manifestSha256: 'c'.repeat(64), asset: { name: 'fixture.tar.gz', url: 'https://github.com/Always1010/CoCoProxy/releases/download/v1.1.0/fixture.tar.gz', size: 1, sha256: 'd'.repeat(64) }, automatic: true };
function deferred() { let resolve!: () => void; const promise = new Promise<void>(accept => { resolve = accept; }); return { promise, resolve }; }
function harness(overrides: Partial<UpdaterHost> = {}, input?: UpdateState) {
  let now = Date.parse('2026-11-07T03:10:00Z'), saved = initialUpdateState();
  const calls = { find: 0, download: 0, prepare: 0, apply: 0, cleanup: 0 };
  const original = { version: '1.0.2', manifestSha256: 'a'.repeat(64) };
  const host: UpdaterHost = { now: () => now, jitter: () => 0, save: async state => { saved = structuredClone(state); },
    installed: async () => ({ ...original }), configured: async () => true,
    find: async () => { calls.find++; return candidate; }, download: async () => { calls.download++; return '/synthetic/payload'; },
    prepare: async () => { calls.prepare++; }, apply: async () => { calls.apply++; return 'updated'; },
    cleanup: async () => { calls.cleanup++; }, ...overrides };
  const state = input ?? { ...initialUpdateState(), settings: { ...settings } };
  const engine = new UpdateEngine(host, state);
  return { engine, host, calls, original, advance: (value: string) => { now = Date.parse(value); }, snapshot: () => structuredClone(saved) };
}

test('policy validates integer day limits and resolves overnight and DST windows by local wall time', () => {
  for (const intervalDays of [1, 365]) assert.equal(parseUpdateSettings({ ...settings, intervalDays }).intervalDays, intervalDays);
  for (const intervalDays of [0, 366, 1.5, '7', NaN]) assert.throws(() => parseUpdateSettings({ ...settings, intervalDays }));
  for (const change of [{ windowStart: '25:00' }, { windowEnd: '03:00' }, { timeZone: 'Invalid/Fixture' }]) assert.throws(() => parseUpdateSettings({ ...settings, ...change }));
  const overnight = { ...settings, windowStart: '23:00', windowEnd: '02:00' };
  const current = nextUpdateWindow(Date.parse('2026-11-08T01:00:00Z'), '2026-11-07', overnight);
  assert.equal(current.date, '2026-11-07'); assert.equal(current.end, Date.parse('2026-11-08T02:00:00Z'));
  const spring = updateWindow('2026-03-08', { ...settings, timeZone: 'America/New_York', windowStart: '02:30', windowEnd: '04:00' });
  assert.equal(spring.start, Date.parse('2026-03-08T07:00:00Z')); assert.equal(spring.end, Date.parse('2026-03-08T08:00:00Z'));
  const fall = updateWindow('2026-11-01', { ...settings, timeZone: 'America/New_York', windowStart: '01:15', windowEnd: '01:45' });
  assert.equal(fall.start, Date.parse('2026-11-01T05:15:00Z')); assert.equal(fall.end, Date.parse('2026-11-01T06:45:00Z'));
});

test('manual checks never install and completed automatic schedule survives reboot without duplicate checks', async () => {
  const manual = harness(); await manual.engine.initialize();
  await manual.engine.handle({ action: 'check' }); await manual.engine.idle();
  assert.equal((await manual.engine.view()).lastResult, 'update-available'); assert.equal(manual.calls.download, 0); assert.equal(manual.calls.apply, 0);
  const automatic = harness({ find: async () => null }); await automatic.engine.initialize();
  await automatic.engine.tick(); await automatic.engine.idle();
  const saved = automatic.snapshot(); assert.equal(saved.dueDate, '2026-11-14');
  const rebooted = harness({}, saved); rebooted.advance('2026-11-08T03:10:00Z');
  await rebooted.engine.initialize(); await rebooted.engine.tick(); await rebooted.engine.idle();
  assert.equal(rebooted.calls.find, 0); assert.equal((await rebooted.engine.view()).nextCheckAt, Date.parse('2026-11-14T03:00:00Z'));
});

test('disabling automation cancels preparation before maintenance, but lets installation finish', async () => {
  for (const boundary of ['prepare', 'apply'] as const) {
    const entered = deferred(), resume = deferred(); let seenSignal: AbortSignal | undefined;
    const h = harness(boundary === 'prepare' ? { prepare: async (_payload, _update, _original, signal) => {
      seenSignal = signal; entered.resolve(); await resume.promise;
    } } : { apply: async () => { entered.resolve(); await resume.promise; return 'updated'; } });
    await h.engine.initialize(); await h.engine.tick(); await entered.promise;
    assert.equal(h.engine.installing, boundary === 'apply');
    await h.engine.handle({ action: 'configure', expectedRevision: 0, settings: { ...settings, enabled: false } });
    if (seenSignal) assert.equal(seenSignal.aborted, true);
    resume.resolve(); await h.engine.idle();
    assert.equal((await h.engine.view()).lastResult, boundary === 'prepare' ? 'cancelled' : 'updated');
    if (boundary === 'prepare') assert.equal(h.calls.apply, 0);
    assert.equal(h.calls.cleanup, 1);
  }
});

test('installed manifest changes during preparation prevent apply', async () => {
  let changed = false;
  const h = harness({ installed: async () => ({ version: '1.0.2', manifestSha256: (changed ? 'e' : 'a').repeat(64) }),
    prepare: async () => { changed = true; } });
  await h.engine.initialize(); await h.engine.tick(); await h.engine.idle();
  assert.equal(h.calls.apply, 0); assert.equal((await h.engine.view()).job?.error, 'UPDATER_INSTALLATION_CHANGED');
});

test('recovered target is blocked on future automatic attempts and interrupted installation requires review', async () => {
  let applies = 0;
  const h = harness({ apply: async () => { applies++; return 'recovered'; } });
  await h.engine.initialize(); await h.engine.tick(); await h.engine.idle();
  assert.equal(h.snapshot().blockedVersion, candidate.version); assert.equal((await h.engine.view()).lastResult, 'recovered');
  h.advance('2026-11-14T03:10:00Z'); await h.engine.tick(); await h.engine.idle();
  assert.equal(applies, 1); assert.equal((await h.engine.view()).lastResult, 'manual-update-required');
  const state = { ...initialUpdateState(), settings: { ...settings }, job: { id: randomUUID(), phase: 'installing', version: candidate.version, error: null } };
  const interrupted = harness({}, state); await interrupted.engine.initialize(); await interrupted.engine.tick();
  assert.equal(interrupted.calls.find, 0); assert.equal((await interrupted.engine.view()).unavailableReason, 'UPDATER_REVIEW_REQUIRED');
  assert.equal((await interrupted.engine.view()).nextCheckAt, null);
  await assert.rejects(interrupted.engine.handle({ action: 'check' }), (error: any) => error.code === 'UPDATER_REVIEW_REQUIRED');
});

test('failed discovery retries once due and honors upstream rate-limit deadlines across reboot', async () => {
  const deadline = Date.parse('2026-11-07T03:20:00Z'); let checks = 0;
  const h = harness({ find: async () => { checks++; throw new UpdateReleaseError('UPDATE_RATE_LIMITED', deadline); } });
  await h.engine.initialize(); await h.engine.tick(); await h.engine.idle();
  assert.equal((await h.engine.view()).job?.error, 'UPDATER_RATE_LIMITED');
  assert.ok(h.snapshot().scheduledAt! >= deadline);
  h.advance('2026-11-07T03:19:59Z'); await h.engine.tick(); await h.engine.idle(); assert.equal(checks, 1);
  const restarted = harness({ find: async () => { checks++; return null; } }, h.snapshot());
  restarted.advance('2026-11-07T03:19:59Z'); await restarted.engine.initialize(); await restarted.engine.tick(); await restarted.engine.idle(); assert.equal(checks, 1);
  restarted.advance('2026-11-07T03:20:00Z'); await restarted.engine.tick(); await restarted.engine.idle(); assert.equal(checks, 2);
});

test('missed windows wait for the next permitted window and transient failures use bounded retry', async () => {
  const state = { ...initialUpdateState(), settings: { ...settings }, dueDate: '2026-11-01', scheduledAt: Date.parse('2026-11-01T03:00:00Z') };
  const missed = harness({}, state); missed.advance('2026-11-07T12:00:00Z');
  await missed.engine.initialize(); await missed.engine.tick(); await missed.engine.idle();
  assert.equal(missed.calls.find, 0); assert.equal((await missed.engine.view()).nextCheckAt, Date.parse('2026-11-08T03:00:00Z'));
  let checks = 0;
  const retry = harness({ find: async () => { if (++checks === 1) throw new Error('transient private details'); return null; } });
  await retry.engine.initialize(); await retry.engine.tick(); await retry.engine.idle();
  assert.equal((await retry.engine.view()).job?.error, 'UPDATER_OPERATION_FAILED');
  assert.equal(retry.snapshot().scheduledAt, Date.parse('2026-11-07T03:11:00Z'));
  retry.advance('2026-11-07T03:10:59Z'); await retry.engine.tick(); assert.equal(checks, 1);
  retry.advance('2026-11-07T03:11:00Z'); await retry.engine.tick(); await retry.engine.idle(); assert.equal(checks, 2);
});

test('shutdown during the final installed-identity read cancels before maintenance starts', async () => {
  const entered = deferred(), resume = deferred(); let prepared = false;
  const h = harness({ prepare: async () => { prepared = true; }, installed: async () => {
    if (prepared) { entered.resolve(); await resume.promise; }
    return { version: '1.0.2', manifestSha256: 'a'.repeat(64) };
  } });
  await h.engine.initialize(); await h.engine.tick(); await entered.promise;
  const closing = h.engine.close(); resume.resolve(); await closing;
  assert.equal(h.calls.apply, 0);
  assert.equal((await h.engine.view()).lastResult, 'cancelled');
});

test('shutdown waits for cleanup when it races the first persisted job transition', async () => {
  const saving = deferred(), saved = deferred(), cleaning = deferred(), cleaned = deferred();
  let intercepted = false, closed = false;
  const h = harness({ save: async state => {
    if (state.job?.phase === 'checking' && !intercepted) { intercepted = true; saving.resolve(); await saved.promise; }
  }, cleanup: async () => { cleaning.resolve(); await cleaned.promise; } });
  await h.engine.initialize();
  const ticking = h.engine.tick(); await saving.promise;
  const closing = h.engine.close().then(() => { closed = true; }); saved.resolve();
  await cleaning.promise;
  // Flush completed promise work, while cleanup deliberately remains pending.
  await new Promise<void>(accept => setImmediate(accept));
  const closedBeforeCleanup = closed; cleaned.resolve(); await Promise.all([ticking, closing]);
  assert.equal(closedBeforeCleanup, false);
  assert.equal(h.engine.busy, false);
});
