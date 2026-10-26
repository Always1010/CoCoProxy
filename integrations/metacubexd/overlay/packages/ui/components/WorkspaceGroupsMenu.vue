<script setup lang="ts">
import { IconAdjustments, IconLink, IconPlus, IconTrash } from '@tabler/icons-vue'
import { localGroupNameError } from '~/utils/group-rules'

const props = defineProps<{ activeGroup: string | null; configure?: (name: string) => void }>()
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
const customError = computed(() => customName.value.trim() && view.value ? localGroupNameError(customName.value, view.value) : '')
const sharedError = computed(() => sharedName.value.trim() && view.value ? localGroupNameError(sharedName.value, view.value, true) : '')

async function add(name: string, preset = false) {
  name = name.trim()
  if (!name || busy.value || !view.value) return
  if (preset ? !available.value.some(service => service.id === name) : localGroupNameError(name, view.value)) return
  await run(async () => {
    await save(settings => { settings.local.selections[name] = 'Proxy' }, preset ? '预置服务组及内置规则已启用' : '策略组已创建，请继续添加匹配规则')
    customName.value = ''
    menu.value?.close()
    await proxyRefresh.refresh()
    if (!preset) props.configure?.(name)
  })
}

function sharedDefault() {
  const selected = view.value?.groups.find(group => group.name === 'Proxy')?.selected
  return selected && (view.value?.nodes.includes(selected) || ['DIRECT', 'REJECT'].includes(selected))
    ? selected : view.value?.nodes[0] ?? 'REJECT'
}

async function addShared() {
  const name = sharedName.value.trim()
  if (!name || !view.value || localGroupNameError(name, view.value, true) || busy.value) return
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
      <div class="px-2 py-1 text-sm font-medium">启用预置服务组</div>
      <p class="px-2 text-xs text-base-content/60">自带域名规则，启用后可单独选择这些服务的出口。</p>
      <ul v-if="available.length" class="menu w-full p-0"><li v-for="service in available" :key="service.id"><button class="min-h-11" :disabled="busy" @click="add(service.id, true)"><IconPlus :size="16" /><span>启用 {{ service.name }}</span><span class="text-xs text-base-content/50">自带规则</span></button></li></ul>
      <p v-else class="px-2 py-2 text-xs text-base-content/50">预置服务组均已启用</p>
      <div class="mt-3 border-t border-base-content/10 px-2 pt-3 text-sm font-medium">创建自定义策略组</div>
      <p class="px-2 pt-1 text-xs text-base-content/60">创建后添加域名规则，指定哪些网站使用本组。初始出口跟随 Proxy。</p>
      <form class="mt-2 flex flex-wrap gap-2" @submit.prevent="add(customName)">
        <input v-model="customName" class="input min-h-11 min-w-0 flex-1 basis-40" aria-label="自定义策略组名称" placeholder="自定义组名" maxlength="80" :disabled="busy" required />
        <button class="btn btn-primary min-h-11" type="submit" title="添加自定义策略组" aria-label="添加自定义策略组" :disabled="busy || !customName.trim() || !!customError"><IconPlus :size="16" /><span>创建并配置规则</span></button>
      </form>
      <p v-if="customError" role="alert" class="px-2 pt-1 text-xs text-error">{{ customError }}</p>
      <section class="mt-4 border-t border-base-content/10 pt-3">
        <div class="px-2 text-sm font-medium">创建共享出口组</div>
        <p class="px-2 pt-1 text-xs text-base-content/45">供多个普通策略组共同引用；只能选择具体节点、直连或拒绝。</p>
        <form class="mt-2 flex flex-wrap gap-2" @submit.prevent="addShared">
          <input v-model="sharedName" class="input min-h-11 min-w-0 flex-1 basis-40" aria-label="共享出口组名称" placeholder="共享出口组名称" maxlength="80" :disabled="busy" required />
          <button class="btn btn-primary min-h-11" type="submit" title="添加共享出口组" aria-label="添加共享出口组" :disabled="busy || !sharedName.trim() || !!sharedError"><IconLink :size="16" /><span>创建共享出口</span></button>
        </form>
        <p v-if="sharedError" role="alert" class="px-2 pt-1 text-xs text-error">{{ sharedError }}</p>
      </section>
      <div v-if="removable" class="mt-4 border-t border-base-content/10 pt-2">
        <p v-if="referenced" class="px-2 pb-1 text-xs text-error" role="alert">{{ referenceMessage }}</p>
        <NuxtLink v-if="referencedByRule" :to="{ path: '/rules', query: { group: activeGroup, tab: 'custom' } }" class="btn btn-ghost min-h-11" @click="menu?.close()"><IconLink :size="16" /><span>查看引用规则</span></NuxtLink>
        <button class="btn btn-ghost btn-sm w-full text-error" :disabled="busy || referenced" :title="referenced ? referenceMessage : '移除当前策略组'" @click="remove"><IconTrash :size="16" /><span>移除{{ activeRole === 'shared' ? '共享出口组' : '策略组' }}：{{ activeGroup }}</span></button>
      </div>
    </Modal>
  </div>
</template>
