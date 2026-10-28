<script setup lang="ts">
import { autoUpdate, flip, offset, shift, useFloating } from '@floating-ui/vue'
import { IconInfoCircle } from '@tabler/icons-vue'
withDefaults(defineProps<{ label?: string }>(), { label: '说明' })
const id = useId()
const trigger = ref<HTMLElement | null>(null)
const popup = ref<HTMLElement | null>(null)
const opened = ref(false)
const { floatingStyles, update } = useFloating(trigger, popup, {
  placement: 'bottom-end', strategy: 'fixed', transform: false,
  middleware: [offset(6), flip({ padding: 8 }), shift({ padding: 8 })],
  whileElementsMounted: autoUpdate,
})
function onToggle() {
  opened.value = popup.value?.matches(':popover-open') ?? false
  if (opened.value) update()
}
</script>

<template>
  <span class="inline-flex text-xs text-base-content/60">
    <button ref="trigger" type="button" class="help-trigger inline-flex min-h-7 cursor-pointer items-center gap-1.5 rounded px-1 text-xs focus-visible:outline focus-visible:outline-primary" :popovertarget="id" :aria-expanded="opened" :aria-describedby="opened ? id : undefined">
      <IconInfoCircle :size="16" aria-hidden="true" /><span>{{ label }}</span>
    </button>
    <div :id="id" ref="popup" popover="auto" role="tooltip" :style="floatingStyles" class="help-popup rounded border border-base-content/15 bg-base-200 px-3 py-2 text-xs text-base-content shadow-lg" @toggle="onToggle"><slot /></div>
  </span>
</template>

<style scoped>
.help-popup {
  inset: auto;
  margin: 0;
  width: max-content;
  max-width: min(320px, calc(100vw - 16px));
  max-height: min(240px, 50dvh);
  overflow-y: auto;
  overflow-wrap: anywhere;
  line-height: 1.5;
}
</style>
