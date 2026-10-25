<script setup lang="ts">
import { IconAlertTriangle, IconRefresh, IconServerCog } from '@tabler/icons-vue'
import { useVersionQuery } from '~/composables/useQueries'
import { useCoproxy } from '~/composables/useCoproxy'
import { useProxyRefresh } from '~/composables/useProxyRefresh'
const route = useRoute()
const { isError, refetch, isFetching } = useVersionQuery()
const { session } = useCoproxy()
const configStore = useConfigStore()
const proxyRefresh = useProxyRefresh()
const retrying = ref(false)
const showBanner = computed(() => !!session.value && (isError.value || !!proxyRefresh.error.value) && route.path !== '/coproxy')
async function retry() {
  if (retrying.value) return
  retrying.value = true
  try { await Promise.allSettled([refetch(), proxyRefresh.refresh()]) }
  finally { retrying.value = false }
}
</script>

<template>
  <div v-if="showBanner" role="status" class="flex shrink-0 items-center justify-between gap-3 bg-warning/15 px-4 py-2 text-warning" :class="{ 'mb-20 lg:mb-0': configStore.useMobileBottomNav }">
    <div class="flex min-w-0 items-center gap-2" :title="proxyRefresh.error.value || '无法连接核心，请重试或查看运行状态。'"><IconAlertTriangle :size="20" class="shrink-0" aria-hidden="true" /><span class="text-sm">核心不可用</span></div>
    <div class="flex shrink-0 gap-1">
      <button class="btn btn-ghost btn-xs" title="重新检查核心" aria-label="重新检查核心" :disabled="isFetching || retrying" @click="retry"><IconRefresh :size="18" :class="{ 'animate-spin': retrying }" />重试</button>
      <NuxtLink class="btn btn-ghost btn-xs" to="/coproxy" title="查看运行状态" aria-label="查看运行状态"><IconServerCog :size="18" />状态</NuxtLink>
    </div>
  </div>
</template>
