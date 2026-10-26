import { readFileSync } from 'node:fs';
import { cloneConfigJson } from '../config/index.ts';
import type { SetupEnvironment } from './input.ts';

/** Shared with the Python hook; packages/ is already included in release source. */
const declaration = JSON.parse(readFileSync(new URL('./router-adapter.json', import.meta.url), 'utf8'));
export class RouterAdapterError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.name = 'RouterAdapterError'; this.code = code; }
}
export interface SetupRouter {
  adapter: 'alwayroute-ubus/v1';
  lanInterface: string;
  gatewayMAC: string;
  dnsListenPort: number;
  localDomains: string[];
  enabled: boolean;
  baseDNSIndependentConfirmed: true;
}
export function parseSetupRouter(input: unknown, routerMAC: string): SetupRouter {
  const invalid = () => { throw new RouterAdapterError('SETUP_ROUTER_FACTS_INVALID'); };
  const value = cloneConfigJson(input) as any;
  const keys = ['adapter', 'lanInterface', 'gatewayMAC', 'dnsListenPort', 'localDomains', 'enabled', 'baseDNSIndependentConfirmed'];
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length ||
      keys.some(key => !Object.hasOwn(value, key))) invalid();
  if (value.adapter !== declaration.id) throw new RouterAdapterError('SETUP_ROUTER_ADAPTER_UNSUPPORTED');
  if (typeof value.lanInterface !== 'string' || !/^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,14}$/.test(value.lanInterface) ||
      value.lanInterface === 'lo' || typeof value.enabled !== 'boolean' || value.baseDNSIndependentConfirmed !== true ||
      !Number.isSafeInteger(value.dnsListenPort) || value.dnsListenPort < 1 || value.dnsListenPort > 65535 || value.dnsListenPort === 53 ||
      typeof value.gatewayMAC !== 'string' || !/^(?:[0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}$/.test(value.gatewayMAC) ||
      (parseInt(value.gatewayMAC.slice(0, 2), 16) & 1) !== 0 || value.gatewayMAC === '00:00:00:00:00:00' ||
      value.gatewayMAC.toLowerCase() === routerMAC.toLowerCase()) invalid();
  if (!Array.isArray(value.localDomains) || value.localDomains.length < 1 || value.localDomains.length > 16 ||
      new Set(value.localDomains).size !== value.localDomains.length || value.localDomains.some((domain: unknown) =>
        typeof domain !== 'string' || domain.length > 253 || domain.split('.').some(label =>
          !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)))) invalid();
  return { ...value, gatewayMAC: value.gatewayMAC.toLowerCase() };
}

/** Values are a target-neutral template. The hook binds the real revision by CAS. */
export function createRouterParameters(environment: SetupEnvironment) {
  if (!environment.router) throw new RouterAdapterError('SETUP_ROUTER_CONFIRMATION_REQUIRED');
  const router = parseSetupRouter(environment.router, environment.network.routerMAC);
  const network = environment.network;
  return { schemaVersion: 1, contract: declaration.contract, adapter: { id: declaration.id, version: declaration.version },
    managedIPv4: network.clientCIDR, nextHopIPv4: network.gatewayIPv4, routerIPv4: network.routerIPv4,
    deliveryMAC: network.routerMAC.toLowerCase(), dnsPort: environment.ports.dns,
    preserveClientSource: true, managedPublicIPv6: 'block', independentDisableRequired: true,
    configTemplate: { schema: 1, enabled: router.enabled, family: 'ipv4', faultPolicy: 'block',
      link: { interface: router.lanInterface, routerAddress: network.routerIPv4,
        gatewayAddress: network.gatewayIPv4, gatewayMac: router.gatewayMAC },
      clientMode: 'lan', clientCIDR: network.clientCIDR, clients: [],
      dns: { gatewayPort: environment.ports.dns, listenPort: router.dnsListenPort, localDomains: router.localDomains }, bypass4: [] },
    prerequisites: { bootstrapResolvers: [...environment.management.bootstrapResolvers],
      baseDNS: { ...declaration.baseDNS, localDomains: [...router.localDomains], unqualifiedNames: true },
      baseDNSIndependentConfirmed: router.baseDNSIndependentConfirmed,
      verification: 'operator-confirmation', endToEnd: 'unverified' },
    sources: { 'link.interface': 'router.lanInterface', 'link.gatewayMac': 'router.gatewayMAC',
      'link.routerAddress': 'network.routerIPv4', 'link.gatewayAddress': 'network.gatewayIPv4',
      clientCIDR: 'network.clientCIDR', 'dns.gatewayPort': 'ports.dns', 'dns.listenPort': 'router.dnsListenPort',
      'dns.localDomains': 'router.localDomains', enabled: 'router.enabled',
      deliveryMAC: 'network.routerMAC', bootstrapResolvers: 'management.bootstrapResolvers' },
  };
}
