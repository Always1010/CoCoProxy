<script setup lang="ts">
import { IconCheck, IconEdit, IconList, IconPlus, IconTrash, IconX } from '@tabler/icons-vue'
import { domainRuleError, domainRuleTypes, isDomainRule, ruleTarget, saveGroupRules, templateRuleLabel } from '~/utils/group-rules'

const props = defineProps<{ groupName: string }>()
const emit = defineEmits<{ close: [] }>()
const { view, workspace, overrides, busy, save } = useWorkspace()
const original = ref([...overrides.value.rules])
const entries = ref([...original.value])
const type = ref('DOMAIN-SUFFIX')
const payload = ref('')
const editing = ref<number | null>(null)
const error = ref('')
const saving = ref(false)
const dirty = computed(() => JSON.stringify(entries.value) !== JSON.stringify(original.value))
const shared = computed(() => view.value?.groups.find(group => group.name === props.groupName)?.role === 'shared')
const editable = computed(() => workspace.value?.mode === 'local' && !shared.value)
const ownRules = computed(() => entries.value.map((value, index) => ({ value, index })).filter(rule => ruleTarget(rule.value) === props.groupName))
const templateRules = computed(() => view.value?.rules.filter(rule => rule.source === 'template' && ruleTarget(rule.value) === props.groupName) ?? [])
const dependents = computed(() => view.value?.groups
  .filter(group => group.role === 'service' && group.name !== props.groupName && group.selected === props.groupName)
  .map(group => group.name) ?? [])
const allRulesLink = computed(() => ({ path: '/rules', query: { group: props.groupName, tab: 'custom' } }))

function resetForm() { editing.value = null; type.value = 'DOMAIN-SUFFIX'; payload.value = ''; error.value = '' }
function edit(index: number) {
  if (busy.value || !isDomainRule(entries.value[index]!)) return
  const parts = entries.value[index]!.split(',')
  editing.value = index; type.value = parts[0]!; payload.value = parts[1]!; error.value = ''
}
function add() {
  if (busy.value || !editable.value) return
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
  if (busy.value || !editable.value || ruleTarget(entries.value[index] ?? '') !== props.groupName) return
  entries.value.splice(index, 1)
  if (editing.value === index) resetForm()
  else if (editing.value !== null && editing.value > index) editing.value--
}
async function persist() {
  if (!dirty.value || busy.value || !editable.value) return
  if (editing.value !== null || payload.value.trim()) { error.value = '请先将当前表单添加到列表，或取消编辑。'; return }
  error.value = ''; saving.value = true
  try {
    await save(settings => { settings.local.rules = saveGroupRules(settings.local.rules, original.value, entries.value, props.groupName) }, workspace.value?.runMode === 'rule' ? '规则已生效' : '规则已保存，切换到规则模式后参与匹配')
    original.value = [...entries.value]
  } catch (cause) { error.value = cause instanceof Error ? cause.message : '保存失败，请重试。' }
  finally { saving.value = false }
}
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col gap-3" aria-label="组内匹配规则">
    <div class="min-h-0 flex-1 space-y-4 overflow-y-auto px-1 [scrollbar-gutter:stable]">
      <p v-if="workspace?.runMode !== 'rule'" class="rounded-lg bg-warning/10 p-3 text-sm">当前为{{ workspace?.runMode === 'global' ? '全局' : '直连' }}模式，域名分流暂不参与匹配；保存后切换到规则模式使用。</p>
      <template v-if="shared">
        <p class="text-sm">本组是共享出口，供普通策略组共同引用；请在普通组中配置域名规则。</p>
        <section class="space-y-2" aria-label="直接跟随本组的策略组">
          <h3 class="text-sm">直接跟随本组 · {{ dependents.length }} 个</h3>
          <ul v-if="dependents.length" class="flex flex-wrap gap-2"><li v-for="name in dependents" :key="name" class="max-w-full break-all rounded-lg bg-base-200 px-3 py-2 text-sm">{{ name }}</li></ul>
          <p v-else class="text-sm text-base-content/60">暂无普通组直接跟随本组。</p>
        </section>
      </template>
      <template v-else-if="editable">
        <p class="text-xs leading-relaxed text-base-content/65">自定义规则先于内置规则匹配；多条自定义规则同时匹配时，以规则页中的顺序为准。新规则追加到自定义规则末尾。</p>
        <form class="space-y-3 rounded-lg border border-base-content/10 p-3" @submit.prevent="add">
          <label class="flex flex-col gap-1 text-sm">匹配方式<select v-model="type" class="select min-h-11 w-full" aria-label="组内规则类型" :disabled="busy"><option v-for="entry in domainRuleTypes" :key="entry.value" :value="entry.value">{{ entry.label }}（{{ entry.value }}）</option></select></label>
          <label class="flex flex-col gap-1 text-sm">{{ type === 'DOMAIN-REGEX' || type === 'DOMAIN-KEYWORD' ? '匹配内容' : '域名' }}<input v-model="payload" class="input min-h-11 w-full" aria-label="组内匹配内容" :placeholder="type === 'DOMAIN-REGEX' ? '^api\\.example\\.com$' : 'example.com'" :disabled="busy" maxlength="8000" spellcheck="false" autocapitalize="none" required /></label>
          <p class="break-all text-sm">目标策略：{{ groupName }}</p>
          <div class="flex flex-wrap gap-2">
            <button class="btn btn-primary min-h-11" type="submit" :disabled="busy"><IconCheck v-if="editing !== null" :size="16" /><IconPlus v-else :size="16" /><span>{{ editing !== null ? '更新到列表' : '添加到列表' }}</span></button>
            <button v-if="editing !== null || payload" class="btn btn-ghost min-h-11" type="button" :disabled="busy" @click="resetForm"><IconX :size="16" /><span>取消编辑</span></button>
          </div>
        </form>
        <section class="space-y-2" aria-label="本组自定义规则">
          <h3 class="text-sm font-medium">自定义规则 · {{ ownRules.length }} 条</h3>
          <p v-if="!ownRules.length" class="text-sm text-base-content/60">尚未配置自定义匹配规则。{{ templateRules.length || groupName === 'Other' ? '本组仍使用内置匹配规则。' : '在上方添加域名规则，指定哪些网站使用本组。' }}</p>
          <div v-for="rule in ownRules" :key="rule.index" class="space-y-2 rounded-lg bg-base-200 p-3">
            <p class="break-all text-sm">{{ templateRuleLabel(rule.value) }}</p>
            <div class="flex flex-wrap gap-2">
              <button v-if="isDomainRule(rule.value)" type="button" class="btn btn-ghost btn-sm min-h-11" :disabled="busy" :aria-label="`编辑组内规则 ${rule.index + 1}`" @click="edit(rule.index)"><IconEdit :size="16" /><span>编辑</span></button>
              <NuxtLink v-else :to="allRulesLink" class="btn btn-ghost btn-sm min-h-11" @click="emit('close')"><IconEdit :size="16" /><span>前往规则页编辑</span></NuxtLink>
              <button type="button" class="btn btn-ghost btn-sm min-h-11 text-error" :disabled="busy" :aria-label="`删除组内规则 ${rule.index + 1}`" @click="remove(rule.index)"><IconTrash :size="16" /><span>删除</span></button>
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
      <NuxtLink :to="allRulesLink" class="btn btn-ghost min-h-11" @click="emit('close')"><IconList :size="16" /><span>查看全部规则</span></NuxtLink>
    </div>
    <p v-if="dirty" class="shrink-0 text-xs text-warning">规则有未保存修改；关闭或取消将丢弃。节点设置需单独保存。</p>
    <p v-if="error" role="alert" class="shrink-0 break-words text-sm text-error">{{ error }}</p>
    <div v-if="editable" class="flex shrink-0 flex-wrap justify-end gap-2 border-t border-base-content/10 pt-3">
      <button type="button" class="btn btn-ghost min-h-11" :disabled="busy" @click="emit('close')"><IconX :size="16" /><span>取消</span></button>
      <button type="button" class="btn btn-primary min-h-11" :disabled="busy || !dirty" @click="persist"><span v-if="saving" class="loading loading-spinner loading-xs" /><IconCheck v-else :size="16" /><span>{{ saving ? '正在保存并应用规则…' : '保存规则' }}</span></button>
    </div>
  </div>
</template>
