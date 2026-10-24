import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { types } from 'node:util';
import { parseRuntimeSettings } from '../runtime/settings.ts';
import { GATEWAY_CORE_SHA256 } from './config.ts';

export const GATEWAY_CREDENTIAL_PATH = '/run/credentials/coproxy-mihomo.service/core-config';
export class GatewayRuntimePlanError extends Error {
  readonly code = 'GATEWAY_RUNTIME_PLAN_INVALID';
  constructor() { super('GATEWAY_RUNTIME_PLAN_INVALID'); this.name = 'GatewayRuntimePlanError'; }
}
const invalid: () => never = () => { throw new GatewayRuntimePlanError(); };
const fields = ['schemaVersion', 'stateDirectory', 'binaryPath', 'binarySha256', 'systemctlPath',
  'unitPath', 'serviceUid', 'coreHome'];

function path(input: unknown): string {
  if (typeof input !== 'string' || input.length > 4096 || !posix.isAbsolute(input) ||
    posix.normalize(input) !== input || input.endsWith('/') ||
    /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(input) ||
    ['/home', '/root', '/run/user'].some(root => within(root, input))) invalid();
  return input;
}
function within(parent: string, child: string): boolean { return child === parent || child.startsWith(parent + '/'); }
/** Escape systemd syntax and specifiers; ExecStart uses no shell. */
function quote(input: string, command = false): string {
  const escaped = input.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%');
  return '"' + (command ? escaped.replaceAll('$', () => '$$') : escaped) + '"';
}

/** Pure proposal. Filesystem ownership below is required, never installed here. */
export function renderGatewayRuntimePlan(input: unknown) {
  try {
    if (!input || typeof input !== 'object' || types.isProxy(input) || Array.isArray(input) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(input))) invalid();
    const descriptors = Object.getOwnPropertyDescriptors(input), keys = Reflect.ownKeys(descriptors);
    if (keys.length !== fields.length || keys.some(key => typeof key !== 'string' || !fields.includes(key))) invalid();
    const values: Record<string, unknown> = {};
    for (const key of fields) {
      const descriptor = descriptors[key];
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) invalid();
      values[key] = descriptor.value;
    }
    if (values.schemaVersion !== 1 || values.binarySha256 !== GATEWAY_CORE_SHA256 ||
      typeof values.serviceUid !== 'number' || !Number.isSafeInteger(values.serviceUid) ||
      values.serviceUid <= 0 || values.serviceUid > 4_294_967_294) invalid();
    const stateDirectory = path(values.stateDirectory), coreHome = path(values.coreHome);
    const binaryPath = path(values.binaryPath), unitPath = path(values.unitPath), systemctlPath = path(values.systemctlPath);
    if (within(stateDirectory, coreHome) || within(coreHome, stateDirectory) ||
      posix.basename(unitPath) !== 'coproxy-mihomo.service' ||
      !['/usr/bin/systemctl', '/bin/systemctl'].includes(systemctlPath)) invalid();
    // A writable home must never contain the executable, unit or control tool.
    // The non-root core also cannot traverse a root-only state directory.
    for (const file of [binaryPath, unitPath, systemctlPath]) {
      if (within(coreHome, file) || within(stateDirectory, file) ||
        within(file, coreHome) || within(file, stateDirectory)) invalid();
    }
    const selectedPath = posix.join(stateDirectory, 'selected-core.json');
    const unit = [
      '[Unit]',
      'Description=Coproxy protected gateway core',
      'Requires=coproxy-network.service',
      'After=coproxy-network.service',
      'BindsTo=coproxy-network.service',
      '',
      '[Service]',
      'Type=exec',
      `User=${values.serviceUid}`,
      `LoadCredential=${quote('core-config:' + selectedPath)}`,
      // %d is deliberately the sole unescaped systemd specifier in this unit.
      `ExecStart=${quote(binaryPath, true)} "-d" ${quote(coreHome, true)} "-f" "%d/core-config"`,
      'Restart=no',
      'KillMode=control-group',
      'TimeoutStartSec=10',
      'TimeoutStopSec=10',
      'UMask=0077',
      'AmbientCapabilities=CAP_NET_ADMIN CAP_NET_RAW',
      'CapabilityBoundingSet=CAP_NET_ADMIN CAP_NET_RAW',
      'NoNewPrivileges=true',
      'PrivateTmp=true',
      'ProtectSystem=strict',
      'ProtectHome=true',
      'ProtectControlGroups=true',
      'ProtectKernelTunables=true',
      'ProtectKernelModules=true',
      'ProtectKernelLogs=true',
      'RestrictSUIDSGID=true',
      'RestrictRealtime=true',
      'RestrictNamespaces=true',
      'LockPersonality=true',
      `ReadWritePaths=${quote(coreHome)}`,
      'StandardInput=null',
      'StandardOutput=journal',
      'StandardError=journal',
      'LogRateLimitIntervalSec=30s',
      'LogRateLimitBurst=200',
      '',
    ].join('\n');
    const settings = parseRuntimeSettings({ schemaVersion: 1, stateDirectory, binaryPath,
      binarySha256: GATEWAY_CORE_SHA256, systemctlPath, unitPath, serviceUid: values.serviceUid,
      unitSha256: createHash('sha256').update(unit, 'utf8').digest('hex') });
    return { unit, settings, coreHome, selectedPath, credentialPath: GATEWAY_CREDENTIAL_PATH,
      filesystem: { directories: [
        { path: stateDirectory, uid: 0, mode: 0o700 },
        { path: posix.join(stateDirectory, 'candidates'), uid: 0, mode: 0o700 },
        { path: coreHome, uid: values.serviceUid, mode: 0o700 },
      ], selectedFile: { path: selectedPath, uid: 0, mode: 0o600 } } };
  } catch { return invalid(); }
}
