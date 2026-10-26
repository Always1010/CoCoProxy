<script setup lang="ts">
import { IconChevronDown, IconChevronUp, IconDeviceFloppy, IconPlus, IconTrash } from '@tabler/icons-vue'
import { ruleTarget } from '~/utils/group-rules'
useHead({ title: '规则 · CoCoProxy' })
const { view, workspace, overrides, busy, load, run, save, editOverrides } = useWorkspace()
const route = useRoute()
const tab = ref<'effective' | 'custom'>(route.query.tab === 'custom' ? 'custom' : 'effective')
const groupFilter = ref(typeof route.query.group === 'string' ? route.query.group : '')
const entries = ref<string[]>([])
const visibleEntries = computed(() => entries.value.map((value, index) => ({ value, index })).filter(entry => !groupFilter.value || ruleTarget(entry.value) === groupFilter.value))
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
    <WorkspaceToolbar :dirty="dirty"><template #actions><RuleTestPopover /></template></WorkspaceToolbar>
    <div role="tablist" class="tabs tabs-box w-fit shrink-0">
      <button role="tab" class="tab" :class="{ 'tab-active': tab === 'effective' }" :aria-selected="tab === 'effective'" @click="tab = 'effective'">生效规则</button>
      <button role="tab" class="tab" :class="{ 'tab-active': tab === 'custom' }" :aria-selected="tab === 'custom'" @click="tab = 'custom'">自定义规则<span v-if="entries.length" class="badge badge-sm ml-2">{{ entries.length }}</span></button>
    </div>
    <NativeRules v-if="tab === 'effective'" :key="view?.active ?? 'initial'" class="min-h-0 flex-1" />
    <div v-else class="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
      <label class="flex flex-wrap items-center gap-2 text-sm">按目标筛选<select v-model="groupFilter" class="select select-sm min-h-11" aria-label="按目标筛选规则"><option value="">全部目标</option><option v-for="value in [...new Set([...targets, groupFilter].filter(Boolean))]" :key="value" :value="value">{{ targetName(value) }}</option></select><span class="text-xs text-base-content/60">列表编号和移动操作沿用全部自定义规则的顺序</span></label>
      <div class="flex items-center justify-between gap-2 px-1"><span class="text-xs text-base-content/50">优先匹配 · {{ workspace?.mode === 'local' ? '本地规则' : '仅覆盖当前配置' }} · 保存即生效</span><button class="btn btn-ghost btn-sm" title="保存规则并立即生效" aria-label="保存规则" :disabled="!dirty || busy" @click="run(saveRules)"><IconDeviceFloppy :size="18" />保存</button></div>
      <template v-if="workspace">
        <form class="flex flex-wrap items-center gap-2 rounded-xl border border-base-content/10 bg-base-200/60 p-3" @submit.prevent="add">
          <select v-model="type" class="select select-sm w-44" aria-label="规则类型"><option v-for="value in ruleTypes" :key="value">{{ value }}</option></select>
          <input v-model="payload" class="input input-sm min-w-36 flex-1" aria-label="匹配内容" :placeholder="payloadHint" required />
          <select v-model="target" class="select select-sm max-w-52 flex-1" aria-label="目标策略"><option v-for="value in targets" :key="value" :value="value">{{ targetName(value) }}</option></select>
          <button class="btn btn-primary btn-sm" type="submit" title="添加规则" aria-label="添加规则" :disabled="busy"><IconPlus :size="18" />添加</button>
        </form>
        <div v-if="!entries.length" class="py-16 text-center text-sm text-base-content/45">暂无自定义规则</div>
        <div v-if="entries.length && !visibleEntries.length" class="py-8 text-center text-sm text-base-content/45">当前目标暂无自定义规则</div>
        <div v-for="{ index } in visibleEntries" :key="index" class="flex flex-wrap items-center gap-1 rounded-xl border border-base-content/8 bg-base-200/60 p-2">
          <span class="w-7 shrink-0 text-center text-xs text-base-content/35">{{ index + 1 }}</span>
          <input v-model="entries[index]" class="input input-ghost input-sm min-w-0 flex-1 font-mono text-xs" :aria-label="`规则 ${index + 1}`" :disabled="busy" spellcheck="false" />
          <div class="ml-auto flex items-center gap-1">
            <button class="btn btn-ghost btn-xs" title="上移" :aria-label="`上移规则 ${index + 1}`" :disabled="busy || index === 0" @click="move(index, -1)"><IconChevronUp :size="16" />上移</button>
            <button class="btn btn-ghost btn-xs" title="下移" :aria-label="`下移规则 ${index + 1}`" :disabled="busy || index === entries.length - 1" @click="move(index, 1)"><IconChevronDown :size="16" />下移</button>
            <button class="btn btn-ghost btn-xs text-error" title="删除" :aria-label="`删除规则 ${index + 1}`" :disabled="busy" @click="entries.splice(index, 1)"><IconTrash :size="16" />删除</button>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>
