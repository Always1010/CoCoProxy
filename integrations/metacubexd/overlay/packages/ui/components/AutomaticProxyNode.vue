<script setup lang="ts">
const props = defineProps<{
  proxyName: string
  testUrl: string | null
  timeout: number | null
  isSelected?: boolean
  groupName?: string
}>()
const { proxyType, runLatencyTest } = useProxyNode(
  () => props.proxyName,
  () => props.testUrl,
  () => props.timeout,
)
</script>

<template>
  <div class="flex min-w-0 items-center gap-3 rounded-lg border border-base-content/8 px-3 py-2 text-sm" :class="isSelected ? 'bg-primary/15' : 'bg-base-200/60'">
    <span class="min-w-0 flex-1 truncate"><ProxyNodeName :name="proxyName" /></span>
    <span class="hidden text-xs text-base-content/45 sm:inline">{{ proxyType }}</span>
    <TcpLatency :proxy-name="proxyName" />
    <Latency :proxy-name="proxyName" :test-url="testUrl" interactive @click.stop="runLatencyTest" />
    <SiteResultBadge v-if="groupName" :proxy-name="proxyName" :group-name="groupName" />
  </div>
</template>
