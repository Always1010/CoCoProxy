<script setup lang="ts">
import { IconAdjustments, IconArrowLeft, IconSettings, IconLink, IconPlus, IconTrash } from '@tabler/icons-vue'
import { localGroupNameError } from '~/utils/group-rules'

const { t, locale } = useI18n()
const catalogLabels: Record<string, string> = { Proxy: 'coco.pzCatalogProxy', Overseas: 'coco.pzCatalogOverseas', Domestic: 'coco.pzCatalogDomestic', Other: 'coco.pzCatalogOther' }
const catalogName = (id: string, fallback = id) => catalogLabels[id] ? t(catalogLabels[id]!) : fallback
const props = defineProps<{ activeGroup: string | null; configure?: (name: string, rules?: boolean) => void }>()
const { view, workspace, overrides, busy, run, save } = useWorkspace()
const proxyRefresh = useProxyRefresh()
const menu = ref<{ open: () => void; close: () => void }>()
const createKind = ref<'preset' | 'custom' | 'shared' | null>(null)
const customName = ref('')
const sharedName = ref('')
const available = computed(() => view.value?.catalog?.filter(service => !service.default && !view.value?.groups.some(group => group.name === service.id)) ?? [])
const deleting = ref<string | null>(null)
const deleteDialog = ref<{ open: () => void; close: (force?: boolean) => void }>()
function removalReason(name: string) {
  if (view.value?.catalog?.some(service => service.id === name && service.default)) return t('coco.pzThisFixedPolicyGroupCannotBeRemoved')
  const dependents = Object.entries(overrides.value.selections).filter(([group, target]) => group !== name && target === name).map(([group]) => group)
  if (dependents.length) return t('coco.pzUsedByChangeThosePolicyGroupsFirst', { groups: dependents.join(locale.value.startsWith('zh') ? '、' : ', ') })
  return ''
}
function requestRemove(name: string) {
  if (busy.value || removalReason(name)) return
  deleting.value = name
  deleteDialog.value?.open()
}
function configure(name: string, rules = false) {
  createKind.value = null
  props.configure?.(name, rules)
}
const customError = computed(() => customName.value.trim() && view.value ? localGroupNameError(customName.value, view.value, false, t) : '')
const sharedError = computed(() => sharedName.value.trim() && view.value ? localGroupNameError(sharedName.value, view.value, true, t) : '')

async function add(name: string, preset = false) {
  name = name.trim()
  if (!name || busy.value || !view.value) return
  if (preset ? !available.value.some(service => service.id === name) : localGroupNameError(name, view.value, false, t)) return
  await run(async () => {
    await save(settings => { settings.local.selections[name] = 'Proxy' }, preset ? 'coco.pzPresetServiceGroupAndBuiltInRulesEnabled' : 'coco.pzPolicyGroupCreatedAddMatchingRulesToContinue')
    customName.value = ''
    createKind.value = null
    await proxyRefresh.refresh()
    if (!preset) configure(name, true)
  })
}

function sharedDefault() {
  const selected = view.value?.groups.find(group => group.name === 'Proxy')?.selected
  return selected && (view.value?.nodes.includes(selected) || ['DIRECT', 'REJECT'].includes(selected))
    ? selected : view.value?.nodes[0] ?? 'REJECT'
}

async function addShared() {
  const name = sharedName.value.trim()
  if (!name || !view.value || localGroupNameError(name, view.value, true, t) || busy.value) return
  await run(async () => {
    await save(settings => {
      settings.local.sharedGroups = [...(settings.local.sharedGroups ?? []), name]
      settings.local.selections[name] = sharedDefault()
    })
    sharedName.value = ''
    createKind.value = null
    await proxyRefresh.refresh()
  })
}

async function remove() {
  const name = deleting.value
  if (!name || removalReason(name) || busy.value) return
  await run(async () => {
    await save(settings => {
      settings.local.rules = settings.local.rules.filter(rule => rule.split(',')[2] !== name && !(rule.startsWith('MATCH,') && rule.split(',')[1] === name))
      delete settings.local.selections[name]
      if (settings.local.automatic) delete settings.local.automatic[name]
      if (settings.local.sharedGroups?.includes(name)) {
        settings.local.sharedGroups = settings.local.sharedGroups.filter(group => group !== name)
        if (!settings.local.sharedGroups.length) delete settings.local.sharedGroups
      }
    })
    deleteDialog.value?.close(true)
    deleting.value = null
    await proxyRefresh.refresh()
  })
}
</script>

<template>
  <div v-if="workspace?.mode === 'local'" class="shrink-0 sm:w-full">
    <button class="btn btn-ghost btn-sm" :title="t('coco.pzManageGroups')" :aria-label="t('coco.pzManageGroups')" @click="createKind = null; menu?.open()"><IconAdjustments :size="18" /><span>{{ t('coco.pzManageGroups') }}</span></button>
    <Modal ref="menu" :title="t('coco.pzManageGroups')" compact :fixed-height="false">
      <template v-if="!createKind">
        <div class="mb-3 flex items-center justify-between gap-2"><span class="text-sm text-base-content/60">{{ t('coco.pzPolicyGroupCount', { count: view?.groups.length ?? 0 }) }}</span><button type="button" class="btn btn-primary min-h-11" @click="createKind = 'preset'"><IconPlus :size="16" /><span>{{ t('coco.pzAddPolicyGroup') }}</span></button></div>
        <ul class="divide-y divide-base-content/10">
          <li v-for="group in view?.groups" :key="group.name" class="py-1.5">
            <div class="flex min-h-11 items-center justify-between gap-2">
              <div class="flex min-w-0 flex-wrap items-baseline gap-x-2"><span class="break-all text-sm font-medium">{{ group.name }}</span><span class="text-xs text-base-content/50">{{ group.role === 'shared' ? t('coco.pzSharedOutbound') : t('coco.pzPolicyGroup') }}</span></div>
              <div class="flex shrink-0 items-center gap-1">
                <button v-if="props.configure" type="button" class="btn btn-ghost btn-sm" :disabled="busy" :aria-label="t('coco.pzConfigurePolicyGroup', { group: group.name })" @click="configure(group.name)"><IconSettings :size="16" /><span>{{ t('coco.pzSettings') }}</span></button>
                <HelpTip v-if="removalReason(group.name)" :label="t('coco.pzCannotRemove')">{{ removalReason(group.name) }}</HelpTip>
                <button v-else type="button" class="btn btn-ghost btn-sm text-error" :disabled="busy" :aria-label="t('coco.pzRemovePolicyGroup', { group: group.name })" @click="requestRemove(group.name)"><IconTrash :size="16" /><span>{{ t('coco.pzRemove') }}</span></button>
              </div>
            </div>
          </li>
        </ul>
      </template>
      <template v-else>
      <button type="button" class="btn btn-ghost btn-sm mb-3 min-h-11" @click="createKind = null"><IconArrowLeft :size="16" /><span>{{ t('coco.pzBackToGroupList') }}</span></button>
      <div class="mb-4 grid grid-cols-3 gap-1 rounded-xl bg-base-content/5 p-1" role="tablist" :aria-label="t('coco.pzPolicyGroupType')">
        <button v-for="item in [{ key: 'preset', label: t('coco.pzPresetServices'), icon: IconPlus }, { key: 'custom', label: t('coco.pzCustom'), icon: IconAdjustments }, { key: 'shared', label: t('coco.pzSharedOutbound'), icon: IconLink }]" :key="item.key" type="button" role="tab" class="btn btn-ghost min-h-11 px-2" :class="createKind === item.key ? 'bg-base-100 shadow-sm' : 'text-base-content/60'" :aria-selected="createKind === item.key" @click="createKind = item.key as typeof createKind"><component :is="item.icon" :size="16" /><span>{{ item.label }}</span></button>
      </div>
      <section v-if="createKind === 'preset'">
        <div class="flex items-center justify-between gap-2"><h3 class="text-sm font-semibold">{{ t('coco.pzEnableServiceGroup') }}</h3><HelpTip>{{ t('coco.pzIncludesDomainRulesOnceEnabledSelectAnOutboundFor') }}</HelpTip></div>
        <ul v-if="available.length" class="grid grid-cols-1 gap-2 sm:grid-cols-2"><li v-for="service in available" :key="service.id"><button class="btn btn-outline min-h-11 w-full justify-start border-base-content/10" :disabled="busy" @click="add(service.id, true)"><IconPlus :size="16" /><span>{{ catalogName(service.id, service.name) }}</span></button></li></ul>
        <p v-else class="py-6 text-center text-sm text-base-content/50">{{ t('coco.pzAllPresetServiceGroupsAreEnabled') }}</p>
      </section>
      <section v-else-if="createKind === 'custom'">
        <div class="flex items-center justify-between gap-2"><h3 class="text-sm font-semibold">{{ t('coco.pzCustomPolicyGroup') }}</h3><HelpTip>{{ t('coco.pzAddDomainRulesAfterCreationToSpecifyWhichWebsites') }}</HelpTip></div>
        <form class="flex flex-wrap gap-2" @submit.prevent="add(customName)">
          <input v-model="customName" class="input min-h-11 min-w-0 flex-1 basis-40" :aria-label="t('coco.pzCustomPolicyGroupName')" :placeholder="t('coco.pzGroupName')" maxlength="80" :disabled="busy" required />
          <button class="btn btn-primary min-h-11" type="submit" :disabled="busy || !customName.trim() || !!customError"><IconPlus :size="16" /><span>{{ t('coco.pzCreateAndConfigure') }}</span></button>
        </form>
        <p v-if="customError" role="alert" class="pt-2 text-xs text-error">{{ customError }}</p>
      </section>
      <section v-else>
        <div class="flex items-center justify-between gap-2"><h3 class="text-sm font-semibold">{{ t('coco.pzSharedOutboundGroup') }}</h3><HelpTip>{{ t('coco.pzReferencedByMultiplePolicyGroupsChooseANodeDirect') }}</HelpTip></div>
        <form class="flex flex-wrap gap-2" @submit.prevent="addShared">
          <input v-model="sharedName" class="input min-h-11 min-w-0 flex-1 basis-40" :aria-label="t('coco.pzSharedOutboundGroupName')" :placeholder="t('coco.pzGroupName')" maxlength="80" :disabled="busy" required />
          <button class="btn btn-primary min-h-11" type="submit" :disabled="busy || !sharedName.trim() || !!sharedError"><IconLink :size="16" /><span>{{ t('coco.pzCreateSharedOutbound') }}</span></button>
        </form>
        <p v-if="sharedError" role="alert" class="pt-2 text-xs text-error">{{ sharedError }}</p>
      </section>
      </template>
    </Modal>
    <Modal ref="deleteDialog" :title="t('coco.pzRemovePolicyGroup2')" compact :fixed-height="false" :close-disabled="busy">
      <p class="text-sm">{{ t('coco.pzConfirmRemoveGroup', { group: deleting }) }}</p>
      <p v-if="deleting && removalReason(deleting)" class="mt-2 text-sm text-error" role="alert">{{ removalReason(deleting) }}</p>
      <template #actions>
        <button type="button" class="btn btn-ghost btn-sm" :disabled="busy" @click="deleteDialog?.close()"><IconArrowLeft :size="16" /><span>{{ t('coco.pzCancel') }}</span></button>
        <button type="button" class="btn btn-error btn-sm" :disabled="busy || !deleting || !!removalReason(deleting)" @click="remove"><IconTrash :size="16" /><span>{{ t('coco.pzRemove') }}</span></button>
      </template>
    </Modal>
  </div>
</template>
