export type ResponsiveLatencySettings = { mode: 'responsive'; slowMs: number };
export const DEFAULT_RESPONSIVE_LATENCY: Readonly<ResponsiveLatencySettings> = Object.freeze({ mode: 'responsive', slowMs: 500 });
export const RESPONSIVE_LATENCY = Object.freeze({ windowMs: 90_000, freshMs: 60_000, samples: 5,
  burstMs: 5000, burstChecks: 3, burstCooldownMs: 60_000, candidates: 2,
  minGainMs: 100, minGainRatio: 0.3, marginMs: 20 });

export function parseResponsiveLatency(value: unknown): ResponsiveLatencySettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('AUTO_SETTINGS_INVALID');
  const input = value as Record<string, unknown>;
  const slowMs = input.slowMs === undefined ? DEFAULT_RESPONSIVE_LATENCY.slowMs : input.slowMs;
  if (Object.keys(input).some(k => !['mode', 'slowMs'].includes(k)) || input.mode !== 'responsive'
    || !Number.isInteger(slowMs) || Number(slowMs) < 500 || Number(slowMs) > 10000) throw new Error('AUTO_SETTINGS_INVALID');
  return { mode: 'responsive', slowMs: Number(slowMs) };
}

export type LatencySample = { at: number; delayMs: number };
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b), half = Math.floor(sorted.length / 2);
  return sorted.length ? sorted.length % 2 ? sorted[half] : (sorted[half - 1] + sorted[half]) / 2 : null;
};

/** A single recovery cannot erase a bad window; two recent recoveries can. */
export function latencyWindow(input: LatencySample[], settings: ResponsiveLatencySettings, at: number) {
  const samples = input.filter(s => s.at <= at && at - s.at <= RESPONSIVE_LATENCY.windowMs
    && Number.isFinite(s.delayMs) && s.delayMs >= 0).slice(-RESPONSIVE_LATENCY.samples).map(s => ({ ...s }));
  const slowCount = samples.filter(s => s.delayMs > settings.slowMs).length;
  const requiredSlowCount = Math.ceil(samples.length * 0.6);
  const medianMs = median(samples.map(s => s.delayMs)), recentMedianMs = median(samples.slice(-3).map(s => s.delayMs));
  const fresh = !!samples.length && at - samples.at(-1)!.at <= RESPONSIVE_LATENCY.freshMs;
  return { samples, slowCount, requiredSlowCount, medianMs, recentMedianMs, fresh,
    baselineMs: medianMs === null || recentMedianMs === null ? null : Math.min(medianMs, recentMedianMs),
    degraded: fresh && samples.length >= 3 && slowCount >= requiredSlowCount && recentMedianMs! > settings.slowMs };
}

/** Response decisions never inherit optional throughput settings or evidence. */
export function latencyDecision(currentMs: number, candidateMs: number, recentSwitches = 0, reverse = false,
  leavingPreferred = false) {
  const costMs = (3000 + recentSwitches * 2000 + (reverse ? 10000 : 0)) / 60 + (leavingPreferred ? 100 : 0);
  const requiredGainMs = Math.max(RESPONSIVE_LATENCY.minGainMs, currentMs * RESPONSIVE_LATENCY.minGainRatio)
    + RESPONSIVE_LATENCY.marginMs * 2 + costMs;
  const gainMs = currentMs - candidateMs;
  return { currentMs, candidateMs, gainMs, requiredGainMs, worthwhile: gainMs > requiredGainMs };
}
