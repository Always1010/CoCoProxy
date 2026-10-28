<script setup lang="ts">
import { IconPlus, IconTrash, IconCheck, IconReload } from '@tabler/icons-vue'
import { useSiteSettings } from '~/composables/useSiteSettings'
import { CoCoProxyError, cocoproxyErrorMessage } from '~/composables/useCoCoProxy'

const props = withDefaults(defineProps<{ groupName?: string; scrollList?: boolean }>(), { scrollList: true })
const sites = useSiteSettings()
const { busy } = useWorkspace()
const selected = ref<string[]>([])
const search = ref('')
const adding = ref(false)
const name = ref('')
const url = ref('')
const error = ref('')
const feedback = ref('')
const loading = ref(false)
const loaded = ref(false)
const initialSelection = ref('[]')
const needsRead = ref(false)
const signature = (values: string[]) => JSON.stringify([...values].sort())
const selectionChanged = computed(() => loaded.value && signature(selected.value) !== initialSelection.value)
const formPending = computed(() => !!name.value.trim() || !!url.value.trim())
const dirty = computed(() => selectionChanged.value || formPending.value)
const saving = computed(() => sites.pending.value || loading.value)
const locked = computed(() => busy.value || saving.value)
defineExpose({ dirty, saving })
const domain = (value: string) => new URL(value).hostname
let disposed = false
const targets = computed(() => sites.data.value?.targets.filter(target => `${target.name} ${target.url}`.toLowerCase().includes(search.value.toLowerCase())) ?? [])
const categories = computed(() => [...new Set(targets.value.map(target => target.category))])
async function refresh(preserveDraft = true) {
  if (locked.value) return
  loading.value = true
  error.value = ''
  try {
    await sites.load()
    if (disposed) return
    const current = props.groupName ? [...sites.selectedIds(props.groupName)] : []
    initialSelection.value = signature(current)
    if (!preserveDraft) selected.value = current
    else if (needsRead.value && signature(selected.value) === initialSelection.value) feedback.value = '检测目标已保存'
    needsRead.value = false
    loaded.value = true
  }
  catch (cause) { if (!disposed) error.value = cocoproxyErrorMessage(cause) }
  finally { if (!disposed) loading.value = false }
}
async function persist(add = false, remove?: string) {
  if (locked.value || !loaded.value || needsRead.value) return
  if (props.groupName && !add && (!selectionChanged.value || formPending.value)) return
  error.value = ''; feedback.value = ''
  try {
    await sites.save({ ...(props.groupName ? { group: props.groupName, selected: [...selected.value] } : {}),
      ...(add ? { add: { name: name.value.trim(), url: url.value.trim() } } : {}), ...(remove ? { remove } : {}) })
    if (disposed) return
    if (props.groupName) selected.value = [...sites.selectedIds(props.groupName)]
    initialSelection.value = signature(selected.value)
    if (add) { name.value = ''; url.value = ''; adding.value = false }
    feedback.value = props.groupName ? '检测目标已保存' : '已保存到服务器'
  } catch (cause) {
    if (!disposed) {
      error.value = cocoproxyErrorMessage(cause)
      needsRead.value = cause instanceof CoCoProxyError && ['NETWORK_UNKNOWN', 'MANAGEMENT_UNAVAILABLE'].includes(cause.code)
    }
  }
}
watch(() => JSON.stringify([selected.value, name.value, url.value]), () => { error.value = '' })
onMounted(() => refresh(false))
watch(() => props.groupName, () => refresh(false))
onUnmounted(() => { disposed = true })
</script>

<template>
  <div class="flex min-w-0 flex-col gap-3" :class="{ 'min-h-0 flex-1': !scrollList }">
    <div class="space-y-3" :class="{ 'min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]': !scrollList }">
    <HelpTip>{{ groupName ? '选择本组检测目标，最多 16 项。站点由各组共用，在站点目录统一维护。' : '在此添加或删除共用站点，再到“组设置 → 站点连通”选择各组检测目标。' }}</HelpTip>
    <div class="flex flex-wrap gap-2"><input v-model="search" class="input input-sm min-w-0 flex-1" type="search" placeholder="搜索站点" aria-label="搜索站点" /><button v-if="!groupName" type="button" class="btn btn-outline btn-sm min-h-11" :disabled="locked" @click="adding = !adding"><IconPlus :size="16" /><span>{{ adding ? '收起添加' : '添加站点' }}</span></button></div>
    <form v-if="adding && !groupName" class="flex flex-col gap-2 rounded-lg border border-base-content/10 p-3" @submit.prevent="persist(true)">
      <label class="text-xs">站点名称<input v-model="name" :disabled="locked" required maxlength="80" class="input input-sm mt-1 w-full" /></label>
      <label class="text-xs">检测网址<input v-model="url" :disabled="locked" required type="url" maxlength="2048" placeholder="https://service.example/check" class="input input-sm mt-1 w-full" /></label>
      <p class="text-xs text-base-content/60">使用不含账号、查询参数和片段的公开 HTTPS 网址。添加后即可用于站点检测。</p>
      <button type="submit" class="btn btn-primary btn-sm min-h-11 self-end" :disabled="locked || !loaded || needsRead || !name.trim() || !url.trim()"><span v-if="sites.pending.value" class="loading loading-spinner loading-xs" /><IconPlus v-else :size="16" /><span>{{ sites.pending.value ? '正在保存…' : groupName ? '添加并选中' : '添加站点' }}</span></button>
    </form>
    <p v-if="loading" role="status" class="text-sm">正在读取站点目录…</p>
    <div v-else class="space-y-3" :class="{ 'max-h-[48vh] overflow-y-auto': scrollList }">
      <section v-for="category in categories" :key="category"><h3 class="mb-1 text-xs font-semibold text-base-content/65">{{ category }}</h3>
        <div v-for="target in targets.filter(item => item.category === category)" :key="target.id" class="flex min-w-0 items-center gap-2 border-b border-base-content/5 py-2">
          <label class="flex min-w-0 flex-1 items-center gap-2">
            <input v-if="groupName" v-model="selected" type="checkbox" class="checkbox checkbox-primary checkbox-sm shrink-0" :value="target.id" :disabled="locked || (!target.permitted && !selected.includes(target.id)) || (!selected.includes(target.id) && selected.length >= 16)" />
            <span class="min-w-0"><span class="block text-sm">{{ target.name }}</span><span class="block truncate text-xs text-base-content/50">{{ domain(target.url) }}</span></span>
          </label>
          <span v-if="!target.permitted" class="text-xs text-warning">站点检测已关闭</span><span v-else-if="!groupName" class="text-xs text-base-content/50">{{ target.builtin ? '内置' : '自定义' }}</span>
          <button v-if="!target.builtin && !groupName" type="button" class="btn btn-ghost btn-xs" :disabled="locked || needsRead" @click="persist(false, target.id)"><IconTrash :size="14" /><span>删除</span></button>
        </div>
      </section>
      <p v-if="!targets.length" class="text-xs text-base-content/55">没有匹配站点</p>
    </div>
    <p v-if="sites.data.value?.targets.some(target => !target.permitted)" class="text-xs text-base-content/55">部署已关闭全部检测，暂时不能新增选择；原有选择可以取消。</p>
    </div>
    <div class="flex shrink-0 flex-wrap items-center justify-between gap-3" :class="{ 'border-t border-base-content/10 pt-3': groupName }">
      <div class="min-w-0 flex-1 basis-40 text-sm" aria-live="polite">
        <p v-if="saving" role="status">{{ loading ? '正在读取检测目标…' : '正在保存检测目标…' }}</p>
        <p v-else-if="error || needsRead" role="alert" class="text-error">{{ error || '暂未确认检测目标是否保存，请重新读取状态后核对。' }}</p>
        <p v-else-if="formPending" class="text-warning">有未添加的站点，请完成添加或清空表单。</p>
        <p v-else-if="selectionChanged" class="text-warning">有未保存修改 · 已选 {{ selected.length }} 项</p>
        <p v-else-if="feedback" role="status" class="flex items-center gap-1 text-success"><IconCheck :size="16" class="shrink-0" />{{ feedback }}</p>
        <p v-else-if="groupName" class="text-base-content/65">已选 {{ selected.length }} 项</p>
      </div>
      <button v-if="needsRead || error" type="button" class="btn btn-outline min-h-11" :disabled="locked" @click="refresh()"><IconReload :size="16" /><span>重新读取状态</span></button>
      <button v-if="groupName" type="button" class="btn btn-primary min-h-11" :disabled="locked || !loaded || !selectionChanged || formPending || needsRead" @click="persist()"><span v-if="sites.pending.value" class="loading loading-spinner loading-xs" /><IconCheck v-else :size="16" /><span>{{ sites.pending.value ? '正在保存…' : feedback && !dirty ? '已保存' : '保存检测目标' }}</span></button>
    </div>
  </div>
</template>
