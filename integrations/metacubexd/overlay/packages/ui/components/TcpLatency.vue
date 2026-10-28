<script setup lang="ts">
import { IconBolt } from '@tabler/icons-vue'
import { useTcpDelay } from '~/composables/useTcpDelay'

const { t, locale } = useI18n()
const props = defineProps<{ proxyName: string }>()
const tcp = useTcpDelay()
const node = computed(() => tcp.metadata(props.proxyName))
const result = computed(() => tcp.resultFor(props.proxyName))
const applicable = computed(() => !!node.value?.applicable)
const labels = computed(() => ({ timeout: t('coco.pzTimeout'), 'dns-failed': t('coco.pzDnsFailed'), refused: t('coco.pzRefused'), unreachable: t('coco.pzUnreachable'), cancelled: t('coco.pzCancelled'), 'not-applicable': t('coco.pzNotApplicable'), error: t('coco.pzFailed'), testing: t('coco.pzTesting3') }))
const text = computed(() => {
  if (!applicable.value) return t('coco.pzNotApplicable')
  const value = result.value
  if (!value) return t('coco.pzUntested')
  return value.status === 'success' ? `${value.delay} ms` : labels.value[value.status]
})
const title = computed(() => {
  if (!applicable.value) return t('coco.pzTcpLatencyIsNotApplicableToThisEntry')
  const value = result.value
  const detail = value?.status === 'error' ? value.message : value && 'checkedAt' in value ? t('coco.pzLastTest', { time: new Date(value.checkedAt).toLocaleTimeString(locale.value) }) : ''
  return t('coco.pzTestNodeTcpLatencyConnectFromTheGatewayTo', { detail: detail ?? '' })
})
</script>

<template>
  <button type="button" class="flex shrink-0 items-center gap-1 rounded-md bg-base-content/5 px-1.5 py-1 text-[0.65rem] tabular-nums sm:text-xs" :class="result?.status === 'success' ? 'text-success' : result && result.status !== 'testing' ? 'text-warning' : 'text-base-content/60'" :disabled="!applicable || result?.status === 'testing'" :title="title" :aria-label="t('coco.pzTcpLatency', { node: proxyName, status: text })" :aria-busy="result?.status === 'testing'" @click.stop="tcp.testNode(proxyName)" @keydown.enter.stop @keydown.space.stop>
    <IconBolt :size="14" :class="{ 'animate-pulse': result?.status === 'testing' }" /><span>TCP {{ text }}</span>
  </button>
</template>
