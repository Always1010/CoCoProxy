<script setup lang="ts">
import { IconRoute } from '@tabler/icons-vue'
import { cocoproxyErrorMessage } from '~/composables/useCoCoProxy'

const { t } = useI18n()
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
const panel = ref<{ open: () => void; close: () => void }>()
const input = ref<HTMLInputElement>()
const opened = ref(false)
const target = ref('')
const network = ref('')
const destinationPort = ref('')
const sourceIP = ref('')
const sourcePort = ref('')
const testing = ref(false)
const result = ref<Result | null>(null)
const errorSource = shallowRef<(() => string) | null>(null)
const error = computed(() => errorSource.value?.() ?? '')
let pending: AbortController | undefined

function cancel() {
  pending?.abort()
  pending = undefined
  testing.value = false
}

async function open() {
  opened.value = true
  panel.value?.open()
  await nextTick()
  input.value?.focus()
}
function close() { opened.value = false; cancel() }

function reset() {
  cancel()
  result.value = null
  errorSource.value = null
}

watch([target, network, destinationPort, sourceIP, sourcePort], reset)
watch(() => view.value?.active, (value, previous) => {
  if (value !== previous && (result.value || testing.value)) {
    reset()
    errorSource.value = () => t('coco.pzTheActiveConfigurationChangedRunTheTestAgain')
  }
})

async function test() {
  if (testing.value || !target.value.trim()) return
  result.value = null
  errorSource.value = null
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
    if (!abort.signal.aborted) errorSource.value = () => cocoproxyErrorMessage(cause, t)
  } finally {
    if (pending === abort) { pending = undefined; testing.value = false }
  }
}

const ruleMessageKeys: Record<string, string> = {
  "未命中前面的规则，使用兜底策略": "coco.pzRuleResultFallbackPolicy",
  "此规则需要 TCP／UDP 条件，请展开高级条件补充。": "coco.pzRuleResultProtocolRequired",
  "此规则需要目的端口，请展开高级条件补充。": "coco.pzRuleResultDestinationPortRequired",
  "此规则需要来源端口，请展开高级条件补充。": "coco.pzRuleResultSourcePortRequired",
  "此规则需要来源 IP，请展开高级条件补充。": "coco.pzRuleResultSourceIpRequired",
  "此规则集合暂不支持分析。": "coco.pzRuleResultRuleSetUnsupported",
  "规则集合内容无法分析。": "coco.pzRuleResultRuleSetContentUnsupported",
  "规则集合包含无法分析的地址。": "coco.pzRuleResultRuleSetAddressUnsupported",
  "此规则集合类型暂不支持分析。": "coco.pzRuleResultRuleSetTypeUnsupported",
  "策略组引用存在循环，无法确定出口。": "coco.pzRuleResultPolicyCycle",
  "此策略组按连接选择或组合节点，无法仅由当前状态确定最终节点。": "coco.pzRuleResultPolicyConnectionSelection",
  "此策略会重新匹配连接，无法确定最终出口。": "coco.pzRuleResultPolicyRematch",
  "内核未返回完整的当前选择，无法确定最终出口。": "coco.pzRuleResultPolicyIncompleteSelection",
  "策略组引用过深，无法确定最终出口。": "coco.pzRuleResultPolicyReferenceDepth",
  "当前核心使用直连模式。": "coco.pzRuleResultCoreDirectMode",
  "当前核心使用全局模式。": "coco.pzRuleResultCoreGlobalMode",
  "此规则使用复杂表达式，暂无法分析。": "coco.pzRuleResultComplexRuleUnsupported",
  "此策略不支持 UDP，请在高级条件中指定 TCP／UDP。": "coco.pzRuleResultPolicyUdpUnsupported",
  "未命中任何规则，内核默认直连。": "coco.pzRuleResultDefaultDirect"
}
function ruleMessage(value: string) {
  if (ruleMessageKeys[value]) return t(ruleMessageKeys[value]!)
  const expression = value.match(/^暂不支持此规则的表达式：(.*)$/)
  if (expression) return t('coco.pzRuleExpressionUnsupported', { type: expression[1] })
  const unsupported = value.match(/^规则 (.*) 需要额外连接信息或暂不支持分析，无法确定后续去向。$/)
  if (unsupported) return t('coco.pzRuleNeedsConnectionInfo', { type: unsupported[1] })
  const domainSet = value.match(/^域名集合 (.*?)：(.*)$/)
  if (domainSet) return t('coco.pzRuleDomainSetMatch', { provider: domainSet[1], entry: domainSet[2] })
  const ipSet = value.match(/^IP 集合 (.*?)：(.*)$/)
  if (ipSet) return t('coco.pzRuleIpSetMatch', { provider: ipSet[1], entry: ipSet[2] })
  return value
}

const catalogLabels: Record<string, string> = { Proxy: 'coco.pzCatalogProxy', Overseas: 'coco.pzCatalogOverseas', Domestic: 'coco.pzCatalogDomestic', Other: 'coco.pzCatalogOther' }
function policyName(name: string) {
  if (name === 'DIRECT') return t('coco.pzDirectDirectConnection')
  if (name === 'REJECT' || name === 'REJECT-DROP') return t('coco.pzReject', { name: name })
  const label = workspace.value?.mode === 'local' ? catalogLabels[name] ? t(catalogLabels[name]!) : view.value?.catalog?.find(group => group.id === name)?.name : undefined
  return label && label !== name ? `${label} (${name})` : name
}

onBeforeUnmount(cancel)
</script>

<template>
  <button class="btn btn-ghost btn-sm" :title="t('coco.pzTestRules')" :aria-label="t('coco.pzTestRules')" aria-haspopup="dialog" aria-controls="rule-test-popover" :aria-expanded="opened" @click="open">
    <IconRoute :size="18" />
    <span>{{ t('coco.pzTestRules') }}</span>
  </button>
  <Modal id="rule-test-popover" ref="panel" :title="t('coco.pzRuleTest')" @close="close">
    <form class="flex flex-col gap-3" @submit.prevent="test">
      <label class="input input-sm flex w-full items-center gap-2">
        <span class="sr-only">{{ t('coco.pzDomainOrIp') }}</span>
        <input ref="input" v-model="target" class="min-w-0 grow" :aria-label="t('coco.pzDomainOrIp')" :placeholder="t('coco.pzEnterADomainOrIp')" maxlength="1024" autocomplete="off" autocapitalize="none" spellcheck="false" required />
      </label>
      <div class="flex items-center justify-between gap-2">
        <span class="text-xs text-base-content/50">{{ t('coco.pzTestAgainstTheActiveConfiguration') }}</span>
        <button type="submit" class="btn btn-primary min-h-11" :disabled="testing || !target.trim()"><span v-if="testing" class="loading loading-spinner loading-xs" /><IconRoute v-else :size="16" /><span>{{ testing ? t('coco.pzTesting') : t('coco.pzTestRules') }}</span></button>
      </div>
      <details class="text-xs">
        <summary class="w-fit cursor-pointer text-base-content/60">{{ t('coco.pzAdvancedConditions') }}</summary>
        <div class="mt-2 grid grid-cols-2 gap-2">
          <label class="flex flex-col gap-1">{{ t('coco.pzProtocol') }}<select v-model="network" class="select select-sm w-full" :aria-label="t('coco.pzTestProtocol')"><option value="">{{ t('coco.pzUnspecified') }}</option><option value="tcp">TCP</option><option value="udp">UDP</option></select></label>
          <label class="flex flex-col gap-1">{{ t('coco.pzDestinationPort') }}<input v-model="destinationPort" type="number" min="1" max="65535" class="input input-sm w-full" :aria-label="t('coco.pzTestDestinationPort')" :placeholder="t('coco.pzOptional')" /></label>
          <label class="flex flex-col gap-1">{{ t('coco.pzSourceIp') }}<input v-model="sourceIP" class="input input-sm w-full" :aria-label="t('coco.pzTestSourceIp')" :placeholder="t('coco.pzOptional')" maxlength="45" spellcheck="false" /></label>
          <label class="flex flex-col gap-1">{{ t('coco.pzSourcePort') }}<input v-model="sourcePort" type="number" min="1" max="65535" class="input input-sm w-full" :aria-label="t('coco.pzTestSourcePort')" :placeholder="t('coco.pzOptional')" /></label>
        </div>
      </details>
    </form>
    <div v-if="testing" role="status" class="mt-3 border-t border-base-content/10 pt-3 text-sm text-base-content/60">{{ t('coco.pzTesting2') }}</div>
    <div v-if="error" role="alert" class="mt-3 rounded-lg bg-error/10 p-3 text-sm text-error">{{ error }}</div>
    <div v-if="result" role="status" aria-live="polite" class="mt-3 space-y-3 border-t border-base-content/10 pt-3">
      <div class="break-all text-xs text-base-content/60">{{ result.target }}<span v-if="result.results.length > 1"> {{ t('coco.pzAnalyzeEachResolvedAddressSeparately') }}</span></div>
      <div v-for="(match, index) in result.results" :key="index" class="space-y-2 rounded-xl bg-base-200/70 p-3">
        <div v-if="match.address" class="break-all font-mono text-xs text-base-content/60">{{ match.address }}</div>
        <template v-if="match.status === 'matched'">
          <div class="text-xs text-base-content/55">{{ t('coco.pzTargetPolicy') }}</div>
          <div class="break-all text-base font-semibold">{{ policyName(match.policy!) }}</div>
          <div v-if="match.chain?.length" class="break-all text-xs"><span class="text-base-content/55">{{ t('coco.pzCurrentOutbound') }}</span>{{ match.chain.join(' → ') }}</div>
        </template>
        <div v-else class="text-sm font-semibold text-warning">{{ t('coco.pzUndetermined') }}</div>
        <div v-if="match.rule" class="text-xs"><span class="text-base-content/55">{{ match.status === 'matched' ? t('coco.pzMatchedRule') : t('coco.pzPendingMatchedRule') }}<span v-if="match.index !== undefined"> #{{ match.index + 1 }}</span></span><code class="mt-1 block break-all whitespace-pre-wrap">{{ match.rule }}</code></div>
        <p class="break-all text-xs text-base-content/70">{{ ruleMessage(match.detail) }}</p>
        <p v-if="match.warning" class="text-xs text-warning">{{ ruleMessage(match.warning) }}</p>
      </div>
      <p class="text-xs leading-relaxed text-base-content/45">{{ t('coco.pzRuleAnalysisDoesNotConnectToTheDestinationWebsite') }}</p>
    </div>
  </Modal>
</template>
