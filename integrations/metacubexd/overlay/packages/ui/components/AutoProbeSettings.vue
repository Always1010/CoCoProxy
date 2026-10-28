<script setup lang="ts">
import { IconCheck } from '@tabler/icons-vue'
import type { AutoProbeSettings } from '~/composables/useWorkspace'
import { CoCoProxyError, cocoproxyErrorMessage } from '~/composables/useCoCoProxy'

const { api, view, workspace, busy, error, run, save } = useWorkspace()
const draft = ref<AutoProbeSettings>()
const allowedOrigins = ref<string[]>([])
const loading = ref(false)
const localError = ref('')
const testResult = ref('')
let disposed = false
const validation = computed(() => {
  if (!draft.value) return '正在读取设置。'
  for (const endpoint of [draft.value.primary, draft.value.secondary]) {
    try {
      const url = new URL(endpoint.url)
      if (url.protocol !== 'https:' || url.username || url.password || endpoint.url.length > 2048 || endpoint.url.includes('?') || endpoint.url.includes('#')) return '请输入不含账号、密码、查询参数和片段的 HTTPS 网址（最多 2048 字符）。'
      if (!allowedOrigins.value.includes(url.origin)) return '检测网址的来源尚未获当前部署许可。'
    } catch { return '请输入有效的检测网址。' }
    if (!Number.isInteger(endpoint.expectedStatus) || endpoint.expectedStatus < 100 || endpoint.expectedStatus > 599) return '期望状态码须为 100–599 的整数。'
  }
  if (!Number.isInteger(draft.value.timeoutMs) || draft.value.timeoutMs < 1000 || draft.value.timeoutMs > 10000 || !Number.isInteger(draft.value.slowMs) || draft.value.slowMs < 500 || draft.value.slowMs > 10000) return '超时须为 1000–10000 ms，慢速阈值须为 500–10000 ms，均须为整数。'
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
  } catch (cause) { if (!disposed) localError.value = cocoproxyErrorMessage(cause) }
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
      localError.value = '检测未通过，请检查网址、期望状态码及当前出口后重试。设置尚未保存。'
      return
    }
    if (workspace.value?.revision !== expectedRevision || view.value?.active !== expectedActive) throw new CoCoProxyError('WORKSPACE_CONFLICT')
    await save(settings => { settings.autoProbes = probes }, '自动选择检测设置已保存')
    testResult.value = `检测通过并已保存：主检测 ${result.primary.delay ?? '—'} ms，备用检测 ${result.secondary.delay ?? '—'} ms。`
  })
}
watch(draft, () => { testResult.value = '' }, { deep: true })
onMounted(open)
onUnmounted(() => { disposed = true })
</script>

<template>
    <section class="border-t border-base-content/10 pt-4">
      <h3 class="mb-2 text-sm font-semibold">自动选择检测 · 所有组共用</h3>
      <HelpTip>所有组共用，保存在服务端。通过当前节点验证两个网址，均通过后才保存；主检测失败或变慢时使用备用检测复核。</HelpTip>
      <p v-if="loading" role="status" class="text-sm">正在读取设置…</p>
      <form v-if="draft" class="flex flex-col gap-3" @submit.prevent="validateAndSave">
        <fieldset v-for="kind in (['primary', 'secondary'] as const)" :key="kind" class="space-y-2 rounded-lg border border-base-content/10 p-3" :disabled="busy">
          <legend class="px-1 text-sm font-medium">{{ kind === 'primary' ? '主检测' : '备用检测' }}</legend>
          <label class="flex flex-col gap-1 text-xs">检测网址<input v-model="draft[kind].url" type="url" maxlength="2048" required class="input input-sm w-full" :aria-label="`${kind === 'primary' ? '主' : '备用'}检测网址`" /></label>
          <label class="flex items-center justify-between gap-3 text-xs">期望状态码<input v-model.number="draft[kind].expectedStatus" type="number" min="100" max="599" required class="input input-sm w-24" /></label>
        </fieldset>
        <label class="flex items-center justify-between gap-3 text-sm">超时（ms）<input v-model.number="draft.timeoutMs" type="number" min="1000" max="10000" required class="input input-sm w-28" :disabled="busy" /></label>
        <label class="flex items-center justify-between gap-3 text-sm">慢速阈值（ms）<input v-model.number="draft.slowMs" type="number" min="500" max="10000" required class="input input-sm w-28" :disabled="busy" /></label>
        <p class="break-all text-xs text-base-content/55">当前许可来源：{{ allowedOrigins.length ? allowedOrigins.join('、') : '无' }}。部署可能只许可 gstatic；其他来源须由管理员显式配置后才能使用。</p>
        <p v-if="validation" role="alert" class="text-sm text-warning">{{ validation }}</p>
        <p v-if="testResult" role="status" class="text-sm text-success">{{ testResult }}</p>
        <div class="mt-1 flex justify-end"><button type="submit" class="btn btn-primary btn-sm" :disabled="busy || !!validation"><IconCheck :size="16" /><span>{{ busy ? '正在验证并保存…' : '验证并保存' }}</span></button></div>
      </form>
      <p v-if="localError || error" role="alert" class="mt-3 text-sm text-error">{{ localError || error }}</p>
    </section>
</template>
