<script setup lang="ts">
import { IconRefresh, IconSettings } from '@tabler/icons-vue'
import { CoproxyError } from '~/composables/useCoproxy'
defineProps<{ dirty?: boolean }>()
const { view, workspace, busy, error, feedback, operation, run, load, save, editOverrides } = useWorkspace()
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
      <span v-if="busy" role="status" class="flex items-center gap-2 text-xs text-base-content/65"><span class="loading loading-spinner loading-xs" />{{ operation || '正在读取…' }}</span>
      <span v-else-if="dirty" class="badge badge-warning badge-sm">规则尚未保存</span>
      <span v-else-if="view?.pending" class="badge badge-warning badge-sm">设置未生效</span>
      <div class="ml-auto flex items-center gap-1">
        <NuxtLink to="/subscriptions" class="btn btn-ghost btn-sm" title="管理订阅">订阅</NuxtLink>
        <button class="btn btn-ghost btn-sm" title="刷新" aria-label="刷新" :disabled="busy" @click="run(load)"><IconRefresh :size="18" :class="{ 'animate-spin': busy }" />刷新</button>
        <NuxtLink to="/coproxy" class="btn btn-ghost btn-sm" title="设置" aria-label="设置"><IconSettings :size="18" />设置</NuxtLink>
      </div>
    </div>
    <div v-if="visibleError" role="alert" class="alert alert-error flex flex-wrap gap-2 py-2 text-sm"><span class="flex-1">{{ visibleError }}</span><button v-if="view?.invalidSelections?.length" class="btn btn-warning btn-sm" :disabled="busy" @click="resetInvalidSelections">重置失效选择</button></div>
    <div v-if="!busy && feedback && !visibleError" role="status" aria-live="polite" class="rounded-lg bg-success/10 px-3 py-2 text-sm text-success">{{ feedback }}</div>
    <div v-if="!busy && view?.pending" class="flex items-center gap-2 rounded-lg bg-warning/10 px-3 py-2 text-sm text-warning"><span class="flex-1">这些设置尚未生效，当前仍使用原配置。重新选择会直接尝试生效。</span><button class="btn btn-ghost btn-sm" title="重试未生效的设置" aria-label="重试未生效的设置" :disabled="!!view.error" @click="run(() => save(() => {}))"><IconRefresh :size="16" />重试</button></div>
  </div>
</template>
