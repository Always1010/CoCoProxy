import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { parseRuntimeSettings } from './settings.ts';
import { RuntimeError } from './types.ts';
import type { RuntimeSettings } from './types.ts';
import { parseAutomaticGatewaySettings } from '../gateway/profile.ts';

const fields = new Set([
  'schemaVersion', 'stateDirectory', 'binaryPath', 'binarySha256', 'systemctlPath',
  'nodePath', 'sourceDirectory', 'settingsPath', 'unitPath', 'serviceUid',
]);
const invalid: () => never = () => { throw new RuntimeError('RUNTIME_PLAN_INVALID'); };

function absolutePath(value: unknown): string {
  if (typeof value !== 'string' || value.length > 4096 || !posix.isAbsolute(value) || posix.normalize(value) !== value ||
      value.endsWith('/') || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(value)) invalid();
  return value;
}

function visibleToService(path: string): void {
  if (['/home', '/root', '/run/user'].some(root => path === root || path.startsWith(root + '/'))) invalid();
}

/** systemd syntax has its own escapes and specifiers; no shell is involved. */
function quote(value: string, command = false): string {
  const escaped = value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%');
  return '"' + (command ? escaped.replaceAll('$', () => '$$') : escaped) + '"';
}

/** Pure, deterministic deployment proposal. It never creates files or invokes systemd. */
export function renderRuntimePlan(input: unknown): { unit: string; settings: RuntimeSettings } {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(input))) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const keys = Reflect.ownKeys(descriptors);
  if ([...fields].some(key => !keys.includes(key)) ||
      keys.some(key => typeof key !== 'string' || (!fields.has(key) && key !== 'automaticGateway'))) invalid();
  const values: Record<string, unknown> = {};
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!descriptor.enumerable || !('value' in descriptor)) invalid();
    values[key] = descriptor.value;
  }
  if (values.schemaVersion !== 1 || !Number.isSafeInteger(values.serviceUid) ||
      (values.serviceUid as number) <= 0 || (values.serviceUid as number) > 4_294_967_294 ||
      typeof values.binarySha256 !== 'string' || !/^[a-f0-9]{64}$/.test(values.binarySha256)) invalid();
  const stateDirectory = absolutePath(values.stateDirectory);
  const binaryPath = absolutePath(values.binaryPath);
  const systemctlPath = absolutePath(values.systemctlPath);
  const nodePath = absolutePath(values.nodePath);
  const sourceDirectory = absolutePath(values.sourceDirectory);
  const settingsPath = absolutePath(values.settingsPath);
  const unitPath = absolutePath(values.unitPath);
  const automaticGateway = values.automaticGateway === undefined ? undefined : parseAutomaticGatewaySettings(values.automaticGateway);
  if (posix.basename(unitPath) !== 'coproxy-mihomo.service') invalid();
  for (const path of [stateDirectory, binaryPath, nodePath, sourceDirectory, settingsPath]) visibleToService(path);
  const command = [nodePath, '--experimental-strip-types', posix.join(sourceDirectory, 'apps/runtime/launch-core.ts'),
    '--settings', settingsPath].map(arg => quote(arg, true)).join(' ');
  const unit = [
    '[Unit]',
    'Description=Coproxy Mihomo runtime',
    ...(automaticGateway ? ['Requires=coproxy-gateway-network.service', 'After=coproxy-gateway-network.service',
      'BindsTo=coproxy-gateway-network.service'] : []),
    '',
    '[Service]',
    'Type=exec',
    `User=${values.serviceUid}`,
    `ExecStart=${command}`,
    'Restart=on-failure',
    'RestartSec=2',
    'KillMode=control-group',
    'TimeoutStopSec=10',
    'UMask=0077',
    'NoNewPrivileges=true',
    ...(automaticGateway ? ['CapabilityBoundingSet=CAP_NET_ADMIN CAP_NET_RAW',
      'AmbientCapabilities=CAP_NET_ADMIN CAP_NET_RAW', 'DevicePolicy=closed',
      'DeviceAllow=/dev/net/tun rw', 'PrivateDevices=false'] : []),
    'PrivateTmp=true',
    'ProtectSystem=strict',
    'ProtectHome=true',
    `ReadWritePaths=${quote(stateDirectory)}`,
    '',
    '[Install]',
    'WantedBy=multi-user.target',
    '',
  ].join('\n');
  const settings = parseRuntimeSettings({
    schemaVersion: 1, stateDirectory, binaryPath, binarySha256: values.binarySha256,
    systemctlPath, unitPath, unitSha256: createHash('sha256').update(unit, 'utf8').digest('hex'),
    serviceUid: values.serviceUid,
    ...(automaticGateway ? { automaticGateway } : {}),
  });
  return { unit, settings };
}
