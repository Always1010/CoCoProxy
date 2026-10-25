<script setup lang="ts">
import { IconAdjustments, IconPlus, IconTrash } from '@tabler/icons-vue'

const props = defineProps<{ activeGroup: string | null }>()
const { view, workspace, overrides, busy, run, save } = useWorkspace()
const proxyRefresh = useProxyRefresh()
const menu = ref<{ open: () => void; close: () => void }>()
const customName = ref('')
const available = computed(() => view.value?.catalog?.filter(service => !service.default && !view.value?.groups.some(group => group.name === service.id)) ?? [])
const removable = computed(() => !!props.activeGroup && !view.value?.catalog?.some(service => service.id === props.activeGroup && service.default))
const referenced = computed(() => overrides.value.rules.some(rule => rule.split(',')[2] === props.activeGroup))
const duplicate = computed(() => view.value?.groups.some(group => group.name === customName.value.trim()))

async function add(name: string) {
  if (!name.trim() || busy.value) return
  await run(async () => {
    await save(settings => { settings.local.selections[name.trim()] = 'Proxy' })
    customName.value = ''
    menu.value?.close()
    await proxyRefresh.refresh()
  })
}

async function remove() {
  const name = props.activeGroup
  if (!name || !removable.value || referenced.value || busy.value) return
  await run(async () => {
    await save(settings => { delete settings.local.selections[name] })
    menu.value?.close()
    await proxyRefresh.refresh()
  })
}
</script>

<template>
  <div v-if="workspace?.mode === 'local'" class="shrink-0 sm:w-full">
    <button class="btn btn-ghost btn-sm" title="管理策略组" aria-label="管理策略组" @click="menu?.open()"><IconAdjustments :size="18" /></button>
    <Modal ref="menu" title="管理策略组">
      <div class="px-2 py-1 text-xs text-base-content/60">添加策略组</div>
      <ul v-if="available.length" class="menu w-full p-0"><li v-for="service in available" :key="service.id"><button :disabled="busy" @click="add(service.id)"><IconPlus :size="16" />{{ service.name }}</button></li></ul>
      <form class="mt-2 flex gap-1 border-t border-base-content/10 pt-2" @submit.prevent="add(customName)">
        <input v-model="customName" class="input input-sm min-w-0 flex-1" aria-label="自定义策略组名称" placeholder="自定义组名" maxlength="80" required />
        <button class="btn btn-primary btn-sm" type="submit" title="添加自定义策略组" aria-label="添加自定义策略组" :disabled="busy || !customName.trim() || duplicate"><IconPlus :size="16" /></button>
      </form>
      <button v-if="removable" class="btn btn-ghost btn-sm mt-2 w-full text-error" :disabled="busy || referenced" :title="referenced ? '请先移除引用此组的规则' : '移除当前策略组'" @click="remove"><IconTrash :size="16" />移除 {{ activeGroup }}</button>
    </Modal>
  </div>
</template>
