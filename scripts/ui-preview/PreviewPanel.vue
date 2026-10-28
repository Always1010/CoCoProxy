<script setup lang="ts">
import { IconFlask, IconRefresh } from '@tabler/icons-vue'
const selected = ref('normal')
const choices = ref<Record<string, string>>({})
const busy = ref(false)
const error = ref('')
onMounted(async () => {
  try {
    const response = await fetch('/api/__preview/scenario')
    if (!response.ok) throw new Error('read')
    const data = await response.json() as { scenario: string; scenarios: Record<string, string> }
    selected.value = data.scenario
    choices.value = data.scenarios
  } catch { error.value = '预览场景读取失败，请刷新重试。' }
})
async function reset() {
  busy.value = true
  error.value = ''
  try {
    const response = await fetch('/api/__preview/scenario', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scenario: selected.value }) })
    if (!response.ok) throw new Error('reset')
    window.location.reload()
  } catch { error.value = '预览场景切换失败，请重试。'; busy.value = false }
}
</script>

<template>
  <details class="shrink-0 border-b border-warning/30 bg-warning/10 px-3 py-1 text-xs" data-ui-preview>
    <summary class="flex cursor-pointer items-center gap-2 py-1"><IconFlask :size="16" aria-hidden="true" /><span>UI 预览 · 模拟数据</span><span class="ml-auto opacity-65">展开场景</span></summary>
    <div class="flex flex-wrap items-center gap-2 py-2">
      <label class="flex items-center gap-2">数据场景<select v-model="selected" aria-label="预览数据场景" class="select select-xs w-36" :disabled="busy"><option v-for="(label, key) in choices" :key="key" :value="key">{{ label }}</option></select></label>
      <button type="button" class="btn btn-xs" :disabled="busy" @click="reset"><IconRefresh :size="14" :class="{ 'animate-spin': busy }" aria-hidden="true" /><span>{{ busy ? '正在切换' : '应用并重置' }}</span></button>
      <span class="opacity-65">数据仅存于内存；切换场景会刷新页面。带宽实测与未模拟操作不可用。</span>
      <span v-if="error" role="alert" class="text-error">{{ error }}</span>
    </div>
  </details>
</template>
