import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { useBatchLatencyTest } from '../useBatchLatencyTest'

const mocks = vi.hoisted(() => ({
  api: null as any, proxies: null as any, recommendation: null as any, feedback: null as any,
  get: vi.fn(), success: vi.fn(), error: vi.fn(),
}))
vi.mock('../useApi', () => ({ useRequest: () => ({ get: mocks.get }), latencyFailureReason: () => 'failed' }))
vi.mock('../useCoCoProxy', () => ({ useCoCoProxy: () => mocks.api }))
vi.mock('../useWorkspace', () => ({ useWorkspace: () => ({ view: ref(null) }) }))
vi.mock('../useLatencyFeedback', () => ({ useLatencyFeedback: () => ({
  nodeFeedback: mocks.feedback,
  beginNode: (name: string) => { mocks.feedback.value[name] = { state: 'testing' } },
  succeedNode: (name: string) => { mocks.feedback.value[name] = { state: 'success' } },
  failNode: (name: string) => { mocks.feedback.value[name] = { state: 'failure' } },
  feedbackForNode: (name: string) => mocks.feedback.value[name] ?? { state: 'idle' },
  describeLatencyFailure: () => 'failed',
}) }))
vi.mock('vue-sonner', () => ({ toast: { success: mocks.success, error: mocks.error } }))

describe('batch latency progress', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.api = { generation: ref('generation-one'), session: ref({ username: 'synthetic' }) }
    mocks.proxies = { proxies: [], recordLatencyTestResult: vi.fn(), fetchProxies: vi.fn() }
    mocks.recommendation = { batchTestProgress: {}, recordTestResult: vi.fn() }
    mocks.feedback = ref({})
    vi.stubGlobal('useConfigStore', () => ({ resolveLatencyTestUrl: (url: string) => url || 'https://probe.example/204', latencyTestTimeoutDuration: 5000 }))
    vi.stubGlobal('useProxiesStore', () => mocks.proxies)
    vi.stubGlobal('useNodeRecommendationStore', () => mocks.recommendation)
    vi.stubGlobal('onBeforeUnmount', vi.fn())
  })
  it('shows in-flight nodes and domains, replenishes the pool, and clears feedback on cancellation', async () => {
    const pending: { resolve: (value: { delay: number }) => void; signal: AbortSignal }[] = []
    mocks.get.mockImplementation((_path: string, options: { signal: AbortSignal }) => ({
      json: () => new Promise((resolve, reject) => {
        pending.push({ resolve, signal: options.signal })
        options.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })
      }),
    }))
    const nodes = Array.from({ length: 12 }, (_, index) => `sample-${index}`)
    mocks.proxies.proxies = [{ name: 'Group A', all: nodes }, { name: 'Group B', all: nodes.slice(0, 3) }]
    const batch = useBatchLatencyTest()
    const run = batch.testMultipleGroups(['Group A', 'Group B'])
    expect(pending).toHaveLength(10)
    expect(batch.activeProbes.value).toHaveLength(10)
    expect(batch.activeProbes.value[0]).toEqual({ name: 'sample-0', url: 'https://probe.example/204' })
    expect(batch.progress.value.total).toBe(12)
    expect(batch.groupProgress.value).toMatchObject({ total: 2, completed: 0, active: ['Group A', 'Group B'] })
    pending[1]!.resolve({ delay: 42 })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(pending).toHaveLength(11)
    expect(batch.activeProbes.value.map(probe => probe.name)).not.toContain('sample-1')
    expect(batch.activeProbes.value.map(probe => probe.name)).toContain('sample-10')
    batch.abortTest()
    await run
    expect(batch.activeProbes.value).toEqual([])
    expect(batch.isRunning.value).toBe(false)
    expect(pending.every(request => request.signal.aborted)).toBe(true)
    expect(Object.values(mocks.feedback.value)).not.toContainEqual({ state: 'testing' })
    expect(mocks.success).not.toHaveBeenCalled()
  })
  it('preserves distinct per-group URLs and reports successful completion', async () => {
    mocks.get.mockReturnValue({ json: async () => ({ delay: 42 }) })
    mocks.proxies.proxies = [
      { name: 'Group A', all: ['shared'], testUrl: 'https://first.example/204' },
      { name: 'Group B', all: ['shared'], testUrl: 'https://second.example/204' },
    ]
    const batch = useBatchLatencyTest()
    await batch.testMultipleGroups(['Group A', 'Group B'])
    expect(mocks.get).toHaveBeenCalledTimes(2)
    expect(mocks.proxies.recordLatencyTestResult.mock.calls).toEqual([
      ['shared', 'https://first.example/204', 42], ['shared', 'https://second.example/204', 42],
    ])
    expect(batch.progress.value.completed).toBe(2)
    expect(batch.groupProgress.value).toEqual({ total: 2, completed: 2, active: [] })
    expect(batch.activeProbes.value).toEqual([])
    expect(mocks.success).toHaveBeenCalledOnce()
  })
})
