<script setup lang="ts">
import { IconX } from '@tabler/icons-vue'
const { t } = useI18n()

interface Props {
  compact?: boolean
  settingsLayout?: boolean
  settingsDirectory?: boolean
  title?: string
  size?: 'md' | 'xl'
  fixedHeight?: boolean
  beforeClose?: () => boolean
  closeDisabled?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  size: 'md',
  fixedHeight: true,
  settingsDirectory: undefined,
  beforeClose: undefined,
  closeDisabled: false,
})

const emit = defineEmits<{
  close: []
}>()

const dialogRef = ref<HTMLDialogElement>()
const isOpen = ref(false)
const isRendered = ref(false)

// SSR-safe unique id so aria-labelledby works even when several Modals mount
// concurrently (e.g. connections.vue mounts two at once).
const titleId = useId()

function open() {
  dialogRef.value?.showModal()
  isRendered.value = true
  isOpen.value = true
}

function close(force = false) {
  if (!force && (props.closeDisabled || (props.beforeClose && !props.beforeClose()))) return
  isOpen.value = false
  dialogRef.value?.close()
  isRendered.value = false
  emit('close')
}

function requestClose() {
  close(false)
}

const modalSizeClass = computed(() =>
  props.size === 'xl' ? 'max-w-6xl' : props.settingsLayout ? 'max-w-3xl' : 'max-w-2xl',
)

defineExpose({ open, close })
</script>

<template>
  <dialog
    ref="dialogRef"
    class="modal modal-bottom sm:modal-middle"
    aria-modal="true"
    :aria-labelledby="title ? titleId : undefined"
    :style="{
      '--modal-border':
        'color-mix(in oklab, var(--color-base-content) 10%, transparent)',
    }"
    @cancel.prevent="requestClose"
  >
    <div
      class="modal-shell flex max-h-[90vh] w-[95%] flex-col overflow-hidden rounded-2xl p-0 sm:w-11/12"
      :class="[isOpen ? 'is-open' : '', modalSizeClass, { 'modal-shell-fixed': fixedHeight, 'modal-compact': compact, 'settings-shell': settingsLayout }]"
      :style="{
        background: 'var(--color-base-100)',
        border: '1px solid var(--modal-border)',
        boxShadow:
          '0 25px 50px -12px color-mix(in oklab, var(--color-base-content) 25%, transparent), 0 0 0 1px var(--modal-border), inset 0 1px 0 0 color-mix(in oklab, var(--color-base-content) 6%, transparent)',
      }"
      @contextmenu.prevent
    >
      <!-- Header -->
      <div
        class="sticky top-0 z-10 flex shrink-0 items-center justify-between px-5 py-4 max-sm:pt-[max(1rem,env(safe-area-inset-top))]"
        :style="{
          background: 'var(--color-base-200)',
          borderBottom: '1px solid var(--modal-border)',
        }"
      >
        <div
          class="flex min-w-0 flex-1 items-center gap-3 text-lg font-bold text-base-content [&>svg]:text-primary"
        >
          <slot name="icon" />
          <span :id="titleId" class="min-w-0 break-all">{{ title }}</span>
        </div>

        <button
          type="button"
          class="modal-close flex min-h-8 shrink-0 cursor-pointer items-center justify-center gap-1 rounded-lg bg-transparent px-2"
          :title="t('coco.anCloseDialog')"
          :aria-label="t('coco.anCloseDialog')"
          :disabled="closeDisabled"
          :style="{
            border: '1px solid var(--modal-border)',
            color:
              'color-mix(in oklab, var(--color-base-content) 60%, transparent)',
          }"
          @click="requestClose"
        >
          <IconX :size="18" aria-hidden="true" /><span class="text-xs">{{ t('coco.anClose') }}</span>
        </button>
      </div>

      <div class="modal-body flex min-h-0 flex-1 flex-col" :class="{ 'settings-body': settingsLayout && $slots.tabs, 'settings-paged': settingsDirectory !== undefined, 'settings-directory': settingsDirectory }">
      <!-- Navigation stays outside the scrolling content. -->
      <div v-if="isRendered && $slots.tabs" class="modal-nav shrink-0 px-5 pt-5">
        <slot name="tabs" />
      </div>

      <!-- Content -->
      <div
        v-if="isRendered"
        class="modal-content min-h-0 flex-1 p-5 max-sm:pb-[max(1.25rem,env(safe-area-inset-bottom))]"
        :class="[$slots.content ? 'flex flex-col overflow-hidden' : 'overflow-y-auto', { '[scrollbar-gutter:stable]': fixedHeight && !$slots.content }]"
      >
        <slot name="content"><slot /></slot>
      </div>

      </div>

      <!-- Actions -->
      <div
        v-if="isRendered && $slots.actions"
        class="sticky bottom-0 z-10 flex shrink-0 items-center justify-end px-5 py-4 max-sm:pb-[max(1rem,env(safe-area-inset-bottom))]"
        :style="{
          background: 'var(--color-base-200)',
          borderTop: '1px solid var(--modal-border)',
        }"
      >
        <div class="flex flex-wrap justify-end gap-2">
          <slot name="actions" />
        </div>
      </div>
    </div>

    <form
      method="dialog"
      class="fixed inset-0 modal-backdrop -z-[1]"
      :class="isOpen ? 'is-open' : ''"
    >
      <button
        type="button"
        class="absolute inset-0 h-full w-full cursor-pointer border-none bg-transparent"
        @click="requestClose"
      />
    </form>
  </dialog>
</template>

<style scoped>
.modal { background-color: transparent !important; transition: none !important; animation: none !important; }
.modal-shell-fixed { height: min(600px, calc(100dvh - 2rem)); max-height: calc(100dvh - 2rem); }
.modal-shell { opacity: 1; transform: none; transition: none; animation: none; }
.modal-backdrop { background: oklch(0% 0 0 / 0.45); }
.modal-close, .modal-close:hover, .modal-close:active { transform: none !important; transition: none !important; animation: none !important; }
.modal-close:hover { background: color-mix(in oklab, var(--color-base-content) 8%, transparent); }
.modal-compact { font-size: 13px; line-height: 1.4; border-radius: 8px; }
.modal-compact > .py-4 { padding: 8px 14px; }
.modal-compact > div > .text-lg { font-size: 14px; font-weight: 600; }
.modal-compact .modal-content { padding: 12px 14px; }
.modal-compact .modal-nav { padding: 8px 14px 0; }
.modal-compact :deep(label), .modal-compact :deep(.input), .modal-compact :deep(.select), .modal-compact :deep(.textarea), .modal-compact :deep(.text-sm) { font-size: 13px; line-height: 1.4; }
.modal-compact :deep(.text-xs) { font-size: 11px; line-height: 1.4; }
.modal-compact :deep(.gap-4), .modal-compact :deep(.gap-3) { gap: 8px; }
.modal-compact :deep(.space-y-4 > :not(:last-child)), .modal-compact :deep(.space-y-3 > :not(:last-child)) { margin-block: 0 8px; }
.modal-compact :deep(.p-3) { padding: 6px 10px; }
.modal-compact :deep(.min-h-11) { min-height: 30px; }
.modal-compact :deep(.btn) { font-size: 12px; min-height: 30px; height: auto; padding: 4px 8px; border-radius: 4px; box-shadow: none; }
.modal-compact :deep(.btn:disabled) { opacity: .35; color: var(--color-base-content); }
.modal-compact :deep(.input), .modal-compact :deep(.select) { min-height: 30px; height: 30px; padding-block: 3px; border-radius: 4px; }
.modal-compact :deep(.toggle) { width: 30px; height: 18px; }
.modal-compact :deep(.rounded-lg), .modal-compact :deep(.rounded-xl) { border-radius: 4px; }
.settings-shell .modal-content :deep(.input.w-full), .settings-shell .modal-content :deep(.select.w-full) { max-width: 380px; }
@media (min-width: 640px) {
  .settings-body { display: grid; grid-template-columns: 142px minmax(0, 1fr); }
  .settings-body > .modal-nav { padding: 10px 8px; border-right: 1px solid var(--modal-border); background: var(--color-base-200); overflow-y: auto; }
  .settings-body > .modal-content { padding: 12px 16px; }
  .modal-nav :deep([role=tablist]) { display: flex; flex-direction: column; align-items: stretch; gap: 3px; }
  .modal-nav :deep([role=tab]) { width: 100%; justify-content: flex-start; border: 1px solid transparent; background: transparent; color: var(--color-base-content); font-weight: 400; }
  .modal-nav :deep([role=tab][aria-selected=true]) { background: color-mix(in oklab, var(--color-primary) 12%, transparent); border-color: color-mix(in oklab, var(--color-primary) 40%, transparent); }
}
@media (width < 640px) {
  .modal-shell-fixed { height: calc(100dvh - 1rem - env(safe-area-inset-top, 0px)); max-height: calc(100dvh - 1rem - env(safe-area-inset-top, 0px)); }
  .settings-shell .modal-nav :deep([role=tablist]) { flex-wrap: nowrap; gap: 3px; }
  .settings-paged > .modal-nav { display: none; }
  .settings-paged.settings-directory > .modal-nav { display: block; flex: 1; min-height: 0; overflow-y: auto; padding: 16px; }
  .settings-paged.settings-directory > .modal-content { display: none; }
  .settings-paged .modal-nav :deep([role=tablist]) { display: flex; flex-direction: column; align-items: stretch; gap: 4px; }
  .settings-paged .modal-nav :deep([role=tab]) { justify-content: flex-start; }
  .settings-paged .modal-nav :deep([role=tab][aria-selected=true]) { background: color-mix(in oklab, var(--color-primary) 12%, transparent); }
}
@media (pointer: coarse) {
  .modal-compact :deep(.btn), .modal-compact :deep(label:has(input)), .modal-compact :deep(summary:not(.help-summary)) { min-height: 40px; }
}
</style>
