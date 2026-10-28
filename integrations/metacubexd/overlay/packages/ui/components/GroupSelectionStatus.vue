<script setup lang="ts">
import { IconArrowLeft, IconBrandSpeedtest, IconChevronRight, IconList, IconRefresh } from '@tabler/icons-vue'
import type { AutomaticStatus, BandwidthSettings } from '~/composables/useWorkspace'
import { cocoproxyErrorMessage } from '~/composables/useCoCoProxy'

const props = defineProps<{ groupName: string; status?: AutomaticStatus; policyEnabled: boolean; bandwidth?: BandwidthSettings; dirty: boolean; disabled: boolean; reading: boolean; error: string }>()
const emit = defineEmits<{ refresh: [] }>()
const { api, view } = useWorkspace()
const detail = ref<'summary' | 'pool' | 'history'>('summary')
const checking = ref(false)
const feedback = ref('')
const group = computed(() => props.status?.groups.find(item => item.name === props.groupName))
const bandwidthStatus = computed(() => group.value?.bandwidth)
const events = computed(() => props.status?.events.filter(event => event.group === props.groupName).slice().reverse() ?? [])
const canCheck = computed(() => props.policyEnabled && !!props.bandwidth?.enabled && !props.dirty && !props.disabled && !props.reading && !props.error && !!group.value && !!view.value?.active && !view.value?.pending && !props.status?.paused && !props.status?.suspended && !props.status?.error && !bandwidthStatus.value?.testingNode && !checking.value)
let disposed = false
onUnmounted(() => { disposed = true })
const phases: Record<string, string> = {
  outage: '暂无已确认出口，退避重试', 'slow-search': '正在寻找更快的候选节点', 'failure-search': '正在寻找可用候选节点',
  'failure-confirmation': '正在复核当前节点', 'return-confirmation': '正在确认优选恢复', backup: '使用备选', monitoring: '监测当前节点',
}
const reasons: Record<string, string> = {
  'waiting-traffic': '等待持续低速业务证据', 'waiting-idle': '等待业务空闲或测速名额', 'budget-exhausted': '自动检测预算不足，保持当前节点',
  'measurement-unavailable': '下载验证服务不可用，无法比较节点吞吐', collecting: '正在补充当前或候选节点的有效样本', 'current-sufficient': '当前延迟正常且吞吐达标，暂停同类低速排查',
  'no-candidate': '没有可比较的候选', 'candidate-unavailable': '候选未通过轻量检查', 'sample-unknown': '样本无效或不足，不给节点降级',
  'no-clear-gain': '扣除波动和成本后改善不足，保持当前节点', 'would-switch': '观察模式：已达到切换条件，未执行切换',
  'bandwidth-improvement': '已确认净收益并完成吞吐性能切换', 'switch-limit': '保持时间或近期切换上限尚未解除',
  'latency-priority': '延迟检测或故障恢复优先，候选池等待继续', 'latency-pressure': '响应延迟上升，已停止下载验证',
  'business-busy': '业务流量增加，已停止下载验证', 'evidence-timeout': '未在时限内收齐证据', 'configuration-changed': '配置或运行代次变化，旧证据失效',
  'selection-conflict': '切换前状态已变化，未执行', 'storage-unavailable': '预算账本不可用，已停止自动下载',
  'screening-latency': '正在轻量筛选候选延迟', 'waiting-sample': '复用已有证据，等待下一次有效采样',
  'search-yield': '连续搜索额度或时间已到，暂时让出资源并保留进度', 'pool-backoff': '候选暂时无足够收益，等待最早到期节点复查',
  'no-potential-gain': '即使吞吐达标也缺少足够收益，省略下载验证', 'shortfall-guard': '候选会引入或扩大明显短板，继续其他节点',
  'post-switch-failure': '切换后短期故障，延长该节点退避', 'waiting-evidence': '等待新鲜证据', 'evidence-ready': '已取得有效证据',
  'preferred-restored': '优选已恢复，完成回切', 'faster-candidate': '候选节点更快，完成切换', 'failure-recovery': '原节点故障，已切换至可用节点',
  'current-slow': '当前节点连续变慢', 'current-unavailable': '当前节点不可用', 'all-unavailable': '本轮未能确认可用出口',
  'no-better-candidate': '暂未找到明显更快的候选节点', 'preferred-check-failed': '优选尚未稳定恢复',
}
const states: Record<string, string> = { pending: '待验证', confirming: '待确认', verified: '已验证', backoff: '退避', unavailable: '不可用' }
const amount = (bytes: number) => (bytes / 1048576).toFixed(1)
const loss = (value: number) => `${value.toFixed(3)} 分`
const time = (value: number) => new Date(value).toLocaleTimeString()
const reason = (value: string) => reasons[value] ?? '等待下一轮评估'
async function check() {
  if (!canCheck.value || !view.value) return
  checking.value = true; feedback.value = ''
  try {
    await api.request('/api/cocoproxy/automatic/bandwidth/check', { method: 'POST', body: {
      expectedRevision: view.value.workspace.revision, expectedActive: view.value.active,
      scope: props.status?.scope, group: props.groupName,
    } })
    if (!disposed) { feedback.value = '本组候选检查已排队，仍遵守退避、空闲、流量预算和切换保持限制。'; emit('refresh') }
  } catch (cause) { if (!disposed) feedback.value = cocoproxyErrorMessage(cause) }
  finally { if (!disposed) checking.value = false }
}
</script>

<template>
  <section class="space-y-4" aria-label="自动选择运行状态">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <button v-if="detail !== 'summary'" type="button" class="btn btn-ghost min-h-11" @click="detail = 'summary'"><IconArrowLeft :size="16" /><span>返回运行概况</span></button>
      <SettingsNotice v-else>对应已保存并生效的配置</SettingsNotice>
      <button type="button" class="btn btn-ghost min-h-11" :disabled="reading || disabled" @click="emit('refresh')"><IconRefresh :size="16" :class="{ 'animate-spin': reading }" /><span>{{ reading ? '正在刷新' : '刷新状态' }}</span></button>
    </div>
    <p v-if="error" role="alert" class="text-sm text-warning">状态读取失败：{{ error }}。保留上次结果，请刷新后再检查候选。</p>
    <p v-if="status?.error || status?.paused || status?.suspended" role="status" class="text-sm text-warning">{{ status?.error || (status?.suspended ? '自动选择已挂起' : '自动选择已暂停') }}</p>
    <template v-if="detail === 'summary'">
      <dl class="status-facts text-sm">
        <dt>当前出口</dt><dd class="break-all">{{ group?.current ?? view?.groups.find(item => item.name === groupName)?.activeSelected ?? '尚未选择' }}</dd>
        <dt>自动选择</dt><dd>{{ !policyEnabled ? '已关闭' : group ? (phases[group.phase] ?? '自动选择运行中') : '等待运行状态' }}</dd>
        <template v-if="group?.reason"><dt>当前原因</dt><dd>{{ reason(group.reason) }}</dd></template>
        <template v-if="group?.nextAt"><dt>下次检测</dt><dd>{{ time(group.nextAt) }}</dd></template>
        <dt>带宽判断</dt><dd>{{ !bandwidth?.enabled ? '已关闭' : !policyEnabled ? '自动选择关闭，未运行' : bandwidthStatus ? reason(bandwidthStatus.reason) : '等待运行状态' }}{{ bandwidth?.enabled && bandwidth.observeOnly ? ' · 仅观察' : '' }}</dd>
      </dl>
      <div v-if="bandwidthStatus?.testingNode" class="flex items-start gap-2 text-sm" role="status"><span class="loading loading-spinner loading-sm shrink-0" /><span class="break-all">正在验证：{{ bandwidthStatus.testingNode }} · 有效样本 {{ bandwidthStatus.round }} / {{ bandwidth?.confirmRounds }}</span></div>
      <div v-if="bandwidthStatus" class="space-y-2 border-t border-base-content/10 pt-4 text-sm">
        <h4 class="font-medium">自动检测用量</h4>
        <p>滚动每小时 {{ amount(bandwidthStatus.hourBytes) }} / {{ amount(bandwidthStatus.hourLimit) }} MiB</p>
        <p>滚动 24 小时 {{ amount(bandwidthStatus.dayBytes) }} / {{ amount(bandwidthStatus.dayLimit) }} MiB</p>
        <p v-if="bandwidthStatus.hourReserve !== undefined && bandwidthStatus.dayReserve !== undefined" class="text-xs text-base-content/65">总额内预留：每小时 {{ amount(bandwidthStatus.hourReserve) }} MiB / 24 小时 {{ amount(bandwidthStatus.dayReserve) }} MiB；{{ bandwidthStatus.urgent ? '已确认劣化，可使用预留' : '普通探索保留应急额度' }}</p>
      </div>
      <div v-if="bandwidth?.enabled" class="space-y-2">
        <button type="button" class="btn btn-outline min-h-11" :disabled="!canCheck" @click="check"><span v-if="checking" class="loading loading-spinner loading-xs" /><IconBrandSpeedtest v-else :size="16" /><span>{{ checking ? '正在排队' : '检查本组候选' }}</span></button>
        <SettingsNotice>{{ dirty ? '保存自动选择设置后可检查。' : !policyEnabled ? '开启并保存自动选择后可检查。' : '检查仍遵守业务空闲、流量预算和节点退避限制，不保证立即检测或切换。' }}</SettingsNotice>
        <p v-if="feedback" role="status" class="text-sm">{{ feedback }}</p>
      </div>
      <div class="flex flex-col gap-2 border-t border-base-content/10 pt-3">
        <button type="button" class="btn btn-ghost min-h-11 justify-between" @click="detail = 'pool'"><span class="flex items-center gap-2"><IconList :size="16" />候选详情 · {{ bandwidthStatus?.pool?.length ?? 0 }} 个</span><IconChevronRight :size="16" /></button>
        <button type="button" class="btn btn-ghost min-h-11 justify-between" @click="detail = 'history'"><span class="flex items-center gap-2"><IconList :size="16" />最近切换 · {{ events.length }} 条</span><IconChevronRight :size="16" /></button>
      </div>
    </template>
    <template v-else-if="detail === 'pool'">
      <h3 class="text-sm font-semibold">候选详情</h3>
      <p v-if="!bandwidthStatus?.pool?.length" class="text-sm text-base-content/60">暂无带宽候选检测记录。</p>
      <div v-if="bandwidthStatus?.decision" class="space-y-1 text-xs text-base-content/70">
        <p>当前损失 {{ loss(bandwidthStatus.decision.current.low) }}～{{ loss(bandwidthStatus.decision.current.high) }}；候选 {{ loss(bandwidthStatus.decision.candidate.low) }}～{{ loss(bandwidthStatus.decision.candidate.high) }}</p>
        <p>保守改善 {{ loss(bandwidthStatus.decision.gain) }}；须超过 {{ loss(bandwidthStatus.decision.threshold) }}（含成本 {{ loss(bandwidthStatus.decision.cost) }}）</p>
        <p v-if="bandwidthStatus.decision.uncertainty">已扣除陌生候选风险 {{ loss(bandwidthStatus.decision.uncertainty) }}</p>
        <p v-if="bandwidthStatus.decision.guard === false">候选未通过相对短板保护。</p>
      </div>
      <p v-if="bandwidthStatus?.searchBytes !== undefined && bandwidthStatus.searchLimit !== undefined" class="text-xs">本段搜索 {{ amount(bandwidthStatus.searchBytes) }} / {{ amount(bandwidthStatus.searchLimit) }} MiB</p>
      <p v-if="bandwidthStatus?.nextAt" class="text-xs">下次评估：{{ time(bandwidthStatus.nextAt) }}</p>
      <ul class="space-y-4">
        <li v-for="node in bandwidthStatus?.pool" :key="node.name" class="space-y-1 border-b border-base-content/10 pb-3 text-xs">
          <p class="break-all text-sm font-medium">{{ node.name }} · {{ node.preferred ? '优选' : '备选' }}{{ node.current ? ' · 当前' : node.active ? ' · 本次候选' : '' }}</p>
          <p>{{ states[node.state] ?? node.state }} · 有效样本 {{ node.samples }} / {{ bandwidth?.confirmRounds }}</p>
          <p>{{ reason(node.reason) }}</p>
          <p>延迟 {{ node.delayMs === null ? '未知' : node.delayMs + ' ms' }}；有效吞吐 {{ node.mbps === null ? '未知' : node.mbps.toFixed(2) + ' Mbps' }}</p>
          <p v-if="node.measuredAt !== null">样本时间 {{ time(node.measuredAt) }}</p>
          <p v-if="node.nextAt > 0">复查时间 {{ time(node.nextAt) }}</p>
        </li>
      </ul>
    </template>
    <template v-else>
      <h3 class="text-sm font-semibold">最近切换</h3>
      <p v-if="!events.length" class="text-sm text-base-content/60">暂无本组切换记录。</p>
      <ol class="space-y-4"><li v-for="(event, index) in events" :key="event.id ?? index" class="space-y-1 border-b border-base-content/10 pb-3 text-xs"><p>{{ time(event.at) }}</p><p class="break-all">{{ event.from ?? '未选择' }} → {{ event.to ?? '未选择' }}</p><p>{{ reason(event.reason) }}</p></li></ol>
    </template>
  </section>
</template>

<style scoped>
.status-facts { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 12px 16px; }
.status-facts dt { opacity: .6; }
</style>
