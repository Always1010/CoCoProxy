<script setup lang="ts">
import { IconRoute, IconX } from '@tabler/icons-vue'
import { cocoproxyErrorMessage } from '~/composables/useCoCoProxy'

interface Match {
  status: 'matched' | 'indeterminate'
  address?: string
  policy?: string
  chain?: string[]
  rule?: string
  index?: number
  detail: string
  warning?: string
}
interface Result { target: string; generation: string; checkedAt: string; results: Match[] }

const { api, view, workspace } = useWorkspace()
const trigger = ref<HTMLButtonElement>()
const panel = ref<HTMLElement>()
const input = ref<HTMLInputElement>()
const opened = ref(false)
const target = ref('')
const network = ref('')
const destinationPort = ref('')
const sourceIP = ref('')
const sourcePort = ref('')
const testing = ref(false)
const result = ref<Result | null>(null)
const error = ref('')
const position = ref({ left: '12px', top: '80px', maxHeight: 'calc(100dvh - 92px)' })
let pending: AbortController | undefined

function place() {
  const rect = trigger.value?.getBoundingClientRect()
  if (!rect) return
  const width = Math.min(420, window.innerWidth - 24)
  const top = Math.max(12, Math.min(rect.bottom + 8, window.innerHeight - 160))
  position.value = {
    left: `${Math.max(12, Math.min(rect.right - width, window.innerWidth - width - 12))}px`,
    top: `${top}px`,
    maxHeight: `${window.innerHeight - top - 12}px`,
  }
}

function cancel() {
  pending?.abort()
  pending = undefined
  testing.value = false
}

async function onToggle(event: Event) {
  opened.value = (event as ToggleEvent).newState === 'open'
  if (opened.value) {
    place()
    await nextTick()
    input.value?.focus()
  } else {
    cancel()
  }
}

function reset() {
  cancel()
  result.value = null
  error.value = ''
}

watch([target, network, destinationPort, sourceIP, sourcePort], reset)
watch(() => view.value?.active, (value, previous) => {
  if (value !== previous && (result.value || testing.value)) {
    reset()
    error.value = '运行配置已变化，请重新测试。'
  }
})

async function test() {
  if (testing.value || !target.value.trim()) return
  result.value = null
  error.value = ''
  const abort = new AbortController()
  pending = abort
  testing.value = true
  try {
    const response = await api.request<Result>('/api/cocoproxy/rules/test', {
      method: 'POST', signal: abort.signal,
      body: {
        target: target.value.trim(),
        ...(network.value ? { network: network.value } : {}),
        ...(destinationPort.value ? { destinationPort: Number(destinationPort.value) } : {}),
        ...(sourceIP.value.trim() ? { sourceIP: sourceIP.value.trim() } : {}),
        ...(sourcePort.value ? { sourcePort: Number(sourcePort.value) } : {}),
      },
    })
    if (!abort.signal.aborted) result.value = response
  } catch (cause) {
    if (!abort.signal.aborted) error.value = cocoproxyErrorMessage(cause)
  } finally {
    if (pending === abort) { pending = undefined; testing.value = false }
  }
}

function policyName(name: string) {
  if (name === 'DIRECT') return 'DIRECT（直连）'
  if (name === 'REJECT' || name === 'REJECT-DROP') return `${name}（拒绝）`
  const label = workspace.value?.mode === 'local' ? view.value?.catalog?.find(group => group.id === name)?.name : undefined
  return label && label !== name ? `${label}（${name}）` : name
}

onMounted(() => window.addEventListener('resize', place))
onBeforeUnmount(() => { cancel(); window.removeEventListener('resize', place) })
</script>

<template>
  <button ref="trigger" class="btn btn-ghost btn-sm" title="测试规则" aria-label="测试规则" aria-haspopup="dialog" aria-controls="rule-test-popover" :aria-expanded="opened" @click="place(); panel?.togglePopover()">
    <IconRoute :size="18" />
  </button>
  <div id="rule-test-popover" ref="panel" popover="auto" role="dialog" aria-labelledby="rule-test-title" class="rule-test-popover fixed m-0 w-[420px] max-w-[calc(100vw-24px)] overflow-y-auto rounded-2xl border border-base-content/15 bg-base-100 p-4 text-base-content shadow-xl" :style="position" @toggle="onToggle">
    <div class="mb-3 flex items-center justify-between gap-2">
      <h2 id="rule-test-title" class="text-sm font-semibold">规则测试</h2>
      <button class="btn btn-ghost btn-xs" title="关闭" aria-label="关闭规则测试" @click="panel?.hidePopover()"><IconX :size="16" /></button>
    </div>
    <form class="flex flex-col gap-3" @submit.prevent="test">
      <label class="input input-sm flex w-full items-center gap-2">
        <span class="sr-only">域名或 IP</span>
        <input ref="input" v-model="target" class="min-w-0 grow" aria-label="域名或 IP" placeholder="输入域名或 IP" maxlength="1024" autocomplete="off" autocapitalize="none" spellcheck="false" required />
      </label>
      <div class="flex items-center justify-between gap-2">
        <span class="text-xs text-base-content/50">按当前已生效配置测试</span>
        <button type="submit" class="btn btn-primary btn-sm" :disabled="testing || !target.trim()"><span v-if="testing" class="loading loading-spinner loading-xs" />确认</button>
      </div>
      <details class="text-xs">
        <summary class="w-fit cursor-pointer text-base-content/60">高级条件</summary>
        <div class="mt-2 grid grid-cols-2 gap-2">
          <label class="flex flex-col gap-1">协议<select v-model="network" class="select select-sm w-full" aria-label="测试协议"><option value="">未指定</option><option value="tcp">TCP</option><option value="udp">UDP</option></select></label>
          <label class="flex flex-col gap-1">目的端口<input v-model="destinationPort" type="number" min="1" max="65535" class="input input-sm w-full" aria-label="测试目的端口" placeholder="可选" /></label>
          <label class="flex flex-col gap-1">来源 IP<input v-model="sourceIP" class="input input-sm w-full" aria-label="测试来源 IP" placeholder="可选" maxlength="45" spellcheck="false" /></label>
          <label class="flex flex-col gap-1">来源端口<input v-model="sourcePort" type="number" min="1" max="65535" class="input input-sm w-full" aria-label="测试来源端口" placeholder="可选" /></label>
        </div>
      </details>
    </form>
    <div v-if="testing" role="status" class="mt-3 border-t border-base-content/10 pt-3 text-sm text-base-content/60">正在测试…</div>
    <div v-if="error" role="alert" class="mt-3 rounded-lg bg-error/10 p-3 text-sm text-error">{{ error }}</div>
    <div v-if="result" role="status" aria-live="polite" class="mt-3 space-y-3 border-t border-base-content/10 pt-3">
      <div class="break-all text-xs text-base-content/60">{{ result.target }}<span v-if="result.results.length > 1"> · 按各解析地址分别分析</span></div>
      <div v-for="(match, index) in result.results" :key="index" class="space-y-2 rounded-xl bg-base-200/70 p-3">
        <div v-if="match.address" class="break-all font-mono text-xs text-base-content/60">{{ match.address }}</div>
        <template v-if="match.status === 'matched'">
          <div class="text-xs text-base-content/55">目标策略</div>
          <div class="break-all text-base font-semibold">{{ policyName(match.policy!) }}</div>
          <div v-if="match.chain?.length" class="break-all text-xs"><span class="text-base-content/55">当前出口：</span>{{ match.chain.join(' → ') }}</div>
        </template>
        <div v-else class="text-sm font-semibold text-warning">暂无法确定</div>
        <div v-if="match.rule" class="text-xs"><span class="text-base-content/55">命中{{ match.status === 'matched' ? '规则' : '待判断规则' }}<span v-if="match.index !== undefined"> #{{ match.index + 1 }}</span></span><code class="mt-1 block break-all whitespace-pre-wrap">{{ match.rule }}</code></div>
        <p class="break-all text-xs text-base-content/70">{{ match.detail }}</p>
        <p v-if="match.warning" class="text-xs text-warning">{{ match.warning }}</p>
      </div>
      <p class="text-xs leading-relaxed text-base-content/45">规则分析不会连接目标网站；需要时使用核心 DNS。真实连接还可能受域名嗅探、入站条件和自动选路影响。</p>
    </div>
  </div>
</template>

<style scoped>
.rule-test-popover::backdrop { background: transparent; }
</style>
