import { execFile } from 'node:child_process';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { arch, platform } from 'node:os';
import { parseSetupEnvironment, SetupError, type SetupEnvironment } from './input.ts';
import { ManagedWebError, verifyManagedWeb, type ManagedWebInput } from './https.ts';
import { inspectServiceAccount } from '../deployment/service-account.ts';

export interface Check { id: string; status: 'pass' | 'fail' | 'unknown'; required: boolean; message: string; action?: string; code?: string }
export interface DoctorHost {
  platform: string; architecture: string; nodeVersion: string; uid: number;
  read(path: string): Promise<string>;
  stat(path: string): Promise<{ directory: boolean; characterDevice: boolean; uid: number; mode: number; link: boolean }>;
  resolve(path: string): Promise<string>;
  run(path: string, args: string[]): Promise<string>;
  managedWeb?(input: ManagedWebInput): Promise<void>;
}
const nativeHost = (): DoctorHost => ({
  platform: platform(), architecture: arch(), nodeVersion: process.versions.node, uid: process.getuid?.() ?? -1,
  read: path => readFile(path, 'utf8'), resolve: realpath, managedWeb: verifyManagedWeb,
  stat: async path => { const s = await lstat(path); return { directory: s.isDirectory(), characterDevice: s.isCharacterDevice(),
    uid: s.uid, mode: s.mode, link: s.isSymbolicLink() }; },
  run: (path, args) => new Promise((resolve, reject) => execFile(path, args, {
    timeout: 5000, maxBuffer: 2 * 1024 * 1024, windowsHide: true, env: { PATH: '/usr/sbin:/usr/bin', LC_ALL: 'C' },
  }, (error, stdout) => error ? reject(new SetupError('SETUP_CHECK_UNAVAILABLE')) : resolve(stdout))),
});

function supportedNode(version: string): boolean {
  const [major, minor] = version.split('.').map(Number);
  return major > 22 || major === 22 && minor >= 18;
}

export function parseServiceIdentity(accounts: string, name: string, expectedUid?: number): number {
  const identity = inspectServiceAccount(accounts, name, expectedUid);
  if (identity.status === 'required') throw new SetupError('SETUP_SERVICE_ACCOUNT_REQUIRED');
  if (identity.status === 'invalid') throw new SetupError('SETUP_SERVICE_ACCOUNT_INVALID');
  return identity.uid;
}

/** All probes are bounded reads or fixed read-only system commands. Never prepares network resources. */
export async function inspectSetup(environmentInput?: unknown, host: DoctorHost = nativeHost()) {
  const environment = environmentInput === undefined ? undefined : parseSetupEnvironment(environmentInput);
  const checks: Check[] = [];
  const add = (id: string, status: Check['status'], message: string, action?: string, required = true) =>
    checks.push({ id, status, required, message, ...(action ? { action } : {}) });
  add('linux', host.platform === 'linux' ? 'pass' : 'fail', '目标系统必须为 Linux。', '请在目标 Linux 外设运行本入口。');
  add('architecture', ['arm64', 'x64'].includes(host.architecture) ? 'pass' : 'fail', '发行载荷支持 ARM64 或 x86-64。');
  add('node', supportedNode(host.nodeVersion) ? 'pass' : 'fail', 'Node.js 运行要求为 22.18 或以上。');
  add('privileges', host.uid === 0 ? 'pass' : 'unknown', '完整权限、网络规则和安装归属检查需要 root 只读访问。',
    '使用目标 root 身份重跑；本检查不会修改系统。');
  if (host.platform !== 'linux') return { schemaVersion: 1, readyForInstallPreflight: false, serviceUid: null, checks };
  async function probe(id: string, action: () => Promise<boolean>, message: string, remedy: string, required = true) {
    try { add(id, await action() ? 'pass' : 'fail', message, remedy, required); }
    catch { add(id, 'unknown', message, remedy, required); }
  }
  await probe('systemd', async () => (await host.stat('/run/systemd/system')).directory,
    '安装目标须由 systemd 管理。', '核对目标的 init 系统，普通端口映射容器不满足当前部署要求。');
  for (const [id, path, args, match, message] of [
    ['python', '/usr/bin/python3', ['--version'], /^Python 3\.(?:9|[1-9]\d)\./, 'Python 需要 3.9 或以上，路径为 /usr/bin/python3。'],
    ['ip', '/usr/sbin/ip', ['-Version'], /ip utility|iproute2/, '需要可用的 iproute2。'],
    ['nft', '/usr/sbin/nft', ['--version'], /nftables/, '需要可用的 nftables。'],
    ['systemctl', environment?.system.systemctlPath ?? '/usr/bin/systemctl', ['--version'], /^systemd /, '需要可用的 systemctl。'],
  ] as const) await probe(id, async () => match.test(await host.run(path, [...args])), message, '按支持组合的系统准备步骤安装或修正工具。');
  await probe('polkit', async () => (await host.stat('/etc/polkit-1/rules.d')).directory,
    '需要 polkit JavaScript rules 目录；存在目录不证明既有授权规则安全。', '安装支持 JavaScript rules 的 polkit 并审阅既有授权。');
  await probe('tun', async () => (await host.stat('/dev/net/tun')).characterDevice,
    '需要 TUN 字符设备；存在设备不替代实际核心运行验收。', '按目标系统方法准备 TUN，检查容器或安全策略限制。');
  await probe('forwarding', async () => (await host.read('/proc/sys/net/ipv4/ip_forward')).trim() === '1',
    'IPv4 转发应已开启。', '审阅并持久设置 IPv4 转发，再重新核对相关 IPv4 参数。');
  let serviceUid: number | null = null;
  if (environment) {
    try {
      serviceUid = parseServiceIdentity(await host.run('/usr/bin/getent', ['passwd']), environment.system.serviceUser, environment.system.serviceUid);
      add('service-account', 'pass', '专用非登录账户唯一对应已确认 UID。');
    } catch { add('service-account', 'fail', '专用非登录账户缺失、重复或身份不匹配。', '创建或核对该专用账户；工具不会创建账户。'); }
    await probe('interface-address', async () => {
      const result = JSON.parse(await host.run('/usr/sbin/ip', ['-j', 'address', 'show', 'dev', environment.network.ingressInterface]));
      return Array.isArray(result) && result.length === 1 && result[0].flags?.includes('UP') &&
        result[0].addr_info?.some((a: any) => a.family === 'inet' && a.local === environment.network.gatewayIPv4 &&
          a.prefixlen === Number(environment.network.clientCIDR.split('/')[1]));
    }, '指定接口应为 UP，且已配置所选 IPv4 与前缀。', '核对网口与地址；不要将 TUN 或其他网络误选为交付接口。');
    for (const [id, path] of [['node-path', environment.system.nodePath], ['systemctl-path', environment.system.systemctlPath]] as const) {
      await probe(id, async () => {
        const resolved = await host.resolve(path), s = await host.stat(resolved);
        return !s.directory && !s.link && s.uid === 0 && (s.mode & 0o022) === 0 && (s.mode & 0o005) === 0o005;
      }, '运行工具应为 root 控制且服务账户可读取和执行。', '使用系统安装的工具，最终安装预检仍会核对全部祖先。');
    }
    await probe('configured-node-version', async () => {
      const version = (await host.run(environment.system.nodePath, ['--version'])).trim();
      return /^v\d+\.\d+\.\d+$/.test(version) && supportedNode(version.slice(1));
    }, '安装设置指定的 Node 路径必须同样满足版本要求。', '不能用当前入口运行时的版本替代目标 nodePath 的版本。');
    for (const [id, path, args, field] of [
      ['policy-rules', '/usr/sbin/ip', ['-j', 'rule', 'show'], null],
      ['routes', '/usr/sbin/ip', ['-j', 'route', 'show', 'table', 'all'], null],
      ['firewall', '/usr/sbin/nft', ['-j', 'list', 'ruleset'], 'nftables'],
    ] as const) await probe(id, async () => {
      const value = JSON.parse(await host.run(path, [...args]));
      return Array.isArray(field === null ? value : value[field]);
    }, '可读取策略路由或防火墙 JSON；资源归属与冲突由安装预检进一步核验。', '核对权限与工具 JSON 能力，不能清空现有规则。');
  } else add('environment', 'unknown', '尚未提供环境输入，未检查账户、地址与具体运行工具路径。', '使用 --environment 提供私有环境文件。');
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
      checks.push({ id: 'managed-https', status: 'unknown', required: true, message,
        code: 'SETUP_HTTPS_PREFLIGHT_UNAVAILABLE', action: '使用目标 root 身份、有效服务账户和完整检查器重跑。' });
    } else {
      try {
        await host.managedWeb({ web: { schemaVersion: 1, nginxPath: environment.https.nginxPath,
          certificatePath: environment.https.certificatePath, privateKeyPath: environment.https.privateKeyPath },
          gatewayIPv4: environment.network.gatewayIPv4, origin: environment.management.origin,
          listenPort: environment.ports.management, serviceUid });
        add('managed-https', 'pass', message);
      } catch (error) {
        const code = error instanceof ManagedWebError && Object.hasOwn(remedies, error.code) ? error.code : 'SETUP_HTTPS_PREFLIGHT_UNAVAILABLE';
        checks.push({ id: 'managed-https', status: code === 'SETUP_HTTPS_PREFLIGHT_UNAVAILABLE' ? 'unknown' : 'fail', required: true,
          message, code, action: remedies[code] ?? '检查器未取得完整证据；使用目标 root 身份重跑安装预检。' });
      }
    }
  }
  add('router-contract', 'unknown', '路由器协作条件仍须通过适配说明及两端验收确认。', '按路由器协作约定核对交付、DNS、保护与独立关闭。', false);
  add('https-client-trust', 'unknown', '服务器只读检查不能证明浏览器信任证书或通知实际送达。', '在实际终端验证 HTTPS 登录和可选通知。', false);
  return { schemaVersion: 1, readyForInstallPreflight: checks.filter(c => c.required).every(c => c.status === 'pass'), serviceUid, checks };
}

export async function resolveServiceUid(environment: SetupEnvironment): Promise<number> {
  if (process.platform !== 'linux') {
    if (environment.system.serviceUid !== undefined) return environment.system.serviceUid;
    throw new SetupError('SETUP_SERVICE_UID_REQUIRES_TARGET');
  }
  return parseServiceIdentity(await nativeHost().run('/usr/bin/getent', ['passwd']), environment.system.serviceUser, environment.system.serviceUid);
}
