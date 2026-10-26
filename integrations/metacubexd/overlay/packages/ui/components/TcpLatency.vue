<script setup lang="ts">
import { IconBolt } from '@tabler/icons-vue'
import { useTcpDelay } from '~/composables/useTcpDelay'

const props = defineProps<{ proxyName: string }>()
const tcp = useTcpDelay()
const node = computed(() => tcp.metadata(props.proxyName))
const result = computed(() => tcp.resultFor(props.proxyName))
const applicable = computed(() => !!node.value?.applicable)
const labels = { timeout: '超时', 'dns-failed': 'DNS失败', refused: '拒绝', unreachable: '不可达', cancelled: '已取消', 'not-applicable': '不适用', error: '失败', testing: '测试中' }
const text = computed(() => {
  if (!applicable.value) return '不适用'
  const value = result.value
  if (!value) return '未测'
  return value.status === 'success' ? `${value.delay} ms` : labels[value.status]
})
const title = computed(() => {
  if (!applicable.value) return 'TCP 延迟不适用于此条目'
  const value = result.value
  const detail = value?.status === 'error' ? value.message : value && 'checkedAt' in value ? `最近测试：${new Date(value.checkedAt).toLocaleTimeString()}` : ''
  return `测试节点 TCP 延迟：从网关连接服务器端口，不验证代理认证或站点访问。${detail ?? ''}`
})
</script>

<template>
  <button type="button" class="flex shrink-0 items-center gap-1 rounded-md bg-base-content/5 px-1.5 py-1 text-[0.65rem] tabular-nums sm:text-xs" :class="result?.status === 'success' ? 'text-success' : result && result.status !== 'testing' ? 'text-warning' : 'text-base-content/60'" :disabled="!applicable || result?.status === 'testing'" :title="title" :aria-label="`${proxyName} TCP 延迟 ${text}`" :aria-busy="result?.status === 'testing'" @click.stop="tcp.testNode(proxyName)" @keydown.enter.stop @keydown.space.stop>
    <IconBolt :size="14" :class="{ 'animate-pulse': result?.status === 'testing' }" /><span>TCP {{ text }}</span>
  </button>
</template>
