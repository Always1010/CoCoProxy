<script setup lang="ts">
import { IconCheck, IconChevronDown, IconEdit, IconList, IconPlus, IconReload, IconTrash, IconX } from '@tabler/icons-vue'
import { domainRuleError, domainRuleTypes, GroupRuleEditError, isDomainRule, ruleTarget, saveGroupRules, templateRuleLabel } from '~/utils/group-rules'
import { CoCoProxyError, cocoproxyErrorMessage } from '~/composables/useCoCoProxy'
const { t } = useI18n()
const errorText = (cause: unknown) => cause instanceof GroupRuleEditError ? t(cause.messageKey)
  : cause instanceof CoCoProxyError ? cocoproxyErrorMessage(cause, t)
    : cause instanceof Error ? cause.message : cocoproxyErrorMessage(cause, t)

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
const error = useLocalizedMessage()
const formError = useLocalizedMessage()
const deletingRule = ref('')
const saving = ref(false)
const saved = useLocalizedMessage()
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
      const type = draft.type
      const issue = domainRuleError(type, value, t)
      if (issue) {
        const detailed = drafts.value.length > 1 || values.length > 1
        formError.value = () => detailed
          ? t('coco.anGroupLine', { value: groupIndex + 1, value2: lineIndex + 1, value3: domainRuleError(type, value, t) })
          : domainRuleError(type, value, t) ?? ''
        return null
      }
      const rule = `${draft.type},${value},${props.groupName}`
      if (seen.has(rule)) {
        formError.value = () => t('coco.anThisGroupAlreadyContainsTheSame', { value: value })
        return null
      }
      seen.add(rule)
      result.push(rule)
    }
  }
  if (!result.length) {
    formError.value = () => t('coco.anEnterAtLeastOneDomainOr')
    return null
  }
  if (editing.value !== null && result.length !== 1) {
    formError.value = () => t('coco.anOnlyOneMatchingValueCanBe')
    return null
  }
  if (entries.value.length - (editing.value === null ? 0 : 1) + result.length > 512) {
    formError.value = () => t('coco.anTheLimitOfCustomRulesHas')
    return null
  }
  return result
}
function successMessage(action: 'add' | 'edit' | 'remove', count = 1): () => string {
  const active = workspace.value?.runMode === 'rule'
  return () => {
    const subject = action === 'add' ? count > 1 ? t('coco.anRulesAdded', { value: count }) : t('coco.anRuleAdded') : action === 'edit' ? t('coco.anRuleChangesSaved') : t('coco.anRuleDeleted')
    return active ? t('coco.anAndApplied', { value: subject }) : t('coco.anTakesEffectInRuleMode', { value: subject })
  }
}
function failureCode(cause: unknown) {
  return typeof cause === 'object' && cause !== null && 'code' in cause ? String((cause as { code?: unknown }).code ?? '') : ''
}
function reconcileFailure(cause: unknown, baseline: string[], attempted: string[], message: () => string) {
  const latest = [...overrides.value.rules]
  if (sameRules(latest, attempted)) {
    original.value = latest
    entries.value = latest
    pendingApply.value = !!view.value?.pending
    needsRead.value = false
    if (pendingApply.value) error.value = () => t('coco.anRulesSavedButNotActiveYet')
    else saved.value = message
    return
  }
  if (!sameRules(latest, baseline)) {
    original.value = latest
    entries.value = latest
    pendingApply.value = !!view.value?.pending
    needsRead.value = false
    error.value = () => t('coco.anRulesChangedTheLatestStateIs')
    return
  }
  error.value = () => errorText(cause)
  needsRead.value = ['NETWORK_UNKNOWN', 'MANAGEMENT_UNAVAILABLE', 'CONFIRM_FAILED', 'WORKSPACE_CONFLICT'].includes(failureCode(cause))
}
async function applyEntries(next: string[], message: () => string) {
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
        await save(settings => { settings.local.rules = saveGroupRules(settings.local.rules, baseline, next, props.groupName, t) }, 'coco.anRulesSaved')
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
  const active = workspace.value?.runMode === 'rule'
  await applyEntries([...entries.value], () => active ? t('coco.anRulesApplied') : t('coco.anRulesSavedTheyTakeEffectIn'))
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
      error.value = pendingApply.value ? () => t('coco.anRulesSavedButNotActiveYet') : ''
      if (!pendingApply.value) saved.value = workspace.value?.runMode === 'rule' ? () => t('coco.anRulesApplied') : () => t('coco.anRulesSavedTheyTakeEffectIn')
    } else if (sameRules(latest, original.value)) {
      error.value = () => t('coco.anStatusReloadedChangesHaveNotBeen')
    } else {
      original.value = latest
      entries.value = latest
      pendingApply.value = !!view.value?.pending
      error.value = () => t('coco.anRulesChangedTheLatestStateIs')
    }
    needsRead.value = false
  } catch (cause) {
    error.value = () => errorText(cause)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col gap-3" :aria-label="t('coco.anGroupMatchingRules')">
    <div class="min-h-0 flex-1 space-y-4 overflow-y-auto px-1 [scrollbar-gutter:stable]">
      <p v-if="workspace?.runMode !== 'rule'" class="rounded-lg bg-warning/10 p-3 text-sm">{{ t('coco.anCurrentlyInModeDomainRoutingDoes', { value: workspace?.runMode === 'global' ? t('coco.anGlobal') : t('coco.anDirect') }) }}</p>
      <div v-if="shared" class="space-y-6">
        <p class="text-xs leading-relaxed text-base-content/65">
          <span class="block">{{ t('coco.anThisGroupProvidesASharedExit') }}</span>
          <span class="block">{{ t('coco.anConfigureDomainRulesInRegularGroups') }}</span>
        </p>
        <section class="space-y-3" :aria-label="t('coco.anProxyGroupsReferencingThisGroup')">
          <div class="flex items-baseline justify-between gap-3">
            <h3 class="text-sm font-semibold">{{ t('coco.anProxyGroupsReferencingThisGroup') }}</h3>
            <span class="shrink-0 text-xs text-base-content/60">{{ t('coco.anGroups', { value: dependents.length }) }}</span>
          </div>
          <ul v-if="dependents.length" class="flex flex-wrap gap-2"><li v-for="name in dependents" :key="name" class="max-w-full break-all rounded-md bg-base-content/5 px-2.5 py-1 text-sm leading-5">{{ name }}</li></ul>
          <p v-else class="text-xs leading-relaxed text-base-content/60">{{ t('coco.anNoRegularProxyGroupsReferenceThis') }}</p>
        </section>
      </div>
      <template v-else-if="editable">
        <div class="space-y-2">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 class="text-sm font-semibold">{{ t('coco.anMatchingRules') }}</h3>

            </div>
            <button v-if="ownRules.length" type="button" class="btn btn-primary btn-sm min-h-11" :disabled="locked || needsRead" @click="openAdd"><IconPlus :size="16" /><span>{{ t('coco.anAddRule') }}</span></button>
          </div>
          <HelpTip>{{ t('coco.anCustomRulesTakePriorityOverBuilt') }}</HelpTip>
        </div>

        <div v-if="saving" role="status" class="flex items-center gap-2 rounded-lg bg-primary/10 p-3 text-sm"><span class="loading loading-spinner loading-sm" /><span>{{ t('coco.anSavingAndApplyingRulesYouMay') }}</span></div>
        <div v-else-if="error || needsRead" role="alert" class="space-y-3 rounded-lg bg-error/10 p-3 text-sm text-error">
          <p class="break-words">{{ error || t('coco.anRuleActivationHasNotBeenConfirmed') }}{{ needsRead ? t('coco.anReloadTheStatusAndReviewIt') : '' }}</p>
          <div class="flex flex-wrap gap-2">
            <button v-if="needsRead" type="button" class="btn btn-outline btn-sm min-h-11" :disabled="locked" @click="reread"><IconReload :size="16" /><span>{{ t('coco.anReloadStatus') }}</span></button>
            <button v-else-if="listChanged || pendingApply" type="button" class="btn btn-outline btn-sm min-h-11" :disabled="locked" @click="retry"><IconReload :size="16" /><span>{{ t('coco.anRetryApply') }}</span></button>
          </div>
        </div>
        <p v-else-if="saved" role="status" class="flex items-center gap-2 rounded-lg bg-success/10 p-3 text-sm text-success"><IconCheck :size="16" class="shrink-0" /><span>{{ saved }}</span></p>

        <section class="space-y-2" :aria-label="t('coco.anCustomRulesForThisGroup')">
          <h3 class="text-sm font-medium">{{ t('coco.anCustomRules', { value: ownRules.length }) }}</h3>
          <div v-if="!ownRules.length" class="space-y-3 rounded-lg border border-dashed border-base-content/15 p-4 text-center">
            <p class="text-sm text-base-content/60">{{ t('coco.anNoCustomRules', { value: templateRules.length || groupName === 'Other' ? t('coco.anThisGroupStillUsesBuiltIn') : t('coco.anAddRulesToSpecifyWhichWebsites') }) }}</p>
            <button type="button" class="btn btn-primary min-h-11" :disabled="locked || needsRead" @click="openAdd"><IconPlus :size="16" /><span>{{ t('coco.anAddRule') }}</span></button>
          </div>
          <div v-for="rule in ownRules" :key="rule.index" class="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-base-content/10 py-2">
            <p class="min-w-0 flex-1 basis-48 break-all text-sm font-medium">{{ templateRuleLabel(rule.value, t) }}</p>
            <div class="flex flex-wrap gap-2">
              <button v-if="isDomainRule(rule.value)" type="button" class="btn btn-ghost btn-sm min-h-11" :disabled="locked || needsRead" :aria-label="t('coco.anEditGroupRule', { value: rule.index + 1 })" @click="edit(rule.index)"><IconEdit :size="16" /><span>{{ t('coco.anEdit2') }}</span></button>
              <NuxtLink v-else :to="customRulesLink" custom v-slot="{ href }"><a :href="href ?? undefined" class="btn btn-ghost btn-sm min-h-11" :aria-disabled="locked" @click.prevent="emit('navigate', customRulesLink)"><IconEdit :size="16" /><span>{{ t('coco.anEditOnRulesPage') }}</span></a></NuxtLink>
              <button type="button" class="btn btn-ghost btn-sm min-h-11 text-error" :disabled="locked || needsRead" :aria-label="t('coco.anDeleteGroupRule', { value: rule.index + 1 })" @click="requestRemove(rule.index)"><IconTrash :size="16" /><span>{{ t('coco.anDelete') }}</span></button>
            </div>
          </div>
        </section>

        <details class="space-y-2 rounded-xl border border-base-content/10 p-3" :aria-label="t('coco.anBuiltInRulesForThisGroup')">
          <summary class="flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 text-sm font-medium"><span>{{ t('coco.anBuiltInRules', { value: templateRules.length }) }}</span><IconChevronDown :size="16" /></summary>
          <p v-if="workspace?.runMode !== 'rule'" class="text-sm text-base-content/60">{{ t('coco.anSwitchToRuleModeToView') }}</p>
          <p v-else-if="!templateRules.length" class="text-sm text-base-content/60">{{ t('coco.anThisGroupHasNoBuiltIn') }}</p>
          <div v-else class="space-y-2"><div v-for="rule in templateRules" :key="rule.value" class="rounded-lg bg-base-200 p-3"><p class="break-all text-sm">{{ templateRuleLabel(rule.value, t) }}</p><span class="mt-2 inline-block rounded bg-base-content/10 px-2 py-1 text-xs text-base-content/60">{{ t('coco.anBuiltInReadOnly') }}</span></div></div>
          <p v-if="groupName === 'Other'" class="text-sm text-base-content/60">{{ t('coco.anThisGroupIsTheFinalFallback') }}</p>
        </details>
      </template>
      <div class="border-t border-base-content/10 pt-4">
        <NuxtLink :to="effectiveRulesLink" custom v-slot="{ href }"><a :href="href ?? undefined" class="btn btn-outline min-h-11 w-full border-base-content/20 sm:w-auto" :aria-disabled="locked" @click.prevent="emit('navigate', effectiveRulesLink)"><IconList :size="16" /><span>{{ t('coco.anViewEffectiveRulesForThisGroup') }}</span></a></NuxtLink>
      </div>
    </div>

    <Modal compact ref="editorDialog" :title="editing === null ? t('coco.anAddMatchingRule') : t('coco.anEditMatchingRule')" :close-disabled="locked" @close="clearEditor">
      <form class="space-y-4" @submit.prevent="submitEditor">
        <div v-for="(draft, index) in drafts" :key="draft.id" class="space-y-3 rounded-lg border border-base-content/10 p-3">
          <div v-if="editing === null && drafts.length > 1" class="flex items-center justify-between gap-2">
            <h3 class="text-sm font-medium">{{ t('coco.anRuleGroup', { value: index + 1 }) }}</h3>
            <button type="button" class="btn btn-ghost btn-sm min-h-11 text-error" :disabled="locked" @click="removeDraftGroup(index)"><IconTrash :size="16" /><span>{{ t('coco.anDeleteThisGroup') }}</span></button>
          </div>
          <label class="flex flex-col gap-1 text-sm">{{ t('coco.anMatchType') }}<select v-model="draft.type" class="select min-h-11 w-full" :aria-label="t('coco.anRuleGroupMatchType', { value: index + 1 })" :disabled="locked"><option v-for="entry in domainRuleTypes" :key="entry.value" :value="entry.value">{{ t(entry.label) }}（{{ entry.value }}）</option></select></label>
          <label class="flex flex-col gap-1 text-sm">
            {{ draft.type === 'DOMAIN-REGEX' || draft.type === 'DOMAIN-KEYWORD' ? t('coco.anMatchingValue') : t('coco.anDomain') }}
            <input v-if="editing !== null" v-model="draft.payload" class="input min-h-11 w-full" :aria-label="t('coco.anEditRuleMatchingValue')" :placeholder="draft.type === 'DOMAIN-REGEX' ? '^api\\.example\\.com$' : 'example.com'" :disabled="locked" maxlength="8000" spellcheck="false" autocapitalize="none" required />
            <textarea v-else v-model="draft.payload" class="textarea min-h-28 w-full" :aria-label="t('coco.anRuleGroupMatchingValue', { value: index + 1 })" :placeholder="draft.type === 'DOMAIN-REGEX' ? '^api\\.example\\.com$' : 'example.com\nexample.org'" :disabled="locked" maxlength="8000" rows="4" spellcheck="false" autocapitalize="none" />
          </label>
          <p v-if="editing === null" class="text-xs text-base-content/60">{{ t('coco.anEnterOnePerLine', { value: draft.type === 'DOMAIN-REGEX' || draft.type === 'DOMAIN-KEYWORD' ? t('coco.anMatchingValue') : t('coco.anDomain') }) }}</p>
        </div>
        <button v-if="editing === null" type="button" class="btn btn-ghost min-h-11 w-full" :disabled="locked" @click="addDraftGroup"><IconPlus :size="16" /><span>{{ t('coco.anAddAnotherMatchType') }}</span></button>
        <p class="break-all text-sm">{{ t('coco.anTargetPolicy', { value: groupName }) }}</p>
        <p v-if="editing === null && draftCount" class="text-sm text-base-content/65">{{ t('coco.anAddRulesInOneApplyOperation', { value: draftCount }) }}</p>
        <p v-if="formError" role="alert" class="break-words text-sm text-error">{{ formError }}</p>
      </form>
      <template #actions>
        <button type="button" class="btn btn-ghost min-h-11" :disabled="locked" @click="editorDialog?.close()"><IconX :size="16" /><span>{{ t('coco.anCancel') }}</span></button>
        <button type="button" class="btn btn-primary min-h-11" :disabled="locked || !draftCount" @click="submitEditor"><IconCheck v-if="editing !== null" :size="16" /><IconPlus v-else :size="16" /><span>{{ editing !== null ? t('coco.anSaveChangesAndApply') : draftCount > 1 ? t('coco.anAddAndApply', { value: draftCount }) : t('coco.anAddAndApply2') }}</span></button>
      </template>
    </Modal>

    <Modal compact ref="deleteDialog" :title="t('coco.anDeleteMatchingRule')" :fixed-height="false" :close-disabled="locked" @close="clearDelete">
      <div class="space-y-3 text-sm">
        <p>{{ t('coco.anDeleteTheFollowingRuleItWill') }}</p>
        <p class="break-all rounded-lg bg-base-200 p-3 font-medium">{{ templateRuleLabel(deletingRule, t) }}</p>
      </div>
      <template #actions>
        <button type="button" class="btn btn-ghost min-h-11" :disabled="locked" @click="deleteDialog?.close()"><IconX :size="16" /><span>{{ t('coco.anCancel') }}</span></button>
        <button type="button" class="btn btn-error min-h-11" :disabled="locked" @click="confirmRemove"><IconTrash :size="16" /><span>{{ t('coco.anDeleteRule') }}</span></button>
      </template>
    </Modal>
  </div>
</template>
