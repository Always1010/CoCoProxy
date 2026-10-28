<script setup lang="ts">
import { IconAlertTriangle, IconRefresh, IconServerCog } from '@tabler/icons-vue'
import { useVersionQuery } from '~/composables/useQueries'
import { useCoCoProxy } from '~/composables/useCoCoProxy'
import { useProxyRefresh } from '~/composables/useProxyRefresh'
const { t } = useI18n()
const route = useRoute()
const { isError, refetch, isFetching } = useVersionQuery()
const { session } = useCoCoProxy()
const configStore = useConfigStore()
const proxyRefresh = useProxyRefresh()
const retrying = ref(false)
const showBanner = computed(() => !!session.value && (isError.value || !!proxyRefresh.error.value) && route.path !== '/cocoproxy')
async function retry() {
  if (retrying.value) return
  retrying.value = true
  try { await Promise.allSettled([refetch(), proxyRefresh.refresh()]) }
  finally { retrying.value = false }
}
</script>

<template>
  <div v-if="showBanner" role="status" class="flex shrink-0 items-center justify-between gap-3 bg-warning/15 px-4 py-2 text-warning" :class="{ 'mb-20 lg:mb-0': configStore.useMobileBottomNav }">
    <div class="flex min-w-0 items-center gap-2" :title="proxyRefresh.error.value || t('coco.anCannotConnectToTheCoreRetry')"><IconAlertTriangle :size="20" class="shrink-0" aria-hidden="true" /><span class="text-sm">{{ t('coco.anCoreUnavailable') }}</span></div>
    <div class="flex shrink-0 gap-1">
      <button class="btn btn-ghost btn-xs" :title="t('coco.anRecheckCore')" :aria-label="t('coco.anRecheckCore')" :disabled="isFetching || retrying" @click="retry"><IconRefresh :size="18" :class="{ 'animate-spin': retrying }" />{{ t('coco.anRetry') }}</button>
      <NuxtLink class="btn btn-ghost btn-xs" to="/cocoproxy" :title="t('coco.anViewOperationStatus')" :aria-label="t('coco.anViewOperationStatus')"><IconServerCog :size="18" />{{ t('coco.anStatus') }}</NuxtLink>
    </div>
  </div>
</template>
