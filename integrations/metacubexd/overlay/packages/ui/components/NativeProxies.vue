<script setup lang="ts">
import type { ProxyProvider, ProxyNodeWithProvider } from '~/types'
import type { MobileNavReselectDetail } from '~/constants'
import { IconActivity, IconArrowUp, IconBrandSpeedtest, IconReload, IconSearch, IconSettings, IconX } from '@tabler/icons-vue'
import { MOBILE_NAV_RESELECT_EVENT, ROUTES } from '~/constants'
import { filterProxiesByAvailability, filterProxiesByName, formatTimeFromNow, sortProxiesByOrderingType } from '~/utils'
import { useProxyRefresh } from '~/composables/useProxyRefresh'
import { useBatchLatencyTest } from '~/composables/useBatchLatencyTest'
import NativeProxyMasterDetail from '~/components/NativeProxyMasterDetail.vue'
import ConnectivityBoard from '~/components/ConnectivityBoard.vue'

const { t, locale } = useI18n()
const proxiesStore = useProxiesStore()
const configStore = useConfigStore()
const recommendationStore = useNodeRecommendationStore()
const workspace = useWorkspace()
const proxyRefresh = useProxyRefresh()
const { isRunning: isBatchTesting, testMultipleGroups, healthCheckAllProviders, abortTest } = useBatchLatencyTest()
const activeTab = ref<'proxies' | 'proxyProviders'>('proxies')
const settingsModal = ref<{ open: () => void }>()
const connectivityModal = ref<{ open: () => void }>()
const proxyMasterDetail = ref<{ scrollToTop: (behavior?: ScrollBehavior) => void }>()
const scrollEl = ref<HTMLElement | null>(null)
const showScrollToTop = ref(false)
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
  return filterProxiesByName(filterProxiesByAvailability({
    proxyNames: sorted, enabled: configStore.hideUnAvailableProxies, testUrl,
    getLatencyByName: proxiesStore.getLatencyByName, isProxyGroup: proxiesStore.isProxyGroup,
    latencyQualityMap: configStore.latencyQualityMap, urlForLatencyTest: configStore.urlForLatencyTest,
  }), configStore.proxiesGroupNameFilter)
}
const sortedNamesByGroup = computed(() => Object.fromEntries(renderProxies.value.map(group =>
  [group.name, sortedNames(group.all ?? [], group.testUrl || null)],
)))
function providerNames(provider: ProxyProvider & { proxies: ProxyNodeWithProvider[] }) {
  return sortedNames(provider.proxies.map(node => node.name), provider.testUrl || null)
}
function testAllGroups() { return testMultipleGroups(renderProxies.value.map(group => group.name)) }
function onScroll(event: Event) { showScrollToTop.value = (event.currentTarget as HTMLElement).scrollTop > 300 }
function scrollToTop() {
  const behavior = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'
  scrollEl.value?.scrollTo({ top: 0, behavior })
  proxyMasterDetail.value?.scrollToTop(behavior)
}
function onReselect(event: Event) {
  if ((event as CustomEvent<MobileNavReselectDetail>).detail?.path === ROUTES.Proxies) scrollToTop()
}
onMounted(() => {
  // Do not reconcile a scheme's remembered group against the previous
  // scheme's cached core data while the first fresh read is still pending.
  void proxyRefresh.refresh().finally(() => { initialRead.value = false })
  window.addEventListener(MOBILE_NAV_RESELECT_EVENT, onReselect)
})
onUnmounted(() => window.removeEventListener(MOBILE_NAV_RESELECT_EVENT, onReselect))
watch(useWindowFocus(), useThrottleFn(focused => { if (focused) void proxyRefresh.refresh() }, 30000, true, true))
watch(activeTab, () => { showScrollToTop.value = false })
</script>

<template>
  <div class="relative flex min-h-0 flex-1 flex-col gap-3">
    <div class="flex shrink-0 flex-wrap items-center gap-2">
      <div class="flex w-fit gap-1 rounded-xl border border-base-content/8 bg-base-200/60 p-1" role="tablist" aria-label="代理来源">
        <button v-for="tab in tabs" :key="tab.type" role="tab" class="flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm" :class="activeTab === tab.type ? 'bg-primary text-primary-content' : 'text-base-content/70'" :aria-selected="activeTab === tab.type" @click="activeTab = tab.type">
          {{ tab.name }}<span class="rounded-md bg-base-content/10 px-1.5 text-xs">{{ tab.count }}</span>
        </button>
      </div>
      <ProxiesSortSelect />
      <button v-if="activeTab === 'proxies'" class="btn btn-ghost btn-sm" :title="isBatchTesting ? '取消延迟测试' : '测试全部组代理延迟'" :aria-label="isBatchTesting ? '取消延迟测试' : '测试全部组代理延迟'" @click="isBatchTesting ? abortTest() : testAllGroups()"><IconX v-if="isBatchTesting" :size="18" /><IconBrandSpeedtest v-else :size="18" /></button>
      <template v-else>
        <button class="btn btn-ghost btn-sm" title="检测全部代理提供者" aria-label="检测全部代理提供者" :disabled="isBatchTesting" @click="healthCheckAllProviders"><IconBrandSpeedtest :size="18" /></button>
        <button class="btn btn-ghost btn-sm" title="更新全部代理提供者" aria-label="更新全部代理提供者" :disabled="proxiesStore.isAllProviderUpdating" @click="proxiesStore.updateAllProvider"><IconReload :size="18" /></button>
      </template>
      <span v-if="isBatchTesting" role="status" class="text-xs text-success">{{ recommendationStore.batchTestProgress.completed }}/{{ recommendationStore.batchTestProgress.total }}</span>
      <label class="input input-sm ml-auto flex min-w-36 flex-1 items-center gap-2 sm:max-w-64">
        <IconSearch :size="16" class="shrink-0 opacity-50" />
        <input v-model="configStore.proxiesGroupNameFilter" type="search" class="min-w-0 grow" :placeholder="t('filterNodesByName')" aria-label="按名称筛选节点" />
        <button v-if="configStore.proxiesGroupNameFilter" title="清空搜索" aria-label="清空搜索" @click="configStore.proxiesGroupNameFilter = ''"><IconX :size="14" /></button>
      </label>
      <button class="btn btn-ghost btn-sm" title="站点检测" aria-label="站点检测" @click="connectivityModal?.open()"><IconActivity :size="18" /><span>站点检测</span></button>
      <button class="btn btn-ghost btn-sm" title="显示设置" aria-label="显示设置" @click="settingsModal?.open()"><IconSettings :size="18" /></button>
    </div>

    <div ref="scrollEl" data-testid="proxies-scroll-container" class="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto" @scroll.passive="onScroll">
      <template v-if="activeTab === 'proxies'">
        <div v-if="initialRead || (!proxiesStore.proxiesLoaded && !renderProxies.length)" class="flex flex-col gap-3 p-1"><div v-for="i in 4" :key="i" class="h-20 animate-pulse rounded-xl bg-base-content/5" /></div>
        <NativeProxyMasterDetail v-else-if="renderProxies.length" ref="proxyMasterDetail" :groups="renderProxies" :sorted-names-by-group="sortedNamesByGroup" :scroll-container="scrollEl" @scroll="onScroll" />
        <div v-else class="py-12 text-center text-sm text-base-content/50">暂无策略组 <NuxtLink to="/subscriptions" class="link link-primary">选择订阅</NuxtLink></div>
      </template>
      <div v-else class="flex flex-col gap-3">
        <section v-for="provider in proxiesStore.proxyProviders" :key="provider.name" class="rounded-xl border border-base-content/10 p-3">
          <div class="mb-2 flex flex-wrap items-center gap-2"><h2 class="min-w-0 flex-1 truncate font-semibold">{{ provider.name }}</h2><span class="text-xs text-base-content/60">{{ provider.proxies.length }} · {{ provider.vehicleType }}</span><button class="btn btn-ghost btn-sm" :aria-label="`更新 ${provider.name}`" title="更新代理提供者" :disabled="proxiesStore.updatingMap[provider.name]" @click="proxiesStore.updateProviderByProviderName(provider.name)"><IconReload :size="16" /></button><button class="btn btn-ghost btn-sm" title="测试此代理提供者的代理延迟" :aria-label="`测试 ${provider.name} 代理延迟`" :disabled="proxiesStore.proxyProviderLatencyTestingMap[provider.name]" @click="proxiesStore.proxyProviderLatencyTest(provider.name)"><IconBrandSpeedtest :size="16" /></button></div>
          <SubscriptionInfo :subscription-info="provider.subscriptionInfo" />
          <div class="my-2 text-xs text-base-content/50">{{ t('updated') }} {{ formatTimeFromNow(provider.updatedAt, locale) }}</div>
          <div class="flex flex-col gap-2"><ProxyNodeListItem v-for="name in providerNames(provider)" :key="name" :proxy-name="name" :test-url="provider.testUrl || null" :timeout="provider.timeout ?? null" :provider-name="provider.name" /></div>
        </section>
        <div v-if="!proxiesStore.proxyProviders.length" class="py-12 text-center text-sm text-base-content/50">{{ t('noData') }}</div>
      </div>
    </div>
    <button v-if="showScrollToTop" data-testid="scroll-to-top" class="btn btn-circle btn-primary absolute right-3 bottom-3 z-30" :title="t('backToTop')" :aria-label="t('backToTop')" @click="scrollToTop"><IconArrowUp :size="20" /></button>

    <Modal ref="settingsModal" :title="t('proxiesSettings')">
      <div class="flex flex-col gap-4">
        <label class="flex items-center justify-between gap-3">{{ t('autoCloseConns') }}<input v-model="configStore.autoCloseConns" type="checkbox" class="toggle toggle-primary" /></label>
        <label class="flex flex-col gap-2">代理延迟测试网址<input v-model="configStore.urlForLatencyTest" class="input w-full" type="url" /></label>
        <label class="flex flex-col gap-2">{{ t('latencyTestUrlSource') }}<select v-model="configStore.latencyTestUrlSource" class="select w-full"><option value="core">{{ t('latencyTestUrlSourceCore') }}</option><option value="dashboard">{{ t('latencyTestUrlSourceDashboard') }}</option></select></label>
        <label class="flex flex-col gap-2">{{ t('latencyTestTimeoutDuration') }} (ms)<input v-model.number="configStore.latencyTestTimeoutDuration" class="input w-full" type="number" min="1" /></label>
        <label class="flex flex-col gap-2">{{ t('latencyMediumThreshold') }} (ms)<input v-model.number="configStore.latencyMediumThreshold" class="input w-full" type="number" min="0" /></label>
        <label class="flex flex-col gap-2">{{ t('latencyHighThreshold') }} (ms)<input v-model.number="configStore.latencyHighThreshold" class="input w-full" type="number" min="0" /></label>
        <label class="flex items-center justify-between gap-3">{{ t('hideUnavailableProxies') }}<input v-model="configStore.hideUnAvailableProxies" type="checkbox" class="toggle toggle-primary" /></label>
        <button class="btn btn-error" @click="configStore.resetProxiesSettings()">{{ t('resetSettings') }}</button>
      </div>
    </Modal>
    <Modal ref="connectivityModal" title="站点检测"><ConnectivityBoard /></Modal>
  </div>
</template>
