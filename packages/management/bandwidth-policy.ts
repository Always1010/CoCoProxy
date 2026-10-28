/** All bandwidth settings are opt-in. Missing fields inherit these versioned defaults. */
const field = (label: string, value: number, min: number, max: number, unit: string, basic = false, integer = true) =>
  ({ label, default: value, min, max, unit, basic, integer });
export const BANDWIDTH_FIELDS = {
  targetMbps: field('目标下载吞吐', 8, 1, 100, 'Mbps', true, false),
  shortageSeconds: field('吞吐不足的重视程度', 1, 0.1, 10, '秒', false, false),
  minGainMs: field('最低绝对改善', 100, 10, 2000, 'ms'),
  minGainRatio: field('最低相对改善', 0.2, 0, 1, '比例', false, false),
  switchCostSeconds: field('基础切换成本', 3, 0, 120, '等价秒', false, false),
  recentCostSeconds: field('近期每次切换附加成本', 2, 0, 120, '等价秒', false, false),
  reverseCostSeconds: field('短期反向切换附加成本', 10, 0, 300, '等价秒', false, false),
  horizonSeconds: field('成本摊销参考任务数', 60, 10, 120, '个'),
  marginMs: field('测量安全裕量', 20, 10, 500, 'ms'),
  agingMs: field('每分钟老化裕量', 10, 1, 100, 'ms'),
  confirmRounds: field('确认轮次', 3, 3, 5, '轮'),
  roundIntervalSeconds: field('轮次间隔', 60, 30, 300, '秒'),
  holdSeconds: field('切换后保持时间', 600, 120, 3600, '秒'),
  cooldownSeconds: field('检查冷却时间', 1800, 300, 86400, '秒'),
  freshSeconds: field('最新证据有效期', 180, 60, 600, '秒'),
  positiveSeconds: field('被动达标证据有效期', 900, 60, 3600, '秒'),
  maxSwitches: field('每组每小时性能切换上限', 3, 1, 6, '次'),
  suspectRatio: field('低速怀疑阈值', 0.8, 0.1, 1, '目标比例', false, false),
  activeSeconds: field('90秒内最少下载活跃时间', 60, 15, 90, '秒'),
  minTrafficMiB: field('触发检查的最少业务流量', 2, 1, 32, 'MiB'),
  durationSeconds: field('单次下载时间上限', 8, 5, 15, '秒'),
  warmupSeconds: field('下载预热时间', 2, 1, 5, '秒'),
  minSampleSeconds: field('最少有效采样时间', 3, 3, 10, '秒'),
  taskMiB: field('单次下载载荷上限', 8, 1, 64, 'MiB'),
  timeoutSeconds: field('单次任务总时限', 20, 10, 30, '秒'),
  hourMiB: field('滚动每小时自动检测预算', 64, 8, 512, 'MiB', true),
  dayMiB: field('滚动24小时自动检测预算', 128, 16, 2048, 'MiB', true),
  campaignSeconds: field('一轮比较最长收集时间', 600, 120, 1800, '秒'),
  busyStartMbps: field('启动前业务流量上限', 1, 0.1, 10, 'Mbps', false, false),
  busyStopMbps: field('检测中业务流量中止阈值', 2, 0.2, 20, 'Mbps', false, false),
  quietSeconds: field('启动前低负载保持时间', 10, 5, 60, '秒'),
} as const;
export type BandwidthSettings = { enabled: boolean; activeProbes: boolean; observeOnly: boolean }
  & { -readonly [K in keyof typeof BANDWIDTH_FIELDS]: number };
export const DEFAULT_BANDWIDTH_SETTINGS: BandwidthSettings = Object.freeze({
  enabled: false, activeProbes: true, observeOnly: false,
  ...Object.fromEntries(Object.entries(BANDWIDTH_FIELDS).map(([key, value]) => [key, value.default])),
} as BandwidthSettings);

export function parseBandwidthSettings(value: unknown): BandwidthSettings {
  const fail = (): never => { throw new Error('AUTO_SETTINGS_INVALID'); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  const input = value as Record<string, unknown>;
  const result = { ...DEFAULT_BANDWIDTH_SETTINGS };
  for (const [key, value] of Object.entries(input)) {
    if (key === 'enabled' || key === 'activeProbes' || key === 'observeOnly') {
      if (typeof value !== 'boolean') return fail();
      result[key] = value;
    } else {
      const definition = BANDWIDTH_FIELDS[key as keyof typeof BANDWIDTH_FIELDS];
      if (!definition || typeof value !== 'number' || !Number.isFinite(value) || value < definition.min || value > definition.max
          || (definition.integer && !Number.isInteger(value))) return fail();
      result[key as keyof typeof BANDWIDTH_FIELDS] = value;
    }
  }
  if (result.durationSeconds < result.warmupSeconds + result.minSampleSeconds
      || result.timeoutSeconds < result.durationSeconds + 5
      || result.roundIntervalSeconds < result.timeoutSeconds * 2
      || result.campaignSeconds < (result.confirmRounds - 1) * result.roundIntervalSeconds + 2 * result.timeoutSeconds
      || result.freshSeconds < result.timeoutSeconds * 2 || result.dayMiB < result.hourMiB
      || result.hourMiB < result.taskMiB * 2 * result.confirmRounds
      || result.busyStopMbps <= result.busyStartMbps
      // Demand-paced probing must have room for warmup, a full sample and response overhead.
      || result.taskMiB * 1048576 < result.targetMbps * 125000 * 1.25 * (result.warmupSeconds + result.minSampleSeconds) + 131072) return fail();
  return result;
}

export const bandwidthLoss = (delayMs: number, mbps: number, settings: BandwidthSettings): number =>
  delayMs / 1000 + settings.shortageSeconds * Math.max(0, settings.targetMbps / mbps - 1);
export type BandwidthSample = { at: number; delayMs: number; mbps: number };
export function bandwidthInterval(samples: BandwidthSample[], settings: BandwidthSettings, at: number) {
  const values = samples.slice(-settings.confirmRounds);
  if (values.length < settings.confirmRounds || values.some(s => !Number.isFinite(s.delayMs) || s.delayMs < 0 || !Number.isFinite(s.mbps) || s.mbps <= 0)
      || at < values.at(-1)!.at || at - values.at(-1)!.at > settings.freshSeconds * 1000) return null;
  const losses = values.map(s => bandwidthLoss(s.delayMs, s.mbps, settings));
  const margin = (settings.marginMs + settings.agingMs * (at - values.at(-1)!.at) / 60000) / 1000;
  return { low: Math.max(0, Math.min(...losses) - margin), high: Math.max(...losses) + margin };
}
export function bandwidthDecision(current: BandwidthSample[], candidate: BandwidthSample[], settings: BandwidthSettings,
  at: number, recentSwitches = 0, reverse = false) {
  const from = bandwidthInterval(current, settings, at), to = bandwidthInterval(candidate, settings, at);
  if (!from || !to) return null;
  const cost = (settings.switchCostSeconds + settings.recentCostSeconds * recentSwitches + (reverse ? settings.reverseCostSeconds : 0)) / settings.horizonSeconds;
  const threshold = Math.max(settings.minGainMs / 1000, settings.minGainRatio * from.low) + cost;
  return { current: from, candidate: to, gain: from.low - to.high, cost, threshold, worthwhile: from.low - to.high > threshold };
}
