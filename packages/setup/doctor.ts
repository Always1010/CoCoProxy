import { execFile } from 'node:child_process';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { arch, platform } from 'node:os';
import { createSetupDeployment, parseSetupEnvironment, SetupError, type SetupEnvironment } from './input.ts';
import { ManagedWebError, verifyManagedWeb, type ManagedWebInput } from './https.ts';
import { inspectServiceAccount } from '../deployment/service-account.ts';
import { assertRootControlledPath, assertTrustedExecutable, assertServiceAncestors, assertPlannedDeploymentDirectory, assertPrivatePath,
  PathEvidenceError, type PathEvidenceHost } from '../deployment/path-evidence.ts';
import { renderDeploymentPlan } from '../deployment/plan.ts';
import { AUTOMATIC_GATEWAY_CORE_SHA256 } from '../gateway/profile.ts';
import { policyRuleConflicts, routeConflicts, firewallConflicts, tunConflicts, networkReceiptRemoved,
  NetworkObservationError } from '../deployment/network-evidence.ts';
import { inspectDeployment } from '../deployment/maintenance.ts';
import { parseListeningSockets, listenerOverlap, setupListeningTargets, type ListeningSocket, type ListeningTarget } from './listening.ts';
import type { EvidenceResult, EvidenceStatus } from './check-result.ts';

export const DOCTOR_LAYERS = [
  { id: 'foundation', label: '基础环境' }, { id: 'components', label: '系统组件' },
  { id: 'identity', label: '身份与目录' }, { id: 'network', label: '网络条件' },
  { id: 'management', label: '管理入口' }, { id: 'installation', label: '已有安装' },
] as const;
export type DoctorLayer = typeof DOCTOR_LAYERS[number]['id'];
type DoctorStatus = Extract<EvidenceStatus, 'pass' | 'fail' | 'unknown'>;
export interface Check extends EvidenceResult {
  layer: DoctorLayer; status: DoctorStatus; required: boolean; message: string;
  conflicts?: string[];
}
const checkLayers = {
  linux: 'foundation', architecture: 'foundation', node: 'foundation', systemd: 'foundation', environment: 'foundation',
  python: 'components', ip: 'components', nft: 'components', systemctl: 'components', polkit: 'components',
  privileges: 'identity', 'service-account': 'identity', 'node-path': 'identity', 'systemctl-path': 'identity',
  'release-parent': 'identity', 'receipt-directory': 'identity', 'service-paths': 'identity',
  'configured-node-version': 'components', tun: 'network', forwarding: 'network', 'interface-address': 'network',
  'policy-rules': 'network', routes: 'network', firewall: 'network', 'router-contract': 'network',
  'tun-name': 'network', 'network-receipt': 'network',
  'managed-https': 'management', 'https-client-trust': 'management',
  'management-port': 'management', 'https-port': 'management', 'external-https': 'management',
  'mixed-port': 'network', 'controller-port': 'network', 'dns-port': 'network',
  'bound-sockets': 'network',
  'installation-receipt': 'installation', 'installation-files': 'installation', 'installation-locks': 'installation',
  'installation-maintenance': 'installation', 'installation-identity': 'installation',
} as const satisfies Record<string, DoctorLayer>;
type CheckId = keyof typeof checkLayers | `deployment-directory-${number}`;
export interface DoctorHost {
  platform: string; architecture: string; nodeVersion: string; uid: number;
  read(path: string): Promise<string>;
  stat(path: string): Promise<{ directory: boolean; characterDevice: boolean; uid: number; mode: number; link: boolean; file?: boolean; nlink?: number }>;
  resolve(path: string): Promise<string>;
  run(path: string, args: string[]): Promise<string>;
  managedWeb?(input: ManagedWebInput): Promise<void>;
  inspection?(): Promise<Awaited<ReturnType<typeof inspectDeployment>>>;
}
const nativeHost = (): DoctorHost => ({
  platform: platform(), architecture: arch(), nodeVersion: process.versions.node, uid: process.getuid?.() ?? -1,
  read: path => readFile(path, 'utf8'), resolve: realpath, managedWeb: verifyManagedWeb, inspection: inspectDeployment,
  stat: async path => { const s = await lstat(path); return { directory: s.isDirectory(), characterDevice: s.isCharacterDevice(),
    uid: s.uid, mode: s.mode, link: s.isSymbolicLink(), file: s.isFile(), nlink: s.nlink }; },
  run: (path, args) => new Promise((resolve, reject) => execFile(path, args, {
    timeout: 5000, maxBuffer: 2 * 1024 * 1024, windowsHide: true, env: { PATH: '/usr/sbin:/usr/bin', LC_ALL: 'C' },
  }, (error, stdout, stderr) => error || path.endsWith('/ss') && stderr.trim() ? reject(new SetupError((error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
    ? 'SETUP_REQUIRED_COMPONENT_MISSING' : 'SETUP_CHECK_UNAVAILABLE')) : resolve(stdout))),
});

function supportedNode(version: string): boolean {
  const [major, minor] = version.split('.').map(Number);
  return major > 22 || major === 22 && minor >= 18;
}

function observationFailure(error: unknown): { code: string; status: DoctorStatus; reason: string } {
  const code = (error as { code?: unknown } | null)?.code;
  if (error instanceof PathEvidenceError) return { code: error.code, status: 'fail', reason: '可信路径、归属或服务访问条件不满足安装器的共享规则。' };
  if (code === 'ENOENT' || error instanceof SetupError && code === 'SETUP_REQUIRED_COMPONENT_MISSING') {
    return { code: 'SETUP_REQUIRED_COMPONENT_MISSING', status: 'fail', reason: '只读观察确认所需路径或命令不存在。' };
  }
  if (error instanceof SyntaxError || error instanceof NetworkObservationError || error instanceof SetupError && code === 'SETUP_OBSERVATION_INVALID') {
    return { code: 'SETUP_OBSERVATION_INVALID', status: 'unknown', reason: '查询结果格式无法识别，未取得可靠观察证据。' };
  }
  return { code: 'SETUP_CHECK_UNAVAILABLE', status: 'unknown', reason: '查询未成功或访问受限，未取得可靠观察证据。' };
}
function recognized(output: string, pattern: RegExp): boolean {
  if (!pattern.test(output)) throw new SetupError('SETUP_OBSERVATION_INVALID');
  return true;
}

export function parseServiceIdentity(accounts: string, name: string, expectedUid?: number): number {
  const identity = inspectServiceAccount(accounts, name, expectedUid);
  if (identity.status === 'required') throw new SetupError('SETUP_SERVICE_ACCOUNT_REQUIRED');
  if (identity.status === 'invalid') throw new SetupError('SETUP_SERVICE_ACCOUNT_INVALID');
  return identity.uid;
}

/** All probes are bounded reads or fixed read-only system commands. Never prepares network resources. */
export async function inspectSetup(environmentInput?: unknown, host: DoctorHost = nativeHost()) {
  const checks: Check[] = [];
  const add = (id: CheckId, status: DoctorStatus, message: string, action?: string, required = true,
    detail?: { code: string; reason: string }) => checks.push({ id, layer: id.startsWith('deployment-directory-') ? 'identity' : checkLayers[id as keyof typeof checkLayers], status, required, message,
      code: detail?.code ?? (status === 'pass' ? 'SETUP_CHECK_PASSED' : status === 'fail' ? 'SETUP_REQUIREMENT_NOT_MET' : 'SETUP_CHECK_UNAVAILABLE'),
      reason: detail?.reason ?? (status === 'pass' ? '本次只读观察满足本项条件。' : status === 'fail'
        ? '已取得观察结果，但条件不满足要求。' : '未取得完整观察证据，不能判断本项通过。') + ' ' + message,
      action: action ?? '核对本项要求；满足后继续执行最终安装预检。' });
  const result = (serviceUid: number | null) => ({ schemaVersion: 1, serviceUid, checks,
    readyForInstallPreflight: checks.filter(check => check.required).every(check => check.status === 'pass'),
    layers: DOCTOR_LAYERS.map(layer => {
      const checkIds = checks.filter(check => check.layer === layer.id).map(check => check.id);
      return { ...layer, checkIds, coverage: checkIds.length ? 'partial' as const : 'not-assessed' as const };
    }) });
  let environment: SetupEnvironment | undefined;
  if (environmentInput === undefined) add('environment', 'unknown', '尚未提供环境输入，未检查账户、地址与具体运行工具路径。',
    '使用 --environment 提供私有环境文件。', true, { code: 'SETUP_ENVIRONMENT_REQUIRED', reason: '缺少环境输入，相关检查尚未执行。' });
  else {
    try {
      environment = parseSetupEnvironment(environmentInput);
      add('environment', 'pass', '环境字段已通过与最终部署计划共享的格式校验；不表示目标环境已就绪。');
    } catch {
      add('environment', 'fail', '环境输入未通过部署格式校验。', '按合成样本核对字段与取值，再重新运行。', true,
        { code: 'SETUP_ENVIRONMENT_INVALID', reason: '提供的环境对象不符合现有部署格式约束。' });
    }
  }
  add('linux', typeof host.platform !== 'string' || !host.platform ? 'unknown' : host.platform === 'linux' ? 'pass' : 'fail',
    '目标系统必须为 Linux。', '请在目标 Linux 外设运行本入口。');
  add('architecture', typeof host.architecture !== 'string' || !host.architecture ? 'unknown'
    : ['arm64', 'x64'].includes(host.architecture) ? 'pass' : 'fail', '发行载荷支持 ARM64 或 x86-64。');
  add('node', typeof host.nodeVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(host.nodeVersion) ? 'unknown'
    : supportedNode(host.nodeVersion) ? 'pass' : 'fail', 'Node.js 运行要求为 22.18 或以上。');
  add('privileges', host.uid === 0 ? 'pass' : 'unknown', '完整权限、网络规则和安装归属检查需要 root 只读访问。',
    '使用目标 root 身份重跑；本检查不会修改系统。');
  if (host.platform !== 'linux') return result(null);
  async function probe(id: CheckId, action: () => Promise<boolean>, message: string, remedy: string, required = true) {
    try { add(id, await action() ? 'pass' : 'fail', message, remedy, required); }
    catch (error) { const failure = observationFailure(error); add(id, failure.status, message, remedy, required, failure); }
  }
  const pathHost: PathEvidenceHost = { resolve: path => host.resolve(path), info: async path => {
    try {
      const stat = await host.stat(path);
      if (typeof stat.file !== 'boolean' || typeof stat.directory !== 'boolean' || typeof stat.link !== 'boolean' ||
        !Number.isSafeInteger(stat.nlink) || !Number.isInteger(stat.uid) || !Number.isInteger(stat.mode)) {
        throw new SetupError('SETUP_OBSERVATION_INVALID');
      }
      return { ...stat, file: stat.file, nlink: stat.nlink! };
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  } };
  async function trustedRun(path: string, args: string[]) {
    await assertTrustedExecutable(path, pathHost);
    return host.run(path, args);
  }
  await probe('systemd', async () => (await host.stat('/run/systemd/system')).directory,
    '安装目标须由 systemd 管理。', '核对目标的 init 系统，普通端口映射容器不满足当前部署要求。');
  await probe('python', async () => {
    const match = /^Python (\d+)\.(\d+)\.\d+/.exec(await trustedRun('/usr/bin/python3', ['--version']));
    if (!match) throw new SetupError('SETUP_OBSERVATION_INVALID');
    return Number(match[1]) > 3 || Number(match[1]) === 3 && Number(match[2]) >= 9;
  }, 'Python 需要 3.9 或以上，路径为 /usr/bin/python3。', '按支持组合的系统准备步骤安装或修正工具。');
  for (const [id, path, args, match, message] of [
    ['ip', '/usr/sbin/ip', ['-Version'], /ip utility|iproute2/, '需要可用的 iproute2。'],
    ['nft', '/usr/sbin/nft', ['--version'], /nftables/, '需要可用的 nftables。'],
    ['systemctl', environment?.system.systemctlPath ?? '/usr/bin/systemctl', ['--version'], /^systemd /, '需要可用的 systemctl。'],
  ] as const) await probe(id, async () => recognized(await trustedRun(path, [...args]), match), message, '按支持组合的系统准备步骤安装或修正工具。');
  await probe('polkit', async () => (await host.stat('/etc/polkit-1/rules.d')).directory,
    '需要 polkit JavaScript rules 目录；存在目录不证明既有授权规则安全。', '安装支持 JavaScript rules 的 polkit 并审阅既有授权。');
  await probe('tun', async () => (await host.stat('/dev/net/tun')).characterDevice,
    '需要 TUN 字符设备；存在设备不替代实际核心运行验收。', '按目标系统方法准备 TUN，检查容器或安全策略限制。');
  await probe('forwarding', async () => {
    const value = (await host.read('/proc/sys/net/ipv4/ip_forward')).trim();
    recognized(value, /^[01]$/);
    return value === '1';
  },
    'IPv4 转发应已开启。', '审阅并持久设置 IPv4 转发，再重新核对相关 IPv4 参数。');
  let serviceUid: number | null = null;
  if (environment) {
    try {
      const accounts = await trustedRun('/usr/bin/getent', ['passwd']);
      if (accounts.trim() && accounts.trim().split('\n').some(line => line.split(':').length !== 7)) {
        throw new SetupError('SETUP_OBSERVATION_INVALID');
      }
      serviceUid = parseServiceIdentity(accounts, environment.system.serviceUser, environment.system.serviceUid);
      add('service-account', 'pass', '专用非登录账户唯一对应已确认 UID。');
    } catch (error) {
      const identityCode = error instanceof SetupError && ['SETUP_SERVICE_ACCOUNT_REQUIRED', 'SETUP_SERVICE_ACCOUNT_INVALID'].includes(error.code)
        ? error.code : undefined;
      const failure = identityCode ? { code: identityCode, status: 'fail' as const, reason: identityCode === 'SETUP_SERVICE_ACCOUNT_REQUIRED'
        ? '账户快照中没有唯一匹配的专用账户。' : '账户快照中的 UID、非登录 shell 或身份唯一性不符合要求。' } : observationFailure(error);
      add('service-account', failure.status, '专用非登录账户应唯一对应已确认 UID。',
        '核对账户或查询权限后重跑；工具不会创建账户。', true, failure);
    }
    await probe('interface-address', async () => {
      const result = JSON.parse(await trustedRun('/usr/sbin/ip', ['-j', 'address', 'show', 'dev', environment.network.ingressInterface]));
      if (!Array.isArray(result)) throw new SetupError('SETUP_OBSERVATION_INVALID');
      if (result.length !== 1) return false;
      if (!Array.isArray(result[0]?.flags) || !Array.isArray(result[0]?.addr_info)) throw new SetupError('SETUP_OBSERVATION_INVALID');
      return result[0].flags.includes('UP') && result[0].addr_info.some((a: any) => a.family === 'inet' && a.local === environment.network.gatewayIPv4 &&
          a.prefixlen === Number(environment.network.clientCIDR.split('/')[1]));
    }, '指定接口应为 UP，且已配置所选 IPv4 与前缀。', '核对网口与地址；不要将 TUN 或其他网络误选为交付接口。');
    for (const [id, path] of [['node-path', environment.system.nodePath], ['systemctl-path', environment.system.systemctlPath]] as const) {
      await probe(id, async () => {
        const resolved = await assertTrustedExecutable(path, pathHost);
        await assertServiceAncestors(path, pathHost); await assertServiceAncestors(resolved, pathHost);
        return ((await pathHost.info(resolved))!.mode & 0o005) === 0o005;
      }, '运行工具及链接链必须由 root 控制，服务账户可遍历、读取和执行。', '核对工具及全部祖先的归属与权限，再执行最终安装预检。');
    }
    await probe('release-parent', async () => {
      await assertRootControlledPath(environment.system.releaseParent, pathHost);
      return Boolean((await pathHost.info(environment.system.releaseParent))?.directory);
    }, '发行安装父目录必须已存在且全部祖先由 root 控制。', '按安装准备步骤核对发行父目录，不使用链接或可写祖先。');
    await probe('receipt-directory', async () => {
      await assertPlannedDeploymentDirectory({ path: '/var/lib/cocoproxy-deployment', mode: '0700', owner: 'root' }, [], pathHost);
      return true;
    }, '已有部署收据目录必须为 root 私有目录，缺失时只检查其可信父目录。', '审阅收据目录归属及权限；不要移动或删除未知收据。');
    if (serviceUid === null) add('service-paths', 'unknown', '缺少可信服务 UID，未核对部署目录归属和服务遍历。');
    else {
      const input = createSetupDeployment(environment, { manifestSha256: 'a'.repeat(64), binarySha256: AUTOMATIC_GATEWAY_CORE_SHA256,
        serviceUid, controllerSecret: 'doctor-path-inspection-only' }) as any;
      const plan = renderDeploymentPlan(input);
      for (const [index, directory] of plan.directories.entries()) await probe(`deployment-directory-${index + 1}`, async () => {
        await assertPlannedDeploymentDirectory(directory, plan.directories, pathHost); return true;
      }, '部署计划中的目录及其祖先必须满足对应 root 或服务 UID 的归属和权限。', '按计划顺序审阅对应目录，不由 doctor 创建目录或修改权限。');
      await probe('service-paths', async () => {
        for (const path of [input.runtime.sourceDirectory, input.runtime.stateDirectory, input.management.credentialPath,
          ...plan.files.filter(file => file.owner !== 'root').map(file => file.path)]) await assertServiceAncestors(path, pathHost);
        return true;
      }, '服务账户必须可遍历发行、状态、凭据和服务文件的已存在祖先。', '核对祖先的服务遍历条件；缺失的计划目录由最终安装复核。');
    }
    await probe('configured-node-version', async () => {
      const version = (await trustedRun(environment.system.nodePath, ['--version'])).trim();
      recognized(version, /^v\d+\.\d+\.\d+$/);
      return supportedNode(version.slice(1));
    }, '安装设置指定的 Node 路径必须同样满足版本要求。', '不能用当前入口运行时的版本替代目标 nodePath 的版本。');
    const resources = { ...environment.resources, clientCIDR: environment.network.clientCIDR };
    const conflictReasons: Record<string, string> = {
      INSTALL_RULE_CONFLICT: '所选策略优先级或核心保留优先级已被占用。',
      INSTALL_RULE_MARK_CONFLICT: '现有 mark/mask 规则与出口或核心保留 mark 存在保守重叠。',
      INSTALL_ROUTE_CONFLICT: '出口表、回程表或核心保留路由表已被占用。',
      INSTALL_NFT_CONFLICT: '项目保护表或核心 nft 表已存在，需先核验归属并完成退役。',
      INSTALL_TUN_CONFLICT: '核心使用的 TUN 名称已存在，不能自动接管。',
    };
    for (const [id, path, args, assess] of [
      ['policy-rules', '/usr/sbin/ip', ['-j', '-4', 'rule', 'show'], (value: unknown) => policyRuleConflicts(value, resources)],
      ['routes', '/usr/sbin/ip', ['-N', '-j', '-4', 'route', 'show', 'table', 'all'], (value: unknown) => routeConflicts(value, resources)],
      ['firewall', '/usr/sbin/nft', ['-j', 'list', 'tables'], firewallConflicts],
      ['tun-name', '/usr/sbin/ip', ['-j', 'link', 'show'], tunConflicts],
    ] as const) {
      const message = '实际网络资源必须未被占用；合法 JSON 本身不能证明没有冲突。';
      const remedy = '先核对资源归属并按维护流程完成停机退役；不要清空规则或删除未知资源。';
      try {
        const conflicts = assess(JSON.parse(await trustedRun(path, [...args])));
        add(id, conflicts.length ? 'fail' : 'pass', message, remedy, true, conflicts.length ? {
          code: conflicts[0], reason: conflicts.map(code => conflictReasons[code]).join(' '),
        } : undefined);
        checks[checks.length - 1].conflicts = conflicts;
      } catch (error) { const failure = observationFailure(error); add(id, failure.status, message, remedy, true, failure); }
    }
    await probe('network-receipt', async () => {
      const path = '/var/lib/cocoproxy-gateway-network/network-receipt.json';
      if (!await pathHost.info(path)) return true;
      await assertRootControlledPath(path, pathHost); await assertPrivatePath(path, 0, pathHost);
      if (!networkReceiptRemoved(JSON.parse(await host.read(path)))) {
        throw new PathEvidenceError('INSTALL_NETWORK_REMOVE_REQUIRED');
      }
      return true;
    }, '已有网络回执必须明确记录已退役；缺失回执也不能免除实时资源检查。',
    '按维护入口核对完整或中断的网络资源并显式退役；doctor 不执行 prepare 或 remove。');
  }
  let installation: Awaited<ReturnType<typeof inspectDeployment>> | undefined;
  const installationIds = ['installation-receipt', 'installation-files', 'installation-locks', 'installation-maintenance', 'installation-identity'] as const;
  const installationAction = '先运行 inspect 审阅收据、漂移和维护状态；不要删除锁或覆盖未知文件。';
  try {
    if (!host.inspection || host.uid !== 0) throw new SetupError('SETUP_CHECK_UNAVAILABLE');
    installation = await host.inspection();
    if (installation.installed === false) {
      for (const id of installationIds) add(id, 'pass', '只读检查未发现部署收据目录；按首次安装继续最终预检。');
    } else if (installation.installed !== true || typeof installation.receipt !== 'object') {
      for (const id of installationIds) add(id, 'unknown', '已有安装收据缺失、不可信或未取得完整观察证据。', installationAction);
    } else {
      const complete = installation.receipt.status === 'complete';
      add('installation-receipt', complete ? 'pass' : 'fail', '已有安装须有完整收据，pending 或卸载残留须先审阅。', installationAction, true,
        complete ? undefined : { code: 'SETUP_INSTALLATION_INCOMPLETE', reason: '部署收据记录未完成或已卸载状态。' });
      const fileStatuses = installation.files?.map(file => file.status) ?? [];
      const fileUnknown = !fileStatuses.length || fileStatuses.includes('INSTALL_INSPECTION_UNAVAILABLE') || installation.release === 'INSTALL_INSPECTION_UNAVAILABLE';
      const filesMatch = fileStatuses.length > 0 && fileStatuses.every(status => status === 'matches-receipt') && installation.release === 'matches-receipt';
      add('installation-files', fileUnknown ? 'unknown' : filesMatch ? 'pass' : 'fail', '收据管理文件的类型、归属、模式、字节及发行内容须与记录一致。', installationAction, true,
        fileUnknown || filesMatch ? undefined : { code: 'SETUP_INSTALLATION_DRIFT', reason: '安装检查确认文件或发行内容缺失、改变或不符合收据。' });
      const pending = installation.lifecycleJournal && installation.lifecycleJournal.status !== 'complete';
      const locked = installation.lock?.present || installation.recoveryLock?.present || installation.lifecycleClaim?.present || pending || installation.temporaryFiles?.length;
      const locksUnknown = !installation.lock || !installation.recoveryLock || !installation.lifecycleClaim || installation.temporaryFilesComplete !== true;
      add('installation-locks', locked ? 'fail' : locksUnknown ? 'unknown' : 'pass', '安装、恢复、生命周期锁及未完成 journal 或临时写入须先审阅。', installationAction, true,
        locked ? { code: installation.lock?.owner === 'alive' ? 'SETUP_INSTALLATION_BUSY' : 'SETUP_INSTALLATION_INCOMPLETE',
          reason: installation.lock?.owner === 'alive' ? '安装检查确认事务锁所属进程仍存活。' : '观察到锁、未完成生命周期记录或残留临时写入。' } : undefined);
      const maintenance = installation.maintenance?.status;
      add('installation-maintenance', maintenance === 'ready' ? 'pass' : maintenance === 'running' || maintenance === 'invalid' ? 'fail' : 'unknown',
        '已有持久运行须处于允许维护的暂停或关闭状态。', '按维护流程显式暂停；不要由 doctor 改写生命周期状态。', true,
        maintenance === 'running' || maintenance === 'invalid' ? { code: 'SETUP_MAINTENANCE_REQUIRED', reason: '现有生命周期仍运行或不满足安装器维护状态约束。' } : undefined);
      const identity = installation.identity;
      const identityKnown = Boolean(environment && serviceUid !== null && identity);
      const identityMatches = identityKnown && identity!.serviceUid === serviceUid && identity!.stateDirectory === '/var/lib/cocoproxy' &&
        identity!.credentialPath === '/etc/cocoproxy/admin.json' && identity!.release.startsWith(environment!.system.releaseParent + '/');
      add('installation-identity', !identityKnown ? 'unknown' : identityMatches ? 'pass' : 'fail', '当前环境身份与布局须匹配已验证收据。', installationAction, true,
        identityKnown && !identityMatches ? { code: 'SETUP_INSTALLATION_IDENTITY_MISMATCH', reason: '服务 UID 或安装布局与已有收据不一致。' } : undefined);
    }
  } catch (error) {
    const failure = observationFailure(error);
    for (const id of installationIds) add(id, 'unknown', '未取得完整的已有安装只读检查证据。', installationAction, true,
      { code: failure.status === 'fail' ? 'SETUP_CHECK_UNAVAILABLE' : failure.code, reason: '安装观察不可用，不能把查询失败解释成未安装。' });
  }
  if (environment) {
    let sockets: ListeningSocket[] | undefined;
    let listenerFailure: ReturnType<typeof observationFailure> | undefined;
    let boundObservation = false;
    let boundFailed = false;
    try {
      let binary: string | undefined;
      for (const candidate of ['/usr/bin/ss', '/usr/sbin/ss']) {
        if (!await pathHost.info(candidate)) continue;
        await assertTrustedExecutable(candidate, pathHost); binary = candidate; break;
      }
      if (!binary) throw new SetupError('SETUP_REQUIRED_COMPONENT_MISSING');
      sockets = [];
      for (const [family, args] of [[4, ['-H', '-4', '-antup']], [6, ['-H', '-6', '-antup']]] as const) {
        try { sockets.push(...parseListeningSockets(await trustedRun(binary, [...args]), family)); }
        catch (error) { listenerFailure = observationFailure(error); }
      }
      for (const family of [4, 6] as const) {
        try {
          const observed = parseListeningSockets(await trustedRun(binary, ['-H', '-' + family, '-B', '-ntup']), family);
          sockets.push(...observed); boundObservation ||= observed.length > 0;
        } catch { boundFailed = true; }
      }
    } catch (error) { listenerFailure = observationFailure(error); }
    add('bound-sockets', boundObservation && !boundFailed ? 'pass' : 'unknown',
      '可选读取较新 ss 的仅绑定未监听 TCP 范围；空输出也不能证明内核提供此能力。',
      '按维护流程停止服务后继续最终安装预检；不要为此自动升级工具或尝试绑定端口。', false,
      boundObservation && !boundFailed ? undefined : { code: 'SETUP_PORT_BOUND_SCOPE_UNAVAILABLE',
        reason: '本次没有取得完整的仅绑定未监听 TCP 观察证据；此额外范围未覆盖，不要求升级 ss。' });
    const installedSnapshot = installation?.installed === true ? installation : undefined;
    const trustedInstallation = installedSnapshot?.receipt?.status === 'complete' && installedSnapshot.release === 'matches-receipt' &&
      installedSnapshot.files?.every(file => file.status === 'matches-receipt') && installedSnapshot.identity?.serviceUid === serviceUid;
    async function socketOwner(socket: ListeningSocket, target: ListeningTarget): Promise<'owned' | 'foreign' | 'unknown'> {
      if (installation?.installed === false) return 'foreign';
      if (!trustedInstallation || !installedSnapshot?.identity || !socket.pids.length ||
        !installedSnapshot.files?.some(file => file.path === '/etc/systemd/system/' + target.unit && file.status === 'matches-receipt')) return 'unknown';
      try {
        const output = await trustedRun(environment!.system.systemctlPath, ['show', target.unit, '--property=MainPID,FragmentPath,DropInPaths,NeedDaemonReload']);
        const properties = Object.fromEntries(output.trim().split('\n').map(line => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)]; }));
        if (!/^[1-9]\d*$/.test(properties.MainPID ?? '') || properties.FragmentPath !== '/etc/systemd/system/' + target.unit ||
          properties.DropInPaths !== '' || properties.NeedDaemonReload !== 'no') return 'unknown';
        const expected = target.executable === 'node' ? environment!.system.nodePath : target.executable === 'nginx' && environment!.https?.mode === 'managed'
          ? environment!.https.nginxPath : installedSnapshot.identity.release + '/bin/mihomo';
        const executable = await host.resolve(expected);
        for (const pid of socket.pids) {
          const actual = await host.resolve('/proc/' + pid + '/exe');
          const groups = (await host.read('/proc/' + pid + '/cgroup')).trim().split('\n');
          if (actual !== executable || !groups.some(group => group.slice(group.lastIndexOf(':') + 1).endsWith('/' + target.unit))) return 'foreign';
        }
        return socket.pids.includes(Number(properties.MainPID)) ? 'owned' : 'unknown';
      } catch { return 'unknown'; }
    }
    for (const target of setupListeningTargets(environment)) {
      const message = '当次可观察 socket 范围须无计划地址、协议和端口重叠，可继续最终安装预检；已有自有占用仍须先停服。';
      const action = '按端口用途审阅监听及进程归属；显式停服或选择新端口，doctor 不终止进程。';
      if (!sockets) { const failure = listenerFailure!; add(target.id, failure.status, message, action, true, failure); continue; }
      const conflicts = sockets.filter(socket => listenerOverlap(socket, target) !== 'no');
      if (!conflicts.length) { add(target.id, listenerFailure ? 'unknown' : 'pass', message, action, true, listenerFailure ? {
        code: 'SETUP_PORT_OBSERVATION_INCOMPLETE', reason: '未取得必要的 IPv4/IPv6 监听与已连接 socket 观察证据；不能判定本项通过。',
      } : undefined); continue; }
      const owners = await Promise.all(conflicts.map(socket => socketOwner(socket, target)));
      const definite = conflicts.map((socket, index) => ({ socket, owner: owners[index] })).filter(({ socket }) =>
        listenerOverlap(socket, target) === 'yes' && ['LISTEN', 'UNCONN'].includes(socket.state));
      const foreign = definite.some(({ owner }) => owner === 'foreign');
      const owned = definite.some(({ owner }) => owner === 'owned');
      add(target.id, foreign || owned ? 'fail' : 'unknown', message, action, true, {
        code: foreign ? 'SETUP_PORT_CONFLICT' : owned ? 'SETUP_PORT_OWNED_REQUIRES_STOP' : 'SETUP_PORT_OWNERSHIP_UNKNOWN',
        reason: foreign ? '观察到与计划监听重叠的非自有占用。' : owned ? '收据、unit 主进程、进程可执行文件及 cgroup 共同确认自有占用，须先停服。'
          : '存在已连接或可能重叠的绑定，但归属、复用或 IPv6 双栈证据不足，不能认定端口可用。',
      });
    }
    if (environment.https?.mode !== 'managed') add('external-https', 'unknown', '外部反向代理的配置、实际转发和 HTTPS 登录须独立验证。',
      '按外部 HTTPS 配方验证实际入口和转发头。', false, { code: 'SETUP_EXTERNAL_VERIFICATION_REQUIRED', reason: '本次只读安装观察没有取得外部反代的配置与访问证据。' });
  }
  if (environment?.https?.mode === 'managed') {
    const remedies: Record<string, string> = {
      SETUP_HTTPS_INVALID: '核对受管 HTTPS 的 origin、非特权端口和证书路径。',
      SETUP_HTTPS_PATH_UNTRUSTED: '核对证书、私钥和 nginx 的全部祖先目录归属、权限及服务账户遍历条件。',
      SETUP_HTTPS_FILE_UNTRUSTED: '核对 nginx、证书和私钥的归属、权限、文件类型及链接；私钥必须由服务 UID 所有且为 0600。',
      SETUP_HTTPS_CERTIFICATE_EXPIRED: '证书尚未生效或已过期；核对系统时间和证书有效期。',
      SETUP_HTTPS_CERTIFICATE_NAME_MISMATCH: '证书 SAN 必须覆盖管理 origin 的主机名或 IP，不能仅依靠 CN。',
      SETUP_HTTPS_KEY_MISMATCH: '准备与证书匹配的私钥，再重新检查。',
      SETUP_HTTPS_PREFLIGHT_FAILED: '核对证书及私钥的格式和可读性，再重新检查。',
    };
    const message = '受管 HTTPS 需要可信 nginx、有效且覆盖 origin 的证书，以及匹配的私有密钥。';
    if (host.uid !== 0 || serviceUid === null || !host.managedWeb) {
      add('managed-https', 'unknown', message, '使用目标 root 身份、有效服务账户和完整检查器重跑。', true,
        { code: 'SETUP_HTTPS_PREFLIGHT_UNAVAILABLE', reason: '缺少受管 HTTPS 检查所需的身份或观察能力，未执行完整校验。' });
    } else {
      try {
        await host.managedWeb({ web: { schemaVersion: 1, nginxPath: environment.https.nginxPath,
          certificatePath: environment.https.certificatePath, privateKeyPath: environment.https.privateKeyPath },
          gatewayIPv4: environment.network.gatewayIPv4, origin: environment.management.origin,
          listenPort: environment.ports.management, serviceUid });
        add('managed-https', 'pass', message);
      } catch (error) {
        const code = error instanceof ManagedWebError && Object.hasOwn(remedies, error.code) ? error.code : 'SETUP_HTTPS_PREFLIGHT_UNAVAILABLE';
        add('managed-https', code === 'SETUP_HTTPS_PREFLIGHT_UNAVAILABLE' ? 'unknown' : 'fail', message,
          remedies[code] ?? '检查器未取得完整证据；使用目标 root 身份重跑安装预检。', true,
          { code, reason: code === 'SETUP_HTTPS_PREFLIGHT_UNAVAILABLE' ? '受管 HTTPS 检查未取得完整观察证据。'
            : '受管 HTTPS 的证书、密钥或可信文件条件未通过校验；按固定原因码处理。' });
      }
    }
  }
  add('router-contract', 'unknown', '路由器协作条件仍须通过适配说明及两端验收确认。', '按路由器协作约定核对交付、DNS、保护与独立关闭。', false,
    { code: 'SETUP_EXTERNAL_VERIFICATION_REQUIRED', reason: '尚未取得路由器组合的实际验收证据。' });
  add('https-client-trust', 'unknown', '服务器只读检查不能证明浏览器信任证书或登录成功。', '在实际终端验证 HTTPS 证书信任和登录。', false,
    { code: 'SETUP_EXTERNAL_VERIFICATION_REQUIRED', reason: '终端信任和实际登录不能由本次服务器只读检查判定。' });
  return result(serviceUid);
}

export async function resolveServiceUid(environment: SetupEnvironment): Promise<number> {
  if (process.platform !== 'linux') {
    if (environment.system.serviceUid !== undefined) return environment.system.serviceUid;
    throw new SetupError('SETUP_SERVICE_UID_REQUIRES_TARGET');
  }
  return parseServiceIdentity(await nativeHost().run('/usr/bin/getent', ['passwd']), environment.system.serviceUser, environment.system.serviceUid);
}
