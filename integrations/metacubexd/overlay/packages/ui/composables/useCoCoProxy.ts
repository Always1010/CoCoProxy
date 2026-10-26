export interface CoCoProxySession {
  authenticated: true
  username: string
  expiresAt: number
}

export interface CoCoProxyDraft {
  revision: number
  generation: string
  updatedAt: string
  policy: Record<string, unknown>
}

export interface CoCoProxySource {
  id: string
  revision: number
  snapshotRevision: number | null
  snapshotDigest: string | null
  snapshotCurrent: boolean
  lastAttempt: string | null
  lastError: string | null
}

export interface CoCoProxyCapture {
  generation: string
  stagedRevision: number
  sources: {
    id: string
    expectedRevision: number
    snapshotRevision: number
    snapshotDigest: string
  }[]
}

export interface CoCoProxyStatus {
  active: string | null
  desired: string | null
  transaction: { id: string; phase: string } | null
  fault: string | null
  checkedAt: string | null
  draft: Omit<CoCoProxyDraft, 'policy'> | null
  core: { ready: boolean; generation: string; checkedAt: string; reason?: string } | null
  gateway: { ready: false; reason: string; profile?: 'mihomo-automatic'; terminalPath?: 'unverified' }
}

const messages: Record<string, string> = {
  SITE_SETTINGS_INVALID: '站点设置无效。请使用公开 HTTPS 网址，不含账号、查询参数、片段或自定义端口；每组最多选择 16 项。',
  SITE_SETTINGS_CONFLICT: '站点设置或当前方案已变化，请重新读取后保存。',
  SITE_SETTINGS_CORRUPT: '站点设置无法读取，请检查服务存储。',
  SITE_TARGET_DENIED: '当前部署限制了此检测来源，尚未保存。请先配置允许的探测来源，或取消受限目标。',
  SITE_TARGET_DUPLICATE: '此检测网址已在站点目录中，请选择已有站点。',
  SITE_TARGET_IN_USE: '其他组或方案仍选用了此站点，请先取消对应选择，再删除。',
  AUTO_SETTINGS_INVALID: '自动选择设置无效，请检查候选节点和检测参数。',
  AUTO_GROUP_INVALID: '此策略组不支持自动选择，或候选节点已变化，请刷新后重试。',
  AUTO_STATE_CONFLICT: '自动选择运行状态已变化，请刷新后重试。',
  AUTO_STATE_CORRUPT: '自动选择运行记录无法读取，请检查服务存储。',
  AUTO_HISTORY_CORRUPT: '自动选择历史无法读取，请检查服务存储。',
  AUTO_PROBE_DENIED: '检测网址来源未获当前部署许可，请联系管理员配置。',
  AUTO_PROBE_UNAVAILABLE: '当前无法通过具体节点检测，请先选择可用节点并确认核心就绪。',
  AUTO_PROBE_BUSY: '另一项检测正在执行，请稍后重试。',
  RULE_TEST_TARGET_INVALID: '请输入有效的域名或 IP，不要包含网址路径或端口。',
  RULE_TEST_INPUT_INVALID: '请检查协议、IP 和端口；端口范围为 1–65535。',
  RULE_TEST_UNAVAILABLE: '当前核心或生效规则暂不可用，请稍后重试。',
  RULE_TEST_DNS_FAILED: '核心 DNS 解析失败，暂无法判断 IP 规则。',
  RULE_TEST_BUSY: '规则测试任务较多，请稍后重试。',
  INVALID_CREDENTIALS: '用户名或密码不正确。',
  UNAUTHORIZED: '会话已失效，请重新登录。',
  LOGIN_RATE_LIMIT: '登录尝试过于频繁，请稍后重试。',
  SESSION_LIMIT: '会话数量已达上限，请稍后重试。',
  DEVICE_LIMIT: '已信任设备数量已达上限，请先撤销不再使用的设备。',
  DEVICE_TRUST_UNAVAILABLE: '此管理入口暂不支持信任设备，请使用临时登录。',
  ORIGIN_DENIED: '当前访问地址未获允许。',
  DRAFT_CONFLICT: '配置已被其他操作修改，请刷新后重试。',
  SOURCE_CONFLICT: '来源版本已变化，请重新读取来源后再操作。',
  WORKSPACE_CONFLICT: '配置已被其他操作修改，请刷新后重试。',
  TCP_NODE_CONFLICT: '节点配置已变化，请刷新后重新测试。',
  TCP_PROBE_BUSY: 'TCP 测试任务较多，请稍后重试。',
  WORKSPACE_PENDING: '请先应用待生效的配置，再切换节点。',
  WORKSPACE_INVALID: '配置内容无效，请检查策略组和规则。',
  WORKSPACE_CORRUPT: '配置无法读取，请检查服务存储。',
  WORKSPACE_UNAVAILABLE: '配置暂时无法读取，请稍后刷新。',
  SELECTION_UNCONFIRMED: '尚未确认核心已切换，请刷新查看当前出口。',
  GROUP_REFERENCE_INVALID: '策略组引用无效，请检查组间关联。',
  GROUP_SELECTION_CONFLICT: '策略选项已变化，请刷新后重新选择。',
  GROUP_SELECTION_UNSUPPORTED: '此策略组自动选择节点。',
  PROFILE_REQUIRED: '请先选择一个订阅配置。',
  PROFILE_RULES_REQUIRED: '此订阅没有规则，请使用本地规则模板。',
  PROFILE_NO_PROXY: '订阅配置没有可用的代理策略组。',
  INVALID_WORKSPACE: '配置内容无效，请检查选项后重试。',
  SOURCE_IN_USE: '订阅正在使用，请先切换到另一个订阅。',
  SOURCE_REQUIRED: '请选择一个可用订阅；当前订阅只能切换，不能取消。',
  SOURCE_NOT_FOUND: '订阅已被删除，请刷新后重试。',
  SOURCE_PROFILE_REQUIRED: '此订阅仅包含节点，请选择完整订阅配置。',
  ACTIVE_CONFLICT: '运行配置已变化，请刷新后重试。',
  DEPLOYMENT_MISMATCH: '配置与当前部署不匹配。',
  RECOVERY_REQUIRED: '配置切换未完成，请到设置中恢复。',
  STORE_LOCKED: '另一项操作正在执行，请稍后重新读取状态。',
  INVALID_INPUT: '配置内容无效，请检查后重试。',
  INVALID_JSON: '请输入有效的 JSON 对象。',
  PROTECTED_FIELD: '策略包含不允许编辑的部署、远程来源、脚本或文件字段。',
  NAME_CONFLICT: '节点、策略组或来源名称重复。',
  LIMIT_EXCEEDED: '策略超过大小、深度或数量限制。',
  BODY_LIMIT: '请求内容过大。',
  SOURCE_PENDING: '选中的订阅需要更新，请先刷新订阅。',
  INVALID_SOURCE_ID: '来源标识须以字母开头，仅含字母、数字、下划线或连字符，最长 64 位。',
  INVALID_SOURCE_URL: '请输入有效的 HTTP 或 HTTPS 订阅地址。',
  AUTOMATIC_GATEWAY_CONFIG_INVALID: '网关部署与当前配置不匹配，请核对部署设置。',
  SOURCE_CLIENT_REQUIRED: '部署尚未配置订阅获取许可。',
  SOURCE_FETCH_FAILED: '更新订阅失败，已保留原有内容。',
  SNAPSHOT_DECODE_FAILED: '订阅内容无法解析。',
  SNAPSHOT_UNSUPPORTED: '订阅包含不支持的字段。',
  SNAPSHOT_INVALID: '订阅节点无效。',
  SNAPSHOT_LIMIT: '订阅超过大小或数量限制。',
  VALIDATION_FAILED: '配置校验失败，请检查选项后重试。',
  ACTIVATION_FAILED: '核心激活失败，请读取当前状态。',
  CONFIRM_FAILED: '核心就绪确认失败，请读取当前状态。',
  RESTORE_FAILED: '恢复失败，请检查当前状态与部署。',
  NETWORK_UNKNOWN: '与服务的连接中断，操作结果未知；请重新读取状态，勿假定操作已停止。',
  MANAGEMENT_UNAVAILABLE: '管理服务暂时不可用，请重新读取状态。',
}

export class CoCoProxyError extends Error {
  constructor(readonly code: string, readonly status = 0) {
    super(messages[code] ?? '操作未完成，请检查输入并重新读取状态。')
    this.name = 'CoCoProxyError'
  }
}

export function cocoproxyErrorMessage(error: unknown): string {
  return error instanceof CoCoProxyError
    ? error.message
    : '操作未完成，请重新读取状态。'
}

export function useCoCoProxy() {
  const session = useState<CoCoProxySession | null>('cocoproxy-session', () => null)
  const generation = useState<string | null>('cocoproxy-generation', () => null)
  // Receipts survive page navigation, but never enter localStorage or a cookie.
  const capture = useState<CoCoProxyCapture | null>('cocoproxy-capture', () => null)

  function clearSession() {
    session.value = null
    generation.value = null
    capture.value = null
    useState('cocoproxy-workspace').value = null
    useState('cocoproxy-workspace-error').value = ''
    useState('cocoproxy-workspace-feedback').value = ''
    useState('cocoproxy-workspace-operation').value = ''
    useState('cocoproxy-latency-feedback').value = {}
    useState('cocoproxy-proxy-read-error').value = ''
    useState('cocoproxy-proxy-workbenches').value = {}
    useState('cocoproxy-tcp-delay-results').value = {}
  }

  async function request<T>(path: string, options: {
    method?: 'GET' | 'POST' | 'PUT' | 'DELETE'
    body?: unknown
    redirectUnauthorized?: boolean
    signal?: AbortSignal
  } = {}): Promise<T> {
    let response: Response
    try {
      response = await fetch(path, {
        method: options.method ?? 'GET',
        credentials: 'same-origin',
        cache: 'no-store',
        signal: options.signal,
        headers: options.body === undefined ? undefined : { 'content-type': 'application/json' },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      })
    } catch {
      throw new CoCoProxyError('NETWORK_UNKNOWN')
    }
    if (response.status === 401) {
      clearSession()
      if (options.redirectUnauthorized !== false)
        await navigateTo('/login', { replace: true })
    }
    let data: unknown
    try { data = await response.json() }
    catch {
      throw new CoCoProxyError(options.body === undefined ? 'MANAGEMENT_UNAVAILABLE' : 'NETWORK_UNKNOWN', response.status)
    }
    if (!response.ok) {
      const code = (data as { error?: { code?: unknown } })?.error?.code
      throw new CoCoProxyError(typeof code === 'string' ? code : 'MANAGEMENT_UNAVAILABLE', response.status)
    }
    return data as T
  }

  async function readSession() {
    try {
      session.value = await request<CoCoProxySession>('/api/session', { redirectUnauthorized: false })
      return session.value
    } catch (error) {
      if (error instanceof CoCoProxyError && error.status === 401) return null
      clearSession()
      throw error
    }
  }

  async function login(username: string, password: string, trust: 'none' | '90days' | 'until-revoked' = 'none', deviceLabel?: string) {
    session.value = await request<CoCoProxySession>('/api/session/login', {
      method: 'POST', body: { username, password, trust, ...(deviceLabel?.trim() ? { deviceLabel: deviceLabel.trim() } : {}) }, redirectUnauthorized: false,
    })
  }

  async function logout() {
    await request('/api/session/logout', { method: 'POST', body: {} })
    clearSession()
    await navigateTo('/login', { replace: true })
  }

  async function readStatus() {
    const result = await request<CoCoProxyStatus>('/api/cocoproxy/status')
    generation.value = result.active
    return result
  }

  return { session, generation, capture, request, readSession, login, logout, readStatus, clearSession }
}
