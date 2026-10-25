<script setup lang="ts">
import { IconChevronDown, IconChevronUp, IconDeviceFloppy, IconPlus, IconTrash } from '@tabler/icons-vue'
useHead({ title: '规则 · Coproxy' })
const { view, workspace, overrides, busy, load, run, save, editOverrides } = useWorkspace()
const tab = ref<'effective' | 'custom'>('effective')
const entries = ref<string[]>([])
const dirty = computed(() => JSON.stringify(entries.value) !== JSON.stringify(overrides.value.rules))
const targets = computed(() => [...new Set(['DIRECT', 'REJECT', ...(view.value?.groups.map(group => group.name) ?? [])])])
const targetName = (name: string) => workspace.value?.mode === 'local' ? view.value?.catalog?.find(service => service.id === name)?.name ?? name : name
const type = ref('DOMAIN-SUFFIX')
const payload = ref('')
const target = ref('DIRECT')
const ruleTypes = ['DOMAIN', 'DOMAIN-SUFFIX', 'DOMAIN-KEYWORD', 'DOMAIN-REGEX', 'IP-CIDR', 'IP-CIDR6', 'SRC-IP-CIDR', 'SRC-IP-CIDR6', 'DST-PORT', 'SRC-PORT', 'NETWORK']
const payloadHint = computed(() => type.value.includes('CIDR') ? (type.value.endsWith('6') ? '2001:db8::/32' : '192.0.2.0/24') : type.value.endsWith('PORT') ? '443' : type.value === 'NETWORK' ? 'tcp / udp' : 'example.com')

watch(() => workspace.value?.revision, () => { entries.value = [...overrides.value.rules] }, { immediate: true })

function add() {
  if (!payload.value.trim()) return
  entries.value.push(`${type.value},${payload.value.trim()},${target.value}`)
  payload.value = ''
}

function move(index: number, offset: number) {
  const next = index + offset
  if (next < 0 || next >= entries.value.length) return
  const entry = entries.value.splice(index, 1)[0]!
  entries.value.splice(next, 0, entry)
}

async function saveRules() {
  if (!dirty.value) return
  await save(settings => { editOverrides(settings).rules = entries.value.map(value => value.trim()).filter(Boolean) })
}

onMounted(() => run(load))
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col gap-3">
    <WorkspaceToolbar :dirty="dirty" :before-apply="saveRules" />
    <div role="tablist" class="tabs tabs-box w-fit shrink-0">
      <button role="tab" class="tab" :class="{ 'tab-active': tab === 'effective' }" :aria-selected="tab === 'effective'" @click="tab = 'effective'">生效规则</button>
      <button role="tab" class="tab" :class="{ 'tab-active': tab === 'custom' }" :aria-selected="tab === 'custom'" @click="tab = 'custom'">自定义规则<span v-if="entries.length" class="badge badge-sm ml-2">{{ entries.length }}</span></button>
    </div>
    <NativeRules v-if="tab === 'effective'" :key="view?.active ?? 'initial'" class="min-h-0 flex-1" />
    <div v-else class="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
      <div class="flex items-center justify-between gap-2 px-1"><span class="text-xs text-base-content/50">优先匹配 · {{ workspace?.mode === 'local' ? '本地规则' : '仅覆盖当前配置' }}</span><button class="btn btn-ghost btn-square btn-sm" title="保存规则" aria-label="保存规则" :disabled="!dirty || busy" @click="run(saveRules)"><IconDeviceFloppy :size="18" /></button></div>
      <template v-if="workspace">
        <form class="flex flex-wrap items-center gap-2 rounded-xl border border-base-content/10 bg-base-200/60 p-3" @submit.prevent="add">
          <select v-model="type" class="select select-sm w-44" aria-label="规则类型"><option v-for="value in ruleTypes" :key="value">{{ value }}</option></select>
          <input v-model="payload" class="input input-sm min-w-36 flex-1" aria-label="匹配内容" :placeholder="payloadHint" required />
          <select v-model="target" class="select select-sm max-w-52 flex-1" aria-label="目标策略"><option v-for="value in targets" :key="value" :value="value">{{ targetName(value) }}</option></select>
          <button class="btn btn-primary btn-square btn-sm" type="submit" title="添加规则" aria-label="添加规则" :disabled="busy"><IconPlus :size="18" /></button>
        </form>
        <div v-if="!entries.length" class="py-16 text-center text-sm text-base-content/45">暂无自定义规则</div>
        <div v-for="(entry, index) in entries" :key="index" class="flex items-center gap-1 rounded-xl border border-base-content/8 bg-base-200/60 p-2">
          <span class="w-7 shrink-0 text-center text-xs text-base-content/35">{{ index + 1 }}</span>
          <input v-model="entries[index]" class="input input-ghost input-sm min-w-0 flex-1 font-mono text-xs" :aria-label="`规则 ${index + 1}`" :disabled="busy" spellcheck="false" />
          <button class="btn btn-ghost btn-square btn-xs" title="上移" :aria-label="`上移规则 ${index + 1}`" :disabled="busy || index === 0" @click="move(index, -1)"><IconChevronUp :size="16" /></button>
          <button class="btn btn-ghost btn-square btn-xs" title="下移" :aria-label="`下移规则 ${index + 1}`" :disabled="busy || index === entries.length - 1" @click="move(index, 1)"><IconChevronDown :size="16" /></button>
          <button class="btn btn-ghost btn-square btn-xs text-error" title="删除" :aria-label="`删除规则 ${index + 1}`" :disabled="busy" @click="entries.splice(index, 1)"><IconTrash :size="16" /></button>
        </div>
      </template>
    </div>
  </div>
</template>
