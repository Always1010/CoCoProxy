import { useWorkspace } from './useWorkspace'
import { useCoCoProxy } from './useCoCoProxy'

export interface SiteTarget { id: string; name: string; url: string; category: string; builtin: boolean; permitted: boolean }
export interface SiteSettings {
  revision: number
  workspaceRevision: number
  scope: string
  targets: SiteTarget[]
  selections: Record<string, string[]>
  groups: string[]
}

export function useSiteSettings() {
  const { api, workspace } = useWorkspace()
  const data = useState<SiteSettings | null>('cocoproxy-site-settings', () => null)
  const pending = useState('cocoproxy-site-settings-busy', () => false)
  const scopeKey = computed(() => JSON.stringify([workspace.value?.mode, workspace.value?.subscriptionId,
    [...(workspace.value?.sourceIds ?? [])].sort()]))
  const { session } = useCoCoProxy()
  watch([scopeKey, session], () => { data.value = null }, { flush: 'sync' })

  async function load() {
    const scope = scopeKey.value
    const login = session.value
    const value = await api.request<SiteSettings>('/api/cocoproxy/workspace/sites')
    if (scope === scopeKey.value && login === session.value) data.value = value
  }
  const selectedIds = (group: string): string[] => {
    if (!data.value) return []
    if (Object.hasOwn(data.value.selections, group)) return data.value.selections[group]!
    const own = data.value.targets.find(target => target.id === group.toLowerCase() && target.permitted)
    return own ? [own.id] : data.value.targets.filter(target => target.id === 'google' && target.permitted).map(target => target.id)
  }
  const targetsFor = (group: string) => data.value?.targets.filter(target => selectedIds(group).includes(target.id)) ?? []
  async function save(change: { group?: string; selected?: string[]; add?: { name: string; url: string }; remove?: string }) {
    if (!data.value || !workspace.value || pending.value) throw new Error('Site settings unavailable')
    const scope = scopeKey.value
    const login = session.value
    const before = data.value
    pending.value = true
    try {
      const value = await api.request<SiteSettings>('/api/cocoproxy/workspace/sites', { method: 'PUT', body: {
        expectedRevision: before.revision, expectedWorkspaceRevision: workspace.value.revision, scope: before.scope, ...change,
      } })
      if (scope !== scopeKey.value || login !== session.value) throw new Error('Site settings changed')
      data.value = value
    } finally { pending.value = false }
  }
  return { data, pending, load, save, selectedIds, targetsFor, scopeKey }
}
