<script setup lang="ts">
import { IconCheck, IconRefresh, IconSettings } from '@tabler/icons-vue'
import { CoproxyError } from '~/composables/useCoproxy'
const props = defineProps<{ dirty?: boolean; beforeApply?: () => Promise<void> }>()
const { view, workspace, busy, error, run, load, save, editOverrides, apply } = useWorkspace()
const profiles = computed(() => view.value?.sources.filter(source => source.kind === 'profile') ?? [])
const visibleError = computed(() => error.value || (view.value?.error ? new CoproxyError(view.value.error).message : ''))

async function changeMode(event: Event) {
  const value = (event.target as HTMLSelectElement).value
  await run(() => save(settings => {
    settings.mode = value === 'local' ? 'local' : 'subscription'
    if (settings.mode === 'subscription' && !settings.subscriptionId)
      settings.subscriptionId = profiles.value[0]?.id ?? null
  }))
}

async function applyCurrent() {
  await run(async () => {
    await props.beforeApply?.()
    await apply()
  })
}

async function resetInvalidSelections() {
  const names = view.value?.invalidSelections ?? []
  await run(() => save(settings => {
    const selections = editOverrides(settings).selections
    for (const name of names) delete selections[name]
  }))
}
</script>

<template>
  <div class="flex shrink-0 flex-col gap-2">
    <div class="flex flex-wrap items-center gap-2 rounded-xl border border-base-content/10 bg-base-200/60 p-2">
      <select class="select select-sm w-36" aria-label="配置方案" :value="workspace?.mode ?? 'local'" :disabled="busy || !workspace || dirty" @change="changeMode">
        <option v-if="workspace?.mode === 'legacy'" value="legacy" disabled>现有配置</option>
        <option value="local">本地规则模板</option>
        <option value="subscription" :disabled="!profiles.length">订阅配置</option>
      </select>
      <select v-if="workspace?.mode === 'subscription'" class="select select-sm max-w-52" aria-label="基础订阅" :value="workspace.subscriptionId" :disabled="busy || dirty" @change="run(() => save(settings => { settings.subscriptionId = ($event.target as HTMLSelectElement).value }))">
        <option v-for="source in profiles" :key="source.id" :value="source.id">{{ source.name || source.host }}</option>
      </select>
      <select class="select select-sm w-28" aria-label="运行模式" :value="workspace?.runMode ?? 'rule'" :disabled="busy || !workspace || dirty" @change="run(() => save(settings => { settings.runMode = ($event.target as HTMLSelectElement).value as 'rule' | 'global' | 'direct' }))">
        <option value="rule">规则</option>
        <option value="global">全局</option>
        <option value="direct">直连</option>
      </select>
      <span v-if="view?.pending || dirty" class="badge badge-warning badge-sm">待应用</span>
      <div class="ml-auto flex items-center gap-1">
        <NuxtLink to="/subscriptions" class="btn btn-ghost btn-sm" title="管理订阅">订阅</NuxtLink>
        <button class="btn btn-ghost btn-sm" title="刷新" aria-label="刷新" :disabled="busy" @click="run(load)"><IconRefresh :size="18" :class="{ 'animate-spin': busy }" />刷新</button>
        <NuxtLink to="/coproxy" class="btn btn-ghost btn-sm" title="设置" aria-label="设置"><IconSettings :size="18" />设置</NuxtLink>
        <button class="btn btn-primary btn-sm" :disabled="busy || (!view?.pending && !dirty)" @click="applyCurrent"><IconCheck :size="16" />应用</button>
      </div>
    </div>
    <div v-if="visibleError" role="alert" class="alert alert-error flex flex-wrap gap-2 py-2 text-sm"><span class="flex-1">{{ visibleError }}</span><button v-if="view?.invalidSelections?.length" class="btn btn-warning btn-sm" :disabled="busy" @click="resetInvalidSelections">重置失效选择</button></div>
  </div>
</template>
