<script setup lang="ts">
import { IconAlertTriangle, IconRefresh, IconServerCog } from '@tabler/icons-vue'
import { useVersionQuery } from '~/composables/useQueries'
import { useCoproxy } from '~/composables/useCoproxy'
const route = useRoute()
const { isError, refetch, isFetching } = useVersionQuery()
const { session } = useCoproxy()
const showBanner = computed(() => !!session.value && isError.value && route.path !== '/coproxy')
</script>

<template>
  <div v-if="showBanner" role="status" class="flex shrink-0 items-center justify-between gap-3 bg-warning/15 px-4 py-2 text-warning">
    <div class="flex min-w-0 items-center gap-2"><IconAlertTriangle :size="20" class="shrink-0" aria-hidden="true" /><span class="text-sm">核心当前不可用，请查看运行状态。</span></div>
    <div class="flex shrink-0 gap-1">
      <button class="btn btn-ghost btn-square btn-xs" title="重新检查核心" aria-label="重新检查核心" :disabled="isFetching" @click="() => refetch()"><IconRefresh :size="18" /></button>
      <NuxtLink class="btn btn-ghost btn-square btn-xs" to="/coproxy" title="查看策略与运行状态" aria-label="查看策略与运行状态"><IconServerCog :size="18" /></NuxtLink>
    </div>
  </div>
</template>
