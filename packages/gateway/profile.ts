import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { types } from 'node:util';
import { canonicalJson, compileConfig, deploymentDnsOptions, type Candidate, type JsonObject } from '../config/index.ts';

/** Legacy ARM64 pin retained for existing fixtures and deployment inputs. */
export const AUTOMATIC_GATEWAY_CORE_SHA256 = '8c73570d9a5f388bc2f58eee0b347ccfab84fb3cf1a0f8f2cf5eac7005fbcdc0';
/** Fixed reviewed v1.19.33 bytes only; target installation also verifies ELF architecture. */
export const AUTOMATIC_GATEWAY_CORE_SHA256_BY_PLATFORM: Readonly<Record<'linux-arm64' | 'linux-amd64-v1', string>> = Object.freeze({
  'linux-arm64': AUTOMATIC_GATEWAY_CORE_SHA256,
  'linux-amd64-v1': '19cbe7ba1523a92ed2d0a30716ea093de57db05b7844db23de2b9c21fd7a1afa',
});
export const AUTOMATIC_GATEWAY_TUN_ADDRESS = '198.18.0.1/30';

export type AutomaticGatewaySettings = {
  schemaVersion: 1;
  ingressInterface: string;
  gatewayIPv4: string;
  routerIPv4: string;
  routerMAC: string;
  /** Exactly one source form; CIDR covers every ordinary host in the connected LAN. */
  clientIPv4?: string;
  clientCIDR?: string;
  prefixLength: number;
  dnsPort: number;
  egressMark: number;
  egressTable: number;
  egressPriority: number;
  tunMtu: number;
};

export class AutomaticGatewayConfigError extends Error {
  readonly code = 'AUTOMATIC_GATEWAY_CONFIG_INVALID';
  constructor() { super('AUTOMATIC_GATEWAY_CONFIG_INVALID'); this.name = 'AutomaticGatewayConfigError'; }
}
function fail(): never { throw new AutomaticGatewayConfigError(); }

/** Reflection never runs user accessors, proxy traps, toJSON or inherited code. */
function dataOnly(input: unknown): void {
  let remaining = 100_000, bytes = 0;
  const ancestors = new Set<object>();
  function visit(value: unknown, depth: number): void {
    if (--remaining < 0 || depth > 48) fail();
    if (value === null || typeof value === 'boolean') return;
    if (typeof value === 'string') { bytes += Buffer.byteLength(value); if (bytes > 4 * 1024 * 1024) fail(); return; }
    if (typeof value === 'number') { if (!Number.isFinite(value)) fail(); return; }
    if (!value || typeof value !== 'object' || types.isProxy(value) || ancestors.has(value)) fail();
    const array = Array.isArray(value), prototype = Object.getPrototypeOf(value);
    if (!array && prototype !== Object.prototype && prototype !== null) fail();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(descriptors).some(key => typeof key !== 'string')) fail();
    ancestors.add(value);
    if (array) {
      if (value.length > remaining || Object.keys(descriptors).some(key => key !== 'length' &&
        (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length))) fail();
      for (let index = 0; index < value.length; index++) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) fail();
        visit(descriptor.value, depth + 1);
      }
    } else {
      for (const [key, descriptor] of Object.entries(descriptors)) {
        bytes += Buffer.byteLength(key);
        if (bytes > 4 * 1024 * 1024 || ['__proto__', 'prototype', 'constructor'].includes(key) ||
          !descriptor.enumerable || !('value' in descriptor)) fail();
        visit(descriptor.value, depth + 1);
      }
    }
    ancestors.delete(value);
  }
  visit(input, 0);
}

function object(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail();
  return input as Record<string, unknown>;
}
function integer(input: unknown, minimum: number, maximum: number): number {
  if (typeof input !== 'number' || !Number.isInteger(input) || input < minimum || input > maximum) fail();
  return input;
}
function ipv4(input: unknown): string {
  if (typeof input !== 'string' || isIP(input) !== 4 || /^0\.|^127\.|^169\.254\./.test(input) || Number(input.split('.')[0]) >= 224) fail();
  return input;
}
const ipv4Number = (address: string) => address.split('.').reduce((value, octet) => value * 256 + Number(octet), 0);
const settingsKeys = ['schemaVersion', 'ingressInterface', 'gatewayIPv4', 'routerIPv4', 'routerMAC',
  'prefixLength', 'dnsPort', 'egressMark', 'egressTable', 'egressPriority', 'tunMtu'];

/** Deployment input only: no generation, executable hooks or implicit defaults. */
export function parseAutomaticGatewaySettings(input: unknown): AutomaticGatewaySettings {
  try {
    dataOnly(input);
    const value = object(input);
    const sourceKey = Object.hasOwn(value, 'clientCIDR') ? 'clientCIDR' : 'clientIPv4';
    if (Object.keys(value).length !== settingsKeys.length + 1 ||
      Object.keys(value).some(key => !settingsKeys.includes(key) && key !== sourceKey) || value.schemaVersion !== 1) fail();
    const iface = value.ingressInterface;
    if (typeof iface !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,14}$/.test(iface) || iface === 'lo' || /tun/i.test(iface)) fail();
    const gatewayIPv4 = ipv4(value.gatewayIPv4), routerIPv4 = ipv4(value.routerIPv4);
    const clientIPv4 = sourceKey === 'clientIPv4' ? ipv4(value.clientIPv4) : undefined;
    if (gatewayIPv4 === routerIPv4 || clientIPv4 === gatewayIPv4 || clientIPv4 === routerIPv4) fail();
    const prefixLength = integer(value.prefixLength, 1, 29), size = 2 ** (32 - prefixLength);
    const network = Math.floor(ipv4Number(gatewayIPv4) / size) * size;
    if ([gatewayIPv4, routerIPv4, ...(clientIPv4 ? [clientIPv4] : [])].some(address => {
      const number = ipv4Number(address);
      return number <= network || number >= network + size - 1;
    })) fail();
    const connected = [24, 16, 8, 0].map(shift => Math.floor(network / 2 ** shift) % 256).join('.') + `/${prefixLength}`;
    if (sourceKey === 'clientCIDR' && value.clientCIDR !== connected) fail();
    const tun = ipv4Number(AUTOMATIC_GATEWAY_TUN_ADDRESS.split('/')[0]);
    if (network <= tun + 2 && network + size - 1 >= tun - 1) fail();
    if (typeof value.routerMAC !== 'string' || !/^(?:[0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}$/.test(value.routerMAC) ||
      (Number.parseInt(value.routerMAC.slice(0, 2), 16) & 1) !== 0 || value.routerMAC === '00:00:00:00:00:00') fail();
    const egressMark = integer(value.egressMark, 1, 0xffffffff), egressTable = integer(value.egressTable, 2000, 19999);
    if ([2023, 2024].includes(egressMark) || egressTable === 2022) fail();
    return { schemaVersion: 1, ingressInterface: iface, gatewayIPv4, routerIPv4, routerMAC: value.routerMAC.toLowerCase(),
      ...(clientIPv4 ? { clientIPv4 } : { clientCIDR: connected }), prefixLength, dnsPort: integer(value.dnsPort, 1024, 65535), egressMark, egressTable,
      egressPriority: integer(value.egressPriority, 1000, 8997), tunMtu: integer(value.tunMtu, 1280, 9000) };
  } catch { return fail(); }
}

/** Called only with parsed settings; router/gateway and LAN control addresses are excluded. */
export function automaticGatewayManagesIPv4(n: AutomaticGatewaySettings, address: string): boolean {
  if (n.clientIPv4) return address === n.clientIPv4;
  const size = 2 ** (32 - n.prefixLength), network = Math.floor(ipv4Number(n.gatewayIPv4) / size) * size;
  const number = ipv4Number(address);
  return number > network && number < network + size - 1 && address !== n.gatewayIPv4 && address !== n.routerIPv4;
}

/** Reuse the existing offline policy compiler, then install the fixed native profile. */
export function compileAutomaticGatewayConfig(base: unknown, input: unknown): Candidate {
  try {
    const settings = parseAutomaticGatewaySettings(input);
    dataOnly(base);
    const compiled = compileConfig(base), dns = compiled.config.dns as JsonObject;
    if (dns.listen !== `127.0.0.1:${settings.dnsPort}` || Number(compiled.config['mixed-port']) < 1024 ||
      Number(String(compiled.config['external-controller']).split(':')[1]) < 1024) fail();
    const resolvers = dns['default-nameserver'];
    if (!Array.isArray(resolvers) || resolvers.some(address => ipv4(address) === settings.gatewayIPv4 || automaticGatewayManagesIPv4(settings, address as string))) fail();
    const size = 2 ** (32 - settings.prefixLength), network = Math.floor(ipv4Number(settings.gatewayIPv4) / size) * size;
    const connected = [24, 16, 8, 0].map(shift => Math.floor(network / 2 ** shift) % 256).join('.') + `/${settings.prefixLength}`;
    const config: JsonObject = {
      ...compiled.config,
      'interface-name': settings.ingressInterface,
      'routing-mark': settings.egressMark,
      'x-coproxy-gateway': { ...settings },
      tun: { enable: true, device: 'coproxy-tun', stack: 'mips', mtu: settings.tunMtu,
        'auto-route': true, 'auto-redirect': true, 'auto-detect-interface': false, 'strict-route': true,
        'include-interface': [settings.ingressInterface], 'route-exclude-address': [connected],
        // Forwarded clients belong to the gateway; local applications retain
        // the host's own routes, including management and system updates.
        'exclude-uid-range': ['0:4294967294'],
        'iproute2-table-index': 2022, 'iproute2-rule-index': 9000,
        'auto-redirect-input-mark': 2023, 'auto-redirect-output-mark': 2024,
        'dns-mode': 'disabled', 'dns-hijack': [], gso: false, 'disable-icmp-forwarding': true },
      dns: { ...dns, listen: `${settings.gatewayIPv4}:${settings.dnsPort}`, 'listen-routing-mark': settings.egressMark,
        'fake-ip-range': AUTOMATIC_GATEWAY_TUN_ADDRESS },
    };
    const sha256 = createHash('sha256').update(canonicalJson(config), 'utf8').digest('hex');
    return { id: sha256, sha256, config };
  } catch { return fail(); }
}

const overlayKeys = ['allow-lan', 'bind-address', 'mixed-port', 'external-controller', 'secret', 'tun', 'ipv6', 'dns', 'sniffer',
  'interface-name', 'routing-mark', 'x-coproxy-gateway'];

/** Extraction for trusted recompile, not proof that an arbitrary stored config is valid. */
export function automaticGatewayPolicy(config: JsonObject): JsonObject {
  dataOnly(config);
  object(config);
  const policy = { ...config };
  for (const key of overlayKeys) delete policy[key];
  return policy;
}

/** Caller must compare the resulting id with the immutable stored generation. */
export function recompileAutomaticGatewayConfig(config: JsonObject, input: unknown): Candidate {
  try {
    dataOnly(config);
    object(config);
    const settings = parseAutomaticGatewaySettings(input), dns = object(config.dns), controller = config['external-controller'];
    if (typeof controller !== 'string' || !/^127\.0\.0\.1:([1-9]\d{0,4})$/.test(controller) || typeof config.secret !== 'string') fail();
    return compileAutomaticGatewayConfig({ schemaVersion: 1, deployment: {
      mixedPort: config['mixed-port'], controllerPort: Number(controller.slice(10)), controllerSecret: config.secret,
      dnsPort: settings.dnsPort, bootstrapResolvers: dns['default-nameserver'], ...deploymentDnsOptions(config),
    }, policy: automaticGatewayPolicy(config) }, settings);
  } catch { return fail(); }
}
