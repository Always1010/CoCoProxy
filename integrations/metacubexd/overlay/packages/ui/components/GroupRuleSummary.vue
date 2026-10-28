<script setup lang="ts">
import { IconList, IconPlus } from '@tabler/icons-vue'
import { ruleTarget } from '~/utils/group-rules'
const { t } = useI18n()

const props = defineProps<{ groupName: string }>()
const emit = defineEmits<{ configure: [] }>()
const { view, workspace, overrides } = useWorkspace()
const shared = computed(() => view.value?.groups.find(group => group.name === props.groupName)?.role === 'shared')
const custom = computed(() => !shared.value && !view.value?.catalog?.some(service => service.id === props.groupName))
const count = computed(() => overrides.value.rules.filter(rule => ruleTarget(rule) === props.groupName).length)
</script>

<template>
  <div v-if="workspace?.mode === 'local'" class="space-y-1 text-xs" :aria-label="t('coco.anProxyGroupRuleSummary')">
    <div class="flex flex-wrap items-center gap-2">
      <span v-if="shared" class="text-base-content/60">{{ t('coco.anSharedExitReferencedByRegularProxy') }}</span>
      <span v-else-if="groupName === 'Other'" class="text-base-content/60">{{ t('coco.anFinalFallbackExitCustomRules', { value: count }) }}</span>
      <span v-else-if="custom && !count" class="text-warning">{{ t('coco.anNoMatchingRulesConfiguredThisGroup') }}</span>
      <span v-else class="text-base-content/60">{{ t('coco.anCustomRules2', { value: custom ? '' : t('coco.anBuiltInMatchingRules'), value2: count }) }}</span>
      <button v-if="!shared" type="button" class="btn btn-ghost btn-sm min-h-11" @click="emit('configure')"><IconPlus v-if="custom && !count" :size="16" /><IconList v-else :size="16" /><span>{{ custom && !count ? t('coco.anAddRule') : t('coco.anManageRules') }}</span></button>
    </div>
    <p v-if="workspace.runMode !== 'rule'" class="text-warning">{{ t('coco.anCurrentlyInModeDomainRoutingDoes2', { value: workspace.runMode === 'global' ? t('coco.anGlobal') : t('coco.anDirect') }) }}</p>
    <p v-if="view?.pending" class="text-warning">{{ t('coco.anSettingsAreNotActiveYetThe') }}</p>
  </div>
</template>
