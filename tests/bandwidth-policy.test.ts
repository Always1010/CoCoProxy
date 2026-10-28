import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_BANDWIDTH_SETTINGS as defaults, parseBandwidthSettings, bandwidthLoss, bandwidthDecision, bandwidthGuard, bandwidthSamples } from '../packages/management/bandwidth-policy.ts';
import { parseAutoGroupPolicy } from '../packages/management/automatic-policy.ts';

test('bandwidth settings preserve legacy policies and validate coupled time and traffic limits', () => {
  const legacy = { preferred: ['a'], fallback: ['b'], returnToPreferred: true };
  assert.deepEqual(parseAutoGroupPolicy(legacy), legacy);
  assert.equal(parseBandwidthSettings({}).enabled, false);
  assert.equal(parseAutoGroupPolicy({ ...legacy, bandwidth: { enabled: true } }).bandwidth?.targetMbps, 8);
  assert.deepEqual(parseBandwidthSettings({ enabled: true, activeProbes: true }), { ...defaults, enabled: true });
  const optedOut = parseAutoGroupPolicy({ ...legacy, bandwidth: { enabled: true, activeProbes: false, observeOnly: true, targetMbps: 10, taskMiB: 10 } }).bandwidth!;
  assert.equal(optedOut.enabled, false);
  assert.equal(optedOut.observeOnly, true);
  assert.equal(optedOut.targetMbps, 10);
  assert.equal(Object.hasOwn(optedOut, 'activeProbes'), false);
  assert.equal(parseBandwidthSettings({ ...optedOut, enabled: true }).enabled, true);
  assert.equal(defaults.confirmRounds, 2);
  assert.equal(parseBandwidthSettings({ confirmRounds: 3, roundIntervalSeconds: 60 }).searchMiB, 48);
  const old = parseBandwidthSettings({ confirmRounds: 3, roundIntervalSeconds: 300, campaignSeconds: 900, freshSeconds: 180 });
  assert.equal(old.roundIntervalSeconds, 120); assert.equal(old.freshSeconds, 260);
  for (const value of [{ enabled: 1 }, { activeProbes: 0 }, { targetMbps: NaN }, { extra: true }, { confirmRounds: 1 }, { durationSeconds: 4 },
    { taskMiB: 1 }, { hourMiB: 16 }, { dayMiB: 32 }, { latestSeconds: 181 }, { targetMbps: 100 }, { roundIntervalSeconds: 20 },
    { reserveHourMiB: 64 }, { reserveDayMiB: 128 }, { searchMiB: 16 }, { confirmRounds: 5, roundIntervalSeconds: 120 }]) {
    assert.throws(() => parseBandwidthSettings(value));
  }
});

test('conservative gain prices switching and uncertainty rather than rewarding bandwidth peaks', () => {
  const at = 30000;
  const samples = (delayMs: number, rates: number[]) => rates.map((mbps, i) => ({ at: i * 30000, delayMs, mbps }));
  const current = samples(80, [4, 4]);
  assert.ok(bandwidthDecision(current, samples(150, [12, 12]), defaults, at)?.worthwhile);
  assert.equal(bandwidthDecision(current, samples(900, [12, 12]), defaults, at)?.guard, false);
  assert.equal(bandwidthDecision(current, samples(50, [1, 12]), defaults, at)?.worthwhile, false);
  const close = samples(80, [6, 6]), better = samples(150, [8, 8]);
  assert.equal(bandwidthDecision(close, better, defaults, at, 0, false, { unfamiliar: false })?.worthwhile, true);
  assert.equal(bandwidthDecision(close, better, defaults, at, 0, true)?.worthwhile, false);
  assert.equal(bandwidthDecision(close, better, defaults, at)?.worthwhile, false);
  const preferred = bandwidthDecision(current, better, defaults, at, 0, false, { candidatePreferred: true, currentPreferred: true })!;
  const fallback = bandwidthDecision(current, better, defaults, at, 0, false, { candidatePreferred: false, currentPreferred: true })!;
  assert.ok(fallback.rank > preferred.rank && fallback.threshold > preferred.threshold);
  assert.equal(bandwidthLoss(80, 8, defaults), bandwidthLoss(80, 100, defaults));
  assert.equal(bandwidthDecision(current, better, defaults, at + 61000), null);
  assert.ok(bandwidthDecision(samples(2000, [0.5, 0.5]), samples(800, [2, 2]), defaults, at)?.worthwhile);
  for (const delay of [50, 500, 2000]) for (const mbps of [0.5, 4, 20]) {
    assert.equal(bandwidthGuard({ delay, mbps }, { delay: delay / 2, mbps: mbps * 2 }, defaults), true);
  }
  assert.equal(bandwidthSamples([{ at: 0, delayMs: 100, mbps: 8 }, { at: 150000, delayMs: 100, mbps: 8 }], defaults, 150000).length, 1);
  assert.equal(bandwidthSamples([{ at: 0, delayMs: 100, mbps: 8 }, { at: 20000, delayMs: 100, mbps: 8 }], defaults, 20000).length, 1);
  assert.equal(bandwidthSamples([{ at: 0, delayMs: 100, mbps: 8 }, { at: 30000, delayMs: 100, mbps: 0 }], defaults, at).length, 0);
});

test('maximum configured sampling interval allows bounded scheduling delay without reviving expired evidence', () => {
  const settings = parseBandwidthSettings({ ...defaults, roundIntervalSeconds: 120 });
  const pair = (gap: number) => [0, gap].map(at => ({ at, startedAt: at, delayMs: 100, mbps: 8 }));
  assert.equal(bandwidthSamples(pair(121000), settings, 121000).length, 2);
  assert.equal(bandwidthSamples(pair(150000), settings, 150000).length, 2);
  assert.equal(bandwidthSamples(pair(151000), settings, 151000).length, 1);
  assert.equal(bandwidthSamples(pair(121000), settings, 180001).length, 1);
  assert.equal(bandwidthSamples(pair(119000), settings, 119000).length, 1);
});

test('enabled bandwidth budgets must cover ordinary confirmation after reserves in both windows', () => {
  for (const limits of [{ hourMiB: 32 }, { dayMiB: 64, reserveDayMiB: 40 }]) {
    assert.throws(() => parseBandwidthSettings({ ...defaults, enabled: true, ...limits }));
  }
  assert.equal(parseBandwidthSettings({ ...defaults, enabled: true, hourMiB: 48, dayMiB: 64 }).hourMiB, 48);
  assert.equal(parseBandwidthSettings({ ...defaults, enabled: true, hourMiB: 32, dayMiB: 32, reserveHourMiB: 0, reserveDayMiB: 0 }).hourMiB, 32);
  assert.equal(parseBandwidthSettings({ ...defaults, enabled: false, hourMiB: 32 }).enabled, false);
});
