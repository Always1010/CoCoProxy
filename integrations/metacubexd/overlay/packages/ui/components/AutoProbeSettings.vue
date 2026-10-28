<script setup lang="ts">
import { IconCheck } from '@tabler/icons-vue'
import type { AutoProbeSettings } from '~/composables/useWorkspace'
import { CoCoProxyError, cocoproxyErrorMessage } from '~/composables/useCoCoProxy'
const { t } = useI18n()

const { api, view, workspace, busy, error, run, save } = useWorkspace()
const draft = ref<AutoProbeSettings>()
const allowedOrigins = ref<string[]>([])
const loading = ref(false)
const localError = useLocalizedMessage()
const testResult = useLocalizedMessage()
let disposed = false
const validation = computed(() => {
  if (!draft.value) return t('coco.anLoadingSettings')
  for (const endpoint of [draft.value.primary, draft.value.secondary]) {
    try {
      const url = new URL(endpoint.url)
      if (url.protocol !== 'https:' || url.username || url.password || endpoint.url.length > 2048 || endpoint.url.includes('?') || endpoint.url.includes('#')) return t('coco.anEnterAnHttpsUrlWithoutA')
      if (!allowedOrigins.value.includes(url.origin)) return t('coco.anTheCheckUrlSOriginIs')
    } catch { return t('coco.anEnterAValidCheckUrl') }
    if (!Number.isInteger(endpoint.expectedStatus) || endpoint.expectedStatus < 100 || endpoint.expectedStatus > 599) return t('coco.anTheExpectedStatusCodeMustBe')
  }
  if (!Number.isInteger(draft.value.timeoutMs) || draft.value.timeoutMs < 1000 || draft.value.timeoutMs > 10000 || !Number.isInteger(draft.value.slowMs) || draft.value.slowMs < 500 || draft.value.slowMs > 10000) return t('coco.anTimeoutMustBeMsAndThe')
  return ''
})
async function open() {
  if (loading.value) return
  loading.value = true
  draft.value = undefined
  localError.value = ''
  testResult.value = ''
  try {
    const result = await api.request<{ defaults: AutoProbeSettings; allowedOrigins: string[] }>('/api/cocoproxy/automatic/probes')
    if (!disposed) {
      draft.value = JSON.parse(JSON.stringify(workspace.value?.autoProbes ?? result.defaults)) as AutoProbeSettings
      allowedOrigins.value = result.allowedOrigins
    }
  } catch (cause) { if (!disposed) localError.value = () => cocoproxyErrorMessage(cause, t) }
  finally { loading.value = false }
}
async function validateAndSave() {
  if (!draft.value || !workspace.value || !view.value || validation.value || busy.value) return
  localError.value = ''
  testResult.value = ''
  // Freeze exactly the tested settings and revision across the asynchronous
  // test; another operator's edit must never be silently overwritten.
  const probes = JSON.parse(JSON.stringify(draft.value)) as AutoProbeSettings
  const expectedRevision = workspace.value.revision
  const expectedActive = view.value.active
  await run(async () => {
    const result = await api.request<{ ok: boolean; primary: { ok: boolean; delay: number | null }; secondary: { ok: boolean; delay: number | null } }>('/api/cocoproxy/automatic/test', {
      method: 'POST', body: { expectedRevision, expectedActive, probes },
    })
    if (!result.ok || !result.primary.ok || !result.secondary.ok) {
      localError.value = () => t('coco.anChecksFailedReviewTheUrlsExpected')
      return
    }
    if (workspace.value?.revision !== expectedRevision || view.value?.active !== expectedActive) throw new CoCoProxyError('WORKSPACE_CONFLICT')
    await save(settings => { settings.autoProbes = probes }, 'coco.anAutomaticSelectionCheckSettingsSaved')
    testResult.value = () => t('coco.anChecksPassedAndSettingsSavedPrimary', { value: result.primary.delay ?? '—', value2: result.secondary.delay ?? '—' })
  })
}
watch(draft, () => { testResult.value = '' }, { deep: true })
onMounted(open)
onUnmounted(() => { disposed = true })
</script>

<template>
    <section class="border-t border-base-content/10 pt-4">
      <h3 class="mb-2 text-sm font-semibold">{{ t('coco.anAutomaticSelectionChecksSharedByAll') }}</h3>
      <HelpTip>{{ t('coco.anSharedByAllGroupsAndStored') }}</HelpTip>
      <p v-if="loading" role="status" class="text-sm">{{ t('coco.anLoadingSettings2') }}</p>
      <form v-if="draft" class="flex flex-col gap-3" @submit.prevent="validateAndSave">
        <fieldset v-for="kind in (['primary', 'secondary'] as const)" :key="kind" class="space-y-2 rounded-lg border border-base-content/10 p-3" :disabled="busy">
          <legend class="px-1 text-sm font-medium">{{ kind === 'primary' ? t('coco.anPrimaryCheck') : t('coco.anSecondaryCheck') }}</legend>
          <label class="flex flex-col gap-1 text-xs">{{ t('coco.anCheckUrl') }}<input v-model="draft[kind].url" type="url" maxlength="2048" required class="input input-sm w-full" :aria-label="t('coco.anCheckUrl2', { value: kind === 'primary' ? t('coco.anPrimary') : t('coco.anSecondary') })" /></label>
          <label class="flex items-center justify-between gap-3 text-xs">{{ t('coco.anExpectedStatusCode') }}<input v-model.number="draft[kind].expectedStatus" type="number" min="100" max="599" required class="input input-sm w-24" /></label>
        </fieldset>
        <label class="flex items-center justify-between gap-3 text-sm">{{ t('coco.anTimeoutMs') }}<input v-model.number="draft.timeoutMs" type="number" min="1000" max="10000" required class="input input-sm w-28" :disabled="busy" /></label>
        <label class="flex items-center justify-between gap-3 text-sm">{{ t('coco.anSlowThresholdMs') }}<input v-model.number="draft.slowMs" type="number" min="500" max="10000" required class="input input-sm w-28" :disabled="busy" /></label>
        <p class="break-all text-xs text-base-content/55">{{ t('coco.anCurrentlyPermittedOriginsThisDeploymentMay', { value: allowedOrigins.length ? allowedOrigins.join('、') : t('coco.anNone') }) }}</p>
        <p v-if="validation" role="alert" class="text-sm text-warning">{{ validation }}</p>
        <p v-if="testResult" role="status" class="text-sm text-success">{{ testResult }}</p>
        <div class="mt-1 flex justify-end"><button type="submit" class="btn btn-primary btn-sm" :disabled="busy || !!validation"><IconCheck :size="16" /><span>{{ busy ? t('coco.anValidatingAndSaving') : t('coco.anValidateAndSave') }}</span></button></div>
      </form>
      <p v-if="localError || error" role="alert" class="mt-3 text-sm text-error">{{ localError || error }}</p>
    </section>
</template>
