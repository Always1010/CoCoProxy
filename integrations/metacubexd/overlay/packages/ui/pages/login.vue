<script setup lang="ts">
import { IconLock, IconLogin } from '@tabler/icons-vue'
import { cocoproxyErrorMessage, useCoCoProxy } from '~/composables/useCoCoProxy'

definePageMeta({ layout: false })
const { t } = useI18n()
useHead({ title: computed(() => t('coco.pzSignInCocoproxy')) })
const { login } = useCoCoProxy()
const username = ref('')
const password = ref('')
const remember = ref(true)
const trust = ref<'90days' | 'until-revoked'>('until-revoked')
const busy = ref(false)
const errorSource = shallowRef<(() => string) | null>(null)
const error = computed(() => errorSource.value?.() ?? '')

async function submit() {
  if (busy.value) return
  busy.value = true
  errorSource.value = null
  try {
    await login(username.value, password.value, remember.value ? trust.value : 'none')
    await navigateTo('/overview', { replace: true })
  } catch (cause) {
    errorSource.value = () => cocoproxyErrorMessage(cause, t)
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
          <div><h1 class="text-2xl font-bold">CoCoProxy</h1><p class="text-sm text-base-content/65">{{ t('coco.pzManagementSignIn') }}</p></div>
        </div>
        <label class="flex flex-col gap-2 text-sm" for="cocoproxy-username">
          {{ t('coco.pzUsername') }}
          <input id="cocoproxy-username" v-model="username" class="input input-bordered w-full" autocomplete="username" required maxlength="64" :disabled="busy" />
        </label>
        <label class="flex flex-col gap-2 text-sm" for="cocoproxy-password">
          {{ t('coco.pzPassword') }}
          <input id="cocoproxy-password" v-model="password" class="input input-bordered w-full" type="password" autocomplete="current-password" required :disabled="busy" />
        </label>
        <label class="flex min-h-11 items-center gap-3 text-sm" for="cocoproxy-remember">
          <input id="cocoproxy-remember" v-model="remember" type="checkbox" class="checkbox checkbox-primary" :disabled="busy" />
          {{ t('coco.pzRememberSignIn') }}
        </label>
        <details v-if="remember" class="text-sm">
          <summary class="cursor-pointer py-2 text-base-content/65">{{ t('coco.pzSignInOptions') }}</summary>
          <label class="mt-2 flex flex-col gap-2" for="cocoproxy-trust">
            {{ t('coco.pzSessionPersistence') }}
            <select id="cocoproxy-trust" v-model="trust" class="select select-bordered w-full" :disabled="busy">
              <option value="until-revoked">{{ t('coco.pzTrustThisDeviceIndefinitely') }}</option>
              <option value="90days">{{ t('coco.pzTrustForDaysRenewedWhenUsed') }}</option>
            </select>
          </label>
        </details>
        <p class="text-xs leading-relaxed text-base-content/55">{{ remember ? t('coco.pzThisDeviceWillSignInAutomaticallyIncludingAfterManagement') : t('coco.pzTemporarySessionsExpireAfterHoursOrWhenTheManagement') }}</p>
        <p v-if="error" class="text-sm text-error" role="alert">{{ error }}</p>
        <button class="btn btn-primary w-full" type="submit" :disabled="busy">
          <span v-if="busy" class="loading loading-spinner loading-sm" aria-hidden="true" />
          <IconLogin v-else :size="20" aria-hidden="true" />
          {{ busy ? t('coco.pzSigningIn') : t('coco.pzSignIn') }}
        </button>
        <p class="text-xs leading-relaxed text-base-content/55">{{ t('coco.pzUseTheAdministratorAccountConfiguredDuringDeploymentChooseTemporary') }}</p>
      </div>
    </form>
  </main>
</template>
