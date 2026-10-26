import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { siteGroupMembers, useSiteProbes } from '../useSiteProbes'

const mocks = vi.hoisted(() => ({ workspace: null as any, sites: null as any, get: vi.fn(), groups: [] as any[] }))
vi.mock('../useWorkspace', () => ({ useWorkspace: () => mocks.workspace }))
vi.mock('../useSiteSettings', () => ({ useSiteSettings: () => mocks.sites }))
vi.mock('../useApi', () => ({
  useRequest: () => ({ get: mocks.get }),
  LatencyTestError: class extends Error { constructor(readonly reason: string, readonly code?: string) { super(reason) } },
}))

describe('group site probes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    const states = new Map<string, any>()
    vi.stubGlobal('useState', (key: string, init: () => unknown) => {
      if (!states.has(key)) states.set(key, ref(init()))
      return states.get(key)
    })
    vi.stubGlobal('onBeforeUnmount', vi.fn())
    vi.stubGlobal('useProxiesStore', () => ({ proxies: mocks.groups }))
    vi.stubGlobal('useConfigStore', () => ({ latencyTestTimeoutDuration: 5000 }))
    mocks.groups = [{ name: 'Group', all: ['node-a', 'node-b', 'REJECT'] }]
    mocks.workspace = { api: { generation: ref('one'), session: ref({ username: 'sample' }) },
      view: ref({ active: 'one', pending: false, tcpNodes: [{ name: 'node-a', fingerprint: 'a' }] }) }
    const targets = [{ id: 'google', name: 'Google', url: 'https://probe.example/204', permitted: true }]
    mocks.sites = { scopeKey: ref('scope'), data: ref({ targets, selections: { Group: ['google'] } }),
      targetsFor: () => mocks.sites.data.value.targets }
    mocks.get.mockImplementation(() => ({ json: async () => ({ delay: 42 }) }))
  })
  it('expands nested groups once, breaks cycles and skips non-dialable pseudo nodes', () => {
    const groups = [{ name: 'A', all: ['B', 'node-a', 'REJECT'] }, { name: 'B', all: ['A', 'node-a', 'node-b'] }]
    expect(siteGroupMembers('A', groups)).toEqual(['node-a', 'node-b'])
  })
  it('keeps per-node and per-target results separate and never changes selection or recommendation', async () => {
    const probes = useSiteProbes()
    await probes.run('Group')
    expect(mocks.get).toHaveBeenCalledTimes(2)
    expect(probes.runs.value.Group?.results['node-a']?.google).toMatchObject({ status: 'success', delay: 42, checkedAt: expect.any(Number) })
    expect(probes.runs.value.Group).toMatchObject({ completed: 2, total: 2, checkedAt: expect.any(Number) })
    await probes.run('Group', 'node-a')
    expect(probes.runs.value.Group?.results['node-b']?.google?.delay).toBe(42)
    mocks.workspace.api.generation.value = 'two'
    expect(probes.runs.value).toEqual({})
  })
  it('bounds the entire node/target batch, cancels queued work and ignores late results', async () => {
    mocks.groups[0].all = Array.from({ length: 30 }, (_, index) => `node-${index}`)
    const finishes: (() => void)[] = []
    mocks.get.mockImplementation(() => ({ json: () => new Promise(resolve => { finishes.push(() => resolve({ delay: 999 })) }) }))
    const probes = useSiteProbes(true)
    const pending = probes.run('Group')
    expect(mocks.get).toHaveBeenCalledTimes(10)
    const signal = mocks.get.mock.calls[0]![1].signal as AbortSignal
    probes.cancel()
    expect(signal.aborted).toBe(true)
    finishes.forEach(finish => finish())
    await pending
    expect(mocks.get).toHaveBeenCalledTimes(10)
    expect(probes.runs.value.Group?.results['node-0']?.google?.status).toBe('cancelled')
    expect(probes.running.value).toBeNull()
  })
})
