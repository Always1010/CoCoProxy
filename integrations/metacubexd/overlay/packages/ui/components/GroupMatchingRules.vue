<script setup lang="ts">
import { IconCheck, IconChevronDown, IconEdit, IconInfoCircle, IconList, IconPlus, IconReload, IconTrash, IconX } from '@tabler/icons-vue'
import { domainRuleError, domainRuleTypes, isDomainRule, ruleTarget, saveGroupRules, templateRuleLabel } from '~/utils/group-rules'

type RuleDraft = { id: number; type: string; payload: string }

const props = defineProps<{ groupName: string }>()
const emit = defineEmits<{ navigate: [target: { path: string; query: Record<string, string> }] }>()
const { view, workspace, overrides, busy, run, save, load } = useWorkspace()
const editorDialog = ref<{ open: () => void; close: (force?: boolean) => void }>()
const deleteDialog = ref<{ open: () => void; close: (force?: boolean) => void }>()
const original = ref([...overrides.value.rules])
const entries = ref([...original.value])
const drafts = ref<RuleDraft[]>([])
const editing = ref<number | null>(null)
const deleting = ref<number | null>(null)
const error = ref('')
const formError = ref('')
const deletingRule = ref('')
const saving = ref(false)
const saved = ref('')
const needsRead = ref(false)
const pendingApply = ref(false)
let nextDraftId = 1

const sameRules = (left: string[], right: string[]) => JSON.stringify(left) === JSON.stringify(right)
const listChanged = computed(() => !sameRules(entries.value, original.value))
const locked = computed(() => busy.value || saving.value)
defineExpose({ saving })
const shared = computed(() => view.value?.groups.find(group => group.name === props.groupName)?.role === 'shared')
const editable = computed(() => workspace.value?.mode === 'local' && !shared.value)
const ownRules = computed(() => entries.value.map((value, index) => ({ value, index })).filter(rule => ruleTarget(rule.value) === props.groupName))
const templateRules = computed(() => view.value?.rules.filter(rule => rule.source === 'template' && ruleTarget(rule.value) === props.groupName) ?? [])
const dependents = computed(() => view.value?.groups
  .filter(group => group.role === 'service' && group.name !== props.groupName && group.selected === props.groupName)
  .map(group => group.name) ?? [])
const effectiveRulesLink = computed(() => ({ path: '/rules', query: { group: props.groupName, tab: 'effective' } }))
const customRulesLink = computed(() => ({ path: '/rules', query: { group: props.groupName, tab: 'custom' } }))
const draftCount = computed(() => drafts.value.reduce((count, draft) => count + draft.payload.split(/\r?\n/).filter(line => line.trim()).length, 0))

function newDraft(type = 'DOMAIN-SUFFIX', payload = ''): RuleDraft {
  return { id: nextDraftId++, type, payload }
}
function clearEditor() {
  drafts.value = []
  editing.value = null
  formError.value = ''
}
function openAdd() {
  if (locked.value || !editable.value || needsRead.value) return
  editing.value = null
  drafts.value = [newDraft()]
  formError.value = ''
  editorDialog.value?.open()
}
function edit(index: number) {
  if (locked.value || needsRead.value || !isDomainRule(entries.value[index] ?? '')) return
  const parts = entries.value[index]!.split(',')
  editing.value = index
  drafts.value = [newDraft(parts[0]!, parts[1]!)]
  formError.value = ''
  editorDialog.value?.open()
}
function addDraftGroup() {
  if (locked.value || editing.value !== null) return
  drafts.value.push(newDraft())
}
function removeDraftGroup(index: number) {
  if (locked.value || drafts.value.length <= 1) return
  drafts.value.splice(index, 1)
}
function collectDraftRules(): string[] | null {
  const result: string[] = []
  const seen = new Set(entries.value.filter((_entry, index) => index !== editing.value))
  for (const [groupIndex, draft] of drafts.value.entries()) {
    const values = draft.payload.split(/\r?\n/).map(value => value.trim()).filter(Boolean)
    for (const [lineIndex, value] of values.entries()) {
      const issue = domainRuleError(draft.type, value)
      if (issue) {
        formError.value = drafts.value.length > 1 || values.length > 1
          ? `第 ${groupIndex + 1} 组第 ${lineIndex + 1} 行：${issue}`
          : issue
        return null
      }
      const rule = `${draft.type},${value},${props.groupName}`
      if (seen.has(rule)) {
        formError.value = `本组已存在相同规则：${value}`
        return null
      }
      seen.add(rule)
      result.push(rule)
    }
  }
  if (!result.length) {
    formError.value = '请至少填写一个域名或匹配内容。'
    return null
  }
  if (editing.value !== null && result.length !== 1) {
    formError.value = '编辑规则时只能填写一个匹配内容。'
    return null
  }
  if (entries.value.length - (editing.value === null ? 0 : 1) + result.length > 512) {
    formError.value = '自定义规则已达 512 条上限。'
    return null
  }
  return result
}
function successMessage(action: 'add' | 'edit' | 'remove', count = 1) {
  const subject = action === 'add' ? count > 1 ? `${count} 条规则已添加` : '规则已添加' : action === 'edit' ? '规则修改已保存' : '规则已删除'
  return workspace.value?.runMode === 'rule' ? `${subject}并生效` : `${subject}，切换到规则模式后生效`
}
function failureCode(cause: unknown) {
  return typeof cause === 'object' && cause !== null && 'code' in cause ? String((cause as { code?: unknown }).code ?? '') : ''
}
function reconcileFailure(cause: unknown, baseline: string[], attempted: string[], message: string) {
  const latest = [...overrides.value.rules]
  if (sameRules(latest, attempted)) {
    original.value = latest
    entries.value = latest
    pendingApply.value = !!view.value?.pending
    needsRead.value = false
    if (pendingApply.value) error.value = '规则已保存，但尚未生效，请重试应用。'
    else saved.value = message
    return
  }
  if (!sameRules(latest, baseline)) {
    original.value = latest
    entries.value = latest
    pendingApply.value = !!view.value?.pending
    needsRead.value = false
    error.value = '规则已发生变化，已显示最新状态，请重新执行操作。'
    return
  }
  error.value = cause instanceof Error ? cause.message : '规则应用失败，请重试。'
  needsRead.value = ['NETWORK_UNKNOWN', 'MANAGEMENT_UNAVAILABLE', 'CONFIRM_FAILED', 'WORKSPACE_CONFLICT'].includes(failureCode(cause))
}
async function applyEntries(next: string[], message: string) {
  if (locked.value || !editable.value || needsRead.value) return
  const baseline = [...original.value]
  entries.value = [...next]
  error.value = ''
  saved.value = ''
  pendingApply.value = false
  saving.value = true
  try {
    await run(async () => {
      try {
        await save(settings => { settings.local.rules = saveGroupRules(settings.local.rules, baseline, next, props.groupName) }, message)
        original.value = [...next]
        entries.value = [...next]
        saved.value = message
      } catch (cause) {
        reconcileFailure(cause, baseline, next, message)
        throw cause
      }
    })
  } finally {
    saving.value = false
  }
}
async function submitEditor() {
  if (locked.value || !editable.value || needsRead.value) return
  const rules = collectDraftRules()
  if (!rules) return
  const next = [...entries.value]
  const action = editing.value === null ? 'add' : 'edit'
  if (editing.value === null) next.push(...rules)
  else next[editing.value] = rules[0]!
  const message = successMessage(action, rules.length)
  editorDialog.value?.close(true)
  await applyEntries(next, message)
}
function requestRemove(index: number) {
  if (locked.value || !editable.value || needsRead.value || ruleTarget(entries.value[index] ?? '') !== props.groupName) return
  deleting.value = index
  deletingRule.value = entries.value[index] ?? ''
  deleteDialog.value?.open()
}
function clearDelete() {
  deleting.value = null
  deletingRule.value = ''
}
async function confirmRemove() {
  if (locked.value || deleting.value === null) return
  const index = deleting.value
  const next = entries.value.filter((_entry, entryIndex) => entryIndex !== index)
  deleteDialog.value?.close(true)
  await applyEntries(next, successMessage('remove'))
}
async function retry() {
  await applyEntries([...entries.value], workspace.value?.runMode === 'rule' ? '规则已生效' : '规则已保存，切换到规则模式后生效')
}
async function reread() {
  if (locked.value) return
  saving.value = true
  try {
    await load()
    const latest = [...overrides.value.rules]
    if (sameRules(latest, entries.value)) {
      original.value = latest
      pendingApply.value = !!view.value?.pending
      error.value = pendingApply.value ? '规则已保存，但尚未生效，请重试应用。' : ''
      if (!pendingApply.value) saved.value = workspace.value?.runMode === 'rule' ? '规则已生效' : '规则已保存，切换到规则模式后生效'
    } else if (sameRules(latest, original.value)) {
      error.value = '状态已重新读取，更改尚未应用，可以重试。'
    } else {
      original.value = latest
      entries.value = latest
      pendingApply.value = !!view.value?.pending
      error.value = '规则已发生变化，已显示最新状态，请重新执行操作。'
    }
    needsRead.value = false
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '读取失败，请重试。'
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col gap-3" aria-label="组内匹配规则">
    <div class="min-h-0 flex-1 space-y-4 overflow-y-auto px-1 [scrollbar-gutter:stable]">
      <p v-if="workspace?.runMode !== 'rule'" class="rounded-lg bg-warning/10 p-3 text-sm">当前为{{ workspace?.runMode === 'global' ? '全局' : '直连' }}模式，域名分流暂不参与匹配；添加或修改会立即保存，切换到规则模式后使用。</p>
      <div v-if="shared" class="space-y-6">
        <p class="text-xs leading-relaxed text-base-content/65">
          <span class="block">本组作为共享出口，供普通策略组引用。</span>
          <span class="block">域名规则请在普通组中配置。</span>
        </p>
        <section class="space-y-3" aria-label="引用本组的策略组">
          <div class="flex items-baseline justify-between gap-3">
            <h3 class="text-sm font-semibold">引用本组的策略组</h3>
            <span class="shrink-0 text-xs text-base-content/60">{{ dependents.length }} 个</span>
          </div>
          <ul v-if="dependents.length" class="flex flex-wrap gap-2"><li v-for="name in dependents" :key="name" class="max-w-full break-all rounded-md bg-base-content/5 px-2.5 py-1 text-sm leading-5">{{ name }}</li></ul>
          <p v-else class="text-xs leading-relaxed text-base-content/60">暂无普通策略组引用本组。</p>
        </section>
      </div>
      <template v-else-if="editable">
        <div class="space-y-2">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 class="text-sm font-semibold">匹配规则</h3>
              <p class="mt-1 text-xs text-base-content/65">自定义规则优先于内置规则，多条规则按列表顺序匹配。</p>
            </div>
            <button v-if="ownRules.length" type="button" class="btn btn-primary btn-sm min-h-11" :disabled="locked || needsRead" @click="openAdd"><IconPlus :size="16" /><span>添加规则</span></button>
          </div>
          <details class="text-xs text-base-content/65">
            <summary class="flex min-h-11 cursor-pointer list-none items-center gap-2"><IconInfoCircle :size="16" /><span>规则说明</span><IconChevronDown :size="14" /></summary>
            <p class="rounded-lg bg-base-200 p-3 leading-relaxed">新增规则追加到自定义规则末尾；同一匹配方式可以每行输入一个内容并一次应用。内置规则由系统提供，不能在此编辑或删除。</p>
          </details>
        </div>

        <div v-if="saving" role="status" class="flex items-center gap-2 rounded-lg bg-primary/10 p-3 text-sm"><span class="loading loading-spinner loading-sm" /><span>正在保存并应用规则，可以关闭组设置。</span></div>
        <div v-else-if="error || needsRead" role="alert" class="space-y-3 rounded-lg bg-error/10 p-3 text-sm text-error">
          <p class="break-words">{{ error || '暂未确认规则是否生效。' }}{{ needsRead ? ' 请重新读取状态后核对。' : '' }}</p>
          <div class="flex flex-wrap gap-2">
            <button v-if="needsRead" type="button" class="btn btn-outline btn-sm min-h-11" :disabled="locked" @click="reread"><IconReload :size="16" /><span>重新读取状态</span></button>
            <button v-else-if="listChanged || pendingApply" type="button" class="btn btn-outline btn-sm min-h-11" :disabled="locked" @click="retry"><IconReload :size="16" /><span>重试应用</span></button>
          </div>
        </div>
        <p v-else-if="saved" role="status" class="flex items-center gap-2 rounded-lg bg-success/10 p-3 text-sm text-success"><IconCheck :size="16" class="shrink-0" /><span>{{ saved }}</span></p>

        <section class="space-y-2" aria-label="本组自定义规则">
          <h3 class="text-sm font-medium">自定义规则 · {{ ownRules.length }} 条</h3>
          <div v-if="!ownRules.length" class="space-y-3 rounded-lg border border-dashed border-base-content/15 p-4 text-center">
            <p class="text-sm text-base-content/60">尚未配置自定义匹配规则。{{ templateRules.length || groupName === 'Other' ? '本组仍使用内置匹配规则。' : '添加规则，指定哪些网站使用本组。' }}</p>
            <button type="button" class="btn btn-primary min-h-11" :disabled="locked || needsRead" @click="openAdd"><IconPlus :size="16" /><span>添加规则</span></button>
          </div>
          <div v-for="rule in ownRules" :key="rule.index" class="space-y-2 rounded-lg bg-base-200 p-3">
            <p class="break-all text-sm font-medium">{{ templateRuleLabel(rule.value) }}</p>
            <p class="text-xs text-base-content/60">目标策略：{{ groupName }}</p>
            <div class="flex flex-wrap gap-2">
              <button v-if="isDomainRule(rule.value)" type="button" class="btn btn-ghost btn-sm min-h-11" :disabled="locked || needsRead" :aria-label="`编辑组内规则 ${rule.index + 1}`" @click="edit(rule.index)"><IconEdit :size="16" /><span>编辑规则</span></button>
              <NuxtLink v-else :to="customRulesLink" custom v-slot="{ href }"><a :href="href ?? undefined" class="btn btn-ghost btn-sm min-h-11" :aria-disabled="locked" @click.prevent="emit('navigate', customRulesLink)"><IconEdit :size="16" /><span>前往规则页编辑</span></a></NuxtLink>
              <button type="button" class="btn btn-ghost btn-sm min-h-11 text-error" :disabled="locked || needsRead" :aria-label="`删除组内规则 ${rule.index + 1}`" @click="requestRemove(rule.index)"><IconTrash :size="16" /><span>删除规则</span></button>
            </div>
          </div>
        </section>

        <section class="space-y-2" aria-label="本组内置规则">
          <h3 class="text-sm font-medium">内置规则 · {{ templateRules.length }} 条</h3>
          <p v-if="workspace?.runMode !== 'rule'" class="text-sm text-base-content/60">切换到规则模式后可查看本组内置规则。</p>
          <p v-else-if="!templateRules.length" class="text-sm text-base-content/60">本组没有内置匹配规则。</p>
          <div v-else class="space-y-2"><div v-for="rule in templateRules" :key="rule.value" class="rounded-lg bg-base-200 p-3"><p class="break-all text-sm">{{ templateRuleLabel(rule.value) }}</p><span class="mt-2 inline-block rounded bg-base-content/10 px-2 py-1 text-xs text-base-content/60">内置 · 只读</span></div></div>
          <p v-if="groupName === 'Other'" class="text-sm text-base-content/60">本组承担最终兜底，其他规则均未命中的流量使用本组。</p>
        </section>
      </template>
      <div class="border-t border-base-content/10 pt-4">
        <NuxtLink :to="effectiveRulesLink" custom v-slot="{ href }"><a :href="href ?? undefined" class="btn btn-outline min-h-11 w-full border-base-content/20 sm:w-auto" :aria-disabled="locked" @click.prevent="emit('navigate', effectiveRulesLink)"><IconList :size="16" /><span>查看本组生效规则</span></a></NuxtLink>
      </div>
    </div>

    <Modal ref="editorDialog" :title="editing === null ? '添加匹配规则' : '编辑匹配规则'" :close-disabled="locked" @close="clearEditor">
      <form class="space-y-4" @submit.prevent="submitEditor">
        <div v-for="(draft, index) in drafts" :key="draft.id" class="space-y-3 rounded-lg border border-base-content/10 p-3">
          <div v-if="editing === null && drafts.length > 1" class="flex items-center justify-between gap-2">
            <h3 class="text-sm font-medium">规则组 {{ index + 1 }}</h3>
            <button type="button" class="btn btn-ghost btn-sm min-h-11 text-error" :disabled="locked" @click="removeDraftGroup(index)"><IconTrash :size="16" /><span>删除此组</span></button>
          </div>
          <label class="flex flex-col gap-1 text-sm">匹配方式<select v-model="draft.type" class="select min-h-11 w-full" :aria-label="`规则组 ${index + 1} 匹配方式`" :disabled="locked"><option v-for="entry in domainRuleTypes" :key="entry.value" :value="entry.value">{{ entry.label }}（{{ entry.value }}）</option></select></label>
          <label class="flex flex-col gap-1 text-sm">
            {{ draft.type === 'DOMAIN-REGEX' || draft.type === 'DOMAIN-KEYWORD' ? '匹配内容' : '域名' }}
            <input v-if="editing !== null" v-model="draft.payload" class="input min-h-11 w-full" aria-label="编辑规则匹配内容" :placeholder="draft.type === 'DOMAIN-REGEX' ? '^api\\.example\\.com$' : 'example.com'" :disabled="locked" maxlength="8000" spellcheck="false" autocapitalize="none" required />
            <textarea v-else v-model="draft.payload" class="textarea min-h-28 w-full" :aria-label="`规则组 ${index + 1} 匹配内容`" :placeholder="draft.type === 'DOMAIN-REGEX' ? '^api\\.example\\.com$' : 'example.com\nexample.org'" :disabled="locked" maxlength="8000" rows="4" spellcheck="false" autocapitalize="none" />
          </label>
          <p v-if="editing === null" class="text-xs text-base-content/60">每行填写一个{{ draft.type === 'DOMAIN-REGEX' || draft.type === 'DOMAIN-KEYWORD' ? '匹配内容' : '域名' }}。</p>
        </div>
        <button v-if="editing === null" type="button" class="btn btn-ghost min-h-11 w-full" :disabled="locked" @click="addDraftGroup"><IconPlus :size="16" /><span>添加另一种匹配方式</span></button>
        <p class="break-all text-sm">目标策略：{{ groupName }}</p>
        <p v-if="editing === null && draftCount" class="text-sm text-base-content/65">本次共添加 {{ draftCount }} 条规则，只应用一次。</p>
        <p v-if="formError" role="alert" class="break-words text-sm text-error">{{ formError }}</p>
      </form>
      <template #actions>
        <button type="button" class="btn btn-ghost min-h-11" :disabled="locked" @click="editorDialog?.close()"><IconX :size="16" /><span>取消</span></button>
        <button type="button" class="btn btn-primary min-h-11" :disabled="locked || !draftCount" @click="submitEditor"><IconCheck v-if="editing !== null" :size="16" /><IconPlus v-else :size="16" /><span>{{ editing !== null ? '保存修改并生效' : draftCount > 1 ? `添加 ${draftCount} 条并生效` : '添加并生效' }}</span></button>
      </template>
    </Modal>

    <Modal ref="deleteDialog" title="删除匹配规则" :fixed-height="false" :close-disabled="locked" @close="clearDelete">
      <div class="space-y-3 text-sm">
        <p>确定删除以下规则吗？确认后会立即保存并应用。</p>
        <p class="break-all rounded-lg bg-base-200 p-3 font-medium">{{ templateRuleLabel(deletingRule) }}</p>
      </div>
      <template #actions>
        <button type="button" class="btn btn-ghost min-h-11" :disabled="locked" @click="deleteDialog?.close()"><IconX :size="16" /><span>取消</span></button>
        <button type="button" class="btn btn-error min-h-11" :disabled="locked" @click="confirmRemove"><IconTrash :size="16" /><span>删除规则</span></button>
      </template>
    </Modal>
  </div>
</template>
