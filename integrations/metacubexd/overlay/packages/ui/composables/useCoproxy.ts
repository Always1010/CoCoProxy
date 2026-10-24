export interface CoproxySession {
  authenticated: true
  username: string
  expiresAt: number
}

export interface CoproxyDraft {
  revision: number
  generation: string
  updatedAt: string
  policy: Record<string, unknown>
}

export interface CoproxySource {
  id: string
  revision: number
  snapshotRevision: number | null
  snapshotDigest: string | null
  snapshotCurrent: boolean
  lastAttempt: string | null
  lastError: string | null
}

export interface CoproxyCapture {
  generation: string
  stagedRevision: number
  sources: {
    id: string
    expectedRevision: number
    snapshotRevision: number
    snapshotDigest: string
  }[]
}

export interface CoproxyStatus {
  active: string | null
  desired: string | null
  transaction: { id: string; phase: string } | null
  fault: string | null
  checkedAt: string | null
  draft: Omit<CoproxyDraft, 'policy'> | null
  core: { ready: boolean; generation: string; checkedAt: string; reason?: string } | null
  gateway: { ready: false; reason: string }
}

const messages: Record<string, string> = {
  INVALID_CREDENTIALS: '用户名或密码不正确。',
  UNAUTHORIZED: '会话已失效，请重新登录。',
  LOGIN_RATE_LIMIT: '登录尝试过于频繁，请稍后重试。',
  SESSION_LIMIT: '会话数量已达上限，请稍后重试。',
  ORIGIN_DENIED: '当前访问地址未获允许。',
  DRAFT_CONFLICT: '草稿已被其他操作修改。编辑内容已保留，请检查后重新加载。',
  SOURCE_CONFLICT: '来源版本已变化，请重新读取来源后再操作。',
  ACTIVE_CONFLICT: '运行代次已变化。候选未被替换，请重新读取状态后再决定是否应用。',
  DEPLOYMENT_MISMATCH: '草稿或候选与当前部署不匹配。',
  RECOVERY_REQUIRED: '存在未完成事务，请先读取状态并执行恢复。',
  STORE_LOCKED: '另一项操作正在执行，请稍后重新读取状态。',
  INVALID_INPUT: '策略结构或字段值无效。',
  INVALID_JSON: '请输入有效的 JSON 对象。',
  PROTECTED_FIELD: '策略包含不允许编辑的部署、远程来源、脚本或文件字段。',
  NAME_CONFLICT: '节点、策略组或来源名称重复。',
  LIMIT_EXCEEDED: '策略超过大小、深度或数量限制。',
  BODY_LIMIT: '请求内容过大。',
  SOURCE_PENDING: '选中的来源尚无当前版本快照，请先刷新。',
  INVALID_SOURCE_ID: '来源标识须以字母开头，仅含字母、数字、下划线或连字符，最长 64 位。',
  INVALID_SOURCE_URL: '请输入有效的 HTTPS 订阅地址。',
  SOURCE_CLIENT_REQUIRED: '部署尚未配置订阅获取许可。',
  SOURCE_FETCH_FAILED: '获取订阅失败，已有快照已保留。',
  SNAPSHOT_DECODE_FAILED: '订阅内容无法解析。',
  SNAPSHOT_UNSUPPORTED: '订阅包含不支持的字段。',
  SNAPSHOT_INVALID: '订阅节点无效。',
  SNAPSHOT_LIMIT: '订阅超过大小或数量限制。',
  VALIDATION_FAILED: '核心配置校验失败，候选未应用。',
  ACTIVATION_FAILED: '核心激活失败，请读取当前状态。',
  CONFIRM_FAILED: '核心就绪确认失败，请读取当前状态。',
  RESTORE_FAILED: '恢复失败，请检查当前状态与部署。',
  NETWORK_UNKNOWN: '与服务的连接中断，操作结果未知；请重新读取状态，勿假定操作已停止。',
  MANAGEMENT_UNAVAILABLE: '管理服务暂时不可用，请重新读取状态。',
}

export class CoproxyError extends Error {
  constructor(readonly code: string, readonly status = 0) {
    super(messages[code] ?? '操作未完成，请检查输入并重新读取状态。')
    this.name = 'CoproxyError'
  }
}

export function coproxyErrorMessage(error: unknown): string {
  return error instanceof CoproxyError
    ? error.message
    : '操作未完成，请重新读取状态。'
}

export function useCoproxy() {
  const session = useState<CoproxySession | null>('coproxy-session', () => null)
  const generation = useState<string | null>('coproxy-generation', () => null)
  // Receipts survive page navigation, but never enter localStorage or a cookie.
  const capture = useState<CoproxyCapture | null>('coproxy-capture', () => null)

  function clearSession() {
    session.value = null
    generation.value = null
    capture.value = null
  }

  async function request<T>(path: string, options: {
    method?: 'GET' | 'POST' | 'PUT'
    body?: unknown
    redirectUnauthorized?: boolean
  } = {}): Promise<T> {
    let response: Response
    try {
      response = await fetch(path, {
        method: options.method ?? 'GET',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: options.body === undefined ? undefined : { 'content-type': 'application/json' },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      })
    } catch {
      throw new CoproxyError('NETWORK_UNKNOWN')
    }
    if (response.status === 401) {
      clearSession()
      if (options.redirectUnauthorized !== false)
        await navigateTo('/login', { replace: true })
    }
    let data: unknown
    try { data = await response.json() }
    catch {
      throw new CoproxyError(options.body === undefined ? 'MANAGEMENT_UNAVAILABLE' : 'NETWORK_UNKNOWN', response.status)
    }
    if (!response.ok) {
      const code = (data as { error?: { code?: unknown } })?.error?.code
      throw new CoproxyError(typeof code === 'string' ? code : 'MANAGEMENT_UNAVAILABLE', response.status)
    }
    return data as T
  }

  async function readSession() {
    try {
      session.value = await request<CoproxySession>('/api/session', { redirectUnauthorized: false })
      return session.value
    } catch (error) {
      if (error instanceof CoproxyError && error.status === 401) return null
      clearSession()
      throw error
    }
  }

  async function login(username: string, password: string) {
    session.value = await request<CoproxySession>('/api/session/login', {
      method: 'POST', body: { username, password }, redirectUnauthorized: false,
    })
  }

  async function logout() {
    await request('/api/session/logout', { method: 'POST', body: {} })
    clearSession()
    await navigateTo('/login', { replace: true })
  }

  async function readStatus() {
    const result = await request<CoproxyStatus>('/api/coproxy/status')
    generation.value = result.active
    return result
  }

  return { session, generation, capture, request, readSession, login, logout, readStatus, clearSession }
}
