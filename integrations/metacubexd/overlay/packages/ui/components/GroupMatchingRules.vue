<script setup lang="ts">
import { IconCheck, IconEdit, IconList, IconPlus, IconReload, IconTrash, IconX } from '@tabler/icons-vue'
import { domainRuleError, domainRuleTypes, isDomainRule, ruleTarget, saveGroupRules, templateRuleLabel } from '~/utils/group-rules'
import { CoCoProxyError } from '~/composables/useCoCoProxy'

const props = defineProps<{ groupName: string }>()
const emit = defineEmits<{ navigate: [target: { path: string; query: Record<string, string> }] }>()
const { view, workspace, overrides, busy, run, save, load } = useWorkspace()
const original = ref([...overrides.value.rules])
const entries = ref([...original.value])
const type = ref('DOMAIN-SUFFIX')
const payload = ref('')
const editing = ref<number | null>(null)
const error = ref('')
const saving = ref(false)
const saved = ref('')
const needsRead = ref(false)
const listChanged = computed(() => JSON.stringify(entries.value) !== JSON.stringify(original.value))
const formPending = computed(() => editing.value !== null || !!payload.value.trim())
const dirty = computed(() => listChanged.value || formPending.value)
const locked = computed(() => busy.value || saving.value)
defineExpose({ dirty, saving })
const shared = computed(() => view.value?.groups.find(group => group.name === props.groupName)?.role === 'shared')
const editable = computed(() => workspace.value?.mode === 'local' && !shared.value)
const ownRules = computed(() => entries.value.map((value, index) => ({ value, index })).filter(rule => ruleTarget(rule.value) === props.groupName))
const templateRules = computed(() => view.value?.rules.filter(rule => rule.source === 'template' && ruleTarget(rule.value) === props.groupName) ?? [])
const dependents = computed(() => view.value?.groups
  .filter(group => group.role === 'service' && group.name !== props.groupName && group.selected === props.groupName)
  .map(group => group.name) ?? [])
const effectiveRulesLink = computed(() => ({ path: '/rules', query: { group: props.groupName, tab: 'effective' } }))
const customRulesLink = computed(() => ({ path: '/rules', query: { group: props.groupName, tab: 'custom' } }))

function resetForm() { editing.value = null; type.value = 'DOMAIN-SUFFIX'; payload.value = ''; error.value = '' }
function edit(index: number) {
  if (locked.value || !isDomainRule(entries.value[index]!)) return
  const parts = entries.value[index]!.split(',')
  editing.value = index; type.value = parts[0]!; payload.value = parts[1]!; error.value = ''
}
function add() {
  if (locked.value || !editable.value) return
  const value = payload.value.trim()
  error.value = domainRuleError(type.value, value)
  if (error.value) return
  const rule = `${type.value},${value},${props.groupName}`
  if (entries.value.some((entry, index) => entry === rule && index !== editing.value)) { error.value = '本组已存在相同规则。'; return }
  if (editing.value === null) {
    if (entries.value.length >= 512) { error.value = '自定义规则已达 512 条上限。'; return }
    entries.value.push(rule)
  } else entries.value[editing.value] = rule
  resetForm()
}
function remove(index: number) {
  if (locked.value || !editable.value || ruleTarget(entries.value[index] ?? '') !== props.groupName) return
  entries.value.splice(index, 1)
  if (editing.value === index) resetForm()
  else if (editing.value !== null && editing.value > index) editing.value--
}
async function persist() {
  if (!dirty.value || locked.value || !editable.value || needsRead.value) return
  if (formPending.value) { error.value = '请先将当前表单添加到列表，或取消编辑。'; return }
  error.value = ''; saving.value = true
  try {
    await run(async () => {
      try {
        const message = workspace.value?.runMode === 'rule' ? '规则已保存并生效' : '规则已保存，切换到规则模式后生效'
        await save(settings => { settings.local.rules = saveGroupRules(settings.local.rules, original.value, entries.value, props.groupName) }, message)
        original.value = [...entries.value]
        saved.value = message
      } catch (cause) {
        error.value = cause instanceof Error ? cause.message : '保存失败，请重试。'
        needsRead.value = cause instanceof CoCoProxyError && ['NETWORK_UNKNOWN', 'MANAGEMENT_UNAVAILABLE', 'CONFIRM_FAILED', 'WORKSPACE_CONFLICT'].includes(cause.code)
      }
    })
  }
  finally { saving.value = false }
}
async function reread() {
  if (locked.value) return
  saving.value = true
  try {
    await load()
    const own = (values: string[]) => values.filter(value => ruleTarget(value) === props.groupName)
    if (JSON.stringify(own(overrides.value.rules)) === JSON.stringify(own(entries.value)) && !view.value?.pending) {
      original.value = [...entries.value]
      saved.value = workspace.value?.runMode === 'rule' ? '规则已保存并生效' : '规则已保存，切换到规则模式后生效'
      error.value = ''
    } else error.value = '状态已重新读取，规则尚未确认生效，请核对后重试。'
    needsRead.value = false
  } catch (cause) { error.value = cause instanceof Error ? cause.message : '读取失败，请重试。' }
  finally { saving.value = false }
}
watch(() => JSON.stringify([entries.value, type.value, payload.value, editing.value]), () => { error.value = '' })
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col gap-3" aria-label="组内匹配规则">
    <div class="min-h-0 flex-1 space-y-4 overflow-y-auto px-1 [scrollbar-gutter:stable]">
      <p v-if="workspace?.runMode !== 'rule'" class="rounded-lg bg-warning/10 p-3 text-sm">当前为{{ workspace?.runMode === 'global' ? '全局' : '直连' }}模式，域名分流暂不参与匹配；保存后切换到规则模式使用。</p>
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
        <p class="text-xs leading-relaxed text-base-content/65">自定义规则先于内置规则匹配；多条自定义规则同时匹配时，以规则页中的顺序为准。新规则追加到自定义规则末尾。</p>
        <form class="space-y-3 rounded-lg border border-base-content/10 p-3" @submit.prevent="add">
          <label class="flex flex-col gap-1 text-sm">匹配方式<select v-model="type" class="select min-h-11 w-full" aria-label="组内规则类型" :disabled="locked"><option v-for="entry in domainRuleTypes" :key="entry.value" :value="entry.value">{{ entry.label }}（{{ entry.value }}）</option></select></label>
          <label class="flex flex-col gap-1 text-sm">{{ type === 'DOMAIN-REGEX' || type === 'DOMAIN-KEYWORD' ? '匹配内容' : '域名' }}<input v-model="payload" class="input min-h-11 w-full" aria-label="组内匹配内容" :placeholder="type === 'DOMAIN-REGEX' ? '^api\\.example\\.com$' : 'example.com'" :disabled="locked" maxlength="8000" spellcheck="false" autocapitalize="none" required /></label>
          <p class="break-all text-sm">目标策略：{{ groupName }}</p>
          <div class="flex flex-wrap gap-2">
            <button class="btn btn-primary min-h-11" type="submit" :disabled="locked"><IconCheck v-if="editing !== null" :size="16" /><IconPlus v-else :size="16" /><span>{{ editing !== null ? '更新到列表' : '添加到列表' }}</span></button>
            <button v-if="editing !== null || payload" class="btn btn-ghost min-h-11" type="button" :disabled="locked" @click="resetForm"><IconX :size="16" /><span>取消编辑</span></button>
          </div>
        </form>
        <section class="space-y-2" aria-label="本组自定义规则">
          <h3 class="text-sm font-medium">自定义规则 · {{ ownRules.length }} 条</h3>
          <p v-if="!ownRules.length" class="text-sm text-base-content/60">尚未配置自定义匹配规则。{{ templateRules.length || groupName === 'Other' ? '本组仍使用内置匹配规则。' : '在上方添加域名规则，指定哪些网站使用本组。' }}</p>
          <div v-for="rule in ownRules" :key="rule.index" class="space-y-2 rounded-lg bg-base-200 p-3">
            <p class="break-all text-sm">{{ templateRuleLabel(rule.value) }}</p>
            <div class="flex flex-wrap gap-2">
              <button v-if="isDomainRule(rule.value)" type="button" class="btn btn-ghost btn-sm min-h-11" :disabled="locked" :aria-label="`编辑组内规则 ${rule.index + 1}`" @click="edit(rule.index)"><IconEdit :size="16" /><span>编辑</span></button>
              <NuxtLink v-else :to="customRulesLink" custom v-slot="{ href }"><a :href="href ?? undefined" class="btn btn-ghost btn-sm min-h-11" :aria-disabled="locked" @click.prevent="emit('navigate', customRulesLink)"><IconEdit :size="16" /><span>前往规则页编辑</span></a></NuxtLink>
              <button type="button" class="btn btn-ghost btn-sm min-h-11 text-error" :disabled="locked" :aria-label="`删除组内规则 ${rule.index + 1}`" @click="remove(rule.index)"><IconTrash :size="16" /><span>删除</span></button>
            </div>
          </div>
        </section>
        <section class="space-y-2" aria-label="本组内置规则">
          <h3 class="text-sm font-medium">内置规则 · 只读</h3>
          <p v-if="workspace?.runMode !== 'rule'" class="text-sm text-base-content/60">切换到规则模式后可查看本组内置规则。</p>
          <p v-else-if="!templateRules.length" class="text-sm text-base-content/60">本组没有内置匹配规则。</p>
          <ul v-else class="space-y-1 text-sm text-base-content/70"><li v-for="rule in templateRules" :key="rule.value" class="break-all">{{ templateRuleLabel(rule.value) }}</li></ul>
          <p v-if="groupName === 'Other'" class="text-sm text-base-content/60">本组承担最终兜底，其他规则均未命中的流量使用本组。</p>
        </section>
      </template>
      <div class="border-t border-base-content/10 pt-4">
        <NuxtLink :to="effectiveRulesLink" custom v-slot="{ href }"><a :href="href ?? undefined" class="btn btn-outline min-h-11 w-full border-base-content/20 sm:w-auto" :aria-disabled="locked" @click.prevent="emit('navigate', effectiveRulesLink)"><IconList :size="16" /><span>查看本组生效规则</span></a></NuxtLink>
      </div>
    </div>
    <div v-if="editable" class="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-base-content/10 pt-3">
      <div class="min-w-0 flex-1 basis-40 text-sm" aria-live="polite">
        <p v-if="saving" role="status">正在保存或核对规则…</p>
        <p v-else-if="error || needsRead" role="alert" class="break-words text-error">{{ error || '暂未确认规则是否生效。' }}{{ needsRead ? ' 请重新读取状态后核对。' : '' }}</p>
        <p v-else-if="formPending" class="text-warning">请先将当前表单添加到列表，或取消编辑。</p>
        <p v-else-if="dirty" class="text-warning">规则有未保存修改</p>
        <p v-else-if="saved" role="status" class="flex items-center gap-1 text-success"><IconCheck :size="16" class="shrink-0" />{{ saved }}</p>
      </div>
      <button v-if="needsRead" type="button" class="btn btn-outline min-h-11" :disabled="locked" @click="reread"><IconReload :size="16" /><span>重新读取状态</span></button>
      <button type="button" class="btn btn-primary min-h-11" :disabled="locked || !listChanged || formPending || needsRead" @click="persist"><span v-if="saving" class="loading loading-spinner loading-xs" /><IconCheck v-else :size="16" /><span>{{ saving ? '正在保存…' : saved && !dirty ? '已保存' : '保存规则' }}</span></button>
    </div>
  </div>
</template>
