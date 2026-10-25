import { resolveActiveGroup } from '~/utils'

/** Browsing belongs to a scheme, not to the generation applied by a node pick. */
export function useProxyWorkbench(scope: string, groupNames: Ref<string[]>) {
  const workbenches = useState<Record<string, { group: string | null; scroll: number }>>(
    'coproxy-proxy-workbenches', () => ({}),
  )
  workbenches.value[scope] ??= { group: null, scroll: 0 }
  const activeName = computed({
    get: () => workbenches.value[scope]?.group ?? null,
    set: (group: string | null) => { workbenches.value[scope] = { group, scroll: 0 } },
  })
  const scrollTop = computed({
    get: () => workbenches.value[scope]?.scroll ?? 0,
    set: (scroll: number) => {
      const entry = workbenches.value[scope]
      if (entry) entry.scroll = scroll
    },
  })
  watchEffect(() => {
    // Transient empty data must not discard the remembered group or position.
    if (!groupNames.value.length) return
    const next = resolveActiveGroup(groupNames.value, activeName.value)
    if (next !== activeName.value) activeName.value = next
  })
  return { activeName, scrollTop }
}
