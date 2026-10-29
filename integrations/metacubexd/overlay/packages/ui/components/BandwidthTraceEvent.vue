<script setup lang="ts">
import { IconChevronDown } from '@tabler/icons-vue'
import { processAction, processReason, processRelativeTime, processSampleLoss } from '~/utils/bandwidth-process'
import type { ProcessTraceRow } from '~/utils/bandwidth-process'
import type { BandwidthSettings } from '~/composables/useWorkspace'

const props = defineProps<{ row: ProcessTraceRow; start: number; current: string; settings: BandwidthSettings }>()
const { t, te, locale } = useI18n()
const expanded = ref(false)
const event = computed(() => props.row.event)
const action = computed(() => processAction(event.value))
const comparison = computed(() => event.value.comparison)
const budget = computed(() => event.value.budget ?? props.row.context?.budget)
const protection = computed(() => event.value.protection ?? props.row.context?.protection)
const shortReason = computed(() => {
  const key = 'coco.process.trace.reason.' + event.value.reason
  return te(key) ? t(key) : processReason(event.value.reason, t)
})
const number = (value: number | null | undefined, digits = 2) => value === null || value === undefined ? '—' : value.toFixed(digits)
const setting = (key: string) => Number(props.settings[key] ?? 0)
const relative = (at: number) => processRelativeTime(at, props.start)
const time = (at: number) => new Date(at).toLocaleString(locale.value)
const flag = (passed: boolean) => passed ? '✓' : '×'
const gainPass = computed(() => !!comparison.value && comparison.value.gain > comparison.value.threshold)
const samples = computed(() => comparison.value ? (['current', 'candidate'] as const).flatMap(side =>
  (side === 'current' ? comparison.value!.effectiveCurrent : comparison.value!.effectiveCandidate).map(sample => ({
    ...sample, node: side === 'current' ? comparison.value!.currentNode : comparison.value!.candidateNode,
    ...processSampleLoss(sample, props.settings),
  }))) : [])
</script>

<template>
  <li class="trace-row">
    <time class="trace-time tabular-nums" :title="time(row.startedAt)">{{ relative(row.startedAt) }}<span v-if="relative(row.endedAt) !== relative(row.startedAt)">–{{ relative(row.endedAt) }}</span></time>
    <span class="trace-rail" aria-hidden="true"><span class="trace-mark" :class="{ decision: ['trigger', 'comparison', 'excluded', 'verify', 'observe'].includes(action), end: action === 'end', waiting: action === 'wait' }" /></span>
    <details :open="expanded" class="trace-body" @toggle="expanded = ($event.target as HTMLDetailsElement).open">
      <summary class="trace-summary">
        <span class="trace-action">{{ t('coco.process.trace.action.' + action) }}<span v-if="event.node && !comparison && action !== 'switch'" class="font-normal"> · {{ event.node }}</span></span>
        <span class="trace-data tabular-nums">
          <template v-if="event.observation && action === 'trigger'">
            <template v-if="event.reason === 'traffic' && event.observation.fresh">
              <span>{{ t('coco.process.trace.active') }} {{ number(event.observation.activeSeconds, 0) }} {{ event.observation.activeSeconds >= event.observation.requiredActiveSeconds ? '≥' : '&lt;' }} {{ event.observation.requiredActiveSeconds }} s</span>
              <span>{{ number(event.observation.trafficMiB) }} {{ event.observation.trafficMiB >= event.observation.requiredTrafficMiB ? '≥' : '&lt;' }} {{ event.observation.requiredTrafficMiB }} MiB</span>
              <span v-if="event.observation.mbps !== null">{{ number(event.observation.mbps) }} {{ event.observation.mbps < event.observation.suspectMbps ? '&lt;' : '≥' }} {{ number(event.observation.suspectMbps) }} Mbps</span><span v-else>— Mbps</span>
            </template>
            <span v-else>{{ t('coco.process.trigger.' + event.reason) }}</span>
          </template>
          <template v-else-if="event.probe"><span>{{ number(event.probe.delayMs, 0) }} ms</span><span :class="event.probe.ok && event.probe.delayMs !== null ? 'text-success' : 'text-warning'">{{ event.probe.retryAfterMs ? t('coco.process.trace.retry') : event.probe.ok && event.probe.delayMs !== null ? '✓' : '×' }}</span></template>
          <template v-else-if="event.sample"><span>{{ number(event.sample.mbps) }} Mbps</span><span>{{ number(event.sample.bytes / 1048576) }} MiB</span><span :class="event.sample.valid ? 'text-success' : 'text-warning'">{{ event.sample.valid ? '✓' : '×' }} {{ t(event.sample.valid ? 'coco.process.valid' : 'coco.process.invalid') }}</span></template>
          <template v-else-if="comparison">
            <span class="break-all">{{ comparison.currentNode }} → {{ comparison.candidateNode }}</span>
            <span :class="gainPass ? 'text-success' : 'text-base-content/70'">{{ t('coco.process.trace.gain') }} {{ number(comparison.gain, 3) }} {{ gainPass ? '&gt;' : '≤' }} {{ number(comparison.threshold, 3) }} {{ t('coco.process.trace.scoreUnit') }} {{ flag(gainPass) }}</span>
            <span :class="comparison.guard ? 'text-success' : 'text-warning'">{{ t('coco.process.trace.guard') }} {{ flag(comparison.guard) }}</span>
          </template>
          <template v-else-if="event.screening">
            <span>{{ event.screening.delayMs }} {{ event.screening.delayMs <= event.screening.delayLimit ? '≤' : '&gt;' }} {{ number(event.screening.delayLimit, 0) }} ms</span>
            <span>{{ t('coco.process.trace.gain') }} {{ number(event.screening.currentLow - event.screening.bestCandidateLoss - event.screening.uncertainty, 3) }} {{ event.screening.currentLow - event.screening.bestCandidateLoss - event.screening.uncertainty > event.screening.threshold ? '&gt;' : '≤' }} {{ number(event.screening.threshold, 3) }} {{ t('coco.process.trace.scoreUnit') }}</span>
            <span class="text-base-content/60">{{ t('coco.process.trace.skipDownload') }}</span>
          </template>
          <span v-else-if="action === 'switch'" class="break-all">{{ current }} → {{ event.node ?? '—' }}</span>
          <span v-else-if="action === 'trigger'">{{ t('coco.process.trigger.' + event.reason) }}</span>
          <template v-else><span>{{ shortReason }}</span><template v-if="event.reason === 'budget-exhausted' && budget"><span>{{ t('coco.process.trace.hour') }} {{ number(budget.hourBytes / 1048576) }} / {{ number(budget.hourLimit / 1048576) }} MiB</span><span>{{ t('coco.process.trace.day') }} {{ number(budget.dayBytes / 1048576) }} / {{ number(budget.dayLimit / 1048576) }} MiB</span></template></template>
          <span v-if="event.nextAt !== null && event.nextAt !== undefined" class="text-base-content/60">{{ t('coco.process.trace.next') }} ≥ {{ relative(event.nextAt) }}</span>
        </span>
        <IconChevronDown :size="14" class="shrink-0 text-base-content/50" aria-hidden="true" />
      </summary>
      <div class="trace-detail space-y-3 text-xs">
        <dl class="trace-facts"><dt>{{ t('coco.process.trace.timestamp') }}</dt><dd>{{ time(event.at) }}</dd><dt>{{ t('coco.process.trace.reasonCode') }}</dt><dd>{{ processReason(event.reason, t) }} <code>{{ event.reason }}</code></dd></dl>
        <template v-if="event.observation">
          <dl class="trace-facts">
            <dt>{{ t('coco.process.trace.window') }}</dt><dd>90 s</dd>
            <dt>{{ t('coco.process.trace.active') }}</dt><dd>{{ number(event.observation.activeSeconds, 0) }} s · {{ t('coco.process.trace.minimum') }} {{ event.observation.requiredActiveSeconds }} s</dd>
            <dt>{{ t('coco.process.traffic') }}</dt><dd>{{ number(event.observation.trafficMiB) }} MiB · {{ t('coco.process.trace.minimum') }} {{ event.observation.requiredTrafficMiB }} MiB</dd>
            <dt>{{ t('coco.process.passiveRate') }}</dt><dd>{{ number(event.observation.mbps) }} Mbps · {{ t('coco.process.trace.below') }} {{ number(event.observation.suspectMbps) }} Mbps</dd>
            <dt>{{ t('coco.process.trace.observation') }}</dt><dd>{{ t(event.observation.fresh ? 'coco.process.trace.fresh' : 'coco.process.trace.stale') }}</dd>
            <dt>{{ t('coco.process.positive') }}</dt><dd>{{ event.observation.positiveUntil > event.at ? time(event.observation.positiveUntil) : t('coco.process.noSuppression') }}</dd>
          </dl>
        </template>
        <dl v-if="event.probe" class="trace-facts"><dt>{{ t('coco.process.trace.delay') }}</dt><dd>{{ number(event.probe.delayMs, 0) }} ms</dd><template v-if="event.probe.retryAfterMs"><dt>{{ t('coco.process.trace.retry') }}</dt><dd>{{ number(event.probe.retryAfterMs / 1000) }} s</dd></template></dl>
        <dl v-if="event.sample" class="trace-facts">
          <dt>{{ t('coco.process.trace.start') }}</dt><dd>{{ time(event.sample.startedAt) }}</dd>
          <dt>{{ t('coco.process.trace.elapsed') }}</dt><dd>{{ number(event.sample.elapsedMs / 1000) }} s</dd>
          <dt>{{ t('coco.process.trace.warmup') }}</dt><dd>{{ number(event.sample.warmupMs === undefined ? undefined : event.sample.warmupMs / 1000) }} s</dd>
          <dt>{{ t('coco.process.trace.sampleTime') }}</dt><dd>{{ number(event.sample.sampleMs === undefined ? undefined : event.sample.sampleMs / 1000) }} s · {{ t('coco.process.trace.minimum') }} {{ setting('minSampleSeconds') }} s</dd>
          <dt>{{ t('coco.process.trace.delay') }}</dt><dd>{{ number(event.sample.delayMs, 0) }} ms</dd>
          <dt>{{ t('coco.process.trace.requiredSamples') }}</dt><dd>{{ setting('confirmRounds') }}</dd>
        </dl>
        <template v-if="comparison">
          <div class="overflow-x-auto"><table class="table table-xs"><thead><tr><th>{{ t('coco.process.trace.node') }}</th><th>{{ t('coco.process.trace.delay') }}</th><th>Mbps</th><th>{{ t('coco.process.samples') }}</th><th>{{ t('coco.process.trace.loss') }}</th></tr></thead><tbody>
            <tr v-for="side in (['current', 'candidate'] as const)" :key="side"><td class="max-w-48 break-all">{{ side === 'current' ? comparison.currentNode : comparison.candidateNode }}</td><td>{{ number(comparison[side].delay, 0) }} ms</td><td>{{ number(comparison[side].mbps) }}</td><td>{{ (side === 'current' ? comparison.effectiveCurrent : comparison.effectiveCandidate).length }} / {{ setting('confirmRounds') }}</td><td>{{ number(comparison[side].low, 3) }}–{{ number(comparison[side].high, 3) }}</td></tr>
          </tbody></table></div>
          <dl class="trace-facts">
            <dt>{{ t('coco.process.trace.gain') }}</dt><dd>{{ number(comparison.current.low, 3) }} − {{ number(comparison.candidate.high, 3) }} − {{ number(comparison.uncertainty, 3) }} = {{ number(comparison.gain, 3) }}</dd>
            <dt>{{ t('coco.process.trace.threshold') }}</dt><dd>max({{ number(setting('minGainMs') / 1000, 3) }}, {{ number(comparison.current.low * setting('minGainRatio'), 3) }}) + {{ number(comparison.cost, 3) }} = {{ number(comparison.threshold, 3) }}</dd>
            <dt>{{ t('coco.process.trace.delayGuard') }}</dt><dd>{{ number(comparison.candidate.delay, 0) }} ≤ {{ number(Math.max(setting('delayReferenceMs'), comparison.current.delay * (1 + setting('tradeoffRatio'))), 0) }} ms {{ flag(comparison.candidate.delay <= Math.max(setting('delayReferenceMs'), comparison.current.delay * (1 + setting('tradeoffRatio')))) }}</dd>
            <dt>{{ t('coco.process.trace.rateGuard') }}</dt><dd>{{ number(comparison.candidate.mbps) }} ≥ {{ number(Math.min(setting('throughputReferenceMbps'), comparison.current.mbps * (1 - setting('tradeoffRatio')))) }} Mbps {{ flag(comparison.candidate.mbps >= Math.min(setting('throughputReferenceMbps'), comparison.current.mbps * (1 - setting('tradeoffRatio')))) }}</dd>
            <dt>{{ t('coco.process.trace.recentSwitches') }}</dt><dd>{{ comparison.recentSwitches }}</dd>
            <dt>{{ t('coco.process.trace.reverse') }}</dt><dd>{{ flag(comparison.reverse) }}</dd>
          </dl>
          <details><summary class="cursor-pointer py-2 text-base-content/65">{{ t('coco.process.calculation') }}</summary><div class="overflow-x-auto"><table class="table table-xs"><thead><tr><th>{{ t('coco.process.trace.node') }}</th><th>{{ t('coco.process.trace.timestamp') }}</th><th>{{ t('coco.process.trace.delay') }}</th><th>Mbps</th><th>{{ t('coco.process.trace.loss') }}</th></tr></thead><tbody><tr v-for="(sample, index) in samples" :key="index"><td class="max-w-40 break-all">{{ sample.node }}</td><td>{{ relative(sample.at) }}</td><td>{{ sample.delayMs }} ms</td><td>{{ number(sample.mbps) }}</td><td>{{ number(sample.delay, 3) }} + {{ number(sample.shortfall, 3) }} = {{ number(sample.total, 3) }}</td></tr></tbody></table></div></details>
        </template>
        <dl v-if="event.screening" class="trace-facts"><dt>{{ t('coco.process.trace.gain') }}</dt><dd>{{ number(event.screening.currentLow, 3) }} − {{ number(event.screening.bestCandidateLoss, 3) }} − {{ number(event.screening.uncertainty, 3) }} = {{ number(event.screening.currentLow - event.screening.bestCandidateLoss - event.screening.uncertainty, 3) }}</dd><dt>{{ t('coco.process.trace.threshold') }}</dt><dd>{{ number(event.screening.threshold, 3) }}</dd></dl>
        <dl v-if="budget" class="trace-facts"><dt>{{ t('coco.process.trace.hour') }}</dt><dd>{{ number(budget.hourBytes / 1048576) }} / {{ number(budget.hourLimit / 1048576) }} MiB</dd><dt>{{ t('coco.process.trace.day') }}</dt><dd>{{ number(budget.dayBytes / 1048576) }} / {{ number(budget.dayLimit / 1048576) }} MiB</dd><dt>{{ t('coco.process.trace.search') }}</dt><dd>{{ number(budget.searchBytes / 1048576) }} / {{ number(budget.searchLimit / 1048576) }} MiB</dd><dt>{{ t('coco.process.trace.reserve') }}</dt><dd>{{ number(budget.hourReserve / 1048576) }} / {{ number(budget.dayReserve / 1048576) }} MiB · {{ t(budget.urgent ? 'coco.process.reserveAllowed' : 'coco.process.reserveProtected') }}</dd></dl>
        <dl v-if="protection" class="trace-facts"><dt>{{ t('coco.process.trace.recentSwitches') }}</dt><dd>{{ protection.recentSwitches }} / {{ protection.maxSwitches }}</dd><dt>{{ t('coco.process.trace.holdUntil') }}</dt><dd>{{ time(protection.holdUntil) }}</dd><dt>{{ t('coco.process.trace.limitUntil') }}</dt><dd>{{ protection.limitUntil ? time(protection.limitUntil) : '—' }}</dd></dl>
        <p class="text-base-content/50">{{ t('coco.process.trace.unrecorded') }}</p>
      </div>
    </details>
  </li>
</template>

<style scoped>
.trace-row { display: grid; grid-template-columns: 5rem 1rem minmax(0, 1fr); column-gap: .75rem; }
.trace-time { padding-top: 1rem; color: color-mix(in srgb, currentColor 60%, transparent); font-size: .75rem; overflow-wrap: anywhere; }
.trace-rail { position: relative; display: flex; justify-content: center; padding-top: 1.3rem; }
.trace-rail::after { content: ''; position: absolute; top: 1.8rem; bottom: -.3rem; width: 1px; background: color-mix(in srgb, currentColor 15%, transparent); }
.trace-row:last-child .trace-rail::after { display: none; }
.trace-mark { width: .45rem; height: .45rem; flex-shrink: 0; border: 1px solid currentColor; border-radius: 50%; color: var(--color-primary); }
.trace-mark.decision { border-radius: 0; transform: rotate(45deg); }
.trace-mark.end { border-radius: 0; background: currentColor; }
.trace-mark.waiting { color: color-mix(in srgb, currentColor 45%, transparent); }
.trace-body { min-width: 0; border-bottom: 1px solid color-mix(in srgb, currentColor 10%, transparent); }
.trace-row:last-child .trace-body { border-bottom: 0; }
.trace-summary { display: grid; grid-template-columns: minmax(6rem, 8rem) minmax(0, 1fr) 1rem; align-items: start; gap: .75rem; padding: .85rem 0; min-height: 2.75rem; cursor: pointer; list-style: none; }
.trace-summary::-webkit-details-marker { display: none; }
.trace-action { font-size: .875rem; font-weight: 500; overflow-wrap: anywhere; }
.trace-data { display: flex; flex-wrap: wrap; gap: .3rem 1rem; font-size: .8125rem; overflow-wrap: anywhere; }
.trace-detail { margin-bottom: 1rem; padding: .85rem; border-radius: .5rem; background: var(--color-base-200); }
.trace-facts { display: grid; grid-template-columns: minmax(5rem, 1fr) minmax(0, 2fr); gap: .4rem 1rem; }
.trace-facts dt { opacity: .65; }
.trace-facts dd { min-width: 0; overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
@media (max-width: 640px) {
  .trace-row { grid-template-columns: 3.8rem .75rem minmax(0, 1fr); column-gap: .4rem; }
  .trace-summary { grid-template-columns: minmax(0, 1fr) 1rem; gap: .4rem; }
  .trace-action { grid-column: 1; }
  .trace-data { grid-column: 1; }
  .trace-summary > svg { grid-column: 2; grid-row: 1; }
  .trace-detail { padding: .6rem; }
  .trace-facts { grid-template-columns: minmax(0, 1fr); gap: .2rem; }
  .trace-facts dd + dt { margin-top: .35rem; }
}
</style>
