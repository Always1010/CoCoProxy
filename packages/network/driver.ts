import { posix } from 'node:path';
import { types } from 'node:util';
import { NetworkCommandError } from './command.ts';
import { observeNetworkHost, type NetworkHostObservation, type NetworkHostOptions } from './host.ts';
import { observeGatewayManagement, type GatewayManagementObservation } from './management-observer.ts';
import { NativeNetworkSession, type NativeNetworkPreflight, type NativeNetworkTools } from './native.ts';
import { observeGatewayEvidence, observeGatewayIdentity, type GatewayEvidenceOptions,
  type GatewayObserverSettings } from './observer.ts';
import { renderNetworkPlan, type NetworkPlan } from './plan.ts';
import { sameNetworkProtection } from './protection.ts';
import { GatewayCoreRuntime, type GatewayCoreSettings } from './runtime.ts';
import { renderGatewayRuntimePlan } from './runtime-plan.ts';
import { NetworkCoordinator, NetworkDriverError, type NetworkDriver, type NetworkEvidence,
  type NetworkIdentity, type NetworkScope } from './transaction.ts';

export interface GatewayDriverSettings {
  authorityDirectory: string;
  resourceDirectory: string;
  core: GatewayCoreSettings;
  tools: NativeNetworkTools;
  host: NetworkHostOptions;
  probe: Omit<GatewayEvidenceOptions['probe'], 'timeoutMs'>;
  link: GatewayEvidenceOptions['link'];
}
type Purpose = 'apply' | 'settle' | 'recover';
export type GatewayResourceSession = Pick<NativeNetworkSession, 'scope' | 'plan' | 'inspect' | 'recoverBlocked' |
  'installBlocked' | 'prepare' | 'retainBlocked' | 'rebind' | 'authorizeCore' | 'activate'>;
type Core = Pick<GatewayCoreRuntime, 'preflight' | 'preflightSettlement' | 'settlePending' | 'assertSettled' | 'ensure' | 'recoverStopped'>;
/** Trusted in-process test seam. It cannot select a production backend. */
export interface GatewayDriverFixtureDependencies {
  core: Core;
  preflight(plan: NetworkPlan, purpose: Purpose): Promise<NativeNetworkPreflight>;
  settle(plan: NetworkPlan): Promise<void>;
  settled(plan: NetworkPlan): Promise<void>;
  open(plan: NetworkPlan): Promise<GatewayResourceSession>;
  host(plan: NetworkPlan): Promise<NetworkHostObservation>;
  management(plan: NetworkPlan): Promise<GatewayManagementObservation>;
  identity(plan: NetworkPlan, settings: GatewayObserverSettings): Promise<NetworkIdentity>;
  evidence(plan: NetworkPlan, settings: GatewayObserverSettings, expected: NetworkIdentity,
    options: GatewayEvidenceOptions, session: GatewayResourceSession): Promise<NetworkEvidence>;
}
const fail: (settled?: boolean) => never = (settled = true) => { throw new NetworkDriverError(settled); };
function data(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || types.isProxy(input) || Array.isArray(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input))) fail();
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (Reflect.ownKeys(descriptors).length !== keys.length || keys.some(key =>
    !descriptors[key]?.enumerable || !('value' in descriptors[key]))) fail();
  return Object.fromEntries(keys.map(key => [key, descriptors[key].value]));
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function directory(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('/') || value === '/' || posix.normalize(value) !== value ||
    /[\x00-\x1f\x7f]/.test(value)) fail();
  return value;
}
function settings(input: GatewayDriverSettings): GatewayDriverSettings {
  const root = data(input, ['authorityDirectory', 'resourceDirectory', 'core', 'tools', 'host', 'probe', 'link']);
  const core = data(root.core, ['runtime', 'coreHome']);
  const runtime = data(core.runtime, ['schemaVersion', 'stateDirectory', 'binaryPath', 'binarySha256',
    'systemctlPath', 'unitPath', 'unitSha256', 'serviceUid']);
  const proposed = renderGatewayRuntimePlan({ schemaVersion: 1, stateDirectory: runtime.stateDirectory as string,
    binaryPath: runtime.binaryPath as string, binarySha256: runtime.binarySha256 as string,
    systemctlPath: runtime.systemctlPath as string, unitPath: runtime.unitPath as string,
    serviceUid: runtime.serviceUid as number, coreHome: core.coreHome as string });
  if (Object.keys(runtime).some(key => runtime[key] !== proposed.settings[key as keyof typeof proposed.settings])) fail();
  const tools = data(root.tools, ['ipBinary', 'nftBinary']);
  if (!['/usr/sbin/ip', '/usr/bin/ip', '/sbin/ip'].includes(tools.ipBinary as string) ||
    !['/usr/sbin/nft', '/usr/bin/nft', '/sbin/nft'].includes(tools.nftBinary as string)) fail();
  const host = data(root.host, ['ipBinary', 'tcBinary', 'iptablesLegacySaveBinary', 'ip6tablesLegacySaveBinary']);
  const probeKeys = ['queryDomain', 'expectedIPv4', 'ipBinary'];
  // A fixed per-transport deadline is sufficient; arbitrary caller extensions
  // (including accessors) are rejected at this privileged composition boundary.
  const probe = data(root.probe, probeKeys), link = data(root.link, ['ipBinary', 'probeIPv4']);
  if (host.ipBinary !== tools.ipBinary || probe.ipBinary !== tools.ipBinary || link.ipBinary !== tools.ipBinary ||
    typeof probe.queryDomain !== 'string' || probe.queryDomain.length > 210 ||
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(probe.queryDomain) ||
    ![probe.expectedIPv4, link.probeIPv4].every(value => typeof value === 'string' &&
      /^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/.test(value) && value.split('.').every(octet => Number(octet) <= 255))) fail();
  for (const [key, name] of [['tcBinary', 'tc'], ['iptablesLegacySaveBinary', 'iptables-legacy-save'],
    ['ip6tablesLegacySaveBinary', 'ip6tables-legacy-save']]) {
    if (!['/usr/bin/', '/usr/sbin/', '/bin/', '/sbin/'].some(prefix => host[key] === prefix + name)) fail();
  }
  const authorityDirectory = directory(root.authorityDirectory), resourceDirectory = directory(root.resourceDirectory);
  const paths = [authorityDirectory, resourceDirectory, directory(proposed.settings.stateDirectory), directory(proposed.coreHome)];
  if (paths.some((path, index) => paths.some((other, peer) => peer !== index &&
    (path === other || path.startsWith(other + '/'))))) fail();
  return freeze({ authorityDirectory, resourceDirectory, core: { runtime: proposed.settings, coreHome: proposed.coreHome },
    tools, host, probe, link } as unknown as GatewayDriverSettings);
}
function fresh(time: number): void {
  const now = Date.now();
  if (!Number.isSafeInteger(time) || time <= 0 || time > now || now - time > 30_000) fail();
}
function sameIdentity(left: NetworkIdentity, right: NetworkIdentity): void {
  const withoutTime = (identity: NetworkIdentity) => ({ ...identity, checkedAt: 0 });
  // Canonical field insertion is not a wire-level identity requirement.
  const stable = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === 'object' &&
    !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
  if (stable(withoutTime(left)) !== stable(withoutTime(right))) fail();
}

/** Compose fixed production components; caller must use coordinator(), whose
 * unique authority lock encloses every operation. No backend comes from JSON. */
export class GatewayNetworkDriver implements NetworkDriver {
  readonly scope: NetworkScope;
  readonly settings: GatewayDriverSettings;
  private readonly deps: GatewayDriverFixtureDependencies;
  private session: GatewayResourceSession | null = null;
  private constructor(input: GatewayDriverSettings, scope: NetworkScope, deps?: GatewayDriverFixtureDependencies) {
    this.settings = settings(input); this.scope = scope;
    this.deps = deps ?? this.productionDependencies();
  }
  static production(input: GatewayDriverSettings): GatewayNetworkDriver {
    if (process.platform !== 'linux' || process.geteuid?.() !== 0) fail();
    return new GatewayNetworkDriver(input, 'production');
  }
  static fixture(input: GatewayDriverSettings, deps: GatewayDriverFixtureDependencies): GatewayNetworkDriver {
    const copied = data(deps, ['core', 'preflight', 'settle', 'settled', 'open', 'host', 'management', 'identity', 'evidence']);
    const core = data(copied.core, ['preflight', 'preflightSettlement', 'settlePending', 'assertSettled', 'ensure', 'recoverStopped']);
    if (Object.values(core).some(value => typeof value !== 'function') ||
      Object.entries(copied).some(([key, value]) => key !== 'core' && typeof value !== 'function')) fail();
    return new GatewayNetworkDriver(input, 'fixture', Object.freeze({ ...copied, core: Object.freeze(core) }) as unknown as GatewayDriverFixtureDependencies);
  }
  coordinator(): NetworkCoordinator { return new NetworkCoordinator(this.settings.authorityDirectory, this); }
  private productionDependencies(): GatewayDriverFixtureDependencies {
    const s = this.settings;
    return {
      core: GatewayCoreRuntime.production(s.core),
      preflight: (plan, purpose) => NativeNetworkSession.preflight(plan.deployment, s.tools, s.resourceDirectory, purpose),
      settle: plan => NativeNetworkSession.settlePending(plan.deployment, s.tools, s.resourceDirectory),
      settled: plan => NativeNetworkSession.assertSettled(plan.deployment, s.tools, s.resourceDirectory),
      open: plan => NativeNetworkSession.openForUpdate(plan.deployment, s.tools, s.resourceDirectory),
      host: plan => observeNetworkHost(plan.deployment, s.host),
      management: plan => observeGatewayManagement({ systemctlPath: s.core.runtime.systemctlPath,
        managementUid: plan.deployment.management!.serviceUid }),
      identity: observeGatewayIdentity,
      evidence: (plan, observer, expected, options, session) => {
        if (!(session instanceof NativeNetworkSession)) fail();
        return observeGatewayEvidence(plan, observer, expected, options, session);
      },
    };
  }
  private plan(input: NetworkPlan): NetworkPlan {
    const p = renderNetworkPlan(input.deployment), core = this.settings.core.runtime;
    if (input.sha256 !== p.sha256 || !p.deployment.management || p.deployment.core.serviceUid !== core.serviceUid ||
      p.deployment.core.binarySha256 !== core.binarySha256 || p.deployment.core.unitSha256 !== core.unitSha256) fail();
    const number = (ip: string) => ip.split('.').reduce((total, octet) => total * 256 + Number(octet), 0);
    const destination = number(this.settings.link.probeIPv4), first = Math.floor(destination / 2 ** 24);
    const size = 2 ** (32 - p.deployment.prefixLength);
    if (first === 0 || first === 127 || first >= 224 || Math.floor(destination / 65536) === 0xa9fe ||
      Math.floor(destination / 131072) === Math.floor(number('198.18.0.1') / 131072) ||
      Math.floor(destination / size) === Math.floor(number(p.deployment.gatewayIPv4) / size)) fail();
    return freeze(p);
  }
  private async call<T>(operation: () => Promise<T>, mutation = false): Promise<T> {
    try { return await operation(); }
    catch (error) {
      if (mutation) this.session = null;
      if (error instanceof NetworkDriverError) throw error;
      return fail(error instanceof NetworkCommandError && error.childSettled === true);
    }
  }
  private async host(plan: NetworkPlan): Promise<void> {
    const observed = await this.deps.host(plan);
    if (observed.commandsSettled !== true) fail(false);
    if (observed.scope !== this.scope || !observed.verified || observed.generation !== plan.deployment.generation ||
      observed.planSha256 !== plan.sha256 || !Object.values(observed.checks).every(value => value === true)) fail();
    fresh(observed.checkedAt);
  }
  private async resource(plan: NetworkPlan): Promise<GatewayResourceSession> {
    const session = this.session;
    if (!session || session.scope !== this.scope || session.plan.sha256 !== plan.sha256) fail();
    return session;
  }
  async preflight(input: NetworkPlan, purpose: Purpose): Promise<void> {
    return this.call(async () => {
      const plan = this.plan(input);
      if (!['apply', 'settle', 'recover'].includes(purpose)) fail();
      const observed = await this.deps.preflight(plan, purpose);
      if (observed.scope !== this.scope || observed.generation !== plan.deployment.generation || observed.planSha256 !== plan.sha256) fail();
      await this.deps.core.preflightSettlement();
      if (purpose === 'apply') {
        await this.deps.core.assertSettled(); await this.deps.core.preflight(plan.deployment); await this.host(plan);
      }
    });
  }
  async settlePending(input: NetworkPlan): Promise<void> {
    return this.call(async () => {
      const plan = this.plan(input); this.session = null;
      await this.deps.settle(plan); await this.deps.core.settlePending();
    }, true);
  }
  async assertSettled(input: NetworkPlan): Promise<void> {
    return this.call(async () => { const plan = this.plan(input); await this.deps.settled(plan); await this.deps.core.assertSettled(); });
  }
  async installBlockedGuard(input: NetworkPlan): Promise<void> {
    return this.call(async () => {
      const plan = this.plan(input);
      if (this.session && !sameNetworkProtection(this.session.plan.deployment, plan.deployment)) fail();
      // Reopen against the durable receipt even in the same process. Active
      // readback may have poisoned the cached session after TUN destruction;
      // only explicit recovery accepts that exact owned capture disappearance.
      this.session = null;
      const old = await this.deps.preflight(plan, 'recover');
      if (old.scope !== this.scope || old.planSha256 !== plan.sha256) fail();
      this.session = await this.deps.open(plan);
      if (this.session.scope !== this.scope || !sameNetworkProtection(this.session.plan.deployment, plan.deployment)) fail();
      if (old.initialized) await this.session.recoverBlocked(); else await this.session.installBlocked();
      if (this.session.plan.sha256 !== plan.sha256) {
        await this.session.retainBlocked(); await this.session.rebind(plan.deployment);
      }
      await this.blocked(plan);
    }, true);
  }
  private async blocked(plan: NetworkPlan): Promise<void> {
    const observed = await (await this.resource(plan)).inspect();
    if (observed.scope !== this.scope || observed.generation !== plan.deployment.generation ||
      observed.planSha256 !== plan.sha256 || observed.mode !== 'blocked') fail();
  }
  async prepareBlocked(input: NetworkPlan): Promise<void> {
    return this.call(async () => {
      const plan = this.plan(input), session = await this.resource(plan);
      await this.blocked(plan); await session.retainBlocked(); await session.prepare(); await this.blocked(plan);
    }, true);
  }
  async ensureCore(input: NetworkPlan): Promise<void> {
    return this.call(async () => {
      const plan = this.plan(input); await this.host(plan);
      await this.deps.core.ensure(plan.deployment, () => this.blocked(plan));
    }, true);
  }
  private async observer(plan: NetworkPlan): Promise<{ settings: GatewayObserverSettings; source: NonNullable<GatewayManagementObservation['facts']> }> {
    const observed = await this.deps.management(plan);
    if (observed.commandsSettled !== true) fail(false);
    if (observed.scope !== this.scope || !observed.verified || !observed.facts ||
      observed.facts.managementUid !== plan.deployment.management!.serviceUid) fail();
    fresh(observed.checkedAt);
    return { settings: { core: this.settings.core, managementPid: observed.facts.managementPid }, source: observed.facts };
  }
  private identitySource(plan: NetworkPlan, identity: NetworkIdentity, source: NonNullable<GatewayManagementObservation['facts']>): void {
    if (identity.scope !== this.scope || identity.generation !== plan.deployment.generation || identity.planSha256 !== plan.sha256 ||
      identity.bootId !== source.bootId || identity.management?.pid !== source.managementPid ||
      identity.management.pidStartTime !== source.managementPidStartTime || identity.management.serviceUid !== source.managementUid) fail();
    fresh(identity.checkedAt);
  }
  async observeIdentity(input: NetworkPlan): Promise<NetworkIdentity> {
    return this.call(async () => {
      const plan = this.plan(input), observer = await this.observer(plan);
      const identity = await this.deps.identity(plan, observer.settings);
      this.identitySource(plan, identity, observer.source); return identity;
    });
  }
  async authorizeCore(input: NetworkPlan, expected: NetworkIdentity): Promise<void> {
    return this.call(async () => {
      const plan = this.plan(input); await this.host(plan);
      const current = await this.observeIdentity(plan); sameIdentity(expected, current);
      await this.blocked(plan); await (await this.resource(plan)).authorizeCore();
    }, true);
  }
  private async evidence(plan: NetworkPlan, expected: NetworkIdentity, mode: 'core-only' | 'active'): Promise<NetworkEvidence> {
    await this.host(plan);
    const observer = await this.observer(plan), session = await this.resource(plan);
    const result = await this.deps.evidence(plan, observer.settings, expected,
      { mode, probe: this.settings.probe, link: this.settings.link }, session);
    this.identitySource(plan, result.identity, observer.source); sameIdentity(expected, result.identity);
    fresh(result.checkedAt);
    if (!['dnsSocketsOwned', 'dnsUdpQuery', 'dnsTcpQuery', 'tunOwned', 'linkAndNeighbour', 'socketEgressMark', 'ownedResources']
      .every(key => result.checks[key as keyof typeof result.checks] === true)) fail();
    return result;
  }
  async probe(input: NetworkPlan, identity: NetworkIdentity): Promise<NetworkEvidence> {
    return this.call(() => this.evidence(this.plan(input), identity, 'core-only'));
  }
  async activate(input: NetworkPlan, evidence: NetworkEvidence): Promise<void> {
    return this.call(async () => {
      const plan = this.plan(input); fresh(evidence.checkedAt);
      await this.evidence(plan, evidence.identity, 'core-only'); await (await this.resource(plan)).activate();
    }, true);
  }
  async verifyActive(input: NetworkPlan, evidence: NetworkEvidence): Promise<NetworkEvidence> {
    return this.call(() => this.evidence(this.plan(input), evidence.identity, 'active'));
  }
  async retainBlockedResources(input: NetworkPlan): Promise<void> {
    return this.call(async () => {
      const plan = this.plan(input); await this.blocked(plan); await (await this.resource(plan)).retainBlocked();
      await this.deps.core.recoverStopped(() => this.blocked(plan)); await this.blocked(plan);
    }, true);
  }
}
