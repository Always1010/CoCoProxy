import { LatencyTestError, useRequest } from './useApi'

export interface ReachabilityTarget { name: string; url: string }
export type ReachabilityStatus = 'success' | 'unreachable' | 'denied' | 'timeout' | 'busy' | 'unavailable' | 'error'
export interface ReachabilityResult {
  status: ReachabilityStatus
  reachable: boolean
  latency: number | null
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
  success: '可达', unreachable: '不可达', denied: '未获检测许可', timeout: '检测超时',
  busy: '检测忙，请稍后重试', unavailable: '核心暂不可用，请刷新', error: '检测失败，请重试',
}
const failed = (status: ReachabilityStatus): ReachabilityResult => ({ status, reachable: false, latency: null })

export function useReachabilityBoard() {
  const isRunning = ref(false)
  const results = ref<Record<string, ReachabilityResult>>({})

  async function testTargetsThroughNode(nodeName: string, targets: ReachabilityTarget[], options: ReachabilityTestOptions = {}) {
    if (!nodeName || !targets.length || isRunning.value) return {}
    isRunning.value = true
    results.value = {}
    const timeout = options.timeout ?? 5000
    try {
      await Promise.all(targets.map(async target => {
        let result: ReachabilityResult
        if (options.allowedOrigins && !options.allowedOrigins.includes(new URL(target.url).origin)) {
          result = failed('denied')
        } else try {
          const { delay } = await useRequest().get(`proxies/${encodeURIComponent(nodeName)}/delay`, {
            searchParams: { url: target.url, timeout }, timeout: Math.max(10_000, timeout + 5000),
          }).json<{ delay: number }>()
          result = Number.isFinite(delay) && delay > 0
            ? { status: 'success', reachable: true, latency: delay } : failed('unreachable')
        } catch (error) {
          result = failed(error instanceof LatencyTestError
            ? error.reason === 'probe_denied' ? 'denied'
              : error.reason === 'timeout' ? 'timeout'
                : error.code === 'CONTROLLER_PROBE_BUSY' ? 'busy'
                  : ['CONTROLLER_UNAVAILABLE', 'CONTROLLER_GENERATION_CONFLICT', 'ACTIVE_CONFLICT'].includes(error.code ?? '') ? 'unavailable' : 'error'
            : error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'error')
        }
        results.value[target.name] = result
      }))
      return { ...results.value }
    } finally { isRunning.value = false }
  }
  return { isRunning, results, testTargetsThroughNode }
}
