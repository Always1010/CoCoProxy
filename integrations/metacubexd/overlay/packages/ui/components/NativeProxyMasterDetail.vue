<script setup lang="ts">
import type { Proxy as ProxyType } from '~/types'
import AutomaticProxyNode from '~/components/AutomaticProxyNode.vue'
import WorkspaceGroupsMenu from '~/components/WorkspaceGroupsMenu.vue'
import { useProxyWorkbench } from '~/composables/useProxyWorkbench'
import { useTcpDelay } from '~/composables/useTcpDelay'
import {
  IconBolt,
  IconBrandSpeedtest,
  IconChevronRight,
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
}

const props = defineProps<Props>()
const emit = defineEmits<{
  scroll: [event: Event]
}>()

const proxiesStore = useProxiesStore()
const { t } = useI18n()

const groupNames = computed(() => props.groups.map((g) => g.name))

// A configuration generation changes on every persisted node selection. Keep
// browsing state under the scheme identity instead, including across navigation.
const { workspace } = useWorkspace()
const { view, busy } = useWorkspace()
const { metadata: tcpMetadata, run: runTcp, cancel: cancelTcp, isRunning: tcpRunning, completed: tcpCompleted, total: tcpTotal } = useTcpDelay()
const scope = `${workspace.value?.mode ?? 'initial'}:${workspace.value?.mode === 'subscription' ? workspace.value.subscriptionId ?? '' : ''}`
const { activeName, scrollTop } = useProxyWorkbench(scope, groupNames)

const activeGroup = computed(
  () => props.groups.find((g) => g.name === activeName.value) ?? null,
)
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
const hasTcpNodes = computed(() => displayNodes.value.some(name => tcpMetadata(name)?.applicable))
function testAllTcp() { return runTcp(view.value?.tcpNodes?.map(node => node.name) ?? []) }

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
  if (!group || busy.value || group.now === name) return
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

defineExpose({ scrollToTop })

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
      <WorkspaceGroupsMenu :active-group="activeName" />
      <button
        v-for="group in groups"
        :key="group.name"
        type="button"
        :aria-label="`策略组 ${group.name}`"
        :aria-pressed="group.name === activeName"
        class="flex w-36 shrink-0 flex-col gap-0.5 rounded-lg border px-3 py-2 text-left transition-all duration-200 sm:w-auto sm:shrink"
        :class="
          group.name === activeName
            ? 'border-primary/55 bg-primary/12 text-base-content'
            : 'border-base-content/8 bg-base-200/60 text-base-content/70 hover:border-primary/30 hover:bg-primary/8'
        "
        @click="activeName = group.name"
      >
        <span class="flex items-center justify-between gap-2">
          <span class="truncate text-sm font-semibold">{{ group.name }}</span>
          <span class="shrink-0 text-[0.7rem] text-base-content/50">
            {{ aliveCount(group) }}/{{ group.all?.length ?? 0 }}
          </span>
        </span>
        <span class="hidden truncate text-xs text-base-content/45 sm:block">{{
          group.now
        }}</span>
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
        <div class="flex min-w-0 flex-wrap items-center gap-2 sm:flex-nowrap">
          <div class="flex min-w-0 flex-1 basis-full items-center gap-2 sm:basis-auto">
            <span class="truncate text-lg font-semibold text-base-content">{{
              activeGroup.name
            }}</span>
            <span
              class="badge inline-flex min-w-0 items-center gap-1 badge-sm badge-primary"
            >
              <span class="shrink-0 font-bold">{{
                formatProxyType(activeGroup.type, t)
              }}</span>
              <template v-if="activeGroup.now?.length">
                <IconChevronRight :size="16" class="shrink-0" />
                <span class="min-w-0 truncate">{{ activeGroup.now }}</span>
              </template>
            </span>
          </div>
          <span class="shrink-0 text-xs text-base-content/45">
            {{ displayNodes.length }}/{{ activeNodes.length }}
          </span>
          <span v-if="tcpRunning" role="status" class="shrink-0 text-xs text-primary">{{ tcpCompleted }}/{{ tcpTotal }}</span>
          <button type="button" class="btn btn-ghost btn-sm" :disabled="!tcpRunning && (busy || !hasTcpNodes)" :title="tcpRunning ? '取消 TCP 延迟测试' : '测试当前组可见节点 TCP 延迟（从网关建连）'" :aria-label="tcpRunning ? '取消 TCP 延迟测试' : '测试当前组可见节点 TCP 延迟'" @click="tcpRunning ? cancelTcp() : runTcp(displayNodes)"><IconX v-if="tcpRunning" :size="18" /><IconBolt v-else :size="18" /></button>
          <details class="dropdown dropdown-end shrink-0">
            <summary class="btn btn-ghost btn-xs" title="更多 TCP 测试操作" aria-label="更多 TCP 测试操作"><IconChevronRight :size="14" class="rotate-90" /></summary>
            <ul class="dropdown-content z-30 menu mt-1 w-52 rounded-box border border-base-content/10 bg-base-200 shadow-lg"><li><button :disabled="tcpRunning || busy" @click="testAllTcp">测试全部节点 TCP 延迟</button></li></ul>
          </details>
          <button type="button" class="btn btn-ghost btn-sm" title="测试当前组代理延迟（访问测试网址）" aria-label="测试当前组代理延迟" :disabled="proxiesStore.proxyGroupLatencyTestingMap[activeGroup.name]" @click="proxiesStore.proxyGroupLatencyTest(activeGroup.name)"><IconBrandSpeedtest :size="18" /></button>
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
        </div>

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
            :test-url="activeGroup.testUrl || null"
            :timeout="activeGroup.timeout ?? null"
            :is-selected="activeGroup.now === name"
            :data-selected="activeGroup.now === name ? 'true' : undefined"
            @click="selectNode(name)"
          />
          <AutomaticProxyNode
            v-else
            :proxy-name="name"
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
