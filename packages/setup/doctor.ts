import { execFile } from 'node:child_process';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { arch, platform } from 'node:os';
import { createSetupDeployment, parseSetupEnvironment, SetupError, type SetupEnvironment } from './input.ts';
import { ManagedWebError, verifyManagedWeb, type ManagedWebInput } from './https.ts';
import { inspectServiceAccount } from '../deployment/service-account.ts';
import { assertRootControlledPath, assertTrustedExecutable, assertServiceAncestors, assertPlannedDeploymentDirectory,
  PathEvidenceError, type PathEvidenceHost } from '../deployment/path-evidence.ts';
import { renderDeploymentPlan } from '../deployment/plan.ts';
import { AUTOMATIC_GATEWAY_CORE_SHA256 } from '../gateway/profile.ts';
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
}
const checkLayers = {
  linux: 'foundation', architecture: 'foundation', node: 'foundation', systemd: 'foundation', environment: 'foundation',
  python: 'components', ip: 'components', nft: 'components', systemctl: 'components', polkit: 'components',
  privileges: 'identity', 'service-account': 'identity', 'node-path': 'identity', 'systemctl-path': 'identity',
  'release-parent': 'identity', 'receipt-directory': 'identity', 'service-paths': 'identity',
  'configured-node-version': 'components', tun: 'network', forwarding: 'network', 'interface-address': 'network',
  'policy-rules': 'network', routes: 'network', firewall: 'network', 'router-contract': 'network',
  'managed-https': 'management', 'https-client-trust': 'management',
} as const satisfies Record<string, DoctorLayer>;
type CheckId = keyof typeof checkLayers | `deployment-directory-${number}`;
export interface DoctorHost {
  platform: string; architecture: string; nodeVersion: string; uid: number;
  read(path: string): Promise<string>;
  stat(path: string): Promise<{ directory: boolean; characterDevice: boolean; uid: number; mode: number; link: boolean; file?: boolean; nlink?: number }>;
  resolve(path: string): Promise<string>;
  run(path: string, args: string[]): Promise<string>;
  managedWeb?(input: ManagedWebInput): Promise<void>;
}
const nativeHost = (): DoctorHost => ({
  platform: platform(), architecture: arch(), nodeVersion: process.versions.node, uid: process.getuid?.() ?? -1,
  read: path => readFile(path, 'utf8'), resolve: realpath, managedWeb: verifyManagedWeb,
  stat: async path => { const s = await lstat(path); return { directory: s.isDirectory(), characterDevice: s.isCharacterDevice(),
    uid: s.uid, mode: s.mode, link: s.isSymbolicLink(), file: s.isFile(), nlink: s.nlink }; },
  run: (path, args) => new Promise((resolve, reject) => execFile(path, args, {
    timeout: 5000, maxBuffer: 2 * 1024 * 1024, windowsHide: true, env: { PATH: '/usr/sbin:/usr/bin', LC_ALL: 'C' },
  }, (error, stdout) => error ? reject(new SetupError((error as NodeJS.ErrnoException).code === 'ENOENT'
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
  if (error instanceof SyntaxError || error instanceof SetupError && code === 'SETUP_OBSERVATION_INVALID') {
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
    for (const [id, path, args, field] of [
      ['policy-rules', '/usr/sbin/ip', ['-j', 'rule', 'show'], null],
      ['routes', '/usr/sbin/ip', ['-j', 'route', 'show', 'table', 'all'], null],
      ['firewall', '/usr/sbin/nft', ['-j', 'list', 'ruleset'], 'nftables'],
    ] as const) await probe(id, async () => {
      const value = JSON.parse(await trustedRun(path, [...args]));
      if (!Array.isArray(field === null ? value : value?.[field])) throw new SetupError('SETUP_OBSERVATION_INVALID');
      return true;
    }, '可读取策略路由或防火墙 JSON；资源归属与冲突由安装预检进一步核验。', '核对权限与工具 JSON 能力，不能清空现有规则。');
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
  add('https-client-trust', 'unknown', '服务器只读检查不能证明浏览器信任证书或通知实际送达。', '在实际终端验证 HTTPS 登录和可选通知。', false,
    { code: 'SETUP_EXTERNAL_VERIFICATION_REQUIRED', reason: '终端信任和实际通知显示不能由本次服务器只读检查判定。' });
  return result(serviceUid);
}

export async function resolveServiceUid(environment: SetupEnvironment): Promise<number> {
  if (process.platform !== 'linux') {
    if (environment.system.serviceUid !== undefined) return environment.system.serviceUid;
    throw new SetupError('SETUP_SERVICE_UID_REQUIRES_TARGET');
  }
  return parseServiceIdentity(await nativeHost().run('/usr/bin/getent', ['passwd']), environment.system.serviceUser, environment.system.serviceUid);
}
