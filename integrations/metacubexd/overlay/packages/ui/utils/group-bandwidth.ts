type Translate = (key: string, named?: Record<string, unknown>) => string
const untranslated: Translate = key => key

export interface BandwidthSettings {
  enabled: boolean
  observeOnly: boolean
  [key: string]: number | boolean
}

export const bandwidthPages = [
  { id: 'bandwidth', label: 'coco.bandwidth', description: 'coco.bandwidthDescription', keys: ['targetMbps'] },
  { id: 'budget', label: 'coco.budget', description: 'coco.budgetDescription', keys: ['hourMiB', 'dayMiB', 'reserveHourMiB', 'reserveDayMiB'] },
  { id: 'gain', label: 'coco.gain', summary: 'coco.gainSummary', description: 'coco.gainDescription', keys: ['delayReferenceMs', 'throughputReferenceMbps', 'tradeoffRatio', 'shortageSeconds', 'minGainMs', 'minGainRatio', 'fallbackPenaltyMs', 'unfamiliarPenaltyMs'] },
  { id: 'protection', label: 'coco.protection', summary: 'coco.protectionSummary', description: 'coco.protectionDescription', keys: ['holdSeconds', 'maxSwitches', 'switchCostSeconds', 'recentCostSeconds', 'reverseCostSeconds', 'reverseWindowSeconds', 'horizonSeconds'] },
  { id: 'sampling', label: 'coco.sampling', summary: 'coco.samplingSummary', description: 'coco.samplingDescription', keys: ['durationSeconds', 'warmupSeconds', 'minSampleSeconds', 'timeoutSeconds', 'taskMiB', 'confirmRounds', 'roundIntervalSeconds'] },
  { id: 'evidence', label: 'coco.evidence', summary: 'coco.evidenceSummary', description: 'coco.evidenceDescription', keys: ['freshSeconds', 'latestSeconds', 'positiveSeconds', 'marginMs', 'agingMs'] },
  { id: 'trigger', label: 'coco.trigger', summary: 'coco.triggerSummary', description: 'coco.triggerDescription', keys: ['suspectRatio', 'activeSeconds', 'minTrafficMiB', 'busyStartMbps', 'busyStopMbps', 'quietSeconds'] },
  { id: 'search', label: 'coco.search', summary: 'coco.searchSummary', description: 'coco.searchDescription', keys: ['campaignSeconds', 'searchMiB', 'yieldSeconds', 'cooldownSeconds'] },
] as const

export type BandwidthPage = typeof bandwidthPages[number]['id']
export type BandwidthField = { label: string; default: number; min: number; max: number; unit: string; integer: boolean; basic: boolean }
export type BandwidthDefinitions = { defaults: BandwidthSettings; fields: Record<string, BandwidthField> }
export type BandwidthIssue = { message: string; page: BandwidthPage; key?: string }

export function bandwidthFieldPage(key: string): BandwidthPage {
  return bandwidthPages.find(page => (page.keys as readonly string[]).includes(key))?.id ?? 'bandwidth'
}

export function bandwidthIssue(s: BandwidthSettings | undefined, definitions: BandwidthDefinitions | undefined,
  automatic: Record<string, { enabled?: boolean; bandwidth?: BandwidthSettings }>, groupName: string, groupEnabled = true, t: Translate = untranslated): BandwidthIssue | undefined {
  if (!s) return
  const issue = (message: string, key: string): BandwidthIssue => ({ message, key, page: bandwidthFieldPage(key) })
  if (!definitions) return s.enabled ? issue(t('coco.definitionsMissing'), 'targetMbps') : undefined
  const n = (key: string) => Number(s[key])
  for (const [key, field] of Object.entries(definitions.fields)) {
    if (!Number.isFinite(n(key)) || n(key) < field.min || n(key) > field.max || (field.integer && !Number.isInteger(n(key))))
      return issue(t('coco.fieldRange', { label: t('coco.bandwidthField.' + key), integer: field.integer ? t('coco.integerRequired') : '' }), key)
  }
  if (n('durationSeconds') < n('warmupSeconds') + n('minSampleSeconds')) return issue(t('coco.downloadDuration'), 'durationSeconds')
  if (n('timeoutSeconds') < n('durationSeconds') + 5) return issue(t('coco.taskDuration'), 'timeoutSeconds')
  if (n('freshSeconds') < (n('confirmRounds') - 1) * n('roundIntervalSeconds') + n('timeoutSeconds')) return issue(t('coco.evidenceDuration'), 'freshSeconds')
  if (n('latestSeconds') < n('timeoutSeconds') || n('latestSeconds') > n('freshSeconds')) return issue(t('coco.latestEvidence'), 'latestSeconds')
  if (n('campaignSeconds') < (n('confirmRounds') - 1) * n('roundIntervalSeconds') + n('timeoutSeconds') * 2) return issue(t('coco.searchDuration'), 'campaignSeconds')
  const confirmation = n('taskMiB') * n('confirmRounds') * 2
  if (n('dayMiB') < n('hourMiB') || n('hourMiB') < confirmation) return issue(t('coco.hourBudget'), 'hourMiB')
  if (n('searchMiB') < confirmation) return issue(t('coco.searchBudget'), 'searchMiB')
  if (n('reserveHourMiB') >= n('hourMiB') || n('reserveDayMiB') >= n('dayMiB')) return issue(t('coco.reserveBudget'), 'reserveHourMiB')
  if (s.enabled && (n('hourMiB') - n('reserveHourMiB') < confirmation || n('dayMiB') - n('reserveDayMiB') < confirmation)) return issue(t('coco.remainingBudget', { confirmation }), 'reserveHourMiB')
  const combined = [s, ...Object.entries(automatic).filter(([name, policy]) => name !== groupName && policy.enabled !== false && policy.bandwidth?.enabled).map(([, policy]) => policy.bandwidth!)]
  const required = Math.max(...combined.map(value => Number(value.taskMiB) * Number(value.confirmRounds) * 2))
  const hour = Math.min(...combined.map(value => Number(value.hourMiB))) - Math.max(...combined.map(value => Number(value.reserveHourMiB)))
  const day = Math.min(...combined.map(value => Number(value.dayMiB))) - Math.max(...combined.map(value => Number(value.reserveDayMiB)))
  if (s.enabled && groupEnabled && (hour < required || day < required)) return issue(t('coco.sharedBudget', { required, hour, day }), 'hourMiB')
  if (n('taskMiB') * 1048576 < n('targetMbps') * 125000 * 1.25 * (n('warmupSeconds') + n('minSampleSeconds')) + 131072) return issue(t('coco.taskBudget'), 'taskMiB')
  if (n('busyStopMbps') <= n('busyStartMbps')) return issue(t('coco.busyThreshold'), 'busyStopMbps')
}
