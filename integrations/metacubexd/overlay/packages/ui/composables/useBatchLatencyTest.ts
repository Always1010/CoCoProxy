import { toast } from 'vue-sonner'
import { useLatencyFeedback, type LatencyFailureReason } from './useLatencyFeedback'
import { latencyFailureReason, useRequest } from './useApi'
import { useCoCoProxy } from './useCoCoProxy'
import { useWorkspace } from './useWorkspace'
import { latencyProbeKey, runLatencyBatch } from '../utils/latencyBatch'

declare function useI18n(): { t: (key: string, named?: object) => string }

const BATCH_DELAY = 200
const PROVIDER_HEALTHCHECK_CONCURRENCY = 3

export interface BatchTestOptions {
  url: string
  timeout: number
  onProgress?: (completed: number, total: number, current: string) => void
  onNodeComplete?: (nodeName: string, delay: number) => void
}

type Probe = { name: string; url: string; timeout: number; key: string }
type ProbeResult = { delay: number; reason?: LatencyFailureReason }

export function useBatchLatencyTest() {
  const configStore = useConfigStore()
  const proxiesStore = useProxiesStore()
  const nodeRecommendationStore = useNodeRecommendationStore()
  const latencyFeedback = useLatencyFeedback()
  const { generation, session } = useCoCoProxy()
  const { view } = useWorkspace()
  const { t } = useI18n()
  const isRunning = ref(false)
  const progress = ref({ completed: 0, total: 0, current: '' })
  const inFlight = ref<Record<string, { name: string; url: string }>>({})
  const activeProbes = computed(() => Object.values(inFlight.value))
  const groupJobs = ref<{ name: string; keys: string[] }[]>([])
  const completedKeys = ref(new Set<string>())
  const groupProgress = computed(() => ({
    total: groupJobs.value.length,
    completed: groupJobs.value.filter(group => group.keys.every(key => completedKeys.value.has(key))).length,
    active: groupJobs.value.filter(group => group.keys.some(key => !!inFlight.value[key])).map(group => group.name),
  }))
  const abortController = ref<AbortController | null>(null)
  const abortTest = () => abortController.value?.abort()
  watch([generation, session], abortTest, { flush: 'sync' })
  onBeforeUnmount(abortTest)

  const identity = (name: string) =>
    view.value?.tcpNodes?.find(node => node.name === name)?.fingerprint ?? name
  const makeProbe = (name: string, url: string, timeout: number): Probe => ({
    name, url, timeout,
    key: latencyProbeKey(generation.value, identity(name), name, url, timeout),
  })

  // Expand nested groups once, avoiding cycles. Only individual node requests
  // enter the shared worker pool; the core group endpoint has unbounded fanout.
  const groupMembers = (name: string, visiting = new Set<string>()): string[] => {
    if (visiting.has(name)) return []
    const group = proxiesStore.proxies.find(group => group.name === name)
    if (!group) return /^(REJECT|REJECT-DROP|PASS|COMPATIBLE)$/i.test(name) ? [] : [name]
    const path = new Set(visiting).add(name)
    return [...new Set((group.all ?? []).flatMap(member => groupMembers(member, path)))]
  }

  const refreshProxies = async () => {
    try { await proxiesStore.fetchProxies() }
    catch (error) { console.warn('Latency results were recorded but proxy refresh failed', error) }
  }

  // One continuously replenished pool for the whole operation, including all
  // groups. A slow node occupies one slot, never a complete ten-node batch.
  const runProbes = async (input: Probe[], options?: Partial<BatchTestOptions>, groups: { name: string; keys: string[] }[] = []) => {
    const jobs = [...new Map(input.map(job => [job.key, job])).values()]
    const results = new Map<string, ProbeResult>()
    if (isRunning.value) return results
    const controller = new AbortController()
    const signal = controller.signal
    const runGeneration = generation.value
    const runSession = session.value
    const request = useRequest()
    const current = () => !signal.aborted && generation.value === runGeneration && session.value === runSession
    const touched = new Set<string>()
    abortController.value = controller
    isRunning.value = true
    inFlight.value = {}
    groupJobs.value = groups
    completedKeys.value = new Set()
    progress.value = { completed: 0, total: jobs.length, current: '' }
    nodeRecommendationStore.batchTestProgress = { total: jobs.length, completed: 0, current: null, isRunning: true }
    try {
      await runLatencyBatch(jobs, signal, async job => {
          // A changed node must never inherit the old identity's measurement.
          if (makeProbe(job.name, job.url, job.timeout).key !== job.key) return
          touched.add(job.name)
          latencyFeedback.beginNode(job.name)
          progress.value.current = job.name
          nodeRecommendationStore.batchTestProgress.current = job.name
          inFlight.value[job.key] = { name: job.name, url: job.url }
          let result: ProbeResult
          try {
            const response = await request.get(`proxies/${encodeURIComponent(job.name)}/delay`, {
              searchParams: { url: job.url, timeout: job.timeout }, signal,
              timeout: Math.max(20_000, job.timeout + 10_000),
            }).json<{ delay: number }>()
            result = response.delay > 0 && Number.isFinite(response.delay)
              ? { delay: response.delay } : { delay: 0, reason: 'failed' }
          } catch (error) { result = { delay: 0, reason: latencyFailureReason(error) } }
          finally { delete inFlight.value[job.key] }
          if (!current() || makeProbe(job.name, job.url, job.timeout).key !== job.key) return
          results.set(job.key, result)
          completedKeys.value.add(job.key)
          proxiesStore.recordLatencyTestResult?.(job.name, job.url, result.delay)
          nodeRecommendationStore.recordTestResult(job.name, result.delay > 0 ? result.delay : null, result.delay > 0)
          if (result.reason) latencyFeedback.failNode(job.name, result.reason)
          else latencyFeedback.succeedNode(job.name, result.delay)
          progress.value.completed++
          nodeRecommendationStore.batchTestProgress.completed++
          options?.onProgress?.(progress.value.completed, jobs.length, job.name)
          options?.onNodeComplete?.(job.name, result.delay)
      }, current)
      if (current()) await refreshProxies()
    } finally {
      for (const name of touched)
        if (latencyFeedback.feedbackForNode(name).state === 'testing')
          delete latencyFeedback.nodeFeedback.value[name]
      isRunning.value = false
      inFlight.value = {}
      progress.value.current = ''
      nodeRecommendationStore.batchTestProgress = { total: jobs.length, completed: progress.value.completed, current: null, isRunning: false }
      abortController.value = null
    }
    return results
  }

  const batchTestNodes = async (nodeNames: string[], options: BatchTestOptions): Promise<Record<string, number>> => {
    const jobs = nodeNames.map(name => makeProbe(name, options.url, options.timeout))
    const results = await runProbes(jobs, options)
    return Object.fromEntries(jobs.filter(job => results.has(job.key)).map(job => [job.name, results.get(job.key)!.delay]))
  }

  const testMultipleGroups = async (groupNames: string[], options?: Partial<BatchTestOptions>): Promise<Record<string, Record<string, number>>> => {
    if (isRunning.value) return {}
    const startedGeneration = generation.value
    const startedSession = session.value
    const groups = [...new Set(groupNames)].map(name => {
      const group = proxiesStore.proxies.find(group => group.name === name)
      const url = options?.url ?? configStore.resolveLatencyTestUrl(group?.testUrl)
      const timeout = options?.timeout ?? configStore.latencyTestTimeoutDuration
      return { name, jobs: group ? groupMembers(name).map(member => makeProbe(member, url, timeout)) : [] }
    })
    const results = await runProbes(groups.flatMap(group => group.jobs), options,
      groups.map(group => ({ name: group.name, keys: group.jobs.map(job => job.key) })))
    const allResults = Object.fromEntries(groups.map(group => [group.name,
      Object.fromEntries(group.jobs.filter(job => results.has(job.key)).map(job => [job.name, results.get(job.key)!.delay])),
    ]))
    // Cancellation or a generation change must not claim completion or success.
    if (progress.value.completed < progress.value.total || generation.value !== startedGeneration || session.value !== startedSession) return allResults
    const succeeded = Object.values(allResults).filter(values => Object.values(values).some(delay => delay > 0)).length
    if (succeeded === groups.length) toast.success(`测延迟完成：${succeeded}/${groups.length} 个策略组成功`)
    else {
      const failures = [...results.values()]
      const reason = failures.some(result => result.reason === 'probe_denied') ? 'probe_denied'
        : failures.some(result => result.reason === 'timeout') ? 'timeout' : 'failed'
      toast.error(`测延迟完成：${succeeded}/${groups.length} 个策略组成功`, { description: latencyFeedback.describeLatencyFailure(reason) })
    }
    return allResults
  }

  const testGroupNodes = async (groupName: string, options?: Partial<BatchTestOptions>): Promise<Record<string, number>> => {
    const results = await testMultipleGroups([groupName], options)
    return results[groupName] ?? {}
  }

  // Health-check every proxy provider. Distinct from "test all groups" (which
  // walks proxy GROUPS) and "update all providers" (which re-downloads them):
  // this fires a latency/health probe across every provider's member nodes.
  //
  // Each provider's own member fan-out is bounded inside
  // proxyProviderLatencyTest; here we additionally bound how many providers run
  // concurrently. Per-provider failures are surfaced via toast (never silently
  // swallowed) and do not abort the remaining providers.
  const healthCheckAllProviders = async (): Promise<void> => {
    if (isRunning.value) return
    const providerNames = proxiesStore.proxyProviders.map(
      (provider) => provider.name,
    )
    if (providerNames.length === 0) return

    groupJobs.value = []
    completedKeys.value = new Set()
    isRunning.value = true
    nodeRecommendationStore.batchTestProgress = {
      total: providerNames.length,
      completed: 0,
      current: null,
      isRunning: true,
    }

    const failed: string[] = []

    try {
      for (
        let i = 0;
        i < providerNames.length;
        i += PROVIDER_HEALTHCHECK_CONCURRENCY
      ) {
        const batch = providerNames.slice(
          i,
          i + PROVIDER_HEALTHCHECK_CONCURRENCY,
        )

        await Promise.all(
          batch.map(async (providerName) => {
            nodeRecommendationStore.batchTestProgress.current = providerName
            try {
              const result = await proxiesStore.proxyProviderLatencyTest(
                providerName,
              )
              if (result && result.succeeded < result.total)
                failed.push(providerName)
            } catch (e) {
              failed.push(providerName)
              console.error(
                `health-check failed for provider "${providerName}"`,
                e,
              )
            } finally {
              nodeRecommendationStore.batchTestProgress.completed++
            }
          }),
        )

        // Delay between batches (except for the last batch)
        if (i + PROVIDER_HEALTHCHECK_CONCURRENCY < providerNames.length) {
          await new Promise((resolve) => setTimeout(resolve, BATCH_DELAY))
        }
      }

      if (failed.length > 0) {
        toast.error(t('providerHealthCheckFailed'), {
          description: failed.join(', '),
        })
      } else {
        toast.success(t('providerHealthCheckSuccess'))
      }
    } finally {
      isRunning.value = false
      nodeRecommendationStore.batchTestProgress = {
        total: providerNames.length,
        completed: providerNames.length,
        current: null,
        isRunning: false,
      }
    }
  }

  return {
    isRunning,
    progress,
    activeProbes,
    groupProgress,
    batchTestNodes,
    testGroupNodes,
    testMultipleGroups,
    healthCheckAllProviders,
    abortTest,
  }
}
