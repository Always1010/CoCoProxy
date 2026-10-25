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

function describeLatencyFailure(reason: LatencyFailureReason): string {
  if (reason === 'probe_denied') return '延迟测试未启用，或测试地址未获许可。'
  if (reason === 'timeout') return '节点延迟测试超时。'
  return '节点延迟测试失败，请检查核心与节点状态。'
}

function shortLatencyFailure(reason: LatencyFailureReason): string {
  if (reason === 'probe_denied') return '未启用'
  if (reason === 'timeout') return '超时'
  return '失败'
}

export function useLatencyFeedback() {
  const nodeFeedback = useState<Record<string, LatencyFeedback>>(
    'coproxy-latency-feedback',
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
