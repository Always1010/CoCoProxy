<script setup lang="ts">
import { IconArrowLeft, IconCheck, IconChevronDown, IconChevronUp, IconEdit, IconInfoCircle, IconList, IconSettings, IconWorld, IconX } from '@tabler/icons-vue'
import type { AutomaticStatus, AutoGroupPolicy } from '~/composables/useWorkspace'
import { cocoproxyErrorMessage } from '~/composables/useCoCoProxy'
import GroupMatchingRules from '~/components/GroupMatchingRules.vue'

const props = defineProps<{ groupName: string; selectable: boolean }>()
const { api, view, workspace, overrides, busy, error, run, save, editOverrides } = useWorkspace()
const proxyRefresh = useProxyRefresh()
const dialog = ref<HTMLDialogElement>()
const enabled = ref(false)
const preferred = ref<string[]>([])
const fallback = ref<string[]>([])
const returnToPreferred = ref(true)
const search = ref('')
type PoolKind = 'preferred' | 'fallback'
const editorKind = ref<PoolKind | null>(null)
const onlySelected = ref(false)
const editorSelected = ref<string[]>([])
const expanded = ref({ preferred: false, fallback: false })
const initialDraft = ref('')
const visible = ref(false)
const tab = ref<'selection' | 'rules' | 'sites'>('selection')
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
const totalSelected = computed(() => preferred.value.length + fallback.value.length)
function draftSignature() { return JSON.stringify([enabled.value, preferred.value, fallback.value, returnToPreferred.value]) }
const changed = computed(() => draftSignature() !== initialDraft.value)
const editingPool = computed(() => editorKind.value === 'fallback' ? fallback.value : preferred.value)
const otherPool = computed(() => editorKind.value === 'fallback' ? preferred.value : fallback.value)
const editorLabel = computed(() => editorKind.value === 'fallback' ? '备选' : '优选')
const otherLabel = computed(() => editorKind.value === 'fallback' ? '优选' : '备选')
const visibleNodes = computed(() => {
  const candidates = [...new Set([...nodes.value, ...editingPool.value, ...otherPool.value])]
    .filter(name => name.toLocaleLowerCase().includes(search.value.toLocaleLowerCase()))
    .filter(name => !onlySelected.value || editingPool.value.includes(name) || editorSelected.value.includes(name))
  return [...candidates.filter(name => !otherPool.value.includes(name)), ...candidates.filter(name => otherPool.value.includes(name))]
})
function pool(kind: PoolKind) { return kind === 'preferred' ? preferred.value : fallback.value }
function editPool(kind: PoolKind) {
  editorKind.value = kind
  search.value = ''
  onlySelected.value = false
  editorSelected.value = [...pool(kind)]
}
function nodeDisabled(name: string) {
  return busy.value || otherPool.value.includes(name)
    || (!editingPool.value.includes(name) && (totalSelected.value >= 32 || !nodes.value.includes(name)))
}
function toggleNode(name: string) {
  if (!editorKind.value || nodeDisabled(name)) return
  const selected = pool(editorKind.value)
  const next = selected.includes(name) ? selected.filter(item => item !== name) : [...selected, name]
  if (editorKind.value === 'preferred') preferred.value = next
  else fallback.value = next
  if (!editorSelected.value.includes(name)) editorSelected.value.push(name)
}
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
  if (reading || !visible.value || document.hidden || tab.value !== 'selection' || !props.selectable) return
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
  tab.value = 'selection'
  editorKind.value = null
  expanded.value = { preferred: false, fallback: false }
  const policy = overrides.value.automatic?.[props.groupName]
  enabled.value = !!policy && policy.enabled !== false
  preferred.value = [...(policy?.preferred ?? [])]
  fallback.value = [...(policy?.fallback ?? [])]
  returnToPreferred.value = policy?.returnToPreferred ?? true
  initialDraft.value = draftSignature()
  search.value = ''
  statusError.value = ''
  status.value = view.value?.automatic
  visible.value = true
  dialog.value?.showModal()
  void refreshStatus(++session)
}
function openSites() { open(); tab.value = 'sites' }
function openRules() { open(); tab.value = 'rules' }
defineExpose({ open, openSites, openRules })
async function persist() {
  if (editorKind.value || invalid.value || busy.value) return
  await run(async () => {
    const policy: AutoGroupPolicy = { enabled: enabled.value, preferred: [...preferred.value], fallback: [...fallback.value], returnToPreferred: returnToPreferred.value }
    await save(settings => {
      const target = editOverrides(settings)
      if (enabled.value || target.automatic?.[props.groupName] || preferred.value.length || fallback.value.length) {
        (target.automatic ??= {})[props.groupName] = policy
      }
      if (!enabled.value) {
        const current = view.value?.groups.find(group => group.name === props.groupName)?.activeSelected
        if (current && nodes.value.includes(current)) target.selections[props.groupName] = current
      }
    }, enabled.value ? '自动选择已启用' : '已切换为手动选择')
    await proxyRefresh.refresh()
    initialDraft.value = draftSignature()
  })
}
watch(() => props.groupName, () => { dialog.value?.close(); close() })
watch(() => JSON.stringify([view.value?.workspace.mode, view.value?.workspace.subscriptionId, view.value?.workspace.sourceIds]), () => { dialog.value?.close(); close() })
onUnmounted(() => { disposed = true; close() })
</script>

<template>
  <span class="shrink-0">
    <button type="button" class="btn btn-ghost btn-sm" :aria-label="`${groupName} 组设置`" @click="open"><IconSettings :size="18" /><span>组设置</span></button>
  </span>
  <dialog ref="dialog" class="modal modal-bottom sm:modal-middle" @close="close">
    <div class="modal-box flex max-h-[90dvh] max-w-2xl flex-col overflow-hidden">
      <div class="mb-3 flex shrink-0 items-center justify-between gap-2">
        <template v-if="editorKind">
          <button type="button" class="btn btn-ghost min-h-11 shrink-0" @click="editorKind = null"><IconArrowLeft :size="16" /><span>返回</span></button>
          <h2 class="text-lg font-semibold">编辑{{ editorLabel }}</h2>
        </template>
        <template v-else>
          <h2 class="min-w-0 break-all text-lg font-semibold">{{ groupName }} · 组设置</h2>
          <button type="button" class="btn btn-ghost min-h-11 shrink-0" @click="dialog?.close()"><IconX :size="16" /><span>关闭</span></button>
        </template>
      </div>
      <div v-if="!editorKind" class="mb-4 flex shrink-0 flex-wrap gap-2" role="tablist" aria-label="组设置类别">
        <button type="button" role="tab" class="btn btn-sm min-h-11" :class="tab === 'selection' ? 'btn-primary' : 'btn-ghost'" :aria-selected="tab === 'selection'" @click="tab = 'selection'"><IconList :size="16" /><span>节点选择</span></button>
        <button v-if="workspace?.mode === 'local'" type="button" role="tab" class="btn btn-sm min-h-11" :class="tab === 'rules' ? 'btn-primary' : 'btn-ghost'" :aria-selected="tab === 'rules'" @click="tab = 'rules'"><IconList :size="16" /><span>匹配规则</span></button>
        <button type="button" role="tab" class="btn btn-sm min-h-11" :class="tab === 'sites' ? 'btn-primary' : 'btn-ghost'" :aria-selected="tab === 'sites'" @click="tab = 'sites'"><IconWorld :size="16" /><span>站点连通</span></button>
      </div>
      <GroupMatchingRules v-if="visible && workspace?.mode === 'local'" v-show="tab === 'rules'" :group-name="groupName" @close="dialog?.close()" />
      <div v-if="visible && tab === 'sites'" class="min-h-0 overflow-y-auto"><SiteTargetSettings :group-name="groupName" /></div>
      <p v-if="tab === 'selection' && !selectable" class="text-sm text-base-content/65">此组保留核心的 {{ view?.groups.find(group => group.name === groupName)?.type }} 自动算法，不能叠加自动选点；仍可配置站点连通检测。</p>
      <form v-if="tab === 'selection' && selectable" class="flex min-h-0 flex-1 flex-col gap-4" @submit.prevent="persist">
        <template v-if="!editorKind">
          <div class="min-h-0 space-y-4 overflow-y-auto">
            <label class="flex min-h-11 items-center justify-between gap-3">自动选点<input v-model="enabled" type="checkbox" class="toggle toggle-primary" :disabled="busy" /></label>
            <template v-if="enabled">
              <label class="flex min-h-11 items-center justify-between gap-3 text-sm">优选恢复后自动回切<input v-model="returnToPreferred" type="checkbox" class="toggle toggle-primary" :disabled="busy" /></label>
              <section v-for="kind in (['preferred', 'fallback'] as const)" :key="kind" class="rounded-lg border border-base-content/10 p-3" :aria-label="kind === 'preferred' ? '优选节点' : '备选节点'">
                <div class="flex items-center justify-between gap-2">
                  <h3 class="text-sm font-medium">{{ kind === 'preferred' ? '优选' : '备选' }} · {{ pool(kind).length }} 个</h3>
                  <button type="button" class="btn btn-ghost btn-sm min-h-11 shrink-0" :disabled="busy" @click="editPool(kind)"><IconEdit :size="16" /><span>编辑{{ kind === 'preferred' ? '优选' : '备选' }}</span></button>
                </div>
                <p class="mb-2 text-xs text-base-content/60">{{ kind === 'preferred' ? '优先使用这些节点' : '优选不可用时使用' }}</p>
                <ul v-if="pool(kind).length" class="grid grid-cols-2 gap-2 sm:grid-cols-3">
                  <li v-for="name in (expanded[kind] ? pool(kind) : pool(kind).slice(0, 6))" :key="name" class="min-w-0 break-all rounded bg-base-200 px-2 py-2 text-xs" :class="!nodes.includes(name) ? 'text-warning' : ''">{{ name }}{{ !nodes.includes(name) ? '（已不在此组）' : '' }}</li>
                </ul>
                <p v-else class="py-2 text-sm text-base-content/50">尚未设置{{ kind === 'preferred' ? '优选' : '备选' }}节点</p>
                <button v-if="pool(kind).length > 6" type="button" class="btn btn-ghost btn-sm mt-2 min-h-11 w-full" :aria-expanded="expanded[kind]" @click="expanded[kind] = !expanded[kind]">
                  <IconChevronUp v-if="expanded[kind]" :size="16" /><IconChevronDown v-else :size="16" />
                  <span>{{ expanded[kind] ? '收起' : `展开其余 ${pool(kind).length - 6} 个` }}{{ kind === 'preferred' ? '优选' : '备选' }}节点</span>
                </button>
              </section>
              <p class="text-xs text-base-content/60">已选 {{ totalSelected }} / 32 个节点；至少选择 1 个优选节点。</p>
            </template>
            <p v-else class="text-xs text-base-content/60">当前为手动选择；已保留优选、备选和回切设置。</p>
            <p v-if="changed" class="text-xs text-warning">有未保存修改</p>
            <p v-if="invalid || error" role="alert" class="text-sm text-error">{{ invalid || error }}</p>
            <section v-if="groupStatus || events.length || statusError" class="space-y-2 rounded-lg bg-base-200 p-3 text-xs" aria-label="自动选择运行状态" aria-live="polite">
              <template v-if="groupStatus">
                <div>{{ phaseLabel(groupStatus.phase) }} · 当前：{{ groupStatus.current ?? '尚未选择' }}</div>
                <div v-if="groupStatus.reason">原因：{{ reasonLabel(groupStatus.reason) }}</div>
                <div>下次检测：{{ groupStatus.nextAt === null ? '等待调度' : timeLabel(groupStatus.nextAt) }}</div>
              </template>
              <p v-if="statusError" class="text-warning">状态读取失败：{{ statusError }}</p>
              <details v-if="events.length">
                <summary class="flex min-h-11 cursor-pointer list-none items-center gap-2"><IconList :size="16" /><span>最近切换记录</span><IconChevronDown :size="14" /></summary>
                <ol class="space-y-1 border-t border-base-content/10 pt-2" aria-label="最近切换记录"><li v-for="(event, index) in events" :key="`${event.at}:${index}`">{{ timeLabel(event.at) }} · {{ event.from ?? '未选择' }} → {{ event.to ?? '未选择' }} · {{ reasonLabel(event.reason) }}</li></ol>
              </details>
            </section>
            <details class="text-xs text-base-content/65">
              <summary class="flex min-h-11 cursor-pointer list-none items-center gap-2"><IconInfoCircle :size="16" /><span>运行规则</span><IconChevronDown :size="14" /></summary>
              <p class="leading-relaxed">开启后按检测结果自动选择节点；关闭后手动选择。正常时每 30 秒检测当前节点，故障时按需检测候选节点。优选不可用时使用备选；开启回切后按 5、10、15 分钟退避检测优选恢复。停用后保留候选和回切设置。此处的自动选点独立于手动站点连通检测。仅可选择此组内的具体代理节点；优选与备选不重复，合计最多 32 个。</p>
            </details>
          </div>
          <div class="modal-action mt-0 shrink-0"><button type="button" class="btn btn-ghost min-h-11" :disabled="busy" @click="dialog?.close()"><IconX :size="16" /><span>取消</span></button><button type="submit" class="btn btn-primary min-h-11" :disabled="busy || !!invalid"><IconCheck :size="16" /><span>{{ busy ? '正在保存…' : '保存节点设置' }}</span></button></div>
        </template>
        <template v-else>
          <p class="shrink-0 text-xs leading-relaxed text-base-content/65">勾选加入{{ editorLabel }}，取消勾选移出。修改暂存，返回组设置后点击“保存”生效。已在{{ otherLabel }}中的节点置灰并排在末尾，需先从{{ otherLabel }}移除后才能选择。</p>
          <input v-model="search" type="search" class="input min-h-11 w-full shrink-0" placeholder="搜索节点名称" :aria-label="`搜索${editorLabel}候选节点`" />
          <div class="flex shrink-0 gap-2" role="group" aria-label="节点筛选">
            <button type="button" class="btn btn-sm min-h-11" :class="!onlySelected ? 'btn-primary' : 'btn-ghost'" :aria-pressed="!onlySelected" @click="onlySelected = false"><IconList :size="16" /><span>全部节点</span></button>
            <button type="button" class="btn btn-sm min-h-11" :class="onlySelected ? 'btn-primary' : 'btn-ghost'" :aria-pressed="onlySelected" @click="onlySelected = true"><IconCheck :size="16" /><span>仅看已选 {{ editingPool.length }}</span></button>
          </div>
          <p v-if="totalSelected >= 32" class="shrink-0 text-xs text-warning">已达 32 个上限，请先取消已有选择再添加节点。</p>
          <div class="min-h-0 flex-1 space-y-1 overflow-y-auto" :aria-label="`${editorLabel}节点编辑列表`">
            <label v-for="name in visibleNodes" :key="name" class="flex min-h-11 items-center gap-3 rounded-lg px-2 py-3 text-sm" :class="nodeDisabled(name) ? 'cursor-not-allowed bg-base-200 text-base-content/40' : 'cursor-pointer hover:bg-base-200'">
              <input type="checkbox" class="checkbox checkbox-primary checkbox-sm shrink-0" :checked="editingPool.includes(name)" :disabled="nodeDisabled(name)" :aria-label="`${editorLabel}：${name}`" @change="toggleNode(name)" />
              <span class="min-w-0 break-all">
                {{ name }}
                <span v-if="otherPool.includes(name)" class="mt-1 block text-xs">已在{{ otherLabel }}中，不可选择</span>
                <span v-else-if="!nodes.includes(name)" class="mt-1 block text-xs text-warning">已不在此组，请取消选择</span>
              </span>
            </label>
            <p v-if="!visibleNodes.length" class="p-3 text-sm text-base-content/50">{{ search ? '没有匹配的节点' : onlySelected ? '尚未选择节点' : '没有可选的具体节点' }}</p>
          </div>
          <div class="flex shrink-0 flex-wrap justify-between gap-2 border-t border-base-content/10 pt-3 text-xs text-base-content/65" aria-live="polite"><span>{{ editorLabel }} {{ editingPool.length }} 个</span><span>合计已选 {{ totalSelected }} / 32</span></div>
        </template>
      </form>
    </div>
    <form method="dialog" class="modal-backdrop"><button aria-label="关闭自动选择设置">关闭</button></form>
  </dialog>
</template>
