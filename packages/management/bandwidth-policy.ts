/** All bandwidth settings are opt-in. Missing fields inherit these versioned defaults. */
const field = (label: string, value: number, min: number, max: number, unit: string, basic = false, integer = true) =>
  ({ label, default: value, min, max, unit, basic, integer });
export const BANDWIDTH_FIELDS = {
  targetMbps: field('目标下载吞吐', 8, 1, 100, 'Mbps', true, false),
  delayReferenceMs: field('延迟参考线（非绝对上限）', 500, 100, 5000, 'ms', true),
  throughputReferenceMbps: field('吞吐参考线（非绝对下限）', 4, 0.1, 100, 'Mbps', true, false),
  tradeoffRatio: field('单项相对恶化容忍度', 0.1, 0, 0.5, '比例', false, false),
  fallbackPenaltyMs: field('备选偏好成本', 100, 0, 2000, '等价ms'),
  unfamiliarPenaltyMs: field('缺少实际使用证据的候选惩罚', 100, 0, 2000, '等价ms'),
  shortageSeconds: field('吞吐不足的重视程度', 1, 0.1, 10, '秒', false, false),
  minGainMs: field('最低绝对改善', 100, 10, 2000, 'ms'),
  minGainRatio: field('最低相对改善', 0.2, 0, 1, '比例', false, false),
  switchCostSeconds: field('基础切换成本', 3, 0, 120, '等价秒', false, false),
  recentCostSeconds: field('近期每次切换附加成本', 2, 0, 120, '等价秒', false, false),
  reverseCostSeconds: field('短期反向切换附加成本', 10, 0, 300, '等价秒', false, false),
  reverseWindowSeconds: field('反向切换成本保护窗口', 3600, 600, 3600, '秒'),
  horizonSeconds: field('成本摊销参考任务数', 60, 10, 120, '个'),
  marginMs: field('测量安全裕量', 20, 10, 500, 'ms'),
  agingMs: field('每分钟老化裕量', 10, 1, 100, 'ms'),
  confirmRounds: field('所需有效样本数', 2, 2, 5, '次'),
  roundIntervalSeconds: field('同节点采样最小间隔', 30, 30, 120, '秒'),
  holdSeconds: field('切换后保持时间', 600, 120, 3600, '秒'),
  cooldownSeconds: field('单节点无收益退避上限', 1800, 300, 86400, '秒'),
  freshSeconds: field('每条证据有效期', 180, 60, 600, '秒'),
  latestSeconds: field('切换时最新证据年龄上限', 60, 30, 180, '秒'),
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
  reserveHourMiB: field('每小时劣化处理预留', 16, 0, 256, 'MiB'),
  reserveDayMiB: field('24小时劣化处理预留', 32, 0, 1024, 'MiB'),
  searchMiB: field('连续搜索载荷上限', 32, 8, 512, 'MiB'),
  yieldSeconds: field('连续搜索后让出时间', 120, 30, 1800, '秒'),
  campaignSeconds: field('连续搜索最长时间', 600, 120, 1800, '秒'),
  busyStartMbps: field('启动前业务流量上限', 1, 0.1, 10, 'Mbps', false, false),
  busyStopMbps: field('检测中业务流量中止阈值', 2, 0.2, 20, 'Mbps', false, false),
  quietSeconds: field('启动前低负载保持时间', 10, 5, 60, '秒'),
} as const;
export type BandwidthSettings = { enabled: boolean; observeOnly: boolean }
  & { -readonly [K in keyof typeof BANDWIDTH_FIELDS]: number };
export const DEFAULT_BANDWIDTH_SETTINGS: BandwidthSettings = Object.freeze({
  enabled: false, observeOnly: false,
  ...Object.fromEntries(Object.entries(BANDWIDTH_FIELDS).map(([key, value]) => [key, value.default])),
} as BandwidthSettings);

export function parseBandwidthSettings(value: unknown): BandwidthSettings {
  const fail = (): never => { throw new Error('AUTO_SETTINGS_INVALID'); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  const input = value as Record<string, unknown>;
  const legacy = !Object.hasOwn(input, 'delayReferenceMs') && Object.hasOwn(input, 'campaignSeconds');
  const result = { ...DEFAULT_BANDWIDTH_SETTINGS };
  for (const [key, value] of Object.entries(input)) {
    if (key === 'activeProbes') {
      // Accept old settings without retaining a separate download permission.
      if (typeof value !== 'boolean') return fail();
    } else if (key === 'enabled' || key === 'observeOnly') {
      if (typeof value !== 'boolean') return fail();
      result[key] = value;
    } else {
      const definition = BANDWIDTH_FIELDS[key as keyof typeof BANDWIDTH_FIELDS];
      // Old saved policies allowed a 300 s gap and only aged the newest sample.
      if (legacy && key === 'roundIntervalSeconds' && typeof value === 'number' && Number.isInteger(value) && value >= 30 && value <= 300) {
        result.roundIntervalSeconds = Math.min(value, 120); continue;
      }
      if (!definition || typeof value !== 'number' || !Number.isFinite(value) || value < definition.min || value > definition.max
          || (definition.integer && !Number.isInteger(value))) return fail();
      result[key as keyof typeof BANDWIDTH_FIELDS] = value;
    }
  }
  // Preserve an explicit legacy opt-out: enabling the feature now includes downloads.
  if (input.activeProbes === false) result.enabled = false;
  // Old policies did not have a per-search budget; retain their saved confirmation count.
  if (!Object.hasOwn(input, 'searchMiB')) result.searchMiB = Math.max(result.searchMiB, result.taskMiB * 2 * result.confirmRounds);
  if (legacy) result.freshSeconds = Math.max(result.freshSeconds, (result.confirmRounds - 1) * result.roundIntervalSeconds + result.timeoutSeconds);
  if (result.durationSeconds < result.warmupSeconds + result.minSampleSeconds
      || result.timeoutSeconds < result.durationSeconds + 5
      || result.campaignSeconds < (result.confirmRounds - 1) * result.roundIntervalSeconds + 2 * result.timeoutSeconds
      || result.freshSeconds < (result.confirmRounds - 1) * result.roundIntervalSeconds + result.timeoutSeconds
      || result.latestSeconds < result.timeoutSeconds || result.latestSeconds > result.freshSeconds || result.dayMiB < result.hourMiB
      || result.hourMiB < result.taskMiB * 2 * result.confirmRounds
      || result.reserveHourMiB >= result.hourMiB || result.reserveDayMiB >= result.dayMiB
      || result.searchMiB < result.taskMiB * 2 * result.confirmRounds
      || result.busyStopMbps <= result.busyStartMbps
      // Demand-paced probing must have room for warmup, a full sample and response overhead.
      || result.taskMiB * 1048576 < result.targetMbps * 125000 * 1.25 * (result.warmupSeconds + result.minSampleSeconds) + 131072) return fail();
  return result;
}

export const bandwidthLoss = (delayMs: number, mbps: number, settings: BandwidthSettings): number =>
  delayMs / 1000 + settings.shortageSeconds * Math.max(0, settings.targetMbps / mbps - 1);
export type BandwidthSample = { at: number; startedAt?: number; delayMs: number; mbps: number };
/** Keep the newest contiguous evidence, never cherry-pick around a bad/invalid sample. */
export function bandwidthSamples(samples: BandwidthSample[], settings: BandwidthSettings, at: number) {
  const values: BandwidthSample[] = [];
  for (let i = samples.length - 1; i >= 0 && values.length < settings.confirmRounds; i--) {
    const s = samples[i], next = values[0];
    if (!Number.isFinite(s.at) || s.at > at || at - s.at > settings.freshSeconds * 1000
        || !Number.isFinite(s.delayMs) || s.delayMs < 0 || !Number.isFinite(s.mbps) || s.mbps <= 0) break;
    if (next) {
      const gap = (next.startedAt ?? next.at) - (s.startedAt ?? s.at);
      // The configured minimum cannot also be an exact deadline: allow probe/tick delays.
      // Every individual sample must still pass freshSeconds above.
      const maximumGap = Math.max(120, settings.roundIntervalSeconds + 30) * 1000;
      if (gap < settings.roundIntervalSeconds * 1000 || gap > maximumGap) break;
    }
    values.unshift(s);
  }
  return values;
}
export function bandwidthInterval(samples: BandwidthSample[], settings: BandwidthSettings, at: number, complete = true) {
  const values = bandwidthSamples(samples, settings, at);
  if (!values.length || (complete && (values.length < settings.confirmRounds || at - values.at(-1)!.at > settings.latestSeconds * 1000))) return null;
  const losses = values.map(s => {
    const loss = bandwidthLoss(s.delayMs, s.mbps, settings);
    const margin = (settings.marginMs + settings.agingMs * (at - s.at) / 60000) / 1000;
    return { low: Math.max(0, loss - margin), high: loss + margin };
  });
  return { low: Math.min(...losses.map(s => s.low)), high: Math.max(...losses.map(s => s.high)),
    delay: Math.max(...values.map(s => s.delayMs)), mbps: Math.min(...values.map(s => s.mbps)) };
}
export type BandwidthPreference = { unfamiliar?: boolean; currentPreferred?: boolean; candidatePreferred?: boolean };
export function bandwidthThreshold(currentLow: number, settings: BandwidthSettings, recentSwitches = 0, reverse = false,
  preference: BandwidthPreference = {}) {
  const cost = (settings.switchCostSeconds + settings.recentCostSeconds * recentSwitches + (reverse ? settings.reverseCostSeconds : 0)) / settings.horizonSeconds
    + (preference.currentPreferred && preference.candidatePreferred === false ? settings.fallbackPenaltyMs / 1000 : 0);
  return { cost, threshold: Math.max(settings.minGainMs / 1000, settings.minGainRatio * currentLow) + cost };
}
export function bandwidthGuard(current: { delay: number; mbps: number }, candidate: { delay: number; mbps: number }, settings: BandwidthSettings) {
  return candidate.delay <= Math.max(settings.delayReferenceMs, current.delay * (1 + settings.tradeoffRatio))
    && candidate.mbps >= Math.min(settings.throughputReferenceMbps, current.mbps * (1 - settings.tradeoffRatio));
}
export function bandwidthDecision(current: BandwidthSample[], candidate: BandwidthSample[], settings: BandwidthSettings,
  at: number, recentSwitches = 0, reverse = false, preference: BandwidthPreference = {}) {
  const from = bandwidthInterval(current, settings, at), to = bandwidthInterval(candidate, settings, at);
  if (!from || !to) return null;
  const uncertainty = preference.unfamiliar !== false ? settings.unfamiliarPenaltyMs / 1000 : 0;
  const { cost, threshold } = bandwidthThreshold(from.low, settings, recentSwitches, reverse, preference);
  const guard = bandwidthGuard(from, to, settings), gain = from.low - to.high - uncertainty;
  return { current: from, candidate: to, gain, cost, threshold, uncertainty, guard,
    rank: to.high + uncertainty + (preference.candidatePreferred === false ? settings.fallbackPenaltyMs / 1000 : 0),
    worthwhile: guard && gain > threshold };
}
