<script setup lang="ts">
import { IconArrowLeft, IconInfoCircle, IconRestore } from '@tabler/icons-vue'
import type { BandwidthSettings } from '~/composables/useWorkspace'
import { bandwidthPages } from '~/utils/group-bandwidth'
import type { BandwidthDefinitions, BandwidthIssue, BandwidthPage } from '~/utils/group-bandwidth'

const props = defineProps<{ modelValue?: BandwidthSettings; definitions: BandwidthDefinitions; page: BandwidthPage; disabled: boolean; issue?: BandwidthIssue }>()
const emit = defineEmits<{ 'update:modelValue': [value: BandwidthSettings] }>()
const explanation = ref(false)
const settings = computed(() => props.modelValue ?? props.definitions.defaults)
const definition = computed(() => bandwidthPages.find(page => page.id === props.page)!)
const fields = computed(() => definition.value.keys.flatMap(key => {
  const field = props.definitions.fields[key]
  return field ? [[key, field] as const] : []
}))
const customCount = computed(() => fields.value.filter(([key]) => settings.value[key] !== props.definitions.defaults[key]).length)
const modes = [
  { id: 'off', label: '关闭', description: '使用原有延迟策略，不进行带宽辅助下载验证。' },
  { id: 'switch', label: '参与切换', description: '结合延迟与下载吞吐判断是否值得切换。' },
  { id: 'observe', label: '仅观察', description: '下载验证和判断照常进行，不执行带宽性能切换；故障恢复仍然执行。' },
] as const
const mode = computed(() => !settings.value.enabled ? 'off' : settings.value.observeOnly ? 'observe' : 'switch')
function setMode(value: typeof modes[number]['id']) {
  if (props.disabled) return
  emit('update:modelValue', { ...settings.value, enabled: value !== 'off', observeOnly: value === 'off' ? settings.value.observeOnly : value === 'observe' })
}
function number(key: string, event: Event) {
  if (props.disabled) return
  const input = event.target as HTMLInputElement
  emit('update:modelValue', { ...settings.value, [key]: input.value === '' ? Number.NaN : Number(input.value) })
}
function restore() {
  if (props.disabled) return
  const next = { ...settings.value }
  for (const [key] of fields.value) next[key] = props.definitions.defaults[key]!
  emit('update:modelValue', next)
}
watch(() => props.page, () => { explanation.value = false })
</script>

<template>
  <section class="space-y-5" :aria-label="definition.label">
    <template v-if="explanation">
      <button type="button" class="btn btn-ghost min-h-11" @click="explanation = false"><IconArrowLeft :size="16" /><span>返回收益判断</span></button>
      <h3 class="text-base font-semibold">评分原理</h3>
      <p class="text-sm leading-relaxed">损失 = 延迟秒数 + 吞吐不足权重 × max(0, 目标 / 有效吞吐 − 1)。达标吞吐封顶，评分不是实际断网时长。</p>
      <p class="text-sm leading-relaxed">比较近期样本的保守区间，扣除陌生候选风险及切换成本；改善须严格超过门槛，并通过相对短板保护，才执行切换。</p>
      <p class="text-sm leading-relaxed">延迟和吞吐参考线不是绝对淘汰线；优选恢复也须满足综合收益条件，避免相近节点反复切换。</p>
    </template>
    <template v-else>
      <fieldset v-if="page === 'bandwidth'" class="space-y-2" :disabled="disabled">
        <legend class="mb-2 text-sm font-medium">工作方式</legend>
        <label v-for="option in modes" :key="option.id" class="flex min-h-11 cursor-pointer items-start gap-3 py-2">
          <input type="radio" name="bandwidth-mode" class="radio radio-primary radio-sm mt-0.5 shrink-0" :checked="mode === option.id" @change="setMode(option.id)" />
          <span><span class="block text-sm font-medium">{{ option.label }}</span><span class="mt-1 block text-xs leading-relaxed text-base-content/65">{{ option.description }}</span></span>
        </label>
      </fieldset>
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
        <SettingsNotice>目标约 {{ (Number(settings.targetMbps) / 8).toFixed(2) }} MB/s；达到目标后，不因更高峰值额外加分。</SettingsNotice>
        <SettingsNotice warning>自动下载验证会消耗流量，观察模式也会消耗；自动选择关闭时不运行。</SettingsNotice>
      </template>
      <SettingsNotice v-if="page === 'budget'">多个启用组共用预算：总额取最小值，劣化处理预留取最大值。预留包含在总额内；预算统计应用载荷，实际网络流量还含协议开销。</SettingsNotice>
      <SettingsNotice v-if="page !== 'bandwidth' && !settings.enabled">带宽辅助决策已关闭，参数仍会保留，启用后参与决策。</SettingsNotice>
      <div class="flex flex-wrap gap-2 border-t border-base-content/10 pt-3">
        <button v-if="page === 'gain'" type="button" class="btn btn-ghost min-h-11" @click="explanation = true"><IconInfoCircle :size="16" /><span>查看评分原理</span></button>
        <button type="button" class="btn btn-ghost min-h-11" :disabled="disabled || !customCount" @click="restore"><IconRestore :size="16" /><span>恢复本页推荐值</span></button>
      </div>
    </template>
  </section>
</template>
