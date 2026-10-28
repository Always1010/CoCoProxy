<script setup lang="ts">
import { IconArrowRight, IconCheck, IconChevronUp, IconHistory, IconRefresh, IconTrash, IconX } from '@tabler/icons-vue'
import type { AutomaticStatus } from '~/composables/useWorkspace'
import { cocoproxyErrorMessage } from '~/composables/useCoCoProxy'
const { t, locale } = useI18n()

const props = defineProps<{ groupName: string; selectable: boolean }>()
const { api, view, overrides } = useWorkspace()
type HistoryEvent = AutomaticStatus['events'][number]
const dialog = ref<{ open: () => void; close: () => void }>()
const scroller = ref<HTMLElement>()
const visible = ref(false)
const status = ref<AutomaticStatus>()
const displayed = ref<HistoryEvent[]>([])
const loading = ref(false)
const refreshing = ref(false)
const clearing = ref(false)
const confirmClear = ref(false)
const error = useLocalizedMessage()
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
const currentNode = computed(() => enabled.value && groupStatus.value?.current || view.value?.groups.find(g => g.name === props.groupName)?.activeSelected || t('coco.anNotConfirmed'))
const currentPool = computed(() => enabled.value && policy.value?.preferred.includes(currentNode.value) ? t('coco.anPreferred')
  : enabled.value && policy.value?.fallback.includes(currentNode.value) ? t('coco.anFallback') : '')
const events = computed(() => (status.value?.events ?? []).filter(e => e.group === props.groupName).slice().reverse())
const eventKey = (event: HistoryEvent) => event.id ?? JSON.stringify([event.at, event.from, event.to, event.reason])
const newCount = computed(() => {
  const shown = new Set(displayed.value.map(eventKey))
  return events.value.filter(e => !shown.has(eventKey(e))).length
})
const phases = computed<Record<string, string>>(() => ({
  outage: t('coco.anNoAvailableExitRetryingWithBackoff'), 'slow-search': t('coco.anLookingForAFasterCandidate'), 'failure-search': t('coco.anLookingForAnAvailableCandidate'),
  'failure-confirmation': t('coco.anRecheckingTheCurrentNode'), 'return-confirmation': t('coco.anConfirmingPreferredNodeRecovery'), backup: t('coco.anUsingFallbackMonitoringTheCurrentNode'), monitoring: t('coco.anMonitoringTheCurrentNode'),
}))
const reasons = computed<Record<string, string>>(() => ({
  'bandwidth-improvement': t('coco.anSwitchedBecauseTheConservativeThroughputBenefit'),
  'preferred-restored': t('coco.anThePreferredNodeRecoveredAndPassed'), 'faster-candidate': t('coco.anTheCurrentNodeRemainedSlowAnd'),
  'failure-recovery': t('coco.anThePreviousNodeFailedChecksAnd'), 'current-slow': t('coco.anTheCurrentNodeRemainsSlow'),
  'current-unavailable': t('coco.anTheCurrentNodeIsUnavailable'), 'all-unavailable': t('coco.anNoAvailableExitWasConfirmedIn'),
  'no-better-candidate': t('coco.anNoSignificantlyFasterCandidateFoundYet'), 'preferred-check-failed': t('coco.anPreferredNodesHaveNotRecoveredReliably'),
}))
const phase = computed(() => !enabled.value ? t('coco.anAutomaticSelectionIsDisabledHistoryRemains')
  : status.value?.paused ? t('coco.anAutomaticSelectionIsPaused')
    : status.value?.suspended || view.value?.pending ? t('coco.anOperationIsUnavailableOrConfigurationIs')
      : groupStatus.value ? phases.value[groupStatus.value.phase] ?? t('coco.anWaitingForScheduling') : t('coco.anWaitingForSchedulingOrAStatus'))
const timeLabel = (at: number) => new Date(at).toLocaleString(locale.value)
const poolLabel = (pool?: string) => pool === 'preferred' ? t('coco.anPreferred') : pool === 'fallback' ? t('coco.anFallback') : ''
const eventLabel = (reason: string) => reason === 'bandwidth-improvement' ? t('coco.anThroughputSwitch') : reason === 'preferred-restored' ? t('coco.anReturnToPreferred') : reason === 'faster-candidate' ? t('coco.anPerformanceSwitch') : reason === 'failure-recovery' ? t('coco.anFailover') : t('coco.anAutomaticSwitch')

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
async function readStatus(background = true) {
  if (!visible.value || disposed || document.hidden || (loading.value && background) || clearing.value) return
  const id = ++requestId
  const requestScope = scope.value
  loading.value = true
  refreshing.value = !background
  try {
    const result = await api.request<AutomaticStatus>('/api/cocoproxy/automatic/status')
    if (visible.value && id === requestId && requestScope === scope.value) {
      if (result.scope !== requestScope || result.workspaceRevision !== view.value?.workspace.revision) {
        error.value = () => t('coco.anThePlanOrSettingsChangedClose')
        return
      }
      accept(result)
    }
  } catch (cause) {
    if (visible.value && id === requestId) error.value = () => cocoproxyErrorMessage(cause, t)
  } finally { if (id === requestId) { loading.value = false; refreshing.value = false } }
}
async function poll(currentSession: number) {
  await readStatus(!!status.value)
  if (visible.value && !disposed && currentSession === session) timer = setTimeout(() => { void poll(currentSession) }, 8000)
}
function close() {
  session++
  requestId++
  visible.value = false
  loading.value = false
  refreshing.value = false
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
  dialog.value?.open()
  void poll(++session)
}
async function clearHistory() {
  if (clearing.value || refreshing.value || !confirmClear.value || !status.value?.scope) return
  if (status.value.workspaceRevision !== view.value?.workspace.revision) {
    error.value = () => t('coco.anThePlanOrSettingsChangedClose')
    return
  }
  const id = ++requestId
  // A background read started before the clear must never restore old records.
  loading.value = false
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
    if (visible.value && id === requestId) error.value = () => cocoproxyErrorMessage(cause, t)
  } finally { clearing.value = false }
}
function visibilityChanged() { if (!document.hidden) void readStatus() }
watch(() => [props.groupName, scope.value], () => { dialog.value?.close(); close() })
onMounted(() => document.addEventListener('visibilitychange', visibilityChanged))
onUnmounted(() => { disposed = true; close(); document.removeEventListener('visibilitychange', visibilityChanged) })
</script>

<template>
  <span v-if="available" class="shrink-0">
    <button type="button" class="btn btn-ghost btn-sm min-h-11" :aria-label="t('coco.anSwitchHistoryFor', { value: groupName })" @click="open"><IconHistory :size="18" aria-hidden="true" /><span>{{ t('coco.anSwitchHistory') }}</span></button>
  </span>
  <Modal ref="dialog" :title="t('coco.anSwitchHistory2', { value: groupName })" @close="close">
    <template #content>
      <div class="mb-3 flex min-h-11 shrink-0 items-center gap-2">
        <button v-if="newCount" type="button" class="btn btn-primary btn-sm min-h-11 shrink-0" @click="showLatest()"><IconChevronUp :size="16" aria-hidden="true" /><span>{{ t('coco.anNewRecordsViewLatest', { value: newCount }) }}</span></button>
        <p v-if="error" role="alert" class="min-w-0 text-sm text-warning">{{ t('coco.anUpdateFailedPreviouslyDisplayedRecordsAre', { value: error }) }}</p>
      </div>
      <div ref="scroller" class="min-h-0 flex-1 space-y-3 overflow-y-auto [scrollbar-gutter:stable]" @scroll="onScroll">
      <section class="shrink-0 space-y-1 rounded-lg bg-base-200 p-3 text-sm" :aria-label="t('coco.anCurrentAutomaticSelectionStatus')" aria-live="polite">
        <p>{{ enabled ? t('coco.anAutomaticSelectionIsOn') : t('coco.anAutomaticSelectionIsOff') }}</p>
        <p class="break-all">{{ t('coco.anCurrentExit', { value: currentNode, value2: currentPool ? ` · ${currentPool}` : '' }) }}</p>
        <p :class="groupStatus?.phase === 'outage' && enabled ? 'text-warning' : 'text-base-content/70'">{{ phase }}</p>
        <p class="text-xs text-base-content/65">{{ enabled && groupStatus?.reason ? reasons[groupStatus.reason] ?? t('coco.anTheOperationStatusChanged') : t('coco.anNoAdditionalReason') }}</p>
        <p class="text-xs text-base-content/65 tabular-nums">{{ t('coco.anNextCheck', { value: enabled && !status?.suspended && !view?.pending && groupStatus?.nextAt ? timeLabel(groupStatus.nextAt) : t('coco.anWaitingForScheduling') }) }}</p>
      </section>
      <div class="flex shrink-0 flex-wrap items-center justify-between gap-2 text-xs text-base-content/60">
        <span>{{ updatedAt ? t('coco.anLastUpdatedAt', { value: timeLabel(updatedAt) }) : t('coco.anLoadingHistory') }}</span>
        <button type="button" class="btn btn-ghost btn-sm min-h-11 min-w-28 shrink-0" :disabled="refreshing || clearing" @click="readStatus(false)"><IconRefresh :size="16" :class="{ 'animate-spin': refreshing }" aria-hidden="true" /><span>{{ refreshing ? t('coco.anRefreshing') : t('coco.anRefresh') }}</span></button>
      </div>
        <ol v-if="displayed.length" class="space-y-3" :aria-label="t('coco.anSwitchRecordsForThisGroup')">
          <li v-for="event in displayed" :key="eventKey(event)" class="space-y-2 rounded-lg border border-base-content/10 p-3 text-sm">
            <div class="flex flex-wrap items-center justify-between gap-2"><time :datetime="new Date(event.at).toISOString()" class="text-xs text-base-content/60">{{ timeLabel(event.at) }}</time><span class="badge badge-sm">{{ eventLabel(event.reason) }}</span></div>
            <div class="flex flex-wrap items-center gap-2"><span class="min-w-0 break-all">{{ event.from ?? t('coco.anNotSelected') }}<span v-if="event.fromPool" class="ml-1 text-xs text-base-content/60">（{{ poolLabel(event.fromPool) }}）</span></span><IconArrowRight :size="16" class="shrink-0" aria-hidden="true" /><span class="min-w-0 break-all">{{ event.to ?? t('coco.anNotSelected') }}<span v-if="event.toPool" class="ml-1 text-xs text-base-content/60">（{{ poolLabel(event.toPool) }}）</span></span></div>
            <p class="text-xs leading-relaxed text-base-content/70">{{ t('coco.anReason', { value: reasons[event.reason] ?? t('coco.anAutomaticSelectionConfirmedANewExit') }) }}</p>
          </li>
        </ol>
        <p v-else-if="status" class="py-8 text-center text-sm text-base-content/60">{{ enabled ? t('coco.anNoRetainedSwitchRecordsConfirmedNode') : t('coco.anNoRetainedSwitchRecords') }}</p>
      </div>
      <footer class="mt-3 max-h-[50%] shrink-0 space-y-2 overflow-y-auto border-t border-base-content/10 pt-3">
        <p class="text-xs text-base-content/60">{{ t('coco.anEachGroupRetainsUpToRecords') }}</p>
        <div v-if="confirmClear" class="space-y-2 rounded-lg bg-base-200 p-3 text-sm">
          <p class="break-all">{{ t('coco.anClearSwitchHistoryForThisCannot', { value: groupName, value2: enabled ? t('coco.anAutomaticSelectionWillContinueRunning') : t('coco.anTheCurrentNodeAndAutomaticSelection') }) }}</p>
          <div class="flex flex-wrap justify-end gap-2"><button type="button" class="btn btn-ghost btn-sm min-h-11" :disabled="clearing" @click="confirmClear = false"><IconX :size="16" aria-hidden="true" /><span>{{ t('coco.anCancel') }}</span></button><button type="button" class="btn btn-error btn-sm min-h-11" :disabled="clearing || refreshing" @click="clearHistory"><IconCheck :size="16" aria-hidden="true" /><span>{{ clearing ? t('coco.anClearing') : t('coco.anConfirmClear') }}</span></button></div>
        </div>
        <div v-else class="flex justify-end"><button type="button" class="btn btn-ghost btn-sm min-h-11" :disabled="!events.length || refreshing || clearing || !updatedAt" @click="confirmClear = true"><IconTrash :size="16" aria-hidden="true" /><span>{{ t('coco.anClearHistory') }}</span></button></div>
      </footer>
    </template>
  </Modal>
</template>
