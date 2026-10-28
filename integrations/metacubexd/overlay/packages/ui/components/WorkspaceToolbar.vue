<script setup lang="ts">
import { IconRefresh } from '@tabler/icons-vue'
import { CoCoProxyError, cocoproxyErrorMessage } from '~/composables/useCoCoProxy'
const { t } = useI18n()
defineProps<{ dirty?: boolean }>()
const { view, workspace, busy, error, feedback, operation, run, load, save, editOverrides } = useWorkspace()
const profiles = computed(() => view.value?.sources.filter(source => source.kind === 'profile') ?? [])
const visibleError = computed(() => error.value || (view.value?.error ? cocoproxyErrorMessage(new CoCoProxyError(view.value.error), t) : ''))

async function changeMode(event: Event) {
  const value = (event.target as HTMLSelectElement).value
  await run(() => save(settings => {
    settings.mode = value === 'local' ? 'local' : 'subscription'
    if (settings.mode === 'subscription' && !settings.subscriptionId)
      settings.subscriptionId = profiles.value[0]?.id ?? null
    if (settings.mode === 'local' && (settings.sourceIds.length !== 1 ||
      !view.value?.sources.some(source => source.snapshotCurrent && settings.sourceIds.includes(source.id)))) {
      const source = view.value?.sources.find(source => source.snapshotCurrent && source.id === settings.subscriptionId)
        ?? view.value?.sources.find(source => source.snapshotCurrent)
      if (source) settings.sourceIds = [source.id]
    }
  }))
}

async function resetInvalidSelections() {
  const names = view.value?.invalidSelections ?? []
  await run(() => save(settings => {
    const selections = editOverrides(settings).selections
    for (const name of names) delete selections[name]
  }))
}
</script>

<template>
  <div class="flex shrink-0 flex-col gap-2">
    <div class="flex flex-wrap items-center gap-2 rounded-xl border border-base-content/10 bg-base-200/60 p-2">
      <select class="select select-sm w-36" :aria-label="t('coco.pzConfigurationScheme')" :value="workspace?.mode ?? 'local'" :disabled="busy || !workspace || dirty" @change="changeMode">
        <option v-if="workspace?.mode === 'legacy'" value="legacy" disabled>{{ t('coco.pzExistingConfiguration') }}</option>
        <option value="local">{{ t('coco.pzLocalRuleTemplate') }}</option>
        <option value="subscription" :disabled="!profiles.length">{{ t('coco.pzSubscriptionConfiguration') }}</option>
      </select>
      <select class="select select-sm w-28" :aria-label="t('coco.pzRunMode')" :value="workspace?.runMode ?? 'rule'" :disabled="busy || !workspace || dirty" @change="run(() => save(settings => { settings.runMode = ($event.target as HTMLSelectElement).value as 'rule' | 'global' | 'direct' }))">
        <option value="rule">{{ t('coco.pzRule2') }}</option>
        <option value="global">{{ t('coco.pzGlobal') }}</option>
        <option value="direct">{{ t('coco.pzDirect') }}</option>
      </select>
      <span v-if="busy" role="status" class="flex items-center gap-2 text-xs text-base-content/65"><span class="loading loading-spinner loading-xs" />{{ operation || t('coco.pzLoading3') }}</span>
      <span v-else-if="dirty" class="badge badge-warning badge-sm">{{ t('coco.pzUnsavedRules') }}</span>
      <span v-else-if="view?.pending" class="badge badge-warning badge-sm">{{ t('coco.pzSettingsNotApplied') }}</span>
      <div class="ml-auto flex items-center gap-1">
        <slot name="actions" />
        <button class="btn btn-ghost btn-sm" :title="t('coco.pzRefresh')" :aria-label="t('coco.pzRefresh')" :disabled="busy" @click="run(load)"><IconRefresh :size="18" :class="{ 'animate-spin': busy }" />{{ t('coco.pzRefresh') }}</button>
      </div>
    </div>
    <div v-if="visibleError" role="alert" class="alert alert-error flex flex-wrap gap-2 py-2 text-sm"><span class="flex-1">{{ visibleError }}</span><button v-if="view?.invalidSelections?.length" class="btn btn-warning btn-sm" :disabled="busy" @click="resetInvalidSelections">{{ t('coco.pzResetInvalidSelections') }}</button></div>
    <div v-if="!busy && feedback && !visibleError" role="status" aria-live="polite" class="rounded-lg bg-success/10 px-3 py-2 text-sm text-success">{{ feedback }}</div>
    <div v-if="!busy && view?.pending" class="flex items-center gap-2 rounded-lg bg-warning/10 px-3 py-2 text-sm text-warning"><span class="flex-1">{{ t('coco.pzTheseSettingsHaveNotTakenEffectThePreviousConfiguration') }}</span><button class="btn btn-ghost btn-sm" :title="t('coco.pzRetryUnappliedSettings')" :aria-label="t('coco.pzRetryUnappliedSettings')" :disabled="!!view.error" @click="run(() => save(() => {}))"><IconRefresh :size="16" />{{ t('coco.pzRetry') }}</button></div>
  </div>
</template>
