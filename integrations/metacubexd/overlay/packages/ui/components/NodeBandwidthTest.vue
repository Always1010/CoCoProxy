<script setup lang="ts">
import { onBeforeRouteLeave } from 'vue-router'
import { IconArrowDown, IconArrowUp, IconBrandSpeedtest, IconPlayerPlay, IconRefresh, IconX } from '@tabler/icons-vue'
import type { BandwidthDirection, BandwidthPhase } from '~/composables/useBandwidthTest'
import { useBandwidthTest } from '~/composables/useBandwidthTest'
import { siteGroupMembers } from '~/composables/useSiteProbes'
const { t } = useI18n()

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
const phaseLabels = computed<Record<BandwidthPhase, string>>(() => ({
  preparing: t('coco.anPreparingTest'), latency: t('coco.anMeasuringIdleLatency'), download: t('coco.anMeasuringDownload'), upload: t('coco.anMeasuringUpload'), finishing: t('coco.anFinishing'),
  cancelling: t('coco.anCancellingAndCleaningUp'), complete: t('coco.anTestComplete'), partial: t('coco.anPartiallyComplete'), failed: t('coco.anTestFailed'), cancelled: t('coco.anTestCancelled'),
}))
const phaseLabel = computed(() => uncertain.value ? t('coco.anConfirmingTaskStatus') : sending.value ? t('coco.anSubmittingRequest') : task.value ? phaseLabels.value[task.value.phase] : t('coco.anReadyToStart'))
const elapsed = computed(() => task.value ? Math.max(0, ((task.value.running ? clock.value : task.value.finishedAt ?? clock.value) - task.value.phaseStartedAt) / 1000) : 0)
const phaseLimit = computed(() => ['download', 'upload'].includes(task.value?.phase ?? '') ? (status.value?.limits.durationMs ?? 6000) / 1000 : undefined)
const progress = computed(() => Math.min(100, elapsed.value / (phaseLimit.value ?? (status.value?.limits.timeoutMs ?? 30000) / 1000) * 100))
const number = (value: number | null | undefined, suffix: string, digits = 1) => typeof value === 'number' && Number.isFinite(value) ? `${value.toFixed(digits)} ${suffix}` : t('coco.anCurrentlyUnavailable')
const speed = (direction: BandwidthDirection) => number(direction.status === 'running' ? direction.liveMbps : direction.mbps, 'Mbps')
const directionLabels = computed<Record<BandwidthDirection['status'], string>>(() => ({ pending: t('coco.anAwaitingTest'), running: t('coco.anTesting'), success: t('coco.anComplete'), insufficient: t('coco.anInsufficientSamples'), failed: t('coco.anFailed'), cancelled: t('coco.anCancelled') }))
const reasonLabels = computed<Record<string, string>>(() => ({
  ACTIVE_CONFLICT: t('coco.anActiveConfigurationChangedTestStopped'), CONTROLLER_UNAVAILABLE: t('coco.anTheProxyCoreIsTemporarilyUnavailable'),
  BANDWIDTH_TIMEOUT: t('coco.anTestTimeLimitReached'), BANDWIDTH_LIMIT: t('coco.anTrafficLimitReached'), BANDWIDTH_BYTE_LIMIT: t('coco.anTrafficLimitReached'), BANDWIDTH_SAMPLE_INSUFFICIENT: t('coco.anInsufficientValidSamples'),
  BANDWIDTH_UNAVAILABLE: t('coco.anNodeBandwidthTestingIsTemporarilyUnavailable'), BANDWIDTH_CANCELLED: t('coco.anTestCancelled2'),
  BANDWIDTH_CONFIG_INVALID: t('coco.anTemporaryTestConfigurationValidationFailedNo'),
}))
const reason = computed(() => task.value?.reason ? reasonLabels.value[task.value.reason] ?? t('coco.anTheTestCouldNotFullyComplete') : '')

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
  error.value = () => t('coco.anTheTestIsStillRunningOr')
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
  <Modal ref="dialog" class="node-bandwidth-modal" :title="t('coco.anNodeBandwidthTest')" :fixed-height="false" :close-disabled="locked" :before-close="beforeClose" @close="hidden">
    <template #icon><IconBrandSpeedtest :size="24" aria-hidden="true" /></template>
    <div class="space-y-4 text-sm">
      <label class="block space-y-1.5">
        <span class="font-medium">{{ t('coco.anTestNode') }}</span>
        <select v-model="selected" class="select select-bordered w-full" :disabled="!!task?.running || sending || uncertain || loading">
          <option v-if="!nodes.length" value="">{{ t('coco.anThisGroupHasNoProxyNodes') }}</option>
          <option v-for="node in nodes" :key="node" :value="node">{{ node }}</option>
        </select>
      </label>
      <div class="space-y-1 text-xs text-base-content/65">
        <p class="break-all">{{ t('coco.anTestOriginCurrentGateway', { value: origin }) }}</p>
        <p>{{ t('coco.anSpeedTestService', { value: status?.server.name ?? 'Cloudflare', value2: status?.server.url ?? 'https://speed.cloudflare.com' }) }}</p>
        <p>{{ t('coco.anQuickTestDownloadAndUploadEach', { value: (status?.limits.durationMs ?? 6000) / 1000, value2: (status?.limits.maxBytes ?? 200000000) / 1000000, value3: (status?.limits.timeoutMs ?? 30000) / 1000 }) }}</p>
        <p>{{ t('coco.anTheProxyContinuesWorkingDuringThe') }}</p>
        <p v-if="status?.automaticRunning" class="text-warning" role="status">{{ t('coco.anBandwidthAssistedDecisionsAreValidatingA') }}</p>
      </div>

      <section v-if="task || sending || uncertain" class="space-y-3 rounded-xl bg-base-200 p-3" :aria-label="t('coco.anNodeBandwidthTestStatus')" aria-live="polite">
        <div class="space-y-1">
          <p class="break-all font-medium">{{ task?.node ?? selected }}</p>
          <p class="flex items-center gap-2"><IconRefresh v-if="task?.running || sending || uncertain" :size="16" class="shrink-0 animate-spin" aria-hidden="true" /><span>{{ phaseLabel }}</span></p>
          <p v-if="task?.running" class="text-xs text-base-content/65">{{ t('coco.anCurrentPhaseSeconds', { value: elapsed.toFixed(1) }) }}<template v-if="phaseLimit"> {{ t('coco.anUpToSeconds', { value: phaseLimit }) }}</template></p>
          <progress v-if="task?.running" class="progress progress-primary w-full" :value="progress" max="100" :aria-label="t('coco.anProgress', { value: phaseLabel })" />
          <p v-if="task?.running && !task.owned" class="text-xs text-warning">{{ t('coco.anAnotherBrowserIsRunningTheTest') }}</p>
          <p v-else-if="locked" class="text-xs text-base-content/65">{{ t('coco.anKeepThisDialogOpenUntilCompletion') }}</p>
        </div>
        <template v-if="task">
          <div class="grid grid-cols-2 gap-3">
            <div v-for="direction in (['download', 'upload'] as const)" :key="direction" class="min-w-0 rounded-lg bg-base-100 p-3">
              <p class="flex items-center gap-1 text-xs text-base-content/65"><IconArrowDown v-if="direction === 'download'" :size="15" aria-hidden="true" /><IconArrowUp v-else :size="15" aria-hidden="true" /><span>{{ direction === 'download' ? t('coco.anDownload') : t('coco.anUpload') }} · {{ directionLabels[task[direction].status] }}</span></p>
              <p class="mt-1 break-words text-lg font-semibold tabular-nums">{{ speed(task[direction]) }}</p>
              <p v-if="task[direction].mbps !== null" class="text-xs text-base-content/65">{{ number(task[direction].mbps! / 8, 'MB/s') }}</p>
            </div>
          </div>
          <div class="grid grid-cols-3 gap-2 text-xs text-base-content/70">
            <p v-for="item in (['idle', 'download', 'upload'] as const)" :key="item">{{ item === 'idle' ? t('coco.anIdleLatency') : item === 'download' ? t('coco.anLatencyDuringDownload') : t('coco.anLatencyDuringUpload') }}<br /><span class="tabular-nums">{{ number(task.latency[item], 'ms', 0) }}</span></p>
          </div>
          <p class="text-xs text-base-content/65">{{ t('coco.anPayloadUsedMb', { value: (task.bytesUsed / 1000000).toFixed(2), value2: (status?.limits.maxBytes ?? 200000000) / 1000000 }) }}</p>
          <p v-if="reason" class="text-xs text-warning">{{ reason }}</p>
        </template>
      </section>
      <p v-if="error" role="alert" class="text-sm text-error">{{ error }}</p>
      <p v-if="status?.available === false" class="text-sm text-warning">{{ t('coco.anNodeBandwidthTestingIsNotEnabled') }}</p>
    </div>
    <template #actions>
      <button v-if="uncertain || error" type="button" class="btn btn-ghost btn-sm min-h-11 min-w-28" :disabled="loading || sending" @click="refresh(true)"><IconRefresh :size="16" :class="{ 'animate-spin': loading }" aria-hidden="true" /><span>{{ loading ? t('coco.anLoading') : t('coco.anReadStatus') }}</span></button>
      <button v-if="task?.running && task.owned" type="button" class="btn btn-warning btn-sm min-h-11" :disabled="loading || sending || uncertain || task.phase === 'cancelling'" @click="cancel"><IconX :size="16" aria-hidden="true" /><span>{{ task.phase === 'cancelling' ? t('coco.anCancelling') : t('coco.anCancelTest') }}</span></button>
      <button v-else-if="!task?.running" type="button" class="btn btn-primary btn-sm min-h-11" :disabled="!canStart || !selected || !nodes.includes(selected)" @click="start(selected)"><IconPlayerPlay :size="16" aria-hidden="true" /><span>{{ sending ? t('coco.anStarting') : task ? t('coco.anTestAgain') : t('coco.anStartTest') }}</span></button>
      <button v-if="!locked" type="button" class="btn btn-ghost btn-sm min-h-11 min-w-11" :title="t('coco.anCloseDialog')" :aria-label="t('coco.anCloseDialog')" @click="dialog?.close()"><IconX :size="16" aria-hidden="true" /><span>{{ t('coco.anClose') }}</span></button>
    </template>
  </Modal>
</template>

<style scoped>
.node-bandwidth-modal :deep(.modal-shell) {
  max-width: 30rem;
}
</style>
