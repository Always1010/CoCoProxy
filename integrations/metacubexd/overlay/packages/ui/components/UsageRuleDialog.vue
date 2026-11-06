<script setup lang="ts">
import { IconCheck, IconRefresh, IconX } from '@tabler/icons-vue'
import { toast } from 'vue-sonner'
import { cocoproxyErrorMessage } from '~/composables/useCoCoProxy'
import type { WorkspaceSettings } from '~/composables/useWorkspace'
import { customRuleTargets } from '~/utils/group-rules'
import { usageRuleDefault, usageRulePlan, usageTarget, type UsageRuleType } from '~/utils/usage-rules'

const { t } = useI18n()
const emit = defineEmits<{ opened: [value: boolean] }>()
const { view, workspace, overrides, busy, load, run, save, editOverrides } = useWorkspace()
const panel = ref<{ open: () => void; close: (force?: boolean) => void }>()
const type = ref<UsageRuleType>('DOMAIN')
const payload = ref('')
const target = ref('')
const observed = ref('')
const original = ref<string[]>([])
const revision = ref(-1)
const scope = ref('')
const loading = ref(false)
const saving = ref(false)
const replace = ref(false)
const needsRead = ref(false)
const savedAttempt = ref<string[] | null>(null)
const savedRevision = ref(-1)
const savedSettingsKey = ref('')
const error = useLocalizedMessage()
const targets = computed(() => customRuleTargets(workspace.value?.mode, view.value?.groups))
const types = computed(() => usageTarget(observed.value)?.kind === 'domain' ? ['DOMAIN', 'DOMAIN-SUFFIX'] as const : [usageTarget(observed.value)?.kind === 'ipv4' ? 'IP-CIDR' : 'IP-CIDR6'] as const)
const plan = computed(() => usageRulePlan(original.value, type.value, payload.value, target.value))
const locked = computed(() => busy.value || loading.value || saving.value)
const currentScope = () => JSON.stringify([workspace.value?.mode, workspace.value?.subscriptionId, workspace.value?.sourceIds])
const sameRules = (left: string[], right: string[]) => JSON.stringify(left) === JSON.stringify(right)
function settingsKey(value: WorkspaceSettings & { revision?: number }) {
  const { revision: _revision, ...settings } = value
  return JSON.stringify(settings, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item)
}
const canSave = computed(() => !!plan.value && targets.value.includes(target.value) && !plan.value.duplicate && (!plan.value.conflicts.length || replace.value)
  && !locked.value && !needsRead.value && !view.value?.pending && !savedAttempt.value && workspace.value?.revision === revision.value && currentScope() === scope.value)

function capture() {
  original.value = [...overrides.value.rules]
  revision.value = workspace.value?.revision ?? -1
  scope.value = currentScope()
  replace.value = false
}
async function open(host: string) {
  const address = usageTarget(host)
  if (!address || saving.value || loading.value) return
  observed.value = address.value
  const initial = usageRuleDefault(address)
  type.value = initial.type; payload.value = initial.payload; target.value = ''
  original.value = []; revision.value = -1; replace.value = false; needsRead.value = true; savedAttempt.value = null
  error.value = ''
  panel.value?.open(); emit('opened', true)
  await reread()
}
async function reread() {
  if (busy.value || loading.value || saving.value) return
  loading.value = true; error.value = ''; needsRead.value = true
  try {
    await load()
    if (savedAttempt.value) {
      if (currentScope() !== scope.value || !sameRules(overrides.value.rules, savedAttempt.value) || workspace.value?.revision !== savedRevision.value || settingsKey(workspace.value) !== savedSettingsKey.value) {
        savedAttempt.value = null; error.value = () => t('coco.usageRuleChanged')
      } else if (!view.value?.pending) {
        finish()
      } else error.value = () => t('coco.usageRuleSavedPending')
    }
    if (!savedAttempt.value) capture()
    needsRead.value = false
  } catch (cause) { error.value = () => cocoproxyErrorMessage(cause, t) }
  finally { loading.value = false }
}
async function submit(retry = false) {
  if (locked.value || needsRead.value || (retry ? !savedAttempt.value : !canSave.value)) return
  saving.value = true; error.value = ''
  try {
    await run(async () => {
      try {
        await load()
        const expectedRevision = retry ? savedRevision.value : revision.value
        if (workspace.value?.revision !== expectedRevision || currentScope() !== scope.value || (retry && (!sameRules(overrides.value.rules, savedAttempt.value!) || settingsKey(workspace.value) !== savedSettingsKey.value))) {
          needsRead.value = true; error.value = () => t('coco.usageRuleChanged'); return
        }
        if (!retry && view.value?.pending) { error.value = () => t('coco.usageRuleExistingPending'); return }
        if (retry && !view.value?.pending) {
          capture(); savedAttempt.value = null
          finish()
          return
        }
        const attempt = retry ? savedAttempt.value! : plan.value!.rules
        if (!retry && (!sameRules(overrides.value.rules, original.value) || !targets.value.includes(target.value))) {
          needsRead.value = true; error.value = () => t('coco.usageRuleChanged'); return
        }
        let attemptedSettingsKey = ''
        try {
          await save(settings => { editOverrides(settings).rules = [...attempt]; attemptedSettingsKey = settingsKey(settings) })
          capture(); savedAttempt.value = null
          finish()
        } catch (cause) {
          // save() rereads after failure. Only retry our own isolated saved revision;
          // never apply pre-existing or subsequently changed workspace edits.
          if (currentScope() === scope.value && sameRules(overrides.value.rules, attempt) && workspace.value?.revision === expectedRevision + 1 && settingsKey(workspace.value) === attemptedSettingsKey) {
            savedAttempt.value = [...attempt]; savedRevision.value = workspace.value?.revision ?? -1
            savedSettingsKey.value = attemptedSettingsKey
          }
          needsRead.value = true
          error.value = savedAttempt.value && view.value?.pending ? () => t('coco.usageRuleSavedPending') : () => cocoproxyErrorMessage(cause, t)
        }
      } catch (cause) { needsRead.value = true; error.value = () => cocoproxyErrorMessage(cause, t) }
    })
  } finally { saving.value = false }
}
function finish() {
  savedAttempt.value = null
  panel.value?.close(true)
  toast.success(t('coco.anRulesSaved'), {
    duration: 2500,
    description: workspace.value?.runMode === 'rule' ? undefined : t('coco.usageRuleInactiveMode'),
  })
}
function close() { emit('opened', false) }
watch([type, payload, target], () => { replace.value = false })
defineExpose({ open })
</script>

<template>
  <Modal ref="panel" compact :fixed-height="false" :title="t('coco.usageRuleAdd')" :close-disabled="locked" @close="close">
    <form class="space-y-4" @submit.prevent="submit()">
      <p class="break-all font-mono text-sm">{{ observed }}</p>
      <p class="text-xs leading-relaxed text-base-content/60">{{ t('coco.usageRuleScope') }}</p>
      <p v-if="loading" role="status" class="text-sm">{{ t('coco.pzLoading') }}</p>
      <label class="flex flex-col gap-1 text-sm">{{ t('coco.anMatchType') }}<select v-model="type" class="select w-full" :disabled="locked || !!savedAttempt"><option v-for="entry in types" :key="entry" :value="entry">{{ entry === 'DOMAIN' ? t('coco.domainExact') : entry === 'DOMAIN-SUFFIX' ? t('coco.domainSuffix') : entry }}</option></select></label>
      <label class="flex flex-col gap-1 text-sm">{{ t('coco.usageRuleValue') }}<input v-model="payload" class="input w-full font-mono" :disabled="locked || !!savedAttempt" maxlength="260" required spellcheck="false" autocapitalize="none" /></label>
      <label class="flex flex-col gap-1 text-sm">{{ t('coco.usageRuleTarget') }}<select v-model="target" class="select w-full" :disabled="locked || !!savedAttempt"><option disabled value="">{{ t('coco.usageRuleChooseTarget') }}</option><option v-for="name in targets" :key="name" :value="name">{{ name }}</option></select></label>
      <div v-if="plan" class="space-y-2 rounded-lg bg-base-200 p-3 text-xs">
        <p class="break-all font-mono">{{ plan.rule }}</p>
        <p class="text-base-content/60">{{ t('coco.usageRulePriority') }}</p>
        <p v-if="plan.duplicate" role="status">{{ t('coco.usageRuleExists') }}</p>
        <div v-if="plan.conflicts.length" class="space-y-2 text-warning"><p>{{ t('coco.usageRuleConflict') }}</p><p v-for="entry in plan.conflicts" :key="entry.index" class="break-all font-mono">{{ entry.value }}</p><label class="flex items-start gap-2"><input v-model="replace" class="checkbox checkbox-sm" type="checkbox" :disabled="locked || !!savedAttempt" /><span>{{ t('coco.usageRuleReplace') }}</span></label></div>
      </div>
      <p v-else-if="payload && target" class="text-sm text-error">{{ t('coco.usageRuleInvalid') }}</p>
      <p v-if="workspace?.runMode !== 'rule' && workspace" class="text-xs text-warning">{{ t('coco.usageRuleModeHint') }}</p>
      <p v-if="view?.pending && !savedAttempt" class="text-xs text-warning">{{ t('coco.usageRuleExistingPending') }}</p>
      <p v-if="workspace && (workspace.revision !== revision || currentScope() !== scope) && !savedAttempt" class="text-xs text-warning">{{ t('coco.usageRuleChanged') }}</p>
      <p v-if="error" role="alert" class="text-sm text-error">{{ error }}</p>
      <p v-if="saving" role="status" class="text-sm">{{ t('coco.applyingSettings') }}</p>
      <NuxtLink v-if="!locked" to="/rules?tab=custom" class="link text-xs">{{ t('coco.usageRuleManage') }}</NuxtLink>
    </form>
    <template #actions>
      <button v-if="needsRead" type="button" class="btn btn-outline btn-sm" :disabled="locked" @click="reread"><IconRefresh :size="16" />{{ t('coco.anReloadStatus') }}</button>
      <button v-else-if="savedAttempt && view?.pending" type="button" class="btn btn-outline btn-sm" :disabled="locked" @click="submit(true)"><IconRefresh :size="16" />{{ t('coco.anRetryApply') }}</button>
      <button type="button" class="btn btn-ghost btn-sm" :disabled="locked" @click="panel?.close()"><IconX :size="16" />{{ t('coco.anCloseDialog') }}</button>
      <button v-if="!savedAttempt" type="button" class="btn btn-primary btn-sm" :disabled="!canSave" @click="submit()"><IconCheck :size="16" />{{ t('coco.anSaveChangesAndApply') }}</button>
    </template>
  </Modal>
</template>
