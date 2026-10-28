<script setup lang="ts">
import { IconInfoCircle } from '@tabler/icons-vue'
withDefaults(defineProps<{ label?: string }>(), { label: '说明' })
</script>

<template>
  <details class="group text-xs text-base-content/60">
    <summary class="inline-flex min-h-11 cursor-pointer list-none items-center gap-1.5 rounded-lg px-1 focus-visible:outline focus-visible:outline-primary [&::-webkit-details-marker]:hidden">
      <IconInfoCircle :size="16" aria-hidden="true" /><span>{{ label }}</span>
    </summary>
    <div class="mb-3 rounded-lg bg-base-content/5 p-3 leading-relaxed text-base-content/70"><slot /></div>
  </details>
</template>
