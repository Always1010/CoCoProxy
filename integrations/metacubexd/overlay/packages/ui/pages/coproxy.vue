<script setup lang="ts">
import { IconCheck, IconLogout, IconRefresh, IconRestore, IconX } from '@tabler/icons-vue'
import type { CoproxyStatus } from '~/composables/useCoproxy'
import { coproxyErrorMessage } from '~/composables/useCoproxy'

useHead({ title: '设置 · Coproxy' })
const api = useCoproxy()
const status = ref<CoproxyStatus | null>(null)
const busy = ref(false)
const error = ref('')

async function run(action: () => Promise<void>) {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try { await action() }
  catch (cause) { error.value = coproxyErrorMessage(cause) }
  finally { busy.value = false }
}
async function refresh() { status.value = await api.readStatus() }
async function recover() {
  await api.request('/api/coproxy/recover', { method: 'POST', body: {} })
  await refresh()
}
onMounted(() => run(refresh))
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto">
    <div class="flex items-center justify-between"><h1 class="text-xl font-semibold">设置</h1><button class="btn btn-ghost btn-square btn-sm" title="刷新状态" aria-label="刷新状态" :disabled="busy" @click="run(refresh)"><IconRefresh :size="18" :class="{ 'animate-spin': busy }" /></button></div>
    <div v-if="error" role="alert" class="alert alert-error text-sm">{{ error }}</div>
    <div class="max-w-2xl rounded-xl border border-base-content/10 bg-base-200/60">
      <div class="flex items-center justify-between border-b border-base-content/8 p-4"><span class="text-sm">当前账户</span><span class="text-sm text-base-content/60">{{ api.session.value?.username }}</span></div>
      <div class="flex items-center justify-between border-b border-base-content/8 p-4"><span class="text-sm">核心状态</span><span v-if="status" class="flex items-center gap-2 text-sm" :class="status.core?.ready ? 'text-success' : 'text-warning'"><IconCheck v-if="status.core?.ready" :size="16" /><IconX v-else :size="16" />{{ status.core?.ready ? '运行中' : '未就绪' }}</span><span v-else class="loading loading-spinner loading-xs" /></div>
      <div class="flex items-center justify-between p-4"><span class="text-sm">管理会话</span><button class="btn btn-outline btn-sm" :disabled="busy" @click="run(api.logout)"><IconLogout :size="16" />退出登录</button></div>
    </div>
    <div v-if="status?.transaction || status?.fault" class="flex max-w-2xl items-center justify-between gap-3 rounded-xl border border-warning/30 bg-warning/10 p-4"><span class="text-sm text-warning">配置切换需要恢复</span><button class="btn btn-warning btn-sm" :disabled="busy" @click="run(recover)"><IconRestore :size="16" />恢复</button></div>
  </div>
</template>