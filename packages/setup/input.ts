import { randomBytes } from 'node:crypto';
import { posix } from 'node:path';
import { cloneConfigJson, type JsonObject } from '../config/index.ts';
import { renderDeploymentPlan } from '../deployment/plan.ts';
import { releaseTarget } from '../deployment/install.ts';
import { AUTOMATIC_GATEWAY_CORE_SHA256, parseAutomaticGatewaySettings } from '../gateway/profile.ts';
import { createRouterParameters, parseSetupRouter, RouterAdapterError, type SetupRouter } from './router-adapter.ts';

export class SetupError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.name = 'SetupError'; this.code = code; }
}
const fail: () => never = () => { throw new SetupError('SETUP_ENVIRONMENT_INVALID'); };
function record(value: unknown, required: string[], optional: string[] = []): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => ![...required, ...optional].includes(key))) fail();
  return value as Record<string, any>;
}
function integer(value: unknown, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) fail();
  return value as number;
}
function installPath(value: unknown): string {
  if (typeof value !== 'string' || !/^\/[A-Za-z0-9_./-]+$/.test(value) || posix.normalize(value) !== value ||
      value.endsWith('/') || value.split('/').includes('.local') ||
      ['/home', '/root', '/tmp', '/var/tmp', '/run/user', '/proc', '/sys', '/dev'].some(root => value === root || value.startsWith(root + '/'))) fail();
  return value;
}

export interface SetupEnvironment {
  schemaVersion: 1;
  network: { ingressInterface: string; gatewayIPv4: string; routerIPv4: string; routerMAC: string; clientCIDR: string };
  management: { origin: string; bootstrapResolvers: string[]; subscriptionOrigins: string[]; probeOrigins: string[] };
  system: { serviceUser: string; serviceUid?: number; nodePath: string; systemctlPath: string; releaseParent: string };
  ports: { management: number; mixed: number; controller: number; dns: number };
  resources: { egressMark: number; egressTable: number; egressPriority: number; tunMtu: number };
  https?: { mode: 'external' } | { mode: 'managed'; certificatePath: string; privateKeyPath: string; nginxPath: string };
  router?: SetupRouter;
}

/** Environment facts only. Release paths, duplicate ports and secrets are generated. */
export function parseSetupEnvironment(input: unknown, previous?: unknown): SetupEnvironment {
  try {
    const old = previous === undefined ? undefined : cloneConfigJson(previous) as any;
    if (previous !== undefined) renderDeploymentPlan(old);
    const value = record(cloneConfigJson(input), ['schemaVersion', 'network', 'management'], ['system', 'ports', 'resources', 'https', 'router']);
    if (value.schemaVersion !== 1) fail();
    const network = record(value.network, ['ingressInterface', 'gatewayIPv4', 'routerIPv4', 'routerMAC', 'clientCIDR']);
    const management = record(value.management, ['origin', 'bootstrapResolvers', 'subscriptionOrigins'], ['probeOrigins']);
    const system = { ...(old ? { serviceUser: old.management.serviceUser, serviceUid: old.runtime.serviceUid,
      nodePath: old.runtime.nodePath, systemctlPath: old.runtime.systemctlPath,
      releaseParent: posix.dirname(posix.dirname(old.runtime.sourceDirectory)) } : {}),
      ...record(value.system ?? {}, [], ['serviceUser', 'serviceUid', 'nodePath', 'systemctlPath', 'releaseParent']) };
    const ports = { ...(old ? { management: old.management.listenPort, mixed: old.management.deployment.mixedPort,
      controller: old.management.deployment.controllerPort, dns: old.management.deployment.dnsPort } : {}),
      ...record(value.ports ?? {}, [], ['management', 'mixed', 'controller', 'dns']) };
    const resources = { ...(old?.runtime.automaticGateway ? Object.fromEntries(
      ['egressMark', 'egressTable', 'egressPriority', 'tunMtu'].map(key => [key, old.runtime.automaticGateway[key]])) : {}),
      ...record(value.resources ?? {}, [], ['egressMark', 'egressTable', 'egressPriority', 'tunMtu']) };
    const serviceUser = system.serviceUser ?? 'cocoproxy';
    if (typeof serviceUser !== 'string' || !/^[a-z_][a-z0-9_-]{0,31}$/.test(serviceUser) || ['root', 'nobody'].includes(serviceUser)) fail();
    const resolvedPorts = { management: integer(ports.management ?? 13000, 1024, 65535),
      mixed: integer(ports.mixed ?? 17890, 1024, 65535), controller: integer(ports.controller ?? 19090, 1024, 65535),
      dns: integer(ports.dns ?? 15353, 1024, 65535) };
    if (new Set(Object.values(resolvedPorts)).size !== 4) fail();
    const resolvedResources = { egressMark: integer(resources.egressMark ?? 65536, 1, 0xffffffff),
      egressTable: integer(resources.egressTable ?? 2024, 2000, 19999),
      egressPriority: integer(resources.egressPriority ?? 8000, 1000, 8997), tunMtu: integer(resources.tunMtu ?? 1500, 1280, 9000) };
    let https: SetupEnvironment['https'];
    if (value.https !== undefined) {
      const web = record(value.https, ['mode'], ['certificatePath', 'privateKeyPath', 'nginxPath']);
      if (web.mode === 'external' && Object.keys(web).length === 1) https = { mode: 'external' };
      else if (web.mode === 'managed') https = { mode: 'managed', certificatePath: installPath(web.certificatePath),
        privateKeyPath: installPath(web.privateKeyPath), nginxPath: installPath(web.nginxPath ?? '/usr/sbin/nginx') };
      else fail();
    }
    const prefix = typeof network.clientCIDR === 'string' ? /\/(\d+)$/.exec(network.clientCIDR) : null;
    if (!prefix) fail();
    parseAutomaticGatewaySettings({ schemaVersion: 1, ...network, prefixLength: Number(prefix[1]), dnsPort: resolvedPorts.dns, ...resolvedResources });
    const result: SetupEnvironment = { schemaVersion: 1, network: network as SetupEnvironment['network'],
      management: { origin: management.origin, bootstrapResolvers: management.bootstrapResolvers,
        subscriptionOrigins: management.subscriptionOrigins, probeOrigins: management.probeOrigins ?? old?.management.controllerPolicy?.allowedProbeOrigins ?? ['https://www.gstatic.com'] },
      system: { serviceUser, ...(system.serviceUid === undefined ? {} : { serviceUid: integer(system.serviceUid, 1, 4_294_967_294) }),
        nodePath: installPath(system.nodePath ?? '/usr/bin/node'), systemctlPath: installPath(system.systemctlPath ?? '/usr/bin/systemctl'),
        releaseParent: installPath(system.releaseParent ?? '/opt/cocoproxy/releases') }, ports: resolvedPorts, resources: resolvedResources,
      ...(https ? { https } : {}),
      ...(value.router === undefined ? {} : { router: parseSetupRouter(value.router, network.routerMAC) }) };
    // Reuse the final deployment compiler for DNS, origin, download policy and port contracts.
    createSetupDeployment(result, { manifestSha256: 'a'.repeat(64), binarySha256: AUTOMATIC_GATEWAY_CORE_SHA256,
      serviceUid: result.system.serviceUid ?? 12345, controllerSecret: 'setup-validation-only' });
    return result;
  } catch (error) { if (error instanceof RouterAdapterError) throw error; return fail(); }
}

export interface SetupRelease {
  manifestSha256: string;
  binarySha256: string;
  serviceUid: number;
  controllerSecret?: string;
}

/** A previous input is validated in full; an upgrade never silently rotates secrets. */
export function createSetupDeployment(environment: SetupEnvironment, release: SetupRelease, previous?: unknown): JsonObject {
  if (!/^[a-f0-9]{64}$/.test(release.manifestSha256) || !/^[a-f0-9]{64}$/.test(release.binarySha256)) fail();
  integer(release.serviceUid, 1, 4_294_967_294);
  const old = previous === undefined ? undefined : cloneConfigJson(previous) as any;
  if (previous !== undefined) {
    renderDeploymentPlan(old);
    if (old.runtime.serviceUid !== release.serviceUid || old.management.serviceUser !== environment.system.serviceUser) {
      throw new SetupError('SETUP_SERVICE_IDENTITY_CHANGED');
    }
  }
  const target = environment.system.releaseParent + '/' + release.manifestSha256;
  const network = environment.network;
  const controllerSecret = old?.management.deployment.controllerSecret ?? release.controllerSecret ?? randomBytes(32).toString('hex');
  const web = environment.https?.mode === 'managed' ? { schemaVersion: 1, nginxPath: environment.https.nginxPath,
    certificatePath: environment.https.certificatePath, privateKeyPath: environment.https.privateKeyPath }
    : environment.https?.mode === 'external' ? undefined : old?.web;
  const input: JsonObject = { schemaVersion: 1, ...(web ? { web } : {}), runtime: {
    schemaVersion: 1, stateDirectory: '/var/lib/cocoproxy', binaryPath: target + '/bin/mihomo', binarySha256: release.binarySha256,
    systemctlPath: environment.system.systemctlPath, nodePath: environment.system.nodePath, sourceDirectory: target + '/source',
    settingsPath: '/etc/cocoproxy/runtime.json', unitPath: '/etc/systemd/system/cocoproxy-mihomo.service', serviceUid: release.serviceUid,
    automaticGateway: { schemaVersion: 1, ...network, prefixLength: Number(network.clientCIDR.split('/')[1]), dnsPort: environment.ports.dns, ...environment.resources,
      ...(old?.runtime.automaticGateway?.tunStack === undefined ? {} : { tunStack: old.runtime.automaticGateway.tunStack }),
      ...(old?.runtime.automaticGateway?.tunGso === undefined ? {} : { tunGso: old.runtime.automaticGateway.tunGso }) },
  }, management: {
    origin: environment.management.origin, listenPort: environment.ports.management, serviceUser: environment.system.serviceUser,
    serverEntry: target + '/server/.output/server/index.mjs', settingsPath: '/etc/cocoproxy/management.json',
    credentialPath: '/etc/cocoproxy/admin.json', unitPath: '/etc/systemd/system/cocoproxy-management.service',
    policyPath: '/etc/polkit-1/rules.d/50-cocoproxy-management.rules',
    deployment: { ...(old?.management.deployment ?? {}), mixedPort: environment.ports.mixed, controllerPort: environment.ports.controller,
      controllerSecret, dnsPort: environment.ports.dns, bootstrapResolvers: environment.management.bootstrapResolvers },
    subscriptionPolicy: { ...(old?.management.subscriptionPolicy ?? {}), allowedOrigins: environment.management.subscriptionOrigins },
    controllerPolicy: { allowedProbeOrigins: environment.management.probeOrigins },
  } };
  if (old && (old.runtime.stateDirectory !== '/var/lib/cocoproxy' || old.runtime.settingsPath !== '/etc/cocoproxy/runtime.json' ||
      old.management.settingsPath !== '/etc/cocoproxy/management.json' || old.management.credentialPath !== '/etc/cocoproxy/admin.json')) {
    throw new SetupError('SETUP_CUSTOM_LAYOUT_REQUIRES_EXISTING_INSTALLER');
  }
  renderDeploymentPlan(input);
  releaseTarget(input, release.manifestSha256);
  return input;
}

export function routerParameters(environment: SetupEnvironment) {
  return createRouterParameters(environment);
}
