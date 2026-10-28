/** Background reads retain existing data and report failures in the core banner. */
export function useProxyRefresh() {
  const { t } = useNuxtApp().$i18n
  const proxies = useProxiesStore()
  const message = useState('cocoproxy-proxy-read-error', () => '')
  const error = computed(() => message.value.startsWith('coco.') ? t(message.value) : message.value)

  async function refresh() {
    try {
      await proxies.fetchProxies()
      message.value = ''
    } catch (cause) {
      message.value = cause instanceof Error
        ? 'messageKey' in cause && typeof cause.messageKey === 'string' ? cause.messageKey : cause.message
        : 'coco.proxyReadFailed'
    }
  }

  return { error, refresh }
}
