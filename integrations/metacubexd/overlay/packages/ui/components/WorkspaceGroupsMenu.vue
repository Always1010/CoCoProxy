<script setup lang="ts">
import { IconAdjustments, IconLink, IconPlus, IconTrash } from '@tabler/icons-vue'

const props = defineProps<{ activeGroup: string | null }>()
const { view, workspace, overrides, busy, run, save } = useWorkspace()
const proxyRefresh = useProxyRefresh()
const menu = ref<{ open: () => void; close: () => void }>()
const customName = ref('')
const sharedName = ref('')
const available = computed(() => view.value?.catalog?.filter(service => !service.default && !view.value?.groups.some(group => group.name === service.id)) ?? [])
const removable = computed(() => !!props.activeGroup && !view.value?.catalog?.some(service => service.id === props.activeGroup && service.default))
const activeRole = computed(() => view.value?.groups.find(group => group.name === props.activeGroup)?.role ?? 'service')
const dependentGroups = computed(() => activeRole.value === 'shared' && props.activeGroup
  ? Object.entries(overrides.value.selections).filter(([name, target]) => name !== props.activeGroup && target === props.activeGroup).map(([name]) => name)
  : [])
const referencedByRule = computed(() => overrides.value.rules.some(rule => rule.split(',')[2] === props.activeGroup))
const referenced = computed(() => referencedByRule.value || dependentGroups.value.length > 0)
const referenceMessage = computed(() => dependentGroups.value.length
  ? `正在被 ${dependentGroups.value.join('、')} 使用，请先更改这些策略组。`
  : referencedByRule.value ? '请先移除引用此组的规则。' : '')
const duplicate = computed(() => view.value?.groups.some(group => group.name === customName.value.trim()))
const sharedDuplicate = computed(() => view.value?.groups.some(group => group.name === sharedName.value.trim()))

async function add(name: string) {
  if (!name.trim() || busy.value) return
  await run(async () => {
    await save(settings => { settings.local.selections[name.trim()] = 'Proxy' })
    customName.value = ''
    menu.value?.close()
    await proxyRefresh.refresh()
  })
}

function sharedDefault() {
  const selected = view.value?.groups.find(group => group.name === 'Proxy')?.selected
  return selected && (view.value?.nodes.includes(selected) || ['DIRECT', 'REJECT'].includes(selected))
    ? selected : view.value?.nodes[0] ?? 'REJECT'
}

async function addShared() {
  const name = sharedName.value.trim()
  if (!name || sharedDuplicate.value || busy.value) return
  await run(async () => {
    await save(settings => {
      settings.local.sharedGroups = [...(settings.local.sharedGroups ?? []), name]
      settings.local.selections[name] = sharedDefault()
    })
    sharedName.value = ''
    menu.value?.close()
    await proxyRefresh.refresh()
  })
}

async function remove() {
  const name = props.activeGroup
  if (!name || !removable.value || referenced.value || busy.value) return
  await run(async () => {
    await save(settings => {
      delete settings.local.selections[name]
      if (settings.local.automatic) delete settings.local.automatic[name]
      if (settings.local.sharedGroups?.includes(name)) {
        settings.local.sharedGroups = settings.local.sharedGroups.filter(group => group !== name)
        if (!settings.local.sharedGroups.length) delete settings.local.sharedGroups
      }
    })
    menu.value?.close()
    await proxyRefresh.refresh()
  })
}
</script>

<template>
  <div v-if="workspace?.mode === 'local'" class="shrink-0 sm:w-full">
    <button class="btn btn-ghost btn-sm" title="管理策略组" aria-label="管理策略组" @click="menu?.open()"><IconAdjustments :size="18" /><span>管理策略组</span></button>
    <Modal ref="menu" title="管理策略组">
      <div class="px-2 py-1 text-xs font-medium text-base-content/60">添加普通策略组</div>
      <ul v-if="available.length" class="menu w-full p-0"><li v-for="service in available" :key="service.id"><button :disabled="busy" @click="add(service.id)"><IconPlus :size="16" />{{ service.name }}</button></li></ul>
      <form class="mt-2 flex gap-1 border-t border-base-content/10 pt-2" @submit.prevent="add(customName)">
        <input v-model="customName" class="input input-sm min-w-0 flex-1" aria-label="自定义策略组名称" placeholder="自定义组名" maxlength="80" required />
        <button class="btn btn-primary btn-sm" type="submit" title="添加自定义策略组" aria-label="添加自定义策略组" :disabled="busy || !customName.trim() || duplicate"><IconPlus :size="16" /><span>添加策略组</span></button>
      </form>
      <section class="mt-4 border-t border-base-content/10 pt-3">
        <div class="px-2 text-xs font-medium text-base-content/60">添加共享出口组</div>
        <p class="px-2 pt-1 text-xs text-base-content/45">供多个普通策略组共同引用；只能选择具体节点、直连或拒绝。</p>
        <form class="mt-2 flex gap-1" @submit.prevent="addShared">
          <input v-model="sharedName" class="input input-sm min-w-0 flex-1" aria-label="共享出口组名称" placeholder="共享出口组名称" maxlength="80" required />
          <button class="btn btn-primary btn-sm" type="submit" title="添加共享出口组" aria-label="添加共享出口组" :disabled="busy || !sharedName.trim() || sharedDuplicate"><IconLink :size="16" /><span>添加共享出口组</span></button>
        </form>
      </section>
      <div v-if="removable" class="mt-4 border-t border-base-content/10 pt-2">
        <p v-if="referenced" class="px-2 pb-1 text-xs text-error" role="alert">{{ referenceMessage }}</p>
        <button class="btn btn-ghost btn-sm w-full text-error" :disabled="busy || referenced" :title="referenced ? referenceMessage : '移除当前策略组'" @click="remove"><IconTrash :size="16" /><span>移除{{ activeRole === 'shared' ? '共享出口组' : '策略组' }}：{{ activeGroup }}</span></button>
      </div>
    </Modal>
  </div>
</template>
