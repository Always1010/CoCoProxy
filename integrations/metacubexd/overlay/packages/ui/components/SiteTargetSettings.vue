<script setup lang="ts">
import { IconPlus, IconTrash, IconCheck, IconReload } from '@tabler/icons-vue'
import { useSiteSettings } from '~/composables/useSiteSettings'
import { cocoproxyErrorMessage } from '~/composables/useCoCoProxy'

const props = defineProps<{ groupName?: string }>()
const sites = useSiteSettings()
const selected = ref<string[]>([])
const search = ref('')
const adding = ref(false)
const name = ref('')
const url = ref('')
const error = ref('')
const feedback = ref('')
const loading = ref(false)
const domain = (value: string) => new URL(value).hostname
let disposed = false
const targets = computed(() => sites.data.value?.targets.filter(target => `${target.name} ${target.url}`.toLowerCase().includes(search.value.toLowerCase())) ?? [])
const categories = computed(() => [...new Set(targets.value.map(target => target.category))])
async function refresh() {
  loading.value = true
  error.value = ''
  try { await sites.load(); if (!disposed) selected.value = props.groupName ? [...sites.selectedIds(props.groupName)] : [] }
  catch (cause) { if (!disposed) error.value = cocoproxyErrorMessage(cause) }
  finally { if (!disposed) loading.value = false }
}
async function persist(add = false, remove?: string) {
  error.value = ''; feedback.value = ''
  try {
    await sites.save({ ...(props.groupName ? { group: props.groupName, selected: [...selected.value] } : {}),
      ...(add ? { add: { name: name.value.trim(), url: url.value.trim() } } : {}), ...(remove ? { remove } : {}) })
    if (disposed) return
    if (props.groupName) selected.value = [...sites.selectedIds(props.groupName)]
    if (add) { name.value = ''; url.value = ''; adding.value = false }
    feedback.value = '已保存到服务器'
  } catch (cause) { if (!disposed) error.value = cocoproxyErrorMessage(cause) }
}
onMounted(refresh)
watch(() => props.groupName, refresh)
onUnmounted(() => { disposed = true })
</script>

<template>
  <div class="flex min-w-0 flex-col gap-3">
    <p class="text-xs text-base-content/65">{{ groupName ? '选择本组检测目标，保存到服务器，下次打开继续使用。最多选择 16 项。' : '所有策略组共用站点目录；在各组的“组设置 → 站点连通”选择检测目标。' }}</p>
    <div class="flex flex-wrap gap-2"><input v-model="search" class="input input-sm min-w-0 flex-1" type="search" placeholder="搜索站点" aria-label="搜索站点" /><button type="button" class="btn btn-outline btn-sm" :disabled="loading || sites.pending.value" @click="adding = !adding"><IconPlus :size="16" /><span>{{ adding ? '收起添加' : '添加站点' }}</span></button></div>
    <form v-if="adding" class="flex flex-col gap-2 rounded-lg border border-base-content/10 p-3" @submit.prevent="persist(true)">
      <label class="text-xs">站点名称<input v-model="name" required maxlength="80" class="input input-sm mt-1 w-full" /></label>
      <label class="text-xs">检测网址<input v-model="url" required type="url" maxlength="2048" placeholder="https://service.example/check" class="input input-sm mt-1 w-full" /></label>
      <p class="text-xs text-base-content/60">使用不含账号、查询参数和片段的公开 HTTPS 网址。已有部署来源限制仍然生效。</p>
      <button type="submit" class="btn btn-primary btn-sm self-end" :disabled="sites.pending.value || !name.trim() || !url.trim()"><IconPlus :size="16" /><span>{{ groupName ? '添加并选中' : '添加站点' }}</span></button>
    </form>
    <p v-if="loading" role="status" class="text-sm">正在读取站点目录…</p>
    <div v-else class="max-h-[48vh] space-y-3 overflow-y-auto">
      <section v-for="category in categories" :key="category"><h3 class="mb-1 text-xs font-semibold text-base-content/65">{{ category }}</h3>
        <div v-for="target in targets.filter(item => item.category === category)" :key="target.id" class="flex min-w-0 items-center gap-2 border-b border-base-content/5 py-2">
          <label class="flex min-w-0 flex-1 items-center gap-2">
            <input v-if="groupName" v-model="selected" type="checkbox" class="checkbox checkbox-primary checkbox-sm shrink-0" :value="target.id" :disabled="sites.pending.value || (!target.permitted && !selected.includes(target.id)) || (!selected.includes(target.id) && selected.length >= 16)" />
            <span class="min-w-0"><span class="block text-sm">{{ target.name }}</span><span class="block truncate text-xs text-base-content/50">{{ domain(target.url) }}</span></span>
          </label>
          <span v-if="!target.permitted" class="text-xs text-warning">部署限制此目标</span><span v-else-if="!groupName" class="text-xs text-base-content/50">{{ target.builtin ? '内置' : '自定义' }}</span>
          <button v-if="!target.builtin && !groupName" type="button" class="btn btn-ghost btn-xs" :disabled="sites.pending.value" @click="persist(false, target.id)"><IconTrash :size="14" /><span>删除</span></button>
        </div>
      </section>
      <p v-if="!targets.length" class="text-xs text-base-content/55">没有匹配站点</p>
    </div>
    <p v-if="sites.data.value?.targets.some(target => !target.permitted)" class="text-xs text-base-content/55">受限目标不能新选；请先调整部署的检测来源许可。原有受限选择可以取消。</p>
    <div v-if="error" role="alert" class="flex flex-wrap items-center gap-2 text-sm text-error"><span>{{ error }}</span><button type="button" class="btn btn-ghost btn-xs" :disabled="loading || sites.pending.value" @click="refresh"><IconReload :size="14" /><span>重新读取</span></button></div><p v-if="feedback" role="status" class="text-xs text-success">{{ feedback }}</p>
    <div v-if="groupName" class="flex items-center justify-between gap-2 border-t border-base-content/10 pt-2"><span class="text-xs text-base-content/65">已选 {{ selected.length }} 项</span><button type="button" class="btn btn-primary btn-sm" :disabled="loading || sites.pending.value" @click="persist()"><IconCheck :size="16" /><span>{{ sites.pending.value ? '正在保存…' : '保存' }}</span></button></div>
  </div>
</template>
