import { posix } from 'node:path';
import { types } from 'node:util';
import { compileConfig } from '../config/index.ts';
import type { JsonObject, JsonValue } from '../config/index.ts';
import { renderRuntimePlan } from '../runtime/plan.ts';
import { HttpsSnapshotClient } from '../subscriptions/http.ts';
import { DEFAULT_LATENCY_PROBE_ORIGIN } from '../management/controller.ts';
import type { HttpsClientOptions } from '../subscriptions/http.ts';
import { renderAutomaticGatewayHostPlan } from '../gateway/host-plan.ts';

export class DeploymentPlanError extends Error {
  readonly code = 'DEPLOYMENT_PLAN_INVALID';
  constructor() { super('DEPLOYMENT_PLAN_INVALID'); this.name = 'DeploymentPlanError'; }
}

export interface DeploymentFile {
  path: string;
  mode: '0600' | '0644';
  owner: 'root' | number;
  sensitive: boolean;
  content: string;
}

export interface DeploymentPlan {
  schemaVersion: 1;
  /** The management settings contain the controller secret. Save the whole plan privately. */
  sensitive: true;
  files: DeploymentFile[];
  directories: { path: string; mode: '0700' | '0755'; owner: 'root' | number }[];
  requirements: string[];
  steps: string[];
}

const fail: () => never = () => { throw new DeploymentPlanError(); };
const controls = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

/** Copy bounded ordinary JSON without invoking accessors, toJSON, or user prototypes. */
function jsonData(input: unknown): JsonValue {
  const ancestors = new Set<object>();
  let remaining = 10_000;
  let bytes = 0;
  function copy(value: unknown, depth: number): JsonValue {
    if (--remaining < 0 || depth > 16) fail();
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number') { if (!Number.isFinite(value)) fail(); return value; }
    if (typeof value === 'string') {
      bytes += Buffer.byteLength(value, 'utf8');
      if (bytes > 128 * 1024) fail();
      return value;
    }
    if (!value || typeof value !== 'object' || types.isProxy(value) || ancestors.has(value)) fail();
    const array = Array.isArray(value);
    if (array ? Object.getPrototypeOf(value) !== Array.prototype :
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(descriptors).some(key => typeof key !== 'string')) fail();
    ancestors.add(value);
    let output: JsonValue;
    if (array) {
      const length = descriptors.length.value as number;
      if (length > remaining || Object.keys(descriptors).some(key =>
        key !== 'length' && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= length))) fail();
      const items: JsonValue[] = [];
      for (let index = 0; index < length; index++) {
        const item = descriptors[String(index)];
        if (!item || !item.enumerable || !('value' in item)) fail();
        items.push(copy(item.value, depth + 1));
      }
      output = items;
    } else {
      const object: JsonObject = Object.create(null);
      for (const [key, item] of Object.entries(descriptors)) {
        if (!item.enumerable || !('value' in item) || ['__proto__', 'constructor', 'prototype'].includes(key)) fail();
        bytes += Buffer.byteLength(key, 'utf8');
        if (bytes > 128 * 1024) fail();
        object[key] = copy(item.value, depth + 1);
      }
      output = object;
    }
    ancestors.delete(value);
    return output;
  }
  return copy(input, 0);
}

function record(input: JsonValue | undefined, required: readonly string[], optional: readonly string[] = []): JsonObject {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
    required.some(key => !Object.hasOwn(input, key)) || Object.keys(input).some(key => ![...required, ...optional].includes(key))) fail();
  return input;
}

function path(input: JsonValue | undefined): string {
  if (typeof input !== 'string' || input.length > 4096 || !posix.isAbsolute(input) ||
    posix.normalize(input) !== input || input.endsWith('/') || controls.test(input) ||
    Buffer.from(input, 'utf8').toString('utf8') !== input) fail();
  // ProtectHome, PrivateTmp and PrivateDevices hide these locations. Kernel virtual
  // filesystems are not stable installation or private persistence locations.
  if (['/home', '/root', '/run/user', '/tmp', '/var/tmp', '/dev', '/proc', '/sys'].some(root => inside(input, root))) fail();
  return input;
}

function inside(child: string, parent: string): boolean { return child === parent || child.startsWith(parent + '/'); }
function overlap(left: string, right: string): boolean { return inside(left, right) || inside(right, left); }

/** systemd performs word parsing/specifier expansion; it never invokes a shell here. */
function quote(value: string, command = false): string {
  const escaped = value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%');
  return '"' + (command ? escaped.replaceAll('$', () => '$$') : escaped) + '"';
}

function origin(input: JsonValue | undefined, httpsOnly: boolean): string {
  if (typeof input !== 'string' || input.length > 8192 || controls.test(input)) fail();
  const url = new URL(input);
  if (url.origin !== input || url.username || url.password ||
    !(url.protocol === 'https:' || (!httpsOnly && url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)))) fail();
  return input;
}

function origins(input: JsonValue | undefined, maximum: number): void {
  if (!Array.isArray(input) || input.length > maximum) fail();
  for (const item of input) origin(item, true);
  if (new Set(input).size !== input.length) fail();
}

function render(input: unknown): DeploymentPlan {
  const envelope = record(jsonData(input), ['schemaVersion', 'runtime', 'management']);
  if (envelope.schemaVersion !== 1) fail();
  const runtime = record(envelope.runtime, ['schemaVersion', 'stateDirectory', 'binaryPath', 'binarySha256',
    'systemctlPath', 'nodePath', 'sourceDirectory', 'settingsPath', 'unitPath', 'serviceUid'], ['automaticGateway']);
  const core = renderRuntimePlan(runtime);
  const management = record(envelope.management, ['origin', 'listenPort', 'serviceUser', 'serverEntry', 'settingsPath',
    'credentialPath', 'unitPath', 'policyPath', 'deployment'], ['subscriptionPolicy', 'controllerPolicy']);
  const serviceUid = core.settings.serviceUid;
  const stateDirectory = path(runtime.stateDirectory);
  const sourceDirectory = path(runtime.sourceDirectory);
  const nodePath = path(runtime.nodePath);
  const systemctlPath = path(runtime.systemctlPath);
  const binaryPath = path(runtime.binaryPath);
  const runtimeSettingsPath = path(runtime.settingsPath);
  const coreUnitPath = path(runtime.unitPath);
  const serverEntry = path(management.serverEntry);
  const settingsPath = path(management.settingsPath);
  const credentialPath = path(management.credentialPath);
  const unitPath = path(management.unitPath);
  const policyPath = path(management.policyPath);
  const networkSettingsPath = posix.join(posix.dirname(runtimeSettingsPath), 'gateway-network.json');
  const networkStateDirectory = '/var/lib/coproxy-gateway-network';
  const networkPlan = core.settings.automaticGateway ? renderAutomaticGatewayHostPlan({
    network: core.settings.automaticGateway, sourceDirectory, pythonPath: '/usr/bin/python3',
    settingsPath: networkSettingsPath, stateDirectory: networkStateDirectory,
  }) : null;
  if (coreUnitPath !== '/etc/systemd/system/coproxy-mihomo.service' ||
    unitPath !== '/etc/systemd/system/coproxy-management.service' ||
    policyPath !== '/etc/polkit-1/rules.d/50-coproxy-management.rules') fail();
  if (typeof management.serviceUser !== 'string' || !/^[a-z_][a-z0-9_-]{0,31}$/.test(management.serviceUser) ||
    ['root', 'nobody'].includes(management.serviceUser)) fail();
  if (typeof management.listenPort !== 'number' || !Number.isInteger(management.listenPort) ||
    management.listenPort < 1024 || management.listenPort > 65535) fail();
  const managementOrigin = origin(management.origin, false);
  // A same-origin HTTP deployment reaches the fixed IPv4 listener directly.
  // IPv6 loopback is valid through an explicitly configured local proxy.
  if (managementOrigin.startsWith('http:') && Number(new URL(managementOrigin).port || 80) !== management.listenPort) fail();

  const controlledFiles = [binaryPath, systemctlPath, nodePath, runtimeSettingsPath, coreUnitPath,
    serverEntry, settingsPath, credentialPath, unitPath, policyPath,
    posix.join(sourceDirectory, 'apps/runtime/launch-core.ts'),
    ...(networkPlan ? [networkSettingsPath, '/etc/systemd/system/coproxy-gateway-network.service',
      posix.join(sourceDirectory, 'apps/gateway/network.py'), '/usr/bin/python3', '/usr/sbin/ip', '/usr/sbin/nft',
      '/usr/bin/ip', '/usr/bin/nft'] : [])];
  if (networkPlan && (overlap(networkStateDirectory, stateDirectory) || overlap(networkStateDirectory, sourceDirectory) ||
      controlledFiles.some(file => overlap(networkStateDirectory, file)) || overlap(networkSettingsPath, sourceDirectory))) fail();
  if (overlap(stateDirectory, sourceDirectory) || controlledFiles.some(file => overlap(stateDirectory, file))) fail();
  for (let index = 0; index < controlledFiles.length; index++) {
    if (controlledFiles.slice(index + 1).some(file => overlap(controlledFiles[index], file))) fail();
  }
  // Private settings may not replace or become children of the trusted source tree.
  if ([runtimeSettingsPath, settingsPath, credentialPath, coreUnitPath, unitPath, policyPath].some(file => overlap(file, sourceDirectory))) fail();
  // Never describe making a standard shared installation directory service-private.
  if (['/etc', '/usr', '/usr/local', '/opt', '/run', '/var', '/var/lib', '/var/cache', '/srv'].includes(stateDirectory)) fail();

  const deployment = record(management.deployment, ['mixedPort', 'controllerPort', 'controllerSecret', 'dnsPort', 'bootstrapResolvers']);
  compileConfig({ schemaVersion: 1, deployment, policy: { rules: ['MATCH,REJECT'] } });
  const ports = [deployment.mixedPort, deployment.controllerPort, deployment.dnsPort];
  if (ports.some(port => typeof port !== 'number' || port < 1024 || port === management.listenPort) ||
    typeof deployment.controllerSecret !== 'string' || deployment.controllerSecret.length > 4096 || controls.test(deployment.controllerSecret)) fail();

  if (management.subscriptionPolicy !== undefined) {
    const policy = record(management.subscriptionPolicy, ['allowedOrigins'],
      ['allowedHttpOrigins', 'allowPrivateAddresses', 'timeoutMs', 'maxBytes', 'maxRedirects', 'ca']);
    origins(policy.allowedOrigins, 100);
    if (policy.allowPrivateAddresses !== undefined && typeof policy.allowPrivateAddresses !== 'boolean') fail();
    if (policy.ca !== undefined && (typeof policy.ca !== 'string' || policy.ca.length > 32_768)) fail();
    // The constructor validates bounds only; it does not resolve or connect.
    new HttpsSnapshotClient(policy as unknown as HttpsClientOptions);
  }
  const controllerPolicy = management.controllerPolicy === undefined
    ? { allowedProbeOrigins: [DEFAULT_LATENCY_PROBE_ORIGIN] }
    : record(management.controllerPolicy, ['allowedProbeOrigins']);
  origins(controllerPolicy.allowedProbeOrigins, 16);

  const settings: JsonObject = { schemaVersion: 1, origin: managementOrigin, credentialPath,
    runtimeSettingsPath, deployment,
    ...(management.subscriptionPolicy === undefined ? {} : { subscriptionPolicy: management.subscriptionPolicy }),
    controllerPolicy };
  const settingsContent = JSON.stringify(settings, null, 2) + '\n';
  if (Buffer.byteLength(settingsContent, 'utf8') > 64 * 1024) fail();
  const managementUnit = [
    '[Unit]', 'Description=Coproxy management server', '', '[Service]', 'Type=exec', `User=${serviceUid}`,
    `ExecStart=${[nodePath, serverEntry].map(argument => quote(argument, true)).join(' ')}`,
    'Environment="NODE_ENV=production"', 'Environment="NITRO_HOST=127.0.0.1"',
    `Environment="NITRO_PORT=${management.listenPort}"`,
    `Environment=${quote('COPROXY_MANAGEMENT_CONFIG=' + settingsPath)}`,
    'Restart=on-failure', 'RestartSec=2', 'KillMode=control-group', 'TimeoutStopSec=30',
    'UMask=0077', 'NoNewPrivileges=true', 'PrivateTmp=true', 'PrivateDevices=true',
    'ProtectSystem=strict', 'ProtectHome=true', 'ProtectKernelTunables=true',
    'ProtectKernelModules=true', 'ProtectControlGroups=true', 'RestrictSUIDSGID=true',
    'CapabilityBoundingSet=', `ReadWritePaths=${quote(stateDirectory)}`, '',
    '[Install]', 'WantedBy=multi-user.target', '',
  ].join('\n');
  const policy = [
    '// Install only after verifying this account name resolves to the fixed service UID.',
    `// Expected service UID: ${serviceUid}. Other polkit rules must be reviewed separately.`,
    'polkit.addRule(function(action, subject) {',
    `    if (subject.user !== ${JSON.stringify(management.serviceUser)}) return;`,
    '    if (action.id === "org.freedesktop.systemd1.manage-unit-files") return polkit.Result.NO;',
    '    if (action.id !== "org.freedesktop.systemd1.manage-units") return;',
    '    var verb = action.lookup("verb");',
    '    if (action.lookup("unit") === "coproxy-mihomo.service" && (verb === "start" || verb === "stop")) {',
    '        return polkit.Result.YES;', '    }', '    return polkit.Result.NO;', '});', '',
  ].join('\n');
  const files: DeploymentFile[] = [
    { path: coreUnitPath, mode: '0644', owner: 'root', sensitive: false, content: core.unit },
    { path: runtimeSettingsPath, mode: '0600', owner: serviceUid, sensitive: true, content: JSON.stringify(core.settings, null, 2) + '\n' },
    { path: unitPath, mode: '0644', owner: 'root', sensitive: false, content: managementUnit },
    { path: settingsPath, mode: '0600', owner: serviceUid, sensitive: true, content: settingsContent },
    { path: policyPath, mode: '0644', owner: 'root', sensitive: false, content: policy },
    ...(networkPlan ? [
      { path: '/etc/systemd/system/coproxy-gateway-network.service', mode: '0644' as const, owner: 'root' as const, sensitive: false, content: networkPlan.unit },
      { path: networkSettingsPath, mode: '0600' as const, owner: 'root' as const, sensitive: true, content: JSON.stringify(networkPlan.settings, null, 2) + '\n' },
    ] : []),
  ];
  const parents = [...new Set(files.map(file => posix.dirname(file.path)).concat(posix.dirname(credentialPath)))];
  if (parents.some(parent => parent === '/' || inside(parent, stateDirectory))) fail();
  return {
    schemaVersion: 1, sensitive: true, files,
    directories: [{ path: stateDirectory, mode: '0700', owner: serviceUid },
      ...(networkPlan ? [{ path: networkStateDirectory, mode: '0700' as const, owner: 'root' as const }] : []),
      ...parents.map(parent => ({ path: parent, mode: '0755' as const, owner: 'root' as const }))],
    requirements: [
      ...(networkPlan ? [
        '自动网关模式另含 root 网络 oneshot：独立阻断规则、一张带 mark 的出口表和终端回程路由；Mihomo 独占自动接管资源。需要另行审阅并授权真实网络变更，不能按显式代理安装范围执行。',
        '网络设置及其祖先必须为 root 控制，网络回执目录 root:0700；不得交给管理服务 UID 写入。Python 3 与 ip/nft 使用系统现有受信路径；本计划不安装工具。',
        '启动前现场核验接口、地址、路由器 MAC、路由表/优先级/mark 和 TUN 冲突，并另行准备 IPv4 转发；网络 oneshot 要求 ip_forward 已为 1，不自行修改 sysctl。核心仅获 CAP_NET_ADMIN/CAP_NET_RAW。',
        '停止核心或网络单元不会清除独立 guard；用户关闭直连由接入路由器独立完成。完整退役先关闭路由器交付并停止核心，再显式运行 root 网络 remove；部分执行须人工核验，不自动猜测恢复。',
      ] : []),
      '本计划含 controllerSecret，输入、整个计划及管理设置必须作为私有敏感资料保存；不得提交、公开打印或放入发行包。',
      '目标必须为具备 systemd 与 JavaScript polkit 规则的 Linux；Node 须支持运行项目和 process.execve，管理 Server 必须完成受审阅的构建。',
      `部署前核对账户 ${management.serviceUser} 唯一解析为非 root UID ${serviceUid}，服务与 CLI 使用该身份；本计划不创建账户或更改组。`,
      'Node、systemctl、核心、全部运行源码和构建产物及其祖先、符号链接最终目标必须由 root 控制，禁止服务 UID、组或其他用户写入；核心摘要应为解压后的真实可执行文件摘要。',
      'unit、polkit 和设置路径的全部祖先必须由 root 控制且不可由服务 UID、组或其他用户替换；安装前检查真实路径和挂载，纯计划无法核验符号链接、ACL、SELinux/AppArmor 或实际所有权。',
      '两个设置文件及既有管理员 credential 文件须为服务 UID 所有、0600 普通文件；状态目录须为同一 UID 所有、0700，不能放宽私有权限。设置通过 ProtectSystem=strict 在服务内只读。',
      '复核既有全部 polkit/sudo 授权及规则排序，禁止更早规则向该服务身份授予任意单元、manage-unit-files 或 root shell；本规则仅为固定核心单元的 start/stop 返回 YES，show 为只读查询。',
      '两个 unit 不得含额外 drop-in 或待 daemon-reload 修改。管理 unit 无核心依赖，不建立新 selection；空状态或已完成事务启动不操作核心，有未完成事务时等待同一持久锁下的一次恢复，必要时恢复上一核心。首次应用仍须显式 expectedActive CAS。',
      '后端固定 IPv4 loopback，远程管理 origin 使用专用 HTTPS 反向代理并覆盖 Host/协议头，拒绝不可信转发头；本计划不安装代理、不申请证书、不开放端口、不修改 DNS/路由/防火墙。',
    ],
    steps: [
      '先审阅全部文件、路径、UID、私有凭据引用和权限要求；此阶段不向系统目录写文件，也不执行服务操作。',
      '另行取得目标系统安装与账户/授权变更许可后，逐项核验既有软件、账户和可信目录；仅创建缺失的专用目录，不对现有共享目录递归 chmod/chown。',
      '在获准目标上按清单逐文件安装，保持 UTF-8、LF 和末尾换行；不覆盖未审阅文件，不复制管理员密码、整个源码工作区或 .local/。',
      '在独立批准的安装步骤中验证 systemd unit 与 polkit 规则、重新加载服务定义；分别验证固定身份只可 show/start/stop 固定核心单元，拒绝 restart、reload、其他单元和 enable。',
      '安装验收后由操作者另行决定是否启动或启用管理服务；不自动启用或启动核心，保持无 active 的初始事务状态。',
      '通过私有管理员登录、草稿 revision、捕获 generation、expectedActive CAS、实际核心观察及恢复流程验收；管理 health 只证明管理端响应，不证明网关就绪。',
    ],
  };
}

/** Pure proposal only: no filesystem writes, network requests, systemctl or account changes. */
export function renderDeploymentPlan(input: unknown): DeploymentPlan {
  try { return render(input); }
  catch { return fail(); }
}
