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
  SITE_SETTINGS_INVALID: 'coco.errorSITE_SETTINGS_INVALID',
  SITE_SETTINGS_CONFLICT: 'coco.errorSITE_SETTINGS_CONFLICT',
  SITE_SETTINGS_CORRUPT: 'coco.errorSITE_SETTINGS_CORRUPT',
  SITE_TARGET_DENIED: 'coco.errorSITE_TARGET_DENIED',
  SITE_TARGET_DUPLICATE: 'coco.errorSITE_TARGET_DUPLICATE',
  SITE_TARGET_IN_USE: 'coco.errorSITE_TARGET_IN_USE',
  AUTO_SETTINGS_INVALID: 'coco.errorAUTO_SETTINGS_INVALID',
  AUTO_GROUP_INVALID: 'coco.errorAUTO_GROUP_INVALID',
  AUTO_STATE_CONFLICT: 'coco.errorAUTO_STATE_CONFLICT',
  AUTO_STATE_CORRUPT: 'coco.errorAUTO_STATE_CORRUPT',
  AUTO_HISTORY_CORRUPT: 'coco.errorAUTO_HISTORY_CORRUPT',
  AUTO_PROBE_DENIED: 'coco.errorAUTO_PROBE_DENIED',
  AUTO_PROBE_UNAVAILABLE: 'coco.errorAUTO_PROBE_UNAVAILABLE',
  AUTO_PROBE_BUSY: 'coco.errorAUTO_PROBE_BUSY',
  RULE_TEST_TARGET_INVALID: 'coco.errorRULE_TEST_TARGET_INVALID',
  RULE_TEST_INPUT_INVALID: 'coco.errorRULE_TEST_INPUT_INVALID',
  RULE_TEST_UNAVAILABLE: 'coco.errorRULE_TEST_UNAVAILABLE',
  RULE_TEST_DNS_FAILED: 'coco.errorRULE_TEST_DNS_FAILED',
  RULE_TEST_BUSY: 'coco.errorRULE_TEST_BUSY',
  INVALID_CREDENTIALS: 'coco.errorINVALID_CREDENTIALS',
  UNAUTHORIZED: 'coco.errorUNAUTHORIZED',
  LOGIN_RATE_LIMIT: 'coco.errorLOGIN_RATE_LIMIT',
  SESSION_LIMIT: 'coco.errorSESSION_LIMIT',
  DEVICE_LIMIT: 'coco.errorDEVICE_LIMIT',
  DEVICE_LABEL_REQUIRED: 'coco.errorDEVICE_LABEL_REQUIRED',
  DEVICE_LABEL_INVALID: 'coco.errorDEVICE_LABEL_INVALID',
  DEVICE_LABEL_DUPLICATE: 'coco.errorDEVICE_LABEL_DUPLICATE',
  DEVICE_NOT_FOUND: 'coco.errorDEVICE_NOT_FOUND',
  USAGE_UNAVAILABLE: 'coco.errorUSAGE_UNAVAILABLE',
  USAGE_QUERY_INVALID: 'coco.errorUSAGE_QUERY_INVALID',
  USAGE_DETAIL_EXPIRED: 'coco.errorUSAGE_DETAIL_EXPIRED',
  USAGE_RANGE_EXPIRED: 'coco.errorUSAGE_RANGE_EXPIRED',
  USAGE_SCHEMA_UNSUPPORTED: 'coco.errorUSAGE_SCHEMA_UNSUPPORTED',
  USAGE_ALIAS_INVALID: 'coco.errorUSAGE_ALIAS_INVALID',
  USAGE_ALIAS_LIMIT: 'coco.errorUSAGE_ALIAS_LIMIT',
  DEVICE_TRUST_UNAVAILABLE: 'coco.errorDEVICE_TRUST_UNAVAILABLE',
  ORIGIN_DENIED: 'coco.errorORIGIN_DENIED',
  DRAFT_CONFLICT: 'coco.errorDRAFT_CONFLICT',
  SOURCE_CONFLICT: 'coco.errorSOURCE_CONFLICT',
  WORKSPACE_CONFLICT: 'coco.errorWORKSPACE_CONFLICT',
  TCP_NODE_CONFLICT: 'coco.errorTCP_NODE_CONFLICT',
  TCP_PROBE_BUSY: 'coco.errorTCP_PROBE_BUSY',
  WORKSPACE_PENDING: 'coco.errorWORKSPACE_PENDING',
  WORKSPACE_INVALID: 'coco.errorWORKSPACE_INVALID',
  WORKSPACE_CORRUPT: 'coco.errorWORKSPACE_CORRUPT',
  WORKSPACE_UNAVAILABLE: 'coco.errorWORKSPACE_UNAVAILABLE',
  SELECTION_UNCONFIRMED: 'coco.errorSELECTION_UNCONFIRMED',
  GROUP_REFERENCE_INVALID: 'coco.errorGROUP_REFERENCE_INVALID',
  GROUP_SELECTION_CONFLICT: 'coco.errorGROUP_SELECTION_CONFLICT',
  GROUP_SELECTION_UNSUPPORTED: 'coco.errorGROUP_SELECTION_UNSUPPORTED',
  PROFILE_REQUIRED: 'coco.errorPROFILE_REQUIRED',
  PROFILE_RULES_REQUIRED: 'coco.errorPROFILE_RULES_REQUIRED',
  PROFILE_NO_PROXY: 'coco.errorPROFILE_NO_PROXY',
  INVALID_WORKSPACE: 'coco.errorINVALID_WORKSPACE',
  SOURCE_IN_USE: 'coco.errorSOURCE_IN_USE',
  SOURCE_REQUIRED: 'coco.errorSOURCE_REQUIRED',
  SOURCE_NOT_FOUND: 'coco.errorSOURCE_NOT_FOUND',
  SOURCE_PROFILE_REQUIRED: 'coco.errorSOURCE_PROFILE_REQUIRED',
  ACTIVE_CONFLICT: 'coco.errorACTIVE_CONFLICT',
  DEPLOYMENT_MISMATCH: 'coco.errorDEPLOYMENT_MISMATCH',
  RECOVERY_REQUIRED: 'coco.errorRECOVERY_REQUIRED',
  STORE_LOCKED: 'coco.errorSTORE_LOCKED',
  INVALID_INPUT: 'coco.errorINVALID_INPUT',
  INVALID_JSON: 'coco.errorINVALID_JSON',
  PROTECTED_FIELD: 'coco.errorPROTECTED_FIELD',
  NAME_CONFLICT: 'coco.errorNAME_CONFLICT',
  LIMIT_EXCEEDED: 'coco.errorLIMIT_EXCEEDED',
  BODY_LIMIT: 'coco.errorBODY_LIMIT',
  SOURCE_PENDING: 'coco.errorSOURCE_PENDING',
  INVALID_SOURCE_ID: 'coco.errorINVALID_SOURCE_ID',
  INVALID_SOURCE_URL: 'coco.errorINVALID_SOURCE_URL',
  AUTOMATIC_GATEWAY_CONFIG_INVALID: 'coco.errorAUTOMATIC_GATEWAY_CONFIG_INVALID',
  SOURCE_CLIENT_REQUIRED: 'coco.errorSOURCE_CLIENT_REQUIRED',
  SOURCE_FETCH_FAILED: 'coco.errorSOURCE_FETCH_FAILED',
  SNAPSHOT_DECODE_FAILED: 'coco.errorSNAPSHOT_DECODE_FAILED',
  SNAPSHOT_UNSUPPORTED: 'coco.errorSNAPSHOT_UNSUPPORTED',
  SNAPSHOT_INVALID: 'coco.errorSNAPSHOT_INVALID',
  SNAPSHOT_LIMIT: 'coco.errorSNAPSHOT_LIMIT',
  VALIDATION_FAILED: 'coco.errorVALIDATION_FAILED',
  ACTIVATION_FAILED: 'coco.errorACTIVATION_FAILED',
  CONFIRM_FAILED: 'coco.errorCONFIRM_FAILED',
  RESTORE_FAILED: 'coco.errorRESTORE_FAILED',
  NETWORK_UNKNOWN: 'coco.errorNETWORK_UNKNOWN',
  MANAGEMENT_UNAVAILABLE: 'coco.errorMANAGEMENT_UNAVAILABLE',
}

export class CoCoProxyError extends Error {
  constructor(readonly code: string, readonly status = 0) {
    super(code)
    this.name = 'CoCoProxyError'
  }
}

export function cocoproxyErrorMessage(error: unknown, t: (key: string) => string): string {
  return error instanceof CoCoProxyError
    ? t(messages[error.code] ?? 'coco.operationFailed')
    : t('coco.operationUnknown')
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
    useState('cocoproxy-workspace-message-params').value = {}
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
    headers?: Record<string, string>
  } = {}): Promise<T> {
    let response: Response
    try {
      response = await fetch(path, {
        method: options.method ?? 'GET',
        credentials: 'same-origin',
        cache: 'no-store',
        signal: options.signal,
        headers: { ...options.headers, ...(options.body === undefined ? {} : { 'content-type': 'application/json' }) },
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
