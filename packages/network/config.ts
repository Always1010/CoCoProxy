import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { types } from 'node:util';
import { canonicalJson, compileConfig, type Candidate, type JsonObject } from '../config/index.ts';
import { NETWORK_TUN_ADDRESS, renderNetworkPlan } from './plan.ts';

// This profile depends on reviewed v1.19.33 behavior, not a floating core schema.
export const GATEWAY_CORE_SHA256 = '8c73570d9a5f388bc2f58eee0b347ccfab84fb3cf1a0f8f2cf5eac7005fbcdc0';
export const GATEWAY_TUN_ADDRESS = NETWORK_TUN_ADDRESS;

export class GatewayConfigError extends Error {
  readonly code = 'GATEWAY_CONFIG_INVALID';
  constructor() { super('GATEWAY_CONFIG_INVALID'); this.name = 'GatewayConfigError'; }
}
function fail(): never { throw new GatewayConfigError(); }

/** Validate before any spread or compiler reflection can invoke supplied code. */
function dataOnly(input: unknown): void {
  let remaining = 100_000, bytes = 0;
  const ancestors = new Set<object>();
  function visit(value: unknown, depth: number): void {
    if (--remaining < 0 || depth > 48) fail();
    if (value === null || typeof value === 'boolean') return;
    if (typeof value === 'string') { bytes += Buffer.byteLength(value); if (bytes > 4 * 1024 * 1024) fail(); return; }
    if (typeof value === 'number') { if (!Number.isFinite(value)) fail(); return; }
    if (!value || typeof value !== 'object' || types.isProxy(value) || ancestors.has(value)) fail();
    const array = Array.isArray(value);
    const prototype = Object.getPrototypeOf(value);
    if (!array && prototype !== Object.prototype && prototype !== null) fail();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(descriptors).some(key => typeof key !== 'string')) fail();
    ancestors.add(value);
    if (array) {
      if (value.length > remaining || Object.keys(descriptors).some(key => key !== 'length' &&
        (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length))) fail();
      for (let i = 0; i < value.length; i++) {
        const descriptor = descriptors[String(i)];
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

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  return value as Record<string, unknown>;
}

function build(input: unknown) {
  dataOnly(input);
  const root = object(input);
  if (root.schemaVersion !== 1 || Object.keys(root).sort().join(',') !== 'base,network,schemaVersion') fail();
  const network = object(root.network);
  if (Object.hasOwn(network, 'generation')) fail();
  // The normalized deployment is the only source of network metadata. Its
  // generation is derived below from the complete canonical core configuration.
  const seed = renderNetworkPlan({ ...network, generation: '0'.repeat(64) }).deployment;
  if (seed.core.binarySha256 !== GATEWAY_CORE_SHA256) fail();
  const base = compileConfig(root.base);
  const dns = base.config.dns as JsonObject;
  const resolvers = dns['default-nameserver'];
  if (!Array.isArray(resolvers) || resolvers.some(value => typeof value !== 'string' || isIP(value) !== 4 ||
    value === seed.gatewayIPv4 || value === seed.clientIPv4 || /^0\.|^127\.|^169\.254\./.test(value) || Number(value.split('.')[0]) >= 224)) fail();
  if (Number(base.config['mixed-port']) < 1024 || Number(String(base.config['external-controller']).split(':')[1]) < 1024 ||
    dns.listen !== `127.0.0.1:${seed.dnsPort}`) fail();
  const subnetSize = 2 ** (32 - seed.prefixLength);
  const number = (address: string) => address.split('.').reduce((value, octet) => value * 256 + Number(octet), 0);
  if (Math.floor(number(seed.gatewayIPv4) / subnetSize) === Math.floor(number(GATEWAY_TUN_ADDRESS.split('/')[0]) / subnetSize)) fail();
  const { generation: _generation, ...metadata } = seed;
  const config: JsonObject = {
    ...base.config,
    'interface-name': seed.ingressInterface,
    'routing-mark': seed.marks.egress,
    // Hash all network deployment inputs, including guard and return resources.
    // Mihomo ignores this reserved extension; CoCoProxy must still authenticate it.
    'x-cocoproxy-network': JSON.parse(JSON.stringify(metadata)) as JsonObject,
    tun: { enable: true, device: seed.tun.interface, stack: 'mips', mtu: seed.tun.mtu,
      'auto-route': false, 'auto-redirect': false, 'auto-detect-interface': false,
      gso: false, 'dns-hijack': [], 'disable-icmp-forwarding': true },
    dns: { ...dns, listen: `${seed.gatewayIPv4}:${seed.dnsPort}`, 'listen-routing-mark': seed.marks.egress,
      'fake-ip-range': GATEWAY_TUN_ADDRESS },
  };
  const sha256 = createHash('sha256').update(canonicalJson(config), 'utf8').digest('hex');
  const candidate: Candidate = { id: sha256, sha256, config };
  const networkPlan = renderNetworkPlan({ ...metadata, generation: sha256 });
  return { schemaVersion: 1, kind: 'gateway-candidate-preview', candidate, networkPlan,
    expectedTun: { interface: seed.tun.interface, address: GATEWAY_TUN_ADDRESS, mtu: seed.tun.mtu },
    activation: 'unsupported-by-current-runtime', sensitive: true } as const;
}

/** Compile only. Existing management and explicit runtime intentionally reject this profile. */
export function compileGatewayPreview(input: unknown): ReturnType<typeof build> {
  try { return build(input); }
  catch { return fail(); }
}
