<script setup lang="ts">
import { IconArrowLeft, IconBrandSpeedtest, IconChevronRight, IconList, IconRefresh } from '@tabler/icons-vue'
import type { AutomaticStatus, BandwidthSettings } from '~/composables/useWorkspace'
import { cocoproxyErrorMessage } from '~/composables/useCoCoProxy'
import BandwidthDecisionProcess from '~/components/BandwidthDecisionProcess.vue'
const { t, locale } = useI18n()

const props = defineProps<{ groupName: string; status?: AutomaticStatus; policyEnabled: boolean; bandwidth?: BandwidthSettings; dirty: boolean; disabled: boolean; reading: boolean; error: string }>()
const emit = defineEmits<{ refresh: []; checking: [value: boolean] }>()
const { api, view } = useWorkspace()
const detail = ref<'summary' | 'pool' | 'history'>('summary')
const checking = ref(false)
const feedback = useLocalizedMessage()
const group = computed(() => props.status?.groups.find(item => item.name === props.groupName))
const bandwidthStatus = computed(() => group.value?.bandwidth)
const engine = computed(() => props.status?.engine)
const engineSummary = computed(() => {
  if (!engine.value) return ''
  if (engine.value.state === 'error') return t('coco.autoEngineFailed')
  if (props.status?.paused) return t('coco.autoEngineReason.paused')
  if (props.status?.suspended && engine.value.state === 'running') return t('coco.anAutomaticSelectionIsSuspended')
  return engine.value.reason ? t('coco.autoEngineReason.' + engine.value.reason) : t('coco.autoEngineRunning')
})
const events = computed(() => props.status?.events.filter(event => event.group === props.groupName).slice().reverse() ?? [])
const canCheck = computed(() => props.policyEnabled && !!props.bandwidth?.enabled && !props.dirty && !props.disabled && !props.reading && !props.error && !!group.value && !!view.value?.active && !view.value?.pending && !props.status?.paused && !props.status?.suspended && !props.status?.error && (!engine.value || engine.value.state === 'running') && !bandwidthStatus.value?.testingNode && !checking.value)
let disposed = false
onUnmounted(() => { disposed = true; emit('checking', false) })
const phases = computed<Record<string, string>>(() => ({
  outage: t('coco.anNoConfirmedExitRetryingWithBackoff'), 'slow-search': t('coco.anLookingForAFasterCandidate'), 'failure-search': t('coco.anLookingForAnAvailableCandidate'),
  'failure-confirmation': t('coco.anRecheckingTheCurrentNode'), 'return-confirmation': t('coco.anConfirmingPreferredNodeRecovery'), backup: t('coco.anUsingFallback'), monitoring: t('coco.anMonitoringTheCurrentNode'),
}))
const reasons = computed<Record<string, string>>(() => ({
  'waiting-traffic': t('coco.anWaitingForEvidenceOfSustainedSlow'), 'waiting-idle': t('coco.anWaitingForIdleTrafficOrA'), 'budget-exhausted': t('coco.anAutomaticCheckBudgetIsInsufficientKeeping'),
  'measurement-unavailable': t('coco.anDownloadValidationServiceIsUnavailableNode'), collecting: t('coco.anCollectingValidSamplesForTheCurrent'), 'current-sufficient': t('coco.anCurrentLatencyIsNormalAndThroughput'),
  'no-candidate': t('coco.anNoComparableCandidates'), 'candidate-unavailable': t('coco.anTheCandidateFailedTheLightweightCheck'), 'sample-unknown': t('coco.anSamplesAreInvalidOrInsufficientThe'),
  'no-clear-gain': t('coco.anImprovementAfterVariationAndCostsIs'), 'would-switch': t('coco.anObservationModeSwitchingCriteriaMetBut'),
  'bandwidth-improvement': t('coco.anNetBenefitConfirmedThroughputPerformanceSwitch'), 'switch-limit': t('coco.anTheHoldPeriodOrRecentSwitch'),
  'latency-priority': t('coco.anLatencyChecksOrFailureRecoveryTake'), 'latency-pressure': t('coco.anResponseLatencyIncreasedDownloadValidationStopped'),
  'business-busy': t('coco.anBusinessTrafficIncreasedDownloadValidationStopped'), 'evidence-timeout': t('coco.anEvidenceWasNotCollectedWithinThe'), 'configuration-changed': t('coco.anConfigurationOrRunGenerationChangedOld'),
  'selection-conflict': t('coco.anStateChangedBeforeSwitchingNoSwitch'), 'storage-unavailable': t('coco.anBudgetLedgerIsUnavailableAutomaticDownloads'),
  'screening-latency': t('coco.anScreeningCandidateLatencyWithLightweightChecks'), 'waiting-sample': t('coco.anReusingExistingEvidenceWaitingForThe'),
  'search-yield': t('coco.anContinuousSearchReachedItsTrafficOr'), 'pool-backoff': t('coco.anCandidatesCurrentlyOfferInsufficientBenefitWaiting'),
  'no-potential-gain': t('coco.anEvenTargetThroughputWouldOfferInsufficient'), 'shortfall-guard': t('coco.anTheCandidateWouldIntroduceOrWorsen'),
  'post-switch-failure': t('coco.anTheNodeFailedShortlyAfterSwitching'), 'waiting-evidence': t('coco.anWaitingForFreshEvidence'), 'evidence-ready': t('coco.anValidEvidenceObtained'),
  'preferred-restored': t('coco.anPreferredNodeRecoveredSwitchedBack'), 'faster-candidate': t('coco.anCandidateIsFasterSwitched'), 'failure-recovery': t('coco.anPreviousNodeFailedSwitchedToAn'),
  'current-slow': t('coco.anTheCurrentNodeRemainsSlow'), 'current-unavailable': t('coco.anTheCurrentNodeIsUnavailable'), 'all-unavailable': t('coco.anNoAvailableExitWasConfirmedIn'),
  'no-better-candidate': t('coco.anNoSignificantlyFasterCandidateFoundYet'), 'preferred-check-failed': t('coco.anPreferredNodesHaveNotRecoveredReliably'),
}))
const states = computed<Record<string, string>>(() => ({ pending: t('coco.anAwaitingValidation'), confirming: t('coco.anAwaitingConfirmation'), verified: t('coco.anVerified'), backoff: t('coco.anBackoff'), unavailable: t('coco.anUnavailable') }))
const amount = (bytes: number) => (bytes / 1048576).toFixed(1)
const loss = (value: number) => t('coco.anPoints', { value: value.toFixed(3) })
const time = (value: number) => new Date(value).toLocaleTimeString(locale.value)
const reason = (value: string) => reasons.value[value] ?? t('coco.anWaitingForTheNextEvaluation')
async function check() {
  if (!canCheck.value || !view.value) return
  checking.value = true; feedback.value = ''
  emit('checking', true)
  let refresh = false
  try {
    await api.request('/api/cocoproxy/automatic/bandwidth/check', { method: 'POST', body: {
      expectedRevision: view.value.workspace.revision, expectedActive: view.value.active,
      scope: props.status?.scope, group: props.groupName,
    } })
    if (!disposed) { feedback.value = () => t('coco.anThisGroupSCandidateCheckIs'); refresh = true }
  } catch (cause) { if (!disposed) feedback.value = () => cocoproxyErrorMessage(cause, t) }
  finally { if (!disposed) { checking.value = false; emit('checking', false); if (refresh) emit('refresh') } }
}
</script>

<template>
  <section class="space-y-4" :aria-label="t('coco.anAutomaticSelectionOperationStatus')">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <button v-if="detail !== 'summary'" type="button" class="btn btn-ghost min-h-11" @click="detail = 'summary'"><IconArrowLeft :size="16" /><span>{{ t('coco.anBackToOperationOverview') }}</span></button>
      <SettingsNotice v-else>{{ t('coco.anReflectsTheSavedAndActiveConfiguration') }}</SettingsNotice>
      <button type="button" class="btn btn-ghost min-h-11 min-w-28 shrink-0" :disabled="reading || disabled || checking" @click="emit('refresh')"><IconRefresh :size="16" :class="{ 'animate-spin': reading }" /><span>{{ reading ? t('coco.anRefreshing') : t('coco.anRefreshStatus') }}</span></button>
    </div>
    <p v-if="error" role="alert" class="text-sm text-warning">{{ t('coco.anFailedToLoadStatusPreviousResults', { value: error }) }}</p>
    <p v-if="status?.error || status?.paused || status?.suspended" role="status" class="text-sm text-warning">{{ status?.error ? t('coco.anOperationIsUnavailableOrConfigurationIs') : (status?.suspended ? t('coco.anAutomaticSelectionIsSuspended') : t('coco.anAutomaticSelectionIsPaused')) }}</p>
    <p v-if="engine?.error" role="alert" class="break-words text-sm text-warning">{{ t('coco.autoEngineError', { phase: t('coco.autoEnginePhase.' + engine.error.phase), code: engine.error.code, count: engine.error.count }) }}</p>
    <template v-if="detail === 'summary'">
      <dl class="status-facts text-sm">
        <dt>{{ t('coco.anCurrentExit2') }}</dt><dd class="break-all">{{ group?.current ?? view?.groups.find(item => item.name === groupName)?.activeSelected ?? t('coco.anNotSelectedYet') }}</dd>
        <dt>{{ t('coco.anAutomaticSelection') }}</dt><dd>{{ !policyEnabled ? t('coco.anOff') : engine && (engine.state !== 'running' || status?.suspended || status?.paused) ? engineSummary : group ? (phases[group.phase] ?? t('coco.anAutomaticSelectionIsRunning')) : t('coco.anWaitingForOperationStatus') }}</dd>
        <dt>{{ t('coco.anCurrentReason') }}</dt><dd>{{ group?.reason ? reason(group.reason) : t('coco.anNoAdditionalReason') }}</dd>
        <dt>{{ t('coco.anNextCheck2') }}</dt><dd class="tabular-nums">{{ engine && engine.state !== 'running' ? engineSummary : engine?.nextStartAt != null && group?.nextAt != null ? time(Math.max(group.nextAt, engine.nextStartAt)) : group?.nextAt != null ? time(group.nextAt) : t('coco.anWaitingForScheduling') }}</dd>
        <template v-if="engine">
          <dt>{{ t('coco.autoEngineLabel') }}</dt><dd>{{ engineSummary }}</dd>
          <dt>{{ t('coco.autoEngineLastSnapshot') }}</dt><dd class="tabular-nums">{{ engine.lastSnapshotAt == null ? t('coco.anUnknown') : time(engine.lastSnapshotAt) }}</dd>
          <dt>{{ t('coco.autoEngineLastCompleted') }}</dt><dd class="tabular-nums">{{ engine.lastCompletedAt == null ? t('coco.anUnknown') : time(engine.lastCompletedAt) }}</dd>
        </template>
        <dt>{{ t('coco.anBandwidthAssistedDecisions2') }}</dt><dd>{{ !bandwidth?.enabled ? t('coco.anOff') : !policyEnabled ? t('coco.anAutomaticSelectionIsOffAndNot') : bandwidthStatus ? reason(bandwidthStatus.reason) : t('coco.anWaitingForOperationStatus') }}{{ bandwidth?.enabled && bandwidth.observeOnly ? t('coco.anObserveOnly') : '' }}</dd>
      </dl>
      <p v-if="engine?.state === 'running' && (engine.pendingProbes || engine.nextStartAt != null)" role="status" class="text-sm text-base-content/70">{{ t('coco.autoEngineQueue', { count: engine.pendingProbes }) }} <span v-if="engine.nextStartAt != null">{{ t('coco.autoEngineNextStart', { time: time(engine.nextStartAt) }) }}</span></p>
      <div v-if="bandwidth?.enabled" class="flex min-h-10 items-start gap-2 text-sm" role="status"><span v-if="bandwidthStatus?.testingNode" class="loading loading-spinner loading-sm shrink-0" /><span class="break-all">{{ bandwidthStatus?.testingNode ? t('coco.anValidatingValidSamples', { value: bandwidthStatus.testingNode, value2: bandwidthStatus.round, value3: bandwidth?.confirmRounds }) : t('coco.anNoNodeIsCurrentlyBeingValidated') }}</span></div>
      <div v-if="bandwidthStatus" class="space-y-2 border-t border-base-content/10 pt-4 text-sm">
        <h4 class="font-medium">{{ t('coco.anAutomaticCheckUsage') }}</h4>
        <p>{{ t('coco.anRollingHourMib', { value: amount(bandwidthStatus.hourBytes), value2: amount(bandwidthStatus.hourLimit) }) }}</p>
        <p>{{ t('coco.anRollingHoursMib', { value: amount(bandwidthStatus.dayBytes), value2: amount(bandwidthStatus.dayLimit) }) }}</p>
        <p v-if="bandwidthStatus.hourReserve !== undefined && bandwidthStatus.dayReserve !== undefined" class="text-xs text-base-content/65">{{ t('coco.anReserveWithinTotalHourlyMibHours', { value: amount(bandwidthStatus.hourReserve), value2: amount(bandwidthStatus.dayReserve), value3: bandwidthStatus.urgent ? t('coco.anDegradationConfirmedReserveIsAvailable') : t('coco.anNormalExplorationPreservesTheEmergencyReserve') }) }}</p>
      </div>
      <div v-if="bandwidth?.enabled" class="space-y-2">
        <button type="button" class="btn btn-outline min-h-11" :disabled="!canCheck" @click="check"><span v-if="checking" class="loading loading-spinner loading-xs" /><IconBrandSpeedtest v-else :size="16" /><span>{{ checking ? t('coco.anQueuing') : t('coco.anCheckThisGroupSCandidates') }}</span></button>
        <SettingsNotice>{{ dirty ? t('coco.anSaveAutomaticSelectionSettingsBeforeChecking') : !policyEnabled ? t('coco.anEnableAndSaveAutomaticSelectionBefore') : t('coco.anChecksStillObeyIdleTrafficTraffic') }}</SettingsNotice>
        <p v-if="feedback" role="status" class="text-sm">{{ feedback }}</p>
      </div>
      <div class="flex flex-col gap-2 border-t border-base-content/10 pt-3">
        <BandwidthDecisionProcess :group-name="groupName" :selectable="true" :dirty="dirty" inline />
        <button type="button" class="btn btn-ghost min-h-11 justify-between" @click="detail = 'pool'"><span class="flex items-center gap-2"><IconList :size="16" />{{ t('coco.anCandidateDetails', { value: bandwidthStatus?.pool?.length ?? 0 }) }}</span><IconChevronRight :size="16" /></button>
        <button type="button" class="btn btn-ghost min-h-11 justify-between" @click="detail = 'history'"><span class="flex items-center gap-2"><IconList :size="16" />{{ t('coco.anRecentSwitches', { value: events.length }) }}</span><IconChevronRight :size="16" /></button>
      </div>
    </template>
    <template v-else-if="detail === 'pool'">
      <h3 class="text-sm font-semibold">{{ t('coco.anCandidateDetails2') }}</h3>
      <p v-if="!bandwidthStatus?.pool?.length" class="text-sm text-base-content/60">{{ t('coco.anNoBandwidthCandidateCheckRecordsYet') }}</p>
      <div v-if="bandwidthStatus?.decision" class="space-y-1 text-xs text-base-content/70">
        <p>{{ t('coco.anCurrentLossCandidate', { value: loss(bandwidthStatus.decision.current.low), value2: loss(bandwidthStatus.decision.current.high), value3: loss(bandwidthStatus.decision.candidate.low), value4: loss(bandwidthStatus.decision.candidate.high) }) }}</p>
        <p>{{ t('coco.anConservativeImprovementMustExceedIncludingCost', { value: loss(bandwidthStatus.decision.gain), value2: loss(bandwidthStatus.decision.threshold), value3: loss(bandwidthStatus.decision.cost) }) }}</p>
        <p v-if="bandwidthStatus.decision.uncertainty">{{ t('coco.anUnfamiliarCandidateRiskDeducted', { value: loss(bandwidthStatus.decision.uncertainty) }) }}</p>
        <p v-if="bandwidthStatus.decision.guard === false">{{ t('coco.anTheCandidateFailedTheRelativeShortfall') }}</p>
      </div>
      <p v-if="bandwidthStatus?.searchBytes !== undefined && bandwidthStatus.searchLimit !== undefined" class="text-xs">{{ t('coco.anThisSearchSegmentMib', { value: amount(bandwidthStatus.searchBytes), value2: amount(bandwidthStatus.searchLimit) }) }}</p>
      <p v-if="bandwidthStatus?.nextAt" class="text-xs">{{ t('coco.anNextEvaluation', { value: time(bandwidthStatus.nextAt) }) }}</p>
      <ul class="space-y-4">
        <li v-for="node in bandwidthStatus?.pool" :key="node.name" class="space-y-1 border-b border-base-content/10 pb-3 text-xs">
          <p class="break-all text-sm font-medium">{{ node.name }} · {{ node.preferred ? t('coco.anPreferred') : t('coco.anFallback') }}{{ node.current ? t('coco.anCurrent') : node.active ? t('coco.anThisCandidate') : '' }}</p>
          <p>{{ t('coco.anValidSamples', { value: states[node.state] ?? node.state, value2: node.samples, value3: bandwidth?.confirmRounds }) }}</p>
          <p>{{ reason(node.reason) }}</p>
          <p>{{ t('coco.anLatencyEffectiveThroughput', { value: node.delayMs === null ? t('coco.anUnknown') : node.delayMs + ' ms', value2: node.mbps === null ? t('coco.anUnknown') : node.mbps.toFixed(2) + ' Mbps' }) }}</p>
          <p v-if="node.measuredAt !== null">{{ t('coco.anSampleTime', { value: time(node.measuredAt) }) }}</p>
          <p v-if="node.nextAt > 0">{{ t('coco.anRecheckTime', { value: time(node.nextAt) }) }}</p>
        </li>
      </ul>
    </template>
    <template v-else>
      <h3 class="text-sm font-semibold">{{ t('coco.anRecentSwitches2') }}</h3>
      <p v-if="!events.length" class="text-sm text-base-content/60">{{ t('coco.anNoSwitchRecordsForThisGroup') }}</p>
      <ol class="space-y-4"><li v-for="(event, index) in events" :key="event.id ?? index" class="space-y-1 border-b border-base-content/10 pb-3 text-xs"><p>{{ time(event.at) }}</p><p class="break-all">{{ event.from ?? t('coco.anNotSelected') }} → {{ event.to ?? t('coco.anNotSelected') }}</p><p>{{ reason(event.reason) }}</p></li></ol>
    </template>
  </section>
</template>

<style scoped>
.status-facts { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 12px 16px; }
.status-facts dt { opacity: .6; }
</style>
