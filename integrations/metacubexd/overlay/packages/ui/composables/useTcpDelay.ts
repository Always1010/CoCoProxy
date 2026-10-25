import { useWorkspace } from './useWorkspace'
import { coproxyErrorMessage } from './useCoproxy'

type TcpResult = {
  name: string
  fingerprint: string
  status: 'success' | 'timeout' | 'dns-failed' | 'refused' | 'unreachable' | 'cancelled' | 'not-applicable'
  delay: number | null
  checkedAt: string
}
type Entry = TcpResult | { status: 'testing' | 'error'; message?: string }
const pending = new Map<string, Promise<void>>()

export function useTcpDelay() {
  const { api, view } = useWorkspace()
  const results = useState<Record<string, Entry>>('coproxy-tcp-delay-results', () => ({}))
  const isRunning = ref(false)
  const completed = ref(0)
  const total = ref(0)
  let controller: AbortController | undefined
  const metadata = (name: string) => view.value?.tcpNodes?.find(node => node.name === name)
  const resultFor = (name: string) => {
    const node = metadata(name)
    return node ? results.value[node.fingerprint] : undefined
  }

  async function testNode(name: string, signal?: AbortSignal): Promise<void> {
    const node = metadata(name)
    const current = view.value
    if (!node?.applicable || !current || signal?.aborted) return
    const existing = pending.get(node.fingerprint)
    if (existing) return existing
    const session = api.session.value
    const task = (async () => {
      results.value[node.fingerprint] = { status: 'testing' }
      try {
        const result = await api.request<TcpResult>('/api/coproxy/workspace/tcp-delay', {
          method: 'POST', signal,
          body: { expectedRevision: current.workspace.revision, expectedActive: current.active, name, fingerprint: node.fingerprint },
        })
        if (api.session.value === session && !signal?.aborted && metadata(name)?.fingerprint === node.fingerprint)
          results.value[node.fingerprint] = result
      } catch (error) {
        if (api.session.value === session && !signal?.aborted)
          results.value[node.fingerprint] = { status: 'error', message: coproxyErrorMessage(error) }
      } finally {
        if (results.value[node.fingerprint]?.status === 'testing') delete results.value[node.fingerprint]
        pending.delete(node.fingerprint)
      }
    })()
    pending.set(node.fingerprint, task)
    return task
  }

  async function run(names: string[]) {
    if (isRunning.value) return
    const nodes = [...new Set(names)].filter(name => metadata(name)?.applicable)
    if (!nodes.length) return
    controller = new AbortController()
    const signal = controller.signal
    isRunning.value = true
    completed.value = 0
    total.value = nodes.length
    let index = 0
    try {
      await Promise.all(Array.from({ length: Math.min(4, nodes.length) }, async () => {
        while (!signal.aborted) {
          const name = nodes[index++]
          if (!name) break
          await testNode(name, signal)
          if (!signal.aborted) completed.value++
        }
      }))
    } finally { isRunning.value = false; controller = undefined }
  }
  const cancel = () => controller?.abort()
  onBeforeUnmount(cancel)
  return { metadata, resultFor, testNode, run, cancel, isRunning, completed, total }
}
