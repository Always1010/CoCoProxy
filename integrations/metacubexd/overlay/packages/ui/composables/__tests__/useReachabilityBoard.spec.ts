import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { useReachabilityBoard, CONNECTIVITY_TARGETS } from '../useReachabilityBoard'
import { LatencyTestError } from '../useApi'

const mocks = vi.hoisted(() => ({ get: vi.fn(), json: vi.fn(), api: null as any, unmount: null as any }))
vi.mock('../useCoCoProxy', () => ({ useCoCoProxy: () => mocks.api }))
vi.mock('../useApi', () => ({
  useRequest: () => ({ get: mocks.get }),
  LatencyTestError: class extends Error {
    constructor(readonly reason: string, readonly code?: string) { super(reason) }
  },
}))
describe('site reachability evidence', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.api = { generation: ref('generation-one'), session: ref({ username: 'synthetic' }) }
    vi.stubGlobal('onBeforeUnmount', (callback: () => void) => { mocks.unmount = callback })
    mocks.get.mockReturnValue({ json: mocks.json })
  })
  it('uses the default allowed Google origin and keeps denied sites without sending probes', async () => {
    mocks.json.mockResolvedValue({ delay: 42 })
    const board = useReachabilityBoard()
    await board.testTargetsThroughNode('Sample Group', CONNECTIVITY_TARGETS, { allowedOrigins: ['https://www.gstatic.com'] })
    expect(mocks.get).toHaveBeenCalledTimes(1)
    expect(mocks.get.mock.calls[0]?.[0]).toBe('proxies/Sample%20Group/delay')
    expect(board.results.value.Google).toMatchObject({ status: 'success', latency: 42 })
    expect(board.results.value.Cloudflare?.status).toBe('denied')
    expect(board.results.value.GitHub?.status).toBe('denied')
    mocks.get.mockClear()
    await board.testTargetsThroughNode('Sample Group', CONNECTIVITY_TARGETS, { allowedOrigins: [] })
    expect(mocks.get).not.toHaveBeenCalled()
  })
  it('preserves permission, timeout, busy and controller failures instead of claiming unreachability', async () => {
    const cases = [
      [new LatencyTestError('probe_denied', 'CONTROLLER_PROBE_DENIED'), 'denied'],
      [new LatencyTestError('timeout'), 'timeout'],
      [new LatencyTestError('failed', 'CONTROLLER_PROBE_BUSY'), 'busy'],
      [new LatencyTestError('failed', 'CONTROLLER_UNAVAILABLE'), 'unavailable'],
      [new Error('transport failed'), 'error'],
    ] as const
    for (const [error, status] of cases) {
      mocks.json.mockRejectedValueOnce(error)
      const board = useReachabilityBoard()
      await board.testTargetsThroughNode('sample', [CONNECTIVITY_TARGETS[0]!])
      expect(board.results.value.Google).toMatchObject({ status, reachable: false, latency: null })
    }
  })
  it('requires a finite positive delay and resets running after failures', async () => {
    const board = useReachabilityBoard()
    for (const delay of [0, -1, NaN, Infinity]) {
      mocks.json.mockResolvedValueOnce({ delay })
      await board.testTargetsThroughNode('sample', [CONNECTIVITY_TARGETS[0]!])
      expect(board.results.value.Google?.status).toBe('unreachable')
      expect(board.isRunning.value).toBe(false)
    }
  })
  it('keeps progress and target identity, cancels requests, and ignores late results from a previous node', async () => {
    let finishOld!: (value: { delay: number }) => void
    let finishNew!: (value: { delay: number }) => void
    mocks.json.mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve }))
      .mockImplementationOnce(() => new Promise(resolve => { finishNew = resolve }))
    const board = useReachabilityBoard()
    const oldRun = board.testTargetsThroughNode('old-node', [CONNECTIVITY_TARGETS[0]!])
    const oldSignal = mocks.get.mock.calls[0]?.[1].signal as AbortSignal
    expect(board.currentTargets.value[0]?.url).toBe(CONNECTIVITY_TARGETS[0]!.url)
    expect(board.progress.value).toEqual({ completed: 0, total: 1 })
    board.reset()
    expect(oldSignal.aborted).toBe(true)
    const newRun = board.testTargetsThroughNode('new-node', [CONNECTIVITY_TARGETS[0]!])
    finishOld({ delay: 999 })
    await oldRun
    expect(board.isRunning.value).toBe(true)
    expect(board.results.value.Google).toMatchObject({ status: 'testing', nodeName: 'new-node' })
    finishNew({ delay: 42 })
    await newRun
    expect(board.results.value.Google).toMatchObject({ status: 'success', nodeName: 'new-node', latency: 42 })
    expect(board.results.value.Google?.checkedAt).toEqual(expect.any(Number))
    expect(board.context.value).toMatchObject({ nodeName: 'new-node', generation: 'generation-one', completedAt: expect.any(Number) })
    expect(board.progress.value).toEqual({ completed: 1, total: 1 })
  })
  it('clears evidence on configuration/session changes and aborts on unmount', async () => {
    mocks.json.mockResolvedValue({ delay: 42 })
    const board = useReachabilityBoard()
    await board.testTargetsThroughNode('sample', [CONNECTIVITY_TARGETS[0]!])
    mocks.api.generation.value = 'generation-two'
    expect(board.results.value).toEqual({})
    expect(board.context.value).toBeNull()
    await board.testTargetsThroughNode('sample', [CONNECTIVITY_TARGETS[0]!])
    mocks.api.session.value = null
    expect(board.results.value).toEqual({})
    let finish!: (value: { delay: number }) => void
    mocks.json.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const run = board.testTargetsThroughNode('sample', [CONNECTIVITY_TARGETS[0]!])
    const signal = mocks.get.mock.calls.at(-1)?.[1].signal as AbortSignal
    mocks.unmount()
    expect(signal.aborted).toBe(true)
    finish({ delay: 999 })
    await run
    expect(board.results.value).toEqual({})
    expect(board.isRunning.value).toBe(false)
  })
})
