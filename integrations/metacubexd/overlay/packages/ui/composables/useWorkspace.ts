import type { CoCoProxySource } from './useCoCoProxy'
import { CoCoProxyError, cocoproxyErrorMessage, useCoCoProxy } from './useCoCoProxy'

export interface AutoGroupPolicy {
  enabled?: boolean
  preferred: string[]
  fallback: string[]
  returnToPreferred: boolean
}

export interface AutoProbeSettings {
  primary: { url: string; expectedStatus: number }
  secondary: { url: string; expectedStatus: number }
  timeoutMs: number
  slowMs: number
}

export interface AutomaticStatus {
  groups: { name: string; phase: string; current: string | null; nextAt: number | null; reason: string | null }[]
  events: { at: number; group: string; from: string | null; to: string | null; reason: string }[]
}

export interface WorkspaceOverrides {
  selections: Record<string, string>
  rules: string[]
  automatic?: Record<string, AutoGroupPolicy>
  sharedGroups?: string[]
}

export interface WorkspaceSettings {
  mode: 'legacy' | 'local' | 'subscription'
  subscriptionId: string | null
  sourceIds: string[]
  runMode: 'rule' | 'global' | 'direct'
  local: WorkspaceOverrides
  subscriptionOverrides: Record<string, WorkspaceOverrides>
  autoProbes?: AutoProbeSettings
}

export interface WorkspaceSource extends CoCoProxySource {
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
  groups: { name: string; type: string; role: 'service' | 'shared'; selected: string; activeSelected?: string | null; options: string[] }[]
  nodes: string[]
  tcpNodes?: { name: string; fingerprint: string; applicable: boolean }[]
  catalog?: { id: string; name: string; default: boolean }[]
  rules: { value: string; source: 'subscription' | 'template' | 'user' | 'legacy'; editable: boolean }[]
  pending: boolean
  active: string | null
  error?: string
  invalidSelections?: string[]
  automatic?: AutomaticStatus
  allowedProbeOrigins?: string[]
}

export function useWorkspace() {
  const api = useCoCoProxy()
  const view = useState<WorkspaceView | null>('cocoproxy-workspace', () => null)
  const busy = useState('cocoproxy-workspace-busy', () => false)
  const error = useState('cocoproxy-workspace-error', () => '')
  const feedback = useState('cocoproxy-workspace-feedback', () => '')
  const operation = useState('cocoproxy-workspace-operation', () => '')
  const workspace = computed(() => view.value?.workspace)
  const overrides = computed(() => {
    const settings = workspace.value
    if (!settings) return { selections: {}, rules: [] } as WorkspaceOverrides
    return settings.mode === 'local'
      ? settings.local
      : settings.subscriptionOverrides[settings.mode === 'legacy' ? 'legacy' : settings.subscriptionId ?? ''] ?? { selections: {}, rules: [] }
  })

  async function load() {
    view.value = await api.request<WorkspaceView>('/api/cocoproxy/workspace')
    api.generation.value = view.value.active
  }

  async function execute(action: () => Promise<void>) {
    if (busy.value) throw new CoCoProxyError('STORE_LOCKED')
    busy.value = true
    error.value = ''
    feedback.value = ''
    try { await action() }
    catch (cause) { error.value = cocoproxyErrorMessage(cause); throw cause }
    finally { busy.value = false; operation.value = '' }
  }

  async function run(action: () => Promise<void>) {
    try { await execute(action) } catch { /* The shared alert reports the failure. */ }
  }

  async function save(change: (settings: WorkspaceSettings) => void, message = '设置已生效') {
    if (!workspace.value || !view.value) throw new CoCoProxyError('WORKSPACE_UNAVAILABLE')
    const { revision, ...current } = workspace.value
    const expectedActive = view.value.active
    const settings = JSON.parse(JSON.stringify(current)) as WorkspaceSettings
    change(settings)
    operation.value = '正在使设置生效…'
    try {
      const saved = await api.request<{ workspace: WorkspaceSettings & { revision: number } }>('/api/cocoproxy/workspace', {
        method: 'PUT', body: { expectedRevision: revision, settings },
      })
      const result = await api.request<{ active: string }>('/api/cocoproxy/workspace/apply', {
        method: 'POST', body: { expectedRevision: saved.workspace.revision, expectedActive },
      })
      await load()
      if (view.value.active !== result.active || view.value.pending) throw new CoCoProxyError('WORKSPACE_CONFLICT')
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
      await save(settings => {
        const overrides = editOverrides(settings)
        overrides.selections[group] = name
        const automatic = overrides.automatic?.[group]
        if (automatic) overrides.automatic![group] = { ...automatic, enabled: false }
      }, '')
      const observed = await api.request<{ proxies: Record<string, { now?: string }> }>('/api/clash/proxies')
      if (observed.proxies[group]?.now !== name) throw new CoCoProxyError('SELECTION_UNCONFIRMED')
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
