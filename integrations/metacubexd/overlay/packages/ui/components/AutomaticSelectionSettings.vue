<script setup lang="ts">
import { IconSettings, IconX } from '@tabler/icons-vue'
import type { AutomaticStatus, AutoGroupPolicy } from '~/composables/useWorkspace'
import { cocoproxyErrorMessage } from '~/composables/useCoCoProxy'

const props = defineProps<{ groupName: string; selectable: boolean }>()
const { api, view, overrides, busy, error, run, save, editOverrides } = useWorkspace()
const proxyRefresh = useProxyRefresh()
const dialog = ref<HTMLDialogElement>()
const enabled = ref(false)
const preferred = ref<string[]>([])
const fallback = ref<string[]>([])
const returnToPreferred = ref(true)
const search = ref('')
const visible = ref(false)
const statusError = ref('')
const status = ref<AutomaticStatus>()
let timer: ReturnType<typeof setTimeout> | undefined
let reading = false
let disposed = false
let session = 0

const nodes = computed(() => {
  const realNodes = new Set(view.value?.nodes ?? [])
  return [...new Set(view.value?.groups.find(group => group.name === props.groupName)?.options ?? [])]
    .filter(name => realNodes.has(name) && !/^(DIRECT|REJECT|REJECT-DROP|PASS|COMPATIBLE)$/i.test(name))
})
const visibleNodes = computed(() => nodes.value.filter(name => name.toLocaleLowerCase().includes(search.value.toLocaleLowerCase())))
const invalid = computed(() => {
  if (!enabled.value) return ''
  if (!preferred.value.length) return '请至少选择一个优选节点。'
  if (preferred.value.length + fallback.value.length > 32) return '优选和备选合计最多 32 个节点。'
  if ([...preferred.value, ...fallback.value].some(name => !nodes.value.includes(name))) return '部分节点已不在此组，请重新选择。'
  if (preferred.value.some(name => fallback.value.includes(name))) return '优选和备选不能包含同一个节点。'
  return ''
})
const groupStatus = computed(() => status.value?.groups.find(group => group.name === props.groupName))
const events = computed(() => status.value?.events.filter(event => event.group === props.groupName).slice(-5).reverse() ?? [])
const phases: Record<string, string> = {
  outage: '暂无已确认出口，退避重试', 'slow-search': '正在寻找更快的候选节点', 'failure-search': '正在寻找可用候选节点',
  'failure-confirmation': '正在复核当前节点', 'return-confirmation': '正在确认优选恢复', backup: '使用备选', monitoring: '监测当前节点',
}
const reasons: Record<string, string> = {
  'preferred-restored': '优选已恢复，完成回切', 'faster-candidate': '候选节点更快，完成切换', 'failure-recovery': '原节点故障，已切换至可用节点',
  'current-slow': '当前节点连续变慢', 'current-unavailable': '当前节点不可用', 'all-unavailable': '本轮未能确认可用出口',
  'no-better-candidate': '暂未找到明显更快的候选节点', 'preferred-check-failed': '优选尚未稳定恢复',
}
function reasonLabel(reason: string) { return reasons[reason] ?? '自动选择状态发生变化' }
function phaseLabel(phase: string) { return phases[phase] ?? '自动选择运行中' }
function timeLabel(at: number) { return new Date(at).toLocaleTimeString() }

async function readStatus() {
  if (reading || !visible.value || document.hidden) return
  const requestSession = session
  reading = true
  try {
    const result = await api.request<AutomaticStatus>('/api/cocoproxy/automatic/status')
    if (visible.value && !disposed && requestSession === session) { status.value = result; statusError.value = '' }
  } catch (cause) {
    if (visible.value && !disposed && requestSession === session) statusError.value = cocoproxyErrorMessage(cause)
  } finally { reading = false }
}
async function refreshStatus(requestSession: number) {
  await readStatus()
  if (visible.value && !disposed && requestSession === session) timer = setTimeout(() => { void refreshStatus(requestSession) }, 8000)
}
function close() {
  session++
  visible.value = false
  if (timer) clearTimeout(timer)
}
function open() {
  if (!props.selectable) return
  const policy = overrides.value.automatic?.[props.groupName]
  enabled.value = !!policy
  preferred.value = [...(policy?.preferred ?? [])]
  fallback.value = [...(policy?.fallback ?? [])]
  returnToPreferred.value = policy?.returnToPreferred ?? true
  search.value = ''
  statusError.value = ''
  status.value = view.value?.automatic
  visible.value = true
  dialog.value?.showModal()
  void refreshStatus(++session)
}
async function persist() {
  if (invalid.value || busy.value) return
  await run(async () => {
    const policy: AutoGroupPolicy = { preferred: [...preferred.value], fallback: [...fallback.value], returnToPreferred: returnToPreferred.value }
    await save(settings => {
      const target = editOverrides(settings)
      if (enabled.value) (target.automatic ??= {})[props.groupName] = policy
      else {
        if (target.automatic) delete target.automatic[props.groupName]
        const current = view.value?.groups.find(group => group.name === props.groupName)?.activeSelected
        if (current && nodes.value.includes(current)) target.selections[props.groupName] = current
      }
    }, enabled.value ? '自动选择已启用' : '已切换为手动选择')
    await proxyRefresh.refresh()
    dialog.value?.close()
  })
}
watch(() => props.groupName, () => { dialog.value?.close(); close() })
watch(() => `${view.value?.workspace.mode}:${view.value?.workspace.subscriptionId ?? ''}`, () => { dialog.value?.close(); close() })
onUnmounted(() => { disposed = true; close() })
</script>

<template>
  <span class="shrink-0" :title="selectable ? '自动选择设置' : '此订阅策略组保留核心自动算法，无法叠加自动选择'">
    <button type="button" class="btn btn-ghost btn-sm" :class="overrides.automatic?.[groupName] ? 'text-primary' : ''" :disabled="!selectable" :title="selectable ? '自动选择设置' : '此订阅策略组保留核心自动算法'" :aria-label="`${groupName} 自动选择设置`" @click="open"><IconSettings :size="18" /></button>
  </span>
  <dialog ref="dialog" class="modal" @close="close">
    <div class="modal-box max-w-2xl">
      <h2 class="mb-4 text-lg font-semibold">{{ groupName }} · 自动选择</h2>
      <form class="flex flex-col gap-4" @submit.prevent="persist">
        <label class="flex items-center justify-between gap-3">启用自动选择<input v-model="enabled" type="checkbox" class="toggle toggle-primary" :disabled="busy" /></label>
        <p class="text-xs leading-relaxed text-base-content/65">正常时每 30 秒检测当前节点；故障时按需检测候选节点并切换。优选不可用时使用备选；开启回切后按 5、10、15 分钟退避检测优选恢复。点击组内节点可随时接管为手动。</p>
        <template v-if="enabled">
          <input v-model="search" type="search" class="input input-sm w-full" placeholder="筛选候选节点" aria-label="筛选自动选择候选节点" />
          <div class="grid grid-cols-2 gap-3">
            <fieldset v-for="kind in (['preferred', 'fallback'] as const)" :key="kind" class="min-w-0 rounded-lg border border-base-content/10 p-2">
              <legend class="px-1 text-sm font-medium">{{ kind === 'preferred' ? '优选' : '备选' }}（{{ kind === 'preferred' ? preferred.length : fallback.length }}）</legend>
              <ul v-if="(kind === 'preferred' ? preferred : fallback).length" class="mb-2 space-y-1 border-b border-base-content/10 pb-2">
                <li v-for="name in (kind === 'preferred' ? preferred : fallback)" :key="name" class="flex items-start justify-between gap-1 text-xs"><span class="break-all" :class="!nodes.includes(name) ? 'text-warning' : ''">{{ name }}{{ !nodes.includes(name) ? '（已不可用）' : '' }}</span><button type="button" class="shrink-0 rounded p-0.5 hover:bg-base-content/10" :disabled="busy" :title="`移除 ${name}`" :aria-label="`从${kind === 'preferred' ? '优选' : '备选'}移除 ${name}`" @click="kind === 'preferred' ? preferred = preferred.filter(item => item !== name) : fallback = fallback.filter(item => item !== name)"><IconX :size="13" /></button></li>
              </ul>
              <div class="max-h-56 space-y-1 overflow-y-auto">
                <label v-for="name in visibleNodes" :key="name" class="flex items-start gap-2 rounded px-1 py-1 text-sm">
                  <input v-if="kind === 'preferred'" v-model="preferred" class="checkbox checkbox-primary checkbox-sm mt-0.5 shrink-0" type="checkbox" :value="name" :disabled="busy || fallback.includes(name) || (!preferred.includes(name) && preferred.length + fallback.length >= 32)" />
                  <input v-else v-model="fallback" class="checkbox checkbox-primary checkbox-sm mt-0.5 shrink-0" type="checkbox" :value="name" :disabled="busy || preferred.includes(name) || (!fallback.includes(name) && preferred.length + fallback.length >= 32)" />
                  <span class="break-all">{{ name }}</span>
                </label>
                <p v-if="!visibleNodes.length" class="p-2 text-xs text-base-content/50">没有可选的具体节点</p>
              </div>
            </fieldset>
          </div>
          <p class="text-xs text-base-content/55">仅可选择此组内的具体代理节点；优选与备选不重复，合计最多 32 个。</p>
          <label class="flex items-center justify-between gap-3 text-sm">优选恢复后自动回切<input v-model="returnToPreferred" type="checkbox" class="toggle toggle-primary" :disabled="busy" /></label>
        </template>
        <p v-if="invalid || error" role="alert" class="text-sm text-error">{{ invalid || error }}</p>
        <section v-if="groupStatus || events.length || statusError" class="space-y-2 rounded-lg bg-base-200 p-3 text-xs" aria-label="自动选择运行状态" aria-live="polite">
          <template v-if="groupStatus">
            <div>{{ phaseLabel(groupStatus.phase) }} · 当前：{{ groupStatus.current ?? '尚未选择' }}</div>
            <div v-if="groupStatus.reason">原因：{{ reasonLabel(groupStatus.reason) }}</div>
            <div>下次检测：{{ groupStatus.nextAt === null ? '等待调度' : timeLabel(groupStatus.nextAt) }}</div>
          </template>
          <p v-if="statusError" class="text-warning">状态读取失败：{{ statusError }}</p>
          <ol v-if="events.length" class="space-y-1 border-t border-base-content/10 pt-2" aria-label="最近切换记录"><li v-for="(event, index) in events" :key="`${event.at}:${index}`">{{ timeLabel(event.at) }} · {{ event.from ?? '未选择' }} → {{ event.to ?? '未选择' }} · {{ reasonLabel(event.reason) }}</li></ol>
        </section>
        <div class="modal-action mt-1"><button type="button" class="btn btn-ghost btn-sm" :disabled="busy" @click="dialog?.close()">取消</button><button type="submit" class="btn btn-primary btn-sm" :disabled="busy || !!invalid">{{ busy ? '正在保存…' : '保存' }}</button></div>
      </form>
    </div>
    <form method="dialog" class="modal-backdrop"><button aria-label="关闭自动选择设置">关闭</button></form>
  </dialog>
</template>
