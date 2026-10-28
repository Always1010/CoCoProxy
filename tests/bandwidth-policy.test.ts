import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_BANDWIDTH_SETTINGS as defaults, parseBandwidthSettings, bandwidthLoss, bandwidthDecision } from '../packages/management/bandwidth-policy.ts';
import { parseAutoGroupPolicy } from '../packages/management/automatic-policy.ts';

test('bandwidth settings preserve legacy policies and validate coupled time and traffic limits', () => {
  const legacy = { preferred: ['a'], fallback: ['b'], returnToPreferred: true };
  assert.deepEqual(parseAutoGroupPolicy(legacy), legacy);
  assert.equal(parseBandwidthSettings({}).enabled, false);
  assert.equal(parseAutoGroupPolicy({ ...legacy, bandwidth: { enabled: true } }).bandwidth?.targetMbps, 8);
  for (const value of [{ enabled: 1 }, { targetMbps: NaN }, { extra: true }, { confirmRounds: 2 }, { durationSeconds: 4 },
    { taskMiB: 1 }, { hourMiB: 16 }, { dayMiB: 32 }, { campaignSeconds: 120 }, { targetMbps: 100 }, { roundIntervalSeconds: 30 }]) {
    assert.throws(() => parseBandwidthSettings(value));
  }
});

test('conservative gain prices switching and uncertainty rather than rewarding bandwidth peaks', () => {
  const at = 120000;
  const samples = (delayMs: number, rates: number[]) => rates.map((mbps, i) => ({ at: i * 60000, delayMs, mbps }));
  const current = samples(80, [6, 6, 6]);
  assert.ok(bandwidthDecision(current, samples(150, [12, 12, 12]), defaults, at)?.worthwhile);
  assert.equal(bandwidthDecision(current, samples(250, [12, 12, 12]), defaults, at)?.worthwhile, false);
  assert.equal(bandwidthDecision(current, samples(150, [5, 14, 12]), defaults, at)?.worthwhile, false);
  assert.equal(bandwidthDecision(current, samples(150, [12, 12, 12]), defaults, at, 0, true)?.worthwhile, false);
  assert.equal(bandwidthLoss(80, 8, defaults), bandwidthLoss(80, 100, defaults));
  assert.equal(bandwidthDecision(current, samples(150, [12, 12, 12]), defaults, at + 181000), null);
});
