<script setup lang="ts">
import type { ShortcutAction } from '~/constants/shortcuts'
import { formatShortcutKey, SHORTCUT_CATEGORIES, SHORTCUT_LABELS } from '~/constants/shortcuts'

const shortcutsStore = useShortcutsStore()
const { t } = useI18n()
const isMobile = useMediaQuery('(max-width: 768px)')
const modal = ref<{ open: () => void; close: () => void }>()

watch(() => shortcutsStore.isHelpModalOpen, open => {
  if (open && !isMobile.value) modal.value?.open()
  else modal.value?.close()
}, { flush: 'post' })
</script>

<template>
  <Modal v-if="!isMobile" ref="modal" :title="t('shortcuts.title', 'Keyboard Shortcuts')" @close="shortcutsStore.closeHelpModal()">
    <div class="space-y-6">
      <section v-for="category in SHORTCUT_CATEGORIES" :key="category.id">
        <h3 class="mb-2 text-sm font-semibold text-base-content/70">{{ t(category.labelKey, category.id) }}</h3>
        <div class="space-y-1">
          <div v-for="action in category.shortcuts" :key="action" class="flex items-center justify-between gap-3 rounded px-2 py-1.5 hover:bg-base-200">
            <span class="text-sm">{{ t(SHORTCUT_LABELS[action as ShortcutAction], action) }}</span>
            <kbd class="kbd kbd-sm shrink-0">{{ formatShortcutKey(shortcutsStore.shortcuts[action as ShortcutAction]) }}</kbd>
          </div>
        </div>
      </section>
      <p class="text-center text-xs text-base-content/50">{{ t('shortcuts.pressEscToClose', 'Press Esc to close') }}</p>
    </div>
  </Modal>
</template>
