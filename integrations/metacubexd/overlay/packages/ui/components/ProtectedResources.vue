<script setup lang="ts">
import { useCoproxy } from '~/composables/useCoproxy'

const { connect, disconnect, reconnectLogs } = useBackendWebSocket()
const { session } = useCoproxy()
const configStore = useConfigStore()

watch(session, (current) => {
  if (current) connect()
  else disconnect()
}, { immediate: true })
watch(() => configStore.logLevel, () => {
  if (session.value) reconnectLogs()
})
onUnmounted(disconnect)
</script>

<template>
  <div class="hidden" />
</template>
