import { CoCoProxyError, cocoproxyErrorMessage } from './useCoCoProxy'
import type { CoCoProxyStatus } from './useCoCoProxy'

export type BandwidthPhase = 'preparing' | 'latency' | 'download' | 'upload' | 'finishing' | 'cancelling' | 'complete' | 'partial' | 'failed' | 'cancelled'
export interface BandwidthDirection {
  status: 'pending' | 'running' | 'success' | 'insufficient' | 'failed' | 'cancelled'
  mbps: number | null
  liveMbps: number | null
  bytes: number
}
export interface BandwidthTask {
  id: string
  node: string
  generation: string
  phase: BandwidthPhase
  running: boolean
  owned: boolean
  reason: string | null
  bytesUsed: number
  phaseStartedAt: number
  startedAt: number
  finishedAt: number | null
  latency: { idle: number | null; download: number | null; upload: number | null }
  download: BandwidthDirection
  upload: BandwidthDirection
}
export interface BandwidthStatus {
  available?: boolean
  automaticRunning?: boolean
  limits: { durationMs: number; maxBytes: number; timeoutMs: number }
  server: { name: string; url: string }
  task: BandwidthTask | null
}

const clientKey = 'cocoproxy-bandwidth-client'
const pendingKey = 'cocoproxy-bandwidth-pending'
function randomClient() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6]! & 15) | 64
  bytes[8] = (bytes[8]! & 63) | 128
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
const messages: Record<string, string> = {
  ACTIVE_CONFLICT: '运行配置正在变化，请等待稳定后重新测试。',
  CONTROLLER_UNAVAILABLE: '代理核心尚未就绪，请确认运行状态后再测试。',
  BANDWIDTH_BUSY: '已有节点带宽测试正在运行，已读取当前任务。',
  BANDWIDTH_NOT_OWNER: '此任务由另一个浏览器发起，仅可查看进度。',
  BANDWIDTH_UNAVAILABLE: '节点带宽测试暂不可用，请确认核心已就绪。',
  BANDWIDTH_NODE_INVALID: '请选择当前策略组中的具体代理节点。',
  BANDWIDTH_NODE_CONFLICT: '节点或生效配置已变化，请刷新工作区后重试。',
  BANDWIDTH_CLIENT_INVALID: '浏览器任务标识无效，请重新打开此页面。',
}

export function useBandwidthTest() {
  const { api, view } = useWorkspace()
  const status = ref<BandwidthStatus | null>(null)
  const visible = ref(false)
  const loading = ref(false)
  const sending = ref(false)
  const uncertain = ref(false)
  const error = ref('')
  const client = ref('')
  const persistent = ref(false)
  let disposed = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let reading = false
  let readId = 0
  let readController: AbortController | undefined
  const task = computed(() => status.value?.task ?? null)
  const locked = computed(() => sending.value || uncertain.value || !!(task.value?.running && task.value.owned))
  const canStart = computed(() => persistent.value && !!status.value && status.value.available !== false && !status.value.automaticRunning && !loading.value && !sending.value && !uncertain.value && !task.value?.running && !!view.value?.active && !view.value.pending)

  function rememberPending(value: boolean) {
    try {
      if (value) sessionStorage.setItem(pendingKey, '1')
      else sessionStorage.removeItem(pendingKey)
    } catch { /* The in-memory lock remains until the server confirms state. */ }
  }
  function accept(result: BandwidthStatus) {
    status.value = result
    uncertain.value = false
    rememberPending(!!(result.task?.running && result.task.owned))
  }
  function message(cause: unknown) {
    return cause instanceof CoCoProxyError ? messages[cause.code] ?? cocoproxyErrorMessage(cause) : cocoproxyErrorMessage(cause)
  }
  function stopPolling() {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
  }
  function stopRead() {
    readId++
    readController?.abort()
    readController = undefined
    reading = false
    loading.value = false
  }
  function schedule() {
    stopPolling()
    if (!disposed && visible.value && !sending.value && (task.value?.running || uncertain.value || status.value?.automaticRunning))
      timer = setTimeout(() => { void refresh() }, 900)
  }
  async function refresh(force = false): Promise<boolean> {
    if (disposed || (reading && !force) || sending.value || (!force && (!visible.value || document.hidden))) { schedule(); return false }
    stopRead()
    const id = ++readId
    const controller = new AbortController()
    readController = controller
    reading = true
    loading.value = force || !status.value
    try {
      const result = await api.request<BandwidthStatus>('/api/cocoproxy/bandwidth', {
        headers: { 'X-CoCoProxy-Bandwidth-Client': client.value }, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]),
      })
      if (disposed || id !== readId) return false
      accept(result)
      error.value = persistent.value ? '' : '无法保存浏览器任务标识，请允许会话存储后再开始测试。'
      return true
    } catch (cause) {
      if (!disposed && id === readId) error.value = message(cause)
      return false
    } finally { if (id === readId) { reading = false; readController = undefined; loading.value = false; schedule() } }
  }
  async function mutate(path: string, body: unknown) {
    sending.value = true
    // Start/cancel wins over an older GET, even if abort arrives after its response.
    stopRead()
    uncertain.value = true
    rememberPending(true)
    error.value = ''
    stopPolling()
    let failure: unknown
    try {
      accept(await api.request<BandwidthStatus>(path, {
        method: 'POST', body, headers: { 'X-CoCoProxy-Bandwidth-Client': client.value }, signal: AbortSignal.timeout(8000),
      }))
    } catch (cause) { failure = cause }
    finally { sending.value = false }
    // A lost POST response may follow a successful start/cancel. Only a read can
    // release the uncertainty lock; never retry the write automatically.
    if (failure) {
      const synchronized = await refresh(true)
      error.value = synchronized ? message(failure) : '操作结果尚未确认，正在重新读取任务。请保持此弹窗开启。'
    }
    schedule()
  }
  async function start(node: string) {
    if (!visible.value || !node || !canStart.value) return
    sending.value = true
    stopRead()
    error.value = ''
    stopPolling()
    try {
      // Automatic selection can advance the runtime generation while the page
      // remains open. Bind this explicit test to a fresh server observation.
      const current = await api.request<CoCoProxyStatus>('/api/cocoproxy/status', {
        headers: { 'X-CoCoProxy-Bandwidth-Client': client.value }, signal: AbortSignal.timeout(8000),
      })
      if (current.transaction || current.fault) throw new CoCoProxyError('ACTIVE_CONFLICT')
      if (!current.active || !current.core?.ready) throw new CoCoProxyError('CONTROLLER_UNAVAILABLE')
      await mutate('/api/cocoproxy/bandwidth', { node, expectedActive: current.active })
    } catch (cause) { error.value = message(cause) }
    finally { sending.value = false; schedule() }
  }
  async function cancel() {
    if (!task.value?.running || !task.value.owned || loading.value || sending.value || uncertain.value || task.value.phase === 'cancelling') return
    await mutate('/api/cocoproxy/bandwidth/cancel', { id: task.value.id })
  }
  function shown() { visible.value = true; void refresh(true) }
  function hidden() { visible.value = false; stopPolling(); stopRead() }
  function visibilityChanged() { if (!document.hidden && visible.value) void refresh() }
  async function restore(): Promise<boolean> {
    try {
      client.value = sessionStorage.getItem(clientKey) || randomClient()
      sessionStorage.setItem(clientKey, client.value)
      persistent.value = true
      uncertain.value = sessionStorage.getItem(pendingKey) === '1'
    } catch {
      client.value ||= randomClient()
      error.value = '无法保存浏览器任务标识，请允许会话存储后再开始测试。'
    }
    const pending = uncertain.value
    await refresh(true)
    return pending || !!(task.value?.running && task.value.owned)
  }
  onMounted(() => document.addEventListener('visibilitychange', visibilityChanged))
  onUnmounted(() => { disposed = true; stopPolling(); stopRead(); document.removeEventListener('visibilitychange', visibilityChanged) })
  return { status, task, visible, loading, sending, uncertain, error, locked, canStart, start, cancel, refresh, shown, hidden, restore }
}
