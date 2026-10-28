<script setup lang="ts">
import { IconActivity, IconBrandSpeedtest, IconCheck, IconInfoCircle, IconX } from '@tabler/icons-vue'
import { CONNECTIVITY_TARGETS, STREAMING_UNLOCK_TARGETS, reachabilityLabels, useReachabilityBoard } from '~/composables/useReachabilityBoard'
import type { ReachabilityTarget } from '~/composables/useReachabilityBoard'

const props = defineProps<{ initialNode?: string }>()
const { t, locale } = useI18n()
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
const testedAt = computed(() => context.value?.completedAt ? new Date(context.value.completedAt).toLocaleTimeString(locale.value) : '')
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
    <p class="text-xs text-base-content/65">{{ t('coco.anAccessTheseSitesThroughTheSelected') }}</p>
    <div class="flex flex-wrap items-end gap-3">
      <label class="flex min-w-0 flex-1 flex-col gap-1 text-xs text-base-content/65">
        {{ t('coco.anNodeProxyGroupUnderTest') }}
        <select v-model="selectedNode" class="select w-full" :aria-label="t('coco.anNodeOrProxyGroupUnderTest')">
          <option v-if="!selectableNames.length" value="">{{ t('coco.anNoNodesAvailableToCheck') }}</option>
          <option v-for="name in selectableNames" :key="name" :value="name">{{ name }}</option>
        </select>
      </label>
      <button class="btn btn-primary btn-sm" :disabled="!isRunning && !canRun" :title="isRunning ? t('coco.anCancelSiteChecks') : t('coco.anCheckSiteConnectivityThroughTheSelected')" :aria-label="isRunning ? t('coco.anCancelSiteChecks') : t('coco.anStartSiteChecks')" @click="isRunning ? cancel() : runBoard()">
        <IconX v-if="isRunning" :size="18" /><IconBrandSpeedtest v-else :size="18" />
        <span>{{ isRunning ? t('coco.anCancelChecks') : t('coco.anStartChecks') }}</span>
      </button>
    </div>
    <div class="flex w-fit max-w-full flex-wrap gap-1 rounded-xl bg-base-200/60 p-1" role="tablist" :aria-label="t('coco.anSiteCheckCategories')">
      <button v-for="tab in tabs" :key="tab.key" role="tab" class="rounded-lg px-3 py-1.5 text-sm" :class="activeGroup === tab.key ? 'bg-primary text-primary-content' : 'text-base-content/70'" :aria-selected="activeGroup === tab.key" @click="activeGroup = tab.key">{{ tab.label }} <span class="text-xs opacity-70">{{ tab.count }}</span></button>
    </div>
    <div v-if="activeGroup === 'streaming'" class="flex items-start gap-2 text-xs text-warning"><IconInfoCircle :size="16" class="shrink-0" /><span>{{ t('reachabilityUnlockLimitation') }}</span></div>
    <div v-if="isRunning" role="status" aria-live="polite" class="flex min-w-0 items-center gap-2 rounded-lg bg-success/10 px-3 py-2 text-xs text-success">
      <span class="loading loading-spinner loading-xs shrink-0 motion-reduce:animate-none" />
      <span class="shrink-0">{{ t('coco.anProcessed', { value: progress.completed, value2: progress.total }) }}</span>
      <span class="min-w-0 break-all">{{ t('coco.anChecking', { value: currentTargets.map(target => `${target.name} · ${domain(target.url)}`).join('、') }) }}</span>
    </div>
    <div class="grid grid-cols-1 gap-2 sm:grid-cols-2" role="list" :aria-label="t('coco.anSiteCheckResults')">
      <div v-for="target in activeTargets" :key="target.url" role="listitem" class="flex min-w-0 flex-wrap items-center justify-between gap-2 rounded-lg border border-base-content/10 bg-base-200/40 px-3 py-2">
        <div class="flex min-w-0 items-center gap-2">
          <IconActivity :size="16" class="shrink-0 text-base-content/40" :class="{ 'animate-pulse motion-reduce:animate-none text-success': results[target.name]?.status === 'testing' }" />
          <div class="min-w-0"><div class="text-sm font-medium">{{ target.name }}</div><div class="break-all text-xs text-base-content/55">{{ domain(target.url) }}</div></div>
        </div>
        <span v-if="!results[target.name]" class="text-xs text-base-content/60">{{ !allowedOrigins ? t('coco.anLoadingCheckPermissions') : !permitted(target) ? t('coco.anCheckNotPermitted') : t('coco.anNotChecked') }}</span>
        <span v-else-if="results[target.name]?.reachable" class="inline-flex items-center gap-1 text-xs font-semibold text-success"><IconCheck :size="14" />{{ results[target.name]?.latency }} ms</span>
        <span v-else class="text-xs" :class="['denied', 'cancelled', 'testing', 'busy'].includes(results[target.name]!.status) ? 'text-base-content/65' : 'text-error'">{{ t(reachabilityLabels[results[target.name]!.status]) }}</span>
      </div>
    </div>
    <p v-if="context && !isRunning" class="break-all text-xs text-base-content/65">{{ t('coco.anThisCheck', { value: context.nodeName, value2: testedAt }) }}</p>
    <p v-else-if="!isRunning" class="text-xs text-base-content/65">{{ !allowedOrigins ? t('coco.anLoadingCheckPermissionsRefreshTheProxies') : !activeTargets.some(permitted) ? t('coco.anThisDeploymentDoesNotPermitChecks') : t('coco.anSitesAreListedSelectStartChecks') }}</p>
  </div>
</template>
