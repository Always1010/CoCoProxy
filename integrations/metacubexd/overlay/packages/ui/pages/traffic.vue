<script setup lang="ts">
import { IconArrowsExchange, IconCheck, IconChevronDown, IconChevronLeft, IconChevronRight, IconCpu, IconDevices, IconDownload, IconEdit, IconInfoCircle, IconListDetails, IconRefresh, IconSearch, IconSelector, IconSum, IconUpload, IconUser, IconWorld, IconX } from '@tabler/icons-vue'
import { onClickOutside, onKeyStroke } from '@vueuse/core'
import dayjs from 'dayjs'
import { cocoproxyErrorMessage, useCoCoProxy } from '~/composables/useCoCoProxy'
import { formatBytes } from '~/utils'

useHead({ title: '用量 · CoCoProxy' })
type Dimension = 'sourceIP' | 'host' | 'outbound' | 'process' | 'inboundUser'
type Sort = 'label' | 'upload' | 'download' | 'total'
interface Row { label: string; upload: number; download: number; total: number; count: number }
interface Result {
  rows: Row[]; totalRows: number; aliases: Record<string, string>; resolution: 'minute' | 'day'
  summary?: { upload: number; download: number; unattributed: number; sources: number }
  trend?: { timestamp: number; upload: number; download: number }[]
  status: { startedAt: number | null; lastSampleAt: number | null; lastCommittedAt: number | null; detailAvailableFrom: number }
  gapCount?: number; sampleError?: boolean; collecting?: boolean
}
const api = useCoCoProxy()
const options = [
  { value: 'sourceIP', label: '来源', icon: IconDevices }, { value: 'host', label: '主机', icon: IconWorld },
  { value: 'outbound', label: '出口', icon: IconArrowsExchange }, { value: 'process', label: '进程', icon: IconCpu }, { value: 'inboundUser', label: '入站用户', icon: IconUser },
] as const
const view = ref<Dimension>('sourceIP')
const rangeDays = ref(7)
const customStart = ref(dayjs().subtract(7, 'day').format('YYYY-MM-DDTHH:mm'))
const customEnd = ref(dayjs().format('YYYY-MM-DDTHH:mm'))
const range = ref({ startTime: Date.now() - 7 * 86400000, endTime: Date.now() })
const overview = ref<Result | null>(null)
const details = ref<Result | null>(null)
const aliases = ref<Record<string, string>>({})
const selected = ref<string | null>(null)
const expanded = ref<string | null>(null)
const expandedRows = ref<Row[]>([])
const expandedPage = ref(0)
const expandedTotal = ref(0)
const rankPage = ref(0)
const detailPage = ref(0)
const rankSearch = ref('')
const detailSearch = ref('')
const sort = ref<Sort>('total')
const order = ref<'asc' | 'desc'>('desc')
const busy = ref(false)
const refreshing = ref(false)
const detailBusy = ref(false)
const expandedBusy = ref(false)
const error = ref('')
const detailError = ref('')
const noteError = ref('')
const editing = ref(false)
const noteIP = ref('')
const note = ref('')
const saving = ref(false)
const noteDialog = ref<HTMLDialogElement>()
const infoOpen = ref(false)
const infoContainer = ref<HTMLElement>()
const infoButton = ref<HTMLButtonElement>()
const infoClose = ref<HTMLButtonElement>()
const pageSize = 50
let overviewVersion = 0, detailVersion = 0, expandedVersion = 0
let controller: AbortController | undefined
let detailController: AbortController | undefined
let expandedController: AbortController | undefined
let timer: ReturnType<typeof setInterval> | undefined
let overviewKey = '', detailKey = '', expandedKey = ''
const current = computed(() => options.find(option => option.value === view.value)!)
const detailDimension = computed<Dimension>(() => view.value === 'host' ? 'sourceIP' : 'host')
const isAddress = (value: string | null) => !!value && !['Inner', 'Unattributed'].includes(value)
const display = (label: string) => label === 'Unattributed' ? '未归属流量' : label === 'Inner' ? '核心内部来源' : label
const date = (value: number | null | undefined) => value ? dayjs(value).format('YYYY-MM-DD HH:mm:ss') : '尚无记录'
const total = computed(() => overview.value?.summary ?? { upload: 0, download: 0, unattributed: 0, sources: 0 })
const collectionUnavailable = computed(() => overview.value && (overview.value.sampleError || !overview.value.collecting))
const hasDataNotes = computed(() => collectionUnavailable.value || !!overview.value?.gapCount || !!total.value.unattributed)
const filters = () => selected.value === null ? {} : { [view.value]: selected.value }
const query = (body: Record<string, unknown>, signal?: AbortSignal, queryRange = range.value) => api.request<Result>('/api/cocoproxy/usage/query', { method: 'POST', body: { ...queryRange, ...body }, signal })

function closeInfo() {
  infoOpen.value = false
  infoButton.value?.focus()
}
async function toggleInfo() {
  infoOpen.value = !infoOpen.value
  if (infoOpen.value) { await nextTick(); infoClose.value?.focus() }
}
onClickOutside(infoContainer, () => { infoOpen.value = false })
onKeyStroke('Escape', (event) => {
  if (infoOpen.value) { event.preventDefault(); closeInfo() }
})

async function refresh(background = false) {
  const version = ++overviewVersion
  controller?.abort(); controller = new AbortController()
  busy.value = true; refreshing.value = !background
  const key = JSON.stringify([view.value, rangeDays.value, rangeDays.value === -1 ? [customStart.value, customEnd.value] : null, rankPage.value, rankSearch.value])
  if (key !== overviewKey) {
    detailVersion++; expandedVersion++; detailController?.abort(); expandedController?.abort()
    detailBusy.value = false; expandedBusy.value = false
    overview.value = null; details.value = null; expanded.value = null; expandedRows.value = []; error.value = ''
    overviewKey = key
  }
  try {
    const endTime = rangeDays.value === -1 ? dayjs(customEnd.value).valueOf() : Date.now()
    const startTime = rangeDays.value === -1 ? dayjs(customStart.value).valueOf() : endTime - rangeDays.value * 86400000
    if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || endTime <= startTime) throw new Error('invalid range')
    const nextRange = { startTime, endTime }
    const result = await query({ dimension: view.value, overview: true, page: rankPage.value, pageSize, search: rankSearch.value }, controller.signal, nextRange)
    if (version !== overviewVersion) return
    range.value = nextRange; overview.value = result; aliases.value = result.aliases; error.value = ''
    if (selected.value === null || !result.rows.some(row => row.label === selected.value)) {
      selected.value = result.rows[0]?.label ?? null; detailPage.value = 0; expanded.value = null; expandedRows.value = []
    }
    await loadDetails(background)
  } catch (cause) {
    if (version === overviewVersion) error.value = overview.value ? '更新失败，显示上次数据。' : cocoproxyErrorMessage(cause)
  } finally { if (version === overviewVersion) { busy.value = false; refreshing.value = false } }
}

async function loadDetails(background = false) {
  const version = ++detailVersion
  detailController?.abort(); detailController = new AbortController()
  if (selected.value === null) { details.value = null; detailBusy.value = false; return }
  const key = JSON.stringify([view.value, selected.value, rangeDays.value, customStart.value, customEnd.value, sort.value, order.value, detailSearch.value, detailPage.value])
  if (key !== detailKey) { details.value = null; detailError.value = ''; detailKey = key }
  detailBusy.value = !background
  try {
    const result = await query({ dimension: detailDimension.value, filters: filters(), sort: sort.value, order: order.value, search: detailSearch.value, page: detailPage.value, pageSize }, detailController.signal)
    if (version !== detailVersion) return
    details.value = result; detailError.value = ''
    if (expanded.value) await loadExpanded(background)
  } catch (cause) { if (version === detailVersion) detailError.value = details.value ? '更新失败，显示上次数据。' : cocoproxyErrorMessage(cause) }
  finally { if (version === detailVersion) detailBusy.value = false }
}

async function select(label: string) {
  expandedVersion++; expandedController?.abort(); expandedBusy.value = false
  selected.value = label; detailPage.value = 0; expanded.value = null; expandedRows.value = []
  await loadDetails()
}
async function loadExpanded(background = false) {
  const version = ++expandedVersion
  expandedController?.abort(); expandedController = new AbortController()
  if (!expanded.value) { expandedBusy.value = false; return }
  const key = JSON.stringify([detailKey, expanded.value, expandedPage.value])
  if (key !== expandedKey) { expandedRows.value = []; expandedTotal.value = 0; expandedKey = key }
  expandedBusy.value = !background
  try {
    const result = await query({ dimension: view.value === 'outbound' ? 'sourceIP' : 'outbound', filters: { ...filters(), [detailDimension.value]: expanded.value }, page: expandedPage.value, pageSize }, expandedController.signal)
    if (version === expandedVersion) { expandedRows.value = result.rows; expandedTotal.value = result.totalRows }
  } catch (cause) { if (version === expandedVersion) detailError.value = expandedRows.value.length ? '更新失败，显示上次数据。' : cocoproxyErrorMessage(cause) }
  finally { if (version === expandedVersion) expandedBusy.value = false }
}
async function toggle(row: Row) {
  if (expanded.value === row.label) { expanded.value = null; expandedVersion++; expandedController?.abort(); expandedBusy.value = false; return }
  expanded.value = row.label; expandedPage.value = 0; expandedRows.value = []; await loadExpanded()
}
function changeSort(field: Sort) {
  order.value = sort.value === field && order.value === 'desc' ? 'asc' : 'desc'
  sort.value = field; detailPage.value = 0; void loadDetails()
}
function editNote(ip: string) {
  noteIP.value = ip; note.value = aliases.value[ip] ?? ''; noteError.value = ''; editing.value = true
}
async function saveNote() {
  if (saving.value) return
  saving.value = true; noteError.value = ''
  try {
    const result = await api.request<{ aliases: Record<string, string> }>('/api/cocoproxy/usage/alias', { method: 'PUT', body: { sourceIP: noteIP.value, label: note.value } })
    aliases.value = result.aliases; editing.value = false
    await refresh()
  } catch (cause) { noteError.value = cocoproxyErrorMessage(cause) }
  finally { saving.value = false }
}
function reset() {
  detailVersion++; expandedVersion++; detailController?.abort(); expandedController?.abort(); detailBusy.value = false; expandedBusy.value = false
  selected.value = null; details.value = null; expanded.value = null; rankPage.value = 0; detailPage.value = 0
  void refresh()
}
watch([view, rangeDays], reset)
watch(rankSearch, useDebounceFn(() => { rankPage.value = 0; void refresh() }, 250))
watch(detailSearch, useDebounceFn(() => { detailPage.value = 0; void loadDetails() }, 250))
watch(editing, async (open) => {
  await nextTick()
  if (open) noteDialog.value?.showModal()
  else noteDialog.value?.close()
})
onMounted(() => {
  void refresh()
  timer = setInterval(() => { if (!document.hidden && !busy.value && !detailBusy.value && !expandedBusy.value && !editing.value) void refresh(true) }, 5000)
})
onBeforeUnmount(() => {
  clearInterval(timer); overviewVersion++; detailVersion++; expandedVersion++
  controller?.abort(); detailController?.abort(); expandedController?.abort()
})
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto pr-1">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div class="flex flex-wrap gap-1 rounded-lg border border-base-content/10 bg-base-200/60 p-1" aria-label="用量维度">
        <button v-for="option in options" :key="option.value" type="button" class="btn btn-ghost btn-sm" :class="{ 'bg-primary text-primary-content': view === option.value }" :aria-pressed="view === option.value" @click="view = option.value"><component :is="option.icon" :size="16" />{{ option.label }}</button>
      </div>
      <div class="flex flex-wrap items-end gap-2">
        <label class="flex flex-col gap-1 text-xs">时间范围 <select v-model.number="rangeDays" class="select select-bordered select-sm w-36"><option :value="1 / 24">最近一小时</option><option :value="1">最近一天</option><option :value="7">最近七天</option><option :value="30">最近三十天</option><option :value="365">最近一年</option><option :value="-1">自定义</option></select></label>
        <button type="button" class="btn btn-ghost btn-sm w-20 px-2" :disabled="refreshing" @click="refresh()"><IconRefresh :size="16" :class="{ 'animate-spin': refreshing }" />{{ refreshing ? '刷新中' : '刷新' }}</button>
        <div ref="infoContainer" class="relative">
          <button ref="infoButton" type="button" class="btn btn-ghost btn-sm px-2" aria-haspopup="dialog" aria-controls="usage-info" :aria-expanded="infoOpen" @click="toggleInfo"><IconInfoCircle :size="16" /><span>说明</span><span v-if="hasDataNotes" class="h-1.5 w-1.5 rounded-full bg-warning" aria-label="有数据提示" /></button>
          <div v-if="infoOpen" id="usage-info" role="dialog" aria-labelledby="usage-info-title" class="absolute right-0 top-full z-30 mt-2 max-h-[calc(100dvh-2rem)] w-96 max-w-[calc(100vw-2rem)] overflow-y-auto rounded-xl border border-base-content/15 bg-base-200 p-4 text-sm shadow-xl max-sm:fixed max-sm:inset-x-4 max-sm:bottom-4 max-sm:top-auto max-sm:mt-0 max-sm:w-auto">
            <div class="mb-4 flex items-center justify-between gap-3"><h2 id="usage-info-title" class="flex items-center gap-2 font-semibold"><IconInfoCircle :size="18" />用量说明</h2><button ref="infoClose" type="button" class="btn btn-ghost btn-square btn-xs" title="关闭说明" aria-label="关闭说明" @click="closeInfo"><IconX :size="14" aria-hidden="true" /></button></div>
            <div class="space-y-4 text-xs leading-relaxed">
              <dl v-if="overview" class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2">
                <dt class="text-base-content/60">采集状态</dt><dd :class="{ 'text-warning': collectionUnavailable }">{{ collectionUnavailable ? '采集暂停，显示历史' : '正常采集' }}</dd>
                <dt class="text-base-content/60">统计始于</dt><dd>{{ date(overview.status.startedAt) }}</dd>
                <dt class="text-base-content/60">最近采集</dt><dd>{{ date(overview.status.lastSampleAt) }}</dd>
                <dt class="text-base-content/60">最近保存</dt><dd>{{ date(overview.status.lastCommittedAt) }}</dd>
              </dl>
              <p v-else class="text-base-content/60">采集记录暂不可用。</p>
              <div class="space-y-2 border-t border-base-content/10 pt-3 text-base-content/70">
                <p>明细保留 30 天，每日来源汇总保留 1 年。</p>
                <p>来源按 IP 汇总，NAT 后的多台设备无法拆分。</p>
                <p v-if="overview?.resolution === 'day'">当前显示每日来源汇总，过期域名明细不可查询。</p>
              </div>
              <div v-if="hasDataNotes" class="space-y-2 border-t border-base-content/10 pt-3">
                <p v-if="collectionUnavailable" class="text-warning">后台采集暂不可用，当前显示已保存历史，空白区间不代表零流量。</p>
                <p v-if="overview?.gapCount">此范围有 {{ overview.gapCount }} 段采集间断或核心重置。</p>
                <p v-if="total.unattributed">未归属流量 {{ formatBytes(total.unattributed) }}，已计入总量。</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
    <form v-if="rangeDays === -1" class="flex flex-wrap items-end gap-2" @submit.prevent="reset">
      <label class="text-xs">开始<input v-model="customStart" type="datetime-local" required class="input input-bordered input-sm block" /></label>
      <label class="text-xs">结束<input v-model="customEnd" type="datetime-local" required class="input input-bordered input-sm block" /></label>
      <button type="submit" class="btn btn-primary btn-sm"><IconSearch :size="16" />查询</button>
    </form>
    <p v-if="error" class="alert alert-error text-sm" role="alert">{{ error }}</p>
    <p v-if="collectionUnavailable" class="text-xs text-warning" role="status">采集暂停，显示历史</p>
    <div class="grid grid-cols-2 gap-3 xl:grid-cols-4">
      <div v-for="card in [{ label: '来源 IP', value: total.sources, icon: IconDevices }, { label: '上传', value: formatBytes(total.upload), icon: IconUpload }, { label: '下载', value: formatBytes(total.download), icon: IconDownload }, { label: '总量', value: formatBytes(total.upload + total.download), icon: IconSum }]" :key="card.label" class="flex h-20 items-center gap-3 rounded-2xl border border-base-content/10 bg-base-200/60 p-3">
        <component :is="card.icon" :size="24" class="shrink-0 text-primary" /><div class="min-w-0"><p class="text-xs text-base-content/50">{{ card.label }}</p><p class="truncate text-lg font-bold">{{ overview ? card.value : '—' }}</p></div>
      </div>
    </div>
    <div class="grid grid-cols-1 gap-4 xl:grid-cols-4">
      <section class="flex h-[340px] min-w-0 flex-col rounded-xl border border-base-content/10 bg-base-200 p-4">
        <div class="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h2 class="flex items-center gap-2 font-semibold"><component :is="current.icon" :size="20" />热门{{ current.label }}</h2>
          <button v-if="view === 'sourceIP'" type="button" class="btn btn-ghost btn-xs" :disabled="!isAddress(selected) || !overview" @click="selected && editNote(selected)"><IconEdit :size="14" />编辑备注</button>
        </div>
        <label class="mb-2 flex items-center gap-2 text-xs"><IconSearch :size="14" /><input v-model="rankSearch" type="search" class="input input-bordered input-sm min-w-0 flex-1" :aria-label="view === 'sourceIP' ? '搜索 IP 或备注' : '搜索热门列表'" :placeholder="view === 'sourceIP' ? '搜索 IP 或备注' : '搜索'" /></label>
        <div class="min-h-0 flex-1 overflow-y-auto">
          <button v-for="row in overview?.rows ?? []" :key="row.label" type="button" class="mb-2 flex w-full flex-col gap-1 rounded-lg p-2 text-left hover:bg-base-content/5" :class="{ 'bg-primary/10 text-primary': selected === row.label }" :aria-pressed="selected === row.label" @click="select(row.label)">
            <span class="flex min-w-0 items-center gap-1 text-sm font-medium"><span class="min-w-0 break-all font-mono" :class="{ 'shrink-0': view === 'sourceIP' && !row.label.includes(':') }">{{ display(row.label) }}</span><span v-if="view === 'sourceIP' && aliases[row.label]" class="min-w-0 truncate text-xs text-base-content/60">（{{ aliases[row.label] }}）</span><span class="ml-auto shrink-0 pl-2 text-xs font-bold">{{ formatBytes(row.total) }}</span></span>
            <span class="flex gap-3 text-[10px] font-bold opacity-60"><span>↑ {{ formatBytes(row.upload) }}</span><span>↓ {{ formatBytes(row.download) }}</span></span>
          </button>
          <p v-if="!overview?.rows.length" class="py-6 text-center text-sm text-base-content/50">{{ refreshing ? '读取中…' : '暂无已记录用量' }}</p>
        </div>
        <div class="mt-2 flex items-center justify-between gap-1 text-xs">
          <button type="button" class="btn btn-ghost btn-xs" :disabled="rankPage === 0 || refreshing" @click="rankPage--; refresh()"><IconChevronLeft :size="14" />上一页</button><span>{{ rankPage + 1 }} / {{ Math.max(1, Math.ceil((overview?.totalRows ?? 0) / pageSize)) }}</span><button type="button" class="btn btn-ghost btn-xs" :disabled="(rankPage + 1) * pageSize >= (overview?.totalRows ?? 0) || refreshing" @click="rankPage++; refresh()">下一页<IconChevronRight :size="14" /></button>
        </div>
      </section>
      <section class="min-h-[340px] min-w-0 rounded-xl border border-base-content/10 bg-base-200 p-2 xl:col-span-3"><TrafficTrendChart :data="overview?.trend ?? []" :start-time="range.startTime" :end-time="range.endTime" :is-loading="busy && !overview" title="流量" /></section>
    </div>
    <section class="rounded-xl border border-base-content/10 bg-base-200/60">
      <div class="flex flex-wrap items-center justify-between gap-3 border-b border-base-content/10 p-4">
        <h2 class="flex min-w-0 items-center gap-2 font-semibold"><IconListDetails :size="20" />用量详情<span v-if="selected" class="truncate text-xs font-normal text-base-content/60">{{ display(selected) }}{{ view === 'sourceIP' && aliases[selected] ? `（${aliases[selected]}）` : '' }}</span><span class="inline-flex shrink-0 items-center gap-1 text-xs font-normal text-base-content/60" :class="{ invisible: !detailBusy }" :aria-hidden="!detailBusy" role="status"><IconRefresh :size="12" :class="{ 'animate-spin': detailBusy }" />读取中</span></h2>
        <label class="flex items-center gap-2 text-xs"><IconSearch :size="14" /><input v-model="detailSearch" type="search" class="input input-bordered input-sm" aria-label="搜索用量详情" placeholder="搜索 IP、备注或主机" /></label>
      </div>
      <p v-if="detailError" class="p-4 text-sm text-warning" role="alert">{{ detailError }}</p>
      <div class="overflow-x-auto">
        <table class="table table-sm w-full">
          <thead><tr><th v-for="column in [{ key: 'label', label: detailDimension === 'sourceIP' ? '来源 IP' : '主机' }, { key: 'upload', label: '上传' }, { key: 'download', label: '下载' }, { key: 'total', label: '总量' }]" :key="column.key"><button class="inline-flex items-center gap-1 whitespace-nowrap" type="button" :aria-label="`按${column.label}排序`" @click="changeSort(column.key as Sort)">{{ column.label }}<IconSelector :size="14" /><span v-if="sort === column.key">{{ order === 'desc' ? '↓' : '↑' }}</span></button></th></tr></thead>
          <tbody>
            <template v-for="row in details?.rows ?? []" :key="row.label">
              <tr class="hover:bg-base-content/5"><td class="max-w-[55vw] sm:max-w-none"><div class="flex items-center gap-2"><button type="button" class="inline-flex min-w-0 items-center gap-1 text-left" :aria-expanded="expanded === row.label" @click="toggle(row)"><IconChevronDown v-if="expanded === row.label" :size="14" class="shrink-0" /><IconChevronRight v-else :size="14" class="shrink-0" /><span class="truncate font-mono text-xs">{{ display(row.label) }}{{ detailDimension === 'sourceIP' && aliases[row.label] ? `（${aliases[row.label]}）` : '' }}</span></button><button v-if="detailDimension === 'sourceIP' && isAddress(row.label)" type="button" class="btn btn-ghost btn-xs shrink-0" @click="editNote(row.label)"><IconEdit :size="12" />备注</button></div></td><td class="whitespace-nowrap">{{ formatBytes(row.upload) }}</td><td class="whitespace-nowrap">{{ formatBytes(row.download) }}</td><td class="whitespace-nowrap font-bold text-primary">{{ formatBytes(row.total) }}</td></tr>
              <tr v-if="expanded === row.label"><td colspan="4" class="bg-base-content/5 p-4"><p class="mb-2 flex items-center gap-2 text-xs text-base-content/60">{{ view === 'outbound' ? '来源 IP' : '出口' }}<span :class="{ invisible: !expandedBusy }" :aria-hidden="!expandedBusy" role="status">读取中…</span></p><div v-for="child in expandedRows" :key="child.label" class="flex flex-wrap justify-between gap-2 py-1 text-xs"><span class="break-all">{{ display(child.label) }}{{ view === 'outbound' && aliases[child.label] ? `（${aliases[child.label]}）` : '' }}</span><span>↑ {{ formatBytes(child.upload) }} · ↓ {{ formatBytes(child.download) }} · {{ formatBytes(child.total) }}</span></div><p v-if="!expandedBusy && !expandedRows.length" class="text-xs text-base-content/50">暂无明细</p><div v-if="expandedTotal > pageSize" class="mt-2 flex justify-between"><button class="btn btn-ghost btn-xs" type="button" :disabled="expandedPage === 0 || expandedBusy" @click="expandedPage--; loadExpanded()"><IconChevronLeft :size="14" />上一页</button><button class="btn btn-ghost btn-xs" type="button" :disabled="(expandedPage + 1) * pageSize >= expandedTotal || expandedBusy" @click="expandedPage++; loadExpanded()">下一页<IconChevronRight :size="14" /></button></div></td></tr>
            </template>
            <tr v-if="!details?.rows.length && !detailBusy"><td colspan="4" class="py-8 text-center text-base-content/50">{{ overview?.resolution === 'day' ? '此范围仅保留每日来源汇总，域名明细已过期。' : '暂无用量详情' }}</td></tr>
          </tbody>
        </table>
      </div>
      <div class="flex items-center justify-between gap-2 border-t border-base-content/10 p-3 text-xs"><button type="button" class="btn btn-ghost btn-sm" :disabled="detailPage === 0 || detailBusy" @click="detailPage--; loadDetails()"><IconChevronLeft :size="14" />上一页</button><span>{{ detailPage + 1 }} / {{ Math.max(1, Math.ceil((details?.totalRows ?? 0) / pageSize)) }} · {{ details?.totalRows ?? 0 }} 项</span><button type="button" class="btn btn-ghost btn-sm" :disabled="(detailPage + 1) * pageSize >= (details?.totalRows ?? 0) || detailBusy" @click="detailPage++; loadDetails()">下一页<IconChevronRight :size="14" /></button></div>
    </section>
    <dialog ref="noteDialog" class="m-auto w-[calc(100%-2rem)] max-w-sm rounded-xl border border-base-content/10 bg-base-200 p-5 text-base-content shadow-xl backdrop:bg-black/60" aria-labelledby="source-note-title" @cancel.prevent="!saving && (editing = false)">
      <form @submit.prevent="saveNote">
        <h2 id="source-note-title" class="font-semibold">编辑来源备注</h2><p class="mt-3 break-all font-mono text-sm">{{ noteIP }}</p>
        <label class="mt-3 block text-sm">来源备注<input v-model="note" autofocus maxlength="40" class="input input-bordered mt-2 w-full" :disabled="saving" placeholder="例如：客厅设备" /></label>
        <p class="mt-2 text-xs leading-relaxed text-base-content/60">备注只标识此 IP，不用于识别或授权设备。留空保存可移除备注，历史查询使用当前备注。</p><p v-if="noteError" class="mt-2 text-sm text-error" role="alert">{{ noteError }}</p>
        <div class="mt-4 flex justify-end gap-2"><button type="button" class="btn btn-ghost btn-sm" :disabled="saving" @click="editing = false"><IconX :size="16" />取消</button><button type="submit" class="btn btn-primary btn-sm" :disabled="saving"><IconCheck :size="16" />{{ saving ? '保存中…' : '保存' }}</button></div>
      </form>
    </dialog>
  </div>
</template>
