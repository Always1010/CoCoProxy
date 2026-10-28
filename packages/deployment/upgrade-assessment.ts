import { createHash } from 'node:crypto';
import { canonicalJson, compileConfig, type JsonObject } from '../config/index.ts';
import { parseStoredCandidate, parseTransactionState } from '../transaction/index.ts';
import { parseRuntimeSelection, parseRuntimeSettings, recompileRuntimeCandidate } from '../runtime/settings.ts';
import type { RuntimeSettings } from '../runtime/types.ts';
import { parseAdminCredential } from '../management/auth.ts';
import { managementOrigin } from '../management/http.ts';
import { SUBSCRIPTION_SOURCE_LIMIT, SUBSCRIPTION_INVENTORY_LIMIT, isSubscriptionTemporaryName } from '../subscriptions/index.ts';
import { posix } from 'node:path';
import { assessStateContent, DEPLOYMENT_STATE_FILES, DEPLOYMENT_STATE_COMPATIBILITY,
  type CompatibilityStatus, type StateStore, type StateContentAssessment } from './compatibility.ts';

export interface CompatibilityCheck {
  status: CompatibilityStatus; code: string; scope: string; reason: string; conditions: string[];
  checks?: CompatibilityCheck[];
}
export interface UpgradeStateHost {
  /** Caller enforces trusted ancestors, private ownership and bounded regular-file reads. */
  read(relative: string, maximum: number): Promise<string | null>;
  list(relative: string): Promise<string[] | null>;
  usage?(): Promise<{ schemaVersion: number; integrity: 'ok' } | null>;
}
export interface StateObservation {
  store: StateStore; sourceId?: string; presence: 'present' | 'absent' | 'unavailable'; value?: unknown;
  assessment: StateContentAssessment;
}
const check = (status: CompatibilityStatus, code: string, scope: string, reason: string, conditions: string[] = [],
  checks?: CompatibilityCheck[]): CompatibilityCheck => ({ status, code, scope, reason, conditions, ...(checks ? { checks } : {}) });
const aggregate = (checks: readonly { status: CompatibilityStatus }[]): CompatibilityStatus =>
  checks.some(item => item.status === 'unsupported') ? 'unsupported' : checks.some(item => item.status === 'unknown') ? 'unknown' : 'supported';
const unavailableState = (): StateContentAssessment => ({ status: 'unknown', code: 'DEPLOYMENT_STATE_OBSERVATION_UNAVAILABLE',
  content: 'not-assessed', version: 'not-declared', scope: 'current-reader-content-and-declared-format' });

/** Missing nested parents are allowed; existing ancestors must still pass the installer's root trust predicate. */
export async function stateDirectoryExists(path: string, host: {
  info(path: string): Promise<{ isDirectory(): boolean } | null>; rootPath(path: string): Promise<void>;
}): Promise<boolean> {
  if (!posix.isAbsolute(path) || posix.normalize(path) !== path || path === '/') throw new Error('DEPLOYMENT_STATE_PATH_INVALID');
  if (await host.info(path)) return true;
  let parent = posix.dirname(path);
  while (parent !== '/' && !await host.info(parent)) parent = posix.dirname(parent);
  if (parent !== '/') {
    await host.rootPath(parent);
    if (!(await host.info(parent))?.isDirectory()) throw new Error('DEPLOYMENT_STATE_ANCESTOR_INVALID');
  }
  return false;
}

export async function inspectStateCompatibility(host: UpgradeStateHost, declaration: unknown) {
  const observations: StateObservation[] = [];
  const inspect = async (store: StateStore, path: string, maximum: number, sourceId?: string) => {
    try {
      const bytes = await host.read(path, maximum);
      if (bytes === null) {
        observations.push({ store, sourceId, presence: 'absent', assessment: { ...unavailableState(), status: 'supported', code: 'DEPLOYMENT_STATE_ABSENT' } });
        return;
      }
      let value: unknown;
      try { value = JSON.parse(bytes); }
      catch {
        observations.push({ store, sourceId, presence: 'present', assessment: { ...unavailableState(), status: 'unsupported',
          code: 'DEPLOYMENT_STATE_JSON_INVALID', content: 'invalid', version: 'invalid' } }); return;
      }
      observations.push({ store, sourceId, presence: 'present', value, assessment: assessStateContent(store, value, declaration, sourceId) });
    } catch { observations.push({ store, sourceId, presence: 'unavailable', assessment: unavailableState() }); }
  };
  for (const file of DEPLOYMENT_STATE_FILES) await inspect(file.store, file.path, file.limit);
  try {
    const value = host.usage ? await host.usage() : await host.read('usage.sqlite', 100);
    observations.push(value === null ? { store: 'usage', presence: 'absent', assessment: { ...unavailableState(), status: 'supported', code: 'DEPLOYMENT_STATE_ABSENT' } }
      : typeof value === 'string' ? { store: 'usage', presence: 'unavailable', assessment: unavailableState() }
      : { store: 'usage', presence: 'present', value, assessment: assessStateContent('usage', value, declaration) });
  } catch (error) {
    observations.push((error as { code?: string }).code === 'USAGE_SCHEMA_UNSUPPORTED'
      ? { store: 'usage', presence: 'present', assessment: { ...unavailableState(), status: 'unsupported', code: 'DEPLOYMENT_STATE_VERSION_UNSUPPORTED', version: 'unsupported-version' } }
      : { store: 'usage', presence: 'unavailable', assessment: unavailableState() });
  }
  try {
    const names = await host.list('subscriptions') ?? [];
    if (names.length > SUBSCRIPTION_INVENTORY_LIMIT || names.filter(name => !isSubscriptionTemporaryName(name)).length > SUBSCRIPTION_SOURCE_LIMIT) {
      observations.push({ store: 'subscription', presence: 'present', assessment: { ...unavailableState(), status: 'unsupported',
        code: 'DEPLOYMENT_STATE_COLLECTION_LIMIT', content: 'invalid' } });
      return { observations, findings: stateFindings(observations) };
    }
    for (const name of names) {
      if (isSubscriptionTemporaryName(name)) { await host.read('subscriptions/' + name, 4 * 1024 * 1024); continue; }
      if (!/^[A-Za-z0-9_-]{1,64}\.json$/.test(name)) throw new Error();
      await inspect('subscription', 'subscriptions/' + name, 4 * 1024 * 1024, name.slice(0, -5));
    }
  } catch { observations.push({ store: 'subscription', presence: 'unavailable', assessment: unavailableState() }); }
  return { observations, findings: stateFindings(observations) };
}
function stateFindings(observations: StateObservation[]) {
  return observations.map(item => ({ store: item.store,
    status: item.presence === 'absent' ? 'absent' : item.presence === 'unavailable' ? 'unavailable' : item.assessment.version,
    contentCompatibility: item.assessment }));
}

export interface UpgradeAssessmentContext {
  targetDeclaration: unknown;
  currentRuntime: RuntimeSettings; targetRuntime: RuntimeSettings;
  currentManagement: { origin: string; credentialPath: string; deployment: JsonObject };
  targetManagement: { origin: string; credentialPath: string; deployment: JsonObject };
  credential: unknown; credentialObserved: boolean;
  networkReceipt: { observation: 'absent' | 'read' | 'unavailable'; value?: unknown };
}
function declared(declaration: unknown, key: 'configurationReader' | 'candidateReader'): boolean {
  const value = declaration as Record<string, unknown> | null;
  return value?.schemaVersion === 1 && value[key] === DEPLOYMENT_STATE_COMPATIBILITY[key];
}
function stateCheck(observations: StateObservation[]): CompatibilityCheck {
  const checks = observations.map(item => {
    const result = item.assessment;
    return check(result.status, result.code, item.store, item.presence === 'absent' ? '没有需要读取的既存记录。'
      : '按共享完整 reader 验证当前内容，并单独核对目标声明；不评估未来写入。');
  });
  return check(aggregate(checks), 'UPGRADE_STATE_FORMAT_ASSESSED', 'observed-state-content',
    '已逐类检查当前持久状态的完整内容及明确声明。', ['实施时暂停写入并重新读取相同状态；不支持自动迁移。'], checks);
}

function referencedCandidates(observations: StateObservation[]): { references: Set<string>; uncertain: boolean } {
  const references = new Set<string>(); let uncertain = false;
  for (const item of observations.filter(item => ['transaction', 'selection'].includes(item.store))) {
    if (item.presence === 'absent') continue;
    if (item.presence !== 'present' || item.assessment.content !== 'valid') { uncertain = true; continue; }
    if (item.store === 'transaction') {
      const value = parseTransactionState(item.value);
      for (const id of [value.active, value.desired, value.pending?.previous, value.pending?.target]) if (id) references.add(id);
    } else {
      const value = parseRuntimeSelection(item.value); references.add(value.generation);
      if (value.hot) references.add(value.hot.baseGeneration);
    }
  }
  return { references, uncertain };
}

export async function createUpgradeAssessment(context: UpgradeAssessmentContext, host: UpgradeStateHost,
  inspectedState?: Awaited<ReturnType<typeof inspectStateCompatibility>>) {
  const state = inspectedState ?? await inspectStateCompatibility(host, context.targetDeclaration);
  const { observations } = state, references = referencedCandidates(observations);
  const historyChecks: CompatibilityCheck[] = [];
  const found = new Set<string>(); let enumerationComplete = true;
  try {
    const names = await host.list('candidates') ?? [];
    if (names.length > 4096) throw new Error();
    for (const name of names) {
      if (/^\.write-[a-f0-9-]{36}$/.test(name)) continue;
      if (!/^[a-f0-9]{64}\.json$/.test(name)) { enumerationComplete = false; continue; }
      const generation = name.slice(0, -5); found.add(generation);
      let bytes: string | null;
      try { bytes = await host.read('candidates/' + name, 4 * 1024 * 1024); }
      catch { bytes = null; }
      if (bytes === null) {
        const unavailable = check('unknown', 'UPGRADE_CANDIDATE_OBSERVATION_UNAVAILABLE', 'historical-candidate-format', '没有取得候选文件的完整可信读取证据。');
        historyChecks.push(unavailable); continue;
      }
      try {
        const config = parseStoredCandidate(bytes, generation);
        try {
          recompileRuntimeCandidate(config, context.targetRuntime, generation);
          historyChecks.push(check(declared(context.targetDeclaration, 'candidateReader') ? 'supported' : 'unknown',
            declared(context.targetDeclaration, 'candidateReader') ? 'UPGRADE_CANDIDATE_FORMAT_SUPPORTED' : 'UPGRADE_CANDIDATE_READER_NOT_DECLARED',
            'historical-candidate-format', '候选摘要、规范字节和运行重编译一致；核心语法尚未执行。'));
        } catch { historyChecks.push(check('unsupported', 'UPGRADE_CANDIDATE_SETTINGS_INCOMPATIBLE', 'historical-candidate-format', '候选不能在所评估设置下按现有运行 reader 重编译。')); }
      } catch {
        const invalid = check('unsupported', 'UPGRADE_CANDIDATE_CONTENT_INVALID', 'historical-candidate-format', '历史候选缺失、不可信或不符合规范摘要内容。');
        historyChecks.push(invalid);
      }
    }
  } catch { enumerationComplete = false; }
  if (!enumerationComplete || references.uncertain) {
    const unknown = check('unknown', 'UPGRADE_HISTORY_OBSERVATION_UNAVAILABLE', 'historical-candidate-inventory', '历史候选或运行引用未取得完整观察证据。');
    historyChecks.push(unknown);
  } else if ([...references.references].some(id => !found.has(id))) {
    const missing = check('unsupported', 'UPGRADE_REFERENCED_CANDIDATE_MISSING', 'historical-candidate-references', '活动、目标或运行选择引用的候选不存在。');
    historyChecks.push(missing);
  }
  const history = check(aggregate(historyChecks), 'UPGRADE_HISTORY_FORMAT_ASSESSED', 'historical-candidate-format-only',
    '已检查保留候选的规范表示、摘要、引用与目标设置重编译；不代表目标核心接受语法。',
    ['任何再次应用的候选须通过所选核心的只读语法验证，再完成运行验收。'], historyChecks);
  let configuration: CompatibilityCheck;
  try {
    parseRuntimeSettings(context.currentRuntime); parseRuntimeSettings(context.targetRuntime);
    for (const value of [context.currentManagement, context.targetManagement]) {
      managementOrigin(value.origin); compileConfig({ schemaVersion: 1, deployment: value.deployment, policy: { rules: ['MATCH,REJECT'] } });
    }
    configuration = check(declared(context.targetDeclaration, 'configurationReader') ? 'supported' : 'unknown',
      declared(context.targetDeclaration, 'configurationReader') ? 'UPGRADE_CONFIGURATION_FORMAT_SUPPORTED' : 'UPGRADE_CONFIGURATION_READER_NOT_DECLARED',
      'validated-deployment-and-runtime-settings', '目标部署计划与新旧运行设置由原解析器校验，管理 origin 与核心部署选项复用原校验。',
      ['配置变化仍须绑定当前输入和新旧清单的显式审阅；核心运行另验。']);
  } catch { configuration = check('unsupported', 'UPGRADE_CONFIGURATION_CONTENT_INVALID', 'validated-deployment-and-runtime-settings', '现有或目标配置未通过共享配置校验。'); }
  const identityChecks: CompatibilityCheck[] = [];
  let fingerprint: string | undefined;
  try {
    if (!context.credentialObserved) throw new Error();
    const credential = parseAdminCredential(context.credential);
    fingerprint = createHash('sha256').update(JSON.stringify({ origin: context.currentManagement.origin, credential })).digest('hex');
    const unchanged = context.currentManagement.origin === context.targetManagement.origin &&
      context.currentManagement.credentialPath === context.targetManagement.credentialPath && context.currentRuntime.serviceUid === context.targetRuntime.serviceUid;
    identityChecks.push(check(unchanged ? 'supported' : 'unsupported', unchanged ? 'UPGRADE_IDENTITY_BINDING_UNCHANGED' : 'UPGRADE_IDENTITY_REAUTHORIZATION_REQUIRED',
      'origin-credential-and-service-identity', unchanged ? '当前凭据合法且原地保留，origin、凭据路径与服务 UID 未改变。'
        : '身份绑定发生变化，旧设备信任绑定将按原规则失效；这不是内容损坏。', ['不复制或重新生成管理员凭据；身份变更后重新授权终端。']));
  } catch { identityChecks.push(check(context.credentialObserved ? 'unsupported' : 'unknown',
    context.credentialObserved ? 'UPGRADE_CREDENTIAL_CONTENT_INVALID' : 'UPGRADE_CREDENTIAL_EVIDENCE_UNAVAILABLE',
    'origin-credential-and-service-identity', context.credentialObserved ? '已读取凭据，但未通过原管理员凭据内容校验。' : '未取得管理员凭据证据，不能保证保留身份绑定。')); }
  for (const item of observations.filter(item => item.store === 'trustedDevices' && item.presence === 'present' && item.assessment.content === 'valid')) {
    const value = item.value as { credentialFingerprint?: unknown };
    const same = fingerprint !== undefined && value.credentialFingerprint === fingerprint;
    identityChecks.push(check(fingerprint === undefined ? 'unknown' : same ? 'supported' : 'unsupported',
      same ? 'UPGRADE_SAVED_BINDING_MATCHES' : 'UPGRADE_SAVED_BINDING_INVALIDATED', item.store,
      same ? '保存的身份绑定与当前管理员和 origin 相符。' : '合法记录的保存绑定已不同；原 reader 将按规则失效处理，不当作损坏。'));
  }
  const identity = check(aggregate(identityChecks), 'UPGRADE_IDENTITY_BINDINGS_ASSESSED', 'observed-identity-bindings',
    '身份保持与合法失效和内容格式分别评估。', [], identityChecks);
  const oldNetwork = context.currentRuntime.automaticGateway, nextNetwork = context.targetRuntime.automaticGateway;
  const sameNetwork = canonicalJson((oldNetwork ?? {}) as unknown as JsonObject) === canonicalJson((nextNetwork ?? {}) as unknown as JsonObject);
  const networkChecks = [check(sameNetwork ? 'supported' : 'unsupported', sameNetwork ? 'UPGRADE_NETWORK_BINDING_UNCHANGED' : 'UPGRADE_NETWORK_RETIREMENT_REQUIRED',
    'static-gateway-settings', sameNetwork ? '经原解析器验证的新旧网关静态配置相同。' : '网关资源或绑定有变化，必须先用旧设置和旧 helper 退役，再审阅新资源。')];
  if (oldNetwork || nextNetwork || context.networkReceipt.observation !== 'absent') {
    const receipt = context.networkReceipt.value as { schemaVersion?: unknown; status?: unknown } | undefined;
    networkChecks.push(context.networkReceipt.observation === 'absent'
      ? check('supported', 'UPGRADE_NETWORK_RECEIPT_ABSENT', 'trusted-network-receipt-header', '没有既存网络回执；这不证明内核无残留。')
      : context.networkReceipt.observation !== 'read' ? check('unknown', 'UPGRADE_NETWORK_RECEIPT_UNAVAILABLE', 'trusted-network-receipt-header', '网络回执读取证据不足。')
      : receipt?.schemaVersion === 1 && typeof receipt.status === 'string' && ['complete', 'removed', 'incomplete'].includes(receipt.status)
        ? check(receipt.status === 'incomplete' ? 'unsupported' : 'supported', receipt.status === 'incomplete' ? 'UPGRADE_NETWORK_TRANSACTION_INCOMPLETE' : 'UPGRADE_NETWORK_RECEIPT_HEADER_RECOGNIZED',
          'trusted-network-receipt-header-only', '只确认可信回执版本与状态，不验证完整 resources 或实时内核归属。')
        : check('unsupported', 'UPGRADE_NETWORK_RECEIPT_HEADER_INVALID', 'trusted-network-receipt-header-only', '可信回执不是已知版本或状态。'));
    networkChecks.push(check('unknown', 'UPGRADE_NETWORK_RESOURCES_NOT_ASSESSED', 'live-network-and-full-receipt-resources',
      '本评估未运行旧 helper 的完整资源归属校验或读取实时内核快照。', ['维护停机后使用旧 helper 显式退役，并由最终安装复核实时资源无冲突。']));
  }
  const network = check(aggregate(networkChecks), 'UPGRADE_NETWORK_PRECONDITIONS_ASSESSED', 'static-binding-and-header-with-live-boundary',
    '静态配置、回执头和未执行的动态归属验证单独列出。', [], networkChecks);
  const stateFormats = stateCheck(observations);
  return { schemaVersion: 1, readOnly: true, scope: 'observed-upgrade-compatibility-no-automatic-migration',
    assessments: { state: stateFormats, configuration, historyCandidates: history, network, identity },
    stateCompatibility: state.findings, automaticProgramRollback: false,
    readiness: aggregate([stateFormats, configuration, history, network, identity]) };
}
