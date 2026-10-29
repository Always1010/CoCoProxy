import type { AutomaticStatus, BandwidthSettings } from '../composables/useWorkspace'

export type ProcessSample = { at: number; startedAt?: number; delayMs: number; mbps: number }
export type ProcessComparison = {
  currentNode: string; candidateNode: string
  current: { low: number; high: number; delay: number; mbps: number }
  candidate: { low: number; high: number; delay: number; mbps: number }
  gain: number; cost: number; threshold: number; uncertainty: number; rank: number; worthwhile: boolean; guard: boolean
  currentSamples: ProcessSample[]; candidateSamples: ProcessSample[]; effectiveCurrent: ProcessSample[]; effectiveCandidate: ProcessSample[]
  recentSwitches: number; reverse: boolean; currentPreferred: boolean; candidatePreferred: boolean
}
export type ProcessEvent = {
  at: number; until: number; kind: string; reason: string; node?: string; nextAt?: number | null
  probe?: { ok: boolean; delayMs: number | null; retryAfterMs?: number }
  observation?: { fresh: boolean; activeSeconds: number; trafficMiB: number; mbps: number | null;
    requiredActiveSeconds: number; requiredTrafficMiB: number; suspectMbps: number; positiveUntil: number }
  sample?: { startedAt: number; elapsedMs: number; delayMs: number | null; mbps: number | null; bytes: number; valid: boolean; sampleMs?: number; warmupMs?: number }
  comparison?: ProcessComparison
  screening?: { currentLow: number; bestCandidateLoss: number; uncertainty: number; threshold: number; delayLimit: number; delayMs: number }
  protection?: { recentSwitches: number; maxSwitches: number; holdUntil: number; limitUntil: number; severe: boolean }
  budget?: { hourBytes: number; dayBytes: number; hourLimit: number; dayLimit: number; hourReserve: number; dayReserve: number; urgent: boolean; searchBytes: number; searchLimit: number }
}
export type ProcessRoundSummary = {
  id: string; startedAt: number; updatedAt: number; endedAt: number | null; current: string; trigger: string; reason: string
  nodes: { name: string; preferred: boolean }[]; truncated: boolean; bytes: number; eventCount: number
}
export type ProcessRound = Omit<ProcessRoundSummary, 'bytes' | 'eventCount'> & {
  scope: string; group: string; generation: string; settings: BandwidthSettings; events: ProcessEvent[]
}
export type ProcessResponse = {
  since: number | null; evicted: boolean; error: boolean; rounds: ProcessRoundSummary[]; detail: ProcessRound | null; status: AutomaticStatus
}

export type ProcessTraceRow = { key: number; event: ProcessEvent; context?: ProcessEvent; startedAt: number; endedAt: number }

/** Only join an action start to its immediately following result; never hide intervening decisions. */
export function processTraceRows(events: ProcessEvent[]): ProcessTraceRow[] {
  const rows: ProcessTraceRow[] = []
  for (let index = 0; index < events.length; index++) {
    const key = index, event = events[index]!, next = events[index + 1]
    const result = event.kind === 'state' && next && event.node === next.node
      && ((event.reason === 'screening-latency' && next.kind === 'probe') || (event.reason === 'collecting' && next.kind === 'sample'))
    if (result) {
      rows.push({ key, event: next, context: event, startedAt: event.at, endedAt: Math.max(next.at, next.until) })
      index++
    } else rows.push({ key, event, startedAt: event.sample?.startedAt ?? event.at, endedAt: Math.max(event.at, event.until) })
  }
  return rows
}

export function processRelativeTime(at: number, start: number) {
  const seconds = Math.max(0, Math.floor((at - start) / 1000))
  return `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`
}

export function processAction(event: ProcessEvent) {
  if (event.kind !== 'state') return ['trigger', 'probe', 'sample', 'comparison', 'excluded', 'end'].includes(event.kind) ? event.kind : 'state'
  if (event.reason === 'screening-latency') return 'probe'
  if (event.reason === 'collecting') return 'sample'
  if (['bandwidth-improvement', 'preferred-restored', 'failure-recovery', 'faster-candidate'].includes(event.reason)) return 'switch'
  if (['configuration-changed', 'probe-target-changed', 'evidence-expired'].includes(event.reason)) return 'invalidate'
  if (event.reason === 'current-sufficient') return 'verify'
  if (event.reason === 'would-switch') return 'observe'
  return 'wait'
}

export function processSampleLoss(sample: ProcessSample, settings: BandwidthSettings) {
  const delay = sample.delayMs / 1000
  const shortfall = Number(settings.shortageSeconds) * Math.max(0, Number(settings.targetMbps) / sample.mbps - 1)
  return { delay, shortfall, total: delay + shortfall }
}

// Reuse the existing explanations so the overview and process never disagree on a reason.
const existingReasons: Record<string, string> = {
  'waiting-traffic': 'coco.anWaitingForEvidenceOfSustainedSlow', 'waiting-idle': 'coco.anWaitingForIdleTrafficOrA',
  'budget-exhausted': 'coco.anAutomaticCheckBudgetIsInsufficientKeeping', 'measurement-unavailable': 'coco.anDownloadValidationServiceIsUnavailableNode',
  collecting: 'coco.anCollectingValidSamplesForTheCurrent', 'current-sufficient': 'coco.anCurrentLatencyIsNormalAndThroughput',
  'no-candidate': 'coco.anNoComparableCandidates', 'candidate-unavailable': 'coco.anTheCandidateFailedTheLightweightCheck',
  'sample-unknown': 'coco.anSamplesAreInvalidOrInsufficientThe', 'no-clear-gain': 'coco.anImprovementAfterVariationAndCostsIs',
  'would-switch': 'coco.anObservationModeSwitchingCriteriaMetBut', 'bandwidth-improvement': 'coco.anNetBenefitConfirmedThroughputPerformanceSwitch',
  'switch-limit': 'coco.anTheHoldPeriodOrRecentSwitch', 'latency-priority': 'coco.anLatencyChecksOrFailureRecoveryTake',
  'latency-pressure': 'coco.anResponseLatencyIncreasedDownloadValidationStopped', 'business-busy': 'coco.anBusinessTrafficIncreasedDownloadValidationStopped',
  'configuration-changed': 'coco.anConfigurationOrRunGenerationChangedOld', 'selection-conflict': 'coco.anStateChangedBeforeSwitchingNoSwitch',
  'storage-unavailable': 'coco.anBudgetLedgerIsUnavailableAutomaticDownloads', 'screening-latency': 'coco.anScreeningCandidateLatencyWithLightweightChecks',
  'waiting-sample': 'coco.anReusingExistingEvidenceWaitingForThe', 'search-yield': 'coco.anContinuousSearchReachedItsTrafficOr',
  'pool-backoff': 'coco.anCandidatesCurrentlyOfferInsufficientBenefitWaiting', 'no-potential-gain': 'coco.anEvenTargetThroughputWouldOfferInsufficient',
  'shortfall-guard': 'coco.anTheCandidateWouldIntroduceOrWorsen', 'post-switch-failure': 'coco.anTheNodeFailedShortlyAfterSwitching',
  'waiting-evidence': 'coco.anWaitingForFreshEvidence', 'evidence-ready': 'coco.anValidEvidenceObtained',
}
export function processReason(reason: string, t: (key: string) => string) {
  return t(existingReasons[reason] ?? `coco.process.reason.${reason}`)
}
