<script setup lang="ts">
import type { ProxyProvider, ProxyNodeWithProvider } from '~/types'
import type { MobileNavReselectDetail } from '~/constants'
import { IconArrowUp, IconBrandSpeedtest, IconReload, IconSearch, IconSettings, IconWorld, IconX } from '@tabler/icons-vue'
import { MOBILE_NAV_RESELECT_EVENT, ROUTES } from '~/constants'
import { filterProxiesByAvailability, filterProxiesByName, formatTimeFromNow, sortProxiesByOrderingType } from '~/utils'
import { useProxyRefresh } from '~/composables/useProxyRefresh'
import { useBatchLatencyTest } from '~/composables/useBatchLatencyTest'
import { useTcpDelay } from '~/composables/useTcpDelay'
import NativeProxyMasterDetail from '~/components/NativeProxyMasterDetail.vue'
import AutoProbeSettings from '~/components/AutoProbeSettings.vue'
import { useSiteSettings } from '~/composables/useSiteSettings'
import { useSiteProbes } from '~/composables/useSiteProbes'

const { t, locale } = useI18n()
const proxiesStore = useProxiesStore()
const configStore = useConfigStore()
const recommendationStore = useNodeRecommendationStore()
const workspace = useWorkspace()
const sites = useSiteSettings()
const siteProbes = useSiteProbes(true)
const detailsModal = ref<{ open: () => void; close: () => void }>()
const detailsGroup = ref('')
const detailsNode = ref('')
const siteError = useLocalizedMessage()
const settingsTab = ref<'general' | 'detection' | 'sites'>('general')
const siteCounts = computed(() => Object.fromEntries(proxiesStore.proxies.map(group => [group.name, sites.targetsFor(group.name).length])))
const activeSiteRun = computed(() => siteProbes.running.value ? siteProbes.runs.value[siteProbes.running.value] : undefined)
const anyTesting = computed(() => tcpRunning.value || isBatchTesting.value || !!siteProbes.running.value)
function details(group: string, node: string) { detailsGroup.value = group; detailsNode.value = node; detailsModal.value?.open() }
provide('cocoproxy-sites', { sites, probes: siteProbes, details })
watch(sites.scopeKey, () => { detailsModal.value?.close(); void readSites() })
const { isRunning: tcpRunning, completed: tcpCompleted, total: tcpTotal, resultFor: tcpResultFor, run: runTcp, cancel: cancelTcp } = useTcpDelay()
const tcpScope = ref('')
const allTcpNames = computed(() => workspace.view.value?.tcpNodes?.filter(node => node.applicable).map(node => node.name) ?? [])
const testingTcpNames = computed(() => allTcpNames.value.filter(name => tcpResultFor(name)?.status === 'testing'))
async function testTcp(names: string[], scope: string) {
  if (anyTesting.value || workspace.busy.value || initialRead.value) return
  tcpScope.value = scope
  await runTcp(names)
}
const proxyRefresh = useProxyRefresh()
const { isRunning: isBatchTesting, activeProbes, groupProgress, testMultipleGroups, healthCheckAllProviders, abortTest } = useBatchLatencyTest()
const testingNames = computed(() => activeProbes.value.map(probe => probe.name))
const testingDomains = computed(() => [...new Set(activeProbes.value.map(probe => {
  try { return new URL(probe.url).hostname } catch { return t('coco.anTestUrl') }
}))])
const activeTab = ref<'proxies' | 'proxyProviders'>('proxies')
const settingsModal = ref<{ open: () => void }>()
const proxyMasterDetail = ref<{ scrollToTop: (behavior?: ScrollBehavior) => void; activeName: string | null }>()
const scrollEl = ref<HTMLElement | null>(null)
const outerScrollTop = ref(0)
const innerScrollTop = ref(0)
const showScrollToTop = computed(() => Math.max(outerScrollTop.value, innerScrollTop.value) > 24)
const initialRead = ref(true)

const renderProxies = computed(() => proxiesStore.proxies.filter(proxy =>
  !proxy.hidden && (proxy.name !== 'GLOBAL' || !!workspace.view.value?.groups.some(group => group.name === 'GLOBAL')),
))
const tabs = computed(() => [
  { type: 'proxies' as const, name: t('proxies'), count: renderProxies.value.length },
  { type: 'proxyProviders' as const, name: t('proxyProviders'), count: proxiesStore.proxyProviders.length },
])

function sortedNames(names: string[], testUrl: string | null) {
  const sorted = sortProxiesByOrderingType({
    proxyNames: names, orderingType: configStore.proxiesOrderingType, testUrl,
    getLatencyByName: proxiesStore.getLatencyByName, isProxyGroup: proxiesStore.isProxyGroup,
    latencyQualityMap: configStore.latencyQualityMap, urlForLatencyTest: configStore.urlForLatencyTest,
    performanceData: recommendationStore.performanceData,
  })
  const visible = filterProxiesByName(filterProxiesByAvailability({
    proxyNames: sorted, enabled: configStore.hideUnAvailableProxies, testUrl,
    getLatencyByName: proxiesStore.getLatencyByName, isProxyGroup: proxiesStore.isProxyGroup,
    latencyQualityMap: configStore.latencyQualityMap, urlForLatencyTest: configStore.urlForLatencyTest,
  }), configStore.proxiesGroupNameFilter)
  const shared = new Set(workspace.view.value?.groups.filter(group => group.role === 'shared').map(group => group.name) ?? [])
  return [...visible.filter(name => shared.has(name)), ...visible.filter(name => !shared.has(name))]
}
const sortedNamesByGroup = computed(() => Object.fromEntries(renderProxies.value.map(group =>
  [group.name, sortedNames(group.all ?? [], group.testUrl || null)],
)))
function providerNames(provider: ProxyProvider & { proxies: ProxyNodeWithProvider[] }) {
  return sortedNames(provider.proxies.map(node => node.name), provider.testUrl || null)
}
function onScroll(event: Event) {
  const target = event.currentTarget as HTMLElement
  if (target === scrollEl.value) outerScrollTop.value = target.scrollTop
  else innerScrollTop.value = target.scrollTop
}
function scrollToTop() {
  const behavior = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'
  scrollEl.value?.scrollTo({ top: 0, behavior })
  proxyMasterDetail.value?.scrollToTop(behavior)
}
function onReselect(event: Event) {
  if ((event as CustomEvent<MobileNavReselectDetail>).detail?.path === ROUTES.Proxies) scrollToTop()
}
async function readSites() {
  siteError.value = ''
  try { await proxyRefresh.refresh(); await sites.load() }
  catch { siteError.value = () => t('coco.anFailedToLoadSiteSettingsRefresh') }
}
onMounted(() => {
  // Do not reconcile a scheme's remembered group against the previous
  // scheme's cached core data while the first fresh read is still pending.
  void readSites().finally(() => { initialRead.value = false })
  window.addEventListener(MOBILE_NAV_RESELECT_EVENT, onReselect)
})
onUnmounted(() => window.removeEventListener(MOBILE_NAV_RESELECT_EVENT, onReselect))
watch(useWindowFocus(), useThrottleFn(focused => { if (focused) void proxyRefresh.refresh() }, 30000, true, true))
watch(activeTab, () => { outerScrollTop.value = 0; innerScrollTop.value = 0 })
watch([workspace.api.generation, sites.scopeKey], cancelTcp, { flush: 'sync' })
function resetGeneral() { configStore.autoCloseConns = true; configStore.hideUnAvailableProxies = false }
function resetDetection() {
  configStore.urlForLatencyTest = 'https://www.gstatic.com/generate_204'
  configStore.latencyTestUrlSource = 'core'
  configStore.latencyTestTimeoutDuration = 5000
  configStore.latencyMediumThreshold = 0
  configStore.latencyHighThreshold = 0
}
</script>

<template>
  <div class="relative flex min-h-0 flex-1 flex-col gap-3">
    <div class="flex shrink-0 flex-wrap items-center gap-2">
      <div class="flex w-fit gap-1 rounded-xl border border-base-content/8 bg-base-200/60 p-1" role="tablist" :aria-label="t('coco.anProxySources')">
        <button v-for="tab in tabs" :key="tab.type" role="tab" class="flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm" :class="activeTab === tab.type ? 'bg-primary text-primary-content' : 'text-base-content/70'" :aria-selected="activeTab === tab.type" @click="activeTab = tab.type">
          {{ tab.name }}<span class="rounded-md bg-base-content/10 px-1.5 text-xs">{{ tab.count }}</span>
        </button>
      </div>
      <ProxiesSortSelect />
      <template v-if="activeTab === 'proxyProviders'">
        <button class="btn btn-ghost btn-sm" :title="t('coco.anCheckAllProxyProviders')" :aria-label="t('coco.anCheckAllProxyProviders')" :disabled="anyTesting" @click="healthCheckAllProviders"><IconBrandSpeedtest :size="18" :class="{ 'animate-pulse motion-reduce:animate-none text-success': isBatchTesting }" /><span>{{ t('coco.anCheckProviders') }}</span></button>
        <button class="btn btn-ghost btn-sm" :title="t('coco.anUpdateAllProxyProviders')" :aria-label="t('coco.anUpdateAllProxyProviders')" :disabled="proxiesStore.isAllProviderUpdating" @click="proxiesStore.updateAllProvider"><IconReload :size="18" :class="{ 'animate-spin motion-reduce:animate-none': proxiesStore.isAllProviderUpdating }" /><span>{{ t('coco.anUpdateProviders') }}</span></button>
      </template>
      <label class="input input-sm ml-auto flex min-w-36 flex-1 items-center gap-2 sm:max-w-64">
        <IconSearch :size="16" class="shrink-0 opacity-50" />
        <input v-model="configStore.proxiesGroupNameFilter" type="search" class="min-w-0 grow" :placeholder="t('filterNodesByName')" :aria-label="t('coco.anFilterNodesByName')" />
        <button v-if="configStore.proxiesGroupNameFilter" class="flex shrink-0 items-center gap-1" :title="t('coco.anClearSearch')" :aria-label="t('coco.anClearSearch')" @click="configStore.proxiesGroupNameFilter = ''"><IconX :size="14" /><span class="text-xs">{{ t('coco.anClear') }}</span></button>
      </label>
      <button class="btn btn-ghost btn-sm" :aria-label="t('coco.anProxySettings')" @click="settingsModal?.open()"><IconSettings :size="18" /><span>{{ t('coco.anProxySettings') }}</span></button>
    </div>

    <p v-if="siteError" role="alert" class="text-xs text-error">{{ siteError }}</p>
    <div v-if="activeSiteRun" role="status" aria-live="polite" class="flex shrink-0 flex-wrap items-center gap-2 rounded-lg bg-success/10 px-3 py-2 text-xs text-success">
      <span class="loading loading-spinner loading-xs shrink-0 motion-reduce:animate-none" /><span>{{ t('coco.anSiteConnectivityItems', { value: activeSiteRun.group, value2: activeSiteRun.completed, value3: activeSiteRun.total }) }}</span>
      <span class="min-w-0 flex-1 truncate">{{ Object.values(activeSiteRun.inFlight).slice(0, 2).join('；') }}</span>
      <button type="button" class="btn btn-ghost btn-sm" @click="siteProbes.cancel()"><IconX :size="16" /><span>{{ t('coco.anCancelChecks') }}</span></button>
    </div>

    <div v-if="tcpRunning" role="status" aria-live="polite" class="flex shrink-0 flex-wrap items-center gap-2 rounded-lg border border-primary/15 bg-primary/10 px-3 py-2 text-xs text-primary">
      <span class="loading loading-xs loading-spinner shrink-0 motion-reduce:animate-none" />
      <span class="shrink-0">{{ t('coco.anTcpTest', { value: tcpScope, value2: tcpCompleted, value3: tcpTotal }) }}</span>
      <span v-if="testingTcpNames.length" class="min-w-0 flex-1 basis-40 truncate" :title="testingTcpNames.join('、')">{{ t('coco.anConnecting', { value: testingTcpNames.join('、') }) }}</span>
      <button type="button" class="btn btn-ghost btn-sm shrink-0" :title="t('coco.anCancelThisTcpLatencyTest')" :aria-label="t('coco.anCancelTcpTest')" @click="cancelTcp"><IconX :size="16" /><span>{{ t('coco.anCancelTcpTest') }}</span></button>
    </div>

    <div v-if="isBatchTesting" role="status" aria-live="polite" class="flex shrink-0 flex-wrap items-center gap-2 rounded-lg border border-success/15 bg-success/10 px-3 py-2 text-xs text-success">
      <span class="loading loading-xs loading-spinner shrink-0 motion-reduce:animate-none" />
      <span class="shrink-0"><template v-if="groupProgress.total">{{ t('coco.anProxyGroupsNodeTasks', { value: groupProgress.completed, value2: groupProgress.total }) }} </template><template v-else>{{ t('coco.anTestingSpeed') }} </template>{{ recommendationStore.batchTestProgress.completed }}/{{ recommendationStore.batchTestProgress.total }}</span>
      <div class="min-w-0 flex-1 basis-40">
        <div v-if="groupProgress.active.length" class="break-all">{{ t('coco.anCurrentProxyGroups', { value: groupProgress.active.join('、') }) }}</div>
        <div v-if="testingNames.length" class="truncate" :title="testingNames.join('、')">{{ t('coco.anTesting2', { value: testingNames.slice(0, 3).join('、'), value2: testingNames.length > 3 ? t('coco.anAndOthersNodesTotal', { value: testingNames.length }) : '' }) }}</div>
        <div v-else>{{ recommendationStore.batchTestProgress.completed === recommendationStore.batchTestProgress.total ? t('coco.anRefreshingMeasurements') : recommendationStore.batchTestProgress.current || t('coco.anPreparingChecks') }}</div>
        <div v-if="testingDomains.length" class="break-all opacity-75">{{ t('coco.anTargets', { value: testingDomains.join('、') }) }}</div>
      </div>
      <button v-if="activeProbes.length" class="btn btn-ghost btn-sm shrink-0" :title="t('coco.anCancelThisProxyLatencyTest')" :aria-label="t('coco.anCancelThisProxyLatencyTest')" @click="abortTest"><IconX :size="16" /><span>{{ t('coco.anCancelSpeedTest') }}</span></button>
    </div>

    <div ref="scrollEl" data-testid="proxies-scroll-container" class="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto" @scroll.passive="onScroll">
      <template v-if="activeTab === 'proxies'">
        <div v-if="initialRead || (!proxiesStore.proxiesLoaded && !renderProxies.length)" class="flex flex-col gap-3 p-1"><div v-for="i in 4" :key="i" class="h-20 animate-pulse rounded-xl bg-base-content/5" /></div>
        <NativeProxyMasterDetail v-else-if="renderProxies.length" ref="proxyMasterDetail" :groups="renderProxies" :sorted-names-by-group="sortedNamesByGroup" :scroll-container="scrollEl" :batch-testing="isBatchTesting" :tcp-testing="tcpRunning" :site-testing="!!siteProbes.running.value" :site-counts="siteCounts" @test-tcp="(names, group) => testTcp(names, group)" @test-group="name => { if (!anyTesting) testMultipleGroups([name]) }" @test-sites="name => { if (!anyTesting) siteProbes.run(name) }" @scroll="onScroll" />
        <div v-else class="py-12 text-center text-sm text-base-content/50">{{ t('coco.anNoProxyGroups') }} <NuxtLink to="/subscriptions" class="link link-primary">{{ t('coco.anChooseSubscription') }}</NuxtLink></div>
      </template>
      <div v-else class="flex flex-col gap-3">
        <section v-for="provider in proxiesStore.proxyProviders" :key="provider.name" class="rounded-xl border border-base-content/10 p-3">
          <div class="mb-2 flex flex-wrap items-center gap-2"><h2 class="min-w-0 flex-1 truncate font-semibold">{{ provider.name }}</h2><span class="text-xs text-base-content/60">{{ provider.proxies.length }} · {{ provider.vehicleType }}</span><button class="btn btn-ghost btn-sm" :aria-label="t('coco.anUpdate', { value: provider.name })" :title="t('coco.anUpdateProxyProvider')" :disabled="proxiesStore.updatingMap[provider.name]" @click="proxiesStore.updateProviderByProviderName(provider.name)"><IconReload :size="16" :class="{ 'animate-spin motion-reduce:animate-none': proxiesStore.updatingMap[provider.name] }" /><span>{{ t('coco.anUpdate2') }}</span></button><button class="btn btn-ghost btn-sm" :title="t('coco.anTestProxyLatencyForThisProvider')" :aria-label="t('coco.anTestProxyLatencyFor', { value: provider.name })" :disabled="proxiesStore.proxyProviderLatencyTestingMap[provider.name]" @click="proxiesStore.proxyProviderLatencyTest(provider.name)"><IconBrandSpeedtest :size="16" :class="{ 'animate-pulse motion-reduce:animate-none': proxiesStore.proxyProviderLatencyTestingMap[provider.name] }" /><span>{{ t('coco.anTestLatency') }}</span></button></div>
          <SubscriptionInfo :subscription-info="provider.subscriptionInfo" />
          <div class="my-2 text-xs text-base-content/50">{{ t('updated') }} {{ formatTimeFromNow(provider.updatedAt, locale) }}</div>
          <div class="flex flex-col gap-2"><ProxyNodeListItem v-for="name in providerNames(provider)" :key="name" :proxy-name="name" :test-url="provider.testUrl || null" :timeout="provider.timeout ?? null" :provider-name="provider.name" /></div>
        </section>
        <div v-if="!proxiesStore.proxyProviders.length" class="py-12 text-center text-sm text-base-content/50">{{ t('noData') }}</div>
      </div>
    </div>
    <button v-if="showScrollToTop" data-testid="scroll-to-top" class="btn btn-primary btn-sm absolute right-3 bottom-3 z-30 min-h-11 shadow-sm" :title="t('backToTop')" :aria-label="t('backToTop')" @click="scrollToTop"><IconArrowUp :size="17" aria-hidden="true" /><span>{{ t('backToTop') }}</span></button>

    <Modal ref="settingsModal" :title="t('coco.anProxySettings')" compact settings-layout fixed-height>
      <template #tabs>
        <div class="flex gap-2" role="tablist" :aria-label="t('coco.anProxySettingsCategories')"><button v-for="tab in [{ key: 'general', name: t('coco.anGeneral'), icon: IconSettings }, { key: 'detection', name: t('coco.anChecks'), icon: IconBrandSpeedtest }, { key: 'sites', name: t('coco.anSiteDirectory'), icon: IconWorld }]" :key="tab.key" type="button" role="tab" class="btn btn-sm" :class="settingsTab === tab.key ? 'btn-primary' : 'btn-ghost'" :aria-selected="settingsTab === tab.key" @click="settingsTab = tab.key as typeof settingsTab"><component :is="tab.icon" :size="16" aria-hidden="true" /><span>{{ tab.name }}</span></button></div>
      </template>
      <div class="flex flex-col gap-4">
        <template v-if="settingsTab === 'general'">
          <label class="flex items-center gap-2"><input v-model="configStore.autoCloseConns" type="checkbox" class="checkbox checkbox-primary checkbox-xs" />{{ t('coco.anDisconnectConnectionsWhenSwitchingNodes') }}</label>
          <label class="flex items-center gap-2"><input v-model="configStore.hideUnAvailableProxies" type="checkbox" class="checkbox checkbox-primary checkbox-xs" />{{ t('coco.anHideUnavailableNodes') }}</label>
          <button type="button" class="btn btn-outline btn-sm self-end" @click="resetGeneral"><IconReload :size="16" /><span>{{ t('coco.anRestoreGeneralDefaults') }}</span></button>
        </template>
        <template v-else-if="settingsTab === 'detection'">
          <HelpTip>{{ t('coco.anBaselineCheckPreferencesAreStoredIn') }}</HelpTip>
          <label class="flex flex-col gap-2">{{ t('coco.anBaselineCheckUrl') }}<input v-model="configStore.urlForLatencyTest" class="input w-full" type="url" /></label>
          <label class="flex flex-col gap-2">{{ t('coco.anCheckUrlSource') }}<select v-model="configStore.latencyTestUrlSource" class="select w-full"><option value="core">{{ t('coco.anPreferProxyGroupConfiguration') }}</option><option value="dashboard">{{ t('coco.anUseTheBaselineUrlForAll') }}</option></select></label>
          <label class="flex flex-col gap-2">{{ t('coco.anCheckTimeoutMs') }}<input v-model.number="configStore.latencyTestTimeoutDuration" class="input w-full" type="number" min="1" max="10000" /></label>
          <fieldset class="space-y-2"><legend class="text-sm">{{ t('coco.anLatencyColorThresholdsMs') }}</legend><label class="flex items-center justify-between gap-3">{{ t('coco.anYellow') }}<input v-model.number="configStore.latencyMediumThreshold" class="input w-32" type="number" min="0" /></label><label class="flex items-center justify-between gap-3">{{ t('coco.anRed') }}<input v-model.number="configStore.latencyHighThreshold" class="input w-32" type="number" min="0" /></label><p class="text-xs text-base-content/55">{{ t('coco.anUsesTheDefaultValueYellowIn') }}</p></fieldset>
          <button type="button" class="btn btn-outline btn-sm self-end" @click="resetDetection"><IconReload :size="16" /><span>{{ t('coco.anRestoreBaselineCheckDefaults') }}</span></button>
          <AutoProbeSettings />
        </template>
        <SiteTargetSettings v-else :scroll-list="false" />
      </div>
    </Modal>
    <Modal ref="detailsModal" :title="t('coco.anSiteConnectivity')"><SiteProbeDetails :group="detailsGroup" :node="detailsNode" :busy="anyTesting" /></Modal>
  </div>
</template>
