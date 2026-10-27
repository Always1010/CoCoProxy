<script setup lang="ts">
import { IconCheck, IconDownload, IconEdit, IconPlus, IconRefresh, IconTrash, IconX } from '@tabler/icons-vue'
import type { WorkspaceSource } from '~/composables/useWorkspace'
import { CoCoProxyError } from '~/composables/useCoCoProxy'

useHead({ title: '订阅 · CoCoProxy' })
const { api, view, workspace, busy, error, load, run, save } = useWorkspace()
const editorOpen = ref(false)
const editorModal = ref<{ open: () => void; close: () => void }>()
const deleteModal = ref<{ open: () => void; close: () => void }>()
const editing = ref<WorkspaceSource | null>(null)
const name = ref('')
const url = ref('')
let editorRequest = 0
const deleting = ref<WorkspaceSource | null>(null)
const sourcePath = (id: string) => `/api/cocoproxy/sources/${encodeURIComponent(id)}`
const selected = (source: WorkspaceSource) => workspace.value?.mode === 'subscription'
  ? workspace.value.subscriptionId === source.id
  : workspace.value?.sourceIds.includes(source.id)
const replacement = (source: WorkspaceSource) => view.value?.sources.find(item =>
  item.id !== source.id && item.snapshotCurrent && (workspace.value?.mode !== 'subscription' || item.kind === 'profile'))
  ?? view.value?.sources.find(item => item.id !== source.id && item.snapshotCurrent)
const canRemove = (source: WorkspaceSource) => !selected(source) || !!replacement(source)
const formatBytes = (bytes: number) => {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), 4)
  return `${(bytes / 1024 ** unit).toFixed(unit ? 1 : 0)} ${['B', 'KB', 'MB', 'GB', 'TB'][unit]}`
}
const updated = (value: string | null) => value
  ? new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value))
  : '尚未更新'

function closeEditor() {
  editorRequest++
  editorOpen.value = false
  editing.value = null
  name.value = ''
  url.value = ''
}

async function openEditor(source: WorkspaceSource | null = null) {
  closeEditor()
  const request = editorRequest
  await run(async () => {
    if (source) {
      const { source: { url: currentUrl, ...current } } = await api.request<{ source: WorkspaceSource & { url: string } }>(`${sourcePath(source.id)}/edit`)
      if (request !== editorRequest) return
      editing.value = current
      name.value = current.name || current.host || ''
      url.value = currentUrl
    }
    editorOpen.value = true
  })
}

async function submit() {
  const source = editing.value
  const id = source?.id ?? `sub-${crypto.randomUUID().replaceAll('-', '')}`
  const hadCurrent = workspace.value?.mode === 'subscription'
    ? !!workspace.value.subscriptionId
    : !!view.value?.sources.some(source => source.snapshotCurrent && workspace.value?.sourceIds.includes(source.id))
  await run(async () => {
    await api.request(sourcePath(id), {
      method: 'PUT', body: { expectedRevision: source?.revision ?? 0, ...(name.value.trim() ? { name: name.value.trim() } : {}), url: url.value.trim() },
    })
    closeEditor()
    await load()
    if (!source) {
      const created = view.value?.sources.find(item => item.id === id)
      if (created) {
        await api.request(`${sourcePath(id)}/refresh`, { method: 'POST', body: { expectedRevision: created.revision } })
        await load()
        if (!hadCurrent)
          await save(settings => { settings.mode = 'local'; settings.sourceIds = [id] }, '订阅已启用')
      }
    }
  })
}

async function refresh(source: WorkspaceSource) {
  await run(async () => {
    try {
      const refreshed = await api.request<WorkspaceSource>(`${sourcePath(source.id)}/refresh`, { method: 'POST', body: { expectedRevision: source.revision } })
      if (selected(source) && (refreshed.snapshotDigest !== source.snapshotDigest || view.value?.pending))
        await save(() => {}, '订阅已更新并生效')
    } finally { await load() }
  })
}

async function choose(source: WorkspaceSource) {
  if (selected(source) && (workspace.value?.mode === 'subscription' || workspace.value?.sourceIds.length === 1)) return
  await run(() => save(settings => {
    if (settings.mode === 'subscription') settings.subscriptionId = source.id
    else {
      settings.mode = 'local'
      settings.sourceIds = [source.id]
    }
  }, `已切换到订阅：${source.name || source.host}`))
}

async function remove() {
  const source = deleting.value
  if (!source) return
  if (!canRemove(source)) return
  await run(async () => {
    if (workspace.value?.sourceIds.includes(source.id) || workspace.value?.subscriptionId === source.id) {
      const next = replacement(source)!
      await save(settings => {
        settings.sourceIds = [next.id]
        if (settings.subscriptionId === source.id) {
          settings.subscriptionId = next.kind === 'profile' ? next.id : null
          settings.mode = next.kind === 'profile' ? 'subscription' : 'local'
        }
      })
    }
    await api.request(sourcePath(source.id), { method: 'DELETE', body: { expectedRevision: source.revision } })
    deleting.value = null
    await load()
  })
}

watch(editorOpen, open => { if (open) editorModal.value?.open(); else editorModal.value?.close() }, { flush: 'post' })
watch(deleting, source => { if (source) deleteModal.value?.open(); else deleteModal.value?.close() }, { flush: 'post' })
onMounted(() => run(load))
onUnmounted(closeEditor)
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
    <div class="flex items-center justify-between gap-3">
      <h1 class="text-xl font-semibold">订阅</h1>
      <button class="btn btn-primary btn-sm" :disabled="busy" @click="openEditor()"><IconPlus :size="18" />导入订阅</button>
    </div>
    <WorkspaceToolbar />
    <div v-if="!view" class="flex flex-1 items-center justify-center"><span class="loading loading-spinner text-primary" /></div>
    <div v-else-if="!view.sources.length" class="flex flex-1 flex-col items-center justify-center gap-4 py-20 text-base-content/50">
      <IconDownload :size="44" class="opacity-40" />
      <span>暂无订阅</span>
      <button class="btn btn-outline btn-sm" @click="openEditor()">导入订阅</button>
    </div>
    <div v-else role="radiogroup" aria-label="当前订阅" class="grid grid-cols-1 items-start gap-3 xl:grid-cols-2 2xl:grid-cols-3">
      <article v-for="source in view.sources" :key="source.id" class="card relative border transition-colors" :class="selected(source) ? 'border-primary bg-primary/8 ring-1 ring-primary/25' : 'border-base-content/10 bg-base-200/60 hover:border-primary/40'">
        <button type="button" role="radio" class="absolute inset-0 rounded-[inherit] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary" :aria-label="`切换到 ${source.name || source.host}`" :aria-checked="selected(source)" :aria-disabled="selected(source) || undefined" :disabled="busy || (!source.snapshotCurrent && !selected(source)) || (workspace?.mode === 'subscription' && source.kind !== 'profile')" @click="choose(source)" />
        <div class="card-body pointer-events-none relative gap-3 p-4">
          <div class="flex items-start gap-3">
            <span class="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border" :class="selected(source) ? 'border-primary bg-primary text-primary-content' : 'border-base-content/20'"><IconCheck v-if="selected(source)" :size="15" /></span>
            <div class="min-w-0 flex-1">
              <h2 class="truncate font-semibold">{{ source.name || source.host || '未命名订阅' }}</h2>
              <div class="mt-1 truncate text-xs text-base-content/50">{{ source.host }}</div>
            </div>
            <span class="badge badge-ghost badge-sm shrink-0">{{ source.kind === 'profile' ? '配置' : '节点' }}</span>
          </div>
          <div class="flex items-center justify-between gap-2 text-xs text-base-content/60">
            <span>{{ source.nodeCount ?? 0 }} 个节点</span>
            <span>{{ updated(source.lastAttempt) }}</span>
          </div>
          <template v-if="source.usage && source.usage.total > 0">
            <progress class="progress progress-primary h-1.5 w-full" :value="(source.usage.upload ?? 0) + (source.usage.download ?? 0)" :max="source.usage.total" />
            <div class="flex items-center justify-between text-xs text-base-content/60"><span>{{ formatBytes((source.usage.upload ?? 0) + (source.usage.download ?? 0)) }} / {{ formatBytes(source.usage.total) }}</span><span v-if="source.usage.expire">{{ new Date(source.usage.expire * 1000).toLocaleDateString() }} 到期</span></div>
          </template>
          <div v-if="source.lastError" class="text-xs text-error" role="status">{{ new CoCoProxyError(source.lastError).message }}</div>
          <div v-else-if="!source.snapshotCurrent" class="text-xs text-warning">需要更新</div>
          <span v-if="source.unsupportedFields?.length" class="badge badge-warning badge-sm" :title="source.unsupportedFields.join('、')" tabindex="0">部分字段未采用</span>
          <div class="pointer-events-auto relative z-10 flex items-center justify-end gap-1 border-t border-base-content/8 pt-2">
            <button class="btn btn-ghost btn-sm" title="更新订阅" :aria-label="`更新 ${source.name || source.host}`" :disabled="busy" @click="refresh(source)"><IconRefresh :size="18" />更新</button>
            <button class="btn btn-ghost btn-sm" title="编辑订阅" :aria-label="`编辑 ${source.name || source.host}`" :disabled="busy" @click="openEditor(source)"><IconEdit :size="18" />编辑</button>
            <button class="btn btn-ghost btn-sm text-error" :title="canRemove(source) ? '删除订阅' : '请先导入另一个可用订阅，至少保留一个当前订阅'" :aria-label="`删除 ${source.name || source.host}`" :disabled="busy || !canRemove(source)" @click="deleting = source"><IconTrash :size="18" />删除</button>
          </div>
        </div>
      </article>
    </div>

    <Modal ref="editorModal" :title="editing ? '编辑订阅' : '导入订阅'" @close="closeEditor">
      <form id="subscription-editor-form" class="space-y-4" @submit.prevent="submit">
        <label class="fieldset"><span class="fieldset-legend">名称</span><input v-model="name" class="input w-full" placeholder="订阅名称" maxlength="128" /></label>
        <label class="fieldset"><span class="fieldset-legend">订阅地址</span><input v-model="url" class="input w-full" type="url" required placeholder="https://…" autocomplete="off" spellcheck="false" /></label>
        <div v-if="error" role="alert" class="text-sm text-error">{{ error }}</div>
      </form>
      <template #actions><button class="btn btn-primary min-h-11" form="subscription-editor-form" type="submit" :disabled="busy"><IconCheck v-if="editing" :size="18" /><IconDownload v-else :size="18" /><span>{{ editing ? '保存' : '导入' }}</span></button></template>
    </Modal>
    <Modal ref="deleteModal" title="删除订阅" @close="deleting = null">
      <p v-if="deleting" class="break-all">删除 {{ deleting.name || deleting.host }}？</p>
      <p v-if="error" role="alert" class="mt-3 text-sm text-error">{{ error }}</p>
      <template #actions><button class="btn btn-ghost min-h-11" :disabled="busy" @click="deleting = null"><IconX :size="18" /><span>取消</span></button><button class="btn btn-error min-h-11" :disabled="busy || !deleting" @click="remove"><IconTrash :size="18" /><span>删除</span></button></template>
    </Modal>
  </div>
</template>
