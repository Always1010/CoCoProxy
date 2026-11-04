<script setup lang="ts">
import { IconTrash } from '@tabler/icons-vue'
import dayjs from 'dayjs'
import { cocoproxyErrorMessage, useCoCoProxy } from '~/composables/useCoCoProxy'
import { formatBytes } from '~/utils'
import type { UsageDeleteScope, UsageDeletePreview } from '~/utils/usage-management'

const { t, locale } = useI18n()
const api = useCoCoProxy()
const emit = defineEmits<{ opened: [value: boolean]; deleted: [value: UsageDeletePreview] }>()
const panel = ref<{ open: () => void; close: (force?: boolean) => void }>()
const scope = ref<UsageDeleteScope>({ mode: 'all' })
const preview = ref<UsageDeletePreview | null>(null)
const start = ref(''), end = ref(''), sourceIP = ref('')
const sourceMode = ref<'all' | 'source'>('all')
const confirmation = ref('')
const reading = ref(false), deleting = ref(false)
const errorSource = shallowRef<(() => string) | null>(null)
const error = computed(() => errorSource.value?.() ?? '')
const editable = computed(() => scope.value.mode === 'range' && !scope.value.selection)
const clearAll = computed(() => scope.value.mode === 'all')
const canDelete = computed(() => !!preview.value && preview.value.detailRows + preview.value.dailyRows > 0 && !reading.value && !deleting.value && (!clearAll.value || confirmation.value === t('coco.usageClearWord')))
const scopeRows = computed(() => {
  const current = preview.value?.scope
  if (!current || current.mode === 'all') return []
  return [...Object.entries(current.filters ?? {}), ...(current.selection ? [[current.selection.dimension, current.selection.values.join('\n')]] : [])]
})
const date = (value: number) => new Date(value).toLocaleString(locale.value, { timeZoneName: 'short' })
let version = 0
let controller: AbortController | undefined

function invalidate() {
  version++; controller?.abort(); preview.value = null; reading.value = false
  confirmation.value = ''; errorSource.value = null
}
watch([start, end, sourceIP, sourceMode], invalidate)
async function readPreview() {
  if (deleting.value) return
  invalidate()
  let input = scope.value
  if (editable.value) {
    const startTime = dayjs(start.value).valueOf(), endTime = dayjs(end.value).valueOf()
    if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || endTime <= startTime || (sourceMode.value === 'source' && !sourceIP.value.trim())) {
      errorSource.value = () => t('coco.errorUSAGE_DELETE_INVALID'); return
    }
    input = { mode: 'range', startTime, endTime, filters: sourceMode.value === 'source' ? { sourceIP: sourceIP.value.trim() } : {} }
  }
  const current = ++version
  controller = new AbortController(); reading.value = true
  try {
    const result = await api.request<UsageDeletePreview>('/api/cocoproxy/usage/deletion/preview', { method: 'POST', body: input, signal: controller.signal })
    if (version === current) preview.value = result
  } catch (cause) { if (version === current) errorSource.value = () => cocoproxyErrorMessage(cause, t) }
  finally { if (version === current) reading.value = false }
}
async function open(input: UsageDeleteScope) {
  invalidate(); scope.value = input
  if (input.mode === 'range') {
    start.value = dayjs(input.startTime).format('YYYY-MM-DDTHH:mm')
    end.value = dayjs(Math.ceil(input.endTime / 60_000) * 60_000).format('YYYY-MM-DDTHH:mm')
    sourceIP.value = input.filters?.sourceIP ?? ''; sourceMode.value = sourceIP.value ? 'source' : 'all'
  }
  emit('opened', true)
  await nextTick(); panel.value?.open(); void readPreview()
}
function close() { invalidate(); emit('opened', false) }
async function remove() {
  if (!canDelete.value || !preview.value) return
  deleting.value = true; errorSource.value = null
  try {
    const result = await api.request<UsageDeletePreview>('/api/cocoproxy/usage/deletion/confirm', { method: 'POST', body: { token: preview.value.token } })
    emit('deleted', result); panel.value?.close(true)
  } catch (cause) {
    if ((cause as { code?: string }).code === 'USAGE_DELETE_STALE') { preview.value = null; confirmation.value = '' }
    errorSource.value = () => cocoproxyErrorMessage(cause, t)
  } finally { deleting.value = false }
}
onBeforeUnmount(() => { version++; controller?.abort() })
defineExpose({ open })
</script>

<template>
  <Modal ref="panel" compact :fixed-height="false" :title="t(clearAll ? 'coco.usageClearAll' : 'coco.usageDeleteTitle')" :close-disabled="deleting" @close="close">
    <div class="space-y-4">
      <form v-if="editable" class="grid grid-cols-1 gap-3 sm:grid-cols-2" @submit.prevent="readPreview">
        <label class="flex flex-col gap-1 text-sm">{{ t('coco.usageDeleteSources') }}<select v-model="sourceMode" class="select w-full" :disabled="deleting"><option value="all">{{ t('coco.usageAllSources') }}</option><option value="source">{{ t('coco.usageSpecificSource') }}</option></select></label>
        <label v-if="sourceMode === 'source'" class="flex flex-col gap-1 text-sm">{{ t('coco.pzSourceIp') }}<input v-model="sourceIP" class="input w-full font-mono" maxlength="512" :disabled="deleting" required /></label>
        <label class="flex min-w-0 flex-col gap-1 text-sm">{{ t('coco.pzStart') }}<input v-model="start" type="datetime-local" class="input w-full min-w-0" :disabled="deleting" required /></label>
        <label class="flex min-w-0 flex-col gap-1 text-sm">{{ t('coco.pzEnd') }}<input v-model="end" type="datetime-local" class="input w-full min-w-0" :disabled="deleting" required /></label>
        <button type="submit" class="btn btn-sm justify-self-start" :disabled="reading || deleting">{{ t(reading ? 'coco.usagePreviewing' : 'coco.usageDeletePreview') }}</button>
      </form>
      <p v-if="reading" class="text-sm" role="status">{{ t('coco.usagePreviewing') }}</p>
      <template v-if="preview">
        <dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
          <dt class="text-base-content/60">{{ t('coco.pzTimeRange') }}</dt>
          <dd v-if="preview.scope.mode === 'all'">{{ t('coco.usageAllHistory') }}</dd>
          <dd v-else class="break-words">{{ date(preview.scope.startTime) }} — {{ date(preview.scope.endTime) }}</dd>
          <template v-for="[dimension, value] in scopeRows" :key="dimension"><dt class="text-base-content/60">{{ t(`coco.usageDeleteDimension.${dimension}`) }}</dt><dd class="whitespace-pre-line break-all font-mono text-xs">{{ value }}</dd></template>
          <template v-if="!scopeRows.length"><dt class="text-base-content/60">{{ t('coco.usageDeleteSources') }}</dt><dd>{{ t('coco.usageAllSources') }}</dd></template>
        </dl>
        <div class="space-y-1 rounded-lg bg-base-200 p-3 text-sm" role="status">
          <p>{{ t('coco.usageDeleteAmount', { amount: formatBytes(preview.upload + preview.download), sources: preview.sources }) }}</p>
          <p class="text-xs text-base-content/70">{{ t('coco.usageDeleteRows', { minutes: preview.detailRows, days: preview.dailyRows }) }}</p>
        </div>
        <p v-if="preview.scope.mode === 'range'" class="text-xs text-base-content/60">{{ t(preview.resolution === 'day' ? 'coco.usageDeleteDayBoundary' : 'coco.usageDeleteMinuteBoundary') }}</p>
        <p v-if="preview.sampledAt" class="text-xs text-base-content/60">{{ t('coco.usageDeleteSnapshot', { time: date(preview.sampledAt) }) }}</p>
        <p v-if="!preview.detailRows && !preview.dailyRows" class="text-sm">{{ t('coco.usageDeleteEmpty') }}</p>
        <p v-else class="text-sm text-warning">{{ t('coco.usageDeleteWarning') }}</p>
        <label v-if="clearAll && preview.dailyRows" class="flex flex-col gap-2 text-sm">{{ t('coco.usageClearConfirm', { word: t('coco.usageClearWord') }) }}<input v-model="confirmation" class="input w-full" autocomplete="off" :disabled="deleting" :placeholder="t('coco.usageClearWord')" /></label>
      </template>
      <p v-if="error" class="text-sm text-error" role="alert">{{ error }}</p>
    </div>
    <template #actions>
      <button type="button" class="btn btn-ghost btn-sm" :disabled="deleting" @click="panel?.close()">{{ t('coco.pzCancel') }}</button>
      <button v-if="!preview && !editable" type="button" class="btn btn-sm" :disabled="reading || deleting" @click="readPreview">{{ t('coco.usageDeletePreview') }}</button>
      <button type="button" class="btn btn-error btn-sm" :disabled="!canDelete" @click="remove"><IconTrash :size="16" aria-hidden="true" />{{ t(deleting ? 'coco.usageDeleting' : 'coco.usageDeleteConfirm') }}</button>
    </template>
  </Modal>
</template>
