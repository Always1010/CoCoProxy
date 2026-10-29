<script setup lang="ts">
import { IconArrowLeft, IconBrandSpeedtest, IconChevronRight, IconRefresh, IconRoute } from '@tabler/icons-vue'
import { CoCoProxyError, cocoproxyErrorMessage } from '~/composables/useCoCoProxy'
import { processReason, processSampleLoss } from '~/utils/bandwidth-process'
import type { ProcessComparison, ProcessResponse } from '~/utils/bandwidth-process'

const props = withDefaults(defineProps<{ groupName: string; selectable: boolean; inline?: boolean; dirty?: boolean }>(), { inline: false, dirty: false })
const { t, locale } = useI18n()
const { api, view, overrides } = useWorkspace()
const dialog = ref<{ open: () => void; close: () => void }>()
const scroller = ref<HTMLElement>()
const visible = ref(false)
const data = ref<ProcessResponse>()
const selectedId = ref<string | null>(null)
const loading = ref(false)
const checking = ref(false)
const updatedAt = ref<number | null>(null)
const error = useLocalizedMessage()
const delayed = ref(false)
const feedback = useLocalizedMessage()
let timer: ReturnType<typeof setTimeout> | undefined
let session = 0, requestId = 0, disposed = false
let reading = false
let controller: AbortController | undefined
let lockedSince: number | null = null
const scope = computed(() => {
  const workspace = view.value?.workspace
  return workspace ? JSON.stringify([workspace.mode, workspace.mode === 'subscription' ? workspace.subscriptionId : workspace.sourceIds]) : ''
})
const policy = computed(() => overrides.value.automatic?.[props.groupName])
const enabled = computed(() => !!policy.value && policy.value.enabled !== false && !!policy.value.bandwidth?.enabled)
const status = computed(() => data.value?.status)
const group = computed(() => status.value?.groups.find(g => g.name === props.groupName))
const bandwidth = computed(() => group.value?.bandwidth)
const observation = computed(() => bandwidth.value?.observation)
const detail = computed(() => data.value?.detail?.id === selectedId.value ? data.value.detail : null)
const comparisons = computed(() => detail.value?.events.flatMap(e => e.comparison ? [{ at: e.at, value: e.comparison }] : []) ?? [])
const canCheck = computed(() => enabled.value && !props.dirty && !checking.value && !loading.value && !error.value && !!group.value
  && !!view.value?.active && !view.value.pending && !status.value?.paused && !status.value?.suspended && !status.value?.error && !bandwidth.value?.testingNode)
const stalled = computed(() => enabled.value && !!status.value?.engine?.lastCompletedAt && !!updatedAt.value && updatedAt.value - status.value.engine.lastCompletedAt > 60000)
const headline = computed(() => !enabled.value ? t('coco.process.disabled') : status.value?.paused || status.value?.suspended ? t('coco.process.suspended')
  : status.value?.engine?.state === 'error' ? t('coco.process.engineError') : stalled.value ? t('coco.process.stalled')
    : status.value?.engine?.state === 'suspended' ? t('coco.autoEngineReason.' + (status.value.engine.reason ?? 'inactive'))
    : bandwidth.value ? reason(bandwidth.value.reason) : t('coco.process.awaitingStatus'))
const time = (at: number | null | undefined) => at === null || at === undefined ? t('coco.process.unknown') : new Date(at).toLocaleString(locale.value)
const number = (n: number | null | undefined, digits = 2) => n === null || n === undefined ? '—' : n.toFixed(digits)
const amount = (bytes: number) => number(bytes / 1048576, 1)
const points = (n: number) => t('coco.process.points', { value: number(n, 3) })
const reason = (value: string) => processReason(value, t)
const setting = (key: string) => Number(detail.value?.settings[key] ?? 0)
const gainGap = (d: ProcessComparison) => Math.max(0, d.threshold - d.gain)
const costParts = (d: ProcessComparison) => [setting('switchCostSeconds') / setting('horizonSeconds'),
  setting('recentCostSeconds') * d.recentSwitches / setting('horizonSeconds'),
  d.reverse ? setting('reverseCostSeconds') / setting('horizonSeconds') : 0,
  d.currentPreferred && !d.candidatePreferred ? setting('fallbackPenaltyMs') / 1000 : 0]

async function refresh(background = true) {
  if (!visible.value || disposed || document.hidden || !view.value || (background && (reading || checking.value))) return
  const id = ++requestId, expectedScope = scope.value, revision = view.value.workspace.revision
  controller?.abort(); controller = new AbortController()
  const query = new URLSearchParams({ group: props.groupName, scope: expectedScope, revision: String(revision) })
  if (selectedId.value) query.set('round', selectedId.value)
  reading = true
  loading.value = !background || !data.value
  if (!background) { lockedSince = null; delayed.value = false }
  try {
    const result = await api.request<ProcessResponse>('/api/cocoproxy/automatic/bandwidth/history?' + query, { signal: controller.signal })
    if (!visible.value || id !== requestId || expectedScope !== scope.value) return
    if (result.status.scope !== expectedScope || result.status.workspaceRevision !== view.value?.workspace.revision) {
      error.value = () => t('coco.anThePlanOrSettingsChangedClose'); return
    }
    if (JSON.stringify(result) !== JSON.stringify(data.value)) data.value = result
    updatedAt.value = Date.now(); error.value = ''; delayed.value = false; lockedSince = null
  } catch (cause) {
    if (visible.value && id === requestId) {
      if (background && data.value && cause instanceof CoCoProxyError && cause.code === 'STORE_LOCKED') {
        lockedSince ??= Date.now(); delayed.value = true
        if (Date.now() - lockedSince >= 15000) error.value = () => cocoproxyErrorMessage(cause, t)
      } else { delayed.value = false; lockedSince = null; error.value = () => cocoproxyErrorMessage(cause, t) }
    }
  } finally { if (id === requestId) { reading = false; loading.value = false } }
}
async function poll(currentSession: number) {
  await refresh()
  if (visible.value && !disposed && currentSession === session) timer = setTimeout(() => { void poll(currentSession) }, 5000)
}
function open() {
  close(); data.value = undefined; selectedId.value = null; updatedAt.value = null; error.value = ''; feedback.value = ''; delayed.value = false; lockedSince = null
  visible.value = true; dialog.value?.open(); void poll(session)
}
function close() {
  session++; requestId++; visible.value = false; reading = false; loading.value = false; controller?.abort()
  if (timer) clearTimeout(timer)
}
function choose(id: string | null) { selectedId.value = id; scroller.value?.scrollTo({ top: 0 }); void refresh(false) }
async function check() {
  if (!canCheck.value || !view.value) return
  const expectedScope = scope.value, currentSession = session
  // A read started before this action must not restore its older status.
  requestId++; controller?.abort(); reading = false; loading.value = false
  checking.value = true; feedback.value = ''
  try {
    await api.request('/api/cocoproxy/automatic/bandwidth/check', { method: 'POST', body: {
      expectedRevision: view.value.workspace.revision, expectedActive: view.value.active, scope: expectedScope, group: props.groupName,
    } })
    if (visible.value && currentSession === session && scope.value === expectedScope) {
      feedback.value = () => t('coco.anThisGroupSCandidateCheckIs'); await refresh(false)
    }
  } catch (cause) { if (visible.value && currentSession === session) feedback.value = () => cocoproxyErrorMessage(cause, t) }
  finally { checking.value = false }
}
function visibilityChanged() { if (!document.hidden && visible.value) void refresh() }
watch(() => [props.groupName, scope.value, view.value?.workspace.revision], () => { dialog.value?.close(); close() })
onMounted(() => document.addEventListener('visibilitychange', visibilityChanged))
onUnmounted(() => { disposed = true; close(); document.removeEventListener('visibilitychange', visibilityChanged) })
defineExpose({ open })
</script>

<template>
  <span v-if="selectable" :class="inline ? 'block' : 'shrink-0'">
    <button type="button" class="btn btn-ghost min-h-11" :class="inline ? 'w-full justify-between' : 'btn-sm'" @click="open"><span class="flex items-center gap-2"><IconRoute :size="18" aria-hidden="true" /><span>{{ t('coco.process.entry') }}</span></span><IconChevronRight v-if="inline" :size="16" aria-hidden="true" /></button>
  </span>
  <Modal ref="dialog" size="xl" :title="t('coco.process.title', { group: groupName })" @close="close">
    <template #content>
      <div class="mb-3 flex shrink-0 flex-wrap items-center justify-between gap-2">
        <button v-if="selectedId" type="button" class="btn btn-ghost min-h-11" @click="choose(null)"><IconArrowLeft :size="16" aria-hidden="true" /><span>{{ t('coco.process.back') }}</span></button>
        <span class="text-xs tabular-nums text-base-content/60">{{ t('coco.process.updated', { time: time(updatedAt) }) }}</span>
        <span v-if="delayed" role="status" class="text-xs text-base-content/60">{{ t('coco.process.readDelayed') }}</span>
        <button type="button" class="btn btn-ghost min-h-11 min-w-28 shrink-0" :disabled="loading || checking" @click="refresh(false)"><IconRefresh :size="16" :class="{ 'animate-spin': loading }" aria-hidden="true" /><span>{{ loading ? t('coco.anRefreshing') : t('coco.anRefresh') }}</span></button>
      </div>
      <p v-if="error" role="alert" class="mb-3 shrink-0 text-sm text-warning">{{ t('coco.anUpdateFailedPreviouslyDisplayedRecordsAre', { value: error }) }}</p>
      <div ref="scroller" class="min-h-0 flex-1 space-y-4 overflow-y-auto [scrollbar-gutter:stable]">
        <template v-if="!selectedId">
          <section class="space-y-3 rounded-xl border border-primary/25 bg-primary/5 p-4" aria-live="polite">
            <div class="flex flex-wrap items-center justify-between gap-2"><h3 class="text-base font-semibold">{{ headline }}</h3><span class="badge badge-outline">{{ policy?.bandwidth?.observeOnly ? t('coco.process.observeOnly') : t('coco.process.automatic') }}</span></div>
            <p class="break-all text-sm">{{ t('coco.process.current', { node: group?.current ?? view?.groups.find(g => g.name === groupName)?.activeSelected ?? '—' }) }}</p>
            <p v-if="bandwidth?.testingNode" class="flex items-center gap-2 text-sm"><span class="loading loading-spinner loading-sm" /><span class="break-all">{{ t('coco.process.testing', { node: bandwidth.testingNode }) }}</span></p>
            <div v-if="bandwidth?.testingNode" class="space-y-1"><p class="text-xs">{{ t('coco.process.progress', { count: bandwidth.pool?.find(n => n.name === bandwidth?.testingNode)?.samples ?? 0, total: policy?.bandwidth?.confirmRounds ?? 0 }) }}</p><progress class="progress progress-primary w-full" :value="bandwidth.pool?.find(n => n.name === bandwidth?.testingNode)?.samples ?? 0" :max="Number(policy?.bandwidth?.confirmRounds ?? 1)" /></div>
            <div class="grid gap-2 text-xs text-base-content/65 sm:grid-cols-2">
              <p>{{ t('coco.process.lastTick', { time: time(status?.engine?.lastCompletedAt) }) }}</p><p>{{ t('coco.process.lastObservation', { time: time(observation?.observedAt) }) }}</p>
              <p v-if="status?.engine?.reason">{{ t('coco.process.scheduler', { reason: t('coco.autoEngineReason.' + status.engine.reason) }) }}</p>
              <p v-if="status?.engine?.error">{{ status.engine.error.code }}</p>
            </div>
          </section>
          <p v-if="data?.error" role="alert" class="rounded-lg bg-warning/10 p-3 text-sm text-warning">{{ t('coco.process.archiveError') }}</p>
          <details class="rounded-xl border border-base-content/10 p-3" :open="!observation?.trigger">
            <summary class="flex min-h-11 cursor-pointer items-center text-sm font-semibold">{{ t('coco.process.triggerConditions') }}</summary>
            <p class="mb-3 text-xs text-base-content/60">{{ t('coco.process.conditionsHelp') }}</p>
            <p v-if="!observation || !observation.fresh" class="text-sm text-warning">{{ t('coco.process.noObservation') }}</p>
            <dl v-else class="process-facts text-sm">
              <dt>{{ t('coco.process.activeTime') }}</dt><dd>{{ number(observation.activeSeconds, 0) }} / {{ observation.requiredActiveSeconds }} s <span>{{ observation.activeSeconds >= observation.requiredActiveSeconds ? '✓' : '…' }}</span></dd>
              <dt>{{ t('coco.process.traffic') }}</dt><dd>{{ number(observation.trafficMiB) }} / {{ observation.requiredTrafficMiB }} MiB <span>{{ observation.trafficMiB >= observation.requiredTrafficMiB ? '✓' : '…' }}</span></dd>
              <dt>{{ t('coco.process.passiveRate') }}</dt><dd>{{ number(observation.mbps) }} Mbps {{ t('coco.process.below', { value: number(observation.suspectMbps) }) }}</dd>
              <dt>{{ t('coco.process.positive') }}</dt><dd>{{ observation.positiveUntil > (updatedAt ?? 0) ? time(observation.positiveUntil) : t('coco.process.noSuppression') }}</dd>
              <dt>{{ t('coco.process.quiet') }}</dt><dd>{{ observation.quiet ? t('coco.process.met') : t('coco.process.waiting') }}</dd>
            </dl>
          </details>
          <section v-if="bandwidth" class="space-y-2 rounded-xl bg-base-200 p-3 text-sm">
            <h3 class="font-semibold">{{ t('coco.process.budget') }}</h3>
            <div class="grid gap-2 sm:grid-cols-2"><p>{{ t('coco.process.hour', { used: amount(bandwidth.hourBytes), total: amount(bandwidth.hourLimit) }) }}</p><p>{{ t('coco.process.day', { used: amount(bandwidth.dayBytes), total: amount(bandwidth.dayLimit) }) }}</p></div>
            <p class="text-xs text-base-content/60">{{ t('coco.process.sharedBudget') }}</p>
            <p class="text-xs">{{ t('coco.process.reserves', { hour: amount(bandwidth.hourReserve ?? 0), day: amount(bandwidth.dayReserve ?? 0), allowed: bandwidth.urgent ? t('coco.process.reserveAllowed') : t('coco.process.reserveProtected') }) }}</p>
            <p v-if="bandwidth.nextAt" class="text-xs">{{ t('coco.process.retry', { time: time(bandwidth.nextAt) }) }}</p>
          </section>
          <div class="space-y-2">
            <button type="button" class="btn btn-outline min-h-11" :disabled="!canCheck" @click="check"><span v-if="checking" class="loading loading-spinner loading-xs" /><IconBrandSpeedtest v-else :size="16" aria-hidden="true" /><span>{{ checking ? t('coco.anQueuing') : t('coco.anCheckThisGroupSCandidates') }}</span></button>
            <p class="text-xs text-base-content/60">{{ dirty ? t('coco.anSaveAutomaticSelectionSettingsBeforeChecking') : t('coco.anChecksStillObeyIdleTrafficTraffic') }}</p><p v-if="feedback" role="status" class="text-sm">{{ feedback }}</p>
          </div>
          <div class="flex items-center justify-between border-t border-base-content/10 pt-4"><h3 class="font-semibold">{{ t('coco.process.rounds') }}</h3><span class="text-xs text-base-content/60">{{ data?.rounds.length ?? 0 }}</span></div>
          <p class="text-xs text-base-content/60">{{ t('coco.process.retention', { time: time(data?.since) }) }}</p>
          <p v-if="data?.evicted" class="text-xs text-warning">{{ t('coco.process.evicted') }}</p>
          <p v-if="data && !data.rounds.length" class="py-6 text-center text-sm text-base-content/60">{{ t('coco.process.empty') }}</p>
          <ol class="space-y-3">
            <li v-for="round in data?.rounds" :key="round.id" class="rounded-xl border border-base-content/10 p-3">
              <div class="flex flex-wrap items-center justify-between gap-2 text-xs"><time>{{ time(round.startedAt) }}</time><span class="badge badge-sm" :class="round.endedAt === null ? 'badge-outline' : 'badge-ghost'">{{ t('coco.process.trigger.' + round.trigger) }}</span></div>
              <p class="mt-2 text-sm font-medium">{{ round.endedAt === null ? t('coco.process.ongoing') + ' · ' : '' }}{{ reason(round.reason) }}</p>
              <p class="mt-1 break-all text-xs text-base-content/65">{{ t('coco.process.current', { node: round.current }) }}</p>
              <div class="mt-2 flex flex-wrap items-center justify-between gap-2"><span class="text-xs text-base-content/60">{{ t('coco.process.roundStats', { count: round.nodes.length, bytes: amount(round.bytes) }) }}</span><button type="button" class="btn btn-ghost min-h-11" @click="choose(round.id)"><span>{{ t('coco.process.details') }}</span><IconChevronRight :size="16" aria-hidden="true" /></button></div>
            </li>
          </ol>
        </template>
        <template v-else-if="detail">
          <section class="space-y-2 rounded-xl bg-base-200 p-4">
            <h3 class="font-semibold">{{ detail.endedAt === null ? t('coco.process.ongoing') + ' · ' : '' }}{{ reason(detail.reason) }}</h3>
            <p class="text-xs">{{ time(detail.startedAt) }} → {{ detail.endedAt === null ? t('coco.process.ongoing') : time(detail.endedAt) }} · {{ t('coco.process.trigger.' + detail.trigger) }}</p>
            <p class="break-all text-sm">{{ t('coco.process.current', { node: detail.current }) }}</p>
            <p class="text-xs text-base-content/60">{{ t('coco.process.snapshotHelp', { target: setting('targetMbps'), rounds: setting('confirmRounds') }) }}</p>
            <p class="text-xs">{{ detail.settings.observeOnly ? t('coco.process.observeOnly') : t('coco.process.automatic') }}</p>
            <p v-if="detail.truncated" class="text-xs text-warning">{{ t('coco.process.truncated') }}</p>
          </section>
          <details class="rounded-xl border border-base-content/10 p-3 text-sm">
            <summary class="flex min-h-11 cursor-pointer items-center font-semibold">{{ t('coco.process.coverage') }}</summary>
            <p class="mb-3 text-xs text-base-content/60">{{ t('coco.process.coverageHelp') }}</p>
            <ul class="grid gap-2 sm:grid-cols-2"><li v-for="node in detail.nodes" :key="node.name" class="space-y-1 rounded-lg bg-base-200 p-2"><p class="break-all">{{ node.name }} · {{ node.preferred ? t('coco.anPreferred') : t('coco.anFallback') }}</p><p class="text-xs">{{ t('coco.process.coverageCounts', { probes: detail.events.filter(e => e.node === node.name && e.kind === 'probe').length, samples: detail.events.filter(e => e.node === node.name && e.sample?.valid).length, comparisons: comparisons.filter(c => c.value.candidateNode === node.name || c.value.currentNode === node.name).length }) }}</p></li></ul>
          </details>
          <section class="space-y-3">
            <h3 class="font-semibold">{{ t('coco.process.comparisons') }}</h3>
            <p v-if="!comparisons.length" class="text-sm text-base-content/60">{{ t('coco.process.noComparison') }}</p>
            <article v-for="(item, index) in comparisons" :key="index" class="space-y-3 rounded-xl border border-base-content/10 p-4 text-sm">
              <div class="flex flex-wrap items-center justify-between gap-2"><strong>{{ item.value.worthwhile ? t('coco.process.gainPassed') : item.value.guard ? t('coco.process.gainFailed') : t('coco.process.guardFailed') }}</strong><time class="text-xs text-base-content/60">{{ time(item.at) }}</time></div>
              <div class="grid gap-3 sm:grid-cols-2">
                <div v-for="side in (['current', 'candidate'] as const)" :key="side" class="space-y-1 rounded-lg bg-base-200 p-3">
                  <p class="break-all font-medium">{{ t('coco.process.side.' + side) }} · {{ side === 'current' ? item.value.currentNode : item.value.candidateNode }}</p>
                  <p>{{ number(item.value[side].delay, 0) }} ms · {{ number(item.value[side].mbps) }} Mbps</p>
                  <p>{{ t('coco.process.lossInterval', { low: number(item.value[side].low, 3), high: number(item.value[side].high, 3) }) }}</p>
                  <p class="text-xs">{{ t('coco.process.progress', { count: (side === 'current' ? item.value.effectiveCurrent : item.value.effectiveCandidate).length, total: setting('confirmRounds') }) }}</p>
                </div>
              </div>
              <p class="font-medium">{{ t('coco.process.gain', { gain: points(item.value.gain), threshold: points(item.value.threshold) }) }}</p>
              <p v-if="!item.value.worthwhile && item.value.guard">{{ t('coco.process.gap', { value: points(gainGap(item.value)) }) }}</p>
              <p>{{ t('coco.process.guard', { value: item.value.guard ? t('coco.process.passed') : t('coco.process.failed') }) }}</p>
              <p class="text-xs text-base-content/60">{{ t('coco.process.executionHelp') }}</p>
              <details class="border-t border-base-content/10 pt-1">
                <summary class="flex min-h-11 cursor-pointer items-center font-medium">{{ t('coco.process.calculation') }}</summary>
                <div class="space-y-2 text-xs">
                  <p>{{ t('coco.process.gainFormula', { current: points(item.value.current.low), candidate: points(item.value.candidate.high), risk: points(item.value.uncertainty), gain: points(item.value.gain) }) }}</p>
                  <p>{{ t('coco.process.thresholdFormula', { absolute: points(setting('minGainMs') / 1000), relative: points(item.value.current.low * setting('minGainRatio')), cost: points(item.value.cost), threshold: points(item.value.threshold) }) }}</p>
                  <p>{{ t('coco.process.costParts', { base: points(costParts(item.value)[0]!), recent: points(costParts(item.value)[1]!), reverse: points(costParts(item.value)[2]!), preference: points(costParts(item.value)[3]!) }) }}</p>
                  <p>{{ t('coco.process.guardValues', { delay: number(Math.max(setting('delayReferenceMs'), item.value.current.delay * (1 + setting('tradeoffRatio'))), 0), rate: number(Math.min(setting('throughputReferenceMbps'), item.value.current.mbps * (1 - setting('tradeoffRatio')))) }) }}</p>
                  <p>{{ t('coco.process.rank', { value: points(item.value.rank) }) }}</p>
                  <p>{{ t('coco.process.scoreHelp') }}</p>
                  <div v-for="side in (['current', 'candidate'] as const)" :key="side" class="space-y-2 border-t border-base-content/10 pt-2">
                    <p class="font-semibold">{{ t('coco.process.side.' + side) }} · {{ t('coco.process.samples') }}</p>
                    <div v-for="(sample, sampleIndex) in (side === 'current' ? item.value.effectiveCurrent : item.value.effectiveCandidate)" :key="sampleIndex" class="space-y-1 rounded-lg bg-base-200 p-2">
                      <p>{{ time(sample.at) }} · {{ number(sample.mbps) }} Mbps</p>
                      <p>{{ t('coco.process.delayCorrection', { raw: (side === 'current' ? item.value.currentSamples : item.value.candidateSamples)[sampleIndex]?.delayMs, effective: sample.delayMs }) }}</p>
                      <p>{{ t('coco.process.sampleLoss', { delay: points(processSampleLoss(sample, detail.settings).delay), shortfall: points(processSampleLoss(sample, detail.settings).shortfall), total: points(processSampleLoss(sample, detail.settings).total) }) }}</p>
                      <p>{{ t('coco.process.margin', { value: points((setting('marginMs') + setting('agingMs') * (item.at - sample.at) / 60000) / 1000) }) }}</p>
                    </div>
                  </div>
                </div>
              </details>
            </article>
          </section>
          <section class="space-y-3">
            <h3 class="font-semibold">{{ t('coco.process.timeline') }}</h3>
            <ol class="ml-2 space-y-3 border-l-2 border-base-content/15 pl-4">
              <li v-for="(event, index) in detail.events" :key="index" class="relative space-y-1 rounded-lg bg-base-200/60 p-3 text-sm">
                <span class="absolute -left-[23px] top-5 h-3 w-3 rounded-full bg-primary" aria-hidden="true" />
                <p class="text-xs text-base-content/60">{{ time(event.at) }}<span v-if="event.until > event.at"> · {{ t('coco.process.duration', { value: number((event.until - event.at) / 1000, 0) }) }}</span></p>
                <p class="break-all"><span v-if="event.node" class="font-semibold">{{ event.node }} · </span>{{ event.kind === 'trigger' ? t('coco.process.trigger.' + event.reason) : reason(event.reason) }}</p>
                <p v-if="event.observation" class="text-xs">{{ event.observation.fresh ? t('coco.process.triggerSnapshot', { active: number(event.observation.activeSeconds, 0), activeLimit: event.observation.requiredActiveSeconds, traffic: number(event.observation.trafficMiB), trafficLimit: event.observation.requiredTrafficMiB, rate: number(event.observation.mbps), rateLimit: number(event.observation.suspectMbps) }) : t('coco.process.noObservation') }}</p>
                <p v-if="event.nextAt" class="text-xs">{{ t('coco.process.retry', { time: time(event.nextAt) }) }}</p>
                <p v-if="event.probe" class="text-xs">{{ t('coco.process.probe', { delay: number(event.probe.delayMs, 0), result: event.probe.ok ? t('coco.process.passed') : t('coco.process.failed') }) }}</p>
                <p v-if="event.screening" class="text-xs">{{ t('coco.process.screening', { gain: points(event.screening.currentLow - event.screening.bestCandidateLoss - event.screening.uncertainty), threshold: points(event.screening.threshold), delay: event.screening.delayMs, limit: number(event.screening.delayLimit, 0) }) }}</p>
                <details v-if="event.sample" class="text-xs"><summary class="flex min-h-11 cursor-pointer items-center">{{ t('coco.process.sampleResult', { result: event.sample.valid ? t('coco.process.valid') : t('coco.process.invalid'), rate: number(event.sample.mbps), bytes: amount(event.sample.bytes) }) }}</summary><div class="space-y-1"><p>{{ t('coco.process.sampleTiming', { start: time(event.sample.startedAt), elapsed: number(event.sample.elapsedMs / 1000), warmup: setting('warmupSeconds'), minimum: setting('minSampleSeconds') }) }}</p><p>{{ t('coco.process.actualTiming', { warmup: event.sample.warmupMs === undefined ? '—' : number(event.sample.warmupMs / 1000), sample: event.sample.sampleMs === undefined ? '—' : number(event.sample.sampleMs / 1000) }) }}</p><p>{{ t('coco.process.probeSource', { delay: number(event.sample.delayMs, 0) }) }}</p><p>{{ t('coco.process.verificationHelp') }}</p></div></details>
                <p v-if="event.comparison" class="text-xs">{{ t('coco.process.gain', { gain: points(event.comparison.gain), threshold: points(event.comparison.threshold) }) }}</p>
                <p v-if="event.budget && event.reason === 'budget-exhausted'" class="text-xs">{{ t('coco.process.hour', { used: amount(event.budget.hourBytes), total: amount(event.budget.hourLimit) }) }} · {{ t('coco.process.day', { used: amount(event.budget.dayBytes), total: amount(event.budget.dayLimit) }) }}</p>
                <p v-if="event.protection" class="text-xs">{{ t('coco.process.protection', { count: event.protection.recentSwitches, limit: event.protection.maxSwitches, hold: time(event.protection.holdUntil), until: event.protection.limitUntil ? time(event.protection.limitUntil) : '—' }) }}</p>
              </li>
            </ol>
          </section>
          <details class="rounded-xl border border-base-content/10 p-3 text-xs"><summary class="flex min-h-11 cursor-pointer items-center font-medium">{{ t('coco.process.parameters') }}</summary><dl class="process-facts"><template v-for="(value, key) in detail.settings" :key="key"><dt class="break-words">{{ key === 'enabled' ? t('coco.process.enabledLabel') : key === 'observeOnly' ? t('coco.process.observeLabel') : t('coco.bandwidthField.' + key) }}</dt><dd>{{ typeof value === 'boolean' ? value ? t('coco.process.met') : t('coco.process.disabledValue') : value }}</dd></template></dl></details>
        </template>
        <p v-else class="py-8 text-center text-sm text-base-content/60">{{ loading ? t('coco.process.loading') : t('coco.process.missing') }}</p>
      </div>
    </template>
  </Modal>
</template>

<style scoped>
.process-facts { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.3fr); gap: 10px 16px; }
.process-facts dt { opacity: .65; }
.process-facts dd { overflow-wrap: anywhere; }
</style>
