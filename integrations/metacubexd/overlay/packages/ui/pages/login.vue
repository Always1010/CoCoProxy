<script setup lang="ts">
import { IconLock, IconLogin } from '@tabler/icons-vue'
import { cocoproxyErrorMessage, useCoCoProxy } from '~/composables/useCoCoProxy'

definePageMeta({ layout: false })
useHead({ title: '登录 · CoCoProxy' })
const { login } = useCoCoProxy()
const username = ref('')
const password = ref('')
const busy = ref(false)
const error = ref('')

async function submit() {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    await login(username.value, password.value)
    await navigateTo('/overview', { replace: true })
  } catch (cause) {
    error.value = cocoproxyErrorMessage(cause)
  } finally {
    password.value = ''
    busy.value = false
  }
}
</script>

<template>
  <main class="flex min-h-dvh items-center justify-center bg-base-100 p-6 text-base-content">
    <form class="card w-full max-w-sm border border-base-content/10 bg-base-200 shadow-xl" @submit.prevent="submit">
      <div class="card-body gap-5">
        <div class="flex items-center gap-3">
          <IconLock class="text-primary" :size="30" aria-hidden="true" />
          <div><h1 class="text-2xl font-bold">CoCoProxy</h1><p class="text-sm text-base-content/65">管理会话登录</p></div>
        </div>
        <label class="flex flex-col gap-2 text-sm" for="cocoproxy-username">
          用户名
          <input id="cocoproxy-username" v-model="username" class="input input-bordered w-full" autocomplete="username" required maxlength="64" :disabled="busy" />
        </label>
        <label class="flex flex-col gap-2 text-sm" for="cocoproxy-password">
          密码
          <input id="cocoproxy-password" v-model="password" class="input input-bordered w-full" type="password" autocomplete="current-password" required :disabled="busy" />
        </label>
        <p v-if="error" class="text-sm text-error" role="alert">{{ error }}</p>
        <button class="btn btn-primary w-full" type="submit" :disabled="busy">
          <span v-if="busy" class="loading loading-spinner loading-sm" aria-hidden="true" />
          <IconLogin v-else :size="20" aria-hidden="true" />
          {{ busy ? '登录中…' : '登录' }}
        </button>
        <p class="text-xs leading-relaxed text-base-content/55">使用部署时设置的管理员账户。会话通过同源 Cookie 验证。</p>
      </div>
    </form>
  </main>
</template>
