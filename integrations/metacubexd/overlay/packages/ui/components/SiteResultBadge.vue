<script setup lang="ts">
import { IconChevronDown } from '@tabler/icons-vue'
import type { useSiteProbes, SiteResult } from '~/composables/useSiteProbes'
import type { useSiteSettings } from '~/composables/useSiteSettings'
const { t } = useI18n()
const props = defineProps<{ proxyName: string; groupName: string }>()
const context = inject<{ probes: ReturnType<typeof useSiteProbes>; sites: ReturnType<typeof useSiteSettings>; details: (group: string, node: string) => void } | null>('cocoproxy-sites', null)
const store = useProxiesStore()
const nodeName = computed(() => {
  let name = props.proxyName
  const visited = new Set<string>()
  while (!visited.has(name)) {
    visited.add(name)
    const group = store.proxies.find(group => group.name === name)
    if (!group?.now) return name
    name = group.now
  }
  return props.proxyName
})
const targets = computed(() => context?.sites.targetsFor(props.groupName) ?? [])
const results = computed(() => context?.probes.runs.value[props.groupName]?.results[nodeName.value])
const entries = computed(() => targets.value.map(target => results.value?.[target.id]))
const successes = computed(() => entries.value.filter(result => result?.status === 'success').length)
const label = computed(() => {
  if (/^(REJECT|REJECT-DROP|PASS|COMPATIBLE)$/i.test(props.proxyName)) return t('coco.pzSitesNA')
  if (!targets.value.length) return t('coco.pzNoSitesSelected')
  if (!results.value) return t('coco.pzSitesUntested')
  if (entries.value.some(result => result?.status === 'testing')) return t('coco.pzTestingSites')
  if (entries.value.some(result => !result || ['cancelled', 'denied', 'busy', 'unavailable'].includes(result.status))) return t('coco.pzSitesIncomplete')
  return t('coco.pzSites', { successful: successes.value, total: targets.value.length })
})
const config = useConfigStore()
function color(result?: SiteResult) {
  if (result?.status === 'success') return result.delay! > config.latencyQualityMap.MEDIUM ? 'bg-warning' : 'bg-success'
  return result && ['failed', 'timeout'].includes(result.status) ? 'bg-error' : 'bg-base-content/20'
}
</script>

<template>
  <button v-if="context && groupName" type="button" class="flex shrink-0 flex-col items-end gap-1 rounded px-1 py-0.5 text-[10px] tabular-nums hover:bg-base-content/5 sm:text-[11px]" :aria-label="t('coco.pzViewSiteResults', { node: proxyName, status: label })" @click.stop="context.details(groupName, nodeName)" @keydown.stop>
    <span class="inline-flex items-center gap-0.5 whitespace-nowrap text-base-content/70"><IconChevronDown :size="11" /><span>{{ label }}</span></span>
    <span v-if="targets.length" class="flex h-[3px] w-11 gap-px overflow-hidden rounded-full" aria-hidden="true"><span v-for="(entry, index) in entries" :key="index" class="h-full min-w-0 flex-1" :class="color(entry)" /></span>
  </button>
</template>
