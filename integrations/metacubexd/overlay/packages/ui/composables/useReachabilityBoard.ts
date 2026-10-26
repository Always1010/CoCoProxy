import { LatencyTestError, useRequest } from './useApi'
import { useCoCoProxy } from './useCoCoProxy'

export interface ReachabilityTarget { name: string; url: string }
export type ReachabilityStatus = 'testing' | 'cancelled' | 'success' | 'unreachable' | 'denied' | 'timeout' | 'busy' | 'unavailable' | 'error'
export interface ReachabilityResult {
  status: ReachabilityStatus
  reachable: boolean
  latency: number | null
  nodeName: string
  url: string
  checkedAt: number | null
}
export interface ReachabilityTestOptions {
  timeout?: number
  allowedOrigins?: readonly string[]
}

// Match the controller's default permission; other sites remain visible even
// when the deployment does not permit probing them.
export const CONNECTIVITY_TARGETS: ReachabilityTarget[] = [
  { name: 'Google', url: 'https://www.gstatic.com/generate_204' },
  { name: 'Cloudflare', url: 'https://cp.cloudflare.com/generate_204' },
  { name: 'GitHub', url: 'https://github.com' },
]
export const STREAMING_UNLOCK_TARGETS: ReachabilityTarget[] = [
  { name: 'YouTube', url: 'https://www.youtube.com/generate_204' },
  { name: 'Netflix', url: 'https://www.netflix.com' },
  { name: 'Disney+', url: 'https://www.disneyplus.com' },
  { name: 'OpenAI', url: 'https://chat.openai.com' },
  { name: 'Gemini', url: 'https://gemini.google.com' },
]

export const reachabilityLabels: Record<ReachabilityStatus, string> = {
  testing: '检测中', cancelled: '已取消',
  success: '可达', unreachable: '不可达', denied: '未获检测许可', timeout: '检测超时',
  busy: '检测忙，请稍后重试', unavailable: '核心暂不可用，请刷新', error: '检测失败，请重试',
}
export function useReachabilityBoard() {
  const { generation, session } = useCoCoProxy()
  const isRunning = ref(false)
  const results = ref<Record<string, ReachabilityResult>>({})
  const context = ref<{ nodeName: string; generation: string | null; startedAt: number; completedAt: number | null } | null>(null)
  const progress = computed(() => ({
    completed: Object.values(results.value).filter(result => result.status !== 'testing').length,
    total: Object.keys(results.value).length,
  }))
  const currentTargets = computed(() => Object.entries(results.value)
    .filter(([, result]) => result.status === 'testing')
    .map(([name, result]) => ({ name, url: result.url })))
  let controller: AbortController | undefined

  function cancel() {
    controller?.abort()
    controller = undefined
    for (const result of Object.values(results.value)) {
      if (result.status === 'testing') { result.status = 'cancelled'; result.checkedAt = Date.now() }
    }
    if (context.value) context.value.completedAt = Date.now()
    isRunning.value = false
  }
  function reset() {
    cancel()
    results.value = {}
    context.value = null
  }
  watch([generation, session], reset, { flush: 'sync' })
  onBeforeUnmount(reset)

  async function testTargetsThroughNode(nodeName: string, targets: ReachabilityTarget[], options: ReachabilityTestOptions = {}) {
    if (!nodeName || !targets.length || isRunning.value) return {}
    const run = new AbortController()
    controller = run
    const runGeneration = generation.value
    const runSession = session.value
    const current = () => controller === run && !run.signal.aborted && generation.value === runGeneration && session.value === runSession
    const entry = (target: ReachabilityTarget, status: ReachabilityStatus, latency: number | null = null): ReachabilityResult => ({
      status, reachable: status === 'success', latency, nodeName, url: target.url, checkedAt: status === 'testing' ? null : Date.now(),
    })
    results.value = Object.fromEntries(targets.map(target => [target.name, entry(target,
      options.allowedOrigins && !options.allowedOrigins.includes(new URL(target.url).origin) ? 'denied' : 'testing')]))
    context.value = { nodeName, generation: runGeneration, startedAt: Date.now(), completedAt: null }
    isRunning.value = true
    const timeout = options.timeout ?? 5000
    try {
      await Promise.all(targets.map(async target => {
        if (!current() || results.value[target.name]?.status === 'denied') return
        let result: ReachabilityResult
        try {
          const { delay } = await useRequest().get(`proxies/${encodeURIComponent(nodeName)}/delay`, {
            searchParams: { url: target.url, timeout }, timeout: Math.max(10_000, timeout + 5000),
            signal: run.signal,
          }).json<{ delay: number }>()
          result = Number.isFinite(delay) && delay > 0
            ? entry(target, 'success', delay) : entry(target, 'unreachable')
        } catch (error) {
          result = entry(target, error instanceof LatencyTestError
            ? error.reason === 'probe_denied' ? 'denied'
              : error.reason === 'timeout' ? 'timeout'
                : error.code === 'CONTROLLER_PROBE_BUSY' ? 'busy'
                  : ['CONTROLLER_UNAVAILABLE', 'CONTROLLER_GENERATION_CONFLICT', 'ACTIVE_CONFLICT'].includes(error.code ?? '') ? 'unavailable' : 'error'
            : error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'error')
        }
        if (current()) results.value[target.name] = result
      }))
      return current() ? { ...results.value } : {}
    } finally {
      if (current()) {
        isRunning.value = false
        if (context.value) context.value.completedAt = Date.now()
        controller = undefined
      }
    }
  }
  return { isRunning, results, context, progress, currentTargets, cancel, reset, testTargetsThroughNode }
}
