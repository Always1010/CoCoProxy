<script setup lang="ts">
useHead({ title: '代理 · CoCoProxy' })
const { workspace, run, load } = useWorkspace()
const scheme = computed(() => `${workspace.value?.mode ?? 'initial'}:${workspace.value?.mode === 'subscription' ? workspace.value.subscriptionId ?? '' : ''}`)
onMounted(() => run(load))
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col gap-3">
    <WorkspaceToolbar />
    <NativeProxies :key="scheme" class="min-h-0 flex-1" />
  </div>
</template>
