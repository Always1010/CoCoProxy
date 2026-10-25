import type { CoproxySource } from './useCoproxy'
import { coproxyErrorMessage, useCoproxy } from './useCoproxy'

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
  groups: { name: string; type: string; selected: string; options: string[] }[]
  nodes: string[]
  catalog?: { id: string; name: string; default: boolean }[]
  rules: { value: string; source: 'subscription' | 'template' | 'user' | 'legacy'; editable: boolean }[]
  pending: boolean
  active: string | null
  error?: string
}

export function useWorkspace() {
  const api = useCoproxy()
  const view = useState<WorkspaceView | null>('coproxy-workspace', () => null)
  const busy = useState('coproxy-workspace-busy', () => false)
  const error = useState('coproxy-workspace-error', () => '')
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

  async function run(action: () => Promise<void>) {
    if (busy.value) return
    busy.value = true
    error.value = ''
    try { await action() }
    catch (cause) { error.value = coproxyErrorMessage(cause) }
    finally { busy.value = false }
  }

  async function save(change: (settings: WorkspaceSettings) => void) {
    if (!workspace.value) return
    const { revision, ...current } = workspace.value
    const settings = JSON.parse(JSON.stringify(current)) as WorkspaceSettings
    change(settings)
    await api.request('/api/coproxy/workspace', {
      method: 'PUT', body: { expectedRevision: revision, settings },
    })
    await load()
  }

  function editOverrides(settings: WorkspaceSettings): WorkspaceOverrides {
    if (settings.mode === 'local') return settings.local
    const id = settings.mode === 'legacy' ? 'legacy' : settings.subscriptionId ?? ''
    return settings.subscriptionOverrides[id] ??= { selections: {}, rules: [] }
  }

  async function apply() {
    if (!workspace.value || !view.value) return
    await api.request('/api/coproxy/workspace/apply', {
      method: 'POST',
      body: { expectedRevision: workspace.value.revision, expectedActive: view.value.active },
    })
    await load()
  }

  return { api, view, workspace, overrides, busy, error, load, run, save, editOverrides, apply }
}
