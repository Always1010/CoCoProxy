<script setup lang="ts">
import { IconCheck, IconDeviceDesktop, IconEdit, IconLogout, IconRefresh, IconRestore, IconShieldX, IconX } from '@tabler/icons-vue'
import type { CoCoProxyStatus } from '~/composables/useCoCoProxy'
import { CoCoProxyError, cocoproxyErrorMessage } from '~/composables/useCoCoProxy'

const { t, locale } = useI18n()
useHead({ title: computed(() => t('coco.pzSettingsCocoproxy')) })
const api = useCoCoProxy()
const status = ref<CoCoProxyStatus | null>(null)
const busy = ref(false)
const errorSource = shallowRef<(() => string) | null>(null)
const error = computed(() => errorSource.value?.() ?? '')
const { view: workspaceView, busy: workspaceBusy, error: workspaceError, operation: workspaceOperation,
  load: loadWorkspace, run: runWorkspace, save: saveWorkspace } = useWorkspace()
const locked = computed(() => busy.value || workspaceBusy.value)
const hostProxy = computed(() => workspaceView.value?.hostProxy)
const hostProxyEnabled = computed(() => hostProxy.value?.enabled ?? workspaceView.value?.workspace.hostProxy === true)
const hostProxyPending = computed(() => workspaceView.value?.pending && hostProxy.value?.active !== hostProxyEnabled.value)
const visibleError = computed(() => error.value || workspaceError.value || (workspaceView.value?.error
  ? cocoproxyErrorMessage(new CoCoProxyError(workspaceView.value.error), t) : ''))
type TrustedDevice = { id: string; label: string; trust: '90days' | 'until-revoked'; createdAt: number; renewedAt: number; expiresAt: number | null; current: boolean; lastIP: string | null }
const devices = ref<TrustedDevice[]>([])
const editing = ref<string | null>(null)
const label = ref('')
async function rename() {
  await api.request('/api/session/devices/rename', { method: 'POST', body: { id: editing.value, label: label.value } })
  editing.value = null
  await refresh()
}

async function run(action: () => Promise<void>) {
  if (locked.value) return
  busy.value = true
  errorSource.value = null
  try { await action() }
  catch (cause) { errorSource.value = () => cocoproxyErrorMessage(cause, t) }
  finally { busy.value = false }
}
async function refresh() {
  await Promise.all([
    api.readStatus().then(value => { status.value = value }),
    api.request<{ devices: TrustedDevice[] }>('/api/session/devices').then(value => { devices.value = value.devices }),
    runWorkspace(loadWorkspace),
  ])
}
async function changeHostProxy(event: Event) {
  const enabled = (event.target as HTMLInputElement).checked
  if (locked.value || !hostProxy.value?.available || !workspaceView.value) return
  await run(() => runWorkspace(() => saveWorkspace(settings => { settings.hostProxy = enabled })))
}
async function retryHostProxy() {
  if (!hostProxy.value?.available || !hostProxyPending.value) return
  await run(() => runWorkspace(() => saveWorkspace(() => {})))
}
async function revoke(device: TrustedDevice) {
  const result = await api.request<{ current: boolean }>('/api/session/devices/revoke', { method: 'POST', body: { id: device.id } })
  if (result.current) {
    api.clearSession()
    await navigateTo('/login', { replace: true })
  } else await refresh()
}
async function recover() {
  await api.request('/api/cocoproxy/recover', { method: 'POST', body: {} })
  await refresh()
}
onMounted(() => run(refresh))
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto">
    <div class="flex items-center justify-between"><h1 class="text-xl font-semibold">{{ t('coco.pzSettings') }}</h1><button class="btn btn-ghost btn-sm" :title="t('coco.pzRefreshStatus')" :aria-label="t('coco.pzRefreshStatus')" :disabled="locked" @click="run(refresh)"><IconRefresh :size="18" :class="{ 'animate-spin': busy }" />{{ t('coco.pzRefresh') }}</button></div>
    <div v-if="visibleError" role="alert" class="alert alert-error text-sm">{{ visibleError }}</div>
    <div class="max-w-2xl rounded-xl border border-base-content/10 bg-base-200/60">
      <div class="flex items-center justify-between border-b border-base-content/8 p-4"><span class="text-sm">{{ t('coco.pzCurrentAccount') }}</span><span class="text-sm text-base-content/60">{{ api.session.value?.username }}</span></div>
      <div class="flex items-center justify-between border-b border-base-content/8 p-4"><span class="text-sm">{{ t('coco.pzCoreStatus') }}</span><span v-if="status" class="flex items-center gap-2 text-sm" :class="status.core?.ready ? 'text-success' : 'text-warning'"><IconCheck v-if="status.core?.ready" :size="16" /><IconX v-else :size="16" />{{ status.core?.ready ? t('coco.pzRunning') : t('coco.pzNotReady') }}</span><span v-else class="loading loading-spinner loading-xs" /></div>
      <div class="flex items-center justify-between p-4"><span class="text-sm">{{ t('coco.pzManagementSession') }}</span><button class="btn btn-outline btn-sm" :disabled="locked" @click="run(api.logout)"><IconLogout :size="16" />{{ t('coco.pzSignOut') }}</button></div>
    </div>
    <section class="max-w-2xl rounded-xl border border-base-content/10 bg-base-200/60 p-4" aria-labelledby="host-proxy-title">
      <label class="flex min-h-11 items-center justify-between gap-4" for="host-proxy-enabled">
        <span id="host-proxy-title" class="flex items-center gap-2 text-base font-semibold"><IconDeviceDesktop :size="20" aria-hidden="true" />{{ t('coco.hostProxyTitle') }}</span>
        <input id="host-proxy-enabled" type="checkbox" role="switch" class="toggle toggle-primary shrink-0" :checked="hostProxyEnabled" :disabled="locked || !hostProxy?.available" aria-describedby="host-proxy-description host-proxy-status" @change="changeHostProxy" />
      </label>
      <p id="host-proxy-description" class="mt-1 text-sm leading-relaxed text-base-content/65">{{ t('coco.hostProxyDescription') }}</p>
      <div id="host-proxy-status" role="status" aria-live="polite" class="mt-3 text-sm">
        <p v-if="workspaceBusy" class="flex items-center gap-2 text-base-content/65"><span class="loading loading-spinner loading-xs" />{{ workspaceOperation || t('coco.pzLoading3') }}</p>
        <p v-else-if="!workspaceView && busy" class="flex items-center gap-2 text-base-content/65"><span class="loading loading-spinner loading-xs" />{{ t('coco.pzLoading3') }}</p>
        <template v-else>
          <p :class="hostProxy?.active === true ? 'text-success' : 'text-base-content/65'">{{ hostProxy?.active === true ? t('coco.hostProxyActive') : hostProxy?.active === false ? t('coco.hostProxyInactive') : t('coco.hostProxyUnconfirmed') }}</p>
          <p v-if="workspaceView && !hostProxy?.available" class="mt-1 text-warning">{{ t('coco.hostProxyUnavailable') }}</p>
          <div v-if="hostProxyPending" class="mt-2 flex flex-wrap items-center gap-2 text-warning">
            <span class="flex-1">{{ hostProxyEnabled ? t('coco.hostProxyPendingEnable') : t('coco.hostProxyPendingDisable') }}</span>
            <button type="button" class="btn btn-ghost btn-sm" :disabled="locked || !hostProxy?.available || !!workspaceView?.error" @click="retryHostProxy"><IconRefresh :size="16" />{{ t('coco.pzRetry') }}</button>
          </div>
        </template>
      </div>
    </section>
    <section class="max-w-2xl rounded-xl border border-base-content/10 bg-base-200/60 p-4" aria-labelledby="trusted-devices-title">
      <h2 id="trusted-devices-title" class="text-base font-semibold">{{ t('coco.pzTrustedDevices') }}</h2>
      <p class="mt-1 text-xs leading-relaxed text-base-content/60">{{ t('coco.pzEachBrowserIsAuthorizedSeparatelyRevokingADeviceInvalidates') }}</p>
      <form v-if="editing" class="mt-3 flex flex-wrap items-center gap-2" @submit.prevent="run(rename)">
        <label class="min-w-0 flex-1 text-sm">{{ t('coco.pzDeviceName') }}<input v-model="label" required maxlength="80" class="input input-bordered w-full" :disabled="locked" /></label>
        <button class="btn btn-primary btn-sm" type="submit" :disabled="locked"><IconCheck :size="16" />{{ t('coco.pzSave') }}</button>
        <button class="btn btn-ghost btn-sm" type="button" :disabled="locked" @click="editing = null"><IconX :size="16" />{{ t('coco.pzCancel') }}</button>
      </form>
      <p v-if="!devices.length" class="mt-4 text-sm text-base-content/60">{{ t('coco.pzNoTrustedDevicesChooseToTrustThisDeviceThe') }}</p>
      <ul v-else class="mt-3 divide-y divide-base-content/10">
        <li v-for="device in devices" :key="device.id" class="flex flex-wrap items-center justify-between gap-3 py-3">
          <div class="min-w-0">
            <div class="flex items-center gap-2"><span class="truncate text-sm">{{ device.label }}</span><span v-if="device.current" class="badge badge-sm shrink-0">{{ t('coco.pzCurrentDevice') }}</span></div>
            <p class="mt-1 break-all text-xs text-base-content/65">{{ t('coco.pzLastIpAddress') }}{{ device.lastIP ?? t('coco.pzUnknown') }}</p>
            <p class="mt-1 text-xs text-base-content/55">{{ device.expiresAt === null ? t('coco.pzTrustedIndefinitely') : t('coco.pzValidUntil', { date: new Date(device.expiresAt).toLocaleDateString(locale) }) }} {{ t('coco.pzAuthorizedOn') }} {{ new Date(device.createdAt).toLocaleDateString(locale) }}</p>
          </div>
          <div class="flex shrink-0 gap-1">
            <button type="button" class="btn btn-ghost btn-sm" :disabled="locked" :aria-label="t('coco.pzRename', { device: device.label })" @click="editing = device.id; label = device.label"><IconEdit :size="16" />{{ t('coco.pzRename2') }}</button>
            <button type="button" class="btn btn-ghost btn-sm text-error" :disabled="locked" :aria-label="device.current ? t('coco.pzRevokeThisDeviceAndSignOut') : t('coco.pzRevokeDevice', { device: device.label })" @click="run(() => revoke(device))"><IconShieldX :size="18" />{{ t('coco.pzRevoke') }}</button>
          </div>
        </li>
      </ul>
    </section>
    <div v-if="status?.transaction || status?.fault" class="flex max-w-2xl items-center justify-between gap-3 rounded-xl border border-warning/30 bg-warning/10 p-4"><span class="text-sm text-warning">{{ t('coco.pzConfigurationSwitchRequiresRecovery') }}</span><button class="btn btn-warning btn-sm" :disabled="locked" @click="run(recover)"><IconRestore :size="16" />{{ t('coco.pzRecover') }}</button></div>
  </div>
</template>
