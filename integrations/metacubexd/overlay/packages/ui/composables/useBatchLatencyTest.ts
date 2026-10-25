import { toast } from 'vue-sonner'
import { useLatencyFeedback } from './useLatencyFeedback'
import {
  latencyFailureReason,
  proxyGroupLatencyTestAPI,
  useRequest,
} from './useApi'

// `useI18n` is auto-imported by @nuxtjs/i18n (no explicit import). In unit
// tests it is provided as a global stub via test/setup.ts.
declare function useI18n(): { t: (key: string, named?: object) => string }

// Batch test configuration
const BATCH_SIZE = 10 // Max concurrent tests
const BATCH_DELAY = 200 // Delay between batches in ms
// How many providers to health-check concurrently. Each provider already fans
// out to its own member nodes (bounded inside proxyProviderLatencyTest), so we
// keep the outer fan-out small to avoid flooding the kernel.
const PROVIDER_HEALTHCHECK_CONCURRENCY = 3

function waitForBatchDelay(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve()

  return new Promise((resolve) => {
    const timeoutId = setTimeout(() => {
      signal?.removeEventListener('abort', resolveDelay)
      resolve()
    }, BATCH_DELAY)

    function resolveDelay() {
      clearTimeout(timeoutId)
      signal?.removeEventListener('abort', resolveDelay)
      resolve()
    }

    signal?.addEventListener('abort', resolveDelay, { once: true })
  })
}

export interface BatchTestOptions {
  url: string
  timeout: number
  onProgress?: (completed: number, total: number, current: string) => void
  onNodeComplete?: (nodeName: string, delay: number) => void
}

export function useBatchLatencyTest() {
  const configStore = useConfigStore()
  const proxiesStore = useProxiesStore()
  const nodeRecommendationStore = useNodeRecommendationStore()
  const latencyFeedback = useLatencyFeedback()
  const { t } = useI18n()

  const isRunning = ref(false)
  const progress = ref({ completed: 0, total: 0, current: '' })
  const abortController = ref<AbortController | null>(null)

  // Test a single proxy node
  const testSingleNode = async (
    proxyName: string,
    url: string,
    timeout: number,
    signal?: AbortSignal,
  ): Promise<{ proxyName: string; delay: number }> => {
    try {
      const request = useRequest()
      const result = await request
        .get(`proxies/${encodeURIComponent(proxyName)}/delay`, {
          searchParams: { url, timeout },
          signal,
          // Client timeout must exceed the backend per-node budget + network
          // overhead, else ky aborts a slow-but-valid probe before the kernel
          // answers and the node always reads as failed (#2041).
          timeout: Math.max(20_000, timeout + 10_000),
        })
        .json<{ delay: number }>()
      return { proxyName, delay: result.delay }
    } catch {
      return { proxyName, delay: 0 } // 0 indicates failure
    }
  }

  // Test a proxy group (uses backend batch API)
  const testProxyGroup = async (
    groupName: string,
    url: string,
    timeout: number,
  ): Promise<Record<string, number>> => {
    return proxyGroupLatencyTestAPI(groupName, url, timeout)
  }

  // Batch test multiple nodes with concurrency control
  const batchTestNodes = async (
    nodeNames: string[],
    options: BatchTestOptions,
  ): Promise<Record<string, number>> => {
    const { url, timeout, onProgress, onNodeComplete } = options
    const results: Record<string, number> = {}

    isRunning.value = true
    progress.value = { completed: 0, total: nodeNames.length, current: '' }
    abortController.value = new AbortController()

    // Update store progress
    proxiesStore.clearLatencyTestStateForNodes?.(nodeNames, url)
    nodeRecommendationStore.batchTestProgress = {
      total: nodeNames.length,
      completed: 0,
      current: null,
      isRunning: true,
    }

    try {
      // Process in batches
      for (let i = 0; i < nodeNames.length; i += BATCH_SIZE) {
        // Check if aborted
        if (abortController.value?.signal.aborted) {
          break
        }

        const batch = nodeNames.slice(i, i + BATCH_SIZE)

        // Test batch concurrently
        const batchPromises = batch.map(async (nodeName) => {
          progress.value.current = nodeName
          nodeRecommendationStore.batchTestProgress.current = nodeName

          const result = await testSingleNode(
            nodeName,
            url,
            timeout,
            abortController.value?.signal,
          )
          results[nodeName] = result.delay
          proxiesStore.recordLatencyTestResult?.(nodeName, url, result.delay)

          progress.value.completed++
          nodeRecommendationStore.batchTestProgress.completed++

          onProgress?.(progress.value.completed, nodeNames.length, nodeName)
          onNodeComplete?.(nodeName, result.delay)

          // Record result in store
          nodeRecommendationStore.recordTestResult(
            nodeName,
            result.delay > 0 ? result.delay : null,
            result.delay > 0,
          )

          return result
        })

        await Promise.all(batchPromises)

        // Delay between batches (except for last batch)
        if (
          i + BATCH_SIZE < nodeNames.length &&
          !abortController.value?.signal.aborted
        ) {
          await waitForBatchDelay(abortController.value?.signal)
        }
      }
    } finally {
      isRunning.value = false
      progress.value.current = ''
      nodeRecommendationStore.batchTestProgress = {
        total: nodeNames.length,
        completed: progress.value.completed,
        current: null,
        isRunning: false,
      }
      abortController.value = null

      // Refresh proxy data so UI shows latest latency
      await proxiesStore.fetchProxies()
    }

    return results
  }

  // Test all nodes in a proxy group using batch API
  const testGroupNodes = async (
    groupName: string,
    options?: Partial<BatchTestOptions>,
    // When false, the caller (e.g. testMultipleGroups) owns the shared
    // `isRunning` / `batchTestProgress` state; this call must not touch it,
    // otherwise its finally-block would reset the global progress mid-run.
    manageGlobalProgress = true,
  ): Promise<Record<string, number>> => {
    // Resolve the per-group test url so "test all" honors latencyTestUrlSource
    // (#2082): in 'core' mode each group probes against its own kernel testUrl
    // instead of the single dashboard url shared by every group.
    const group = proxiesStore.proxies.find((g) => g.name === groupName)
    const url =
      options?.url ?? configStore.resolveLatencyTestUrl(group?.testUrl)
    const timeout = options?.timeout ?? configStore.latencyTestTimeoutDuration

    // Preserve the last successful values while the spinner is visible. A
    // failed attempt gets its own explicit status instead of erasing the last
    // known measurement back to "---".
    for (const memberName of group?.all ?? [])
      latencyFeedback.beginNode(memberName)
    if (manageGlobalProgress) {
      isRunning.value = true
      nodeRecommendationStore.batchTestProgress = {
        total: 1,
        completed: 0,
        current: groupName,
        isRunning: true,
      }
    }

    try {
      const results = await testProxyGroup(groupName, url, timeout)

      // Record whatever we got. recordBatchResults / recordLatencyTestResults
      // are no-ops on empty input, so an empty `{}` cleanly means "preserve
      // existing state".
      nodeRecommendationStore.recordBatchResults(results)

      // Refresh proxy data so UI shows latest latency. Don't propagate a
      // fetch failure — that would abort the surrounding `testMultipleGroups`
      // loop and leave the global testing flag stuck.
      try {
        await proxiesStore.fetchProxies()
      } catch (error) {
        console.warn('Latency results were recorded but proxy refresh failed', error)
      }
      proxiesStore.recordLatencyTestResults?.(results, url)

      for (const memberName of group?.all ?? []) {
        const delay = results[memberName]
        if ((delay ?? 0) > 0) latencyFeedback.succeedNode(memberName, delay!)
        else latencyFeedback.failNode(memberName, 'failed')
      }

      return results
    } catch (error) {
      const reason = latencyFailureReason(error)
      for (const memberName of group?.all ?? [])
        latencyFeedback.failNode(memberName, reason)
      if (manageGlobalProgress)
        toast.error('测延迟失败', {
          description: latencyFeedback.describeLatencyFailure(reason),
        })
      throw error
    } finally {
      if (manageGlobalProgress) {
        isRunning.value = false
        nodeRecommendationStore.batchTestProgress = {
          total: 1,
          completed: 1,
          current: null,
          isRunning: false,
        }
      }
    }
  }

  // Test multiple groups sequentially
  const testMultipleGroups = async (
    groupNames: string[],
    options?: Partial<BatchTestOptions>,
  ): Promise<Record<string, Record<string, number>>> => {
    const allResults: Record<string, Record<string, number>> = {}
    let failedGroups = 0
    let deniedGroups = 0
    let timedOutGroups = 0

    isRunning.value = true
    nodeRecommendationStore.batchTestProgress = {
      total: groupNames.length,
      completed: 0,
      current: null,
      isRunning: true,
    }

    try {
      for (let i = 0; i < groupNames.length; i++) {
        const groupName = groupNames[i]
        if (!groupName) continue

        nodeRecommendationStore.batchTestProgress.current = groupName
        nodeRecommendationStore.batchTestProgress.completed = i

        try {
          const results = await testGroupNodes(groupName, options, false)
          allResults[groupName] = results
          if (!Object.values(results).some((delay) => delay > 0)) failedGroups++
        } catch (error) {
          allResults[groupName] = {}
          failedGroups++
          const reason = latencyFailureReason(error)
          if (reason === 'probe_denied') deniedGroups++
          if (reason === 'timeout') timedOutGroups++
        }

        // Delay between groups
        if (i < groupNames.length - 1) {
          await new Promise((resolve) => setTimeout(resolve, BATCH_DELAY))
        }
      }
    } finally {
      isRunning.value = false
      nodeRecommendationStore.batchTestProgress = {
        total: groupNames.length,
        completed: groupNames.length,
        current: null,
        isRunning: false,
      }
    }

    const succeeded = groupNames.length - failedGroups
    if (failedGroups === 0)
      toast.success(`测延迟完成：${succeeded}/${groupNames.length} 个策略组成功`)
    else
      toast.error(`测延迟完成：${succeeded}/${groupNames.length} 个策略组成功`, {
        description: deniedGroups
          ? latencyFeedback.describeLatencyFailure('probe_denied')
          : timedOutGroups
            ? latencyFeedback.describeLatencyFailure('timeout')
            : latencyFeedback.describeLatencyFailure('failed'),
      })

    return allResults
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
    const providerNames = proxiesStore.proxyProviders.map(
      (provider) => provider.name,
    )
    if (providerNames.length === 0) return

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

  // Abort ongoing test
  const abortTest = () => {
    abortController.value?.abort()
  }

  return {
    isRunning,
    progress,
    batchTestNodes,
    testGroupNodes,
    testMultipleGroups,
    healthCheckAllProviders,
    abortTest,
  }
}
