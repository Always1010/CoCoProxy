<script setup lang="ts">
import { IconArrowLeft, IconChevronRight, IconInfoCircle, IconRestore, IconSettings } from '@tabler/icons-vue'
import type { BandwidthSettings } from '~/composables/useWorkspace'
import { bandwidthPages } from '~/utils/group-bandwidth'
import type { BandwidthDefinitions, BandwidthIssue, BandwidthPage } from '~/utils/group-bandwidth'

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
  <section class="space-y-3" :aria-label="definition.label">
    <template v-if="explanation">
      <button type="button" class="btn btn-ghost min-h-11" @click="explanation = false"><IconArrowLeft :size="16" /><span>返回收益判断</span></button>
      <h3 class="flex items-center gap-2 text-base font-semibold"><IconInfoCircle :size="18" />评分原理</h3>
      <p class="text-sm leading-relaxed">损失 = 延迟秒数 + 吞吐不足权重 × max(0, 目标 / 有效吞吐 − 1)。达标吞吐封顶，评分不是实际断网时长。</p>
      <p class="text-sm leading-relaxed">比较近期样本的保守区间，扣除陌生候选风险及切换成本；改善须严格超过门槛，并通过相对短板保护，才执行切换。</p>
      <p class="text-sm leading-relaxed">延迟和吞吐参考线不是绝对淘汰线；优选恢复也须满足综合收益条件，避免相近节点反复切换。</p>
    </template>
    <template v-else>
      <template v-if="page === 'bandwidth'">
        <div class="flex min-h-11 items-center justify-between gap-4 text-sm font-medium">
          <div class="flex flex-wrap items-center gap-2"><label for="group-bandwidth-enabled">带宽辅助决策</label><HelpTip label="说明">根据延迟与下载吞吐综合评估候选改善，故障恢复优先。关闭并保存后使用原有延迟选择策略；原有参数会保留。</HelpTip></div>
          <input id="group-bandwidth-enabled" :checked="settings.enabled" type="checkbox" class="toggle toggle-primary" :disabled="disabled" @change="toggle('enabled', $event)" />
        </div>
      </template>
      <div v-if="settings.enabled" class="space-y-3" :class="{ 'pl-4': page === 'bandwidth' }">
        <div v-if="page === 'bandwidth'" class="flex min-h-11 items-center justify-between gap-4 text-sm">
          <div class="flex flex-wrap items-center gap-2"><label for="group-bandwidth-observe">仅观察</label><HelpTip label="说明">仍会下载验证并消耗流量，但不执行带宽性能切换；故障恢复继续执行。</HelpTip></div>
          <input id="group-bandwidth-observe" :checked="settings.observeOnly" type="checkbox" class="toggle toggle-primary" :disabled="disabled" @change="toggle('observeOnly', $event)" />
        </div>
        <p v-else class="text-xs text-base-content/60">{{ customCount ? '已自定义 ' + customCount + ' 项' : '使用推荐参数' }}</p>
        <div :class="page === 'bandwidth' ? 'space-y-4' : 'grid gap-x-5 gap-y-4 sm:grid-cols-2'">
          <label v-for="[key, field] in fields" :key="key" class="block text-sm" :for="'group-bandwidth-' + key">
            <span class="mb-1.5 block">{{ key === 'targetMbps' ? '目标下载速度' : field.label }}</span>
            <span class="flex items-center gap-2">
              <input :id="'group-bandwidth-' + key" :value="settings[key]" type="number" class="input input-sm w-36" :class="{ 'input-error': issue?.key === key }" :min="field.min" :max="field.max" :step="field.integer ? 1 : 0.01" :disabled="disabled" :aria-invalid="issue?.key === key || undefined" :aria-describedby="issue?.key === key ? 'bandwidth-field-error' : undefined" required @input="number(key, $event)" />
              <span class="text-xs text-base-content/60">{{ field.unit }}</span>
            </span>
            <span v-if="issue?.key === key" id="bandwidth-field-error" class="mt-1 block text-xs text-error" role="alert">{{ issue.message }}</span>
          </label>
        </div>
        <template v-if="page === 'bandwidth'">
          <HelpTip label="目标速度说明">目标约 {{ (Number(settings.targetMbps) / 8).toFixed(2) }} MB/s；达到目标后，不因更高峰值额外加分。</HelpTip>
          <SettingsNotice warning>自动下载验证会消耗流量，观察模式也会消耗。</SettingsNotice>
          <div class="divide-y divide-base-content/10 border-t border-base-content/10">
            <button type="button" class="auxiliary-link btn btn-ghost min-h-11 w-full justify-between" :disabled="disabled" @click="emit('navigate', 'budget')">
              <span class="flex min-w-0 items-start gap-2 text-left"><IconSettings :size="16" class="mt-0.5 shrink-0" /><span><span class="block">流量预算<span v-if="issue?.page === 'budget'" class="ml-2 text-error">有配置错误</span></span><span class="mt-1 block text-xs font-normal text-base-content/60">每小时 {{ settings.hourMiB }} MiB · 24 小时 {{ settings.dayMiB }} MiB</span></span></span><span class="flex shrink-0 items-center gap-1 text-xs">设置<IconChevronRight :size="14" /></span>
            </button>
            <button type="button" class="auxiliary-link btn btn-ghost min-h-11 w-full justify-between" :disabled="disabled" @click="emit('navigate', 'advanced')">
              <span class="flex min-w-0 items-start gap-2 text-left"><IconSettings :size="16" class="mt-0.5 shrink-0" /><span><span class="block">高级参数<span v-if="issue && issue.page !== 'bandwidth' && issue.page !== 'budget'" class="ml-2 text-error">有配置错误</span></span><span class="mt-1 block text-xs font-normal text-base-content/60">{{ tuningCount ? '已自定义 ' + tuningCount + ' 项' : '使用推荐参数' }}</span></span></span><span class="flex shrink-0 items-center gap-1 text-xs">设置<IconChevronRight :size="14" /></span>
            </button>
          </div>
        </template>
        <SettingsNotice v-if="page === 'budget'">多个启用组共用预算：总额取最小值，劣化处理预留取最大值。预留包含在总额内；预算统计应用载荷，实际网络流量还含协议开销。</SettingsNotice>
        <div v-if="page !== 'bandwidth'" class="flex flex-wrap gap-2 border-t border-base-content/10 pt-3">
          <button v-if="page === 'gain'" type="button" class="btn btn-ghost min-h-11" @click="explanation = true"><IconInfoCircle :size="16" /><span>查看评分原理</span></button>
          <button type="button" class="btn btn-ghost min-h-11" :disabled="disabled || !customCount" @click="restore"><IconRestore :size="16" /><span>恢复本页推荐值</span></button>
        </div>
      </div>
    </template>
  </section>
</template>

<style scoped>
.auxiliary-link { height: auto; padding-block: 12px; white-space: normal; gap: 12px; }
</style>
