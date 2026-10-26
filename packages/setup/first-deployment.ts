import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { canonicalJson, cloneConfigJson, type JsonObject } from '../config/index.ts';
import { renderDeploymentPlan } from '../deployment/plan.ts';
import { inspectDeployment, loadInstalledDeployment } from '../deployment/maintenance.ts';
import { assertDeploymentExecutable, assertPrivateDeploymentFile, assertRootPath, deploymentPathInfo,
  readRegularDeploymentFile, runDeploymentTool } from '../deployment/install.ts';
import { parseAdminCredential } from '../management/auth.ts';
import { assertSetupLifecycleUnit } from './lifecycle.ts';
import { createManagementEvidenceReport } from './management-evidence.ts';
import type { EvidenceResult, EvidenceStatus } from './check-result.ts';

const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const hash = /^[a-f0-9]{64}$/;
const STORE = '/var/lib/cocoproxy-deployment';
type Installed = Awaited<ReturnType<typeof loadInstalledDeployment>>;
type Binding = { deploymentSha256: string | null; configurationSha256: string; activeGeneration: string | null; administratorSha256: string | null };
type Check = EvidenceResult & { source: 'installed-files' | 'service-state' | 'systemd' | 'core-observer' | 'operator-record' | 'none'; observedAt: number | null;
  scope?: string; subjects?: string[]; binding?: unknown };
type Recorded = { observedAt: number };
type OperatorEvidence = { schemaVersion: 1; binding: Binding; recordedAt: number; management?: unknown;
  router?: Recorded & { scope: 'configured-lan'; parametersMatched: boolean; deliveryEnabled: boolean; independentDisableVerified: boolean };
  terminal?: Recorded & { scope: 'managed-clients'; terminalIds: string[]; proxy: boolean; direct: boolean; dns: boolean; localAccess: boolean } };
type RuntimeStatus = { active: string | null; desired: string | null; transaction: unknown; fault: unknown };
type CoreStatus = RuntimeStatus & { core: { ready: boolean; generation: string; checkedAt: string; reason: string | null } | null };
type InstallationObservation = Awaited<ReturnType<typeof inspectDeployment>> & { lifecycleClaimPresent?: boolean };
export interface FirstDeploymentHost {
  now(): number;
  inspect(): Promise<InstallationObservation>;
  load(path: string): Promise<Installed>;
  credential(installed: Installed): Promise<string | null>;
  runtime(installed: Installed, command: 'status' | 'runtime-status' | 'runtime-lifecycle-status'): Promise<any>;
  units(installed: Installed): Promise<{ active: boolean; enabled: boolean }>;
  unchanged(installed: Installed, inputPath: string, binding: Binding, state?: RuntimeStatus): Promise<boolean>;
}
export class FirstDeploymentError extends Error {
  readonly code: string;
  constructor(code = 'SETUP_FIRST_DEPLOYMENT_EVIDENCE_INVALID') { super(code); this.code = code; }
}
function need(value: unknown): asserts value { if (!value) throw new FirstDeploymentError(); }
function object(value: unknown, required: string[], optional: string[] = []): Record<string, any> {
  need(value && typeof value === 'object' && !Array.isArray(value));
  need(required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => [...required, ...optional].includes(key)));
  return value as Record<string, any>;
}
function time(value: unknown, maximum: number) { need(Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= maximum); }
function parseEvidence(raw: unknown, now: number): OperatorEvidence {
  const value = object(cloneConfigJson(raw), ['schemaVersion', 'binding', 'recordedAt'], ['management', 'router', 'terminal']);
  need(value.schemaVersion === 1); time(value.recordedAt, now);
  const binding = object(value.binding, ['deploymentSha256', 'configurationSha256', 'activeGeneration', 'administratorSha256']);
  need(typeof binding.configurationSha256 === 'string' && hash.test(binding.configurationSha256));
  for (const key of ['deploymentSha256', 'activeGeneration', 'administratorSha256']) need(binding[key] === null || typeof binding[key] === 'string' && hash.test(binding[key]));
  if (Object.hasOwn(value, 'management')) {
    need(value.management && typeof value.management === 'object'); time(value.management.recordedAt, value.recordedAt);
  }
  if (Object.hasOwn(value, 'router')) {
    const item = object(value.router, ['scope', 'observedAt', 'parametersMatched', 'deliveryEnabled', 'independentDisableVerified']);
    need(item.scope === 'configured-lan'); time(item.observedAt, value.recordedAt);
    need(['parametersMatched', 'deliveryEnabled', 'independentDisableVerified'].every(key => typeof item[key] === 'boolean'));
  }
  if (Object.hasOwn(value, 'terminal')) {
    const item = object(value.terminal, ['scope', 'observedAt', 'terminalIds', 'proxy', 'direct', 'dns', 'localAccess']);
    need(item.scope === 'managed-clients'); time(item.observedAt, value.recordedAt);
    need(Array.isArray(item.terminalIds) && item.terminalIds.length > 0 && item.terminalIds.length <= 32 &&
      new Set(item.terminalIds).size === item.terminalIds.length && item.terminalIds.every((id: unknown) => typeof id === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(id)));
    need(['proxy', 'direct', 'dns', 'localAccess'].every(key => typeof item[key] === 'boolean'));
  }
  return value as OperatorEvidence;
}

const nativeHost: FirstDeploymentHost = {
  now: Date.now, load: loadInstalledDeployment,
  async inspect() {
    const observation = await inspectDeployment();
    if (observation.installed !== true) return observation;
    await assertRootPath(STORE);
    return { ...observation, lifecycleClaimPresent: Boolean(await deploymentPathInfo(STORE + '/lifecycle-claim.lock')) };
  },
  async credential({ input }) {
    await assertRootPath(posix.dirname(input.management.credentialPath));
    if (!(await deploymentPathInfo(input.management.credentialPath))) return null;
    await assertPrivateDeploymentFile(input.management.credentialPath, input.runtime.serviceUid);
    const bytes = await readRegularDeploymentFile(input.management.credentialPath, 16384);
    parseAdminCredential(JSON.parse(bytes.toString()));
    return sha(bytes);
  },
  async runtime({ input }, command) {
    // The existing CLI status readers do not initialize stores, acquire locks, or repair state.
    // Running them as the service UID preserves privateRead's ownership boundary.
    await assertDeploymentExecutable('/usr/sbin/runuser');
    await assertDeploymentExecutable(input.runtime.nodePath);
    const entry = input.runtime.sourceDirectory + '/apps/cli/main.ts'; await assertRootPath(entry);
    const args = ['-u', input.management.serviceUser, '--', input.runtime.nodePath, '--experimental-strip-types', entry,
      command, '--state-dir', input.runtime.stateDirectory];
    if (command !== 'status') args.push('--runtime-settings', input.runtime.settingsPath);
    return JSON.parse(await runDeploymentTool('/usr/sbin/runuser', args));
  },
  async units({ input }) {
    const units = ['cocoproxy-management.service', ...(input.web ? ['cocoproxy-web.service'] : []),
      ...(input.runtime.automaticGateway ? ['cocoproxy-gateway-guard.service'] : [])];
    let active = true, enabled = true;
    for (const unit of units) {
      const output = await runDeploymentTool(input.runtime.systemctlPath, ['show', unit, '--property=LoadState,FragmentPath,DropInPaths,NeedDaemonReload,Job,ActiveState']);
      assertSetupLifecycleUnit(output, unit);
      for (const path of ['/etc/systemd/system/' + unit + '.d', '/run/systemd/system/' + unit, '/run/systemd/system/' + unit + '.d']) {
        if (await deploymentPathInfo(path)) throw new Error('unit conflict');
      }
      if (unit !== 'cocoproxy-gateway-guard.service') active &&= output.split('\n').includes('ActiveState=active');
      const state = (await runDeploymentTool(input.runtime.systemctlPath, ['show', unit, '--property=UnitFileState', '--value'])).trim();
      if (!['enabled', 'disabled', 'enabled-runtime', 'static', 'indirect', 'masked', 'masked-runtime', 'linked', 'linked-runtime'].includes(state)) throw new Error('unit state unavailable');
      enabled &&= state === 'enabled';
    }
    return { active, enabled };
  },
  async unchanged(installed, inputPath, binding, previousState) {
    const observation = await nativeHost.inspect();
    if (observation.installed !== true || typeof observation.receipt !== 'object' || observation.receipt.status !== 'complete' || interrupted(observation)) return false;
    const current = await loadInstalledDeployment(inputPath);
    const administrator = await nativeHost.credential(current);
    const state = previousState ? await nativeHost.runtime(current, 'status') : undefined;
    return current.inputBytes.equals(installed.inputBytes) && current.receiptBytes.equals(installed.receiptBytes) &&
      administrator === binding.administratorSha256 && (!previousState || state.active === previousState.active && state.desired === previousState.desired &&
        JSON.stringify(state.transaction) === JSON.stringify(previousState.transaction) && state.fault === previousState.fault);
  },
};

function interrupted(observation: InstallationObservation): boolean {
  return Boolean('receipt' in observation && typeof observation.receipt === 'object' && observation.receipt.status !== 'complete' ||
    'lock' in observation && observation.lock?.present || 'recoveryLock' in observation && observation.recoveryLock?.present ||
    observation.lifecycleClaimPresent || 'lifecycleJournal' in observation && observation.lifecycleJournal && observation.lifecycleJournal.status !== 'complete');
}

/** Cross-step report only: no service starts, router commands, writes, or lifecycle authorization. */
export async function createFirstDeploymentReport(deploymentInput: unknown, options: { inputPath: string; evidence?: unknown },
  host: FirstDeploymentHost = nativeHost) {
  const input = cloneConfigJson(deploymentInput) as JsonObject; renderDeploymentPlan(input);
  const now = host.now(), operator = options.evidence === undefined ? undefined : parseEvidence(options.evidence, now);
  const management = await createManagementEvidenceReport(input, { evidence: operator?.management }, { now: () => now, probeHttps: async () => { throw new Error(); } });
  const checks: Check[] = [];
  const add = (id: string, status: EvidenceStatus, code: string, reason: string, action: string, source: Check['source'] = 'none') => {
    const check: Check = { id, status, code, reason, action, source, observedAt: source === 'none' ? null : now }; checks.push(check); return check;
  };
  const installAction = '先运行 install --payload <载荷> --manifest-sha256 <可信摘要> --input <私有部署输入> 预检，审阅后显式 --apply；已存在或中断安装先运行 inspect。';
  let installed: Installed | undefined, installation: Check;
  try {
    const observed = await host.inspect();
    if (observed.installed === false || typeof observed.receipt === 'object' && observed.receipt.status === 'uninstalled') {
      installation = add('installation', 'not-run', 'SETUP_FIRST_INSTALL_REQUIRED', '尚无当前完成安装。', installAction, 'installed-files');
    } else if (observed.installed !== true) {
      installation = add('installation', 'unknown', 'SETUP_FIRST_INSTALL_UNTRUSTED', '安装收据不可可靠读取，需要先审阅归属。', '运行 inspect；按 maintenance-recovery 文档审阅收据及可信路径，禁止删除锁后重试。', 'installed-files');
    } else if (interrupted(observed)) {
      installation = add('installation', 'unknown', 'SETUP_FIRST_INSTALL_INTERRUPTED', '安装或生命周期仍有中断、锁或未完成记录。', '运行 inspect；完整安装中断可预览 recover，partial 写入或生命周期中断按原动作重新预览审阅，不自动清锁。', 'installed-files');
    } else {
      try {
        installed = await host.load(options.inputPath);
        need(sha(canonicalJson(installed.input)) === sha(canonicalJson(input)));
        installation = add('installation', 'pass', 'SETUP_FIRST_INSTALL_VERIFIED', '当前输入与完成收据、自有文件、发布字节及服务身份一致。', '继续检查管理员与管理入口。', 'installed-files');
      } catch {
        installed = undefined;
        installation = add('installation', 'fail', 'SETUP_FIRST_INSTALL_MISMATCH', '当前输入、收据、文件或服务身份不一致，拒绝接管。', '运行 inspect 核对归属与漂移；恢复匹配的原输入或审阅对应升级，不继续 initialize/enable。', 'installed-files');
      }
    }
  } catch {
    installation = add('installation', 'unknown', 'SETUP_FIRST_INSTALL_OBSERVATION_UNAVAILABLE', '当前进程无法取得可信 Linux root 安装观察。', '在目标 Linux root shell 使用原私有部署输入运行 status；先运行 inspect 核对安装。');
  }
  const binding: Binding = { deploymentSha256: installed ? sha(installed.receiptBytes) : null,
    configurationSha256: management.binding.configurationSha256, activeGeneration: null, administratorSha256: null };
  const unavailable = (id: string, action: string) => add(id, 'unknown', 'SETUP_FIRST_OBSERVATION_UNAVAILABLE', '缺少该项的可信当前观察，需要复验。', action);
  const adminAction = '运行 initialize --input <私有部署输入> --admin-input <私有登录输入> 预览；审阅摘要后按相同动作显式 --apply。';
  if (installed) {
    try {
      binding.administratorSha256 = await host.credential(installed);
      add('administrator', binding.administratorSha256 ? 'pass' : 'not-run', binding.administratorSha256 ? 'SETUP_FIRST_ADMIN_VERIFIED' : 'SETUP_FIRST_ADMIN_REQUIRED',
        binding.administratorSha256 ? '当前管理员凭据格式、私有权限和服务 UID 归属有效；这不证明可登录。' : '尚未初始化管理员凭据。', adminAction, 'installed-files');
    } catch { add('administrator', 'fail', 'SETUP_FIRST_ADMIN_INVALID', '管理员凭据格式或归属无效。', '审阅管理员文件归属及格式；initialize 不覆盖现有文件。', 'installed-files'); }
  } else unavailable('administrator', adminAction);
  let units: { active: boolean; enabled: boolean } | undefined;
  if (installed) {
    try {
      units = await host.units(installed);
      add('management-service', units.active ? 'pass' : 'fail', units.active ? 'SETUP_FIRST_MANAGEMENT_ACTIVE' : 'SETUP_FIRST_MANAGEMENT_INACTIVE',
        units.active ? '自有管理服务当前 active；HTTPS 访问与登录另列。' : '管理服务当前未全部 active。',
        '先查询 runtime-lifecycle-status；若 enabled 且未 paused，先预览并显式执行 pause-maintenance，再预览 start-management，按摘要实施后重新验收。', 'systemd');
    } catch { unavailable('management-service', '核对 systemd unit、覆盖文件和查询权限；先运行 inspect，再重新运行 status。'); }
  } else unavailable('management-service', '安装核验通过后运行 start-management 预览。');
  let state: RuntimeStatus | undefined;
  if (installed) {
    try {
      state = await host.runtime(installed, 'status');
      need(state && (state.active === null || typeof state.active === 'string' && hash.test(state.active)) && Object.hasOwn(state, 'transaction') && Object.hasOwn(state, 'fault'));
      binding.activeGeneration = state.active;
      const settled = state.active !== null && state.transaction === null && state.fault === null;
      add('configuration', settled ? 'pass' : state.transaction !== null || state.fault !== null ? 'fail' : 'not-run',
        settled ? 'SETUP_FIRST_CONFIGURATION_COMMITTED' : state.active === null && state.transaction === null && state.fault === null ? 'SETUP_FIRST_CONFIGURATION_REQUIRED' : 'SETUP_FIRST_CONFIGURATION_RECOVERY_REQUIRED',
        settled ? '持久事务状态记录当前已提交的活跃候选；核心健康另验。' : '尚无稳定已提交候选，或配置事务需要恢复。',
        state.transaction !== null || state.fault !== null ? '在后台审阅配置事务及恢复操作，不覆盖故障状态；恢复后重新运行 status。' : '在后台添加订阅或配置、暂存并应用首次候选，等待提交成功后重新运行 status。', 'service-state');
    } catch { state = undefined; unavailable('configuration', '检查服务 UID 的私有状态目录及事务文件，再运行 CLI status；不要删除或重建现有状态。'); }
    try {
      const observed: CoreStatus = await host.runtime(installed, 'runtime-status');
      const consistent = !!state && observed.active === state.active && observed.transaction === null && observed.fault === null;
      const ready = consistent && state!.active !== null && observed.core?.ready === true && observed.core.generation === state!.active;
      add('core', ready ? 'pass' : consistent && state!.active === null ? 'not-run' : consistent ? 'fail' : 'unknown', ready ? 'SETUP_FIRST_CORE_READY' : consistent ? 'SETUP_FIRST_CORE_NOT_READY' : 'SETUP_FIRST_CORE_STATE_CHANGED',
        ready ? '既有核心观察器当前核验已提交候选的核心就绪；不证明路由器或终端路径。' : consistent ? '当前核心尚未通过就绪观察。' : '两次事务观察不一致或缺失，需重新取得一致观察。',
        '在后台查看核心和配置事务状态；对照 runtime-status 排查，完成后重新运行 status。', 'core-observer');
    } catch { unavailable('core', '在目标机以服务身份运行 runtime-status；核对 unit、候选、进程与控制器只读观察后重新运行 status。'); }
  } else { unavailable('configuration', '完成安装后在后台配置并应用首次候选。'); unavailable('core', '安装核验通过并应用候选后运行 runtime-status。'); }
  const current = !!installed && !!state && binding.administratorSha256 !== null && operator !== undefined && canonicalJson(operator.binding as unknown as JsonObject) === canonicalJson(binding as unknown as JsonObject);
  const recordAction = ' 完成实际观察后运行 record-observations --input <原私有部署输入> --facts <本次事实私有JSON> --output <新私有证据>，再用 status --evidence <新私有证据> 复核。';
  const manual = (id: string, observation: Recorded | undefined, passed: boolean, action: string) => {
    const bound = current && binding.activeGeneration !== null;
    const check = add(id, observation ? bound ? passed ? 'pass' : 'fail' : 'unknown' : 'not-run',
      !observation ? 'SETUP_FIRST_OPERATOR_WAIT' : !bound ? 'SETUP_FIRST_EVIDENCE_BINDING_CHANGED' : passed ? 'SETUP_FIRST_OPERATOR_CONFIRMED' : 'SETUP_FIRST_OPERATOR_REPORTED_FAILURE',
      !observation ? '等待操作者完成当前部署范围的观察并提供记录。' : !bound ? '记录的安装、部署配置、活跃候选或管理员绑定已变化或尚不可核对，需要复验。' : passed ? '操作者记录此范围已通过；这是记录时的人工观察。' : '操作者记录此范围仍有检查未通过。', action + recordAction, observation ? 'operator-record' : 'none');
    check.observedAt = observation?.observedAt ?? null;
    check.scope = id === 'router' ? 'configured-lan' : 'managed-clients'; check.binding = operator?.binding ?? binding;
    if (id === 'terminal') check.subjects = operator?.terminal?.terminalIds ?? [];
  };
  manual('router', operator?.router, !!operator?.router?.parametersMatched && !!operator?.router?.deliveryEnabled && !!operator?.router?.independentDisableVerified,
    '人工核对当前配置的两端参数、开启指定 LAN 交付并验证独立关闭入口，再记录 configured-lan 观察；当前报告不连接或操作路由器。');
  manual('terminal', operator?.terminal, !!operator?.terminal?.proxy && !!operator?.terminal?.direct && !!operator?.terminal?.dns && !!operator?.terminal?.localAccess,
    '在记录的终端范围验证代理、直连、DNS 和本地访问，记录 managed-clients 观察及终端别名；新增或变化的终端另验。');
  for (const item of management.checks) {
    const check = add(item.id, item.status, item.code, item.reason, item.action + recordAction, item.source === 'operator-record' ? 'operator-record' : 'none');
    check.observedAt = item.observedAt;
    check.scope = item.scope; check.subjects = item.subject ? [item.subject] : []; check.binding = item.binding;
    if (['browser-notification-capability', 'test-notification-displayed'].includes(item.id)) check.action +=
      ' 若未选择可选通知，在 management 观察中明确记录 notifications: "declined" 并省略 notification；已有 browser 观察仍如实保留。';
    if (item.source === 'operator-record' && !current) {
      check.status = 'unknown'; check.code = 'SETUP_FIRST_EVIDENCE_BINDING_CHANGED';
      check.reason = '管理观察的安装、部署配置、活跃候选或管理员绑定已变化或尚不可核对，需要复验。';
    }
    if (item.observedAt !== null && operator && item.observedAt > operator.recordedAt) throw new FirstDeploymentError();
  }
  if (installed) {
    try {
      const value = (await host.runtime(installed, 'runtime-lifecycle-status')).lifecycle;
      need(value && value.schemaVersion === 1 && typeof value.enabled === 'boolean' && typeof value.paused === 'boolean');
      const ready = value.enabled && !value.paused && units?.enabled === true;
      const managementStep = checks.find(check => check.id === 'management-service')!;
      managementStep.action = value.enabled && !value.paused
        ? '当前自动生命周期已启用且未暂停：先预览 pause-maintenance --input <私有部署输入>，审阅后显式实施；再预览 start-management 并按摘要实施，最终重新验收并显式 resume-persistence。'
        : '运行 start-management --input <私有部署输入> 预览；管理员初始化后审阅摘要并按相同动作显式 --apply，再次运行 status。';
      add('persistence', ready ? 'pass' : units ? 'not-run' : 'unknown', ready ? 'SETUP_FIRST_PERSISTENCE_ENABLED' : 'SETUP_FIRST_PERSISTENCE_REQUIRED',
        ready ? '当前持久恢复意图已启用且未暂停，所需管理/HTTPS/guard unit 已设置开机启用；不证明冷启动或长期稳定性。' : '持久恢复意图或所需 unit 的开机启用尚未全部满足。',
        '完成当前终端路径验收后，运行 enable-persistence --input <私有部署输入> --terminal-path-verified 预览；已启用且暂停时使用 resume-persistence，审阅摘要后实施。', 'service-state');
    } catch { unavailable('persistence', '检查私有 lifecycle 意图与 systemd unit 开机状态，禁止以旧 action journal 代替当前观察。'); }
    try {
      if (!await host.unchanged(installed, options.inputPath, binding, state)) throw new Error();
    } catch {
      for (const check of checks) if (check.status === 'pass' || check.status === 'not-applicable') {
        check.status = 'unknown'; check.code = 'SETUP_FIRST_SNAPSHOT_CHANGED'; check.reason = '报告期间安装证据发生变化或无法复核，需重新运行 status。';
      }
    }
  } else unavailable('persistence', '安装核验通过并完成当前终端路径验收后预览 enable-persistence。');
  const order = ['installation', 'administrator', 'management-service', 'https-reachable', 'login', 'terminal-certificate-trust',
    'configuration', 'core', 'router', 'terminal', 'browser-notification-capability', 'test-notification-displayed', 'persistence'];
  checks.sort((left, right) => order.indexOf(left.id) - order.indexOf(right.id));
  const completed = checks.filter(check => ['pass', 'not-applicable'].includes(check.status)).map(check => check.id);
  const pending = checks.filter(check => !completed.includes(check.id));
  const next = pending[0];
  return { schemaVersion: 1, readOnly: true, generatedAt: now, binding, managementBinding: management.binding,
    operatorRecord: operator ? { binding: operator.binding, recordedAt: operator.recordedAt } : null,
    evidenceScope: 'current machine observations and bound historical operator records; not physical acceptance',
    checks, completed, pending: pending.map(check => check.id), evidenceComplete: !next,
    currentWait: next ? { step: next.id, code: next.code, kind: next.source === 'operator-record' || next.code === 'SETUP_FIRST_OPERATOR_WAIT' || next.code === 'SETUP_MANAGEMENT_NOT_RUN' ? 'operator' : next.status === 'fail' ? 'repair' : 'observation-or-action' } : null,
    next: next ? { step: next.id, action: next.action } : { step: 'external-acceptance', action: '按部署验收清单完成干净首装、多终端、冷启动、断线恢复及长期运行的独立验收；本报告不替代这些观察。' } };
}

/** Human event time with an explicit timezone; recording time is generated separately. */
function eventTime(value: unknown, maximum: number): number {
  need(typeof value === 'string');
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  need(match);
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  const milliseconds = Number((match[7] ?? '').padEnd(3, '0'));
  const local = new Date(Date.UTC(year, month - 1, day, hour, minute, second, milliseconds));
  need(year >= 1970 && local.getUTCFullYear() === year && local.getUTCMonth() === month - 1 && local.getUTCDate() === day &&
    local.getUTCHours() === hour && local.getUTCMinutes() === minute && local.getUTCSeconds() === second);
  const zone = match[8], zoneHours = zone === 'Z' ? 0 : Number(zone.slice(1, 3)), zoneMinutes = zone === 'Z' ? 0 : Number(zone.slice(4, 6));
  need(zoneHours <= 23 && zoneMinutes <= 59);
  const offset = (zoneHours * 60 + zoneMinutes) * 60000 * (zone.startsWith('-') ? -1 : 1);
  const result = local.getTime() - offset; time(result, maximum); return result;
}

/** Bind newly stated facts only. Never import or relabel previous evidence as a new observation. */
export async function createFirstDeploymentObservations(deploymentInput: unknown, options: { inputPath: string; facts: unknown },
  host: FirstDeploymentHost = nativeHost): Promise<OperatorEvidence> {
  const facts = object(cloneConfigJson(options.facts), ['schemaVersion'], ['observedAt', 'management', 'router', 'terminal']);
  need(facts.schemaVersion === 1);
  const current = await createFirstDeploymentReport(deploymentInput, { inputPath: options.inputPath }, host);
  const verified = (report: typeof current) => ['installation', 'administrator'].every(id => report.checks.find(check => check.id === id)?.status === 'pass');
  if (!verified(current)) throw new FirstDeploymentError('SETUP_FIRST_RECORD_DEPLOYMENT_UNVERIFIED');
  const recordedAt = host.now();
  const observedAt = Object.hasOwn(facts, 'observedAt') ? eventTime(facts.observedAt, recordedAt) : undefined;
  const observationTime = () => { need(observedAt !== undefined); return observedAt; };
  const evidence: OperatorEvidence = { schemaVersion: 1, binding: current.binding, recordedAt };
  if (Object.hasOwn(facts, 'router')) {
    const value = object(facts.router, ['parametersMatched', 'deliveryEnabled', 'independentDisableVerified']);
    evidence.router = { ...value, scope: 'configured-lan', observedAt: observationTime() } as OperatorEvidence['router'];
  }
  if (Object.hasOwn(facts, 'terminal')) {
    const value = object(facts.terminal, ['terminalIds', 'proxy', 'direct', 'dns', 'localAccess']);
    evidence.terminal = { ...value, scope: 'managed-clients', observedAt: observationTime() } as OperatorEvidence['terminal'];
  }
  if (Object.hasOwn(facts, 'management')) {
    const value = object(facts.management, ['terminalId', 'notifications'], ['https', 'login', 'certificate', 'browser', 'notification']);
    const management: Record<string, unknown> = { schemaVersion: 1, binding: current.managementBinding, recordedAt,
      terminalId: value.terminalId, notifications: value.notifications };
    for (const [key, fields] of [
      ['https', ['pageLoaded']], ['login', ['authenticated', 'logoutCompleted', 'anonymousApiDenied']],
      ['certificate', ['warningShown', 'exceptionUsed']],
      ['browser', ['secureContext', 'notificationApi', 'serviceWorker', 'pushManager', 'permission', 'requiresInstalledApp', 'installedApp']],
    ] as const) if (Object.hasOwn(value, key)) management[key] = { ...object(value[key], [...fields]), observedAt: observationTime() };
    if (Object.hasOwn(value, 'notification')) {
      const notification = object(value.notification, ['testRequestedAt', 'providerAccepted', 'displayedAt', 'notDisplayed']);
      management.notification = { ...notification, observedAt: observationTime(), testRequestedAt: eventTime(notification.testRequestedAt, observedAt!),
        displayedAt: notification.displayedAt === null ? null : eventTime(notification.displayedAt, observedAt!) };
    }
    evidence.management = management;
  }
  // Reuse the consuming parser, then re-observe the deployment. Missing facts stay missing.
  const reviewed = await createFirstDeploymentReport(deploymentInput, { inputPath: options.inputPath, evidence }, host);
  if (!verified(reviewed) || canonicalJson(current.binding as unknown as JsonObject) !== canonicalJson(reviewed.binding as unknown as JsonObject)) {
    throw new FirstDeploymentError('SETUP_FIRST_RECORD_BINDING_CHANGED');
  }
  return evidence;
}
