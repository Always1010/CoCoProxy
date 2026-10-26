<script setup lang="ts">
import { IconBell, IconBellOff, IconRefresh, IconSend } from '@tabler/icons-vue'
import { CoCoProxyError, cocoproxyErrorMessage } from '~/composables/useCoCoProxy'
import { useNotifications, type NotificationPreferences } from '~/composables/useNotifications'

const notifications = useNotifications()
const { status, events, localSubscription, permission, platform, limitation } = notifications
const busy = ref(false), error = ref(''), feedback = ref('')
const preferences = ref<NotificationPreferences>({ groups: null, switches: true, recovery: true, outage: true, showNodes: false })
const deliveryMessage = (delivery: string) => ({ disabled: '未开启', subscribed: '已订阅', accepted: '推送服务已接受（不等于设备已显示）', retrying: '发送失败，服务器将自动重试', expired: '订阅已失效，请重新开启', PUSH_LIBRARY_UNAVAILABLE: '服务器通知组件加载失败，请联系管理员修复运行环境', PUSH_CONFIGURATION_ERROR: '服务器通知认证或加密配置异常' } as Record<string, string>)[delivery] ?? '发送异常，请测试并检查网络'
const deliveryText = computed(() => deliveryMessage(status.value?.delivery ?? 'disabled'))
const reasonText = (reason: string) => ({ 'failure-recovery': '故障切换', 'preferred-restored': '首选恢复回切', 'faster-candidate': '劣化切换', 'all-unavailable': '暂无可用候选', 'available-again': '恢复可用', test: '测试通知' } as Record<string, string>)[reason] ?? '自动切换'
async function run(action: () => Promise<void>) {
  if (busy.value) return
  busy.value = true; error.value = ''; feedback.value = ''
  try {
    await action()
    if (status.value) preferences.value = { ...status.value.preferences,
      groups: status.value.preferences.groups === null ? null : [...status.value.preferences.groups] }
  }
  catch (cause) { error.value = cause instanceof CoCoProxyError ? cocoproxyErrorMessage(cause) : cause instanceof Error ? cause.message : cocoproxyErrorMessage(cause) }
  finally { busy.value = false }
}
async function test() {
  const result = await notifications.test()
  if (result.delivery === 'accepted') feedback.value = '推送服务已接受测试通知，请确认此设备是否显示；系统实际显示仍受通知权限、勿扰模式和浏览器后台设置影响。'
  else if (result.delivery === 'retrying') feedback.value = '测试通知首次发送失败，服务器已进入自动重试；请稍后刷新发送状态。'
  else if (['PUSH_LIBRARY_UNAVAILABLE', 'PUSH_CONFIGURATION_ERROR', 'expired'].includes(result.delivery)) throw new Error(deliveryMessage(result.delivery))
  else feedback.value = result.queued ? '测试通知仍在发送队列中，请稍后刷新发送状态。' : deliveryMessage(result.delivery)
}
function toggleGroup(name: string) {
  const selected = preferences.value.groups ?? status.value?.groups ?? []
  preferences.value.groups = selected.includes(name) ? selected.filter(group => group !== name) : [...selected, name]
}
let refreshTimer: ReturnType<typeof setInterval> | undefined
onMounted(() => {
  void run(notifications.refresh)
  refreshTimer = setInterval(() => {
    if (!busy.value && document.visibilityState === 'visible') void notifications.refresh().catch(() => {})
  }, 15_000)
})
onUnmounted(() => clearInterval(refreshTimer))
</script>

<template>
  <section class="max-w-2xl rounded-xl border border-base-content/10 bg-base-200/60 p-4" aria-labelledby="notifications-title">
    <div class="flex items-center justify-between gap-2">
      <h2 id="notifications-title" class="text-base font-semibold">此设备的通知</h2>
      <button class="btn btn-ghost btn-sm" title="刷新通知状态" aria-label="刷新通知状态" :disabled="busy" @click="run(notifications.refresh)"><IconRefresh :size="18" /><span>刷新状态</span></button>
    </div>
    <p class="mt-2 text-sm">{{ platform }} · {{ deliveryText }}</p>
    <p class="mt-2 text-xs leading-relaxed text-base-content/60">Windows 优先使用 Edge / Chrome；iPad / iPhone 需要添加到主屏幕。Android 受推送通道和省电设置影响；Linux 桌面及桌面浏览器完全退出后的接收能力需实测。</p>
    <p v-if="limitation" class="mt-3 text-sm text-warning">{{ limitation }}</p>
    <p v-else-if="permission === 'denied'" class="mt-3 text-sm text-warning">系统通知权限已拒绝，请到浏览器或系统设置中修改。</p>
    <p v-if="status && !status.trusted" class="mt-3 text-sm text-warning">临时登录可查看事件。开启后台通知，请退出后选择“信任此设备”登录。</p>
    <p v-if="status && !status.supported" class="mt-3 text-sm text-error">服务器通知存储不可用，通知未启用；这不会影响代理选路。</p>
    <p v-if="status?.subscribed && !localSubscription" class="mt-3 text-sm text-warning">此浏览器的订阅需要修复，请重新开启通知。</p>
    <p v-if="error" class="mt-3 text-sm text-error" role="alert">{{ error }}</p>
    <p v-if="feedback" class="mt-3 text-sm text-success" role="status">{{ feedback }}</p>
    <p v-if="events[0]" class="mt-3 text-xs" aria-live="polite">最近事件：{{ events[0].group }} · {{ reasonText(events[0].reason) }} · {{ new Date(events[0].at).toLocaleTimeString() }}</p>
    <div class="mt-3 flex flex-wrap gap-2">
      <button class="btn btn-primary btn-sm" :disabled="busy || !!limitation || !status?.trusted || !status?.supported" @click="run(notifications.enable)"><IconBell :size="16" />{{ status?.subscribed && localSubscription ? '修复订阅' : '开启此设备通知' }}</button>
      <button v-if="status?.subscribed" class="btn btn-ghost btn-sm" title="关闭此设备通知" aria-label="关闭此设备通知" :disabled="busy" @click="run(notifications.disable)"><IconBellOff :size="18" /><span>关闭通知</span></button>
      <button v-if="status?.subscribed" class="btn btn-ghost btn-sm" title="发送测试通知" aria-label="发送测试通知" :disabled="busy || !localSubscription" @click="run(test)"><IconSend :size="18" /><span>发送测试</span></button>
    </div>
    <fieldset v-if="status?.subscribed" :disabled="busy" class="mt-4 flex flex-col gap-3 border-t border-base-content/10 pt-4">
      <legend class="text-sm">通知偏好</legend>
      <label class="flex items-center gap-2 text-sm"><input v-model="preferences.switches" type="checkbox" class="checkbox checkbox-sm" />自动故障／劣化切换</label>
      <label class="flex items-center gap-2 text-sm"><input v-model="preferences.recovery" type="checkbox" class="checkbox checkbox-sm" />首选回切与恢复</label>
      <label class="flex items-center gap-2 text-sm"><input v-model="preferences.outage" type="checkbox" class="checkbox checkbox-sm" />候选全部不可用</label>
      <label class="flex items-center gap-2 text-sm"><input v-model="preferences.showNodes" type="checkbox" class="checkbox checkbox-sm" />在锁屏通知中显示节点名称</label>
      <label class="flex items-center gap-2 text-sm"><input :checked="preferences.groups === null" type="checkbox" class="checkbox checkbox-sm" @change="preferences.groups = preferences.groups === null ? [] : null" />关注全部自动策略组（含以后新增）</label>
      <div v-if="preferences.groups !== null" class="flex flex-wrap gap-3">
        <label v-for="group in status.groups" :key="group" class="flex items-center gap-2 text-sm"><input :checked="preferences.groups.includes(group)" type="checkbox" class="checkbox checkbox-sm" @change="toggleGroup(group)" />{{ group }}</label>
      </div>
      <button class="btn btn-outline btn-sm self-start" @click="run(() => notifications.save(preferences))">保存通知偏好</button>
    </fieldset>
    <p class="mt-3 text-xs text-base-content/55">关闭页面不取消订阅；退出登录或撤销设备后停止新发送。已提交给推送服务的通知可能仍会到达。手机离开内网后可能收到提醒，但打开管理页面仍需能访问内网。</p>
    <details class="mt-4 border-t border-base-content/10 pt-3">
      <summary class="cursor-pointer text-sm">最近通知事件（{{ events.length }}）</summary>
      <p v-if="!events.length" class="mt-2 text-xs text-base-content/55">暂无事件。自动选择发生确认后的状态变化时会记录。</p>
      <ul class="mt-2 max-h-64 space-y-2 overflow-y-auto"><li v-for="event in events" :key="event.id" class="text-xs"><span class="text-base-content/55">{{ new Date(event.at).toLocaleString() }}</span> · {{ event.group }} · {{ reasonText(event.reason) }}</li></ul>
    </details>
  </section>
</template>
