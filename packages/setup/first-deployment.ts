import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { canonicalJson, cloneConfigJson, type JsonObject } from '../config/index.ts';
import { renderDeploymentPlan } from '../deployment/plan.ts';
import { inspectDeployment, loadInstalledDeployment } from '../deployment/maintenance.ts';
import { assertDeploymentExecutable, assertPrivateDeploymentFile, assertRootPath, deploymentPathInfo,
  readRegularDeploymentFile, runDeploymentTool } from '../deployment/install.ts';
import { parseAdminCredential } from '../management/auth.ts';
import { assertSetupLifecycleUnit } from './lifecycle.ts';
import type { EvidenceResult, EvidenceStatus } from './check-result.ts';

const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const hash = /^[a-f0-9]{64}$/;
const STORE = '/var/lib/cocoproxy-deployment';
type Installed = Awaited<ReturnType<typeof loadInstalledDeployment>>;
type Check = EvidenceResult & { source: 'installed-files' | 'service-state' | 'systemd' | 'core-observer' | 'none'; observedAt: number | null };
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
  unchanged(installed: Installed, inputPath: string, administratorSha256: string | null, state?: RuntimeStatus): Promise<boolean>;
}
export class FirstDeploymentError extends Error {
  readonly code: string;
  constructor(code = 'SETUP_FIRST_DEPLOYMENT_STATE_INVALID') { super(code); this.code = code; }
}
function need(value: unknown): asserts value { if (!value) throw new FirstDeploymentError(); }
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
  async unchanged(installed, inputPath, administratorSha256, previousState) {
    const observation = await nativeHost.inspect();
    if (observation.installed !== true || typeof observation.receipt !== 'object' || observation.receipt.status !== 'complete' || interrupted(observation)) return false;
    const current = await loadInstalledDeployment(inputPath);
    const administrator = await nativeHost.credential(current);
    const state = previousState ? await nativeHost.runtime(current, 'status') : undefined;
    return current.inputBytes.equals(installed.inputBytes) && current.receiptBytes.equals(installed.receiptBytes) &&
      administrator === administratorSha256 && (!previousState || state.active === previousState.active && state.desired === previousState.desired &&
        JSON.stringify(state.transaction) === JSON.stringify(previousState.transaction) && state.fault === previousState.fault);
  },
};

function interrupted(observation: InstallationObservation): boolean {
  return Boolean('receipt' in observation && typeof observation.receipt === 'object' && observation.receipt.status !== 'complete' ||
    'lock' in observation && observation.lock?.present || 'recoveryLock' in observation && observation.recoveryLock?.present ||
    observation.lifecycleClaimPresent || 'lifecycleJournal' in observation && observation.lifecycleJournal && observation.lifecycleJournal.status !== 'complete');
}

/** Cross-step report only: no service starts, router commands, writes, or lifecycle authorization. */
export async function createFirstDeploymentReport(deploymentInput: unknown, options: { inputPath: string },
  host: FirstDeploymentHost = nativeHost) {
  const input = cloneConfigJson(deploymentInput) as JsonObject; renderDeploymentPlan(input);
  const now = host.now();
  const checks: Check[] = [];
  const add = (id: string, status: EvidenceStatus, code: string, reason: string, action: string, source: Check['source'] = 'none') => {
    const check: Check = { id, status, code, reason, action, source, observedAt: source === 'none' ? null : now }; checks.push(check); return check;
  };
  const installAction = '先运行 install --payload <载荷> --manifest-sha256 <可信摘要> --input <私有部署输入> 预检，审阅后显式 --apply；已存在或中断安装先运行 inspect。';
  let installed: Installed | undefined;
  try {
    const observed = await host.inspect();
    if (observed.installed === false || typeof observed.receipt === 'object' && observed.receipt.status === 'uninstalled') {
      add('installation', 'not-run', 'SETUP_FIRST_INSTALL_REQUIRED', '尚无当前完成安装。', installAction, 'installed-files');
    } else if (observed.installed !== true) {
      add('installation', 'unknown', 'SETUP_FIRST_INSTALL_UNTRUSTED', '安装收据不可可靠读取，需要先审阅归属。', '运行 inspect；按 maintenance-recovery 文档审阅收据及可信路径，禁止删除锁后重试。', 'installed-files');
    } else if (interrupted(observed)) {
      add('installation', 'unknown', 'SETUP_FIRST_INSTALL_INTERRUPTED', '安装或生命周期仍有中断、锁或未完成记录。', '运行 inspect；完整安装中断可预览 recover，partial 写入或生命周期中断按原动作重新预览审阅，不自动清锁。', 'installed-files');
    } else {
      try {
        installed = await host.load(options.inputPath);
        need(sha(canonicalJson(installed.input)) === sha(canonicalJson(input)));
        add('installation', 'pass', 'SETUP_FIRST_INSTALL_VERIFIED', '当前输入与完成收据、自有文件、发布字节及服务身份一致。', '继续检查管理员与管理入口。', 'installed-files');
      } catch {
        installed = undefined;
        add('installation', 'fail', 'SETUP_FIRST_INSTALL_MISMATCH', '当前输入、收据、文件或服务身份不一致，拒绝接管。', '运行 inspect 核对归属与漂移；恢复匹配的原输入或审阅对应升级，不继续 initialize/enable。', 'installed-files');
      }
    }
  } catch {
    add('installation', 'unknown', 'SETUP_FIRST_INSTALL_OBSERVATION_UNAVAILABLE', '当前进程无法取得可信 Linux root 安装观察。', '在目标 Linux root shell 使用原私有部署输入运行 status；先运行 inspect 核对安装。');
  }
  let administratorSha256: string | null = null;
  const unavailable = (id: string, action: string) => add(id, 'unknown', 'SETUP_FIRST_OBSERVATION_UNAVAILABLE', '缺少该项的可信当前观察，需要复验。', action);
  const adminAction = '运行 initialize --input <私有部署输入> --admin-input <私有登录输入> 预览；审阅摘要后按相同动作显式 --apply。';
  if (installed) {
    try {
      administratorSha256 = await host.credential(installed);
      add('administrator', administratorSha256 ? 'pass' : 'not-run', administratorSha256 ? 'SETUP_FIRST_ADMIN_VERIFIED' : 'SETUP_FIRST_ADMIN_REQUIRED',
        administratorSha256 ? '当前管理员凭据格式、私有权限和服务 UID 归属有效；这不证明可登录。' : '尚未初始化管理员凭据。', adminAction, 'installed-files');
    } catch { add('administrator', 'fail', 'SETUP_FIRST_ADMIN_INVALID', '管理员凭据格式或归属无效。', '审阅管理员文件归属及格式；initialize 不覆盖现有文件。', 'installed-files'); }
  } else unavailable('administrator', adminAction);
  let units: { active: boolean; enabled: boolean } | undefined;
  if (installed) {
    try {
      units = await host.units(installed);
      add('management-service', units.active ? 'pass' : 'fail', units.active ? 'SETUP_FIRST_MANAGEMENT_ACTIVE' : 'SETUP_FIRST_MANAGEMENT_INACTIVE',
        units.active ? '自有管理服务当前 active；HTTPS 访问与登录仍须实际验收。' : '管理服务当前未全部 active。',
        '先查询 runtime-lifecycle-status；若 enabled 且未 paused，先预览并显式执行 pause-maintenance，再预览 start-management，按摘要实施后重新验收。', 'systemd');
    } catch { unavailable('management-service', '核对 systemd unit、覆盖文件和查询权限；先运行 inspect，再重新运行 status。'); }
  } else unavailable('management-service', '安装核验通过后运行 start-management 预览。');
  let state: RuntimeStatus | undefined;
  if (installed) {
    try {
      state = await host.runtime(installed, 'status');
      need(state && (state.active === null || typeof state.active === 'string' && hash.test(state.active)) && Object.hasOwn(state, 'transaction') && Object.hasOwn(state, 'fault'));
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
      if (!await host.unchanged(installed, options.inputPath, administratorSha256, state)) throw new Error();
    } catch {
      for (const check of checks) if (check.status === 'pass' || check.status === 'not-applicable') {
        check.status = 'unknown'; check.code = 'SETUP_FIRST_SNAPSHOT_CHANGED'; check.reason = '报告期间安装证据发生变化或无法复核，需重新运行 status。';
      }
    }
  } else unavailable('persistence', '安装核验通过并完成当前终端路径验收后预览 enable-persistence。');
  const next = checks.find(check => check.status !== 'pass' && check.status !== 'not-applicable');
  return { schemaVersion: 1, readOnly: true, generatedAt: now, scope: 'current-machine',
    checks,
    currentWait: next ? { step: next.id, code: next.code, kind: next.status === 'fail' ? 'repair' : 'observation-or-action' } : null,
    next: next ? { step: next.id, action: next.action } : { step: 'manual-acceptance',
      action: '在实际终端验收 HTTPS、登录、证书信任、代理、直连、DNS 与本地访问，核对路由器交付及独立关闭；再按文档验收冷启动和恢复。' },
    acceptanceNotice: '本报告只查询当前机器状态；实际终端、路由器路径、冷启动和长期稳定性须按文档验收。' };
}
