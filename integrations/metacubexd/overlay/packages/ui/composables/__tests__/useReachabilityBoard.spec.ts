import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useReachabilityBoard, CONNECTIVITY_TARGETS } from '../useReachabilityBoard'
import { LatencyTestError } from '../useApi'

const mocks = vi.hoisted(() => ({ get: vi.fn(), json: vi.fn() }))
vi.mock('../useApi', () => ({
  useRequest: () => ({ get: mocks.get }),
  LatencyTestError: class extends Error {
    constructor(readonly reason: string, readonly code?: string) { super(reason) }
  },
}))
describe('site reachability evidence', () => {
  beforeEach(() => {
    vi.clearAllMocks()
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
})
