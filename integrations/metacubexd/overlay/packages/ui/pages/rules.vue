<script setup lang="ts">
import { IconChevronDown, IconChevronUp, IconDeviceFloppy, IconList, IconPlus, IconTrash } from '@tabler/icons-vue'
import { customRuleTargets, ruleTarget } from '~/utils/group-rules'
const { t } = useI18n()
useHead({ title: computed(() => t('coco.pzRulesCocoproxy')) })
const { view, workspace, overrides, busy, load, run, save, editOverrides } = useWorkspace()
const route = useRoute()
const tab = ref<'effective' | 'custom'>(route.query.tab === 'custom' ? 'custom' : 'effective')
const groupFilter = ref(typeof route.query.group === 'string' ? route.query.group : '')
watch(() => [route.query.tab, route.query.group], () => {
  tab.value = route.query.tab === 'custom' ? 'custom' : 'effective'
  groupFilter.value = typeof route.query.group === 'string' ? route.query.group : ''
})
const entries = ref<string[]>([])
const visibleEntries = computed(() => entries.value.map((value, index) => ({ value, index })).filter(entry => !groupFilter.value || ruleTarget(entry.value) === groupFilter.value))
const dirty = computed(() => JSON.stringify(entries.value) !== JSON.stringify(overrides.value.rules))
const targets = computed(() => customRuleTargets(workspace.value?.mode, view.value?.groups))
const catalogLabels: Record<string, string> = { Proxy: 'coco.pzCatalogProxy', Overseas: 'coco.pzCatalogOverseas', Domestic: 'coco.pzCatalogDomestic', Other: 'coco.pzCatalogOther' }
const catalogName = (id: string, fallback = id) => catalogLabels[id] ? t(catalogLabels[id]!) : fallback
const targetName = (name: string) => workspace.value?.mode === 'local' ? catalogName(name, view.value?.catalog?.find(service => service.id === name)?.name ?? name) : name
const type = ref('DOMAIN-SUFFIX')
const payload = ref('')
const target = ref('DIRECT')
watch(targets, available => { if (!available.includes(target.value)) target.value = 'DIRECT' })
const ruleTypes = ['DOMAIN', 'DOMAIN-SUFFIX', 'DOMAIN-KEYWORD', 'DOMAIN-REGEX', 'IP-CIDR', 'IP-CIDR6', 'SRC-IP-CIDR', 'SRC-IP-CIDR6', 'DST-PORT', 'SRC-PORT', 'NETWORK']
const payloadHint = computed(() => type.value.includes('CIDR') ? (type.value.endsWith('6') ? '2001:db8::/32' : '192.0.2.0/24') : type.value.endsWith('PORT') ? '443' : type.value === 'NETWORK' ? 'tcp / udp' : 'example.com')

watch(() => workspace.value?.revision, () => { entries.value = [...overrides.value.rules] }, { immediate: true })

function add() {
  if (!payload.value.trim() || !targets.value.includes(target.value)) return
  entries.value.push(`${type.value},${payload.value.trim()},${target.value}`)
  payload.value = ''
}

function move(index: number, offset: number) {
  const next = index + offset
  if (next < 0 || next >= entries.value.length) return
  const entry = entries.value.splice(index, 1)[0]!
  entries.value.splice(next, 0, entry)
}

async function saveRules() {
  if (!dirty.value) return
  await save(settings => { editOverrides(settings).rules = entries.value.map(value => value.trim()).filter(Boolean) })
}

onMounted(() => run(load))
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col gap-3">
    <WorkspaceToolbar :dirty="dirty"><template #actions><RuleTestPopover /></template></WorkspaceToolbar>
    <div role="tablist" class="tabs tabs-box w-fit shrink-0">
      <button role="tab" class="tab" :class="{ 'tab-active': tab === 'effective' }" :aria-selected="tab === 'effective'" @click="tab = 'effective'">{{ t('coco.pzEffectiveRules') }}</button>
      <button role="tab" class="tab" :class="{ 'tab-active': tab === 'custom' }" :aria-selected="tab === 'custom'" @click="tab = 'custom'">{{ t('coco.pzCustomRules') }}<span v-if="entries.length" class="badge badge-sm ml-2">{{ entries.length }}</span></button>
    </div>
    <div v-if="tab === 'effective' && groupFilter" class="flex shrink-0 flex-wrap items-center gap-2 text-sm">
      <span class="break-all">{{ t('coco.pzCurrentTarget') }}{{ targetName(groupFilter) }}</span>
      <button type="button" class="btn btn-ghost btn-sm min-h-11" @click="groupFilter = ''"><IconList :size="16" /><span>{{ t('coco.pzViewAllTargets') }}</span></button>
    </div>
    <NativeRules v-if="tab === 'effective'" :key="view?.active ?? 'initial'" :group="groupFilter" class="min-h-0 flex-1" />
    <div v-else class="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
      <label class="flex flex-wrap items-center gap-2 text-sm">{{ t('coco.pzFilterByTarget') }}<select v-model="groupFilter" class="select select-sm min-h-11" :aria-label="t('coco.pzFilterRulesByTarget')"><option value="">{{ t('coco.pzAllTargets') }}</option><option v-for="value in [...new Set([...targets, groupFilter].filter(Boolean))]" :key="value" :value="value">{{ targetName(value) }}</option></select><span class="text-xs text-base-content/60">{{ t('coco.pzRowNumbersAndMoveActionsFollowTheOrderOf') }}</span></label>
      <div class="flex items-center justify-between gap-2 px-1"><span class="text-xs text-base-content/50">{{ t('coco.pzMatchFirst') }} {{ workspace?.mode === 'local' ? t('coco.pzLocalRules') : t('coco.pzOverrideCurrentConfigurationOnly') }} {{ t('coco.pzChangesTakeEffectWhenSaved') }}</span><button class="btn btn-ghost btn-sm" :title="t('coco.pzSaveRulesAndApplyImmediately')" :aria-label="t('coco.pzSaveRules')" :disabled="!dirty || busy" @click="run(saveRules)"><IconDeviceFloppy :size="18" />{{ t('coco.pzSave') }}</button></div>
      <template v-if="workspace">
        <form class="flex flex-wrap items-center gap-2 rounded-xl border border-base-content/10 bg-base-200/60 p-3" @submit.prevent="add">
          <select v-model="type" class="select select-sm w-44" :aria-label="t('coco.pzRuleType')"><option v-for="value in ruleTypes" :key="value">{{ value }}</option></select>
          <input v-model="payload" class="input input-sm min-w-36 flex-1" :aria-label="t('coco.pzMatchValue')" :placeholder="payloadHint" required />
          <select v-model="target" class="select select-sm max-w-52 flex-1" :aria-label="t('coco.pzTargetPolicy')"><option v-for="value in targets" :key="value" :value="value">{{ targetName(value) }}</option></select>
          <button class="btn btn-primary btn-sm" type="submit" :title="t('coco.pzAddRule')" :aria-label="t('coco.pzAddRule')" :disabled="busy"><IconPlus :size="18" />{{ t('coco.pzAdd') }}</button>
        </form>
        <div v-if="!visibleEntries.length" class="space-y-2 py-8 text-center text-sm text-base-content/45">
          <p>{{ groupFilter ? t('coco.pzNoCustomRulesForThisTarget') : t('coco.pzNoCustomRules') }}</p>
          <p>{{ t('coco.pzViewBuiltInRulesUnderEffectiveRules') }}</p>
          <button type="button" class="btn btn-ghost btn-sm min-h-11" @click="tab = 'effective'"><IconList :size="16" /><span>{{ groupFilter ? t('coco.pzViewEffectiveRulesForThisGroup') : t('coco.pzViewEffectiveRules') }}</span></button>
        </div>
        <div v-for="{ index } in visibleEntries" :key="index" class="flex flex-wrap items-center gap-1 rounded-xl border border-base-content/8 bg-base-200/60 p-2">
          <span class="w-7 shrink-0 text-center text-xs text-base-content/35">{{ index + 1 }}</span>
          <input v-model="entries[index]" class="input input-ghost input-sm min-w-0 flex-1 font-mono text-xs" :aria-label="t('coco.pzRule', { number: index + 1 })" :disabled="busy" spellcheck="false" />
          <div class="ml-auto flex items-center gap-1">
            <button class="btn btn-ghost btn-xs" :title="t('coco.pzMoveUp')" :aria-label="t('coco.pzMoveRuleUp', { number: index + 1 })" :disabled="busy || index === 0" @click="move(index, -1)"><IconChevronUp :size="16" />{{ t('coco.pzMoveUp') }}</button>
            <button class="btn btn-ghost btn-xs" :title="t('coco.pzMoveDown')" :aria-label="t('coco.pzMoveRuleDown', { number: index + 1 })" :disabled="busy || index === entries.length - 1" @click="move(index, 1)"><IconChevronDown :size="16" />{{ t('coco.pzMoveDown') }}</button>
            <button class="btn btn-ghost btn-xs text-error" :title="t('coco.pzDelete')" :aria-label="t('coco.pzDeleteRule', { number: index + 1 })" :disabled="busy" @click="entries.splice(index, 1)"><IconTrash :size="16" />{{ t('coco.pzDelete') }}</button>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>
