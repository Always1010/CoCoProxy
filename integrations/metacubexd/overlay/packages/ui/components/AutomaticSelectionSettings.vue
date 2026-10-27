<script setup lang="ts">
import { IconArrowLeft, IconCheck, IconChevronDown, IconChevronUp, IconEdit, IconInfoCircle, IconList, IconReload, IconSettings, IconWorld, IconX } from '@tabler/icons-vue'
import type { AutomaticStatus, AutoGroupPolicy } from '~/composables/useWorkspace'
import { CoCoProxyError, cocoproxyErrorMessage } from '~/composables/useCoCoProxy'
import GroupMatchingRules from '~/components/GroupMatchingRules.vue'

const props = defineProps<{ groupName: string; selectable: boolean }>()
const { api, view, workspace, overrides, busy, run, save, load, editOverrides } = useWorkspace()
const proxyRefresh = useProxyRefresh()
const dialog = ref<{ open: () => void; close: (force?: boolean) => void }>()
const rulesEditor = ref<{ dirty: boolean; saving: boolean }>()
const sitesEditor = ref<{ dirty: boolean; saving: boolean }>()
const sitesVisited = ref(false)
const confirmClose = ref(false)
type Destination = { path: string; query: Record<string, string> }
const destination = ref<Destination>()
const saving = ref(false)
const saved = ref(false)
const saveError = ref('')
const refreshWarning = ref('')
const needsRead = ref(false)
const locked = computed(() => busy.value || saving.value || !!rulesEditor.value?.saving || !!sitesEditor.value?.saving)
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
const dirtyTabs = computed(() => [
  changed.value && props.selectable ? '节点选择' : '',
  rulesEditor.value?.dirty ? '匹配规则' : '',
  sitesEditor.value?.dirty ? '站点连通' : '',
].filter(Boolean))
function beforeClose() {
  if (locked.value) return false
  if (!dirtyTabs.value.length) return true
  confirmClose.value = true
  return false
}
function continueEditing() { confirmClose.value = false; destination.value = undefined }
function discardAndClose() {
  if (locked.value) return
  const target = destination.value
  confirmClose.value = false
  dialog.value?.close(true)
  if (target) void navigateTo(target)
}
function requestNavigation(target: Destination) {
  if (locked.value) return
  destination.value = target
  if (beforeClose()) discardAndClose()
}
function selectTab(value: 'selection' | 'rules' | 'sites') {
  if (locked.value) return
  tab.value = value
  if (value === 'sites') sitesVisited.value = true
}
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
  if (locked.value) return
  editorKind.value = kind
  search.value = ''
  onlySelected.value = false
  editorSelected.value = [...pool(kind)]
}
function nodeDisabled(name: string) {
  return locked.value || otherPool.value.includes(name)
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
  confirmClose.value = false
  destination.value = undefined
  sitesVisited.value = false
  saved.value = false
  saveError.value = ''
  refreshWarning.value = ''
  needsRead.value = false
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
  dialog.value?.open()
  void refreshStatus(++session)
}
function openSites() { open(); selectTab('sites') }
function openRules() { open(); selectTab('rules') }
defineExpose({ open, openSites, openRules })
async function persist() {
  if (editorKind.value || invalid.value || locked.value || !changed.value || needsRead.value) return
  saving.value = true
  saveError.value = ''; refreshWarning.value = ''
  try {
    await run(async () => {
      try {
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
        }, '节点设置已保存并生效')
        initialDraft.value = draftSignature()
        saved.value = true
      } catch (cause) {
        saveError.value = cocoproxyErrorMessage(cause)
        needsRead.value = cause instanceof CoCoProxyError && ['NETWORK_UNKNOWN', 'MANAGEMENT_UNAVAILABLE', 'CONFIRM_FAILED', 'WORKSPACE_CONFLICT'].includes(cause.code)
        return
      }
      try {
        await proxyRefresh.refresh()
        if (proxyRefresh.error.value) refreshWarning.value = '节点设置已生效，列表刷新失败。'
      } catch { refreshWarning.value = '节点设置已生效，列表刷新失败。' }
    })
  } finally { saving.value = false }
}
async function reread() {
  if (locked.value) return
  saving.value = true
  try {
    await load()
    const policy = overrides.value.automatic?.[props.groupName]
    const current = JSON.stringify([!!policy && policy.enabled !== false, policy?.preferred ?? [], policy?.fallback ?? [], policy?.returnToPreferred ?? true])
    if (current === draftSignature() && !view.value?.pending) {
      initialDraft.value = current; saved.value = true; saveError.value = ''
    } else saveError.value = '状态已重新读取，修改尚未确认生效，请核对后重试。'
    needsRead.value = false
  } catch (cause) { saveError.value = cocoproxyErrorMessage(cause) }
  finally { saving.value = false }
}
watch(draftSignature, () => { saveError.value = ''; refreshWarning.value = '' })
watch(() => props.groupName, () => { dialog.value?.close(true); close() })
watch(() => JSON.stringify([view.value?.workspace.mode, view.value?.workspace.subscriptionId, view.value?.workspace.sourceIds]), () => { dialog.value?.close(true); close() })
onUnmounted(() => { disposed = true; close() })
</script>

<template>
  <span class="shrink-0">
    <button type="button" class="btn btn-ghost btn-sm" :aria-label="`${groupName} 组设置`" @click="open"><IconSettings :size="18" /><span>组设置</span></button>
  </span>
  <Modal ref="dialog" :title="editorKind ? `编辑${editorLabel}` : `${groupName} · 组设置`" :before-close="beforeClose" :close-disabled="locked" @close="close">
    <template #tabs>
      <button v-if="editorKind" type="button" class="btn btn-ghost min-h-11" :disabled="locked || confirmClose" @click="editorKind = null"><IconArrowLeft :size="16" /><span>返回组设置</span></button>
      <div v-else class="flex flex-wrap gap-2" role="tablist" aria-label="组设置类别">
        <button type="button" role="tab" class="btn btn-sm min-h-11" :disabled="locked || confirmClose" :class="tab === 'selection' ? 'btn-primary' : 'btn-ghost'" :aria-selected="tab === 'selection'" @click="selectTab('selection')"><IconList :size="16" /><span>节点选择</span></button>
        <button v-if="workspace?.mode === 'local'" type="button" role="tab" class="btn btn-sm min-h-11" :disabled="locked || confirmClose" :class="tab === 'rules' ? 'btn-primary' : 'btn-ghost'" :aria-selected="tab === 'rules'" @click="selectTab('rules')"><IconList :size="16" /><span>匹配规则</span></button>
        <button type="button" role="tab" class="btn btn-sm min-h-11" :disabled="locked || confirmClose" :class="tab === 'sites' ? 'btn-primary' : 'btn-ghost'" :aria-selected="tab === 'sites'" @click="selectTab('sites')"><IconWorld :size="16" /><span>站点连通</span></button>
      </div>
    </template>
    <template #content>
      <div v-if="confirmClose" role="alertdialog" aria-label="放弃未保存修改" class="flex min-h-0 flex-1 flex-col justify-center gap-4">
        <p class="text-sm">{{ dirtyTabs.join('、') }}有未保存修改，{{ destination ? '离开' : '关闭' }}将丢弃这些修改。已成功保存的设置不受影响。</p>
        <div class="flex flex-wrap justify-end gap-2"><button type="button" class="btn btn-ghost min-h-11" @click="continueEditing"><IconArrowLeft :size="16" /><span>继续编辑</span></button><button type="button" class="btn btn-error min-h-11" @click="discardAndClose"><IconX :size="16" /><span>{{ destination ? '放弃并离开' : '放弃并关闭' }}</span></button></div>
      </div>
      <GroupMatchingRules v-if="visible && workspace?.mode === 'local'" ref="rulesEditor" v-show="tab === 'rules' && !confirmClose" :group-name="groupName" @navigate="requestNavigation" />
      <SiteTargetSettings v-if="visible && sitesVisited" ref="sitesEditor" v-show="tab === 'sites' && !confirmClose" :group-name="groupName" :scroll-list="false" />
      <p v-if="tab === 'selection' && !selectable && !confirmClose" class="min-h-0 overflow-y-auto text-sm text-base-content/65">此组保留核心的 {{ view?.groups.find(group => group.name === groupName)?.type }} 自动算法，不能叠加自动选点；仍可配置站点连通检测。</p>
      <form v-if="tab === 'selection' && selectable" v-show="!confirmClose" class="flex min-h-0 flex-1 flex-col gap-4" :class="{ 'pool-editor': editorKind }" @submit.prevent="persist">
        <template v-if="!editorKind">
          <div class="min-h-0 flex-1 space-y-4 overflow-y-auto [scrollbar-gutter:stable]">
            <label class="flex min-h-11 items-center justify-between gap-3">自动选点<input v-model="enabled" type="checkbox" class="toggle toggle-primary" :disabled="locked" /></label>
            <template v-if="enabled">
              <label class="flex min-h-11 items-center justify-between gap-3 text-sm">优选恢复后自动回切<input v-model="returnToPreferred" type="checkbox" class="toggle toggle-primary" :disabled="locked" /></label>
              <section v-for="kind in (['preferred', 'fallback'] as const)" :key="kind" class="rounded-lg border border-base-content/10 p-3" :aria-label="kind === 'preferred' ? '优选节点' : '备选节点'">
                <div class="flex items-center justify-between gap-2">
                  <h3 class="text-sm font-medium">{{ kind === 'preferred' ? '优选' : '备选' }} · {{ pool(kind).length }} 个</h3>
                  <button type="button" class="btn btn-ghost btn-sm min-h-11 shrink-0" :disabled="locked" @click="editPool(kind)"><IconEdit :size="16" /><span>编辑{{ kind === 'preferred' ? '优选' : '备选' }}</span></button>
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
          <div class="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-base-content/10 pt-3">
            <div class="min-w-0 flex-1 basis-40 text-sm" aria-live="polite">
              <p v-if="saving" role="status">正在保存或核对节点设置…</p>
              <p v-else-if="saveError || needsRead || invalid" role="alert" class="text-error">{{ saveError || (needsRead ? '暂未确认节点设置是否生效。' : invalid) }}{{ needsRead ? ' 请重新读取状态后核对。' : '' }}</p>
              <p v-else-if="changed" class="text-warning">有未保存修改</p>
              <p v-else-if="saved" role="status" class="flex items-center gap-1" :class="refreshWarning ? 'text-warning' : 'text-success'"><IconCheck :size="16" class="shrink-0" />{{ refreshWarning || '节点设置已保存并生效' }}</p>
            </div>
            <button v-if="needsRead" type="button" class="btn btn-outline min-h-11" :disabled="locked" @click="reread"><IconReload :size="16" /><span>重新读取状态</span></button>
            <button type="submit" class="btn btn-primary min-h-11" :disabled="locked || !!invalid || !changed || needsRead"><span v-if="saving" class="loading loading-spinner loading-xs" /><IconCheck v-else :size="16" /><span>{{ saving ? '正在保存…' : saved && !changed ? '已保存' : '保存节点设置' }}</span></button>
          </div>
        </template>
        <template v-else>
          <p class="shrink-0 text-xs leading-relaxed text-base-content/65">勾选加入{{ editorLabel }}，取消勾选移出。修改暂存，返回组设置后点击“保存”生效。已在{{ otherLabel }}中的节点置灰并排在末尾，需先从{{ otherLabel }}移除后才能选择。</p>
          <input v-model="search" type="search" class="input min-h-11 w-full shrink-0" placeholder="搜索节点名称" :aria-label="`搜索${editorLabel}候选节点`" />
          <div class="flex shrink-0 gap-2" role="group" aria-label="节点筛选">
            <button type="button" class="btn btn-sm min-h-11" :class="!onlySelected ? 'btn-primary' : 'btn-ghost'" :aria-pressed="!onlySelected" @click="onlySelected = false"><IconList :size="16" /><span>全部节点</span></button>
            <button type="button" class="btn btn-sm min-h-11" :class="onlySelected ? 'btn-primary' : 'btn-ghost'" :aria-pressed="onlySelected" @click="onlySelected = true"><IconCheck :size="16" /><span>仅看已选 {{ editingPool.length }}</span></button>
          </div>
          <p v-if="totalSelected >= 32" class="shrink-0 text-xs text-warning">已达 32 个上限，请先取消已有选择再添加节点。</p>
          <div class="pool-list min-h-0 flex-1 space-y-1 overflow-y-auto [scrollbar-gutter:stable]" :aria-label="`${editorLabel}节点编辑列表`">
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
    </template>
  </Modal>
</template>

<style scoped>
/* Short viewports scroll the editor as one region so its controls cannot squeeze the list away. */
@media (max-height: 540px) {
  .pool-editor {
    overflow-y: auto;
    scrollbar-gutter: stable;
  }
  .pool-editor .pool-list {
    flex: none;
    overflow-y: visible;
  }
}
</style>
