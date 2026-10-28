<script setup lang="ts">
import { IconCheck, IconEdit, IconLogout, IconRefresh, IconRestore, IconShieldX, IconX } from '@tabler/icons-vue'
import type { CoCoProxyStatus } from '~/composables/useCoCoProxy'
import { cocoproxyErrorMessage } from '~/composables/useCoCoProxy'

const { t, locale } = useI18n()
useHead({ title: computed(() => t('coco.pzSettingsCocoproxy')) })
const api = useCoCoProxy()
const status = ref<CoCoProxyStatus | null>(null)
const busy = ref(false)
const errorSource = shallowRef<(() => string) | null>(null)
const error = computed(() => errorSource.value?.() ?? '')
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
  if (busy.value) return
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
  ])
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
    <div class="flex items-center justify-between"><h1 class="text-xl font-semibold">{{ t('coco.pzSettings') }}</h1><button class="btn btn-ghost btn-sm" :title="t('coco.pzRefreshStatus')" :aria-label="t('coco.pzRefreshStatus')" :disabled="busy" @click="run(refresh)"><IconRefresh :size="18" :class="{ 'animate-spin': busy }" />{{ t('coco.pzRefresh') }}</button></div>
    <div v-if="error" role="alert" class="alert alert-error text-sm">{{ error }}</div>
    <div class="max-w-2xl rounded-xl border border-base-content/10 bg-base-200/60">
      <div class="flex items-center justify-between border-b border-base-content/8 p-4"><span class="text-sm">{{ t('coco.pzCurrentAccount') }}</span><span class="text-sm text-base-content/60">{{ api.session.value?.username }}</span></div>
      <div class="flex items-center justify-between border-b border-base-content/8 p-4"><span class="text-sm">{{ t('coco.pzCoreStatus') }}</span><span v-if="status" class="flex items-center gap-2 text-sm" :class="status.core?.ready ? 'text-success' : 'text-warning'"><IconCheck v-if="status.core?.ready" :size="16" /><IconX v-else :size="16" />{{ status.core?.ready ? t('coco.pzRunning') : t('coco.pzNotReady') }}</span><span v-else class="loading loading-spinner loading-xs" /></div>
      <div class="flex items-center justify-between p-4"><span class="text-sm">{{ t('coco.pzManagementSession') }}</span><button class="btn btn-outline btn-sm" :disabled="busy" @click="run(api.logout)"><IconLogout :size="16" />{{ t('coco.pzSignOut') }}</button></div>
    </div>
    <section class="max-w-2xl rounded-xl border border-base-content/10 bg-base-200/60 p-4" aria-labelledby="trusted-devices-title">
      <h2 id="trusted-devices-title" class="text-base font-semibold">{{ t('coco.pzTrustedDevices') }}</h2>
      <p class="mt-1 text-xs leading-relaxed text-base-content/60">{{ t('coco.pzEachBrowserIsAuthorizedSeparatelyRevokingADeviceInvalidates') }}</p>
      <form v-if="editing" class="mt-3 flex flex-wrap items-center gap-2" @submit.prevent="run(rename)">
        <label class="min-w-0 flex-1 text-sm">{{ t('coco.pzDeviceName') }}<input v-model="label" required maxlength="80" class="input input-bordered w-full" :disabled="busy" /></label>
        <button class="btn btn-primary btn-sm" type="submit" :disabled="busy"><IconCheck :size="16" />{{ t('coco.pzSave') }}</button>
        <button class="btn btn-ghost btn-sm" type="button" :disabled="busy" @click="editing = null"><IconX :size="16" />{{ t('coco.pzCancel') }}</button>
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
            <button type="button" class="btn btn-ghost btn-sm" :disabled="busy" :aria-label="t('coco.pzRename', { device: device.label })" @click="editing = device.id; label = device.label"><IconEdit :size="16" />{{ t('coco.pzRename2') }}</button>
            <button type="button" class="btn btn-ghost btn-sm text-error" :disabled="busy" :aria-label="device.current ? t('coco.pzRevokeThisDeviceAndSignOut') : t('coco.pzRevokeDevice', { device: device.label })" @click="run(() => revoke(device))"><IconShieldX :size="18" />{{ t('coco.pzRevoke') }}</button>
          </div>
        </li>
      </ul>
    </section>
    <div v-if="status?.transaction || status?.fault" class="flex max-w-2xl items-center justify-between gap-3 rounded-xl border border-warning/30 bg-warning/10 p-4"><span class="text-sm text-warning">{{ t('coco.pzConfigurationSwitchRequiresRecovery') }}</span><button class="btn btn-warning btn-sm" :disabled="busy" @click="run(recover)"><IconRestore :size="16" />{{ t('coco.pzRecover') }}</button></div>
  </div>
</template>
