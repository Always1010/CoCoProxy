import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { useTcpDelay } from '../useTcpDelay'

const mocks = vi.hoisted(() => ({ workspace: null as any }))
vi.mock('../useWorkspace', () => ({ useWorkspace: () => mocks.workspace }))

describe('TCP delay results', () => {
  beforeEach(() => {
    const state = ref({})
    vi.stubGlobal('useState', () => state)
    vi.stubGlobal('onBeforeUnmount', vi.fn())
    mocks.workspace = {
      view: ref({ active: 'active-one', workspace: { revision: 3 }, tcpNodes: [
        { name: 'one', fingerprint: 'fingerprint-one', applicable: true },
        { name: 'udp', fingerprint: 'fingerprint-udp', applicable: false },
      ] }),
      api: { session: ref({ username: 'synthetic' }), request: vi.fn() },
    }
  })

  it('deduplicates shared nodes, preserves a valid zero, and invalidates edited nodes', async () => {
    const api = mocks.workspace.api
    api.request.mockResolvedValue({ name: 'one', fingerprint: 'fingerprint-one', status: 'success', delay: 0, checkedAt: '2026-01-01T00:00:00Z' })
    const tcp = useTcpDelay()
    await tcp.run(['one', 'one', 'udp', 'DIRECT'])
    expect(api.request).toHaveBeenCalledTimes(1)
    expect(api.request.mock.calls[0][1].body).toEqual({ expectedRevision: 3, expectedActive: 'active-one', name: 'one', fingerprint: 'fingerprint-one' })
    expect(tcp.resultFor('one')?.status).toBe('success')
    expect(tcp.resultFor('one')).toHaveProperty('delay', 0)
    expect(tcp.resultFor('udp')).toBeUndefined()
    mocks.workspace.view.value.tcpNodes[0].fingerprint = 'edited-node'
    expect(tcp.resultFor('one')).toBeUndefined()
  })

  it('limits batch fanout, cancels queued probes, and clears abandoned testing states', async () => {
    mocks.workspace.view.value.tcpNodes = Array.from({ length: 10 }, (_, i) => ({ name: `node-${i}`, fingerprint: `id-${i}`, applicable: true }))
    const api = mocks.workspace.api
    api.request.mockImplementation((_path: string, options: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
    }))
    const tcp = useTcpDelay()
    const run = tcp.run(mocks.workspace.view.value.tcpNodes.map((node: { name: string }) => node.name))
    expect(api.request).toHaveBeenCalledTimes(4)
    tcp.cancel()
    await run
    expect(api.request).toHaveBeenCalledTimes(4)
    expect(tcp.isRunning.value).toBe(false)
    expect(tcp.resultFor('node-0')).toBeUndefined()
  })
})
