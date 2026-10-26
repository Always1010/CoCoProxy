import { constants } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, open, readFile, realpath, rm } from 'node:fs/promises';
import { dirname, join, posix } from 'node:path';
import { isIP } from 'node:net';
import { createInterface } from 'node:readline/promises';
import { pathToFileURL } from 'node:url';
import { inspectServiceAccount } from '../packages/deployment/service-account.ts';
import { assertRootControlledPath, assertTrustedExecutable, assertServiceAncestors } from '../packages/deployment/path-evidence.ts';

const fail = code => { throw Object.assign(new Error(code), { code }); };
const receiptPath = '/var/lib/cocoproxy-deployment/receipt.json';
const inputPath = '/etc/cocoproxy-install/deployment.json';
const journalPath = '/etc/cocoproxy-install/remote-last.json';
export const INSTALL_ARTIFACTS = ['/etc/cocoproxy/runtime.json', '/etc/cocoproxy/management.json', '/etc/cocoproxy/admin.json',
  '/var/lib/cocoproxy', '/var/lib/cocoproxy-gateway-network', '/var/lib/cocoproxy-deployment/install.lock',
  '/var/lib/cocoproxy-deployment/recovery.lock', '/etc/systemd/system/cocoproxy-management.service',
  '/etc/systemd/system/cocoproxy-mihomo.service', '/etc/systemd/system/cocoproxy-web.service',
  '/etc/systemd/system/cocoproxy-gateway-guard.service', '/etc/systemd/system/cocoproxy-gateway-network.service'];
const nativeInfo = async path => {
  try { const s = await lstat(path); return { directory: s.isDirectory(), file: s.isFile(), link: s.isSymbolicLink(),
    uid: s.uid, mode: s.mode, nlink: s.nlink, size: s.size }; }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
};
const pathHost = { info: nativeInfo, resolve: realpath };

export async function assertLocalTarget() {
  if (process.platform !== 'linux' || !['arm64', 'x64'].includes(process.arch)) fail('LOCAL_UBUNTU_TARGET_REQUIRED');
  if (process.getuid?.() !== 0) fail('LOCAL_DEPLOY_ROOT_REQUIRED');
  const version = process.versions.node.split('.').map(Number);
  if (version[0] < 22 || version[0] === 22 && version[1] < 18) fail('LOCAL_NODE_22_18_REQUIRED');
  if (!/^ID=ubuntu$/m.test(await readFile('/etc/os-release', 'utf8')) || !(await nativeInfo('/run/systemd/system'))?.directory) fail('LOCAL_UBUNTU_SYSTEMD_REQUIRED');
  const node = await assertTrustedExecutable(process.execPath, pathHost);
  await assertServiceAncestors(node, pathHost);
  // Coordinator's public entry invokes node by name, so use this already verified engine.
  process.env.PATH = `${dirname(process.execPath)}:/usr/sbin:/usr/bin:/sbin:/bin`;
}

async function privateJSON(path, host) {
  const stat = await host.info(path);
  if (!stat?.file || stat.link || stat.nlink !== 1 || stat.uid !== 0 || (stat.mode & 0o7777) !== 0o600 || stat.size > 128 * 1024) fail('LOCAL_INSTALL_STATE_REQUIRES_REVIEW');
  await assertRootControlledPath(dirname(path), host);
  if (((await host.info(dirname(path))).mode & 0o7777) !== 0o700) fail('LOCAL_INSTALL_STATE_REQUIRES_REVIEW');
  try { return JSON.parse(await host.read(path)); } catch { fail('LOCAL_INSTALL_STATE_REQUIRES_REVIEW'); }
}

/** Presence is never treated as proof of a fresh install; all decisions precede prompts. */
export async function detectLocalInstallation(host = { ...pathHost, read: path => readFile(path, 'utf8') }) {
  const receipt = await host.info(receiptPath), input = await host.info(inputPath), journal = await host.info(journalPath);
  if (journal && (await privateJSON(journalPath, host)).status !== 'complete') fail('LOCAL_INSTALL_STATE_REQUIRES_REVIEW');
  if (receipt) {
    if ((await privateJSON(receiptPath, host)).status !== 'complete' || !input) fail('LOCAL_INSTALL_STATE_REQUIRES_REVIEW');
    await privateJSON(inputPath, host);
    return 'existing'; // The public coordinator validates full receipt/input/file identity.
  }
  if (input || journal) fail('LOCAL_INSTALL_STATE_REQUIRES_REVIEW');
  for (const path of INSTALL_ARTIFACTS) if (await host.info(path)) fail('LOCAL_INSTALL_STATE_REQUIRES_REVIEW');
  return 'first';
}

export async function needsUpdateRouterAdapter(manifestSha256, host = { ...pathHost, read: path => readFile(path, 'utf8') }) {
  if ((await privateJSON(receiptPath, host)).manifestSha256 === manifestSha256) return false;
  if (!(await privateJSON(inputPath, host)).runtime?.automaticGateway) return false;
  const profilePath = '/etc/cocoproxy-install/remote.json', configPath = '/etc/cocoproxy-install/router-ssh.json';
  if (await host.info(profilePath)) {
    const profile = await privateJSON(profilePath, host);
    if (typeof profile.routerHook === 'string' && profile.routerHook) return false;
  }
  if (await host.info(configPath)) { await privateJSON(configPath, host); return false; }
  return true;
}

export async function collectRouterAdapter(terminal) {
  terminal.write('此次网关更新需要路由器维护适配器，以查询、独立关闭并恢复原交付意图；即使尚未开启交付也必须核验。');
  const choice = await terminal.prompt('适配器：1 使用既有私有 SSH 配置；2 填写 AlwayRoute SSH 参数；3 使用 root 控制的既有 hook', '1');
  if (choice === '1' || choice === '3') {
    const path = await terminal.prompt(choice === '1' ? '私有 router SSH 配置绝对路径' : '可信 hook 可执行文件绝对路径');
    if (!posix.isAbsolute(path) || posix.normalize(path) !== path || /[\x00-\x1f\x7f]/.test(path)) fail('LOCAL_ROUTER_ADAPTER_INPUT_INVALID');
    return { flag: choice === '1' ? '--router-config' : '--router-hook', path };
  }
  if (choice !== '2') fail('LOCAL_ROUTER_ADAPTER_INPUT_INVALID');
  const host = await terminal.prompt('已核验的路由器 SSH IP');
  const user = await terminal.prompt('路由器 SSH 用户（必须已具备公开 ubus 权限）');
  const rawPort = await terminal.prompt('路由器 SSH 端口', '22');
  const identityFile = await terminal.prompt('目标网关上既有私钥绝对路径（不复制密钥）');
  const knownHostsFile = await terminal.prompt('目标网关上已核验的 known_hosts 绝对路径');
  if (!isIP(host) || !/^[a-z_][a-z0-9_-]{0,31}$/.test(user) || !/^\d{1,5}$/.test(rawPort) || Number(rawPort) < 1 || Number(rawPort) > 65535 ||
      [identityFile, knownHostsFile].some(path => !posix.isAbsolute(path) || posix.normalize(path) !== path || /[\x00-\x1f\x7f]/.test(path))) fail('LOCAL_ROUTER_ADAPTER_INPUT_INVALID');
  return { flag: '--router-config', config: { host, user, port: Number(rawPort), identityFile, knownHostsFile } };
}

export async function withRouterAdapterWizard({ deploy, signal, preview = false, terminal }) {
  if (!terminal && (!process.stdin.isTTY || !process.stdout.isTTY)) fail('LOCAL_ROUTER_ADAPTER_REQUIRED');
  terminal ??= createTerminal(process.stdin, process.stdout, signal);
  const adapter = await collectRouterAdapter(terminal);
  if (adapter.config) {
    for (const [path, privateKey] of [[adapter.config.identityFile, true], [adapter.config.knownHostsFile, false]]) {
      await assertRootControlledPath(path, pathHost);
      const stat = await nativeInfo(path);
      if (!stat?.file || stat.nlink !== 1 || (privateKey && (stat.mode & 0o7777) !== 0o600)) fail('LOCAL_ROUTER_ADAPTER_INPUT_INVALID');
    }
  }
  terminal.write(adapter.config ? `本次使用已核验 SSH 目标 ${adapter.config.user}@${adapter.config.host}:${adapter.config.port}，只引用已有密钥和指纹文件。`
    : `本次使用 ${adapter.flag} ${adapter.path}。`);
  terminal.write('公开协调器会先检查适配器兼容性，再按原意图完成维护更新；成功后保存适配器引用，后续更新复用，不会首次启用路由器交付。');
  if ((await terminal.prompt(preview ? '确认按上述适配器预览？输入 PREVIEW' : '确认按上述适配器维护更新？输入 DEPLOY')).trim() !== (preview ? 'PREVIEW' : 'DEPLOY')) fail('LOCAL_INSTALL_CANCELLED');
  signal?.throwIfAborted();
  if (adapter.path) return deploy(adapter.flag, adapter.path);
  await assertRootControlledPath('/run', pathHost);
  const directory = await mkdtemp('/run/cocoproxy-local-router-');
  await chmod(directory, 0o700);
  try {
    const path = join(directory, 'router-ssh.json');
    await writePrivateInput(path, adapter.config);
    return await deploy('--router-config', path);
  } finally { await rm(directory, { recursive: true, force: true }); }
}

export function createTerminal(input = process.stdin, output = process.stdout, signal) {
  if (!input.isTTY || !output.isTTY) fail('LOCAL_FIRST_INSTALL_TTY_OR_INPUTS_REQUIRED');
  const prompt = async (label, fallback = '') => {
    const reader = createInterface({ input, output, terminal: true });
    const controller = new AbortController();
    const cancel = () => controller.abort(Object.assign(new Error('LOCAL_INSTALL_CANCELLED'), { code: 'LOCAL_INSTALL_CANCELLED' }));
    reader.once('SIGINT', cancel); reader.once('close', cancel);
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      if (signal?.aborted) cancel();
      const value = (await reader.question(`${label}${fallback ? ` [${fallback}]` : ''}: `, { signal: controller.signal })).trim();
      return value || fallback;
    } catch (error) { if (controller.signal.aborted) fail('LOCAL_INSTALL_CANCELLED'); throw error; }
    finally { reader.off('SIGINT', cancel); reader.off('close', cancel); signal?.removeEventListener('abort', cancel); reader.close(); }
  };
  // Raw input avoids readline echo, history and terminal escape interpretation of secrets.
  const secret = label => new Promise((resolveSecret, reject) => {
    output.write(`${label}: `);
    const previous = input.isRaw;
    let value = '';
    const cleanup = () => { input.off('data', onData); input.off('end', onEnd); signal?.removeEventListener('abort', onAbort);
      input.setRawMode(previous); input.pause(); output.write('\n'); };
    const rejectSecret = () => { cleanup(); reject(Object.assign(new Error('LOCAL_INSTALL_CANCELLED'), { code: 'LOCAL_INSTALL_CANCELLED' })); };
    const onEnd = () => rejectSecret();
    const onAbort = () => rejectSecret();
    const onData = chunk => {
      for (const character of chunk.toString('utf8')) {
        if (character === '\u0003' || character === '\u0004') { rejectSecret(); return; }
        if (character === '\r' || character === '\n') { cleanup(); resolveSecret(value); return; }
        if (character === '\u007f' || character === '\b') { value = [...value].slice(0, -1).join(''); continue; }
        if (character >= ' ' && character !== '\u007f') value += character;
        if (Buffer.byteLength(value) > 1024) { rejectSecret(); return; }
      }
    };
    if (signal?.aborted) { rejectSecret(); return; }
    input.setRawMode(true); input.resume(); input.on('data', onData); input.once('end', onEnd);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
  return { prompt, secret, write: value => output.write(value + '\n') };
}

export async function collectInstallAnswers(terminal, nodePath = process.execPath, validateEnvironment) {
  validateEnvironment ??= (await import('../packages/setup/input.ts')).parseSetupEnvironment;
  const required = async label => {
    for (;;) { const value = await terminal.prompt(label); if (value) return value; terminal.write('此项必须填写已经核验的实际值。'); }
  };
  terminal.write('首次安装：请填写已核验的局域网参数。此向导不设置网口地址、默认路由或路由器交付。');
  const network = {};
  for (const [key, label] of [['ingressInterface', '外设接入网口名称'], ['gatewayIPv4', '外设稳定 IPv4'],
    ['routerIPv4', '路由器 LAN IPv4'], ['routerMAC', '路由器实际交付接口 MAC'], ['clientCIDR', '同一 LAN 的规范 CIDR（含前缀）']]) network[key] = await required(label);
  const origin = await required('管理 HTTPS origin（含非特权端口，例如 https://主机名:13443）');
  const list = value => value.split(',').map(item => item.trim()).filter(Boolean);
  const management = { origin, bootstrapResolvers: list(await required('独立引导 DNS IP，多个用逗号分隔')),
    subscriptionOrigins: list(await required('允许的订阅 HTTPS origins（只填来源，不含路径或口令），多个用逗号分隔')),
    probeOrigins: list(await required('允许的延迟探测 HTTPS origins，多个用逗号分隔')) };
  const serviceUser = await terminal.prompt('专用非登录服务账户', 'cocoproxy');
  const mode = await terminal.prompt('HTTPS 证书：1 使用既有证书和私钥；2 新建自签名证书（需在终端单独信任）', '1');
  if (!['1', '2'].includes(mode)) fail('LOCAL_HTTPS_CHOICE_INVALID');
  const certificatePath = mode === '2' ? '/etc/cocoproxy-tls/certificate.pem' : await required('既有证书绝对路径（root 所有，服务可读）');
  const privateKeyPath = mode === '2' ? '/etc/cocoproxy-tls/private-key.pem' : await required('既有私钥绝对路径（须为专用服务 UID 所有，0600）');
  const environment = validateEnvironment({ schemaVersion: 1, network, management,
    system: { serviceUser, nodePath }, https: { mode: 'managed', certificatePath, privateKeyPath, nginxPath: '/usr/sbin/nginx' } });
  let administrator;
  for (;;) {
    const username = await terminal.prompt('管理员用户名', 'admin');
    const password = await terminal.secret('管理员密码（10–1024 字节，不回显）');
    const confirmation = await terminal.secret('再次输入管理员密码');
    if (/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(username) && password === confirmation && !password.includes('\0') &&
        Buffer.byteLength(password) >= 10 && Buffer.byteLength(password) <= 1024) { administrator = { username, password }; break; }
    terminal.write('用户名或密码不符合要求，或两次密码不一致；请重新输入。');
  }
  return { environment, administrator, generateCertificate: mode === '2' };
}

const prerequisites = [
  ['python3', '/usr/bin/python3'], ['iproute2', '/usr/sbin/ip'], ['nftables', '/usr/sbin/nft'],
  ['polkitd', '/etc/polkit-1/rules.d'], ['nginx', '/usr/sbin/nginx'], ['openssl', '/usr/bin/openssl'],
  ['passwd', '/usr/sbin/useradd'], ['procps', '/usr/sbin/sysctl'],
];

async function safeDirectory(path, mode) {
  const existing = await nativeInfo(path);
  if (existing) {
    await assertRootControlledPath(path, pathHost);
    if (!existing.directory || (existing.mode & 0o7777) !== mode) fail('LOCAL_PREPARATION_DIRECTORY_CONFLICT');
    return;
  }
  if (!await nativeInfo(dirname(path))) await safeDirectory(dirname(path), 0o755);
  await assertRootControlledPath(dirname(path), pathHost);
  await mkdir(path, { mode });
  await chmod(path, mode); // Only this invocation's newly created directory.
}

export async function writePrivateInput(path, value) {
  const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(JSON.stringify(value, null, 2) + '\n'); await handle.sync(); }
  finally { await handle.close(); }
}

export async function planSystemPreparation(answers, host = { ...pathHost, read: path => readFile(path, 'utf8'), run: undefined }) {
  const packages = [];
  for (const [name, path] of prerequisites) if (!await host.info(path)) packages.push(name);
  const accounts = await host.run('/usr/bin/getent', ['passwd'], { capture: true });
  const identity = inspectServiceAccount(accounts, answers.environment.system.serviceUser);
  if (identity.status === 'invalid' || accounts.trim().split('\n').filter(line => line.split(':')[0] === answers.environment.system.serviceUser).length > 1) fail('LOCAL_SERVICE_ACCOUNT_CONFLICT');
  const forwarding = (await host.read('/proc/sys/net/ipv4/ip_forward')).trim();
  if (!['0', '1'].includes(forwarding)) fail('LOCAL_FORWARDING_OBSERVATION_INVALID');
  if (answers.generateCertificate && (await host.info(answers.environment.https.certificatePath) || await host.info(answers.environment.https.privateKeyPath))) fail('LOCAL_CERTIFICATE_ALREADY_EXISTS');
  if (forwarding === '0' && await host.info('/etc/sysctl.d/90-cocoproxy-forwarding.conf')) fail('LOCAL_FORWARDING_CONFIG_REQUIRES_REVIEW');
  return { packages, createAccount: identity.status === 'required', serviceUid: identity.uid, enableForwarding: forwarding === '0', generateCertificate: answers.generateCertificate };
}

export function preparationSummary(answers, plan) {
  const environment = answers.environment;
  return [
    '请审阅本次首次安装及系统准备范围：',
    `网络事实：接口 ${environment.network.ingressInterface}，外设 ${environment.network.gatewayIPv4}，LAN ${environment.network.clientCIDR}，路由器 ${environment.network.routerIPv4} / ${environment.network.routerMAC}。`,
    `HTTPS：${environment.management.origin}；证书 ${environment.https.certificatePath}；私钥 ${environment.https.privateKeyPath}。`,
    `独立引导 DNS：${environment.management.bootstrapResolvers.join(', ')}；订阅许可数 ${environment.management.subscriptionOrigins.length}；探测许可数 ${environment.management.probeOrigins.length}。`,
    plan.packages.length ? `系统包：apt-get update，apt-get install --no-install-recommends ${plan.packages.join(' ')}。Ubuntu 包维护脚本可能启动其系统服务。` : '系统包：所需路径均存在，最终仍由公开预检核验。',
    plan.createAccount ? `账户：创建系统非登录账户 ${environment.system.serviceUser}，UID 由系统分配，不授予 sudo 权限。` : `账户：复用已核对的非登录账户 ${environment.system.serviceUser} / UID ${plan.serviceUid}。`,
    '目录：仅新建缺失的 /opt/cocoproxy/releases 和 /etc/cocoproxy-install；既有目录不改归属或权限。',
    plan.enableForwarding ? '内核：新建 /etc/sysctl.d/90-cocoproxy-forwarding.conf 并设置 net.ipv4.ip_forward=1；不改接口地址、路由、防火墙或 DNS。' : '内核：IPv4 forwarding 已为 1。',
    plan.generateCertificate ? '证书：为上述 origin 主机生成有效期 365 天的 RSA 自签名证书；私钥属服务 UID、0600；不会修改任何客户端信任库。' : '证书：仅使用所选既有文件；不改其归属、权限或字节。',
    '软件：调用公开本机部署协调器安装已验证载荷、初始化管理员并启动管理及 HTTPS；不会启用自动网关或路由器交付。',
    '系统准备和安装失败不会自动回滚已完成步骤；已有部分安装需先 inspect/recover 审阅。',
  ].join('\n');
}

export async function applySystemPreparation(answers, plan, run) {
  if (plan.packages.length) {
    await assertTrustedExecutable('/usr/bin/apt-get', pathHost);
    await run('/usr/bin/apt-get', ['update']);
    await run('/usr/bin/apt-get', ['install', '--yes', '--no-install-recommends', ...plan.packages]);
  }
  if (plan.createAccount) {
    // Recheck exact identity immediately before creating; never adopt a concurrently created login account.
    if (inspectServiceAccount(await run('/usr/bin/getent', ['passwd'], { capture: true }), answers.environment.system.serviceUser).status !== 'required') fail('LOCAL_SERVICE_ACCOUNT_CHANGED');
    await assertTrustedExecutable('/usr/sbin/useradd', pathHost);
    await run('/usr/sbin/useradd', ['--system', '--user-group', '--no-create-home', '--home-dir', '/nonexistent', '--shell', '/usr/sbin/nologin', answers.environment.system.serviceUser]);
  }
  const identity = inspectServiceAccount(await run('/usr/bin/getent', ['passwd'], { capture: true }), answers.environment.system.serviceUser, plan.serviceUid);
  if (identity.status !== 'valid') fail('LOCAL_SERVICE_ACCOUNT_CONFLICT');
  answers.environment.system.serviceUid = identity.uid;
  await safeDirectory('/opt/cocoproxy/releases', 0o755);
  await safeDirectory('/etc/cocoproxy-install', 0o700);
  if (plan.enableForwarding) {
    await assertRootControlledPath('/etc/sysctl.d', pathHost);
    const path = '/etc/sysctl.d/90-cocoproxy-forwarding.conf';
    const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o644);
    try { await handle.writeFile('net.ipv4.ip_forward = 1\n'); await handle.chmod(0o644); await handle.sync(); }
    finally { await handle.close(); }
    await assertTrustedExecutable('/usr/sbin/sysctl', pathHost);
    await run('/usr/sbin/sysctl', ['-p', path], { capture: true });
  }
  if (plan.generateCertificate) {
    await safeDirectory('/etc/cocoproxy-tls', 0o755);
    const host = new URL(answers.environment.management.origin).hostname;
    const directory = await mkdtemp('/etc/cocoproxy-tls/.generate-');
    await chmod(directory, 0o700);
    try {
      await assertTrustedExecutable('/usr/bin/openssl', pathHost);
      await run('/usr/bin/openssl', ['req', '-x509', '-newkey', 'rsa:3072', '-sha256', '-days', '365', '-nodes',
        '-subj', '/CN=' + host, '-addext', `subjectAltName=${isIP(host) ? 'IP' : 'DNS'}:${host}`,
        '-keyout', join(directory, 'key.pem'), '-out', join(directory, 'cert.pem')], { capture: true });
      // Exclusive writes prevent overwriting an existing certificate or key, including concurrent creation.
      for (const [source, destination, mode, uid] of [['cert.pem', answers.environment.https.certificatePath, 0o644, 0],
        ['key.pem', answers.environment.https.privateKeyPath, 0o600, identity.uid]]) {
        const handle = await open(destination, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, mode);
        try { await handle.writeFile(await readFile(join(directory, source))); await handle.chmod(mode); await handle.chown(uid, 0); await handle.sync(); }
        finally { await handle.close(); }
      }
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
}

export async function firstInstallWizard({ run, deploy, payload, preview = false, signal, terminal }) {
  terminal ??= createTerminal(process.stdin, process.stdout, signal);
  // A fresh source clone has no node_modules. Use the verified release's bundled runtime dependencies.
  const { parseSetupEnvironment } = await import(pathToFileURL(join(payload, 'source/packages/setup/input.ts')).href);
  const answers = await collectInstallAnswers(terminal, process.execPath, parseSetupEnvironment);
  const plan = await planSystemPreparation(answers, { ...pathHost, read: path => readFile(path, 'utf8'), run });
  terminal.write(preparationSummary(answers, plan));
  if (preview) { terminal.write('预览结束：未执行系统准备或安装。正式运行后需重新审阅并确认。'); return; }
  if ((await terminal.prompt('确认按上述范围准备系统并安装？输入 INSTALL')).trim() !== 'INSTALL') fail('LOCAL_INSTALL_CANCELLED');
  await applySystemPreparation(answers, plan, run);
  await assertRootControlledPath('/run', pathHost);
  const directory = await mkdtemp('/run/cocoproxy-local-install-');
  await chmod(directory, 0o700);
  try {
    const environment = join(directory, 'environment.json'), administrator = join(directory, 'administrator.json');
    await writePrivateInput(environment, answers.environment);
    await writePrivateInput(administrator, answers.administrator);
    await deploy({ environment, administrator });
    terminal.write('首次安装完成。请从已填写的 HTTPS origin 登录，信任证书、配置订阅并按部署指南完成终端验收，再显式启用持久运行和路由器交付。');
  } finally { answers.administrator.password = ''; await rm(directory, { recursive: true, force: true }); }
}
