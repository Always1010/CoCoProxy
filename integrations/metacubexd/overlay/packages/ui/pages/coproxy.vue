<script setup lang="ts">
import { IconDeviceFloppy, IconLogout, IconPencil, IconRefresh, IconServerCog } from '@tabler/icons-vue'
import type { CoproxyCapture, CoproxyDraft, CoproxySource, CoproxyStatus } from '~/composables/useCoproxy'
import { CoproxyError, coproxyErrorMessage, useCoproxy } from '~/composables/useCoproxy'

useHead({ title: '策略与订阅 · Coproxy' })
const api = useCoproxy()
const { session, capture } = api
const status = ref<CoproxyStatus | null>(null)
const sources = ref<CoproxySource[]>([])
const selected = ref<string[]>([])
const policyText = ref('')
const savedText = ref('')
const draftRevision = ref(0)
const draftLoaded = ref(false)
const sourcesLoaded = ref(false)
const busy = ref('')
const error = ref('')
const notice = ref('')
const sourceId = ref('')
const sourceUrl = ref('')
const sourceRevision = ref(0)
const dirty = computed(() => policyText.value !== savedText.value)
const samplePolicy = { mode: 'rule', proxies: [], 'proxy-groups': [], rules: ['MATCH,REJECT'] }
const short = (value: string | null | undefined) => value ? value.slice(0, 12) : '无'
const sourcePath = (id: string) => `/api/coproxy/sources/${encodeURIComponent(id)}`
const selectedSources = computed(() => sources.value.filter(source => selected.value.includes(source.id)))
const captureOutdated = computed(() => {
  const receipt = capture.value
  if (!receipt) return false
  if (dirty.value || draftRevision.value !== receipt.stagedRevision) return true
  if (selectedSources.value.length !== receipt.sources.length) return true
  return receipt.sources.some(item => {
    const current = selectedSources.value.find(source => source.id === item.id)
    return !current || current.revision !== item.expectedRevision || !current.snapshotCurrent
  })
})

async function run(name: string, action: () => Promise<void>) {
  if (busy.value) return
  busy.value = name
  error.value = ''
  notice.value = ''
  try { await action() }
  catch (cause) { error.value = coproxyErrorMessage(cause) }
  finally { busy.value = '' }
}

async function readStatus() { status.value = await api.readStatus() }

async function refreshOverview() {
  await Promise.all([readStatus(), readSources()])
}

async function readSources() {
  const result = await api.request<{ sources: CoproxySource[] }>('/api/coproxy/sources')
  sources.value = result.sources
  sourcesLoaded.value = true
  selected.value = selected.value.filter(id => result.sources.some(source => source.id === id))
}

async function readDraft() {
  const { draft } = await api.request<{ draft: CoproxyDraft | null }>('/api/coproxy/draft')
  draftRevision.value = draft?.revision ?? 0
  policyText.value = JSON.stringify(draft?.policy ?? samplePolicy, null, 2)
  savedText.value = policyText.value
  draftLoaded.value = true
}

async function saveDraft() {
  let policy: unknown
  try { policy = JSON.parse(policyText.value) }
  catch { throw new CoproxyError('INVALID_JSON') }
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) throw new CoproxyError('INVALID_JSON')
  const result = await api.request<Omit<CoproxyDraft, 'policy'>>('/api/coproxy/draft', {
    method: 'PUT', body: { expectedRevision: draftRevision.value, policy },
  })
  draftRevision.value = result.revision
  savedText.value = policyText.value
  notice.value = `已保存草稿版本 ${result.revision}。尚未捕获或应用。`
  await readStatus()
}

async function stage() {
  if (dirty.value || !draftRevision.value || !sourcesLoaded.value) return
  const requested = selectedSources.value.map(source => ({ id: source.id, expectedRevision: source.revision }))
  capture.value = await api.request<CoproxyCapture>('/api/coproxy/stage', {
    method: 'POST', body: { expectedRevision: draftRevision.value, sources: requested },
  })
  notice.value = '候选已捕获；核心尚未切换。请核对下方回执再应用。'
  await readStatus()
}

async function apply() {
  if (!capture.value || !status.value) return
  const generation = capture.value.generation
  const expectedActive = status.value.active
  await api.request('/api/coproxy/apply', { method: 'POST', body: { generation, expectedActive } })
  notice.value = `候选 ${short(generation)} 的应用事务已完成。`
  await readStatus()
}

async function recover() {
  await api.request('/api/coproxy/recover', { method: 'POST', body: {} })
  notice.value = '恢复操作已完成，请核对当前状态。'
  await readStatus()
}

function editSource(source: CoproxySource) {
  sourceId.value = source.id
  sourceRevision.value = source.revision
  sourceUrl.value = ''
}

function sourceIdChanged() {
  sourceRevision.value = sources.value.find(source => source.id === sourceId.value)?.revision ?? 0
}

async function configureSource() {
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(sourceId.value)) throw new CoproxyError('INVALID_SOURCE_ID')
  const result = await api.request<CoproxySource>(sourcePath(sourceId.value), {
    method: 'PUT', body: { expectedRevision: sourceRevision.value, url: sourceUrl.value },
  })
  sourceRevision.value = result.revision
  sourceUrl.value = ''
  notice.value = '来源地址已保存。请单独刷新以取得快照；当前运行配置未改变。'
  await readSources()
}

async function refreshSource(source: CoproxySource) {
  try {
    await api.request<CoproxySource>(`${sourcePath(source.id)}/refresh`, {
      method: 'POST', body: { expectedRevision: source.revision },
    })
  } catch (cause) {
    // Failed refreshes may still record a new source revision and keep an old snapshot.
    try { await readSources() } catch { /* Keep the original fixed error. */ }
    throw cause
  }
  await readSources()
  notice.value = `来源 ${source.id} 的刷新已完成，尚未捕获或应用。`
}

onMounted(() => run('load', async () => {
  await Promise.all([readStatus(), readDraft(), readSources()])
  // Restore only the selected IDs from the in-memory capture, never credentials.
  if (capture.value) selected.value = capture.value.sources.map(source => source.id)
}))
</script>

<template>
  <main class="mx-auto flex w-full max-w-6xl flex-col gap-6 overflow-y-auto p-4 sm:p-6">
    <header class="flex items-center justify-between gap-4">
      <div class="flex items-center gap-3">
        <IconServerCog :size="28" class="text-primary" aria-hidden="true" />
        <div><h1 class="text-xl font-semibold">策略与订阅</h1><p class="text-sm text-base-content/60">Coproxy · {{ session?.username }}</p></div>
      </div>
      <div class="flex gap-2">
        <button class="btn btn-ghost btn-square" title="重新读取状态与来源（保留编辑文本）" aria-label="重新读取状态与来源，保留编辑文本" :disabled="!!busy" @click="run('refresh', refreshOverview)"><IconRefresh :size="20" /></button>
        <button class="btn btn-ghost btn-square" title="注销" aria-label="注销" :disabled="!!busy" @click="run('logout', api.logout)"><IconLogout :size="20" /></button>
      </div>
    </header>

    <p v-if="error" role="alert" class="rounded-box border border-error/30 bg-error/10 p-4 text-sm text-error">{{ error }}</p>
    <p v-if="notice" role="status" class="rounded-box border border-info/25 bg-info/10 p-4 text-sm">{{ notice }}</p>
    <p v-if="busy" class="flex items-center gap-2 text-sm text-base-content/65" role="status"><span class="loading loading-spinner loading-xs" />正在处理，请等待服务返回…</p>

    <section class="grid gap-3 sm:grid-cols-3" aria-label="运行状态">
      <div class="rounded-box border border-base-content/10 bg-base-200 p-4">
        <h2 class="mb-2 text-sm text-base-content/60">事务状态</h2>
        <p class="font-medium">{{ !status ? '尚未读取' : status.transaction ? `进行中 · ${status.transaction.phase}` : status.fault ? '存在故障' : '无未完成事务' }}</p>
        <dl class="mt-3 space-y-1 text-xs"><div><dt class="inline">已记录 active：</dt><dd class="inline font-mono" :title="status?.active ?? ''">{{ short(status?.active) }}</dd></div><div><dt class="inline">期望代次：</dt><dd class="inline font-mono" :title="status?.desired ?? ''">{{ short(status?.desired) }}</dd></div></dl>
        <p class="mt-2 text-xs text-base-content/55">持久化 active 记录不等于当前健康。</p>
        <button v-if="status?.transaction || status?.fault" class="btn btn-sm btn-warning mt-3" :disabled="!!busy" @click="run('recover', recover)">恢复未完成事务</button>
      </div>
      <div class="rounded-box border border-base-content/10 bg-base-200 p-4">
        <h2 class="mb-2 text-sm text-base-content/60">核心观察</h2>
        <p class="font-medium" :class="status?.core?.ready ? 'text-success' : 'text-warning'">{{ !status ? '尚未读取' : !status.core ? '尚无可观察代次' : status.core.ready ? '核心已就绪' : '核心未就绪' }}</p>
        <p v-if="status?.core" class="mt-3 text-xs text-base-content/60">检查时间：{{ status.core.checkedAt }}</p>
        <p class="mt-2 text-xs text-base-content/55">仅反映核心，不代表网关或终端流量可用。</p>
      </div>
      <div class="rounded-box border border-base-content/10 bg-base-200 p-4">
        <h2 class="mb-2 text-sm text-base-content/60">网关状态</h2>
        <p class="font-medium text-warning">{{ status ? '尚未实现' : '尚未读取' }}</p>
        <p class="mt-3 text-xs text-base-content/55">网关接管与真实流量验收尚未提供，不能据此判断整条链路健康。</p>
      </div>
    </section>

    <section class="rounded-box border border-base-content/10 bg-base-200 p-4 sm:p-5">
      <div class="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div><h2 class="font-semibold">策略草稿 <span class="badge badge-ghost ml-2">版本 {{ draftRevision }}</span></h2><p class="mt-1 text-xs text-base-content/60">保存只更新草稿；捕获生成不可变候选；应用才切换核心。</p></div>
        <div class="flex items-center gap-2">
          <span v-if="dirty" class="text-xs text-warning">有未保存编辑</span>
          <button class="btn btn-ghost btn-square btn-sm" title="重新加载草稿，替换当前编辑文本" aria-label="重新加载草稿，替换当前编辑文本" :disabled="!!busy" @click="run('reload-draft', readDraft)"><IconRefresh :size="18" /></button>
          <button class="btn btn-primary btn-sm" :disabled="!!busy || !draftLoaded" @click="run('save', saveDraft)"><IconDeviceFloppy :size="18" aria-hidden="true" />保存草稿</button>
        </div>
      </div>
      <details open>
        <summary class="mb-3 cursor-pointer text-sm">高级编辑 · policy JSON</summary>
        <label class="sr-only" for="coproxy-policy">策略 JSON</label>
        <textarea id="coproxy-policy" v-model="policyText" class="textarea textarea-bordered min-h-72 w-full font-mono text-xs leading-relaxed" spellcheck="false" autocomplete="off" :disabled="!!busy || !draftLoaded" />
        <p class="mt-2 text-xs text-base-content/55">仅接受策略 JSON 对象；部署监听、核心密钥与获取许可由服务端管理。编辑文本可能包含节点凭据，不会存入浏览器持久存储。重新加载草稿会替换当前文本。</p>
      </details>
    </section>

    <section class="rounded-box border border-base-content/10 bg-base-200 p-4 sm:p-5">
      <h2 class="font-semibold">订阅来源</h2>
      <p class="mb-4 mt-1 text-xs text-base-content/60">保存地址与获取快照分开操作。勾选的来源会按表内版本捕获；刷新不会自动应用。</p>
      <div class="overflow-x-auto">
        <table class="table table-sm">
          <thead><tr><th>捕获</th><th>来源</th><th>版本</th><th>快照</th><th>最近尝试</th><th>操作</th></tr></thead>
          <tbody>
            <tr v-for="source in sources" :key="source.id">
              <td><input v-model="selected" type="checkbox" class="checkbox checkbox-sm" :value="source.id" :aria-label="`捕获来源 ${source.id} 版本 ${source.revision}`" :disabled="!!busy || !source.snapshotCurrent" /></td>
              <td class="font-mono">{{ source.id }}</td><td>{{ source.revision }}</td>
              <td><span :class="source.snapshotCurrent ? 'text-success' : 'text-warning'">{{ source.snapshotCurrent ? `可捕获 · v${source.snapshotRevision}` : '等待刷新' }}</span><span v-if="source.snapshotDigest" class="mt-1 block font-mono text-xs opacity-50" :title="source.snapshotDigest">{{ short(source.snapshotDigest) }}</span></td>
              <td class="text-xs"><span>{{ source.lastAttempt ?? '尚未刷新' }}</span><span v-if="source.lastError" class="mt-1 block text-error">{{ coproxyErrorMessage(new CoproxyError(source.lastError)) }}</span></td>
              <td><div class="flex gap-1"><button class="btn btn-ghost btn-square btn-sm" :title="`编辑来源 ${source.id}`" :aria-label="`编辑来源 ${source.id}`" :disabled="!!busy" @click="editSource(source)"><IconPencil :size="17" /></button><button class="btn btn-ghost btn-square btn-sm" :title="`刷新来源 ${source.id} 版本 ${source.revision}`" :aria-label="`刷新来源 ${source.id}`" :disabled="!!busy" @click="run('source-refresh', () => refreshSource(source))"><IconRefresh :size="17" /></button></div></td>
            </tr>
            <tr v-if="!sources.length"><td colspan="6" class="py-6 text-center text-base-content/50">{{ sourcesLoaded ? '暂无来源；也可只使用草稿中的节点。' : '尚未读取来源。' }}</td></tr>
          </tbody>
        </table>
      </div>
      <form class="mt-4 grid items-end gap-3 border-t border-base-content/10 pt-4 sm:grid-cols-[1fr_2fr_auto]" @submit.prevent="run('source-save', configureSource)">
        <label class="flex flex-col gap-2 text-xs" for="coproxy-source-id">来源标识 · 预期版本 {{ sourceRevision }}<input id="coproxy-source-id" v-model="sourceId" class="input input-bordered input-sm w-full" maxlength="64" required autocomplete="off" :disabled="!!busy || !sourcesLoaded" @change="sourceIdChanged" /></label>
        <label class="flex flex-col gap-2 text-xs" for="coproxy-source-url">订阅地址<input id="coproxy-source-url" v-model="sourceUrl" class="input input-bordered input-sm w-full" type="url" placeholder="https://… 或已获准的 http://…" required autocomplete="off" :disabled="!!busy || !sourcesLoaded" /></label>
        <button class="btn btn-outline btn-sm" type="submit" :disabled="!!busy || !sourcesLoaded"><IconDeviceFloppy :size="17" aria-hidden="true" />保存地址</button>
      </form>
      <p class="mt-2 text-xs text-base-content/55">编辑已有来源请点铅笔；URL 不回显。发生版本冲突后，先重新读取来源，再点铅笔选择新版本。地址受部署获取许可约束。</p>
    </section>

    <section class="rounded-box border border-primary/25 bg-base-200 p-4 sm:p-5">
      <div class="flex flex-wrap items-center justify-between gap-3"><div><h2 class="font-semibold">捕获与应用</h2><p class="mt-1 text-xs text-base-content/60">将已保存草稿 v{{ draftRevision }} 与 {{ selectedSources.length }} 个来源版本捕获为候选。</p></div><button class="btn btn-outline btn-primary btn-sm" :disabled="!!busy || !draftRevision || dirty || !sourcesLoaded || selectedSources.some(source => !source.snapshotCurrent)" @click="run('stage', stage)">捕获候选</button></div>
      <p v-if="dirty" class="mt-3 text-sm text-warning">请先保存编辑，再捕获新候选。</p>
      <div v-if="capture" class="mt-4 space-y-3 border-t border-base-content/10 pt-4">
        <p v-if="captureOutdated" role="status" class="rounded-lg bg-warning/10 p-3 text-sm text-warning">此回执与当前编辑或来源选择不同。下方应用按钮仍应用这份已捕获候选；如需新内容，请先保存并重新捕获。</p>
        <dl class="grid gap-2 text-sm"><div><dt class="text-base-content/60">候选代次</dt><dd class="break-all font-mono text-xs">{{ capture.generation }}</dd></div><div><dt class="inline text-base-content/60">捕获草稿版本：</dt><dd class="inline">{{ capture.stagedRevision }}</dd></div><div><dt class="text-base-content/60">来源捕获回执</dt><dd v-if="!capture.sources.length" class="text-xs">无外部来源</dd><dd v-for="item in capture.sources" :key="item.id" class="mt-1 break-all font-mono text-xs">{{ item.id }} · 来源 v{{ item.expectedRevision }} · 快照 v{{ item.snapshotRevision }} · {{ item.snapshotDigest }}</dd></div></dl>
        <div class="flex flex-wrap items-center justify-between gap-3 border-t border-base-content/10 pt-3"><p class="max-w-xl text-xs text-base-content/60">应用将切换核心，并以当前读到的 active {{ short(status?.active) }} 检查冲突。请核对候选和来源回执；失联时操作结果未知，需重新读取状态。</p><button class="btn btn-warning btn-sm" :disabled="!!busy || !status || !!status.transaction || !!status.fault" @click="run('apply', apply)">应用候选 {{ short(capture.generation) }}</button></div>
      </div>
      <p v-else class="mt-4 text-sm text-base-content/55">尚未捕获候选。回执仅保留在本次页面会话内，刷新浏览器后需重新捕获。</p>
    </section>
  </main>
</template>
