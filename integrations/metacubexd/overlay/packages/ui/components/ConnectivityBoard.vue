<script setup lang="ts">
import { IconActivity, IconBrandSpeedtest, IconCheck, IconInfoCircle, IconX } from '@tabler/icons-vue'
import { CONNECTIVITY_TARGETS, STREAMING_UNLOCK_TARGETS, reachabilityLabels, useReachabilityBoard } from '~/composables/useReachabilityBoard'
import type { ReachabilityTarget } from '~/composables/useReachabilityBoard'

const props = defineProps<{ initialNode?: string }>()
const { t } = useI18n()
const proxiesStore = useProxiesStore()
const configStore = useConfigStore()
const { view } = useWorkspace()
const allowedOrigins = computed(() => view.value?.allowedProbeOrigins)
const permitted = (target: ReachabilityTarget) => allowedOrigins.value?.includes(new URL(target.url).origin) ?? false
const { isRunning, results, context, progress, currentTargets, cancel, reset, testTargetsThroughNode } = useReachabilityBoard()

const selectableNames = computed(() => Array.from(new Set([
  ...proxiesStore.proxies.map(proxy => proxy.name), ...proxiesStore.nodeNames(),
])))
const selectedNode = ref('')
watch(selectableNames, names => {
  if (!names.includes(selectedNode.value))
    selectedNode.value = props.initialNode && names.includes(props.initialNode) ? props.initialNode : names[0] ?? ''
}, { immediate: true })

const activeGroup = ref<'connectivity' | 'streaming'>('connectivity')
const activeTargets = computed(() => activeGroup.value === 'connectivity' ? CONNECTIVITY_TARGETS : STREAMING_UNLOCK_TARGETS)
const tabs = computed(() => [
  { key: 'connectivity' as const, label: t('connectivityTargets'), count: CONNECTIVITY_TARGETS.length },
  { key: 'streaming' as const, label: t('streamingUnlockTargets'), count: STREAMING_UNLOCK_TARGETS.length },
])
// Changing the object under test invalidates completed and in-flight evidence.
watch([selectedNode, activeGroup, () => JSON.stringify(allowedOrigins.value)], reset, { flush: 'sync' })
const canRun = computed(() => !!selectedNode.value && activeTargets.value.some(permitted))
const domain = (url: string) => new URL(url).hostname
const testedAt = computed(() => context.value?.completedAt ? new Date(context.value.completedAt).toLocaleTimeString() : '')
function runBoard() {
  if (!canRun.value) return
  return testTargetsThroughNode(selectedNode.value, activeTargets.value, {
    timeout: configStore.latencyTestTimeoutDuration, allowedOrigins: allowedOrigins.value ?? [],
  })
}
defineExpose({ cancel })
</script>

<template>
  <div class="flex min-w-0 flex-col gap-4" data-testid="connectivity-board">
    <p class="text-xs text-base-content/65">通过所选节点或策略组访问下列站点。结果仅表示该代理路径的访问情况。</p>
    <div class="flex flex-wrap items-end gap-3">
      <label class="flex min-w-0 flex-1 flex-col gap-1 text-xs text-base-content/65">
        被测节点／策略组
        <select v-model="selectedNode" class="select w-full" aria-label="被测节点或策略组">
          <option v-if="!selectableNames.length" value="">暂无可检测节点</option>
          <option v-for="name in selectableNames" :key="name" :value="name">{{ name }}</option>
        </select>
      </label>
      <button class="btn btn-primary btn-sm" :disabled="!isRunning && !canRun" :title="isRunning ? '取消站点检测' : '检测所选节点的站点连通性'" :aria-label="isRunning ? '取消站点检测' : '开始站点检测'" @click="isRunning ? cancel() : runBoard()">
        <IconX v-if="isRunning" :size="18" /><IconBrandSpeedtest v-else :size="18" />
      </button>
    </div>
    <div class="flex w-fit max-w-full flex-wrap gap-1 rounded-xl bg-base-200/60 p-1" role="tablist" aria-label="检测站点类别">
      <button v-for="tab in tabs" :key="tab.key" role="tab" class="rounded-lg px-3 py-1.5 text-sm" :class="activeGroup === tab.key ? 'bg-primary text-primary-content' : 'text-base-content/70'" :aria-selected="activeGroup === tab.key" @click="activeGroup = tab.key">{{ tab.label }} <span class="text-xs opacity-70">{{ tab.count }}</span></button>
    </div>
    <div v-if="activeGroup === 'streaming'" class="flex items-start gap-2 text-xs text-warning"><IconInfoCircle :size="16" class="shrink-0" /><span>{{ t('reachabilityUnlockLimitation') }}</span></div>
    <div v-if="isRunning" role="status" aria-live="polite" class="flex min-w-0 items-center gap-2 rounded-lg bg-success/10 px-3 py-2 text-xs text-success">
      <span class="loading loading-spinner loading-xs shrink-0 motion-reduce:animate-none" />
      <span class="shrink-0">已处理 {{ progress.completed }}/{{ progress.total }}</span>
      <span class="min-w-0 break-all">正在检测：{{ currentTargets.map(target => domain(target.url)).join('、') }}</span>
    </div>
    <div class="grid grid-cols-1 gap-2 sm:grid-cols-2" role="list" aria-label="站点检测结果">
      <div v-for="target in activeTargets" :key="target.url" role="listitem" class="flex min-w-0 flex-wrap items-center justify-between gap-2 rounded-lg border border-base-content/10 bg-base-200/40 px-3 py-2">
        <div class="flex min-w-0 items-center gap-2">
          <IconActivity :size="16" class="shrink-0 text-base-content/40" :class="{ 'animate-pulse motion-reduce:animate-none text-success': results[target.name]?.status === 'testing' }" />
          <div class="min-w-0"><div class="text-sm font-medium">{{ target.name }}</div><div class="break-all text-xs text-base-content/55">{{ domain(target.url) }}</div></div>
        </div>
        <span v-if="!results[target.name]" class="text-xs text-base-content/60">{{ !allowedOrigins ? '读取检测许可中…' : !permitted(target) ? '未获检测许可' : '未检测' }}</span>
        <span v-else-if="results[target.name]?.reachable" class="inline-flex items-center gap-1 text-xs font-semibold text-success"><IconCheck :size="14" />{{ results[target.name]?.latency }} ms</span>
        <span v-else class="text-xs" :class="['denied', 'cancelled', 'testing', 'busy'].includes(results[target.name]!.status) ? 'text-base-content/65' : 'text-error'">{{ reachabilityLabels[results[target.name]!.status] }}</span>
      </div>
    </div>
    <p v-if="context && !isRunning" class="break-all text-xs text-base-content/65">本次检测：{{ context.nodeName }} · {{ testedAt }}</p>
    <p v-else-if="!isRunning" class="text-xs text-base-content/65">{{ !allowedOrigins ? '正在读取检测许可；若长时间未完成，请刷新代理页。' : !activeTargets.some(permitted) ? '当前部署未许可这些站点的检测，请联系管理员配置。' : '站点已列出，点击测速图标开始检测；未获许可的站点会跳过。' }}</p>
  </div>
</template>
