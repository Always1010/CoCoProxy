<script setup lang="ts">
import { getLatencyClassName } from '~/utils'
import { useLatencyFeedback } from '~/composables/useLatencyFeedback'

interface Props {
  proxyName: string
  testUrl: string | null
  providerName?: string
  groupName?: string
  class?: string | Record<string, boolean>
  // When true the pill is a real keyboard-operable control (own tab stop +
  // Enter/Space). Left false for display-only call sites such as
  // ProxyPreviewBar.
  interactive?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  providerName: '',
  groupName: '',
  interactive: false,
})

defineEmits<{
  click: [event: Event]
}>()

const proxiesStore = useProxiesStore()
const configStore = useConfigStore()
const latencyFeedback = useLatencyFeedback()
const { t } = useI18n()

const extraClass = computed(() => props.class || '')

const latency = computed(() =>
  proxiesStore.getLatencyByName(props.proxyName, props.testUrl),
)

const feedback = computed(() => latencyFeedback.feedbackForNode(props.proxyName))

const isTesting = computed(
  () =>
    feedback.value.state === 'testing' ||
    proxiesStore.isTesting(props.proxyName, {
      providerName: props.providerName,
      groupName: props.groupName,
    }),
)

const failureReason = computed(() =>
  feedback.value.state === 'failure' ? feedback.value.reason : null,
)

const latencyClass = computed(() =>
  failureReason.value
    ? 'text-error'
    : getLatencyClassName(latency.value, configStore.latencyQualityMap),
)

const latencyText = computed(() => {
  if (failureReason.value)
    return latencyFeedback.shortLatencyFailure(failureReason.value)
  return latency.value ? `代理 ${latency.value} ms` : '代理未测'
})

const feedbackTitle = computed(() =>
  failureReason.value
    ? latencyFeedback.describeLatencyFailure(failureReason.value)
    : props.interactive
      ? '测试代理延迟：通过此节点访问测试网址'
      : undefined,
)

// Screen-reader label: the bare number alone reads e.g. "88" with no unit or
// purpose, and the spinner announces nothing. Give it a unit, a "testing"
// state, and — only when interactive — the action verb.
const ariaLabel = computed(() => {
  if (isTesting.value) return t('recommendation.testing')
  if (failureReason.value)
    return latencyFeedback.describeLatencyFailure(failureReason.value)
  const value = latency.value ? `${latency.value} ms` : '尚未测试'
  return props.interactive ? `${t('testLatency')}, ${value}` : value
})
</script>

<template>
  <span
    class="latency-pill flex min-w-12 cursor-pointer items-center justify-center rounded-md px-1.5 py-1 text-[0.65rem] font-semibold whitespace-nowrap tabular-nums sm:text-xs"
    :class="[latencyClass, extraClass]"
    :role="interactive ? 'button' : undefined"
    :tabindex="interactive ? 0 : undefined"
    :aria-label="ariaLabel"
    :aria-busy="isTesting || undefined"
    :title="feedbackTitle"
    @click="$emit('click', $event)"
    @keydown.enter.prevent.stop="interactive && $emit('click', $event)"
    @keydown.space.prevent.stop="interactive && $emit('click', $event)"
  >
    <span
      v-if="isTesting"
      class="inline-flex items-center gap-1"
    >
      <span
        aria-hidden="true"
        class="h-3 w-3 animate-spin rounded-full border-2 border-current/30 border-t-current"
      />
      <span>测试中</span>
    </span>
    <span v-else>{{ latencyText }}</span>
  </span>
</template>

<style scoped>
.latency-pill {
  position: relative;
  background-color: color-mix(in oklab, currentColor 12%, transparent);
  box-shadow: var(--inner-highlight);
  transition:
    transform var(--dur-base) var(--ease-spring),
    background-color var(--dur-fast) var(--ease-soft);
}
.latency-pill:hover {
  transform: scale(1.06);
  background-color: color-mix(in oklab, currentColor 18%, transparent);
}
.latency-pill:active {
  transform: scale(0.92);
  transition-duration: var(--dur-instant);
  transition-timing-function: var(--ease-press);
}

</style>
