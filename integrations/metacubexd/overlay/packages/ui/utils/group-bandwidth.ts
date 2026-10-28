export interface BandwidthSettings {
  enabled: boolean
  observeOnly: boolean
  [key: string]: number | boolean
}

export const bandwidthPages = [
  { id: 'bandwidth', label: '辅助决策', description: '带宽辅助决策结合延迟与下载吞吐，评估候选改善是否值得切换。', keys: ['targetMbps'] },
  { id: 'budget', label: '流量预算', description: '限制带宽辅助决策的自动下载验证流量；劣化处理预留包含在总额内。', keys: ['hourMiB', 'dayMiB', 'reserveHourMiB', 'reserveDayMiB'] },
  { id: 'gain', label: '收益判断', summary: '改善门槛与候选偏好', description: '判断候选改善是否足以支持切换；参考线不是绝对淘汰线。', keys: ['delayReferenceMs', 'throughputReferenceMbps', 'tradeoffRatio', 'shortageSeconds', 'minGainMs', 'minGainRatio', 'fallbackPenaltyMs', 'unfamiliarPenaltyMs'] },
  { id: 'protection', label: '切换保护', summary: '保持时间与切换成本', description: '通过保持时间、次数限制和切换成本减少反复切换。', keys: ['holdSeconds', 'maxSwitches', 'switchCostSeconds', 'recentCostSeconds', 'reverseCostSeconds', 'reverseWindowSeconds', 'horizonSeconds'] },
  { id: 'sampling', label: '下载采样', summary: '下载验证与确认样本', description: '配置单次下载验证及同节点样本的确认要求。', keys: ['durationSeconds', 'warmupSeconds', 'minSampleSeconds', 'timeoutSeconds', 'taskMiB', 'confirmRounds', 'roundIntervalSeconds'] },
  { id: 'evidence', label: '证据有效期', summary: '样本时效与测量裕量', description: '限制旧证据的使用，并为测量波动保留裕量。', keys: ['freshSeconds', 'latestSeconds', 'positiveSeconds', 'marginMs', 'agingMs'] },
  { id: 'trigger', label: '触发条件', summary: '低速与业务空闲条件', description: '配置低速怀疑条件，以及下载验证所需的业务空闲条件。', keys: ['suspectRatio', 'activeSeconds', 'minTrafficMiB', 'busyStartMbps', 'busyStopMbps', 'quietSeconds'] },
  { id: 'search', label: '搜索节奏', summary: '连续搜索与节点退避', description: '限制连续搜索的时间和流量，并为无收益节点设置退避。', keys: ['campaignSeconds', 'searchMiB', 'yieldSeconds', 'cooldownSeconds'] },
] as const

export type BandwidthPage = typeof bandwidthPages[number]['id']
export type BandwidthField = { label: string; default: number; min: number; max: number; unit: string; integer: boolean; basic: boolean }
export type BandwidthDefinitions = { defaults: BandwidthSettings; fields: Record<string, BandwidthField> }
export type BandwidthIssue = { message: string; page: BandwidthPage; key?: string }

export function bandwidthFieldPage(key: string): BandwidthPage {
  return bandwidthPages.find(page => (page.keys as readonly string[]).includes(key))?.id ?? 'bandwidth'
}

export function bandwidthIssue(s: BandwidthSettings | undefined, definitions: BandwidthDefinitions | undefined,
  automatic: Record<string, { enabled?: boolean; bandwidth?: BandwidthSettings }>, groupName: string, groupEnabled = true): BandwidthIssue | undefined {
  if (!s) return
  const issue = (message: string, key: string): BandwidthIssue => ({ message, key, page: bandwidthFieldPage(key) })
  if (!definitions) return s.enabled ? issue('参数定义尚未读取，请重读参数后保存。', 'targetMbps') : undefined
  const n = (key: string) => Number(s[key])
  for (const [key, field] of Object.entries(definitions.fields)) {
    if (!Number.isFinite(n(key)) || n(key) < field.min || n(key) > field.max || (field.integer && !Number.isInteger(n(key))))
      return issue(`请检查「${field.label}」的范围${field.integer ? '，此项须为整数' : ''}。`, key)
  }
  if (n('durationSeconds') < n('warmupSeconds') + n('minSampleSeconds')) return issue('下载时间须容纳预热与有效采样时间。', 'durationSeconds')
  if (n('timeoutSeconds') < n('durationSeconds') + 5) return issue('任务总时限须比下载时间至少多 5 秒。', 'timeoutSeconds')
  if (n('freshSeconds') < (n('confirmRounds') - 1) * n('roundIntervalSeconds') + n('timeoutSeconds')) return issue('证据有效期须容纳全部确认间隔与任务时限。', 'freshSeconds')
  if (n('latestSeconds') < n('timeoutSeconds') || n('latestSeconds') > n('freshSeconds')) return issue('最新证据年龄上限须容纳任务，且不能超过证据有效期。', 'latestSeconds')
  if (n('campaignSeconds') < (n('confirmRounds') - 1) * n('roundIntervalSeconds') + n('timeoutSeconds') * 2) return issue('连续搜索时间须容纳当前与候选的确认任务。', 'campaignSeconds')
  const confirmation = n('taskMiB') * n('confirmRounds') * 2
  if (n('dayMiB') < n('hourMiB') || n('hourMiB') < confirmation) return issue('24 小时预算须不少于每小时预算；小时预算须容纳全部确认轮次。', 'hourMiB')
  if (n('searchMiB') < confirmation) return issue('连续搜索额度须容纳当前与候选所需的全部有效样本。', 'searchMiB')
  if (n('reserveHourMiB') >= n('hourMiB') || n('reserveDayMiB') >= n('dayMiB')) return issue('劣化处理预留须小于对应总预算，预留包含在总额内。', 'reserveHourMiB')
  if (s.enabled && (n('hourMiB') - n('reserveHourMiB') < confirmation || n('dayMiB') - n('reserveDayMiB') < confirmation)) return issue(`扣除预留后，每小时和 24 小时预算均须至少剩余 ${confirmation} MiB，才能完成普通比较。`, 'reserveHourMiB')
  const combined = [s, ...Object.entries(automatic).filter(([name, policy]) => name !== groupName && policy.enabled !== false && policy.bandwidth?.enabled).map(([, policy]) => policy.bandwidth!)]
  const required = Math.max(...combined.map(value => Number(value.taskMiB) * Number(value.confirmRounds) * 2))
  const hour = Math.min(...combined.map(value => Number(value.hourMiB))) - Math.max(...combined.map(value => Number(value.reserveHourMiB)))
  const day = Math.min(...combined.map(value => Number(value.dayMiB))) - Math.max(...combined.map(value => Number(value.reserveDayMiB)))
  if (s.enabled && groupEnabled && (hour < required || day < required)) return issue(`多个启用组共用预算：最小总额减最大预留后，小时和 24 小时均须至少剩余 ${required} MiB；目前分别为 ${hour}、${day} MiB。请协调各组额度或预留。`, 'hourMiB')
  if (n('taskMiB') * 1048576 < n('targetMbps') * 125000 * 1.25 * (n('warmupSeconds') + n('minSampleSeconds')) + 131072) return issue('单次流量额度不足以验证目标速度，请增加额度或降低目标。', 'taskMiB')
  if (n('busyStopMbps') <= n('busyStartMbps')) return issue('检测中止阈值须高于启动阈值。', 'busyStopMbps')
}
