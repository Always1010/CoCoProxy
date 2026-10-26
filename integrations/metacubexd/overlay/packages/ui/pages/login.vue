<script setup lang="ts">
import { IconLock, IconLogin } from '@tabler/icons-vue'
import { cocoproxyErrorMessage, useCoCoProxy } from '~/composables/useCoCoProxy'

definePageMeta({ layout: false })
useHead({ title: '登录 · CoCoProxy' })
const { login } = useCoCoProxy()
const username = ref('')
const password = ref('')
const trust = ref<'none' | '90days' | 'until-revoked'>('until-revoked')
const deviceLabel = ref('')
const busy = ref(false)
const error = ref('')

async function submit() {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    await login(username.value, password.value, trust.value, deviceLabel.value)
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
        <label class="flex flex-col gap-2 text-sm" for="cocoproxy-trust">
          登录保持方式
          <select id="cocoproxy-trust" v-model="trust" class="select select-bordered w-full" :disabled="busy">
            <option value="until-revoked">长期信任此设备</option>
            <option value="90days">信任 90 天（使用时续期）</option>
            <option value="none">临时登录（8 小时）</option>
          </select>
        </label>
        <label v-if="trust !== 'none'" class="flex flex-col gap-2 text-sm" for="cocoproxy-device-label">
          设备备注（可选）
          <input id="cocoproxy-device-label" v-model="deviceLabel" class="input input-bordered w-full" placeholder="例如：我的手机" maxlength="80" :disabled="busy" />
        </label>
        <p class="text-xs leading-relaxed text-base-content/55">{{ trust === 'none' ? '临时会话在 8 小时后或管理服务重启后失效。' : '此设备下次自动登录，管理服务重启后仍有效。主动退出或在设置中撤销设备后，需要重新登录。' }}</p>
        <p v-if="error" class="text-sm text-error" role="alert">{{ error }}</p>
        <button class="btn btn-primary w-full" type="submit" :disabled="busy">
          <span v-if="busy" class="loading loading-spinner loading-sm" aria-hidden="true" />
          <IconLogin v-else :size="20" aria-hidden="true" />
          {{ busy ? '登录中…' : '登录' }}
        </button>
        <p class="text-xs leading-relaxed text-base-content/55">使用部署时设置的管理员账户。共用设备请选择临时登录。</p>
      </div>
    </form>
  </main>
</template>
