<script setup lang="ts">
import { IconRefresh } from '@tabler/icons-vue'
import { siteResultLabels, type useSiteProbes } from '~/composables/useSiteProbes'
import type { useSiteSettings } from '~/composables/useSiteSettings'
const props = defineProps<{ group: string; node: string; busy: boolean }>()
const context = inject<{ probes: ReturnType<typeof useSiteProbes>; sites: ReturnType<typeof useSiteSettings> }>('cocoproxy-sites')!
const targets = computed(() => context.sites.targetsFor(props.group))
const run = computed(() => context.probes.runs.value[props.group])
const results = computed(() => run.value?.results[props.node])
const checkedAt = computed(() => Math.max(0, ...Object.values(results.value ?? {}).map(result => result.checkedAt ?? 0)))
const config = useConfigStore()
const store = useProxiesStore()
const history = computed(() => store.getLatencyHistoryByName(props.node, store.proxies.find(group => group.name === props.group)?.testUrl ?? null).slice(-10).toReversed())
const slow = (id: string) => results.value?.[id]?.status === 'success' && results.value[id]!.delay! > config.latencyQualityMap.MEDIUM
const canTest = computed(() => context.probes.members(props.group).includes(props.node) && targets.value.some(target => target.permitted))
</script>

<template>
  <div class="space-y-3">
    <p class="break-all text-sm">{{ group }} → {{ node }}</p>
    <p class="text-xs text-base-content/60">每段对应一个站点。绿：成功；黄：成功但较慢；红：失败；灰：未测或未完成。探测成功不代表登录、播放或地区解锁已通过。</p>
    <div v-for="target in targets" :key="target.id" class="flex items-center justify-between gap-3 border-b border-base-content/10 py-2 text-sm"><span>{{ target.name }}</span><span :class="slow(target.id) ? 'text-warning' : results?.[target.id]?.status === 'success' ? 'text-success' : 'text-base-content/65'">{{ results?.[target.id] ? siteResultLabels[results[target.id]!.status] : '未测' }}<span v-if="slow(target.id)"> · 较慢</span><template v-if="results?.[target.id]?.delay"> · {{ results[target.id]!.delay }} ms</template></span></div>
    <p v-if="!targets.length" class="text-sm text-base-content/60">尚未选择站点，请在“组设置 → 站点连通”中配置。</p>
    <details v-if="history.length" class="text-xs text-base-content/60"><summary class="cursor-pointer py-1">代理延迟历史</summary><div v-for="(entry, index) in history" :key="index" class="flex justify-between gap-3 py-1"><span>{{ new Date(entry.time).toLocaleString() }}</span><span>{{ entry.delay ? `${entry.delay} ms` : '失败' }}</span></div></details>
    <div class="flex flex-wrap items-center justify-between gap-2"><span class="text-xs text-base-content/55">{{ checkedAt ? `检测于 ${new Date(checkedAt).toLocaleTimeString()}` : '' }}</span><button type="button" class="btn btn-outline btn-sm" :disabled="busy || !canTest" @click="context.probes.run(group, node)"><IconRefresh :size="16" /><span>重新检测</span></button></div>
  </div>
</template>
