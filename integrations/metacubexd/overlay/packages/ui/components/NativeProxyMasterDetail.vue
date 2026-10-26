<script setup lang="ts">
import type { Proxy as ProxyType } from '~/types'
import AutomaticProxyNode from '~/components/AutomaticProxyNode.vue'
import WorkspaceGroupsMenu from '~/components/WorkspaceGroupsMenu.vue'
import AutomaticSelectionSettings from '~/components/AutomaticSelectionSettings.vue'
import AutomaticSelectionHistory from '~/components/AutomaticSelectionHistory.vue'
import GroupRuleSummary from '~/components/GroupRuleSummary.vue'
import { useProxyWorkbench } from '~/composables/useProxyWorkbench'
import { siteGroupMembers } from '~/composables/useSiteProbes'
import {
  IconBolt,
  IconActivity,
  IconBrandSpeedtest,
  IconChevronRight,
  IconLink,
  IconRefresh,
  IconRouter,
  IconTarget,
  IconWorld,
  IconX,
} from '@tabler/icons-vue'
import {
  filterNodesByCapability,
  filterNodesByRegion,
  filterNodesByType,
  formatProxyType,
  getCapabilityFacets,
  getRegionFacets,
  getTypeFacets,
} from '~/utils'

interface Props {
  groups: ProxyType[]
  sortedNamesByGroup: Record<string, string[]>
  scrollContainer?: HTMLElement | null
  batchTesting?: boolean
  tcpTesting?: boolean
  siteTesting?: boolean
  siteCounts?: Record<string, number>
}

const props = defineProps<Props>()
const emit = defineEmits<{
  scroll: [event: Event]
  'test-group': [name: string]
  'test-tcp': [names: string[], group: string]
  'test-sites': [group: string]
}>()

const proxiesStore = useProxiesStore()
const { t } = useI18n()

const groupNames = computed(() => props.groups.map((g) => g.name))

// A configuration generation changes on every persisted node selection. Keep
// browsing state under the scheme identity instead, including across navigation.
const { workspace } = useWorkspace()
const { view, busy, overrides } = useWorkspace()
const scope = `${workspace.value?.mode ?? 'initial'}:${workspace.value?.mode === 'subscription' ? workspace.value.subscriptionId ?? '' : ''}`
const { activeName, scrollTop } = useProxyWorkbench(scope, groupNames)

const activeGroup = computed(
  () => props.groups.find((g) => g.name === activeName.value) ?? null,
)
const groupRole = (name: string) => view.value?.groups.find(group => group.name === name)?.role ?? 'service'
const isSharedGroup = (group: ProxyType) => groupRole(group.name) === 'shared'
const resolvedNode = (group: ProxyType) => proxiesStore.getNowProxyNodeName(group.name)
function isAutomaticGroup(group: ProxyType) {
  const policy = overrides.value.automatic?.[group.name]
  return group.type === 'Selector' && !!policy && policy.enabled !== false
}
const automaticEnabled = computed(() => !!activeGroup.value && isAutomaticGroup(activeGroup.value))
const canSelect = computed(() => activeGroup.value?.type === 'Selector')
const activeNodes = computed(() =>
  activeGroup.value
    ? props.sortedNamesByGroup[activeGroup.value.name] || []
    : [],
)

// --- Local workbench state (scoped to the active group; reset on switch) ---
const selectedRegions = ref<Set<string>>(new Set())
const selectedTypes = ref<Set<string>>(new Set())
const filterUdp = ref(false)
const filterXudp = ref(false)

// type/udp/xudp aren't encoded in the node name, so facet/filter helpers read
// them through the store's node read-model.
const metaOf = (name: string) => proxiesStore.getNode(name)

// Facets derive from the (sorted/globally-filtered) group node list, so chip
// counts stay stable as the active filters narrow the displayed list.
const regionFacets = computed(() => getRegionFacets(activeNodes.value))
const typeFacets = computed(() => getTypeFacets(activeNodes.value, metaOf))
const capabilityFacets = computed(() =>
  getCapabilityFacets(activeNodes.value, metaOf),
)

const hasCapability = computed(
  () => capabilityFacets.value.udp > 0 || capabilityFacets.value.xudp > 0,
)
const hasAnyFacet = computed(
  () =>
    regionFacets.value.length > 1 ||
    typeFacets.value.length > 1 ||
    hasCapability.value,
)
const hasActiveFilter = computed(
  () =>
    selectedRegions.value.size > 0 ||
    selectedTypes.value.size > 0 ||
    filterUdp.value ||
    filterXudp.value,
)

const displayNodes = computed(() =>
  filterNodesByCapability(
    filterNodesByType(
      filterNodesByRegion(activeNodes.value, selectedRegions.value),
      selectedTypes.value,
      metaOf,
    ),
    { udp: filterUdp.value, xudp: filterXudp.value },
    metaOf,
  ),
)

const selectedVisible = computed(
  () =>
    !!activeGroup.value?.now &&
    displayNodes.value.includes(activeGroup.value.now),
)
const allMembers = computed(() => activeGroup.value ? siteGroupMembers(activeGroup.value.name, proxiesStore.proxies) : [])
const hasTcpNodes = computed(() => allMembers.value.some(name => view.value?.tcpNodes?.some(node => node.name === name && node.applicable)))
const detectionBusy = computed(() => props.batchTesting || props.tcpTesting || props.siteTesting || busy.value)
const detectionMenu = ref<HTMLDetailsElement>()
const groupSettings = ref<{ openSites: () => void; openRules: () => void }>()
async function configureGroupRules(name: string) {
  activeName.value = name
  await nextTick()
  groupSettings.value?.openRules()
}
function detect(kind: 'latency' | 'tcp' | 'sites') {
  if (!activeGroup.value || detectionBusy.value) return
  if (detectionMenu.value) detectionMenu.value.open = false
  if (kind === 'latency') emit('test-group', activeGroup.value.name)
  else if (kind === 'tcp') emit('test-tcp', [...allMembers.value], activeGroup.value.name)
  else if (!props.siteCounts?.[activeGroup.value.name]) groupSettings.value?.openSites()
  else emit('test-sites', activeGroup.value.name)
}

function toggleInSet(set: Ref<Set<string>>, key: string) {
  const next = new Set(set.value)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  set.value = next
}
const toggleRegion = (code: string) => toggleInSet(selectedRegions, code)
const toggleType = (type: string) => toggleInSet(selectedTypes, type)

function clearFilters() {
  selectedRegions.value = new Set()
  selectedTypes.value = new Set()
  filterUdp.value = false
  filterXudp.value = false
}

// Shared pill styling for every filter chip (region / protocol / feature).
function chipClass(active: boolean) {
  return [
    'flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs transition-all duration-150',
    active
      ? 'border-primary/50 bg-primary/15 text-primary'
      : 'border-base-content/10 bg-base-100/60 text-base-content/60 hover:border-primary/30 hover:text-base-content/80',
  ]
}

// On mobile the page scrolls; on desktop only the node list scrolls so the
// group title and filters remain fixed at the top of the detail pane.
// The selected row carries data-selected="true" (a fallthrough attr on
// ProxyNodeListItem's root).
const nodeListEl = ref<HTMLElement | null>(null)
function scrollSelectedIntoView(behavior: ScrollBehavior = 'smooth') {
  nodeListEl.value
    ?.querySelector('[data-selected="true"]')
    ?.scrollIntoView({ block: 'center', behavior })
}

function scrollToTop(behavior: ScrollBehavior = 'smooth') {
  nodeListEl.value?.scrollTo({ top: 0, behavior })
}

function onScroll(event: Event) {
  scrollTop.value = (event.currentTarget as HTMLElement).scrollTop
  emit('scroll', event)
}

async function selectNode(name: string) {
  const group = activeGroup.value
  if (!group || busy.value || (group.now === name && !automaticEnabled.value)) return
  const top = nodeListEl.value?.scrollTop ?? 0
  const outerTop = props.scrollContainer?.scrollTop ?? 0
  try { await proxiesStore.selectProxyInGroup(group, name) }
  catch { /* useWorkspace owns the visible error and verifies core selection. */ }
  await nextTick()
  if (activeName.value === group.name) {
    nodeListEl.value?.scrollTo({ top, behavior: 'auto' })
    props.scrollContainer?.scrollTo({ top: outerTop, behavior: 'auto' })
  }
}

defineExpose({ scrollToTop, activeName })

// On group switch: reset local filters and reveal the selected node.
watch(activeName, () => {
  clearFilters()
  nextTick(() => scrollSelectedIntoView('auto'))
})

// First paint (master mode just opened): activeName resolves synchronously in
// the watchEffect above, before the watch() is wired — so it never fires for the
// initial group. Reveal the selected node once the list is mounted.
onMounted(() => nextTick(() => {
  const top = scrollTop.value
  if (top > 0) nodeListEl.value?.scrollTo({ top, behavior: 'auto' })
  else scrollSelectedIntoView('auto')
}))

function aliveCount(group: ProxyType) {
  return proxiesStore.aliveNodeNames(group.all ?? []).length
}
</script>

<template>
  <div class="flex min-h-0 flex-col gap-3 sm:h-full sm:flex-row" :data-active-group="activeName">
    <!-- Group navigation: horizontal strip on mobile, left rail on >=sm -->
    <div
      class="flex shrink-0 gap-1 overflow-x-auto pb-1 sm:w-48 sm:flex-col sm:overflow-x-visible sm:overflow-y-auto sm:pb-0"
    >
      <WorkspaceGroupsMenu :active-group="activeName" :configure="configureGroupRules" />
      <button
        v-for="group in groups"
        :key="group.name"
        type="button"
        :aria-label="`${isSharedGroup(group) ? '共享出口组' : '策略组'} ${group.name}${isAutomaticGroup(group) ? '，自动选择' : ''}`"
        :aria-pressed="group.name === activeName"
        class="flex w-44 shrink-0 items-center gap-2 rounded-lg border px-3 py-2 text-left transition-all duration-200 sm:w-auto sm:shrink"
        :class="
          group.name === activeName
            ? 'border-primary/55 bg-primary/12 text-base-content'
            : 'border-base-content/8 bg-base-200/60 text-base-content/70 hover:border-primary/30 hover:bg-primary/8'
        "
        @click="activeName = group.name"
      >
        <span v-if="isSharedGroup(group) || isAutomaticGroup(group)" class="flex shrink-0 flex-col items-start gap-0.5">
          <span
            v-if="isSharedGroup(group)"
            class="inline-flex shrink-0 items-center gap-0.5 whitespace-nowrap rounded border border-info/25 bg-info/10 px-1 py-0.5 text-[0.65rem] leading-none text-info"
          >
            <IconLink :size="12" aria-hidden="true" />
            <span>共享</span>
          </span>
          <span
            v-if="isAutomaticGroup(group)"
            class="inline-flex shrink-0 items-center gap-0.5 whitespace-nowrap rounded border border-primary/25 bg-primary/10 px-1 py-0.5 text-[0.65rem] leading-none text-primary"
          >
            <IconRefresh :size="12" aria-hidden="true" />
            <span>自动</span>
          </span>
        </span>
        <span class="flex min-w-0 flex-1 flex-col gap-0.5">
          <span class="flex min-w-0 items-center justify-between gap-2">
            <span class="truncate text-sm font-semibold">{{ group.name }}</span>
            <span class="shrink-0 text-[0.7rem] text-base-content/50">
              {{ aliveCount(group) }}/{{ group.all?.length ?? 0 }}
            </span>
          </span>
          <span class="hidden truncate text-xs text-base-content/45 sm:block">
            {{ group.now }}<template v-if="resolvedNode(group) !== group.now"> → {{ resolvedNode(group) }}</template>
          </span>
        </span>
      </button>
    </div>

    <!-- Right detail: active group's nodes + workbench bar -->
    <div
      v-if="activeGroup"
      class="flex min-w-0 flex-col rounded-xl border border-base-content/8 bg-base-200/40 sm:min-h-0 sm:flex-1 sm:overflow-hidden"
    >
      <div
        data-testid="master-detail-header"
        class="flex shrink-0 flex-col gap-2 rounded-t-xl border-b border-base-content/8 bg-base-200/95 px-3 pt-3 pb-2"
      >
        <div class="flex min-w-0 flex-wrap items-center gap-2">
          <div class="flex min-w-0 flex-1 basis-full items-center gap-2 sm:basis-auto">
            <span class="truncate text-lg font-semibold text-base-content">{{
              activeGroup.name
            }}</span>
            <span v-if="isSharedGroup(activeGroup)" class="badge badge-sm badge-info gap-1"><IconLink :size="12" aria-hidden="true" /><span>共享出口</span></span>
            <span
              class="badge inline-flex min-w-0 items-center gap-1 badge-sm badge-primary"
            >
              <IconRefresh v-if="automaticEnabled" :size="14" class="shrink-0" aria-hidden="true" />
              <span class="shrink-0 font-bold">{{
                automaticEnabled ? '自动选点' : canSelect ? '手动选择' : formatProxyType(activeGroup.type, t)
              }}</span>
              <template v-if="activeGroup.now?.length">
                <IconChevronRight :size="16" class="shrink-0" />
                <span class="min-w-0 truncate">{{ activeGroup.now }}</span>
                <template v-if="resolvedNode(activeGroup) !== activeGroup.now">
                  <IconChevronRight :size="16" class="shrink-0" />
                  <span class="min-w-0 truncate">{{ resolvedNode(activeGroup) }}</span>
                </template>
              </template>
            </span>
          </div>
          <span class="shrink-0 text-xs text-base-content/45">
            {{ displayNodes.length }}/{{ activeNodes.length }}
          </span>
          <details ref="detectionMenu" class="dropdown dropdown-end">
            <summary class="btn btn-ghost btn-sm" aria-label="选择检测类型"><IconBrandSpeedtest :size="18" /><span>检测</span><span aria-hidden="true">▾</span></summary>
            <div class="dropdown-content z-40 w-64 rounded-xl border border-base-content/10 bg-base-200 p-2 shadow-xl">
              <p class="px-2 py-1 text-xs text-base-content/60">当前策略组 · 全部可检测节点<br />不受名称、地区和协议筛选影响</p>
              <button type="button" class="btn btn-ghost btn-sm w-full justify-start" :disabled="detectionBusy || !allMembers.length" @click="detect('latency')"><IconBrandSpeedtest :size="16" /><span>代理延迟</span></button>
              <button type="button" class="btn btn-ghost btn-sm w-full justify-start" :disabled="detectionBusy || !hasTcpNodes" @click="detect('tcp')"><IconBolt :size="16" /><span>TCP 延迟</span></button>
              <button type="button" class="btn btn-ghost btn-sm w-full justify-start" :disabled="detectionBusy || !allMembers.length" @click="detect('sites')"><IconActivity :size="16" /><span>站点连通 · {{ siteCounts?.[activeGroup.name] ? `已选 ${siteCounts[activeGroup.name]} 项` : '选择站点' }}</span></button>
            </div>
          </details>
          <button
            type="button"
            class="flex h-8 shrink-0 items-center justify-center gap-1 rounded-lg border border-base-content/10 bg-base-100/60 px-2 text-xs text-base-content/70 transition-all duration-200 hover:border-primary/30 hover:bg-primary/15 hover:text-primary disabled:cursor-not-allowed disabled:opacity-40"
            :disabled="!selectedVisible"
            :title="t('jumpToCurrent')"
            :aria-label="t('jumpToCurrent')"
            @click="scrollSelectedIntoView()"
          >
            <IconTarget :size="18" />
            <span>定位</span>
          </button>
          <AutomaticSelectionSettings ref="groupSettings" :group-name="activeGroup.name" :selectable="canSelect" />
          <AutomaticSelectionHistory :group-name="activeGroup.name" :selectable="canSelect" />
        </div>

        <p v-if="automaticEnabled" class="text-xs text-primary" role="status">点击节点可切换为手动选择</p>
        <GroupRuleSummary :group-name="activeGroup.name" @configure="groupSettings?.openRules()" />

        <!-- Quick-filter rail: region · protocol · features. Each facet group
             gets its own row so a long region list (many flags) can never push
             the protocol/feature filters off-screen — every row scrolls on its
             own, with its category icon pinned left. Rows render only when the
             group offers a real choice. -->
        <div v-if="hasAnyFacet" class="flex items-start gap-1.5">
          <div class="flex min-w-0 flex-1 flex-col gap-1.5">
            <!-- Region -->
            <div
              v-if="regionFacets.length > 1"
              class="flex items-center gap-1.5"
            >
              <IconWorld
                :size="14"
                class="shrink-0 text-base-content/35"
                aria-hidden="true"
              />
              <div
                class="-mx-0.5 flex min-w-0 flex-1 [scrollbar-width:none] items-center gap-1.5 overflow-x-auto px-0.5 py-px [&::-webkit-scrollbar]:hidden"
              >
                <button
                  type="button"
                  :class="chipClass(selectedRegions.size === 0)"
                  :aria-pressed="selectedRegions.size === 0"
                  @click="selectedRegions = new Set()"
                >
                  {{ t('all') }}
                </button>
                <button
                  v-for="facet in regionFacets"
                  :key="`region-${facet.code}`"
                  type="button"
                  :class="chipClass(selectedRegions.has(facet.code))"
                  :aria-pressed="selectedRegions.has(facet.code)"
                  @click="toggleRegion(facet.code)"
                >
                  <span>{{ facet.flag || t('regionOther') }}</span>
                  <span class="opacity-55">{{ facet.count }}</span>
                </button>
              </div>
            </div>

            <!-- Protocol -->
            <div v-if="typeFacets.length > 1" class="flex items-center gap-1.5">
              <IconRouter
                :size="14"
                class="shrink-0 text-base-content/35"
                aria-hidden="true"
              />
              <div
                class="-mx-0.5 flex min-w-0 flex-1 [scrollbar-width:none] items-center gap-1.5 overflow-x-auto px-0.5 py-px [&::-webkit-scrollbar]:hidden"
              >
                <button
                  type="button"
                  :class="chipClass(selectedTypes.size === 0)"
                  :aria-pressed="selectedTypes.size === 0"
                  @click="selectedTypes = new Set()"
                >
                  {{ t('all') }}
                </button>
                <button
                  v-for="facet in typeFacets"
                  :key="`type-${facet.type}`"
                  type="button"
                  :class="chipClass(selectedTypes.has(facet.type))"
                  :aria-pressed="selectedTypes.has(facet.type)"
                  @click="toggleType(facet.type)"
                >
                  <span>{{ formatProxyType(facet.type, t) }}</span>
                  <span class="opacity-55">{{ facet.count }}</span>
                </button>
              </div>
            </div>

            <!-- Features: UDP / XUDP independent toggles -->
            <div v-if="hasCapability" class="flex items-center gap-1.5">
              <IconBolt
                :size="14"
                class="shrink-0 text-base-content/35"
                aria-hidden="true"
              />
              <div
                class="-mx-0.5 flex min-w-0 flex-1 [scrollbar-width:none] items-center gap-1.5 overflow-x-auto px-0.5 py-px [&::-webkit-scrollbar]:hidden"
              >
                <button
                  v-if="capabilityFacets.udp > 0"
                  type="button"
                  :class="chipClass(filterUdp)"
                  :aria-pressed="filterUdp"
                  @click="filterUdp = !filterUdp"
                >
                  <span>{{ t('udp') }}</span>
                  <span class="opacity-55">{{ capabilityFacets.udp }}</span>
                </button>
                <button
                  v-if="capabilityFacets.xudp > 0"
                  type="button"
                  :class="chipClass(filterXudp)"
                  :aria-pressed="filterXudp"
                  @click="filterXudp = !filterXudp"
                >
                  <span>XUDP</span>
                  <span class="opacity-55">{{ capabilityFacets.xudp }}</span>
                </button>
              </div>
            </div>
          </div>

          <!-- Clear all active filters; pinned top-right, outside the rows -->
          <button
            v-if="hasActiveFilter"
            type="button"
            class="mt-0.5 flex shrink-0 items-center rounded-full p-1 text-base-content/40 transition-colors hover:bg-base-content/8 hover:text-base-content"
            :title="t('clearFilters')"
            :aria-label="t('clearFilters')"
            @click="clearFilters"
          >
            <IconX :size="14" />
            <span class="px-1 text-xs">清空筛选</span>
          </button>
        </div>
      </div>

      <!-- Node list -->
      <div
        ref="nodeListEl"
        data-testid="master-detail-scroll-container"
        class="flex flex-col gap-2 px-3 pt-2 pb-3 sm:min-h-0 sm:flex-1 sm:overflow-y-auto"
        @scroll.passive="onScroll"
      >
        <template v-for="name in displayNodes" :key="name">
          <ProxyNodeListItem
            v-if="canSelect"
            :proxy-name="name"
            :group-name="activeGroup.name"
            :kind-label="groupRole(name) === 'shared' ? '共享出口' : ''"
            :test-url="activeGroup.testUrl || null"
            :timeout="activeGroup.timeout ?? null"
            :is-selected="activeGroup.now === name"
            :data-selected="activeGroup.now === name ? 'true' : undefined"
            @click="selectNode(name)"
          />
          <AutomaticProxyNode
            v-else
            :proxy-name="name"
            :group-name="activeGroup.name"
            :test-url="activeGroup.testUrl || null"
            :timeout="activeGroup.timeout ?? null"
            :is-selected="activeGroup.now === name"
            :data-selected="activeGroup.now === name ? 'true' : undefined"
          />
        </template>
        <div
          v-if="displayNodes.length === 0"
          class="py-8 text-center text-sm text-base-content/40"
        >
          {{ t('noData') }}
        </div>
      </div>
    </div>
  </div>
</template>
