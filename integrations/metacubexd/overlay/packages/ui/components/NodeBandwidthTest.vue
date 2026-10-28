<script setup lang="ts">
import { onBeforeRouteLeave } from 'vue-router'
import { IconArrowDown, IconArrowUp, IconBrandSpeedtest, IconPlayerPlay, IconRefresh, IconX } from '@tabler/icons-vue'
import type { BandwidthDirection, BandwidthPhase } from '~/composables/useBandwidthTest'
import { useBandwidthTest } from '~/composables/useBandwidthTest'
import { siteGroupMembers } from '~/composables/useSiteProbes'

const props = defineProps<{ groupName: string; currentNode: string }>()
const proxies = useProxiesStore()
const dialog = ref<{ open: () => void; close: () => void }>()
const { status, task, visible, loading, sending, uncertain, error, locked, canStart, start, cancel, refresh, shown, hidden, restore } = useBandwidthTest()
const selected = ref('')
const clock = ref(Date.now())
let ticker: ReturnType<typeof setInterval> | undefined
const nodes = computed(() => siteGroupMembers(props.groupName, proxies.proxies).filter(name => {
  const node = proxies.getNode(name)
  return !/^(DIRECT|REJECT|REJECT-DROP|PASS|COMPATIBLE)$/i.test(name) && !!node && !/^(Direct|Reject|RejectDrop|Reject-Drop|Pass|Compatible|Selector|URLTest|Fallback|LoadBalance|Relay)$/i.test(node.type)
    && !proxies.proxies.some(group => group.name === name && !!group.all)
}))
const origin = computed(() => import.meta.client ? window.location.origin : '')
const phaseLabels: Record<BandwidthPhase, string> = {
  preparing: '正在准备测试', latency: '正在测空闲延迟', download: '正在测下载', upload: '正在测上传', finishing: '正在收尾',
  cancelling: '正在取消并清理', complete: '测试完成', partial: '部分完成', failed: '测试失败', cancelled: '测试已取消',
}
const phaseLabel = computed(() => uncertain.value ? '正在确认任务状态' : sending.value ? '正在提交请求' : task.value ? phaseLabels[task.value.phase] : '准备开始')
const elapsed = computed(() => task.value ? Math.max(0, ((task.value.running ? clock.value : task.value.finishedAt ?? clock.value) - task.value.phaseStartedAt) / 1000) : 0)
const phaseLimit = computed(() => ['download', 'upload'].includes(task.value?.phase ?? '') ? (status.value?.limits.durationMs ?? 6000) / 1000 : undefined)
const progress = computed(() => Math.min(100, elapsed.value / (phaseLimit.value ?? (status.value?.limits.timeoutMs ?? 30000) / 1000) * 100))
const number = (value: number | null | undefined, suffix: string, digits = 1) => typeof value === 'number' && Number.isFinite(value) ? `${value.toFixed(digits)} ${suffix}` : '暂不可用'
const speed = (direction: BandwidthDirection) => number(direction.status === 'running' ? direction.liveMbps : direction.mbps, 'Mbps')
const directionLabels: Record<BandwidthDirection['status'], string> = { pending: '待测试', running: '测试中', success: '已完成', insufficient: '样本不足', failed: '失败', cancelled: '已取消' }
const reasonLabels: Record<string, string> = {
  ACTIVE_CONFLICT: '生效配置已变化，测试停止', CONTROLLER_UNAVAILABLE: '代理核心暂不可用',
  BANDWIDTH_TIMEOUT: '已达到测试时限', BANDWIDTH_LIMIT: '已达到流量上限', BANDWIDTH_BYTE_LIMIT: '已达到流量上限', BANDWIDTH_SAMPLE_INSUFFICIENT: '有效样本不足',
  BANDWIDTH_UNAVAILABLE: '节点带宽测试暂不可用', BANDWIDTH_CANCELLED: '已取消测试',
}
const reason = computed(() => task.value?.reason ? reasonLabels[task.value.reason] ?? '测试未能全部完成，请检查节点与服务状态后重试。' : '')

function chooseDefault() { selected.value = nodes.value.includes(props.currentNode) ? props.currentNode : nodes.value[0] ?? '' }
function open() {
  if (!visible.value) chooseDefault()
  dialog.value?.open()
  shown()
}
function beforeClose() {
  if (locked.value) return false
  hidden()
  return true
}
function beforeUnload(event: BeforeUnloadEvent) {
  if (!locked.value) return
  event.preventDefault()
  event.returnValue = ''
}
onBeforeRouteLeave((to) => {
  if (to.path === '/login' || !locked.value) return true
  error.value = '测试仍在运行或操作结果尚未确认，请等待结束或取消测试后再离开。'
  return false
})
watch(nodes, () => { if (!task.value?.running && !nodes.value.includes(selected.value)) chooseDefault() })
onMounted(async () => {
  window.addEventListener('beforeunload', beforeUnload)
  ticker = setInterval(() => { if (visible.value && task.value?.running && !document.hidden) clock.value = Date.now() }, 250)
  if (await restore()) open()
})
onUnmounted(() => { window.removeEventListener('beforeunload', beforeUnload); if (ticker) clearInterval(ticker) })
defineExpose({ open })
</script>

<template>
  <Modal ref="dialog" class="node-bandwidth-modal" title="节点带宽测试" :fixed-height="false" :close-disabled="locked" :before-close="beforeClose" @close="hidden">
    <template #icon><IconBrandSpeedtest :size="24" aria-hidden="true" /></template>
    <div class="space-y-4 text-sm">
      <label class="block space-y-1.5">
        <span class="font-medium">测试节点</span>
        <select v-model="selected" class="select select-bordered w-full" :disabled="!!task?.running || sending || uncertain || loading">
          <option v-if="!nodes.length" value="">当前组没有可测试的代理节点</option>
          <option v-for="node in nodes" :key="node" :value="node">{{ node }}</option>
        </select>
      </label>
      <div class="space-y-1 text-xs text-base-content/65">
        <p class="break-all">测试发起端：当前网关 {{ origin }}</p>
        <p>测速服务：{{ status?.server.name ?? 'Cloudflare' }} · {{ status?.server.url ?? 'https://speed.cloudflare.com' }}</p>
        <p>快速测试：下载、上传各最多 {{ (status?.limits.durationMs ?? 6000) / 1000 }} 秒；总载荷最多 {{ (status?.limits.maxBytes ?? 200000000) / 1000000 }} MB；含准备最多 {{ (status?.limits.timeoutMs ?? 30000) / 1000 }} 秒。</p>
        <p>测试期间代理继续工作，带宽占用可能影响其他设备。</p>
      </div>

      <section v-if="task || sending || uncertain" class="space-y-3 rounded-xl bg-base-200 p-3" aria-label="节点带宽测试状态" aria-live="polite">
        <div class="space-y-1">
          <p class="break-all font-medium">{{ task?.node ?? selected }}</p>
          <p class="flex items-center gap-2"><IconRefresh v-if="task?.running || sending || uncertain" :size="16" class="shrink-0 animate-spin" aria-hidden="true" /><span>{{ phaseLabel }}</span></p>
          <p v-if="task?.running" class="text-xs text-base-content/65">当前阶段 {{ elapsed.toFixed(1) }} 秒<template v-if="phaseLimit"> / 最多 {{ phaseLimit }} 秒</template></p>
          <progress v-if="task?.running" class="progress progress-primary w-full" :value="progress" max="100" :aria-label="`${phaseLabel}进度`" />
          <p v-if="task?.running && !task.owned" class="text-xs text-warning">另一个浏览器正在测试，仅可查看；可关闭此弹窗。</p>
          <p v-else-if="locked" class="text-xs text-base-content/65">请保持弹窗开启，结束或取消完成后可离开；关闭浏览器无法保证任务停止。</p>
        </div>
        <template v-if="task">
          <div class="grid grid-cols-2 gap-3">
            <div v-for="direction in (['download', 'upload'] as const)" :key="direction" class="min-w-0 rounded-lg bg-base-100 p-3">
              <p class="flex items-center gap-1 text-xs text-base-content/65"><IconArrowDown v-if="direction === 'download'" :size="15" aria-hidden="true" /><IconArrowUp v-else :size="15" aria-hidden="true" /><span>{{ direction === 'download' ? '下载' : '上传' }} · {{ directionLabels[task[direction].status] }}</span></p>
              <p class="mt-1 break-words text-lg font-semibold tabular-nums">{{ speed(task[direction]) }}</p>
              <p v-if="task[direction].mbps !== null" class="text-xs text-base-content/65">{{ number(task[direction].mbps! / 8, 'MB/s') }}</p>
            </div>
          </div>
          <div class="grid grid-cols-3 gap-2 text-xs text-base-content/70">
            <p v-for="item in (['idle', 'download', 'upload'] as const)" :key="item">{{ item === 'idle' ? '空闲延迟' : item === 'download' ? '下载时延迟' : '上传时延迟' }}<br /><span class="tabular-nums">{{ number(task.latency[item], 'ms', 0) }}</span></p>
          </div>
          <p class="text-xs text-base-content/65">已用载荷 {{ (task.bytesUsed / 1000000).toFixed(2) }} / {{ (status?.limits.maxBytes ?? 200000000) / 1000000 }} MB</p>
          <p v-if="reason" class="text-xs text-warning">{{ reason }}</p>
        </template>
      </section>
      <p v-if="error" role="alert" class="text-sm text-error">{{ error }}</p>
      <p v-if="status?.available === false" class="text-sm text-warning">当前部署未启用节点带宽测试。</p>
    </div>
    <template #actions>
      <button v-if="uncertain || error" type="button" class="btn btn-ghost btn-sm min-h-11" :disabled="loading || sending" @click="refresh(true)"><IconRefresh :size="16" aria-hidden="true" /><span>读取状态</span></button>
      <button v-if="task?.running && task.owned" type="button" class="btn btn-warning btn-sm min-h-11" :disabled="loading || sending || uncertain || task.phase === 'cancelling'" @click="cancel"><IconX :size="16" aria-hidden="true" /><span>{{ task.phase === 'cancelling' ? '正在取消' : '取消测试' }}</span></button>
      <button v-else-if="!task?.running" type="button" class="btn btn-primary btn-sm min-h-11" :disabled="!canStart || !selected || !nodes.includes(selected)" @click="start(selected)"><IconPlayerPlay :size="16" aria-hidden="true" /><span>{{ sending ? '正在开始' : task ? '重新测试' : '开始测试' }}</span></button>
      <button v-if="!locked" type="button" class="btn btn-ghost btn-sm min-h-11" @click="dialog?.close()"><IconX :size="16" aria-hidden="true" /><span>关闭</span></button>
    </template>
  </Modal>
</template>

<style scoped>
.node-bandwidth-modal :deep(.modal-shell) {
  max-width: 30rem;
}
</style>
