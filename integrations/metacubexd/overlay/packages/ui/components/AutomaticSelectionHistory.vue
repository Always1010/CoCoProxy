<script setup lang="ts">
import { IconArrowRight, IconCheck, IconChevronUp, IconHistory, IconRefresh, IconTrash, IconX } from '@tabler/icons-vue'
import type { AutomaticStatus } from '~/composables/useWorkspace'
import { cocoproxyErrorMessage } from '~/composables/useCoCoProxy'

const props = defineProps<{ groupName: string; selectable: boolean }>()
const { api, view, overrides } = useWorkspace()
type HistoryEvent = AutomaticStatus['events'][number]
const dialog = ref<HTMLDialogElement>()
const scroller = ref<HTMLElement>()
const visible = ref(false)
const status = ref<AutomaticStatus>()
const displayed = ref<HistoryEvent[]>([])
const loading = ref(false)
const clearing = ref(false)
const confirmClear = ref(false)
const error = ref('')
const updatedAt = ref<number>()
const nearTop = ref(true)
let timer: ReturnType<typeof setTimeout> | undefined
let session = 0
let requestId = 0
let disposed = false
const scope = computed(() => {
  const workspace = view.value?.workspace
  return workspace ? JSON.stringify([workspace.mode, workspace.mode === 'subscription' ? workspace.subscriptionId : workspace.sourceIds]) : ''
})
const policy = computed(() => overrides.value.automatic?.[props.groupName])
const enabled = computed(() => !!policy.value && policy.value.enabled !== false)
const hasHistory = computed(() => view.value?.automatic?.events.some(e => e.group === props.groupName))
const available = computed(() => props.selectable && (enabled.value || hasHistory.value || (policy.value && view.value?.automatic?.error) || visible.value))
const groupStatus = computed(() => status.value?.groups.find(g => g.name === props.groupName))
const currentNode = computed(() => enabled.value && groupStatus.value?.current || view.value?.groups.find(g => g.name === props.groupName)?.activeSelected || '尚未确认')
const currentPool = computed(() => enabled.value && policy.value?.preferred.includes(currentNode.value) ? '优选'
  : enabled.value && policy.value?.fallback.includes(currentNode.value) ? '备选' : '')
const events = computed(() => (status.value?.events ?? []).filter(e => e.group === props.groupName).slice().reverse())
const eventKey = (event: HistoryEvent) => event.id ?? JSON.stringify([event.at, event.from, event.to, event.reason])
const newCount = computed(() => {
  const shown = new Set(displayed.value.map(eventKey))
  return events.value.filter(e => !shown.has(eventKey(e))).length
})
const phases: Record<string, string> = {
  outage: '暂无可用出口，退避重试', 'slow-search': '正在寻找更快的候选节点', 'failure-search': '正在寻找可用候选节点',
  'failure-confirmation': '正在复核当前节点', 'return-confirmation': '正在确认优选恢复', backup: '使用备选，监测当前节点', monitoring: '监测当前节点',
}
const reasons: Record<string, string> = {
  'preferred-restored': '优选节点恢复，并通过稳定性确认', 'faster-candidate': '当前节点连续变慢，候选节点满足改善条件',
  'failure-recovery': '原节点检测失败，已确认替代节点可用', 'current-slow': '当前节点连续变慢',
  'current-unavailable': '当前节点不可用', 'all-unavailable': '本轮未能确认可用出口',
  'no-better-candidate': '暂未找到明显更快的候选节点', 'preferred-check-failed': '优选尚未稳定恢复',
}
const phase = computed(() => !enabled.value ? '自动选点已停用，保留历史供回看'
  : status.value?.paused ? '自动选点已暂停'
    : status.value?.suspended || view.value?.pending ? '运行暂不可用或配置待生效'
      : groupStatus.value ? phases[groupStatus.value.phase] ?? '等待调度' : '等待调度或运行状态更新')
const timeLabel = (at: number) => new Date(at).toLocaleString()
const poolLabel = (pool?: string) => pool === 'preferred' ? '优选' : pool === 'fallback' ? '备选' : ''
const eventLabel = (reason: string) => reason === 'preferred-restored' ? '优选回切' : reason === 'faster-candidate' ? '性能切换' : reason === 'failure-recovery' ? '故障切换' : '自动切换'

function showLatest(scroll = true) {
  displayed.value = [...events.value]
  if (scroll) { nearTop.value = true; scroller.value?.scrollTo({ top: 0 }) }
}
function onScroll() {
  nearTop.value = (scroller.value?.scrollTop ?? 0) < 24
  if (nearTop.value) showLatest(false)
}
function accept(result: AutomaticStatus) {
  status.value = result
  if (view.value) view.value.automatic = result
  // Expired/cleared records disappear, while new arrivals wait until the reader returns to the top.
  const retained = new Set(events.value.map(eventKey))
  displayed.value = displayed.value.filter(e => retained.has(eventKey(e)))
  if (nearTop.value) showLatest(false)
  updatedAt.value = Date.now()
  error.value = ''
}
async function readStatus() {
  if (!visible.value || disposed || document.hidden || loading.value || clearing.value) return
  const id = ++requestId
  const requestScope = scope.value
  loading.value = true
  try {
    const result = await api.request<AutomaticStatus>('/api/cocoproxy/automatic/status')
    if (visible.value && id === requestId && requestScope === scope.value) {
      if (result.scope !== requestScope || result.workspaceRevision !== view.value?.workspace.revision) {
        error.value = '方案或设置已变化，请关闭面板并刷新工作区。'
        return
      }
      accept(result)
    }
  } catch (cause) {
    if (visible.value && id === requestId) error.value = cocoproxyErrorMessage(cause)
  } finally { if (id === requestId) loading.value = false }
}
async function poll(currentSession: number) {
  await readStatus()
  if (visible.value && !disposed && currentSession === session) timer = setTimeout(() => { void poll(currentSession) }, 8000)
}
function close() {
  session++
  requestId++
  visible.value = false
  loading.value = false
  if (timer) clearTimeout(timer)
}
function open() {
  status.value = view.value?.automatic
  nearTop.value = true
  showLatest(false)
  error.value = ''
  updatedAt.value = undefined
  confirmClear.value = false
  visible.value = true
  dialog.value?.showModal()
  void poll(++session)
}
async function clearHistory() {
  if (clearing.value || loading.value || !confirmClear.value || !status.value?.scope) return
  if (status.value.workspaceRevision !== view.value?.workspace.revision) {
    error.value = '方案或设置已变化，请关闭面板并刷新工作区。'
    return
  }
  const id = ++requestId
  const requestScope = scope.value
  clearing.value = true
  try {
    const result = await api.request<AutomaticStatus>('/api/cocoproxy/automatic/history/clear', {
      method: 'POST', body: { expectedRevision: status.value.workspaceRevision, scope: status.value.scope, group: props.groupName },
    })
    if (requestScope === scope.value && result.scope === requestScope && result.workspaceRevision === view.value?.workspace.revision) {
      if (view.value) view.value.automatic = result
      if (visible.value && id === requestId) { accept(result); showLatest(); confirmClear.value = false }
    }
  } catch (cause) {
    if (visible.value && id === requestId) error.value = cocoproxyErrorMessage(cause)
  } finally { clearing.value = false }
}
function visibilityChanged() { if (!document.hidden) void readStatus() }
watch(() => [props.groupName, scope.value], () => { dialog.value?.close(); close() })
onMounted(() => document.addEventListener('visibilitychange', visibilityChanged))
onUnmounted(() => { disposed = true; close(); document.removeEventListener('visibilitychange', visibilityChanged) })
</script>

<template>
  <span v-if="available" class="shrink-0">
    <button type="button" class="btn btn-ghost btn-sm min-h-11" :aria-label="`${groupName} 切换历史`" @click="open"><IconHistory :size="18" aria-hidden="true" /><span>切换历史</span></button>
  </span>
  <dialog ref="dialog" class="modal modal-bottom sm:modal-middle" :aria-label="`${groupName} 切换历史`" @close="close">
    <div class="modal-box flex h-[92dvh] max-h-[92dvh] max-w-2xl flex-col gap-3 overflow-hidden sm:h-auto sm:max-h-[85dvh]">
      <div class="flex shrink-0 items-center justify-between gap-2">
        <h2 class="min-w-0 break-all text-lg font-semibold">{{ groupName }} · 切换历史</h2>
        <button type="button" class="btn btn-ghost min-h-11 shrink-0" @click="dialog?.close()"><IconX :size="18" aria-hidden="true" /><span>关闭</span></button>
      </div>
      <section class="shrink-0 space-y-1 rounded-lg bg-base-200 p-3 text-sm" aria-label="当前自动选点状态" aria-live="polite">
        <p>{{ enabled ? '自动选点已开启' : '自动选点已关闭' }}</p>
        <p class="break-all">当前出口：{{ currentNode }}{{ currentPool ? ` · ${currentPool}` : '' }}</p>
        <p :class="groupStatus?.phase === 'outage' && enabled ? 'text-warning' : 'text-base-content/70'">{{ phase }}</p>
        <p v-if="enabled && groupStatus?.reason" class="text-xs text-base-content/65">{{ reasons[groupStatus.reason] ?? '运行状态发生变化' }}</p>
        <p v-if="enabled && !status?.suspended && !view?.pending && groupStatus?.nextAt" class="text-xs text-base-content/65">下次检测：{{ timeLabel(groupStatus.nextAt) }}</p>
      </section>
      <div class="flex shrink-0 flex-wrap items-center justify-between gap-2 text-xs text-base-content/60">
        <span>{{ updatedAt ? `最近更新于 ${timeLabel(updatedAt)}` : '正在读取历史…' }}</span>
        <button type="button" class="btn btn-ghost btn-sm min-h-11" :disabled="loading || clearing" @click="readStatus"><IconRefresh :size="16" :class="{ 'animate-spin': loading }" aria-hidden="true" /><span>{{ loading ? '正在刷新' : '刷新' }}</span></button>
      </div>
      <p v-if="error" role="alert" class="shrink-0 text-sm text-warning">更新失败：{{ error }} 已显示的记录仍予保留。</p>
      <button v-if="newCount" type="button" class="btn btn-primary btn-sm min-h-11 shrink-0" @click="showLatest()"><IconChevronUp :size="16" aria-hidden="true" /><span>有 {{ newCount }} 条新记录 · 查看最新</span></button>
      <div ref="scroller" class="min-h-0 flex-1 overflow-y-auto sm:max-h-[45dvh]" @scroll="onScroll">
        <ol v-if="displayed.length" class="space-y-3" aria-label="当前组切换记录">
          <li v-for="event in displayed" :key="eventKey(event)" class="space-y-2 rounded-lg border border-base-content/10 p-3 text-sm">
            <div class="flex flex-wrap items-center justify-between gap-2"><time :datetime="new Date(event.at).toISOString()" class="text-xs text-base-content/60">{{ timeLabel(event.at) }}</time><span class="badge badge-sm">{{ eventLabel(event.reason) }}</span></div>
            <div class="flex flex-wrap items-center gap-2"><span class="min-w-0 break-all">{{ event.from ?? '未选择' }}<span v-if="event.fromPool" class="ml-1 text-xs text-base-content/60">（{{ poolLabel(event.fromPool) }}）</span></span><IconArrowRight :size="16" class="shrink-0" aria-hidden="true" /><span class="min-w-0 break-all">{{ event.to ?? '未选择' }}<span v-if="event.toPool" class="ml-1 text-xs text-base-content/60">（{{ poolLabel(event.toPool) }}）</span></span></div>
            <p class="text-xs leading-relaxed text-base-content/70">原因：{{ reasons[event.reason] ?? '自动选择已确认新的出口节点' }}</p>
          </li>
        </ol>
        <p v-else-if="!loading && !error" class="py-8 text-center text-sm text-base-content/60">{{ enabled ? '暂无保留的切换记录，之后确认的节点切换会显示在这里。' : '暂无保留的切换记录。' }}</p>
      </div>
      <footer class="shrink-0 space-y-2 border-t border-base-content/10 pt-3">
        <p class="text-xs text-base-content/60">每组最多保留 50 条，最长 7 天，较早记录自动清理。仅记录确认生效的自动切换。</p>
        <div v-if="confirmClear" class="space-y-2 rounded-lg bg-base-200 p-3 text-sm">
          <p class="break-all">清空“{{ groupName }}”的切换历史？此操作无法撤销，{{ enabled ? '自动选点将继续运行。' : '当前节点和自动选点设置不变。' }}</p>
          <div class="flex flex-wrap justify-end gap-2"><button type="button" class="btn btn-ghost btn-sm min-h-11" :disabled="clearing" @click="confirmClear = false"><IconX :size="16" aria-hidden="true" /><span>取消</span></button><button type="button" class="btn btn-error btn-sm min-h-11" :disabled="clearing || loading" @click="clearHistory"><IconCheck :size="16" aria-hidden="true" /><span>{{ clearing ? '正在清空' : '确认清空' }}</span></button></div>
        </div>
        <div v-else class="flex justify-end"><button type="button" class="btn btn-ghost btn-sm min-h-11" :disabled="!events.length || loading || clearing || !updatedAt" @click="confirmClear = true"><IconTrash :size="16" aria-hidden="true" /><span>清空历史</span></button></div>
      </footer>
    </div>
    <form method="dialog" class="modal-backdrop"><button aria-label="关闭切换历史">关闭</button></form>
  </dialog>
</template>
