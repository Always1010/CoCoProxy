import type { CoproxySource } from './useCoproxy'
import { CoproxyError, coproxyErrorMessage, useCoproxy } from './useCoproxy'

export interface WorkspaceOverrides {
  selections: Record<string, string>
  rules: string[]
}

export interface WorkspaceSettings {
  mode: 'legacy' | 'local' | 'subscription'
  subscriptionId: string | null
  sourceIds: string[]
  runMode: 'rule' | 'global' | 'direct'
  local: WorkspaceOverrides
  subscriptionOverrides: Record<string, WorkspaceOverrides>
}

export interface WorkspaceSource extends CoproxySource {
  name: string
  host: string
  kind: 'nodes' | 'profile'
  nodeCount: number
  unsupportedFields?: string[]
  usage?: { upload: number; download: number; total: number; expire: number }
}

export interface WorkspaceView {
  workspace: WorkspaceSettings & { revision: number }
  sources: WorkspaceSource[]
  groups: { name: string; type: string; selected: string; activeSelected?: string | null; options: string[] }[]
  nodes: string[]
  tcpNodes?: { name: string; fingerprint: string; applicable: boolean }[]
  catalog?: { id: string; name: string; default: boolean }[]
  rules: { value: string; source: 'subscription' | 'template' | 'user' | 'legacy'; editable: boolean }[]
  pending: boolean
  active: string | null
  error?: string
  invalidSelections?: string[]
}

export function useWorkspace() {
  const api = useCoproxy()
  const view = useState<WorkspaceView | null>('coproxy-workspace', () => null)
  const busy = useState('coproxy-workspace-busy', () => false)
  const error = useState('coproxy-workspace-error', () => '')
  const feedback = useState('coproxy-workspace-feedback', () => '')
  const operation = useState('coproxy-workspace-operation', () => '')
  const workspace = computed(() => view.value?.workspace)
  const overrides = computed(() => {
    const settings = workspace.value
    if (!settings) return { selections: {}, rules: [] } as WorkspaceOverrides
    return settings.mode === 'local'
      ? settings.local
      : settings.subscriptionOverrides[settings.mode === 'legacy' ? 'legacy' : settings.subscriptionId ?? ''] ?? { selections: {}, rules: [] }
  })

  async function load() {
    view.value = await api.request<WorkspaceView>('/api/coproxy/workspace')
    api.generation.value = view.value.active
  }

  async function execute(action: () => Promise<void>) {
    if (busy.value) throw new CoproxyError('STORE_LOCKED')
    busy.value = true
    error.value = ''
    feedback.value = ''
    try { await action() }
    catch (cause) { error.value = coproxyErrorMessage(cause); throw cause }
    finally { busy.value = false; operation.value = '' }
  }

  async function run(action: () => Promise<void>) {
    try { await execute(action) } catch { /* The shared alert reports the failure. */ }
  }

  async function save(change: (settings: WorkspaceSettings) => void, message = '设置已生效') {
    if (!workspace.value || !view.value) throw new CoproxyError('WORKSPACE_UNAVAILABLE')
    const { revision, ...current } = workspace.value
    const expectedActive = view.value.active
    const settings = JSON.parse(JSON.stringify(current)) as WorkspaceSettings
    change(settings)
    operation.value = '正在使设置生效…'
    try {
      const saved = await api.request<{ workspace: WorkspaceSettings & { revision: number } }>('/api/coproxy/workspace', {
        method: 'PUT', body: { expectedRevision: revision, settings },
      })
      const result = await api.request<{ active: string }>('/api/coproxy/workspace/apply', {
        method: 'POST', body: { expectedRevision: saved.workspace.revision, expectedActive },
      })
      await load()
      if (view.value.active !== result.active || view.value.pending) throw new CoproxyError('WORKSPACE_CONFLICT')
      feedback.value = message
    } catch (cause) {
      // An interrupted request may already have taken effect. Read the core's
      // current state, but never retry a write or claim that it succeeded.
      try { await load() } catch { /* Preserve the original actionable error. */ }
      throw cause
    }
  }

  async function select(group: string, name: string) {
    await execute(async () => {
      await save(settings => { editOverrides(settings).selections[group] = name }, '')
      const observed = await api.request<{ proxies: Record<string, { now?: string }> }>('/api/clash/proxies')
      if (observed.proxies[group]?.now !== name) throw new CoproxyError('SELECTION_UNCONFIRMED')
      feedback.value = `已切换：${group} → ${name}`
    })
  }

  function editOverrides(settings: WorkspaceSettings): WorkspaceOverrides {
    if (settings.mode === 'local') return settings.local
    const id = settings.mode === 'legacy' ? 'legacy' : settings.subscriptionId ?? ''
    return settings.subscriptionOverrides[id] ??= { selections: {}, rules: [] }
  }

  return { api, view, workspace, overrides, busy, error, feedback, operation, load, run, save, select, editOverrides }
}
