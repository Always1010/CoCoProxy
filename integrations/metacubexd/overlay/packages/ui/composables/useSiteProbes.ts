import { useSiteSettings, type SiteTarget } from './useSiteSettings'
import { useWorkspace } from './useWorkspace'
import { useRequest, LatencyTestError } from './useApi'
import { runLatencyBatch } from '../utils/latencyBatch'

export type SiteResult = { status: 'testing' | 'success' | 'failed' | 'timeout' | 'cancelled' | 'denied' | 'busy' | 'unavailable'; delay: number | null; checkedAt?: number }
export interface SiteRun {
  group: string
  targets: SiteTarget[]
  nodes: string[]
  results: Record<string, Record<string, SiteResult>>
  completed: number
  total: number
  inFlight: Record<string, string>
  checkedAt: number | null
}
export const siteResultLabels: Record<SiteResult['status'], string> = {
  testing: '检测中', success: '成功', failed: '失败', timeout: '超时', cancelled: '已取消', denied: '目标受限', busy: '检测繁忙', unavailable: '核心不可用',
}

/** Pure expansion shared by TCP and site detection, independent of list filters. */
export function siteGroupMembers(group: string, groups: { name: string; all?: string[] }[], visiting = new Set<string>()): string[] {
  if (visiting.has(group)) return []
  const entry = groups.find(item => item.name === group)
  if (!entry) return /^(REJECT|REJECT-DROP|PASS|COMPATIBLE)$/i.test(group) ? [] : [group]
  const path = new Set(visiting).add(group)
  return [...new Set((entry.all ?? []).flatMap(name => siteGroupMembers(name, groups, path)))]
}

export function useSiteProbes(owner = false) {
  const { api, view } = useWorkspace()
  const sites = useSiteSettings()
  const proxiesStore = useProxiesStore()
  const config = useConfigStore()
  const siteMeasurements = useState<Record<string, string[]>>('cocoproxy-site-measurements', () => Object.create(null))
  const runs = useState<Record<string, SiteRun>>('cocoproxy-site-runs', () => Object.create(null))
  const running = useState<string | null>('cocoproxy-site-running', () => null)
  const controller = useState<AbortController | null>('cocoproxy-site-controller', () => null)
  const members = (group: string) => siteGroupMembers(group, proxiesStore.proxies)
  const cancel = () => {
    controller.value?.abort()
    controller.value = null
    for (const run of Object.values(runs.value)) {
      for (const results of Object.values(run.results)) for (const result of Object.values(results))
        if (result.status === 'testing') { result.status = 'cancelled'; result.checkedAt = Date.now() }
      if (run.checkedAt === null) run.checkedAt = Date.now()
      run.inFlight = {}
    }
    running.value = null
  }
  const reset = () => { cancel(); runs.value = Object.create(null) }
  const signature = computed(() => JSON.stringify([sites.scopeKey.value, api.generation.value, api.session.value,
    view.value?.tcpNodes, proxiesStore.proxies.map(group => [group.name, group.all]), sites.data.value?.targets,
    sites.data.value?.selections, config.latencyTestTimeoutDuration]))
  watch(signature, reset, { flush: 'sync' })
  if (owner) onBeforeUnmount(cancel)

  async function run(group: string, onlyNode?: string) {
    if (running.value || !sites.data.value || !view.value?.active || view.value.pending) return
    const all = members(group)
    const nodes = onlyNode ? all.filter(name => name === onlyNode) : all
    const targets = sites.targetsFor(group).map(target => ({ ...target }))
    if (!nodes.length || !targets.length) return
    const abort = new AbortController()
    const before = signature.value
    const current = () => controller.value === abort && !abort.signal.aborted && signature.value === before
    const previous = runs.value[group]
    const entry: SiteRun = {
      group, targets, nodes: onlyNode && previous ? [...new Set([...previous.nodes, ...nodes])] : nodes,
      results: onlyNode && previous ? Object.assign(Object.create(null), previous.results) : Object.create(null),
      completed: 0, total: nodes.length * targets.length, inFlight: {}, checkedAt: null,
    }
    const jobs = nodes.flatMap(name => {
      entry.results[name] = Object.fromEntries(targets.map(target => [target.id, { status: target.permitted ? 'testing' : 'denied', delay: null }]))
      return targets.map(target => ({ name, target, key: JSON.stringify([name, target.url]) }))
    })
    controller.value = abort
    runs.value[group] = entry
    const active = runs.value[group]!
    running.value = group
    const request = useRequest()
    const timeout = Math.max(1, Math.min(10000, config.latencyTestTimeoutDuration))
    try {
      await runLatencyBatch(jobs, abort.signal, async job => {
        if (!current()) return
        active.inFlight[job.key] = `${job.name} → ${job.target.name}`
        let result: SiteResult = { status: 'denied', delay: null }
        try {
          if (job.target.permitted) {
            siteMeasurements.value[job.name] = [...new Set([...(siteMeasurements.value[job.name] ?? []), job.target.url])]
            const value = await request.get(`proxies/${encodeURIComponent(job.name)}/delay`, {
              searchParams: { url: job.target.url, timeout }, signal: abort.signal, timeout: timeout + 5000,
            }).json<{ delay: number }>()
            result = Number.isFinite(value.delay) && value.delay > 0
              ? { status: 'success', delay: value.delay } : { status: 'failed', delay: null }
          }
        } catch (cause) {
          const status = cause instanceof LatencyTestError
            ? cause.reason === 'probe_denied' ? 'denied' : cause.reason === 'timeout' ? 'timeout'
              : cause.code === 'CONTROLLER_PROBE_BUSY' ? 'busy'
                : ['CONTROLLER_UNAVAILABLE', 'CONTROLLER_GENERATION_CONFLICT', 'ACTIVE_CONFLICT'].includes(cause.code ?? '') ? 'unavailable' : 'failed'
            : cause instanceof Error && cause.name === 'TimeoutError' ? 'timeout' : 'failed'
          result = { status, delay: null }
        } finally { delete active.inFlight[job.key] }
        if (!current()) return
        active.results[job.name]![job.target.id] = { ...result, checkedAt: Date.now() }
        active.completed++
      }, current)
    } finally {
      if (current()) { active.checkedAt = Date.now(); running.value = null; controller.value = null }
    }
  }
  return { runs, running, members, run, cancel, reset }
}
