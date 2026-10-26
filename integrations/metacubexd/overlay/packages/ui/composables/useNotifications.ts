export type NotificationPreferences = { groups: string[] | null; switches: boolean; recovery: boolean; outage: boolean; showNodes: boolean }
export type NotificationStatus = { supported: boolean; trusted: boolean; publicKey: string | null; subscribed: boolean; preferences: NotificationPreferences; delivery: string; pending: number; lastAt: number | null; groups: string[]; error: string | null }
export type NotificationEvent = { id: string; at: number; group: string; reason: string }

export function useNotifications() {
  const api = useCoCoProxy()
  const status = ref<NotificationStatus | null>(null)
  const events = ref<NotificationEvent[]>([])
  const localSubscription = ref(false)
  const permission = ref<NotificationPermission | 'unsupported'>('unsupported')
  const platform = ref('')
  const limitation = ref('')
  async function refresh() {
    const ua = navigator.userAgent
    const apple = /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)
    platform.value = apple ? 'iPhone / iPad' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux 桌面' : '当前浏览器'
    const standalone = matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone
    limitation.value = !window.isSecureContext ? '通知需要可信 HTTPS。请先核对证书信任，忽略证书警告不等于支持推送。'
      : apple && !standalone ? '请先使用浏览器的“添加到主屏幕”，再从桌面 CoCoProxy 图标打开并开启通知。'
        : !('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window) ? '当前浏览器不支持后台推送，可继续查看下方事件记录。'
          : ''
    permission.value = 'Notification' in window ? Notification.permission : 'unsupported'
    const [state, history] = await Promise.all([
      api.request<NotificationStatus>('/api/cocoproxy/notifications/status'),
      api.request<{ events: NotificationEvent[] }>('/api/cocoproxy/notifications/events'),
    ])
    status.value = state; events.value = history.events
    if ('serviceWorker' in navigator) {
      const registration = await navigator.serviceWorker.getRegistration()
      const sub = await registration?.pushManager.getSubscription()
      localSubscription.value = !!sub && (!state.publicKey || keyText(sub.options.applicationServerKey) === state.publicKey)
    }
  }
  function keyText(key: ArrayBuffer | null) {
    return key ? btoa(String.fromCharCode(...new Uint8Array(key))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') : ''
  }
  async function enable() {
    if (limitation.value) throw new Error(limitation.value)
    if (!status.value?.trusted) throw new Error('请先以可信设备方式登录，再开启后台通知。')
    // Permission is requested directly from the user gesture, before network awaits.
    const granted = await Notification.requestPermission()
    permission.value = granted
    if (granted !== 'granted') throw new Error('系统尚未允许通知，请在浏览器或系统通知设置中开启。')
    const { publicKey } = await api.request<{ publicKey: string }>('/api/cocoproxy/notifications/initialize', { method: 'POST', body: {} })
    const workerUrl = new URL('/cocoproxy-sw.js', location.origin).href
    const registration = await navigator.serviceWorker.register(workerUrl, { scope: '/', updateViaCache: 'none' })
    await new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(() => { clearInterval(check); reject(new Error('通知组件尚未生效，请关闭后台的所有窗口后重新打开，再重试。')) }, 10_000)
      const check = setInterval(() => {
        if (registration.active?.scriptURL === workerUrl) { clearInterval(check); clearTimeout(deadline); resolve() }
      }, 100)
    })
    let subscription = await registration.pushManager.getSubscription()
    if (subscription && keyText(subscription.options.applicationServerKey) !== publicKey) { await subscription.unsubscribe(); subscription = null }
    if (!subscription) {
      const key = Uint8Array.from(atob(publicKey.replace(/-/g, '+').replace(/_/g, '/')), char => char.charCodeAt(0))
      subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key })
    }
    await api.request('/api/cocoproxy/notifications/subscription', { method: 'POST', body: { subscription: subscription.toJSON() } })
    registration.active?.postMessage({ type: 'NOTIFICATIONS_ENABLED' })
    await refresh()
  }
  async function disable() {
    await api.request('/api/cocoproxy/notifications/unsubscribe', { method: 'POST', body: {} })
    const registration = await navigator.serviceWorker.getRegistration()
    registration?.active?.postMessage({ type: 'NOTIFICATIONS_DISABLED' })
    await (await registration?.pushManager.getSubscription())?.unsubscribe()
    await refresh()
  }
  async function save(preferences: NotificationPreferences) {
    await api.request('/api/cocoproxy/notifications/preferences', { method: 'PUT', body: preferences }); await refresh()
  }
  async function test() {
    await api.request('/api/cocoproxy/notifications/test', { method: 'POST', body: {} }); await refresh()
  }
  return { status, events, localSubscription, permission, platform, limitation, refresh, enable, disable, save, test }
}
