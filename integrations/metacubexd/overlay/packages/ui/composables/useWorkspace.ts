import type { CoCoProxySource } from './useCoCoProxy'
import { CoCoProxyError, cocoproxyErrorMessage, useCoCoProxy } from './useCoCoProxy'
import type { BandwidthSettings } from '../utils/group-bandwidth'
export type { BandwidthSettings } from '../utils/group-bandwidth'

export interface AutoGroupPolicy {
  enabled?: boolean
  preferred: string[]
  fallback: string[]
  returnToPreferred: boolean
  bandwidth?: BandwidthSettings
}

export interface BandwidthSelectionStatus {
  phase: string
  reason: string
  candidate: string | null
  testingNode: string | null
  round: number
  nextAt: number | null
  hourBytes: number
  dayBytes: number
  hourLimit: number
  dayLimit: number
  hourReserve?: number
  dayReserve?: number
  searchBytes?: number
  searchLimit?: number
  urgent?: boolean
  pool?: { name: string; preferred: boolean; current: boolean; state: string; reason: string; samples: number;
    delayMs: number | null; mbps: number | null; measuredAt: number | null; nextAt: number; active: boolean }[]
  decision: { current: { low: number; high: number }; candidate: { low: number; high: number }; gain: number; cost: number; threshold: number;
    uncertainty?: number; guard?: boolean; worthwhile: boolean } | null
}

export interface AutoProbeSettings {
  primary: { url: string; expectedStatus: number }
  secondary: { url: string; expectedStatus: number }
  timeoutMs: number
  slowMs: number
}

export interface AutomaticEngineStatus {
  state: 'running' | 'suspended' | 'error'
  reason: 'initializing' | 'inactive' | 'paused' | 'direct' | 'disabled' | 'runtime-unavailable' | 'transaction' | 'fault' | 'pending' | 'switching' | 'stopped' | 'quota' | 'retry-after' | 'queued' | null
  lastStartedAt: number | null
  lastCompletedAt: number | null
  lastSnapshotAt: number | null
  error: { phase: 'snapshot' | 'probe' | 'switch' | 'tick'; code: string; since: number; at: number; count: number } | null
  pendingProbes: number
  nextStartAt: number | null
}

export interface AutomaticStatus {
  engine?: AutomaticEngineStatus
  scope?: string
  workspaceRevision?: number
  paused?: boolean
  suspended?: boolean
  error?: string
  groups: { name: string; phase: string; current: string | null; nextAt: number | null; reason: string | null; bandwidth?: BandwidthSelectionStatus }[]
  events: { id?: string; at: number; group: string; from: string | null; to: string | null; reason: string;
    fromPool?: 'preferred' | 'fallback'; toPool?: 'preferred' | 'fallback' }[]
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
  const { t } = useNuxtApp().$i18n
  const api = useCoCoProxy()
  const view = useState<WorkspaceView | null>('cocoproxy-workspace', () => null)
  const busy = useState('cocoproxy-workspace-busy', () => false)
  const errorCode = useState('cocoproxy-workspace-error', () => '')
  const feedbackKey = useState('cocoproxy-workspace-feedback', () => '')
  const operationKey = useState('cocoproxy-workspace-operation', () => '')
  const messageParams = useState<Record<string, string>>('cocoproxy-workspace-message-params', () => ({}))
  const error = computed(() => errorCode.value ? cocoproxyErrorMessage(new CoCoProxyError(errorCode.value), t) : '')
  const feedback = computed(() => feedbackKey.value ? t(feedbackKey.value, messageParams.value) : '')
  const operation = computed(() => operationKey.value ? t(operationKey.value, messageParams.value) : '')
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
    errorCode.value = ''
    feedbackKey.value = ''
    try { await action() }
    catch (cause) { errorCode.value = cause instanceof CoCoProxyError ? cause.code : 'UNKNOWN'; throw cause }
    finally { busy.value = false; operationKey.value = '' }
  }

  async function run(action: () => Promise<void>) {
    try { await execute(action) } catch { /* The shared alert reports the failure. */ }
  }

  async function save(change: (settings: WorkspaceSettings) => void,
    message: string | { key: string; params?: Record<string, string> } = 'coco.settingsSaved') {
    if (!workspace.value || !view.value) throw new CoCoProxyError('WORKSPACE_UNAVAILABLE')
    const { revision, ...current } = workspace.value
    const expectedActive = view.value.active
    const settings = JSON.parse(JSON.stringify(current)) as WorkspaceSettings
    change(settings)
    operationKey.value = 'coco.applyingSettings'
    try {
      const saved = await api.request<{ workspace: WorkspaceSettings & { revision: number } }>('/api/cocoproxy/workspace', {
        method: 'PUT', body: { expectedRevision: revision, settings },
      })
      const result = await api.request<{ active: string }>('/api/cocoproxy/workspace/apply', {
        method: 'POST', body: { expectedRevision: saved.workspace.revision, expectedActive },
      })
      await load()
      if (view.value.active !== result.active || view.value.pending) throw new CoCoProxyError('WORKSPACE_CONFLICT')
      feedbackKey.value = typeof message === 'string' ? message : message.key
      messageParams.value = typeof message === 'string' ? {} : message.params ?? {}
    } catch (cause) {
      // An interrupted request may already have taken effect. Read the core's
      // current state, but never retry a write or claim that it succeeded.
      try { await load() } catch { /* Preserve the original actionable error. */ }
      throw cause
    }
  }

  async function select(group: string, name: string) {
    await execute(async () => {
      if (!view.value) throw new CoCoProxyError('WORKSPACE_UNAVAILABLE')
      const expectedRevision = view.value.workspace.revision
      messageParams.value = { group, name }
      operationKey.value = 'coco.switching'
      try {
        const result = await api.request<{ active: string; view: WorkspaceView }>('/api/cocoproxy/workspace/select', {
          method: 'POST', body: { expectedRevision, expectedActive: view.value.active, group, name },
        })
        if (result.view.active !== result.active || result.view.pending || result.view.workspace.revision !== expectedRevision + 1)
          throw new CoCoProxyError('WORKSPACE_CONFLICT')
        if (result.view.groups.find(item => item.name === group)?.activeSelected !== name)
          throw new CoCoProxyError('SELECTION_UNCONFIRMED')
        view.value = result.view
        api.generation.value = result.active
        feedbackKey.value = 'coco.switched'
      } catch (cause) {
        // A failed response can follow a committed switch. Read once; never
        // replay the write or infer success from the user's requested choice.
        try { await load() } catch { /* Preserve the original failure. */ }
        throw cause
      }
    })
  }

  function editOverrides(settings: WorkspaceSettings): WorkspaceOverrides {
    if (settings.mode === 'local') return settings.local
    const id = settings.mode === 'legacy' ? 'legacy' : settings.subscriptionId ?? ''
    return settings.subscriptionOverrides[id] ??= { selections: {}, rules: [] }
  }

  return { api, view, workspace, overrides, busy, error, feedback, operation, load, run, save, select, editOverrides }
}
