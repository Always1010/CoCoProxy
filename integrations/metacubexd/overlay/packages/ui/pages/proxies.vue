<script setup lang="ts">
import { IconChevronRight, IconGlobe, IconPlus, IconSearch, IconTrash } from '@tabler/icons-vue'
useHead({ title: '代理 · Coproxy' })
const { view, workspace, overrides, busy, load, run, save, editOverrides } = useWorkspace()
const tab = ref<'groups' | 'nodes'>('groups')
const search = ref('')
const addMenu = ref<HTMLDetailsElement | null>(null)
const customGroup = ref('')
const groups = computed(() => view.value?.groups.filter(group => displayName(group.name).toLocaleLowerCase().includes(search.value.toLocaleLowerCase())) ?? [])
const availableServices = computed(() => view.value?.catalog?.filter(service => !service.default && !view.value?.groups.some(group => group.name === service.id)) ?? [])
const displayName = (name: string) => workspace.value?.mode === 'local' ? view.value?.catalog?.find(service => service.id === name)?.name ?? name : name
const removable = (name: string) => workspace.value?.mode === 'local' && !view.value?.catalog?.some(service => service.id === name && service.default)
const referenced = (name: string) => overrides.value.rules.some(rule => rule.split(',')[2] === name)
const sourceNames = computed(() => view.value?.sources.filter(source => workspace.value?.sourceIds.includes(source.id)).map(source => source.name || source.host) ?? [])
const selectedName = computed(() => workspace.value?.mode === 'subscription'
  ? view.value?.sources.find(source => source.id === workspace.value?.subscriptionId)?.name || '订阅配置'
  : workspace.value?.mode === 'legacy' ? '现有配置' : '本地规则模板')

function select(name: string, event: Event) {
  const value = (event.target as HTMLSelectElement).value
  return run(() => save(settings => { editOverrides(settings).selections[name] = value }))
}

function addGroup(id: string) {
  if (!id.trim()) return
  if (addMenu.value) addMenu.value.open = false
  return run(async () => {
    await save(settings => { settings.local.selections = { ...settings.local.selections, [id.trim()]: 'Proxy' } })
    customGroup.value = ''
  })
}

function removeGroup(id: string) {
  return run(() => save(settings => { delete settings.local.selections[id] }))
}

onMounted(() => run(load))
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col gap-3">
    <WorkspaceToolbar />
    <div class="flex shrink-0 items-center gap-2">
      <div role="tablist" class="tabs tabs-box w-fit">
        <button role="tab" class="tab" :class="{ 'tab-active': tab === 'groups' }" :aria-selected="tab === 'groups'" @click="tab = 'groups'">策略组</button>
        <button role="tab" class="tab" :class="{ 'tab-active': tab === 'nodes' }" :aria-selected="tab === 'nodes'" @click="tab = 'nodes'">节点</button>
      </div>
      <span v-if="view" class="ml-auto text-xs text-base-content/50">{{ view.nodes.length }} 个节点</span>
    </div>
    <div v-if="tab === 'groups'" class="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
      <div v-if="workspace" class="flex items-center gap-2 px-1 text-sm text-base-content/60"><span>{{ selectedName }}</span><IconChevronRight :size="15" /><span class="truncate">{{ workspace.mode !== 'local' ? '保留原有策略组' : sourceNames.join('、') || '未选择订阅' }}</span></div>
      <div class="flex items-center gap-2">
        <label class="input input-sm flex w-full items-center gap-2 sm:max-w-xs"><IconSearch :size="16" class="opacity-50" /><input v-model="search" type="search" class="grow" placeholder="搜索策略组" aria-label="搜索策略组" /></label>
        <details v-if="workspace?.mode === 'local'" ref="addMenu" class="dropdown dropdown-end ml-auto">
          <summary class="btn btn-ghost btn-square btn-sm" title="添加策略组" aria-label="添加策略组"><IconPlus :size="18" /></summary>
          <div class="dropdown-content z-10 mt-2 w-64 rounded-box border border-base-content/10 bg-base-200 p-2 shadow-lg">
            <ul v-if="availableServices.length" class="menu w-full p-0"><li v-for="service in availableServices" :key="service.id"><button :disabled="busy" @click="addGroup(service.id)">{{ service.name }}</button></li></ul>
            <form class="mt-2 flex gap-1 border-t border-base-content/10 pt-2" @submit.prevent="addGroup(customGroup)"><input v-model="customGroup" class="input input-sm min-w-0 flex-1" aria-label="自定义策略组名称" placeholder="自定义组名" maxlength="80" required /><button class="btn btn-primary btn-square btn-sm" type="submit" title="添加自定义策略组" aria-label="添加自定义策略组" :disabled="busy || !customGroup.trim() || !!view?.groups.some(group => group.name === customGroup.trim())"><IconPlus :size="16" /></button></form>
          </div>
        </details>
      </div>
      <div v-if="!view" class="flex flex-1 items-center justify-center"><span class="loading loading-spinner text-primary" /></div>
      <div v-else-if="!groups.length" class="py-16 text-center text-sm text-base-content/50">{{ search ? '没有匹配的策略组' : '暂无策略组' }}<NuxtLink v-if="!search" to="/subscriptions" class="ml-2 link link-primary">选择订阅</NuxtLink></div>
      <div v-else class="grid grid-cols-1 gap-2 xl:grid-cols-2">
        <div v-for="group in groups" :key="group.name" class="flex min-w-0 items-center gap-3 rounded-xl border border-base-content/8 bg-base-200/60 px-3 py-3">
          <IconGlobe :size="22" class="shrink-0 text-primary" />
          <div class="min-w-0 flex-1"><div class="truncate text-sm font-medium">{{ displayName(group.name) }}</div><div class="mt-0.5 text-xs text-base-content/45">{{ group.type }} · {{ group.options.length }} 个选项</div></div>
          <select class="select select-sm w-44 max-w-[50%] truncate" :aria-label="`${displayName(group.name)} 策略`" :value="overrides.selections[group.name] ?? group.selected" :disabled="busy || group.type !== 'select'" :title="group.type !== 'select' ? '由自动策略选择节点' : undefined" @change="select(group.name, $event)"><option v-for="option in group.options" :key="option" :value="option">{{ displayName(option) }}</option></select>
          <button v-if="removable(group.name)" class="btn btn-ghost btn-square btn-xs text-error" :title="referenced(group.name) ? '请先移除引用此组的规则' : '移除策略组'" :aria-label="`移除 ${displayName(group.name)}`" :disabled="busy || referenced(group.name)" @click="removeGroup(group.name)"><IconTrash :size="16" /></button>
        </div>
      </div>
    </div>
    <NativeProxies v-else :key="view?.active ?? 'initial'" class="min-h-0 flex-1" />
  </div>
</template>
