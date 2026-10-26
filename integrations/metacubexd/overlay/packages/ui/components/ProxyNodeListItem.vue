<script setup lang="ts">
import { IconCircleCheckFilled, IconLink } from '@tabler/icons-vue'

interface Props {
  proxyName: string
  testUrl: string | null
  timeout: number | null
  isSelected?: boolean
  providerName?: string
  groupName?: string
  kindLabel?: string
}

const props = withDefaults(defineProps<Props>(), {
  isSelected: false,
  providerName: '',
})

const emit = defineEmits<{
  click: []
}>()

const {
  proxyType,
  isUDP,
  specialTypes,
  isTesting,
  stabilityBar,
  runLatencyTest,
} = useProxyNode(
  () => props.proxyName,
  () => props.testUrl,
  () => props.timeout,
  { providerName: () => props.providerName },
)

function onClick() {
  emit('click')
}
</script>

<template>
  <!-- Wrapper lifts the selected row above its neighbours -->
  <div class="relative z-0" :class="isSelected ? 'z-10' : ''">
    <div
      class="relative rounded-lg transition-all duration-300"
      :class="
        isSelected
          ? 'bg-primary/15 text-base-content shadow-[inset_2px_0_var(--color-primary)]'
          : 'bg-neutral text-neutral-content hover:shadow-md'
      "
    >
      <div
        class="flex items-center gap-1.5 px-2 py-1.5 sm:gap-2 sm:px-3"
        :class="{ 'cursor-pointer hover:opacity-80': !!onClick }"
        role="button"
        tabindex="0"
        :aria-pressed="isSelected"
        :aria-label="kindLabel ? `${kindLabel} ${proxyName}` : proxyName"
        @click="onClick"
        @keydown.enter.self.prevent="onClick"
        @keydown.space.self.prevent="onClick"
      >
        <!-- Selected indicator -->
        <IconCircleCheckFilled
          v-if="isSelected"
          class="size-4 shrink-0 text-primary"
        />

        <!-- Proxy name -->
        <span class="line-clamp-1 min-w-0 flex-1 text-sm font-medium break-all">
          <ProxyNodeName :name="proxyName" />
        </span>

        <span v-if="kindLabel" class="inline-flex shrink-0 items-center gap-1 rounded border border-primary/25 bg-primary/10 px-1.5 py-0.5 text-[0.65rem] text-primary">
          <IconLink :size="12" aria-hidden="true" />
          <span>{{ kindLabel }}</span>
        </span>

        <!-- UDP indicator -->
        <span
          v-if="isUDP"
          class="hidden shrink-0 rounded bg-info px-1.5 py-0.5 text-[0.625rem] font-semibold text-info-content sm:inline"
          >U</span
        >

        <!-- Special types -->
        <span
          v-if="specialTypes"
          class="hidden text-xs uppercase opacity-60 sm:inline"
        >
          {{ specialTypes }}
        </span>

        <!-- Proxy type -->
        <span class="hidden text-xs uppercase opacity-75 sm:inline">
          {{ proxyType }}
        </span>

        <!-- Latency -->
        <TcpLatency :proxy-name="proxyName" />
        <div class="flex shrink-0 flex-col items-end gap-1">
          <Latency
            :proxy-name="proxyName"
            :test-url="testUrl"
            :provider-name="providerName"
            :class="{ 'animate-pulse': isTesting }"
            interactive
            @click.stop="runLatencyTest()"
          />
          <div v-if="!groupName && stabilityBar.length" class="flex h-[3px] w-full max-w-[44px] gap-px overflow-hidden rounded-full" aria-hidden="true"><div v-for="(result, index) in stabilityBar" :key="index" class="h-full flex-1 bg-current" :class="result.colorClass" /></div>
        </div>
        <SiteResultBadge v-if="groupName" :proxy-name="proxyName" :group-name="groupName" />
      </div>
    </div>
  </div>
</template>
