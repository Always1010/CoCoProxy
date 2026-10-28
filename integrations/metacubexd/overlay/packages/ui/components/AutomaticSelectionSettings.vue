<script setup lang="ts">
import { IconAdjustments, IconArrowLeft, IconCheck, IconChevronDown, IconChevronRight, IconChevronUp, IconEdit, IconList, IconReload, IconSettings, IconWorld, IconX } from '@tabler/icons-vue'
import type { AutomaticStatus, AutoGroupPolicy, BandwidthSettings } from '~/composables/useWorkspace'
import { CoCoProxyError, cocoproxyErrorMessage } from '~/composables/useCoCoProxy'
import GroupMatchingRules from '~/components/GroupMatchingRules.vue'
import BandwidthSelectionSettings from '~/components/BandwidthSelectionSettings.vue'
import GroupSelectionStatus from '~/components/GroupSelectionStatus.vue'
import { bandwidthIssue, bandwidthPages } from '~/utils/group-bandwidth'
import type { BandwidthDefinitions, BandwidthPage } from '~/utils/group-bandwidth'
const { t } = useI18n()

const props = defineProps<{ groupName: string; selectable: boolean }>()
const { api, view, workspace, overrides, busy, run, save, load, editOverrides } = useWorkspace()
const proxyRefresh = useProxyRefresh()
const dialog = ref<{ open: () => void; close: (force?: boolean) => void }>()
const rulesEditor = ref<{ saving: boolean }>()
const sitesEditor = ref<{ dirty: boolean; saving: boolean }>()
const sitesVisited = ref(false)
const confirmClose = ref(false)
type Destination = { path: string; query: Record<string, string> }
const destination = ref<Destination>()
const saving = ref(false)
const saved = ref(false)
const saveError = useLocalizedMessage()
const refreshWarning = useLocalizedMessage()
const needsRead = ref(false)
const locked = computed(() => busy.value || saving.value || !!rulesEditor.value?.saving || !!sitesEditor.value?.saving)
const closeLocked = computed(() => saving.value || !!sitesEditor.value?.saving)
const enabled = ref(false)
const preferred = ref<string[]>([])
const fallback = ref<string[]>([])
const returnToPreferred = ref(true)
const bandwidth = ref<BandwidthSettings>()
const definitions = ref<BandwidthDefinitions>()
const definitionsLoading = ref(false)
const definitionsError = useLocalizedMessage()
const search = ref('')
type PoolKind = 'preferred' | 'fallback'
const editorKind = ref<PoolKind | null>(null)
const onlySelected = ref(false)
const editorSelected = ref<string[]>([])
const expanded = ref({ preferred: false, fallback: false })
const initialDraft = ref('')
const visible = ref(false)
const fromManager = ref(false)
type SettingsPage = 'selection' | 'pool' | 'advanced' | 'status' | 'rules' | 'sites' | BandwidthPage
const tab = ref<SettingsPage>('selection')
const directoryOpen = ref(true)
const tunePages = bandwidthPages.filter(page => page.id !== 'bandwidth' && page.id !== 'budget')
const autoPages = [
  { id: 'selection', label: 'coco.anAutomaticSelection', description: 'coco.anAutomaticallyManageTheExitUsingThis' },
  { id: 'pool', label: 'coco.anCandidateNodes', description: 'coco.anAutomaticSelectionUsesOnlyTheNodes' },
  ...bandwidthPages.filter(page => page.id === 'bandwidth'),
] as const
const otherPages = computed(() => [
  ...(props.selectable ? [{ id: 'status' as const, label: 'coco.anOperationStatus', description: 'coco.anViewChecksUsageAndSwitchRecords' }] : []),
  ...(workspace.value?.mode === 'local' ? [{ id: 'rules' as const, label: 'coco.anMatchingRules', description: 'coco.anManageTheRulesThatRouteTraffic' }] : []),
  { id: 'sites' as const, label: 'coco.anSiteConnectivity', description: 'coco.anChooseTargetsForThisGroupS' },
])
const allPages = computed(() => [...autoPages, ...otherPages.value, ...bandwidthPages,
  { id: 'advanced', label: 'coco.anAdvancedParameters', description: 'coco.anTheseParametersApplyOnlyToBandwidth' }])
const currentPage = computed(() => allPages.value.find(page => page.id === tab.value))
const bandwidthPage = computed(() => bandwidthPages.find(page => page.id === tab.value))
const auxiliaryPage = computed(() => !!bandwidthPage.value || tab.value === 'advanced')
const activeNavigation = computed(() => auxiliaryPage.value ? 'bandwidth' : tab.value)
const effectiveBandwidth = computed(() => bandwidth.value ?? definitions.value?.defaults)
const configurationPage = computed(() => tab.value !== 'status' && tab.value !== 'rules' && tab.value !== 'sites')
const statusError = useLocalizedMessage()
const status = ref<AutomaticStatus>()
const statusReading = ref(false)
const statusChecking = ref(false)
let timer: ReturnType<typeof setTimeout> | undefined
let reading = false
let statusRequest = 0
let disposed = false
let session = 0

const nodes = computed(() => {
  const realNodes = new Set(view.value?.nodes ?? [])
  return [...new Set(view.value?.groups.find(group => group.name === props.groupName)?.options ?? [])]
    .filter(name => realNodes.has(name) && !/^(DIRECT|REJECT|REJECT-DROP|PASS|COMPATIBLE)$/i.test(name))
})
const totalSelected = computed(() => preferred.value.length + fallback.value.length)
function draftSignature() { return JSON.stringify([enabled.value, preferred.value, fallback.value, returnToPreferred.value, bandwidth.value ?? null]) }
const changed = computed(() => draftSignature() !== initialDraft.value)
const dirtyTabs = computed(() => [
  changed.value && props.selectable ? t('coco.anAutomaticSelectionSettings') : '',
  sitesEditor.value?.dirty ? t('coco.anSiteConnectivity') : '',
].filter(Boolean))
function beforeClose() {
  if (closeLocked.value) return false
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
function selectTab(value: SettingsPage) {
  if (locked.value) return
  if (!enabled.value && !['selection', 'status', 'rules', 'sites'].includes(value)) return
  if ((value === 'advanced' || bandwidthPages.some(page => page.id === value && page.id !== 'bandwidth')) && !effectiveBandwidth.value?.enabled) return
  tab.value = value
  editorKind.value = null
  directoryOpen.value = false
  if (value === 'sites') sitesVisited.value = true
  if (value === 'status') void readStatus()
}
function pageDirty(page: string, descendants = false): boolean {
  if (page === 'sites') return !!sitesEditor.value?.dirty
  if (page === 'advanced') return tunePages.some(item => pageDirty(item.id))
  if (page === 'bandwidth' && descendants) return bandwidthPages.some(item => pageDirty(item.id))
  if (!initialDraft.value) return false
  const initial = JSON.parse(initialDraft.value) as [boolean, string[], string[], boolean, BandwidthSettings | null]
  if (page === 'selection') return enabled.value !== initial[0] || returnToPreferred.value !== initial[3]
  if (page === 'pool') return JSON.stringify([preferred.value, fallback.value]) !== JSON.stringify([initial[1], initial[2]])
  const section = bandwidthPages.find(item => item.id === page)
  if (!section) return false
  const current = bandwidth.value ?? definitions.value?.defaults
  const previous = initial[4] ?? definitions.value?.defaults
  const keys: readonly string[] = page === 'bandwidth' ? [...section.keys, 'enabled', 'observeOnly'] : section.keys
  return keys.some(key => current?.[key] !== previous?.[key])
}
function pageInvalid(page: string) { return invalidPage.value === page || (page === 'bandwidth' && !!bandwidthError.value) }
function customCount(page: BandwidthPage) {
  const keys = bandwidthPages.find(item => item.id === page)?.keys ?? []
  return keys.filter(key => effectiveBandwidth.value?.[key] !== definitions.value?.defaults[key]).length
}
function locateInvalid() {
  if (!invalidPage.value) return
  if (!enabled.value) { selectTab('selection'); void nextTick(() => document.getElementById('group-automatic-enabled')?.focus()); return }
  if (invalidPage.value !== 'pool' && !effectiveBandwidth.value?.enabled) { selectTab('bandwidth'); void nextTick(() => document.getElementById('group-bandwidth-enabled')?.focus()); return }
  selectTab(invalidPage.value)
  const key = invalidPage.value === bandwidthError.value?.page ? bandwidthError.value?.key : undefined
  void nextTick(() => document.getElementById(key ? `group-bandwidth-${key}` : 'group-settings-page')?.focus())
}
const editingPool = computed(() => editorKind.value === 'fallback' ? fallback.value : preferred.value)
const otherPool = computed(() => editorKind.value === 'fallback' ? preferred.value : fallback.value)
const editorLabel = computed(() => editorKind.value === 'fallback' ? t('coco.anFallback') : t('coco.anPreferred'))
const otherLabel = computed(() => editorKind.value === 'fallback' ? t('coco.anPreferred') : t('coco.anFallback'))
const visibleNodes = computed(() => {
  const candidates = [...new Set([...nodes.value, ...editingPool.value, ...otherPool.value])]
    .filter(name => name.toLocaleLowerCase().includes(search.value.toLocaleLowerCase()))
    .filter(name => !onlySelected.value || editingPool.value.includes(name) || editorSelected.value.includes(name))
  return [...candidates.filter(name => !otherPool.value.includes(name)), ...candidates.filter(name => otherPool.value.includes(name))]
})
function pool(kind: PoolKind) { return kind === 'preferred' ? preferred.value : fallback.value }
function editPool(kind: PoolKind) {
  if (locked.value || !enabled.value) return
  tab.value = 'pool'
  editorKind.value = kind
  directoryOpen.value = false
  search.value = ''
  onlySelected.value = false
  editorSelected.value = [...pool(kind)]
}
function nodeDisabled(name: string) {
  return locked.value || !enabled.value || otherPool.value.includes(name)
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
const bandwidthError = computed(() => bandwidthIssue(bandwidth.value, definitions.value, overrides.value.automatic ?? {}, props.groupName, enabled.value, t))
const invalidPage = computed<SettingsPage | undefined>(() => {
  if (!enabled.value) return bandwidthError.value?.page
  if (!preferred.value.length || totalSelected.value > 32 || [...preferred.value, ...fallback.value].some(name => !nodes.value.includes(name)) || preferred.value.some(name => fallback.value.includes(name))) return 'pool'
  return bandwidthError.value?.page
})
const invalid = computed(() => {
  if (!enabled.value) return bandwidthError.value?.message ?? ''
  if (!preferred.value.length) return t('coco.anSelectAtLeastOnePreferredNode')
  if (preferred.value.length + fallback.value.length > 32) return t('coco.anPreferredAndFallbackPoolsMayContain')
  if ([...preferred.value, ...fallback.value].some(name => !nodes.value.includes(name))) return t('coco.anSomeNodesAreNoLongerIn')
  if (preferred.value.some(name => fallback.value.includes(name))) return t('coco.anPreferredAndFallbackPoolsCannotContain')
  if (bandwidthError.value) return bandwidthError.value.message
  return ''
})
const savedPolicy = computed(() => overrides.value.automatic?.[props.groupName])

async function readDefinitions() {
  if (definitionsLoading.value) return
  const requestSession = session
  definitionsLoading.value = true; definitionsError.value = ''
  try {
    const result = await api.request<{ bandwidth: BandwidthDefinitions }>('/api/cocoproxy/automatic/probes')
    if (visible.value && !disposed && requestSession === session) definitions.value = result.bandwidth
  } catch (cause) { if (visible.value && !disposed && requestSession === session) definitionsError.value = () => cocoproxyErrorMessage(cause, t) }
  finally { if (requestSession === session) definitionsLoading.value = false }
}

async function readStatus(background = false) {
  if ((reading && background) || statusChecking.value || disposed || !visible.value || document.hidden || tab.value !== 'status' || !props.selectable) return
  const requestSession = session
  const id = ++statusRequest
  reading = true; statusReading.value = !background
  try {
    const result = await api.request<AutomaticStatus>('/api/cocoproxy/automatic/status')
    if (visible.value && !disposed && requestSession === session && id === statusRequest) { status.value = result; statusError.value = '' }
  } catch (cause) {
    if (visible.value && !disposed && requestSession === session && id === statusRequest) statusError.value = () => cocoproxyErrorMessage(cause, t)
  } finally { if (requestSession === session && id === statusRequest) { reading = false; statusReading.value = false } }
}
function checkingStatus(value: boolean) {
  statusChecking.value = value
  if (value) { statusRequest++; reading = false; statusReading.value = false }
}
async function refreshStatus(requestSession: number) {
  await readStatus(true)
  if (visible.value && !disposed && requestSession === session) timer = setTimeout(() => { void refreshStatus(requestSession) }, 8000)
}
function close() {
  session++
  visible.value = false
  reading = false
  statusReading.value = false
  statusChecking.value = false
  definitionsLoading.value = false
  if (timer) clearTimeout(timer)
}
function open() {
  if (timer) clearTimeout(timer)
  reading = false
  statusReading.value = false
  statusChecking.value = false
  definitionsLoading.value = false
  fromManager.value = false
  confirmClose.value = false
  destination.value = undefined
  sitesVisited.value = false
  saved.value = false
  saveError.value = ''
  refreshWarning.value = ''
  needsRead.value = false
  tab.value = props.selectable ? 'selection' : 'sites'
  sitesVisited.value = !props.selectable
  directoryOpen.value = true
  editorKind.value = null
  expanded.value = { preferred: false, fallback: false }
  const policy = overrides.value.automatic?.[props.groupName]
  enabled.value = !!policy && policy.enabled !== false
  preferred.value = [...(policy?.preferred ?? [])]
  fallback.value = [...(policy?.fallback ?? [])]
  returnToPreferred.value = policy?.returnToPreferred ?? true
  bandwidth.value = policy?.bandwidth ? JSON.parse(JSON.stringify(policy.bandwidth)) as BandwidthSettings : undefined
  initialDraft.value = draftSignature()
  search.value = ''
  statusError.value = ''
  status.value = view.value?.automatic
  visible.value = true
  dialog.value?.open()
  void refreshStatus(++session)
  if (props.selectable) void readDefinitions()
}
function openSites() { open(); selectTab('sites') }
function openRules() { open(); selectTab('rules') }
function openFromManager(rules = false) { open(); fromManager.value = true; if (rules) selectTab('rules') }
defineExpose({ open, openSites, openRules, openFromManager })
async function persist() {
  if (editorKind.value || invalid.value || locked.value || !changed.value || needsRead.value) return
  saving.value = true
  saveError.value = ''; refreshWarning.value = ''
  try {
    await run(async () => {
      try {
        const policy: AutoGroupPolicy = { enabled: enabled.value, preferred: [...preferred.value], fallback: [...fallback.value], returnToPreferred: returnToPreferred.value }
        if (bandwidth.value) policy.bandwidth = JSON.parse(JSON.stringify(bandwidth.value)) as BandwidthSettings
        await save(settings => {
          const target = editOverrides(settings)
          target.automatic ??= {}
          target.automatic[props.groupName] = policy
          if (!enabled.value) {
            const current = view.value?.groups.find(group => group.name === props.groupName)?.activeSelected
            if (current && nodes.value.includes(current)) target.selections[props.groupName] = current
          }
        }, 'coco.anAutomaticSelectionSettingsSavedAndApplied')
        initialDraft.value = draftSignature()
        saved.value = true
      } catch (cause) {
        saveError.value = () => cocoproxyErrorMessage(cause, t)
        needsRead.value = cause instanceof CoCoProxyError && ['NETWORK_UNKNOWN', 'MANAGEMENT_UNAVAILABLE', 'CONFIRM_FAILED', 'WORKSPACE_CONFLICT'].includes(cause.code)
        return
      }
      try {
        await proxyRefresh.refresh()
        if (proxyRefresh.error.value) refreshWarning.value = () => t('coco.anAutomaticSelectionSettingsAreActiveBut')
      } catch { refreshWarning.value = () => t('coco.anAutomaticSelectionSettingsAreActiveBut') }
    })
  } finally { saving.value = false }
}
async function reread() {
  if (locked.value) return
  saving.value = true
  try {
    await load()
    const policy = overrides.value.automatic?.[props.groupName]
    const current = JSON.stringify([!!policy && policy.enabled !== false, policy?.preferred ?? [], policy?.fallback ?? [], policy?.returnToPreferred ?? true, policy?.bandwidth ?? null])
    if (current === draftSignature() && !view.value?.pending) {
      initialDraft.value = current; saved.value = true; saveError.value = ''
    } else saveError.value = () => t('coco.anStatusReloadedTheChangesHaveNot')
    needsRead.value = false
  } catch (cause) { saveError.value = () => cocoproxyErrorMessage(cause, t) }
  finally { saving.value = false }
}
watch(draftSignature, () => { saveError.value = ''; refreshWarning.value = '' })
watch(enabled, value => { if (!value && configurationPage.value && tab.value !== 'selection') selectTab('selection') })
watch(() => effectiveBandwidth.value?.enabled, value => { if (!value && auxiliaryPage.value && tab.value !== 'bandwidth') selectTab('bandwidth') })
watch(() => props.groupName, () => { dialog.value?.close(true); close() })
watch(() => JSON.stringify([view.value?.workspace.mode, view.value?.workspace.subscriptionId, view.value?.workspace.sourceIds]), () => { dialog.value?.close(true); close() })
onUnmounted(() => { disposed = true; close() })
</script>

<template>
  <span class="shrink-0">
    <button type="button" class="btn btn-ghost btn-sm" :aria-label="t('coco.anSettingsForGroup', { value: groupName })" @click="open"><IconSettings :size="18" /><span>{{ t('coco.anGroupSettings') }}</span></button>
  </span>
  <Modal ref="dialog" compact settings-layout :settings-directory="directoryOpen && !confirmClose" :title="t('coco.anGroupSettings2', { value: groupName })" :before-close="beforeClose" :close-disabled="closeLocked" @close="close">
    <template #tabs>
      <nav class="group-settings-nav space-y-5" :aria-label="t('coco.anGroupSettingsDirectory')">
        <button v-if="fromManager" type="button" class="btn btn-ghost min-h-11 w-full justify-start" :disabled="locked || confirmClose" @click="dialog?.close()"><IconArrowLeft :size="16" /><span>{{ t('coco.anBackToGroupList') }}</span></button>
        <section v-if="selectable">
          <div role="tablist" :aria-label="t('coco.anAutomaticSelectionSettings')">
            <button v-for="page in autoPages.filter(page => enabled || page.id === 'selection')" :key="page.id" type="button" role="tab" class="btn btn-ghost min-h-11" :class="{ 'automatic-child': page.id !== 'selection' }" :disabled="locked || confirmClose" :aria-selected="activeNavigation === page.id" :aria-controls="'group-settings-page'" @click="selectTab(page.id)">
              <IconSettings :size="16" /><span>{{ t(page.label) }}</span><span v-if="pageInvalid(page.id)" class="ml-auto text-error" :aria-label="t('coco.anConfigurationError')">!</span><span v-else-if="pageDirty(page.id, true)" class="ml-auto text-warning" :aria-label="t('coco.anUnsavedChanges')">●</span>
            </button>
          </div>
        </section>
        <section>
          <h3 class="nav-heading">{{ t('coco.anChecksAndRules') }}</h3>
          <div role="tablist" :aria-label="t('coco.anChecksAndRules')">
            <button v-for="page in otherPages" :key="page.id" type="button" role="tab" class="btn btn-ghost min-h-11" :disabled="locked || confirmClose" :aria-selected="tab === page.id" aria-controls="group-settings-page" @click="selectTab(page.id)">
              <IconWorld v-if="page.id === 'sites'" :size="16" /><IconList v-else :size="16" /><span>{{ t(page.label) }}</span><span v-if="pageDirty(page.id)" class="ml-auto text-warning" :aria-label="t('coco.anUnsavedChanges')">●</span>
            </button>
          </div>
        </section>
      </nav>
    </template>
    <template #content>
      <div v-if="confirmClose" role="alertdialog" :aria-label="t('coco.anDiscardUnsavedChanges')" class="flex min-h-0 flex-1 flex-col justify-center gap-4 overflow-y-auto">
        <p class="text-sm">{{ t('coco.anHasUnsavedChangesChoosingWillDiscard', { value: dirtyTabs.join('、'), value2: destination ? t('coco.anLeave') : t('coco.anClose') }) }}</p>
        <div class="flex flex-wrap justify-end gap-2"><button type="button" class="btn btn-ghost min-h-11" @click="continueEditing"><IconArrowLeft :size="16" /><span>{{ t('coco.anContinueEditing') }}</span></button><button type="button" class="btn btn-error min-h-11" :disabled="locked" @click="discardAndClose"><IconX :size="16" /><span>{{ destination ? t('coco.anDiscardAndLeave') : t('coco.anDiscardAndClose') }}</span></button></div>
      </div>
      <div v-show="!confirmClose" id="group-settings-page" class="flex min-h-0 flex-1 flex-col gap-3" role="tabpanel" :aria-label="currentPage ? t(currentPage.label) : undefined" tabindex="-1">
        <button type="button" class="mobile-directory-back btn btn-ghost min-h-11 self-start" :disabled="locked" @click="directoryOpen = true"><IconArrowLeft :size="16" /><span>{{ t('coco.anSettingsDirectory') }}</span></button>
        <header class="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-base-content/10 pb-3">
          <div class="min-w-0 space-y-1">
            <p v-if="auxiliaryPage && tab !== 'bandwidth'" class="break-words text-xs text-base-content/55">{{ t('coco.anAutomaticSelectionAssistedDecisions', { value: tunePages.some(page => page.id === tab) ? t('coco.anAdvancedParameters2') : '' }) }}</p>
            <h2 class="text-base font-semibold">{{ editorKind ? t('coco.anEditCandidatePool', { pool: editorLabel }) : currentPage ? t(currentPage.label) : '' }}</h2>
          </div>
          <HelpTip v-if="currentPage?.description" :label="t('coco.anPageHelp')">{{ t(currentPage.description) }}</HelpTip>
        </header>
        <SettingsNotice v-if="!configurationPage && changed" warning class="shrink-0">{{ t('coco.anAutomaticSelectionSettingsHaveUnsavedChanges') }}<button type="button" class="btn btn-ghost btn-xs" :disabled="locked" @click="selectTab('selection')"><IconEdit :size="14" /><span>{{ t('coco.anBackToConfigureAndSave') }}</span></button></SettingsNotice>
        <GroupMatchingRules v-if="visible && workspace?.mode === 'local'" ref="rulesEditor" v-show="tab === 'rules'" :group-name="groupName" @navigate="requestNavigation" />
        <SiteTargetSettings v-if="visible && sitesVisited" ref="sitesEditor" v-show="tab === 'sites'" :group-name="groupName" :scroll-list="false" />
        <div v-if="tab === 'status'" class="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]">
          <GroupSelectionStatus :key="groupName" :group-name="groupName" :status="status" :policy-enabled="!!savedPolicy && savedPolicy.enabled !== false" :bandwidth="savedPolicy?.bandwidth" :dirty="changed || needsRead" :disabled="locked" :reading="statusReading" :error="statusError" @refresh="readStatus()" @checking="checkingStatus" />
        </div>
        <template v-if="configurationPage && selectable">
          <div class="settings-page-scroll min-h-0 flex-1 space-y-5 overflow-y-auto [scrollbar-gutter:stable]">
            <button v-if="auxiliaryPage && tab !== 'bandwidth'" type="button" class="btn btn-ghost min-h-11" :disabled="locked" @click="selectTab(tunePages.some(page => page.id === tab) ? 'advanced' : 'bandwidth')"><IconArrowLeft :size="16" /><span>{{ tunePages.some(page => page.id === tab) ? t('coco.anBackToAdvancedParameters') : t('coco.anBackToAssistedDecisions') }}</span></button>
            <template v-if="tab === 'selection'">
              <label class="flex min-h-11 items-center justify-between gap-4 text-sm font-medium">{{ t('coco.anEnableAutomaticSelection') }}<input id="group-automatic-enabled" v-model="enabled" type="checkbox" class="toggle toggle-primary" :disabled="locked" /></label>
              <HelpTip :label="t('coco.anAboutAutomaticSelection')">{{ t('coco.anAutomaticallyChooseAnExitFromSelected') }}</HelpTip>
              <SettingsNotice v-if="!enabled">{{ t('coco.anAfterSavingAutomaticSelectionStopsAnd') }}</SettingsNotice>
              <div v-else class="automatic-options space-y-5 pl-4">
                <div class="space-y-1">
                  <label class="flex min-h-11 items-center justify-between gap-4 text-sm">{{ t('coco.anReturnAutomaticallyWhenPreferredNodesRecover') }}<input v-model="returnToPreferred" type="checkbox" class="toggle toggle-primary" :disabled="locked" /></label>
                  <HelpTip :label="t('coco.anAboutReturningToPreferred')">{{ t('coco.anControlsDedicatedPreferredRecoveryChecksWith') }}</HelpTip>
                </div>
                <div class="space-y-2 border-t border-base-content/10 pt-4">
                <button type="button" class="summary-link btn btn-ghost min-h-11 w-full justify-between" :disabled="locked" @click="selectTab('pool')"><span>{{ t('coco.anPreferredFallback', { value: preferred.length, value2: fallback.length }) }}</span><span class="flex items-center gap-1"><IconEdit :size="16" />{{ t('coco.anConfigureCandidates') }}</span></button>
                <button type="button" class="summary-link btn btn-ghost min-h-11 w-full justify-between" :disabled="locked" @click="selectTab('bandwidth')"><span>{{ t('coco.anBandwidthAssistedDecisions', { value: !bandwidth?.enabled ? t('coco.anOff') : bandwidth.observeOnly ? t('coco.anObserveOnly') : t('coco.anOn') }) }}</span><span class="flex items-center gap-1"><IconEdit :size="16" />{{ t('coco.anAssistedDecisions') }}</span></button>
              </div>
              </div>
            </template>
            <template v-else-if="tab === 'pool' && !editorKind">
              <section v-for="kind in (['preferred', 'fallback'] as const)" :key="kind" class="border-b border-base-content/10 pb-4" :aria-label="kind === 'preferred' ? t('coco.anPreferredNodes') : t('coco.anFallbackNodes')">
                <div class="flex items-center justify-between gap-2">
                  <h3 class="text-sm font-medium">{{ t('coco.anNodes', { value: kind === 'preferred' ? t('coco.anPreferred') : t('coco.anFallback'), value2: pool(kind).length }) }}</h3>
                  <button type="button" class="btn btn-ghost btn-sm min-h-11 shrink-0" :disabled="locked" @click="editPool(kind)"><IconEdit :size="16" /><span>{{ t('coco.anEdit', { value: kind === 'preferred' ? t('coco.anPreferred') : t('coco.anFallback') }) }}</span></button>
                </div>
                <HelpTip :label="kind === 'preferred' ? t('coco.anAboutPreferredNodes') : t('coco.anAboutFallbackNodes')">{{ kind === 'preferred' ? t('coco.anCandidatesToUseFirst') : t('coco.anBackupCandidatesWhenPreferredNodesAre') }}</HelpTip>
                <ul v-if="pool(kind).length" class="space-y-1">
                  <li v-for="name in (expanded[kind] ? pool(kind) : pool(kind).slice(0, 4))" :key="name" class="min-w-0 break-all py-1 text-sm" :class="!nodes.includes(name) ? 'text-warning' : ''">{{ name }}{{ !nodes.includes(name) ? t('coco.anNoLongerInThisGroup') : '' }}</li>
                </ul>
                <p v-else class="py-2 text-sm text-base-content/50">{{ t('coco.anNoNodesConfigured', { value: kind === 'preferred' ? t('coco.anPreferred') : t('coco.anFallback') }) }}</p>
                <button v-if="pool(kind).length > 4" type="button" class="btn btn-ghost btn-sm mt-2 min-h-11" :aria-expanded="expanded[kind]" @click="expanded[kind] = !expanded[kind]"><IconChevronUp v-if="expanded[kind]" :size="16" /><IconChevronDown v-else :size="16" /><span>{{ t(expanded[kind] ? 'coco.anCollapseCandidatePool' : 'coco.anExpandCandidatePool', { count: pool(kind).length - 4, pool: kind === 'preferred' ? t('coco.anPreferred') : t('coco.anFallback') }) }}</span></button>
              </section>
              <SettingsNotice>{{ t('coco.anSelectedAtLeastPreferredNodePools', { value: totalSelected }) }}</SettingsNotice>
            </template>
            <template v-else-if="tab === 'pool' && editorKind">
              <button type="button" class="btn btn-ghost min-h-11" :disabled="locked" @click="editorKind = null"><IconArrowLeft :size="16" /><span>{{ t('coco.anBackToCandidateSummary') }}</span></button>
              <HelpTip :label="t('coco.anSelectionHelp')">{{ t('coco.anSelectANodeToAddIt', { value: editorLabel, value2: otherLabel }) }}</HelpTip>
              <input v-model="search" type="search" class="input min-h-11 w-full" :placeholder="t('coco.anSearchNodeNames')" :aria-label="t('coco.anSearchCandidatePool', { pool: editorLabel })" />
              <div class="flex flex-wrap gap-2" role="group" :aria-label="t('coco.anNodeFilter')">
                <button type="button" class="btn btn-sm min-h-11" :class="!onlySelected ? 'btn-primary' : 'btn-ghost'" :aria-pressed="!onlySelected" @click="onlySelected = false"><IconList :size="16" /><span>{{ t('coco.anAllNodes') }}</span></button>
                <button type="button" class="btn btn-sm min-h-11" :class="onlySelected ? 'btn-primary' : 'btn-ghost'" :aria-pressed="onlySelected" @click="onlySelected = true"><IconCheck :size="16" /><span>{{ t('coco.anSelectedOnly', { value: editingPool.length }) }}</span></button>
              </div>
              <p v-if="totalSelected >= 32" class="text-xs text-warning">{{ t('coco.anTheLimitOfNodesHasBeen') }}</p>
              <div class="space-y-1" :aria-label="t('coco.anCandidatePoolEditor', { pool: editorLabel })">
                <label v-for="name in visibleNodes" :key="name" class="flex min-h-11 items-center gap-3 border-b border-base-content/5 py-3 text-sm" :class="nodeDisabled(name) ? 'cursor-not-allowed text-base-content/40' : 'cursor-pointer'">
                  <input type="checkbox" class="checkbox checkbox-primary checkbox-sm shrink-0" :checked="editingPool.includes(name)" :disabled="nodeDisabled(name)" :aria-label="t('coco.anCandidateCheckbox', { pool: editorLabel, node: name })" @change="toggleNode(name)" />
                  <span class="min-w-0 break-all">{{ name }}<span v-if="otherPool.includes(name)" class="mt-1 block text-xs">{{ t('coco.anAlreadyInCannotSelect', { value: otherLabel }) }}</span><span v-else-if="!nodes.includes(name)" class="mt-1 block text-xs text-warning">{{ t('coco.anNoLongerInThisGroupDeselect') }}</span></span>
                </label>
                <p v-if="!visibleNodes.length" class="py-3 text-sm text-base-content/50">{{ search ? t('coco.anNoMatchingNodes') : onlySelected ? t('coco.anNoNodesSelected') : t('coco.anNoIndividualNodesAvailable') }}</p>
              </div>
            </template>
            <template v-else-if="tab === 'advanced'">
              <SettingsNotice>{{ t('coco.anTheseParametersApplyOnlyToBandwidth') }}</SettingsNotice>
              <div class="divide-y divide-base-content/10">
                <button v-for="page in tunePages" :key="page.id" type="button" class="parameter-link btn btn-ghost min-h-11 w-full justify-between" :disabled="locked" @click="selectTab(page.id)">
                  <span class="flex min-w-0 items-start gap-2 text-left"><IconAdjustments :size="16" class="mt-0.5 shrink-0" /><span><span class="block">{{ t(page.label) }}<span v-if="pageInvalid(page.id)" class="ml-2 text-error">{{ t('coco.anConfigurationError') }}</span><span v-else-if="pageDirty(page.id)" class="ml-2 text-warning">{{ t('coco.anUnsaved') }}</span></span><span class="mt-1 block text-xs font-normal text-base-content/60">{{ t(page.summary) }}{{ customCount(page.id) ? t('coco.anCustomizedCountSuffix', { count: customCount(page.id) }) : '' }}</span></span></span>
                  <span class="flex shrink-0 items-center gap-1 text-xs">{{ t('coco.anOpen') }}<IconChevronRight :size="14" /></span>
                </button>
              </div>
            </template>
            <template v-else-if="bandwidthPage">
              <p v-if="definitionsLoading" role="status" class="text-sm">{{ t('coco.anLoadingParameters') }}</p>
              <div v-if="definitionsError" class="space-y-2 text-sm text-warning"><p role="alert">{{ definitionsError }}</p><button type="button" class="btn btn-ghost min-h-11" :disabled="locked || definitionsLoading" @click="readDefinitions"><IconReload :size="16" /><span>{{ t('coco.anReloadParameters') }}</span></button></div>
              <BandwidthSelectionSettings v-if="definitions" :key="tab" v-model="bandwidth" :definitions="definitions" :page="bandwidthPage.id" :disabled="locked || !enabled" :issue="bandwidthError" @navigate="selectTab" />
              <button v-if="tab === 'budget'" type="button" class="btn btn-ghost min-h-11" :disabled="locked" @click="selectTab('status')"><IconList :size="16" /><span>{{ t('coco.anViewOperationUsage') }}</span></button>
            </template>
          </div>
          <div class="shrink-0 space-y-2 border-t border-base-content/10 pt-3">
            <template v-if="editorKind">
              <div class="flex flex-wrap items-center justify-between gap-2 text-xs text-base-content/65"><span>{{ t('coco.anNodesTotal', { value: editorLabel, value2: editingPool.length, value3: totalSelected }) }}</span><button type="button" class="btn btn-ghost min-h-11" :disabled="locked" @click="editorKind = null"><IconCheck :size="16" /><span>{{ t('coco.anFinishSelection') }}</span></button></div>
            </template>
            <template v-else>
              <div class="text-xs" aria-live="polite">
                <p v-if="saving" role="status">{{ t('coco.anSavingOrVerifyingAutomaticSelectionSettings') }}</p>
                <p v-else-if="saveError || needsRead || invalid" role="alert" class="text-error">{{ saveError || (needsRead ? t('coco.anConfigurationActivationIsNotYetConfirmed') : invalid) }}</p>
                <p v-else-if="changed" class="text-warning">{{ t('coco.anAutomaticSelectionSettingsHaveUnsavedChanges2') }}</p>
                <p v-else-if="saved" role="status" :class="refreshWarning ? 'text-warning' : 'text-success'">{{ refreshWarning || t('coco.anAutomaticSelectionSettingsSavedAndApplied') }}</p>
              </div>
              <div class="flex flex-wrap justify-end gap-2">
                <button v-if="invalidPage" type="button" class="btn btn-ghost min-h-11" :disabled="locked" @click="locateInvalid"><IconEdit :size="16" /><span>{{ !enabled ? t('coco.anEnableAutomaticSelectionToFixThis') : !effectiveBandwidth?.enabled && invalidPage !== 'pool' ? t('coco.anEnableAssistedDecisionsToFixThis') : t('coco.anFixSettingsPage', { page: t(allPages.find(page => page.id === invalidPage)?.label ?? '') }) }}</span></button>
                <button v-if="needsRead" type="button" class="btn btn-outline min-h-11" :disabled="locked" @click="reread"><IconReload :size="16" /><span>{{ t('coco.anReloadStatus') }}</span></button>
                <button type="button" class="btn btn-primary min-h-11" :disabled="locked || !!invalid || !changed || needsRead" @click="persist"><span v-if="saving" class="loading loading-spinner loading-xs" /><IconCheck v-else :size="16" /><span>{{ saving ? t('coco.anSaving') : saved && !changed ? t('coco.anSaved') : t('coco.anSaveAutomaticSelectionSettings') }}</span></button>
              </div>
            </template>
          </div>
        </template>
      </div>
    </template>
  </Modal>
</template>

<style scoped>
.nav-heading { padding: 0 8px; margin-bottom: 6px; font-size: 11px; opacity: .55; }
.mobile-directory-back { display: none; }
.summary-link { white-space: normal; height: auto; text-align: left; gap: 12px; }
.group-settings-nav :deep(.automatic-child) { padding-left: 20px; }
.parameter-link { height: auto; padding-block: 12px; white-space: normal; }
@media (width < 640px) {
  .mobile-directory-back { display: inline-flex; }
}
</style>
