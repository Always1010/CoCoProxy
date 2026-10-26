import { beforeEach, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { ref } from 'vue'
import { useProxiesStore } from '../proxies'

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), evidence: null as any }))
vi.mock('~/composables/useLatencyFeedback', () => ({ useLatencyFeedback: () => ({}) }))
vi.mock('~/composables/useApi', () => ({
  fetchProxiesAPI: mocks.fetch, fetchProxyProvidersAPI: async () => ({ providers: {} }),
  closeAllConnectionsAPI: vi.fn(), closeSingleConnectionAPI: vi.fn(), latencyFailureReason: vi.fn(),
  proxyGroupLatencyTestAPI: vi.fn(), proxyLatencyTestAPI: vi.fn(), selectProxyInGroupAPI: vi.fn(),
  unfixProxyInGroupAPI: vi.fn(), updateProxyProviderAPI: vi.fn(),
}))
beforeEach(() => {
  setActivePinia(createPinia())
  mocks.evidence = ref({ node: ['https://site.example/check'] })
  vi.stubGlobal('useState', () => mocks.evidence)
  vi.stubGlobal('useConfigStore', () => ({
    latencyQualityMap: { NOT_CONNECTED: 0, MEDIUM: 500, HIGH: 1000 },
    resolveLatencyTestUrl: (url?: string) => url || 'https://baseline.example/204',
  }))
  vi.stubGlobal('useConnectionsStore', () => ({}))
})

it('a successful site measurement cannot become a different failed baseline or its history', async () => {
  mocks.fetch.mockResolvedValue({ proxies: { node: {
    name: 'node', type: 'Socks5', history: [], udp: false, xudp: false, tfo: false,
    extra: {
      'https://baseline.example/204': { history: [{ time: '2026-01-01', delay: 0 }] },
      'https://site.example/check': { history: [{ time: '2026-01-01', delay: 42 }] },
    },
  } } })
  const store = useProxiesStore()
  await store.fetchProxies()
  expect(store.getLatencyByName('node', null)).toBe(0)
  expect(store.getLatencyHistoryByName('node', null)).toEqual([{ time: '2026-01-01', delay: 0 }])
  expect(store.getLatencyByName('node', 'https://site.example/check')).toBe(42)
  mocks.fetch.mockResolvedValue({ proxies: { node: {
    name: 'node', type: 'Socks5', history: [{ time: '2026-01-02', delay: 99 }], extra: {}, udp: false, xudp: false, tfo: false,
  } } })
  await store.fetchProxies()
  expect(store.getLatencyByName('node', null)).toBe(0)
  expect(store.getLatencyHistoryByName('node', null)).toEqual([{ time: '2026-01-01', delay: 0 }])
})
