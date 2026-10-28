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
const siteError = ref('')
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
  try { return new URL(probe.url).hostname } catch { return '测速网址' }
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
  catch { siteError.value = '站点设置读取失败，请刷新页面重试。' }
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
      <div class="flex w-fit gap-1 rounded-xl border border-base-content/8 bg-base-200/60 p-1" role="tablist" aria-label="代理来源">
        <button v-for="tab in tabs" :key="tab.type" role="tab" class="flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm" :class="activeTab === tab.type ? 'bg-primary text-primary-content' : 'text-base-content/70'" :aria-selected="activeTab === tab.type" @click="activeTab = tab.type">
          {{ tab.name }}<span class="rounded-md bg-base-content/10 px-1.5 text-xs">{{ tab.count }}</span>
        </button>
      </div>
      <ProxiesSortSelect />
      <template v-if="activeTab === 'proxyProviders'">
        <button class="btn btn-ghost btn-sm" title="检测全部代理提供者" aria-label="检测全部代理提供者" :disabled="anyTesting" @click="healthCheckAllProviders"><IconBrandSpeedtest :size="18" :class="{ 'animate-pulse motion-reduce:animate-none text-success': isBatchTesting }" /><span>检测提供者</span></button>
        <button class="btn btn-ghost btn-sm" title="更新全部代理提供者" aria-label="更新全部代理提供者" :disabled="proxiesStore.isAllProviderUpdating" @click="proxiesStore.updateAllProvider"><IconReload :size="18" :class="{ 'animate-spin motion-reduce:animate-none': proxiesStore.isAllProviderUpdating }" /><span>更新提供者</span></button>
      </template>
      <label class="input input-sm ml-auto flex min-w-36 flex-1 items-center gap-2 sm:max-w-64">
        <IconSearch :size="16" class="shrink-0 opacity-50" />
        <input v-model="configStore.proxiesGroupNameFilter" type="search" class="min-w-0 grow" :placeholder="t('filterNodesByName')" aria-label="按名称筛选节点" />
        <button v-if="configStore.proxiesGroupNameFilter" class="flex shrink-0 items-center gap-1" title="清空搜索" aria-label="清空搜索" @click="configStore.proxiesGroupNameFilter = ''"><IconX :size="14" /><span class="text-xs">清空</span></button>
      </label>
      <button class="btn btn-ghost btn-sm" aria-label="代理设置" @click="settingsModal?.open()"><IconSettings :size="18" /><span>代理设置</span></button>
    </div>

    <p v-if="siteError" role="alert" class="text-xs text-error">{{ siteError }}</p>
    <div v-if="activeSiteRun" role="status" aria-live="polite" class="flex shrink-0 flex-wrap items-center gap-2 rounded-lg bg-success/10 px-3 py-2 text-xs text-success">
      <span class="loading loading-spinner loading-xs shrink-0 motion-reduce:animate-none" /><span>站点连通 · {{ activeSiteRun.group }} · {{ activeSiteRun.completed }}/{{ activeSiteRun.total }} 项</span>
      <span class="min-w-0 flex-1 truncate">{{ Object.values(activeSiteRun.inFlight).slice(0, 2).join('；') }}</span>
      <button type="button" class="btn btn-ghost btn-sm" @click="siteProbes.cancel()"><IconX :size="16" /><span>取消检测</span></button>
    </div>

    <div v-if="tcpRunning" role="status" aria-live="polite" class="flex shrink-0 flex-wrap items-center gap-2 rounded-lg border border-primary/15 bg-primary/10 px-3 py-2 text-xs text-primary">
      <span class="loading loading-xs loading-spinner shrink-0 motion-reduce:animate-none" />
      <span class="shrink-0">TCP 测试 · {{ tcpScope }} · {{ tcpCompleted }}/{{ tcpTotal }}</span>
      <span v-if="testingTcpNames.length" class="min-w-0 flex-1 basis-40 truncate" :title="testingTcpNames.join('、')">正在建连：{{ testingTcpNames.join('、') }}</span>
      <button type="button" class="btn btn-ghost btn-sm shrink-0" title="取消本次 TCP 延迟测试" aria-label="取消 TCP 测试" @click="cancelTcp"><IconX :size="16" /><span>取消 TCP 测试</span></button>
    </div>

    <div v-if="isBatchTesting" role="status" aria-live="polite" class="flex shrink-0 flex-wrap items-center gap-2 rounded-lg border border-success/15 bg-success/10 px-3 py-2 text-xs text-success">
      <span class="loading loading-xs loading-spinner shrink-0 motion-reduce:animate-none" />
      <span class="shrink-0"><template v-if="groupProgress.total">策略组 {{ groupProgress.completed }}/{{ groupProgress.total }} · 节点任务 </template><template v-else>测速中 </template>{{ recommendationStore.batchTestProgress.completed }}/{{ recommendationStore.batchTestProgress.total }}</span>
      <div class="min-w-0 flex-1 basis-40">
        <div v-if="groupProgress.active.length" class="break-all">当前策略组：{{ groupProgress.active.join('、') }}</div>
        <div v-if="testingNames.length" class="truncate" :title="testingNames.join('、')">正在测试：{{ testingNames.slice(0, 3).join('、') }}{{ testingNames.length > 3 ? ` 等 ${testingNames.length} 个节点` : '' }}</div>
        <div v-else>{{ recommendationStore.batchTestProgress.completed === recommendationStore.batchTestProgress.total ? '正在刷新测量结果…' : recommendationStore.batchTestProgress.current || '正在准备检测…' }}</div>
        <div v-if="testingDomains.length" class="break-all opacity-75">目标：{{ testingDomains.join('、') }}</div>
      </div>
      <button v-if="activeProbes.length" class="btn btn-ghost btn-sm shrink-0" title="取消本次代理延迟测试" aria-label="取消本次代理延迟测试" @click="abortTest"><IconX :size="16" /><span>取消测速</span></button>
    </div>

    <div ref="scrollEl" data-testid="proxies-scroll-container" class="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto" @scroll.passive="onScroll">
      <template v-if="activeTab === 'proxies'">
        <div v-if="initialRead || (!proxiesStore.proxiesLoaded && !renderProxies.length)" class="flex flex-col gap-3 p-1"><div v-for="i in 4" :key="i" class="h-20 animate-pulse rounded-xl bg-base-content/5" /></div>
        <NativeProxyMasterDetail v-else-if="renderProxies.length" ref="proxyMasterDetail" :groups="renderProxies" :sorted-names-by-group="sortedNamesByGroup" :scroll-container="scrollEl" :batch-testing="isBatchTesting" :tcp-testing="tcpRunning" :site-testing="!!siteProbes.running.value" :site-counts="siteCounts" @test-tcp="(names, group) => testTcp(names, group)" @test-group="name => { if (!anyTesting) testMultipleGroups([name]) }" @test-sites="name => { if (!anyTesting) siteProbes.run(name) }" @scroll="onScroll" />
        <div v-else class="py-12 text-center text-sm text-base-content/50">暂无策略组 <NuxtLink to="/subscriptions" class="link link-primary">选择订阅</NuxtLink></div>
      </template>
      <div v-else class="flex flex-col gap-3">
        <section v-for="provider in proxiesStore.proxyProviders" :key="provider.name" class="rounded-xl border border-base-content/10 p-3">
          <div class="mb-2 flex flex-wrap items-center gap-2"><h2 class="min-w-0 flex-1 truncate font-semibold">{{ provider.name }}</h2><span class="text-xs text-base-content/60">{{ provider.proxies.length }} · {{ provider.vehicleType }}</span><button class="btn btn-ghost btn-sm" :aria-label="`更新 ${provider.name}`" title="更新代理提供者" :disabled="proxiesStore.updatingMap[provider.name]" @click="proxiesStore.updateProviderByProviderName(provider.name)"><IconReload :size="16" :class="{ 'animate-spin motion-reduce:animate-none': proxiesStore.updatingMap[provider.name] }" /><span>更新</span></button><button class="btn btn-ghost btn-sm" title="测试此代理提供者的代理延迟" :aria-label="`测试 ${provider.name} 代理延迟`" :disabled="proxiesStore.proxyProviderLatencyTestingMap[provider.name]" @click="proxiesStore.proxyProviderLatencyTest(provider.name)"><IconBrandSpeedtest :size="16" :class="{ 'animate-pulse motion-reduce:animate-none': proxiesStore.proxyProviderLatencyTestingMap[provider.name] }" /><span>测延迟</span></button></div>
          <SubscriptionInfo :subscription-info="provider.subscriptionInfo" />
          <div class="my-2 text-xs text-base-content/50">{{ t('updated') }} {{ formatTimeFromNow(provider.updatedAt, locale) }}</div>
          <div class="flex flex-col gap-2"><ProxyNodeListItem v-for="name in providerNames(provider)" :key="name" :proxy-name="name" :test-url="provider.testUrl || null" :timeout="provider.timeout ?? null" :provider-name="provider.name" /></div>
        </section>
        <div v-if="!proxiesStore.proxyProviders.length" class="py-12 text-center text-sm text-base-content/50">{{ t('noData') }}</div>
      </div>
    </div>
    <button v-if="showScrollToTop" data-testid="scroll-to-top" class="btn btn-primary btn-sm btn-circle absolute right-3 bottom-3 z-30 size-9 min-h-9 shadow-sm" :title="t('backToTop')" :aria-label="t('backToTop')" @click="scrollToTop"><IconArrowUp :size="17" aria-hidden="true" /></button>

    <Modal ref="settingsModal" title="代理设置" compact settings-layout fixed-height>
      <template #tabs>
        <div class="flex gap-2" role="tablist" aria-label="代理设置类别"><button v-for="tab in [{ key: 'general', name: '通用', icon: IconSettings }, { key: 'detection', name: '检测', icon: IconBrandSpeedtest }, { key: 'sites', name: '站点目录', icon: IconWorld }]" :key="tab.key" type="button" role="tab" class="btn btn-sm" :class="settingsTab === tab.key ? 'btn-primary' : 'btn-ghost'" :aria-selected="settingsTab === tab.key" @click="settingsTab = tab.key as typeof settingsTab"><component :is="tab.icon" :size="16" aria-hidden="true" /><span>{{ tab.name }}</span></button></div>
      </template>
      <div class="flex flex-col gap-4">
        <template v-if="settingsTab === 'general'">
          <HelpTip>这些页面偏好只保存在当前浏览器。</HelpTip>
          <label class="flex items-center gap-2"><input v-model="configStore.autoCloseConns" type="checkbox" class="checkbox checkbox-primary checkbox-xs" />切换节点时断开连接</label>
          <label class="flex items-center gap-2"><input v-model="configStore.hideUnAvailableProxies" type="checkbox" class="checkbox checkbox-primary checkbox-xs" />隐藏不可用节点</label>
          <button type="button" class="btn btn-outline btn-sm self-end" @click="resetGeneral"><IconReload :size="16" /><span>恢复通用默认值</span></button>
        </template>
        <template v-else-if="settingsTab === 'detection'">
          <HelpTip>基准检测偏好保存在当前浏览器。站点结果独立展示，不覆盖基准延迟，也不参与自动选点。</HelpTip>
          <label class="flex flex-col gap-2">基准检测网址<input v-model="configStore.urlForLatencyTest" class="input w-full" type="url" /></label>
          <label class="flex flex-col gap-2">检测网址来源<select v-model="configStore.latencyTestUrlSource" class="select w-full"><option value="core">优先使用策略组配置</option><option value="dashboard">统一使用基准网址</option></select></label>
          <label class="flex flex-col gap-2">检测超时（ms）<input v-model.number="configStore.latencyTestTimeoutDuration" class="input w-full" type="number" min="1" max="10000" /></label>
          <fieldset class="space-y-2"><legend class="text-sm">延迟颜色阈值（ms）</legend><label class="flex items-center justify-between gap-3">黄色<input v-model.number="configStore.latencyMediumThreshold" class="input w-32" type="number" min="0" /></label><label class="flex items-center justify-between gap-3">红色<input v-model.number="configStore.latencyHighThreshold" class="input w-32" type="number" min="0" /></label><p class="text-xs text-base-content/55">0 表示使用默认值。站点色条中黄色仍表示探测成功，红色表示失败。</p></fieldset>
          <button type="button" class="btn btn-outline btn-sm self-end" @click="resetDetection"><IconReload :size="16" /><span>恢复基准检测默认值</span></button>
          <AutoProbeSettings />
        </template>
        <SiteTargetSettings v-else :scroll-list="false" />
      </div>
    </Modal>
    <Modal ref="detailsModal" title="站点连通"><SiteProbeDetails :group="detailsGroup" :node="detailsNode" :busy="anyTesting" /></Modal>
  </div>
</template>
