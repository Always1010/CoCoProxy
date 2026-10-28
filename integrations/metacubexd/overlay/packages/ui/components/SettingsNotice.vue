<script setup lang="ts">
import { IconInfoCircle } from '@tabler/icons-vue'
defineProps<{ warning?: boolean }>()
</script>

<template>
  <p role="note" class="flex items-start gap-2 text-xs leading-relaxed" :class="warning ? 'text-warning' : 'text-base-content/65'">
    <IconInfoCircle :size="16" class="mt-0.5 shrink-0" aria-hidden="true" />
    <span class="min-w-0"><slot /></span>
  </p>
</template>
