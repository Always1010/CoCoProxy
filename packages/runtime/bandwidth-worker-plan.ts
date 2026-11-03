import { posix } from 'node:path';
import { parseRuntimeSettings } from './settings.ts';
import type { RuntimeSettings } from './types.ts';

export const BANDWIDTH_WORKER_SOCKET = '/run/cocoproxy-bandwidth.sock';
export const BANDWIDTH_WORKER_SERVICE = 'cocoproxy-bandwidth.service';
export const BANDWIDTH_WORKER_SOCKET_UNIT = 'cocoproxy-bandwidth.socket';
export type BandwidthWorkerSettings = { schemaVersion: 1; runtime: RuntimeSettings; enabled: boolean };
const invalid = (): never => { throw new Error('BANDWIDTH_WORKER_SETTINGS_INVALID'); };

export function parseBandwidthWorkerSettings(input: unknown): BandwidthWorkerSettings {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return invalid();
  const value = input as BandwidthWorkerSettings;
  if (Object.keys(value).sort().join(',') !== 'enabled,runtime,schemaVersion' || value.schemaVersion !== 1 || typeof value.enabled !== 'boolean') return invalid();
  return { schemaVersion: 1, runtime: parseRuntimeSettings(value.runtime), enabled: value.enabled };
}

const path = (value: string) => {
  if (typeof value !== 'string' || !posix.isAbsolute(value) || posix.normalize(value) !== value || value.endsWith('/')
      || /[\u0000-\u001f\u007f]/u.test(value) || ['/home', '/root', '/tmp', '/var/tmp', '/proc', '/sys', '/dev', '/run/user']
        .some(root => value === root || value.startsWith(root + '/'))) return invalid();
  return value;
};
const quote = (value: string, command = false) => '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
  .replaceAll('%', '%%').replaceAll('$', () => command ? '$$' : '$') + '"';

/** Root-owned execution policy has no credentials and is separate from writable workspace settings. */
export function renderBandwidthWorkerPlan(input: { runtime: RuntimeSettings; nodePath: string; sourceDirectory: string; settingsPath: string; enabled: boolean }) {
  const settings = parseBandwidthWorkerSettings({ schemaVersion: 1, runtime: input.runtime, enabled: input.enabled });
  const command = [path(input.nodePath), '--experimental-strip-types', posix.join(path(input.sourceDirectory), 'apps/runtime/bandwidth-worker.ts'),
    '--settings', path(input.settingsPath)].map(arg => quote(arg, true)).join(' ');
  const serviceUnit = [
    '[Unit]', 'Description=CoCoProxy bounded bandwidth worker', `Requires=${BANDWIDTH_WORKER_SOCKET_UNIT}`,
    `After=${BANDWIDTH_WORKER_SOCKET_UNIT}`,
    ...(settings.runtime.automaticGateway ? ['Requires=cocoproxy-gateway-network.service', 'After=cocoproxy-gateway-network.service',
      'BindsTo=cocoproxy-gateway-network.service'] : []), '',
    '[Service]', 'Type=exec', `User=${settings.runtime.serviceUid}`, `ExecStart=${command}`,
    'Restart=no', 'RuntimeMaxSec=45', 'TimeoutStopSec=5', 'KillMode=control-group', 'UMask=0077',
    'NoNewPrivileges=true', 'PrivateTmp=true', 'PrivateDevices=true', 'ProtectSystem=strict', 'ProtectHome=true',
    'ProtectKernelTunables=true', 'ProtectKernelModules=true', 'ProtectControlGroups=true', 'RestrictSUIDSGID=true',
    ...(settings.runtime.automaticGateway ? ['CapabilityBoundingSet=CAP_NET_ADMIN CAP_NET_RAW', 'AmbientCapabilities=CAP_NET_ADMIN CAP_NET_RAW']
      : ['CapabilityBoundingSet=']),
    `ReadOnlyPaths=${quote(settings.runtime.stateDirectory)}`, 'StandardOutput=null', 'StandardError=null', '',
  ].join('\n');
  const socketUnit = ['[Unit]', 'Description=CoCoProxy local bandwidth task socket', '', '[Socket]',
    `ListenStream=${BANDWIDTH_WORKER_SOCKET}`, `SocketUser=${settings.runtime.serviceUid}`, 'SocketMode=0600',
    'Accept=no', 'Backlog=1', 'RemoveOnStop=true', '', '[Install]', 'WantedBy=sockets.target', ''].join('\n');
  return { serviceUnit, socketUnit, settingsContent: JSON.stringify(settings, null, 2) + '\n' };
}
