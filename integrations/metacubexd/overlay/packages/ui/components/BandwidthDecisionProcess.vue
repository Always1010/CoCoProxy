<script setup lang="ts">
import { IconArrowLeft, IconChevronRight, IconRefresh, IconRoute } from '@tabler/icons-vue'
import { CoCoProxyError, cocoproxyErrorMessage } from '~/composables/useCoCoProxy'
import { processReason, processTraceRows } from '~/utils/bandwidth-process'
import type { ProcessResponse } from '~/utils/bandwidth-process'
import BandwidthTraceEvent from '~/components/BandwidthTraceEvent.vue'

const props = withDefaults(defineProps<{ groupName: string; selectable: boolean; inline?: boolean; dirty?: boolean }>(), { inline: false, dirty: false })
const { t, te, locale } = useI18n()
const { api, view } = useWorkspace()
const dialog = ref<{ open: () => void; close: () => void }>()
const scroller = ref<HTMLElement>()
const visible = ref(false)
const data = ref<ProcessResponse>()
const selectedId = ref<string | null>(null)
const loading = ref(false)
const updatedAt = ref<number | null>(null)
const error = useLocalizedMessage()
const delayed = ref(false)
let timer: ReturnType<typeof setTimeout> | undefined
let session = 0, requestId = 0, disposed = false
let reading = false
let controller: AbortController | undefined
let lockedSince: number | null = null
const scope = computed(() => {
  const workspace = view.value?.workspace
  return workspace ? JSON.stringify([workspace.mode, workspace.mode === 'subscription' ? workspace.subscriptionId : workspace.sourceIds]) : ''
})
const rounds = computed(() => [...(data.value?.rounds ?? [])].sort((a, b) => b.startedAt - a.startedAt))
const detail = computed(() => data.value?.detail?.id === selectedId.value ? data.value.detail : null)
const rows = computed(() => processTraceRows(detail.value?.events ?? []))
const time = (at: number | null | undefined) => at === null || at === undefined ? t('coco.process.unknown') : new Date(at).toLocaleString(locale.value)
const shortTime = (at: number) => new Date(at).toLocaleTimeString(locale.value)
const reason = (value: string) => {
  const key = 'coco.process.trace.reason.' + value
  return te(key) ? t(key) : processReason(value, t)
}

async function refresh(background = true) {
  if (!visible.value || disposed || document.hidden || !view.value || (background && reading)) return
  const id = ++requestId, expectedScope = scope.value, revision = view.value.workspace.revision
  controller?.abort(); controller = new AbortController()
  const query = new URLSearchParams({ group: props.groupName, scope: expectedScope, revision: String(revision) })
  if (selectedId.value) query.set('round', selectedId.value)
  reading = true
  loading.value = !background || !data.value
  if (!background) { lockedSince = null; delayed.value = false }
  try {
    const result = await api.request<ProcessResponse>('/api/cocoproxy/automatic/bandwidth/history?' + query, { signal: controller.signal })
    if (!visible.value || id !== requestId || expectedScope !== scope.value) return
    if (result.status.scope !== expectedScope || result.status.workspaceRevision !== view.value?.workspace.revision) {
      error.value = () => t('coco.anThePlanOrSettingsChangedClose'); return
    }
    if (JSON.stringify(result) !== JSON.stringify(data.value)) data.value = result
    updatedAt.value = Date.now(); error.value = ''; delayed.value = false; lockedSince = null
  } catch (cause) {
    if (visible.value && id === requestId) {
      if (background && data.value && cause instanceof CoCoProxyError && cause.code === 'STORE_LOCKED') {
        lockedSince ??= Date.now(); delayed.value = true
        if (Date.now() - lockedSince >= 15000) error.value = () => cocoproxyErrorMessage(cause, t)
      } else { delayed.value = false; lockedSince = null; error.value = () => cocoproxyErrorMessage(cause, t) }
    }
  } finally { if (id === requestId) { reading = false; loading.value = false } }
}
async function poll(currentSession: number) {
  await refresh()
  if (visible.value && !disposed && currentSession === session) timer = setTimeout(() => { void poll(currentSession) }, 5000)
}
function open() {
  close(); data.value = undefined; selectedId.value = null; updatedAt.value = null; error.value = ''; delayed.value = false; lockedSince = null
  visible.value = true; dialog.value?.open(); void poll(session)
}
function close() {
  session++; requestId++; visible.value = false; reading = false; loading.value = false; controller?.abort()
  if (timer) clearTimeout(timer)
}
function choose(id: string | null) { selectedId.value = id; scroller.value?.scrollTo({ top: 0 }); void refresh(false) }
function visibilityChanged() { if (!document.hidden && visible.value) void refresh() }
watch(() => [props.groupName, scope.value, view.value?.workspace.revision], () => { dialog.value?.close(); close() })
onMounted(() => document.addEventListener('visibilitychange', visibilityChanged))
onUnmounted(() => { disposed = true; close(); document.removeEventListener('visibilitychange', visibilityChanged) })

defineExpose({ open })
</script>

<template>
  <span v-if="selectable" :class="inline ? 'block' : 'shrink-0'">
    <button type="button" class="btn btn-ghost min-h-11" :class="inline ? 'w-full justify-between' : 'btn-sm'" @click="open"><span class="flex items-center gap-2"><IconRoute :size="18" aria-hidden="true" /><span>{{ t('coco.process.entry') }}</span></span><IconChevronRight v-if="inline" :size="16" aria-hidden="true" /></button>
  </span>
  <Modal ref="dialog" size="xl" :title="t('coco.process.title', { group: groupName })" @close="close">
    <template #content>
      <div class="mb-3 flex shrink-0 items-center gap-2">
        <button v-if="selectedId" type="button" class="btn btn-ghost min-h-11 shrink-0" :title="t('coco.process.back')" :aria-label="t('coco.process.back')" @click="choose(null)"><IconArrowLeft :size="18" aria-hidden="true" /></button>
        <select v-if="selectedId" :value="selectedId" class="select select-sm min-h-11 min-w-0 flex-1" :aria-label="t('coco.process.trace.chooseRound')" @change="choose(($event.target as HTMLSelectElement).value)"><option v-for="round in rounds" :key="round.id" :value="round.id">{{ time(round.startedAt) }} · {{ t('coco.process.trigger.' + round.trigger) }}{{ round.endedAt === null ? ' · ' + t('coco.process.ongoing') : '' }}</option></select>
        <span v-else class="min-w-0 flex-1 text-sm">{{ t('coco.process.rounds') }} · {{ rounds.length }}</span>
        <button type="button" class="btn btn-ghost min-h-11 shrink-0" :disabled="loading" :title="t('coco.anRefresh')" :aria-label="t('coco.anRefresh')" @click="refresh(false)"><IconRefresh :size="18" :class="{ 'animate-spin': loading }" aria-hidden="true" /></button>
      </div>
      <p v-if="error" role="alert" class="mb-3 shrink-0 text-sm text-warning">{{ t('coco.anUpdateFailedPreviouslyDisplayedRecordsAre', { value: error }) }}</p>
      <p v-if="data?.error" role="alert" class="mb-3 shrink-0 text-xs text-warning">{{ t('coco.process.archiveError') }}</p>
      <div ref="scroller" class="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]">
        <template v-if="!selectedId">
          <p v-if="!data || !rounds.length" class="py-8 text-center text-sm text-base-content/60">{{ loading ? t('coco.process.loading') : t('coco.process.empty') }}</p>
          <ol class="divide-y divide-base-content/10">
            <li v-for="round in rounds" :key="round.id"><button type="button" class="flex min-h-20 w-full items-center gap-3 py-3 text-left hover:bg-base-content/5" @click="choose(round.id)"><time class="shrink-0 text-xs tabular-nums text-base-content/65" :title="time(round.startedAt)">{{ shortTime(round.startedAt) }}</time><span class="min-w-0 flex-1 space-y-1"><span class="block text-sm">{{ t('coco.process.trigger.' + round.trigger) }} <span v-if="round.endedAt === null" class="text-primary">· {{ t('coco.process.ongoing') }}</span></span><span class="block break-all text-xs text-base-content/60">{{ round.current }} · {{ reason(round.reason) }}</span></span><span class="shrink-0 text-xs tabular-nums text-base-content/50">{{ t('coco.process.trace.events', { count: round.eventCount }) }}</span><IconChevronRight :size="16" class="shrink-0 text-base-content/50" aria-hidden="true" /></button></li>
          </ol>
        </template>
        <template v-else-if="detail">
          <div class="mb-3 flex flex-wrap gap-x-5 gap-y-1 border-b border-base-content/10 pb-3 text-xs text-base-content/65"><span>{{ t('coco.process.trace.initial') }} <span class="break-all text-base-content">{{ detail.current }}</span></span><span>{{ shortTime(detail.startedAt) }} → {{ detail.endedAt === null ? t('coco.process.ongoing') : shortTime(detail.endedAt) }}</span><span>{{ t(detail.settings.observeOnly ? 'coco.process.observeOnly' : 'coco.process.automatic') }}</span></div>
          <p v-if="detail.truncated" class="mb-3 text-xs text-warning">{{ t('coco.process.truncated') }}</p>
          <div class="trace-head text-xs text-base-content/50" aria-hidden="true"><span>{{ t('coco.process.trace.relativeTime') }}</span><span></span><span>{{ t('coco.process.trace.actionColumn') }}</span><span>{{ t('coco.process.trace.dataColumn') }}</span></div>
          <ol :aria-label="t('coco.process.timeline')"><BandwidthTraceEvent v-for="row in rows" :key="row.key" :row="row" :start="detail.startedAt" :current="detail.current" :settings="detail.settings" /></ol>
          <details class="mt-4 border-t border-base-content/10 py-2 text-xs"><summary class="min-h-11 cursor-pointer py-3 text-base-content/65">{{ t('coco.process.coverage') }} · {{ detail.nodes.length }}</summary><ul class="space-y-2"><li v-for="node in detail.nodes" :key="node.name" class="flex flex-wrap justify-between gap-2"><span class="break-all">{{ node.name }} · {{ t(node.preferred ? 'coco.anPreferred' : 'coco.anFallback') }}</span><span class="text-base-content/60">{{ t('coco.process.coverageCounts', { probes: detail.events.filter(e => e.node === node.name && e.probe).length, samples: detail.events.filter(e => e.node === node.name && e.sample?.valid).length, comparisons: detail.events.filter(e => e.comparison && (e.comparison.currentNode === node.name || e.comparison.candidateNode === node.name)).length }) }}</span></li></ul><p class="mt-2 text-base-content/50">{{ t('coco.process.coverageHelp') }}</p></details>
          <details class="border-t border-base-content/10 py-2 text-xs"><summary class="min-h-11 cursor-pointer py-3 text-base-content/65">{{ t('coco.process.parameters') }}</summary><dl class="process-facts"><template v-for="(value, key) in detail.settings" :key="key"><dt>{{ key === 'enabled' ? t('coco.process.enabledLabel') : key === 'observeOnly' ? t('coco.process.observeLabel') : t('coco.bandwidthField.' + key) }}</dt><dd>{{ typeof value === 'boolean' ? value ? '✓' : '×' : value }}</dd></template></dl></details>
        </template>
        <p v-else class="py-8 text-center text-sm text-base-content/60">{{ loading ? t('coco.process.loading') : t('coco.process.missing') }}</p>
      </div>
      <div class="mt-3 flex shrink-0 flex-wrap justify-between gap-2 border-t border-base-content/10 pt-3 text-xs text-base-content/55"><span>{{ t('coco.process.updated', { time: time(updatedAt) }) }}</span><span v-if="delayed" role="status">{{ t('coco.process.readDelayed') }}</span><span v-else-if="data?.evicted">{{ t('coco.process.evicted') }}</span><span v-else :title="t('coco.process.retention', { time: time(data?.since) })">{{ t('coco.process.trace.retention') }}</span></div>
    </template>
  </Modal>
</template>

<style scoped>
.trace-head { display: grid; grid-template-columns: 5rem 1rem minmax(6rem, 8rem) minmax(0, 1fr); column-gap: .75rem; padding-bottom: .25rem; }
.process-facts { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: .5rem 1rem; }
.process-facts dt { opacity: .65; overflow-wrap: anywhere; }
.process-facts dd { overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
@media (max-width: 640px) { .trace-head { grid-template-columns: 3.8rem .75rem minmax(0, 1fr); column-gap: .4rem; } .trace-head span:last-child { display: none; } }
</style>
