/** Background reads retain existing data and report failures in the core banner. */
export function useProxyRefresh() {
  const proxies = useProxiesStore()
  const error = useState('cocoproxy-proxy-read-error', () => '')

  async function refresh() {
    try {
      await proxies.fetchProxies()
      error.value = ''
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : '无法读取核心代理数据，请重试。'
    }
  }

  return { error, refresh }
}
