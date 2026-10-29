import { posix } from 'node:path';
import { types } from 'node:util';
import { parseAutomaticGatewaySettings, type AutomaticGatewaySettings } from './profile.ts';

export type AutomaticGatewayHostSettings = {
  schemaVersion: 1;
  network: AutomaticGatewaySettings;
  stateDirectory: string;
  ipPath: '/usr/sbin/ip';
  nftPath: '/usr/sbin/nft';
  guardRules: string;
};

function invalid(): never { throw new Error('AUTOMATIC_GATEWAY_HOST_PLAN_INVALID'); }
function installPath(value: unknown): string {
  if (typeof value !== 'string' || !posix.isAbsolute(value) || posix.normalize(value) !== value ||
      value === '/' || value.endsWith('/') || value.length > 4096 ||
      /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(value) ||
      ['/home', '/root', '/tmp', '/var/tmp', '/run/user'].some(root => value === root || value.startsWith(root + '/'))) invalid();
  return value;
}
function quote(value: string, command = false): string {
  const escaped = value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%');
  return '"' + (command ? escaped.replaceAll('$', () => '$$') : escaped) + '"';
}

/** Must match the root helper's fixed guard. Counters are omitted for stable receipts. */
export function automaticGatewayGuardRules(network: AutomaticGatewaySettings): string {
  const n = parseAutomaticGatewaySettings(network);
  const address = n.gatewayIPv4.split('.').reduce((value, octet) => value * 256 + Number(octet), 0);
  const subnet = Math.floor(address / 2 ** (32 - n.prefixLength)) * 2 ** (32 - n.prefixLength);
  const lan = [24, 16, 8, 0].map(shift => Math.floor(subnet / 2 ** shift) % 256).join('.') + `/${n.prefixLength}`;
  const broadcast = [24, 16, 8, 0].map(shift => Math.floor((subnet + 2 ** (32 - n.prefixLength) - 1) / 2 ** shift) % 256).join('.');
  const scope = n.clientCIDR ?? n.clientIPv4!;
  const excluded = n.clientCIDR ? `  iifname "${n.ingressInterface}" meta nfproto ipv4 ip daddr != ${lan} ip saddr { ${n.gatewayIPv4}, ${n.routerIPv4}, ${lan.split('/')[0]}, ${broadcast} } drop\n` : '';
  return `table inet cocoproxy_auto_guard {
 chain ingress {
  type filter hook prerouting priority -310; policy accept;
${excluded}  iifname "${n.ingressInterface}" meta nfproto ipv4 ip daddr != ${lan} ip saddr != ${scope} drop
  iifname "${n.ingressInterface}" meta nfproto ipv4 ip daddr != ${lan} ether saddr != ${n.routerMAC} drop
 }
 chain dns {
  type filter hook input priority -310; policy accept;
  iifname "lo" ip daddr ${n.gatewayIPv4} meta l4proto { tcp, udp } th dport ${n.dnsPort} accept
  iifname "${n.ingressInterface}" ip saddr ${n.routerIPv4} ether saddr ${n.routerMAC} ip daddr ${n.gatewayIPv4} meta l4proto { tcp, udp } th dport ${n.dnsPort} accept
  ip daddr ${n.gatewayIPv4} meta l4proto { tcp, udp } th dport ${n.dnsPort} drop
 }
 chain forwarding {
  type filter hook forward priority -310; policy accept;
  iifname "${n.ingressInterface}" meta nfproto ipv6 drop
  iifname "${n.ingressInterface}" ip saddr ${scope} ip daddr != ${lan} oifname != "cocoproxy-tun" drop
 }
}
`;
}

/** Pure installation proposal. Runtime checks root ownership and every path ancestor. */
export function renderAutomaticGatewayHostPlan(input: {
  network: unknown; sourceDirectory: string; pythonPath: string; settingsPath: string; stateDirectory: string;
  hostStateDirectory?: string; hostServiceUid?: number;
}): { unit: string; earlyUnit: string; settings: AutomaticGatewayHostSettings; guardRules: string } {
  if (!input || typeof input !== 'object' || types.isProxy(input) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(input))) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const fields = ['network', 'sourceDirectory', 'pythonPath', 'settingsPath', 'stateDirectory'];
  const optional = ['hostStateDirectory', 'hostServiceUid'];
  if (Reflect.ownKeys(descriptors).some(key => typeof key !== 'string' || ![...fields, ...optional].includes(key)) || fields.some(field => {
    const descriptor = descriptors[field];
    return !descriptor || !descriptor.enumerable || !('value' in descriptor);
  })) invalid();
  if (optional.some(field => descriptors[field] && (!descriptors[field].enumerable || !('value' in descriptors[field]))) ||
      optional.some(field => !!descriptors[field] !== !!descriptors[optional[0]])) invalid();
  const values = Object.fromEntries([...fields, ...optional.filter(field => descriptors[field])].map(field => [field, descriptors[field].value]));
  const network = parseAutomaticGatewaySettings(values.network);
  const source = installPath(values.sourceDirectory), python = installPath(values.pythonPath);
  const settingsPath = installPath(values.settingsPath), stateDirectory = installPath(values.stateDirectory);
  if (settingsPath === stateDirectory || settingsPath.startsWith(stateDirectory + '/') ||
      source === stateDirectory || source.startsWith(stateDirectory + '/') || stateDirectory.startsWith(source + '/')) invalid();
  const guardRules = automaticGatewayGuardRules(network);
  const command = [python, '-I', posix.join(source, 'apps/gateway/network.py'), 'prepare', '--settings', settingsPath]
    .map(value => quote(value, true)).join(' ');
  const reload = [python, '-I', posix.join(source, 'apps/gateway/network.py'), 'reconcile', '--settings', settingsPath]
    .map(value => quote(value, true)).join(' ');
  const guard = [python, '-I', posix.join(source, 'apps/gateway/network.py'), 'guard', '--settings', settingsPath]
    .map(value => quote(value, true)).join(' ');
  let hostGuard: string | undefined;
  if (values.hostStateDirectory !== undefined) {
    const hostState = installPath(values.hostStateDirectory);
    if (!Number.isSafeInteger(values.hostServiceUid) || values.hostServiceUid <= 0 || values.hostServiceUid > 4294967294 ||
        hostState === stateDirectory || hostState.startsWith(stateDirectory + '/') || stateDirectory.startsWith(hostState + '/')) invalid();
    hostGuard = [python, '-I', posix.join(source, 'apps/gateway/host_proxy.py'), '--early-network', settingsPath,
      '--state', hostState, '--uid', String(values.hostServiceUid)].map(value => quote(value, true)).join(' ');
  }
  const earlyUnit = ['[Unit]', 'Description=CoCoProxy early ingress guard',
    'DefaultDependencies=no', 'After=local-fs.target', 'Before=network-pre.target', 'Wants=network-pre.target',
    '', '[Service]', 'Type=oneshot', 'RemainAfterExit=true', 'User=root', `ExecStart=${guard}`,
    ...(hostGuard ? [`ExecStart=${hostGuard}`] : []), 'UMask=0077',
    'TimeoutStartSec=30', 'TimeoutStopSec=10', 'NoNewPrivileges=true',
    'CapabilityBoundingSet=CAP_NET_ADMIN', 'ProtectSystem=strict', 'ProtectHome=true',
    'PrivateTmp=true', `ReadWritePaths=${quote(stateDirectory)}`, '',
    '[Install]', 'WantedBy=multi-user.target', ''].join('\n');
  const unit = ['[Unit]', 'Description=CoCoProxy automatic gateway network prerequisites',
    'After=network-online.target', 'Wants=network-online.target', '', '[Service]', 'Type=oneshot',
    'RemainAfterExit=true', 'User=root', `ExecStart=${command}`,
    ...(hostGuard ? [`ExecStart=${hostGuard}`] : []), `ExecReload=${reload}`,
    ...(hostGuard ? [`ExecReload=${hostGuard}`] : []), 'UMask=0077',
    'TimeoutStartSec=60', 'TimeoutStopSec=10', 'NoNewPrivileges=true',
    'CapabilityBoundingSet=CAP_NET_ADMIN', 'ProtectSystem=strict', 'ProtectHome=true',
    'PrivateTmp=true', `ReadWritePaths=${quote(stateDirectory)}`, '',
    '# Explicitly start this unit after authorized host preflight; stopping retains the guard.', ''].join('\n');
  return { unit, earlyUnit, settings: { schemaVersion: 1, network, stateDirectory, ipPath: '/usr/sbin/ip',
    nftPath: '/usr/sbin/nft', guardRules }, guardRules };
}
