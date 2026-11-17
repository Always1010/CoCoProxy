<script setup lang="ts">
import type { AutomaticEngineStatus, ResponsiveLatencyStatus } from '~/composables/useWorkspace'
const props = defineProps<{ status: ResponsiveLatencyStatus; engine?: AutomaticEngineStatus }>()
const { t, locale } = useI18n()
const reasons = computed<Record<string, string>>(() => ({
  'insufficient-evidence': t('coco.response.reason.insufficient-evidence'),
  monitoring: t('coco.response.reason.monitoring'),
  'checking-response': t('coco.response.reason.checking-response'),
  'current-degraded': t('coco.response.reason.current-degraded'),
  'candidate-confirmation': t('coco.response.reason.candidate-confirmation'),
  'gain-insufficient': t('coco.response.reason.gain-insufficient'),
  'current-recovered': t('coco.response.reason.current-recovered'),
  'no-better-candidate': t('coco.response.reason.no-better-candidate'),
  'failure-confirmation': t('coco.response.reason.failure-confirmation'),
  holding: t('coco.response.reason.holding'),
}))
const reason = computed(() => props.engine?.reason === 'quota' ? t('coco.autoEngineReason.quota')
  : props.engine?.reason === 'retry-after' ? t('coco.autoEngineReason.retry-after')
    : reasons.value[props.status.reason] ?? t('coco.anWaitingForTheNextEvaluation'))
const ms = (value: number | null) => value === null ? t('coco.anUnknown') : Math.round(value) + ' ms'
const time = (value: number) => new Date(value).toLocaleTimeString(locale.value)
</script>

<template>
  <section class="space-y-2 border-t border-base-content/10 pt-4 text-sm" :aria-label="t('coco.response.title')">
    <h4 class="font-medium">{{ t('coco.response.title') }}</h4>
    <p role="status">{{ reason }}</p>
    <p>{{ t('coco.response.window', { threshold: ms(status.slowMs), median: ms(status.fresh ? status.medianMs : null), slow: status.slowCount, total: status.samples.length }) }}</p>
    <ul class="flex flex-wrap gap-x-4 gap-y-1 text-xs tabular-nums text-base-content/70" :aria-label="t('coco.response.samples')">
      <li v-for="sample in status.samples" :key="sample.at">{{ time(sample.at) }} · {{ ms(sample.delayMs) }}</li>
    </ul>
    <template v-if="status.decision">
      <p class="break-all">{{ t('coco.response.candidate', { node: status.decision.node, current: ms(status.decision.currentMs), candidate: ms(status.decision.candidateMs) }) }}</p>
      <p>{{ t('coco.response.gain', { gain: ms(status.decision.gainMs), required: ms(status.decision.requiredGainMs) }) }}</p>
    </template>
    <SettingsNotice>{{ t('coco.response.evidenceHint') }}</SettingsNotice>
  </section>
</template>
