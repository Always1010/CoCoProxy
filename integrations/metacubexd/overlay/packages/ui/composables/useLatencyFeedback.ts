export type LatencyFailureReason = 'probe_denied' | 'timeout' | 'failed'

export type LatencyFeedback =
  | { state: 'idle' }
  | { state: 'testing' }
  | { state: 'success'; delay: number }
  | { state: 'failure'; reason: LatencyFailureReason }

export interface LatencySummary {
  total: number
  completed: number
  succeeded: number
  timedOut: number
  failed: number
  denied: number
  running: boolean
}

const emptySummary = (): LatencySummary => ({
  total: 0,
  completed: 0,
  succeeded: 0,
  timedOut: 0,
  failed: 0,
  denied: 0,
  running: false,
})

export function useLatencyFeedback() {
  const { t } = useNuxtApp().$i18n
  function describeLatencyFailure(reason: LatencyFailureReason): string {
    if (reason === 'probe_denied') return t('coco.probeDenied')
    if (reason === 'timeout') return t('coco.probeTimeout')
    return t('coco.probeFailed')
  }

  function shortLatencyFailure(reason: LatencyFailureReason): string {
    if (reason === 'probe_denied') return t('coco.notEnabled')
    if (reason === 'timeout') return t('coco.timeout')
    return t('coco.failed')
  }

  const nodeFeedback = useState<Record<string, LatencyFeedback>>(
    'cocoproxy-latency-feedback',
    () => ({}),
  )
  const beginNode = (name: string) => {
    nodeFeedback.value[name] = { state: 'testing' }
  }
  const succeedNode = (name: string, delay: number) => {
    nodeFeedback.value[name] = { state: 'success', delay }
  }
  const failNode = (name: string, reason: LatencyFailureReason) => {
    nodeFeedback.value[name] = { state: 'failure', reason }
  }
  const feedbackForNode = (name: string): LatencyFeedback =>
    nodeFeedback.value[name] ?? { state: 'idle' }

  return {
    nodeFeedback,
    beginNode,
    succeedNode,
    failNode,
    feedbackForNode,
    emptySummary,
    describeLatencyFailure,
    shortLatencyFailure,
  }
}
