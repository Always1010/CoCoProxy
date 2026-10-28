<script setup lang="ts">
import { IconAdjustments, IconBrandSpeedtest, IconRefresh, IconRestore } from '@tabler/icons-vue'
import type { BandwidthSettings, BandwidthSelectionStatus } from '~/composables/useWorkspace'
import { cocoproxyErrorMessage } from '~/composables/useCoCoProxy'

const props = defineProps<{ modelValue?: BandwidthSettings; disabled: boolean; status?: BandwidthSelectionStatus; groupName: string; canCheck: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [value: BandwidthSettings] }>()
const { api, view } = useWorkspace()
type Field = { label: string; default: number; min: number; max: number; unit: string; integer: boolean; basic: boolean }
const definitions = ref<{ defaults: BandwidthSettings; fields: Record<string, Field> }>()
const error = ref('')
const loading = ref(false)
const checking = ref(false)
const feedback = ref('')
const settings = computed(() => props.modelValue ?? definitions.value?.defaults)
const basic = computed(() => Object.entries(definitions.value?.fields ?? {}).filter(([, value]) => value.basic))
const advanced = computed(() => Object.entries(definitions.value?.fields ?? {}).filter(([, value]) => !value.basic))
const invalid = computed(() => {
  const s = settings.value
  if (!s?.enabled) return ''
  if (!definitions.value) return '参数定义尚未读取，请重试后保存。'
  const n = (key: string) => Number(s[key])
  if (Object.entries(definitions.value.fields).some(([key, f]) => !Number.isFinite(n(key)) || n(key) < f.min || n(key) > f.max || (f.integer && !Number.isInteger(n(key))))) return '请检查参数范围；整数项不能填写小数。'
  if (n('durationSeconds') < n('warmupSeconds') + n('minSampleSeconds') || n('timeoutSeconds') < n('durationSeconds') + 5
    || n('roundIntervalSeconds') < n('timeoutSeconds') * 2 || n('freshSeconds') < n('timeoutSeconds') * 2
    || n('campaignSeconds') < (n('confirmRounds') - 1) * n('roundIntervalSeconds') + n('timeoutSeconds') * 2) return '时间不足：需容纳预热、有效样本、两节点任务和全部确认轮次。'
  if (n('dayMiB') < n('hourMiB') || n('hourMiB') < n('taskMiB') * n('confirmRounds') * 2) return '每日预算须不少于每小时预算；每小时预算须容纳当前与候选的全部确认轮次。'
  if (n('taskMiB') * 1048576 < n('targetMbps') * 125000 * 1.25 * (n('warmupSeconds') + n('minSampleSeconds')) + 131072) return '单次流量额度不足以验证该目标，请增加额度或降低目标。'
  if (n('busyStopMbps') <= n('busyStartMbps')) return '检测中止阈值须高于启动阈值。'
  return ''
})
defineExpose({ valid: computed(() => !invalid.value) })
function set(key: string, value: number | boolean) {
  if (!settings.value || props.disabled) return
  emit('update:modelValue', { ...settings.value, [key]: value })
}
function number(key: string, event: Event) { set(key, Number((event.target as HTMLInputElement).value)) }
function toggle(key: string, event: Event) { set(key, (event.target as HTMLInputElement).checked) }
function restore() {
  if (definitions.value && settings.value) emit('update:modelValue', { ...definitions.value.defaults,
    enabled: settings.value.enabled, observeOnly: settings.value.observeOnly })
}
async function load() {
  loading.value = true; error.value = ''
  try { definitions.value = (await api.request<{ bandwidth: NonNullable<typeof definitions.value> }>('/api/cocoproxy/automatic/probes')).bandwidth }
  catch (cause) { error.value = cocoproxyErrorMessage(cause) }
  finally { loading.value = false }
}
async function check() {
  if (!props.canCheck || props.disabled || checking.value || !view.value?.active) return
  checking.value = true; feedback.value = ''
  try {
    await api.request('/api/cocoproxy/automatic/bandwidth/check', { method: 'POST', body: {
      expectedRevision: view.value.workspace.revision, expectedActive: view.value.active,
      scope: view.value.automatic?.scope, group: props.groupName,
    } })
    feedback.value = '检查已排队，仍遵守业务空闲、流量预算和切换保持限制。'
  } catch (cause) { feedback.value = cocoproxyErrorMessage(cause) }
  finally { checking.value = false }
}
const reasons: Record<string, string> = {
  'waiting-traffic': '等待持续低速业务证据', 'waiting-idle': '等待业务空闲或测速名额', 'budget-exhausted': '自动检测预算不足，保持当前节点',
  'measurement-unavailable': '下载验证服务不可用，无法比较节点吞吐', collecting: '正在收集当前与候选的配对样本', 'current-sufficient': '当前节点无需为这点改善切换',
  'no-candidate': '没有可比较的候选', 'candidate-unavailable': '候选未通过轻量检查', 'sample-unknown': '样本无效或不足，不给节点降级',
  'no-clear-gain': '扣除波动和成本后改善不足，保持当前节点', 'would-switch': '观察模式：已达到切换条件，未执行切换',
  'bandwidth-improvement': '已确认净收益并完成吞吐性能切换', 'switch-limit': '保持时间或近期切换上限尚未解除',
  'latency-priority': '延迟检测或故障恢复优先，已结束本轮', 'latency-pressure': '响应延迟上升，已停止下载验证',
  'business-busy': '业务流量增加，已停止下载验证', 'evidence-timeout': '未在时限内收齐证据', 'configuration-changed': '配置或运行代次变化，旧证据失效',
  'selection-conflict': '切换前状态已变化，未执行', 'storage-unavailable': '预算账本不可用，已停止自动下载',
}
const amount = (bytes: number) => (bytes / 1048576).toFixed(1)
const loss = (value: number) => `${Math.round(value * 1000)} ms`
onMounted(load)
</script>

<template>
  <section class="space-y-3 rounded-lg border border-base-content/10 p-3" aria-label="带宽辅助决策设置">
    <label class="flex min-h-11 items-center justify-between gap-3 text-sm font-medium">带宽辅助决策<input :checked="settings?.enabled ?? false" type="checkbox" class="toggle toggle-primary" :disabled="disabled || (!settings?.enabled && (loading || !definitions))" @change="toggle('enabled', $event)" /></label>
    <p class="text-xs leading-relaxed text-base-content/65">默认关闭，关闭时完整使用原自动选点策略。开启后普通性能切换与优选回切须通过吞吐、波动和切换成本判断；故障恢复仍优先。</p>
    <p v-if="loading" class="text-xs" role="status">正在读取参数…</p>
    <div v-if="error" class="flex flex-wrap items-center gap-2 text-xs text-warning"><span>{{ error }}</span><button type="button" class="btn btn-sm min-h-11" :disabled="disabled || loading" @click="load"><IconRefresh :size="16" /><span>重读参数</span></button></div>
    <template v-if="settings?.enabled && definitions">
      <label class="flex min-h-11 items-center justify-between gap-3 text-sm">仅观察，不执行带宽切换<input :checked="settings.observeOnly" type="checkbox" class="toggle toggle-sm" :disabled="disabled" @change="toggle('observeOnly', $event)" /></label>
      <p class="text-xs text-base-content/65">开启带宽辅助决策后会按需自动下载验证并消耗流量，观察模式也会消耗验证流量。建议先用观察模式核对收益。多组同时开启时，采用各组最小配置作为全局流量预算。</p>
      <div class="space-y-2">
        <label v-for="[key, field] in basic" :key="key" class="flex min-h-11 flex-wrap items-center justify-between gap-2 text-sm"><span>{{ field.label }}（{{ field.unit }}）</span><input :value="settings[key]" type="number" class="input input-sm w-28" :min="field.min" :max="field.max" :step="field.integer ? 1 : 0.01" :disabled="disabled" required @input="number(key, $event)" /></label>
      </div>
      <p class="text-xs text-base-content/65">目标 {{ settings.targetMbps }} Mbps，约 {{ (Number(settings.targetMbps) / 8).toFixed(2) }} MB/s；预算统计应用载荷，实际网络流量含协议开销。</p>
      <button type="button" class="btn btn-sm min-h-11" :disabled="disabled || !canCheck || checking || !!status?.testingNode" @click="check"><IconBrandSpeedtest :size="16" /><span>{{ checking ? '正在排队' : '检查吞吐' }}</span></button>
      <p v-if="!canCheck" class="text-xs text-base-content/65">保存组设置后可发起检查。</p>
      <p v-if="feedback" class="text-xs" role="status">{{ feedback }}</p>
      <details class="rounded-lg bg-base-200 p-3">
        <summary class="flex min-h-11 cursor-pointer items-center gap-2 text-sm"><IconAdjustments :size="16" /><span>高级参数 · 收益、成本和检测调度</span></summary>
        <p class="mb-2 text-xs text-base-content/65">损失 = 延迟秒数 + 吞吐不足重视程度 × max(0, 目标 / 有效吞吐 − 1)。达标吞吐封顶；使用近期保守区间，不表示统计学的95%置信区间。</p>
        <label v-for="[key, field] in advanced" :key="key" class="flex min-h-11 flex-wrap items-center justify-between gap-2 text-sm"><span>{{ field.label }}（{{ field.unit }}）</span><input :value="settings[key]" type="number" class="input input-sm w-28" :min="field.min" :max="field.max" :step="field.integer ? 1 : 0.01" :disabled="disabled" required @input="number(key, $event)" /></label>
        <button type="button" class="btn btn-sm mt-3 min-h-11" :disabled="disabled" @click="restore"><IconRestore :size="16" /><span>恢复推荐参数</span></button>
      </details>
      <p v-if="invalid" class="text-xs text-error" role="alert">{{ invalid }}</p>
      <div v-if="status" class="space-y-1 rounded-lg bg-base-200 p-3 text-xs" aria-live="polite">
        <p>{{ reasons[status.reason] ?? '等待下一轮观察' }}</p>
        <p v-if="status.testingNode" class="break-all">正在验证：{{ status.testingNode }}</p>
        <p v-if="status.candidate" class="break-all">候选：{{ status.candidate }} · 已完成 {{ status.round }} 轮</p>
        <p>载荷：本小时 {{ amount(status.hourBytes) }} / {{ amount(status.hourLimit) }} MiB；24小时 {{ amount(status.dayBytes) }} / {{ amount(status.dayLimit) }} MiB</p>
        <template v-if="status.decision">
          <p>当前损失 {{ loss(status.decision.current.low) }}～{{ loss(status.decision.current.high) }}；候选 {{ loss(status.decision.candidate.low) }}～{{ loss(status.decision.candidate.high) }}</p>
          <p>保守改善 {{ loss(status.decision.gain) }}；须超过 {{ loss(status.decision.threshold) }}（含成本 {{ loss(status.decision.cost) }}）</p>
        </template>
      </div>
    </template>
  </section>
</template>
