<script setup lang="ts">
import { IconCheck, IconDownload, IconRefresh, IconRestore } from '@tabler/icons-vue'
import { cocoproxyErrorMessage } from '~/composables/useCoCoProxy'

type Settings = { schemaVersion: 1; enabled: boolean; intervalDays: number; timeZone: string; windowStart: string; windowEnd: string }
type View = { available: boolean; configured: boolean; unavailableReason: string | null; settings: Settings; revision: number; currentVersion: string | null; latestVersion: string | null; nextCheckAt: number | null; lastCheckedAt: number | null; lastResult: string | null; job: { id: string; phase: string; version: string | null; error: string | null } | null }
const { t, locale } = useI18n()
const api = useCoCoProxy()
const view = shallowRef<View | null>(null)
const draft = ref<Settings | null>(null)
const baseline = ref('')
const revision = ref(0)
const busy = ref(false)
const offline = ref(false)
const error = useLocalizedMessage()
const panel = ref<{ open: () => void; close: (force?: boolean) => void }>()
const installingVersion = ref<string | null>(null)
const dirty = computed(() => !!draft.value && JSON.stringify(draft.value) !== baseline.value)
const jobActive = computed(() => !!view.value?.job && !['completed', 'succeeded', 'failed', 'idle', 'interrupted', 'cancelled'].includes(view.value.job.phase))
const usable = computed(() => view.value?.available && view.value.configured)
let reading = false
let sequence = 0
let disposed = false
let timer: ReturnType<typeof setTimeout> | undefined
function accept(value: View, reset = false) {
  if (!draft.value || reset || (!dirty.value && revision.value !== value.revision)) {
    draft.value = { ...value.settings }; baseline.value = JSON.stringify(value.settings); revision.value = value.revision
  }
  if (JSON.stringify(value) !== JSON.stringify(view.value)) view.value = value
  offline.value = false
}
async function load(foreground = false) {
  if (reading || busy.value) return
  reading = true
  const started = sequence
  if (foreground) { busy.value = true; error.value = '' }
  try { const value = await api.request<View>('/api/cocoproxy/updates'); if (started === sequence) accept(value) }
  catch (cause) { if (started === sequence) { offline.value = true; if (foreground) error.value = () => cocoproxyErrorMessage(cause, t) } }
  finally { reading = false; if (foreground) busy.value = false }
}
async function operate(path: string, method: 'PUT' | 'POST', body: unknown, reset = false) {
  if (busy.value) return
  sequence++
  busy.value = true; error.value = ''
  try { accept(await api.request<View>(`/api/cocoproxy/updates/${path}`, { method, body }), reset) }
  catch (cause) { error.value = () => cocoproxyErrorMessage(cause, t) }
  finally { busy.value = false }
}
async function save() {
  if (!draft.value || !Number.isInteger(draft.value.intervalDays) || draft.value.intervalDays < 1 || draft.value.intervalDays > 365) { error.value = () => t('coco.updatesInvalid'); return }
  await operate('settings', 'PUT', { expectedRevision: revision.value, settings: { ...draft.value } }, true)
}
function confirmInstall() { installingVersion.value = view.value?.latestVersion ?? null; panel.value?.open() }
async function install() {
  if (!installingVersion.value) return
  await operate('install', 'POST', { expectedVersion: installingVersion.value })
  panel.value?.close()
}
function date(value: number | null | undefined) { return value ? new Date(value).toLocaleString(locale.value) : t('coco.pzUnknown') }
function visible() { if (document.visibilityState === 'visible') void load() }
async function poll() {
  if (document.visibilityState === 'visible') await load()
  if (!disposed) timer = setTimeout(poll, 5000)
}
onMounted(() => { void load(true); timer = setTimeout(poll, 5000); document.addEventListener('visibilitychange', visible) })
onBeforeUnmount(() => { disposed = true; clearTimeout(timer); document.removeEventListener('visibilitychange', visible) })
</script>

<template>
  <section class="max-w-2xl rounded-xl border border-base-content/10 bg-base-200/60 p-4" aria-labelledby="software-updates-title">
    <div class="flex items-center justify-between gap-3">
      <h2 id="software-updates-title" class="text-base font-semibold">{{ t('coco.updatesTitle') }}</h2>
      <button type="button" class="btn btn-ghost btn-sm" :disabled="busy" :title="t('coco.pzRefreshStatus')" :aria-label="t('coco.pzRefreshStatus')" @click="load(true)"><IconRefresh :size="18" :class="{ 'animate-spin': busy }" /></button>
    </div>
    <p class="mt-1 text-sm text-base-content/65">{{ t('coco.updatesDescription') }}</p>
    <p v-if="!view && busy" class="mt-3 text-sm" role="status">{{ t('coco.pzLoading3') }}</p>
    <p v-if="offline" class="mt-3 text-sm text-warning" role="status">{{ t('coco.updatesOffline') }}</p>
    <template v-if="view">
      <p v-if="!view.available || !view.configured" class="mt-3 text-sm text-warning">{{ t('coco.updatesUnavailable') }}</p>
      <dl class="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
        <dt>{{ t('coco.updatesInstalled') }}</dt><dd class="break-all">{{ view.currentVersion ?? t('coco.pzUnknown') }}</dd>
        <dt>{{ t('coco.updatesLatest') }}</dt><dd class="break-all">{{ view.latestVersion ?? t('coco.pzUnknown') }}</dd>
        <dt>{{ t('coco.updatesLastCheck') }}</dt><dd>{{ date(view.lastCheckedAt) }}</dd>
        <dt>{{ t('coco.updatesNextCheck') }}</dt><dd>{{ date(view.nextCheckAt) }}</dd>
      </dl>
      <p v-if="view.lastResult" class="mt-2 break-words text-sm">{{ t('coco.updatesResult') }}: {{ t(`coco.updatesResults.${view.lastResult}`, view.lastResult) }}</p>
      <p v-if="view.job" class="mt-2 break-words text-sm" role="status">{{ t('coco.updatesJob') }}: {{ t(`coco.updatesPhases.${view.job.phase}`, view.job.phase) }} {{ view.job.version }}<span v-if="view.job.error" class="text-error"> — {{ t('coco.updatesTaskError') }} ({{ view.job.error }})</span></p>
      <form v-if="draft" class="mt-4 space-y-3" @submit.prevent="save">
        <label class="flex min-h-11 items-center justify-between gap-3 text-sm"><span>{{ t('coco.updatesAutomatic') }}</span><input v-model="draft.enabled" type="checkbox" role="switch" class="toggle toggle-primary" :disabled="busy || !view.available" /></label>
        <div class="grid gap-3 sm:grid-cols-2">
          <label class="flex flex-col gap-1 text-sm">{{ t('coco.updatesInterval') }}<input v-model.number="draft.intervalDays" type="number" min="1" max="365" step="1" required class="input w-full" :disabled="busy || !view.available" /></label>
          <label class="flex flex-col gap-1 text-sm">{{ t('coco.updatesTimeZone') }}<input v-model="draft.timeZone" required maxlength="80" class="input w-full" :disabled="busy || !view.available" /></label>
          <label class="flex flex-col gap-1 text-sm">{{ t('coco.updatesWindowStart') }}<input v-model="draft.windowStart" type="time" required class="input w-full" :disabled="busy || !view.available" /></label>
          <label class="flex flex-col gap-1 text-sm">{{ t('coco.updatesWindowEnd') }}<input v-model="draft.windowEnd" type="time" required class="input w-full" :disabled="busy || !view.available" /></label>
        </div>
        <p class="text-xs text-base-content/60">{{ t('coco.updatesWindowHelp') }}</p>
        <div class="flex flex-wrap items-center gap-2">
          <button type="submit" class="btn btn-primary btn-sm" :disabled="busy || !view.available || !dirty" :title="t('coco.pzSave')" :aria-label="t('coco.pzSave')"><IconCheck :size="18" /></button>
          <button type="button" class="btn btn-ghost btn-sm" :disabled="busy || !dirty" :title="t('coco.updatesReset')" :aria-label="t('coco.updatesReset')" @click="accept(view, true)"><IconRestore :size="18" /></button>
          <button type="button" class="btn btn-ghost btn-sm" :disabled="busy || !usable || jobActive" @click="operate('check', 'POST', {})"><IconRefresh :size="16" />{{ t('coco.updatesCheck') }}</button>
          <button type="button" class="btn btn-outline btn-sm" :disabled="busy || !usable || jobActive || !view.latestVersion || view.latestVersion === view.currentVersion" @click="confirmInstall"><IconDownload :size="16" />{{ t('coco.updatesInstall') }}</button>
        </div>
      </form>
    </template>
    <p v-if="error" class="mt-3 text-sm text-error" role="alert">{{ error }}</p>
    <Modal ref="panel" compact :fixed-height="false" :title="t('coco.updatesInstall')" :close-disabled="busy">
      <p class="p-4 text-sm">{{ t('coco.updatesConfirm', { version: installingVersion }) }}</p>
      <template #actions>
        <button type="button" class="btn btn-ghost btn-sm" :disabled="busy" @click="panel?.close()">{{ t('coco.pzCancel') }}</button>
        <button type="button" class="btn btn-primary btn-sm" :disabled="busy" @click="install"><IconDownload :size="16" />{{ t('coco.updatesInstall') }}</button>
      </template>
    </Modal>
  </section>
</template>
