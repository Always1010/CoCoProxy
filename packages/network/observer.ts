import { types } from 'node:util';
import { NetworkCommandError } from './command.ts';
import { observeGatewayCore, type GatewayCoreObservation } from './core-observer.ts';
import { observeCoreCgroup, type CoreCgroupObservation, type CoreCgroupRequest } from './identity.ts';
import { observeNetworkLink, type NetworkLinkObservation, type NetworkLinkOptions } from './link.ts';
import { NativeNetworkSession } from './native.ts';
import { renderNetworkPlan, type NetworkPlan } from './plan.ts';
import { observeNetworkReadiness, type NetworkProbeObservation, type NetworkProbeOptions } from './probe.ts';
import type { GatewayCoreSettings } from './runtime.ts';
import { observeSocketSources, type SocketSourceBinding, type SocketSourceObservation, type SocketSourceOptions } from './sockets.ts';
import { NetworkDriverError, type NetworkEvidence, type NetworkIdentity, type NetworkScope } from './transaction.ts';

/** Trusted deployment settings. Management PID must come from the fixed service or authenticated local peer. */
export interface GatewayObserverSettings { core: GatewayCoreSettings; managementPid: number }
export interface GatewayEvidenceOptions { probe: NetworkProbeOptions; link: NetworkLinkOptions; mode: 'core-only' | 'active' }
type ResourceFacts = Pick<Awaited<ReturnType<NativeNetworkSession['inspect']>>, 'scope' | 'generation' | 'planSha256' | 'mode'>;
/** Internal seam only; cannot supply a backend to production entry points. */
export interface GatewayObserverFixture {
  core(settings: GatewayCoreSettings, plan: NetworkPlan): Promise<GatewayCoreObservation>;
  cgroup(request: CoreCgroupRequest): Promise<CoreCgroupObservation>;
  sockets(plan: NetworkPlan, binding: SocketSourceBinding, options: SocketSourceOptions): Promise<SocketSourceObservation>;
  probe(plan: NetworkPlan, identity: NetworkIdentity, options: NetworkProbeOptions): Promise<NetworkProbeObservation>;
  link(plan: NetworkPlan, options: NetworkLinkOptions): Promise<NetworkLinkObservation>;
  /** Must inspect the real owned resource session in production, never just compare saved booleans. */
  resources(plan: NetworkPlan): Promise<ResourceFacts>;
  now(): number;
}
const fail: (settled?: boolean) => never = (settled = true) => { throw new NetworkDriverError(settled); };
const uintPid = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 1 && value <= 0x7fff_ffff;
const positive = (value: unknown): value is string => typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value) && BigInt(value) <= 0xffff_ffff_ffff_ffffn;
function data(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== keys.length || keys.some(key => !descriptors[key]?.enumerable || !('value' in descriptors[key]))) fail();
  return Object.fromEntries(keys.map(key => [key, descriptors[key].value]));
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function planFor(input: NetworkPlan): NetworkPlan {
  const plan = renderNetworkPlan(input.deployment);
  if (input.sha256 !== plan.sha256 || !plan.deployment.management) fail();
  return freeze(plan);
}
function fresh(time: unknown, started: number, now: number): number {
  if (typeof time !== 'number' || !Number.isSafeInteger(time) || time <= 0 || time < started || time > now || now - time > 30_000 ||
    !Number.isSafeInteger(started) || started <= 0 || !Number.isSafeInteger(now) || now < started || now - started > 30_000) fail();
  return time;
}
function observed(value: { scope: NetworkScope; verified: boolean; checkedAt: number }, scope: NetworkScope,
  started: number, reader: GatewayObserverFixture, commandsSettled: unknown): void {
  if (commandsSettled !== true) fail(false);
  if (value.scope !== scope || value.verified !== true) fail();
  fresh(value.checkedAt, started, reader.now());
}
function same(left: NetworkIdentity, right: NetworkIdentity): void {
  const model = (value: NetworkIdentity) => {
    const snapshot = data(value, ['scope', 'generation', 'planSha256', 'checkedAt', 'bootId', 'corePid', 'corePidStartTime',
      'coreUnitControlGroup', 'coreCgroupKernelId', 'serviceUid', 'binarySha256', 'unitSha256',
      'processAndUnitVerified', 'socketCgroupIsolationVerified', 'management']);
    snapshot.management = data(snapshot.management, ['pid', 'pidStartTime', 'serviceUid', 'unitControlGroup', 'cgroupKernelId']);
    return JSON.stringify({ ...snapshot, checkedAt: 0 });
  };
  if (model(left) !== model(right)) fail();
}
function socketBinding(identity: NetworkIdentity): SocketSourceBinding {
  const management = identity.management!;
  return { bootId: identity.bootId, core: { pid: identity.corePid, startTime: identity.corePidStartTime,
    uid: identity.serviceUid, cgroupKernelId: identity.coreCgroupKernelId }, management: { pid: management.pid,
    startTime: management.pidStartTime, uid: management.serviceUid, cgroupKernelId: management.cgroupKernelId } };
}
async function identity(plan: NetworkPlan, settings: GatewayObserverSettings, reader: GatewayObserverFixture,
  scope: NetworkScope, started: number): Promise<NetworkIdentity> {
  const request = data(settings, ['core', 'managementPid']);
  if (!uintPid(request.managementPid)) fail();
  const snapshots: NetworkIdentity[] = [];
  for (let index = 0; index < 2; index++) {
    const core = await reader.core(request.core as GatewayCoreSettings, plan);
    observed(core, scope, started, reader, core.commandsSettled);
    if (!core.facts) fail();
    const facts = data(core.facts, ['generation', 'planSha256', 'bootId', 'corePid', 'corePidStartTime', 'serviceUid',
      'binarySha256', 'unitSha256', 'coreUnitControlGroup']);
    if (facts.generation !== plan.deployment.generation || facts.planSha256 !== plan.sha256 ||
      facts.serviceUid !== plan.deployment.core.serviceUid || facts.binarySha256 !== plan.deployment.core.binarySha256 ||
      facts.unitSha256 !== plan.deployment.core.unitSha256 || !uintPid(facts.corePid) || facts.corePid === request.managementPid ||
      typeof facts.bootId !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(facts.bootId) ||
      !positive(facts.corePidStartTime) || facts.coreUnitControlGroup !== '/system.slice/coproxy-mihomo.service') fail();
    const groups = await reader.cgroup({ corePid: facts.corePid, corePidStartTime: facts.corePidStartTime,
      bootId: facts.bootId, serviceUid: plan.deployment.core.serviceUid, managementUid: plan.deployment.management!.serviceUid,
      managementPid: request.managementPid });
    observed(groups, scope, started, reader, true);
    if (!groups.identity) fail();
    const group = data(groups.identity, ['bootId', 'corePid', 'corePidStartTime', 'coreUnitControlGroup', 'coreCgroupKernelId',
      'managementPid', 'managementPidStartTime', 'managementUnitControlGroup', 'managementCgroupKernelId']);
    if (group.bootId !== facts.bootId || group.corePid !== facts.corePid || group.corePidStartTime !== facts.corePidStartTime ||
      group.coreUnitControlGroup !== facts.coreUnitControlGroup || group.managementPid !== request.managementPid ||
      !positive(group.managementPidStartTime) || !positive(group.coreCgroupKernelId) || !positive(group.managementCgroupKernelId) ||
      group.coreCgroupKernelId === group.managementCgroupKernelId || group.managementUnitControlGroup !== '/system.slice/coproxy-management.service') fail();
    const result: NetworkIdentity = { scope, generation: plan.deployment.generation, planSha256: plan.sha256,
      checkedAt: Math.min(core.checkedAt, groups.checkedAt), bootId: facts.bootId, corePid: facts.corePid,
      corePidStartTime: facts.corePidStartTime, coreUnitControlGroup: facts.coreUnitControlGroup,
      coreCgroupKernelId: group.coreCgroupKernelId, ...plan.deployment.core,
      processAndUnitVerified: true, socketCgroupIsolationVerified: true,
      management: { pid: request.managementPid, pidStartTime: group.managementPidStartTime,
        serviceUid: plan.deployment.management!.serviceUid, unitControlGroup: group.managementUnitControlGroup,
        cgroupKernelId: group.managementCgroupKernelId } };
    snapshots.push(result);
    if (index === 0) {
      const sockets = await reader.sockets(plan, socketBinding(result), { stage: 'identity' });
      observed(sockets, scope, started, reader, sockets.commandsSettled);
      if (sockets.stage !== 'identity' || sockets.generation !== result.generation || sockets.planSha256 !== plan.sha256 ||
        !['dnsListenerSources', 'coreSocketSources', 'egressSocketMarks', 'managementExcluded'].every(key =>
          sockets.checks[key as keyof typeof sockets.checks] === true)) fail();
      result.checkedAt = Math.min(result.checkedAt, sockets.checkedAt);
    }
  }
  same(snapshots[0], snapshots[1]);
  fresh(snapshots[0].checkedAt, started, reader.now());
  return freeze(snapshots[0]);
}
async function normalized<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (error) {
    if (error instanceof NetworkDriverError) throw error;
    return fail(error instanceof NetworkCommandError && error.childSettled === true);
  }
}
const live = (session?: NativeNetworkSession): GatewayObserverFixture => ({
  core: (settings, plan) => observeGatewayCore(settings, plan.deployment), cgroup: observeCoreCgroup,
  sockets: observeSocketSources, probe: observeNetworkReadiness, link: observeNetworkLink,
  async resources(plan) {
    if (!(session instanceof NativeNetworkSession) || session.scope !== 'production' || session.plan.sha256 !== plan.sha256) fail();
    return session.inspect();
  }, now: Date.now,
});
/** Fixed live readers only; no candidate/status JSON may substitute for these facts. */
export async function observeGatewayIdentity(plan: NetworkPlan, settings: GatewayObserverSettings): Promise<NetworkIdentity> {
  return normalized(async () => identity(planFor(plan), settings, live(), 'production', Date.now()));
}
export async function observeGatewayIdentityFixture(plan: NetworkPlan, settings: GatewayObserverSettings,
  reader: GatewayObserverFixture): Promise<NetworkIdentity> {
  return normalized(async () => identity(planFor(plan), settings, reader, 'fixture', reader.now()));
}
async function evidence(plan: NetworkPlan, settings: GatewayObserverSettings, expected: NetworkIdentity,
  options: GatewayEvidenceOptions, reader: GatewayObserverFixture, scope: NetworkScope): Promise<NetworkEvidence> {
  const started = reader.now();
  if (!['core-only', 'active'].includes(options.mode)) fail();
  const before = await identity(plan, settings, reader, scope, started);
  same(expected, before);
  const probe = await reader.probe(plan, before, options.probe);
  observed(probe, scope, started, reader, probe.commandsSettled);
  if (!['dnsSocketsOwned', 'dnsUdpQuery', 'dnsTcpQuery', 'tunOwned'].every(key => probe.checks[key as keyof typeof probe.checks] === true)) fail();
  const link = await reader.link(plan, options.link);
  observed(link, scope, started, reader, link.commandsSettled);
  if (link.planSha256 !== plan.sha256 || link.generation !== plan.deployment.generation ||
    !['interfaceIdentity', 'carrier', 'gatewayAddress', 'mtu', 'routerNeighbour', 'egressRoute', 'stable'].every(key => link.checks[key as keyof typeof link.checks] === true)) fail();
  const sockets = await reader.sockets(plan, socketBinding(before), { stage: 'ready' });
  observed(sockets, scope, started, reader, sockets.commandsSettled);
  if (sockets.stage !== 'ready' || sockets.planSha256 !== plan.sha256 || sockets.generation !== plan.deployment.generation ||
    !['dnsListenerSources', 'coreSocketSources', 'egressSocketMarks', 'managementExcluded', 'upstreamObserved'].every(key => sockets.checks[key as keyof typeof sockets.checks] === true)) fail();
  const resources = await reader.resources(plan);
  if (resources.scope !== scope || resources.generation !== plan.deployment.generation || resources.planSha256 !== plan.sha256 || resources.mode !== options.mode) fail();
  const after = await identity(plan, settings, reader, scope, started);
  same(before, after);
  const checkedAt = Math.min(before.checkedAt, probe.checkedAt, link.checkedAt, sockets.checkedAt, after.checkedAt);
  fresh(checkedAt, started, reader.now());
  return freeze({ identity: after, checkedAt, checks: { dnsSocketsOwned: true, dnsUdpQuery: true, dnsTcpQuery: true,
    tunOwned: true, linkAndNeighbour: true, socketEgressMark: true, ownedResources: true } });
}
export async function observeGatewayEvidence(plan: NetworkPlan, settings: GatewayObserverSettings, expected: NetworkIdentity,
  options: GatewayEvidenceOptions, session: NativeNetworkSession): Promise<NetworkEvidence> {
  return normalized(async () => evidence(planFor(plan), settings, expected, options, live(session), 'production'));
}
export async function observeGatewayEvidenceFixture(plan: NetworkPlan, settings: GatewayObserverSettings, expected: NetworkIdentity,
  options: GatewayEvidenceOptions, reader: GatewayObserverFixture): Promise<NetworkEvidence> {
  return normalized(async () => evidence(planFor(plan), settings, expected, options, reader, 'fixture'));
}
