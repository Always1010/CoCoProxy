<script setup lang="ts">
import { IconAdjustments, IconArrowLeft, IconSettings, IconLink, IconPlus, IconTrash } from '@tabler/icons-vue'
import { localGroupNameError } from '~/utils/group-rules'

const props = defineProps<{ activeGroup: string | null; configure?: (name: string, rules?: boolean) => void }>()
const { view, workspace, overrides, busy, run, save } = useWorkspace()
const proxyRefresh = useProxyRefresh()
const menu = ref<{ open: () => void; close: () => void }>()
const createKind = ref<'preset' | 'custom' | 'shared' | null>(null)
const customName = ref('')
const sharedName = ref('')
const available = computed(() => view.value?.catalog?.filter(service => !service.default && !view.value?.groups.some(group => group.name === service.id)) ?? [])
const deleting = ref<string | null>(null)
const deleteDialog = ref<{ open: () => void; close: (force?: boolean) => void }>()
function removalReason(name: string) {
  if (view.value?.catalog?.some(service => service.id === name && service.default)) return '固定策略组，不能移除。'
  const dependents = Object.entries(overrides.value.selections).filter(([group, target]) => group !== name && target === name).map(([group]) => group)
  if (dependents.length) return `正在被 ${dependents.join('、')} 使用，请先更改这些策略组。`
  return ''
}
function requestRemove(name: string) {
  if (busy.value || removalReason(name)) return
  deleting.value = name
  deleteDialog.value?.open()
}
function configure(name: string, rules = false) {
  createKind.value = null
  props.configure?.(name, rules)
}
const customError = computed(() => customName.value.trim() && view.value ? localGroupNameError(customName.value, view.value) : '')
const sharedError = computed(() => sharedName.value.trim() && view.value ? localGroupNameError(sharedName.value, view.value, true) : '')

async function add(name: string, preset = false) {
  name = name.trim()
  if (!name || busy.value || !view.value) return
  if (preset ? !available.value.some(service => service.id === name) : localGroupNameError(name, view.value)) return
  await run(async () => {
    await save(settings => { settings.local.selections[name] = 'Proxy' }, preset ? '预置服务组及内置规则已启用' : '策略组已创建，请继续添加匹配规则')
    customName.value = ''
    createKind.value = null
    await proxyRefresh.refresh()
    if (!preset) configure(name, true)
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
    createKind.value = null
    await proxyRefresh.refresh()
  })
}

async function remove() {
  const name = deleting.value
  if (!name || removalReason(name) || busy.value) return
  await run(async () => {
    await save(settings => {
      settings.local.rules = settings.local.rules.filter(rule => rule.split(',')[2] !== name && !(rule.startsWith('MATCH,') && rule.split(',')[1] === name))
      delete settings.local.selections[name]
      if (settings.local.automatic) delete settings.local.automatic[name]
      if (settings.local.sharedGroups?.includes(name)) {
        settings.local.sharedGroups = settings.local.sharedGroups.filter(group => group !== name)
        if (!settings.local.sharedGroups.length) delete settings.local.sharedGroups
      }
    })
    deleteDialog.value?.close(true)
    deleting.value = null
    await proxyRefresh.refresh()
  })
}
</script>

<template>
  <div v-if="workspace?.mode === 'local'" class="shrink-0 sm:w-full">
    <button class="btn btn-ghost btn-sm" title="管理策略组" aria-label="管理策略组" @click="createKind = null; menu?.open()"><IconAdjustments :size="18" /><span>管理策略组</span></button>
    <Modal ref="menu" title="管理策略组" compact :fixed-height="false">
      <template v-if="!createKind">
        <div class="mb-3 flex items-center justify-between gap-2"><span class="text-sm text-base-content/60">{{ view?.groups.length ?? 0 }} 个策略组</span><button type="button" class="btn btn-primary min-h-11" @click="createKind = 'preset'"><IconPlus :size="16" /><span>添加策略组</span></button></div>
        <ul class="divide-y divide-base-content/10">
          <li v-for="group in view?.groups" :key="group.name" class="py-1.5">
            <div class="flex min-h-11 items-center justify-between gap-2">
              <div class="flex min-w-0 flex-wrap items-baseline gap-x-2"><span class="break-all text-sm font-medium">{{ group.name }}</span><span class="text-xs text-base-content/50">{{ group.role === 'shared' ? '共享出口' : '策略组' }}</span></div>
              <div class="flex shrink-0 items-center gap-1">
                <button v-if="props.configure" type="button" class="btn btn-ghost btn-sm" :disabled="busy" :aria-label="`设置策略组 ${group.name}`" @click="configure(group.name)"><IconSettings :size="16" /><span>设置</span></button>
                <HelpTip v-if="removalReason(group.name)" label="不可移除">{{ removalReason(group.name) }}</HelpTip>
                <button v-else type="button" class="btn btn-ghost btn-sm text-error" :disabled="busy" :aria-label="`移除策略组 ${group.name}`" @click="requestRemove(group.name)"><IconTrash :size="16" /><span>移除</span></button>
              </div>
            </div>
          </li>
        </ul>
      </template>
      <template v-else>
      <button type="button" class="btn btn-ghost btn-sm mb-3 min-h-11" @click="createKind = null"><IconArrowLeft :size="16" /><span>返回组列表</span></button>
      <div class="mb-4 grid grid-cols-3 gap-1 rounded-xl bg-base-content/5 p-1" role="tablist" aria-label="策略组类型">
        <button v-for="item in [{ key: 'preset', label: '预置服务', icon: IconPlus }, { key: 'custom', label: '自定义', icon: IconAdjustments }, { key: 'shared', label: '共享出口', icon: IconLink }]" :key="item.key" type="button" role="tab" class="btn btn-ghost min-h-11 px-2" :class="createKind === item.key ? 'bg-base-100 shadow-sm' : 'text-base-content/60'" :aria-selected="createKind === item.key" @click="createKind = item.key as typeof createKind"><component :is="item.icon" :size="16" /><span>{{ item.label }}</span></button>
      </div>
      <section v-if="createKind === 'preset'">
        <div class="flex items-center justify-between gap-2"><h3 class="text-sm font-semibold">启用服务组</h3><HelpTip>自带域名规则，启用后可单独选择这些服务的出口。</HelpTip></div>
        <ul v-if="available.length" class="grid grid-cols-1 gap-2 sm:grid-cols-2"><li v-for="service in available" :key="service.id"><button class="btn btn-outline min-h-11 w-full justify-start border-base-content/10" :disabled="busy" @click="add(service.id, true)"><IconPlus :size="16" /><span>{{ service.name }}</span></button></li></ul>
        <p v-else class="py-6 text-center text-sm text-base-content/50">预置服务组均已启用</p>
      </section>
      <section v-else-if="createKind === 'custom'">
        <div class="flex items-center justify-between gap-2"><h3 class="text-sm font-semibold">自定义策略组</h3><HelpTip>创建后添加域名规则，指定哪些网站使用本组。初始出口跟随 Proxy。</HelpTip></div>
        <form class="flex flex-wrap gap-2" @submit.prevent="add(customName)">
          <input v-model="customName" class="input min-h-11 min-w-0 flex-1 basis-40" aria-label="自定义策略组名称" placeholder="组名" maxlength="80" :disabled="busy" required />
          <button class="btn btn-primary min-h-11" type="submit" :disabled="busy || !customName.trim() || !!customError"><IconPlus :size="16" /><span>创建并配置</span></button>
        </form>
        <p v-if="customError" role="alert" class="pt-2 text-xs text-error">{{ customError }}</p>
      </section>
      <section v-else>
        <div class="flex items-center justify-between gap-2"><h3 class="text-sm font-semibold">共享出口组</h3><HelpTip>供多个策略组共同引用；可选择具体节点、直连或拒绝。网站匹配规则在引用它的策略组中配置。</HelpTip></div>
        <form class="flex flex-wrap gap-2" @submit.prevent="addShared">
          <input v-model="sharedName" class="input min-h-11 min-w-0 flex-1 basis-40" aria-label="共享出口组名称" placeholder="组名" maxlength="80" :disabled="busy" required />
          <button class="btn btn-primary min-h-11" type="submit" :disabled="busy || !sharedName.trim() || !!sharedError"><IconLink :size="16" /><span>创建共享出口</span></button>
        </form>
        <p v-if="sharedError" role="alert" class="pt-2 text-xs text-error">{{ sharedError }}</p>
      </section>
      </template>
    </Modal>
    <Modal ref="deleteDialog" title="移除策略组" compact :fixed-height="false" :close-disabled="busy">
      <p class="text-sm">确定移除「{{ deleting }}」？该组的自定义规则和节点选择设置也会一并移除。</p>
      <p v-if="deleting && removalReason(deleting)" class="mt-2 text-sm text-error" role="alert">{{ removalReason(deleting) }}</p>
      <template #actions>
        <button type="button" class="btn btn-ghost btn-sm" :disabled="busy" @click="deleteDialog?.close()"><IconArrowLeft :size="16" /><span>取消</span></button>
        <button type="button" class="btn btn-error btn-sm" :disabled="busy || !deleting || !!removalReason(deleting)" @click="remove"><IconTrash :size="16" /><span>移除</span></button>
      </template>
    </Modal>
  </div>
</template>
