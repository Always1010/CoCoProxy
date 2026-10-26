import { beforeEach, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { useSiteSettings } from '../useSiteSettings'
const mocks = vi.hoisted(() => ({ workspace: null as any, api: null as any }))
vi.mock('../useWorkspace', () => ({ useWorkspace: () => mocks.workspace }))
vi.mock('../useCoCoProxy', () => ({ useCoCoProxy: () => mocks.api }))
beforeEach(() => {
  const states = new Map<string, any>()
  vi.stubGlobal('useState', (key: string, init: () => unknown) => {
    if (!states.has(key)) states.set(key, ref(init()))
    return states.get(key)
  })
  mocks.api = { session: ref({ username: 'sample' }), request: vi.fn() }
  mocks.workspace = { api: mocks.api, workspace: ref({ mode: 'local', subscriptionId: null, sourceIds: ['one'], revision: 7 }) }
})
const value = (revision: number) => ({ revision, scope: 'one', targets: [], selections: {}, groups: [], workspaceRevision: 7 })
it('late reads cannot replace a newer revision or populate a different source scope', async () => {
  const settings = useSiteSettings()
  let finish!: (value: unknown) => void
  mocks.api.request.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    .mockResolvedValueOnce(value(2))
  const old = settings.load()
  await settings.load()
  finish(value(1)); await old
  expect(settings.data.value?.revision).toBe(2)
  mocks.api.request.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const other = settings.load()
  mocks.workspace.workspace.value.sourceIds = ['two']
  finish(value(3)); await other
  expect(settings.data.value).toBeNull()
})
it('saving sends captured scope and revisions without applying routing, and releases busy state on conflict', async () => {
  const settings = useSiteSettings()
  mocks.api.request.mockResolvedValueOnce(value(3)).mockResolvedValueOnce(value(4))
  await settings.load()
  await settings.save({ group: 'Proxy', selected: ['google'] })
  expect(mocks.api.request.mock.calls[1]).toEqual(['/api/cocoproxy/workspace/sites', { method: 'PUT', body: {
    expectedRevision: 3, expectedWorkspaceRevision: 7, scope: 'one', group: 'Proxy', selected: ['google'],
  } }])
  mocks.api.request.mockRejectedValueOnce(new Error('conflict'))
  await expect(settings.save({ group: 'Proxy', selected: [] })).rejects.toThrow('conflict')
  expect(settings.pending.value).toBe(false)
  expect(settings.data.value?.revision).toBe(4)
})
