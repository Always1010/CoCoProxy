<script setup lang="ts">
import { IconArrowLeft, IconChevronRight, IconInfoCircle, IconRestore, IconSettings } from '@tabler/icons-vue'
import type { BandwidthSettings } from '~/composables/useWorkspace'
import { bandwidthPages } from '~/utils/group-bandwidth'
import type { BandwidthDefinitions, BandwidthIssue, BandwidthPage } from '~/utils/group-bandwidth'
const { t } = useI18n()

const units: Record<string, string> = { '比例': 'ratio', '等价ms': 'equivalentMs', '秒': 'seconds', '等价秒': 'equivalentSeconds', '个': 'items', '次': 'times', '目标比例': 'targetRatio' }
const unitLabel = (unit: string) => units[unit] ? t('coco.bandwidthUnit.' + units[unit]) : unit

const props = defineProps<{ modelValue?: BandwidthSettings; definitions: BandwidthDefinitions; page: BandwidthPage; disabled: boolean; issue?: BandwidthIssue }>()
const emit = defineEmits<{ 'update:modelValue': [value: BandwidthSettings]; navigate: [page: BandwidthPage | 'advanced'] }>()
const explanation = ref(false)
const settings = computed(() => props.modelValue ?? props.definitions.defaults)
const definition = computed(() => bandwidthPages.find(page => page.id === props.page)!)
const fields = computed(() => definition.value.keys.flatMap(key => {
  const field = props.definitions.fields[key]
  return field ? [[key, field] as const] : []
}))
const customCount = computed(() => fields.value.filter(([key]) => settings.value[key] !== props.definitions.defaults[key]).length)
const tuningCount = computed(() => bandwidthPages.filter(page => page.id !== 'bandwidth' && page.id !== 'budget')
  .flatMap(page => [...page.keys]).filter(key => settings.value[key] !== props.definitions.defaults[key]).length)
function toggle(key: 'enabled' | 'observeOnly', event: Event) {
  if (props.disabled || (key === 'observeOnly' && !settings.value.enabled)) return
  emit('update:modelValue', { ...settings.value, [key]: (event.target as HTMLInputElement).checked })
}
function number(key: string, event: Event) {
  if (props.disabled || !settings.value.enabled) return
  const input = event.target as HTMLInputElement
  emit('update:modelValue', { ...settings.value, [key]: input.value === '' ? Number.NaN : Number(input.value) })
}
function restore() {
  if (props.disabled || !settings.value.enabled) return
  const next = { ...settings.value }
  for (const [key] of fields.value) next[key] = props.definitions.defaults[key]!
  emit('update:modelValue', next)
}
watch(() => props.page, () => { explanation.value = false })
</script>

<template>
  <section class="space-y-3" :aria-label="t(definition.label)">
    <template v-if="explanation">
      <button type="button" class="btn btn-ghost min-h-11" @click="explanation = false"><IconArrowLeft :size="16" /><span>{{ t('coco.anBackToBenefitAssessment') }}</span></button>
      <h3 class="flex items-center gap-2 text-base font-semibold"><IconInfoCircle :size="18" />{{ t('coco.anHowScoringWorks') }}</h3>
      <p class="text-sm leading-relaxed">{{ t('coco.anLossLatencyInSecondsThroughputShortfall') }}</p>
      <p class="text-sm leading-relaxed">{{ t('coco.anCompareConservativeIntervalsFromRecentSamples') }}</p>
      <p class="text-sm leading-relaxed">{{ t('coco.anLatencyAndThroughputReferencesAreNot') }}</p>
    </template>
    <template v-else>
      <template v-if="page === 'bandwidth'">
        <div class="flex min-h-11 items-center justify-between gap-4 text-sm font-medium">
          <div class="flex flex-wrap items-center gap-2"><label for="group-bandwidth-enabled">{{ t('coco.anBandwidthAssistedDecisions2') }}</label><HelpTip :label="t('coco.anHelp')">{{ t('coco.anEvaluateCandidateImprovementsUsingLatencyAnd') }}</HelpTip></div>
          <input id="group-bandwidth-enabled" :checked="settings.enabled" type="checkbox" class="toggle toggle-primary" :disabled="disabled" @change="toggle('enabled', $event)" />
        </div>
      </template>
      <div v-if="settings.enabled" class="space-y-3" :class="{ 'pl-4': page === 'bandwidth' }">
        <div v-if="page === 'bandwidth'" class="flex min-h-11 items-center justify-between gap-4 text-sm">
          <div class="flex flex-wrap items-center gap-2"><label for="group-bandwidth-observe">{{ t('coco.anObserveOnly2') }}</label><HelpTip :label="t('coco.anHelp')">{{ t('coco.anDownloadValidationStillConsumesTrafficBut') }}</HelpTip></div>
          <input id="group-bandwidth-observe" :checked="settings.observeOnly" type="checkbox" class="toggle toggle-primary" :disabled="disabled" @change="toggle('observeOnly', $event)" />
        </div>
        <p v-else class="text-xs text-base-content/60">{{ customCount ? t('coco.anCustomizedCount', { count: customCount }) : t('coco.anUsingRecommendedParameters') }}</p>
        <div :class="page === 'bandwidth' ? 'space-y-4' : 'grid gap-x-5 gap-y-4 sm:grid-cols-2'">
          <label v-for="[key, field] in fields" :key="key" class="block text-sm" :for="'group-bandwidth-' + key">
            <span class="mb-1.5 block">{{ t('coco.bandwidthField.' + key) }}</span>
            <span class="flex items-center gap-2">
              <input :id="'group-bandwidth-' + key" :value="settings[key]" type="number" class="input input-sm w-36" :class="{ 'input-error': issue?.key === key }" :min="field.min" :max="field.max" :step="field.integer ? 1 : 0.01" :disabled="disabled" :aria-invalid="issue?.key === key || undefined" :aria-describedby="issue?.key === key ? 'bandwidth-field-error' : undefined" required @input="number(key, $event)" />
              <span class="text-xs text-base-content/60">{{ unitLabel(field.unit) }}</span>
            </span>
            <span v-if="issue?.key === key" id="bandwidth-field-error" class="mt-1 block text-xs text-error" role="alert">{{ issue.message }}</span>
          </label>
        </div>
        <template v-if="page === 'bandwidth'">
          <HelpTip :label="t('coco.anAboutTargetSpeed')">{{ t('coco.anTheTargetIsApproximatelyMbS', { value: (Number(settings.targetMbps) / 8).toFixed(2) }) }}</HelpTip>
          <SettingsNotice warning>{{ t('coco.anAutomaticDownloadValidationConsumesTrafficIncluding') }}</SettingsNotice>
          <div class="divide-y divide-base-content/10 border-t border-base-content/10">
            <button type="button" class="auxiliary-link btn btn-ghost min-h-11 w-full justify-between" :disabled="disabled" @click="emit('navigate', 'budget')">
              <span class="flex min-w-0 items-start gap-2 text-left"><IconSettings :size="16" class="mt-0.5 shrink-0" /><span><span class="block">{{ t('coco.anTrafficBudget') }}<span v-if="issue?.page === 'budget'" class="ml-2 text-error">{{ t('coco.anConfigurationError') }}</span></span><span class="mt-1 block text-xs font-normal text-base-content/60">{{ t('coco.anHourlyMibHoursMib', { value: settings.hourMiB, value2: settings.dayMiB }) }}</span></span></span><span class="flex shrink-0 items-center gap-1 text-xs">{{ t('coco.anSettings') }}<IconChevronRight :size="14" /></span>
            </button>
            <button type="button" class="auxiliary-link btn btn-ghost min-h-11 w-full justify-between" :disabled="disabled" @click="emit('navigate', 'advanced')">
              <span class="flex min-w-0 items-start gap-2 text-left"><IconSettings :size="16" class="mt-0.5 shrink-0" /><span><span class="block">{{ t('coco.anAdvancedParameters') }}<span v-if="issue && issue.page !== 'bandwidth' && issue.page !== 'budget'" class="ml-2 text-error">{{ t('coco.anConfigurationError') }}</span></span><span class="mt-1 block text-xs font-normal text-base-content/60">{{ tuningCount ? t('coco.anCustomizedCount', { count: tuningCount }) : t('coco.anUsingRecommendedParameters') }}</span></span></span><span class="flex shrink-0 items-center gap-1 text-xs">{{ t('coco.anSettings') }}<IconChevronRight :size="14" /></span>
            </button>
          </div>
        </template>
        <SettingsNotice v-if="page === 'budget'">{{ t('coco.anEnabledGroupsShareABudgetThe') }}</SettingsNotice>
        <div v-if="page !== 'bandwidth'" class="flex flex-wrap gap-2 border-t border-base-content/10 pt-3">
          <button v-if="page === 'gain'" type="button" class="btn btn-ghost min-h-11" @click="explanation = true"><IconInfoCircle :size="16" /><span>{{ t('coco.anViewScoringExplanation') }}</span></button>
          <button type="button" class="btn btn-ghost min-h-11" :disabled="disabled || !customCount" @click="restore"><IconRestore :size="16" /><span>{{ t('coco.anRestoreRecommendedValuesForThisPage') }}</span></button>
        </div>
      </div>
    </template>
  </section>
</template>

<style scoped>
.auxiliary-link { height: auto; padding-block: 12px; white-space: normal; gap: 12px; }
</style>
