<script setup lang="ts">
import { IconList, IconPlus } from '@tabler/icons-vue'
import { ruleTarget } from '~/utils/group-rules'

const props = defineProps<{ groupName: string }>()
const emit = defineEmits<{ configure: [] }>()
const { view, workspace, overrides } = useWorkspace()
const shared = computed(() => view.value?.groups.find(group => group.name === props.groupName)?.role === 'shared')
const custom = computed(() => !shared.value && !view.value?.catalog?.some(service => service.id === props.groupName))
const count = computed(() => overrides.value.rules.filter(rule => ruleTarget(rule) === props.groupName).length)
</script>

<template>
  <div v-if="workspace?.mode === 'local'" class="space-y-1 text-xs" aria-label="策略组规则摘要">
    <div class="flex flex-wrap items-center gap-2">
      <span v-if="shared" class="text-base-content/60">共享出口：供普通策略组共同引用，统一切换节点。</span>
      <span v-else-if="groupName === 'Other'" class="text-base-content/60">最终兜底出口 · 自定义规则：{{ count }} 条</span>
      <span v-else-if="custom && !count" class="text-warning">尚未配置匹配规则，当前不会自动接收流量。</span>
      <span v-else class="text-base-content/60">{{ custom ? '' : '内置匹配规则 · ' }}自定义规则：{{ count }} 条</span>
      <button v-if="!shared" type="button" class="btn btn-ghost btn-sm min-h-11" @click="emit('configure')"><IconPlus v-if="custom && !count" :size="16" /><IconList v-else :size="16" /><span>{{ custom && !count ? '添加规则' : '管理规则' }}</span></button>
    </div>
    <p v-if="workspace.runMode !== 'rule'" class="text-warning">当前为{{ workspace.runMode === 'global' ? '全局' : '直连' }}模式，域名分流暂不参与匹配。</p>
    <p v-if="view?.pending" class="text-warning">设置尚未生效，当前仍使用原配置。</p>
  </div>
</template>
