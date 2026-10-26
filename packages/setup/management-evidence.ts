import { createHash } from 'node:crypto';
import { request } from 'node:https';
import { canonicalJson, cloneConfigJson, type JsonObject } from '../config/index.ts';
import { renderDeploymentPlan } from '../deployment/plan.ts';
import type { EvidenceResult, EvidenceStatus } from './check-result.ts';

export class ManagementEvidenceError extends Error {
  readonly code: string;
  constructor(code = 'SETUP_MANAGEMENT_EVIDENCE_INVALID') { super(code); this.name = 'ManagementEvidenceError'; this.code = code; }
}
const need = (value: unknown): void => { if (!value) throw new ManagementEvidenceError(); };
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const ids = ['https-reachable', 'login', 'terminal-certificate-trust', 'browser-notification-capability', 'test-notification-displayed'] as const;
type Id = typeof ids[number];
type Binding = { originSha256: string; configurationSha256: string };
type Observed = { observedAt: number };
type OperatorEvidence = {
  schemaVersion: 1; binding: Binding; terminalId: string; recordedAt: number; notifications: 'selected' | 'declined' | 'undecided';
  https?: Observed & { pageLoaded: boolean };
  login?: Observed & { authenticated: boolean; logoutCompleted: boolean; anonymousApiDenied: boolean };
  certificate?: Observed & { warningShown: boolean; exceptionUsed: boolean };
  browser?: Observed & { secureContext: boolean; notificationApi: boolean; serviceWorker: boolean; pushManager: boolean;
    permission: 'default' | 'granted' | 'denied'; requiresInstalledApp: boolean; installedApp: boolean };
  notification?: Observed & { testRequestedAt: number; providerAccepted: boolean | null; displayedAt: number | null; notDisplayed: boolean };
};
export type ManagementEvidenceResult = EvidenceResult & {
  scope: 'invoking-node' | 'terminal'; subject: string | null; source: 'none' | 'operator-record' | 'node-https-probe';
  observedAt: number | null; binding: Binding; additionalObservations?: ManagementEvidenceResult[];
};
type ProbeCode = 'SETUP_MANAGEMENT_HTTPS_REACHABLE' | 'SETUP_MANAGEMENT_HTTPS_REQUIRED' | 'SETUP_MANAGEMENT_HTTPS_FAILED'
  | 'SETUP_MANAGEMENT_HTTPS_TIMEOUT' | 'SETUP_MANAGEMENT_HTTPS_RESPONSE_INVALID';
export interface ManagementEvidenceHost { now(): number; probeHttps(origin: string): Promise<ProbeCode> }

function record(value: unknown, required: string[], optional: string[] = []): Record<string, any> {
  need(value && typeof value === 'object' && !Array.isArray(value));
  const object = value as Record<string, unknown>;
  need(required.every(key => Object.hasOwn(object, key)) && Object.keys(object).every(key => [...required, ...optional].includes(key)));
  return object;
}
function time(value: unknown, now: number): asserts value is number { need(Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= now); }
function parseEvidence(raw: unknown, now: number): OperatorEvidence {
  const value = record(cloneConfigJson(raw), ['schemaVersion', 'binding', 'terminalId', 'recordedAt', 'notifications'],
    ['https', 'login', 'certificate', 'browser', 'notification']);
  need(value.schemaVersion === 1 && typeof value.terminalId === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(value.terminalId));
  need(['selected', 'declined', 'undecided'].includes(value.notifications));
  time(value.recordedAt, now);
  const binding = record(value.binding, ['originSha256', 'configurationSha256']);
  need(Object.values(binding).every(item => typeof item === 'string' && /^[a-f0-9]{64}$/.test(item)));
  for (const [key, fields] of [
    ['https', ['pageLoaded']], ['login', ['authenticated', 'logoutCompleted', 'anonymousApiDenied']],
    ['certificate', ['warningShown', 'exceptionUsed']],
    ['browser', ['secureContext', 'notificationApi', 'serviceWorker', 'pushManager', 'requiresInstalledApp', 'installedApp']],
    ['notification', ['notDisplayed']],
  ] as const) {
    if (!Object.hasOwn(value, key)) continue;
    const extra = key === 'browser' ? ['permission'] : key === 'notification' ? ['testRequestedAt', 'providerAccepted', 'displayedAt'] : [];
    const observation = record(value[key], ['observedAt', ...fields, ...extra]);
    time(observation.observedAt, value.recordedAt);
    need(fields.every(field => typeof observation[field] === 'boolean'));
    if (key === 'browser') need(['default', 'granted', 'denied'].includes(observation.permission));
    if (key === 'notification') {
      time(observation.testRequestedAt, observation.observedAt);
      need(observation.providerAccepted === null || typeof observation.providerAccepted === 'boolean');
      if (observation.displayedAt !== null) {
        time(observation.displayedAt, observation.observedAt);
        need(observation.displayedAt >= observation.testRequestedAt && !observation.notDisplayed && observation.providerAccepted !== false);
      }
    }
  }
  need(value.notifications !== 'declined' || !Object.hasOwn(value, 'notification'));
  return value as OperatorEvidence;
}

/** Fixed public GET only. No redirects, login, cookies, custom CA, TLS bypass or unbounded response. */
export async function probeManagementHttps(origin: string, transport: typeof request = request,
  timers: Pick<typeof globalThis, 'setTimeout' | 'clearTimeout'> = globalThis): Promise<ProbeCode> {
  if (new URL(origin).protocol !== 'https:') return 'SETUP_MANAGEMENT_HTTPS_REQUIRED';
  return new Promise(resolve => {
    let settled = false;
    let outgoing: ReturnType<typeof request> | undefined;
    const finish = (code: ProbeCode) => { if (!settled) { settled = true; timers.clearTimeout(timer); resolve(code); } };
    const timer = timers.setTimeout(() => { finish('SETUP_MANAGEMENT_HTTPS_TIMEOUT'); outgoing?.destroy(); }, 5000);
    try {
      outgoing = transport(new URL('/api/cocoproxy/health', origin), {
        method: 'GET', rejectUnauthorized: true, agent: false, headers: { accept: 'application/json' },
      }, response => {
        if (response.statusCode !== 200) { finish('SETUP_MANAGEMENT_HTTPS_RESPONSE_INVALID'); response.destroy(); return; }
        const chunks: Buffer[] = []; let length = 0;
        response.on('data', (chunk: Buffer) => {
          length += chunk.length;
          if (length > 2048) { finish('SETUP_MANAGEMENT_HTTPS_RESPONSE_INVALID'); response.destroy(); }
          else chunks.push(chunk);
        });
        response.on('error', () => finish('SETUP_MANAGEMENT_HTTPS_FAILED'));
        response.on('end', () => {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            finish(body?.responding === true && body?.scope === 'management_only' ? 'SETUP_MANAGEMENT_HTTPS_REACHABLE' : 'SETUP_MANAGEMENT_HTTPS_RESPONSE_INVALID');
          } catch { finish('SETUP_MANAGEMENT_HTTPS_RESPONSE_INVALID'); }
        });
      });
      outgoing.on('error', () => finish('SETUP_MANAGEMENT_HTTPS_FAILED'));
      outgoing.end();
    } catch { finish('SETUP_MANAGEMENT_HTTPS_FAILED'); outgoing?.destroy(); }
  });
}

const actions: Record<Id, string> = {
  'https-reachable': '显式执行 --probe-https 检查调用端，或记录指定终端实际打开页面的观察。',
  login: '在指定终端登录、检查匿名 API 拒绝访问并退出，再记录观察；不要提供密码或 Cookie。',
  'terminal-certificate-trust': '在指定终端检查证书警告及例外；服务器 SAN/密钥检查不能替代终端信任。',
  'browser-notification-capability': '在指定浏览器检查安全上下文、通知 API、Service Worker、PushManager、权限和主屏幕要求。',
  'test-notification-displayed': '从已配置通知的终端主动发送测试，并确认操作系统实际显示；服务接受不等于显示。',
};

/** Report observations, never manufacture terminal evidence from service or server certificate state. */
export async function createManagementEvidenceReport(deploymentInput: unknown, options: { evidence?: unknown; probeHttps?: boolean } = {},
  host: ManagementEvidenceHost = { now: Date.now, probeHttps: probeManagementHttps }) {
  const input = cloneConfigJson(deploymentInput) as JsonObject;
  renderDeploymentPlan(input);
  const origin = (input.management as JsonObject).origin as string;
  const binding: Binding = { originSha256: sha(origin), configurationSha256: sha(canonicalJson(input)) };
  const operator = options.evidence === undefined ? undefined : parseEvidence(options.evidence, host.now());
  const current = !operator || operator.binding.originSha256 === binding.originSha256 && operator.binding.configurationSha256 === binding.configurationSha256;
  const make = (id: Id, status: EvidenceStatus, code: string, reason: string, observedAt: number | null = null): ManagementEvidenceResult => ({
    id, status, code, reason, action: actions[id], scope: 'terminal', subject: operator?.terminalId ?? null,
    source: observedAt === null ? 'none' : 'operator-record', observedAt, binding: observedAt === null ? binding : operator?.binding ?? binding,
  });
  function observed(id: Id, observation: Observed | undefined, passed: boolean, success: string, failure: string) {
    if (!observation) return make(id, 'not-run', 'SETUP_MANAGEMENT_NOT_RUN', '尚未取得该项的独立终端观察。');
    if (!current) return make(id, 'unknown', 'SETUP_MANAGEMENT_EVIDENCE_BINDING_CHANGED', '观察对应的 origin 或部署配置已改变，需要重新核验。', observation.observedAt);
    return make(id, passed ? 'pass' : 'fail', passed ? 'SETUP_MANAGEMENT_OPERATOR_CONFIRMED' : 'SETUP_MANAGEMENT_OPERATOR_REPORTED_FAILURE', passed ? success : failure, observation.observedAt);
  }
  const https = observed('https-reachable', operator?.https, new URL(origin).protocol === 'https:' && operator?.https?.pageLoaded === true,
    '操作者记录此终端已打开 HTTPS 页面；这不单独证明登录或终端证书信任。', '操作者未能打开 HTTPS 页面，或当前入口未使用 HTTPS。');
  const login = observed('login', operator?.login, !!operator?.login?.authenticated && !!operator?.login?.logoutCompleted && !!operator?.login?.anonymousApiDenied,
    '操作者记录此终端已完成登录、匿名 API 拒绝访问和退出。', '操作者记录的登录、匿名访问限制或退出检查未全部通过。');
  const certificate = observed('terminal-certificate-trust', operator?.certificate, new URL(origin).protocol === 'https:' && operator?.certificate?.warningShown === false && operator?.certificate?.exceptionUsed === false,
    '操作者记录此终端未出现证书警告且未使用例外；这是终端人工声明。', '此终端出现证书警告、使用了证书例外，或当前入口未使用 HTTPS。');
  const browser = operator?.browser;
  const capability = observed('browser-notification-capability', browser,
    !!browser?.secureContext && !!browser.notificationApi && !!browser.serviceWorker && !!browser.pushManager && browser.permission === 'granted' && (!browser.requiresInstalledApp || browser.installedApp),
    '操作者记录此浏览器的通知能力、权限及主屏幕要求均满足；不证明实际送达。', '此浏览器的能力、权限或主屏幕要求尚未全部满足。');
  const notification = operator?.notification;
  let displayed = observed('test-notification-displayed', notification, notification?.displayedAt !== null && notification?.displayedAt !== undefined,
    '操作者记录操作系统已实际显示本次测试通知；这不是服务端送达证明。', '操作者确认本次测试通知尚未在操作系统显示。');
  if (notification && current && notification.displayedAt === null && !notification.notDisplayed) displayed = make('test-notification-displayed', 'unknown',
    'SETUP_MANAGEMENT_DISPLAY_NOT_CONFIRMED', notification.providerAccepted === true ? '仅记录推送服务已接受，尚无终端实际显示证据。' : '测试已请求，尚不能判断终端是否实际显示。', notification.observedAt);
  for (const result of [capability, displayed]) if (operator?.notifications === 'declined' && result.status === 'not-run') {
    result.status = current ? 'not-applicable' : 'unknown';
    result.code = current ? 'SETUP_MANAGEMENT_NOTIFICATIONS_DECLINED' : 'SETUP_MANAGEMENT_EVIDENCE_BINDING_CHANGED';
    result.reason = current ? '操作者明确未选择通知功能；不代表此终端已通过通知验收。' : '未选择通知的记录对应旧绑定，需要重新确认。';
    result.source = 'operator-record';
    result.observedAt = operator.recordedAt; result.binding = operator.binding;
  }
  let httpsResult = https;
  if (options.probeHttps) {
    let code: ProbeCode;
    try { code = await host.probeHttps(origin); } catch { code = 'SETUP_MANAGEMENT_HTTPS_FAILED'; }
    httpsResult = { ...make('https-reachable', code === 'SETUP_MANAGEMENT_HTTPS_REACHABLE' ? 'pass' : 'fail', code,
      code === 'SETUP_MANAGEMENT_HTTPS_REACHABLE' ? '调用端 Node 完成可信 TLS 及固定管理 health 响应检查；不证明任何浏览器的信任或登录。'
        : '调用端 Node 未通过可信 TLS 或固定管理 health 响应检查；此结果不判定指定浏览器的证书信任。', host.now()),
      scope: 'invoking-node', subject: 'current-process', source: 'node-https-probe', binding,
      ...(operator?.https ? { additionalObservations: [https] } : {}) };
  }
  return { schemaVersion: 1, readOnly: true, generatedAt: host.now(), binding,
    evidenceAuthenticity: 'operator records are self-reported observations, not cryptographic proof',
    checks: [httpsResult, login, certificate, capability, displayed] };
}
