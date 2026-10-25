<script setup lang="ts">
import { IconCheck, IconDownload, IconEdit, IconPlus, IconRefresh, IconTrash, IconX } from '@tabler/icons-vue'
import type { WorkspaceSource } from '~/composables/useWorkspace'
import { CoproxyError } from '~/composables/useCoproxy'

useHead({ title: '订阅 · Coproxy' })
const { api, view, workspace, busy, error, load, run, save } = useWorkspace()
const editorOpen = ref(false)
const editing = ref<WorkspaceSource | null>(null)
const name = ref('')
const url = ref('')
const deleting = ref<WorkspaceSource | null>(null)
const sourcePath = (id: string) => `/api/coproxy/sources/${encodeURIComponent(id)}`
const selected = (source: WorkspaceSource) => workspace.value?.mode === 'subscription'
  ? workspace.value.subscriptionId === source.id
  : workspace.value?.sourceIds.includes(source.id)
const formatBytes = (bytes: number) => {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), 4)
  return `${(bytes / 1024 ** unit).toFixed(unit ? 1 : 0)} ${['B', 'KB', 'MB', 'GB', 'TB'][unit]}`
}
const updated = (value: string | null) => value
  ? new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value))
  : '尚未更新'

function openEditor(source: WorkspaceSource | null = null) {
  editing.value = source
  name.value = source?.name ?? ''
  url.value = ''
  editorOpen.value = true
}

async function submit() {
  const source = editing.value
  const id = source?.id ?? `sub-${crypto.randomUUID().replaceAll('-', '')}`
  await run(async () => {
    await api.request(sourcePath(id), {
      method: 'PUT', body: { expectedRevision: source?.revision ?? 0, name: name.value.trim(), ...(url.value.trim() ? { url: url.value.trim() } : {}) },
    })
    // Clear the address before the next network request; the service owns it now.
    url.value = ''
    editorOpen.value = false
    await load()
    if (!source) {
      const created = view.value?.sources.find(item => item.id === id)
      if (created) {
        await api.request(`${sourcePath(id)}/refresh`, { method: 'POST', body: { expectedRevision: created.revision } })
        await load()
      }
    }
  })
}

async function refresh(source: WorkspaceSource) {
  await run(async () => {
    try {
      await api.request(`${sourcePath(source.id)}/refresh`, { method: 'POST', body: { expectedRevision: source.revision } })
    } finally { await load() }
  })
}

async function choose(source: WorkspaceSource) {
  await run(() => save(settings => {
    if (settings.mode === 'subscription') settings.subscriptionId = source.id
    else {
      settings.mode = 'local'
      settings.sourceIds = settings.sourceIds.includes(source.id)
        ? settings.sourceIds.filter(id => id !== source.id)
        : [...settings.sourceIds, source.id]
    }
  }))
}

async function remove() {
  const source = deleting.value
  if (!source) return
  await run(async () => {
    await api.request(sourcePath(source.id), { method: 'DELETE', body: { expectedRevision: source.revision } })
    deleting.value = null
    await load()
  })
}

onMounted(() => run(load))
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
    <div v-else class="grid grid-cols-1 items-start gap-3 xl:grid-cols-2 2xl:grid-cols-3">
      <article v-for="source in view.sources" :key="source.id" class="card border bg-base-200/60" :class="selected(source) ? 'border-primary/40' : 'border-base-content/10'">
        <div class="card-body gap-3 p-4">
          <div class="flex items-start gap-3">
            <button class="btn btn-xs shrink-0" :class="selected(source) ? 'btn-primary' : 'btn-ghost'" :title="workspace?.mode === 'subscription' ? '使用此订阅配置' : '用于本地规则模板'" :aria-label="`选择 ${source.name || source.host}`" :aria-pressed="selected(source)" :disabled="busy || (!source.snapshotCurrent && !selected(source)) || (workspace?.mode === 'subscription' && source.kind !== 'profile')" @click="choose(source)"><IconCheck v-if="selected(source)" :size="14" />{{ selected(source) ? '已选' : '选用' }}</button>
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
          <div v-if="source.lastError" class="text-xs text-error" role="status">{{ new CoproxyError(source.lastError).message }}</div>
          <div v-else-if="!source.snapshotCurrent" class="text-xs text-warning">需要更新</div>
          <span v-if="source.unsupportedFields?.length" class="badge badge-warning badge-sm" :title="source.unsupportedFields.join('、')" tabindex="0">部分字段未采用</span>
          <div class="flex items-center justify-end gap-1 border-t border-base-content/8 pt-2">
            <button class="btn btn-ghost btn-sm" title="更新订阅" :aria-label="`更新 ${source.name || source.host}`" :disabled="busy" @click="refresh(source)"><IconRefresh :size="18" />更新</button>
            <button class="btn btn-ghost btn-sm" title="编辑订阅" :aria-label="`编辑 ${source.name || source.host}`" :disabled="busy" @click="openEditor(source)"><IconEdit :size="18" />编辑</button>
            <button class="btn btn-ghost btn-sm text-error" title="删除订阅" :aria-label="`删除 ${source.name || source.host}`" :disabled="busy" @click="deleting = source"><IconTrash :size="18" />删除</button>
          </div>
        </div>
      </article>
    </div>

    <dialog v-if="editorOpen" open class="modal modal-open" aria-labelledby="subscription-editor-title" @keydown.esc="editorOpen = false">
      <form class="modal-box max-w-md space-y-4" @submit.prevent="submit">
        <div class="flex items-center justify-between"><h2 id="subscription-editor-title" class="text-lg font-semibold">{{ editing ? '编辑订阅' : '导入订阅' }}</h2><button type="button" class="btn btn-ghost btn-square btn-sm" title="关闭" aria-label="关闭" @click="editorOpen = false"><IconX :size="18" /></button></div>
        <label class="fieldset"><span class="fieldset-legend">名称</span><input v-model="name" class="input w-full" placeholder="订阅名称" maxlength="80" /></label>
        <label class="fieldset"><span class="fieldset-legend">{{ editing ? '替换订阅地址' : '订阅地址' }}</span><input v-model="url" class="input w-full" type="url" :required="!editing" :placeholder="editing ? '留空保留原地址' : 'https://…'" autocomplete="off" spellcheck="false" /></label>
        <div v-if="error" role="alert" class="text-sm text-error">{{ error }}</div>
        <div class="modal-action"><button class="btn btn-primary btn-sm" type="submit" :disabled="busy">{{ editing ? '保存' : '导入' }}</button></div>
      </form>
      <form method="dialog" class="modal-backdrop" @submit.prevent="editorOpen = false"><button>关闭</button></form>
    </dialog>
    <dialog v-if="deleting" open class="modal modal-open" aria-labelledby="subscription-delete-title" @keydown.esc="deleting = null">
      <div class="modal-box max-w-sm"><h2 id="subscription-delete-title" class="font-semibold">删除 {{ deleting.name || deleting.host }}？</h2><div class="modal-action"><button class="btn btn-ghost btn-sm" :disabled="busy" @click="deleting = null">取消</button><button class="btn btn-error btn-sm" :disabled="busy" @click="remove">删除</button></div></div>
    </dialog>
  </div>
</template>
