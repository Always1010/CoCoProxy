import { join } from 'node:path';
import { types } from 'node:util';
import { FileTransactionStore, TransactionError } from '../transaction/index.ts';
import { atomicWrite, inspectPrivateDirectory, privateRead } from '../storage/private-files.ts';
import { NetworkCommandError } from './command.ts';
import { renderNetworkPlan, type NetworkPlan, type NetworkPlanInput } from './plan.ts';
import { sameNetworkProtection } from './protection.ts';

export type NetworkScope = 'production' | 'fixture';
export type NetworkPhase = 'guarding' | 'preparing' | 'starting-core' | 'authorizing-core' |
  'probing' | 'activating' | 'ready' | 'settling' | 'containing' | 'blocked' | 'fault';
export class NetworkTransactionError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.name = 'NetworkTransactionError'; this.code = code; }
}
/** Only trusted driver code may assert that a failed mutation is fully settled. */
export class NetworkDriverError extends Error {
  readonly childSettled: boolean;
  constructor(childSettled: boolean) {
    super('NETWORK_DRIVER_FAILED'); this.name = 'NetworkDriverError'; this.childSettled = childSettled;
  }
}

export interface NetworkIdentity {
  scope: NetworkScope;
  generation: string;
  planSha256: string;
  checkedAt: number;
  bootId: string;
  corePid: number;
  corePidStartTime: string;
  coreUnitControlGroup: '/system.slice/coproxy-mihomo.service';
  coreCgroupKernelId: string;
  serviceUid: number;
  binarySha256: string;
  unitSha256: string;
  processAndUnitVerified: true;
  socketCgroupIsolationVerified: true;
  /** Required whenever the plan binds an independent management identity. */
  management?: { pid: number; pidStartTime: string; serviceUid: number;
    unitControlGroup: '/system.slice/coproxy-management.service'; cgroupKernelId: string };
}
const checks = ['dnsSocketsOwned', 'dnsUdpQuery', 'dnsTcpQuery', 'tunOwned', 'linkAndNeighbour',
  'socketEgressMark', 'ownedResources'] as const;
export interface NetworkEvidence {
  identity: NetworkIdentity;
  checkedAt: number;
  checks: Record<(typeof checks)[number], true>;
}

/**
 * Trusted in-process implementation, never supplied by JSON or browser input.
 * All methods must be bounded. Successful mutations must be fully settled and
 * read back. Unknown rejection is fenced as unsettled, never blindly retried.
 * No native backend is selected by this module and no fake default is supplied.
 */
export interface NetworkDriver {
  readonly scope: NetworkScope;
  /** Read-only ownership/collision/bypass/platform preflight. No repairs.
   * settle verifies trusted operation receipts and context before convergence;
   * it may accept bound live pending work, but never unknown ownership. recover
   * performs the full resource preflight after all pending work has settled. */
  preflight(plan: NetworkPlan, purpose: 'apply' | 'settle' | 'recover'): Promise<void>;
  /** Explicit recovery only, under the coordinator lock and durable fence.
   * Revalidate trusted persisted operation bindings, then boundedly terminate
   * or await only those earlier worker/manager operations. No caller-selected
   * PID, new business operation, network authorization or resource repair.
   * Success is followed by independent read-only settlement proof/preflight. */
  settlePending(plan: NetworkPlan): Promise<void>;
  /** Read-only proof that every earlier tool/manager mutation has settled. */
  assertSettled(plan: NetworkPlan): Promise<void>;
  /** Verify ownership, atomically install blocked guard, then read it back. */
  installBlockedGuard(plan: NetworkPlan): Promise<void>;
  /** Blackholes first; rules/routes and inactive classification; read back. */
  prepareBlocked(plan: NetworkPlan): Promise<void>;
  /** The sole installed systemd supervisor selects/starts this exact candidate. */
  ensureCore(plan: NetworkPlan): Promise<void>;
  observeIdentity(plan: NetworkPlan): Promise<NetworkIdentity>;
  /** Recheck identity before core-only authorization; clients stay blocked. */
  authorizeCore(plan: NetworkPlan, identity: NetworkIdentity): Promise<void>;
  /** Actual queries/ownership/kernel readback, not persisted booleans. */
  probe(plan: NetworkPlan, identity: NetworkIdentity): Promise<NetworkEvidence>;
  /** Recheck binding/evidence, add capture, atomically activate, read back. */
  activate(plan: NetworkPlan, evidence: NetworkEvidence): Promise<void>;
  /** Fresh active readback and probes; must preserve the same core identity. */
  verifyActive(plan: NetworkPlan, evidence: NetworkEvidence): Promise<NetworkEvidence>;
  /** Called only after blocked guard: retain blackholes, withdraw capture and
   * classification, then verify blocking. Never remove guard or restore DIRECT. */
  retainBlockedResources(plan: NetworkPlan): Promise<void>;
}

interface Journal {
  schemaVersion: 1;
  scope: NetworkScope;
  revision: number;
  deployment: NetworkPlanInput;
  planSha256: string;
  phase: NetworkPhase;
  fault: string | null;
  unsettled: boolean;
  updatedAt: number;
}
export interface NetworkStatus {
  scope: NetworkScope;
  revision: number;
  desiredEnabled: boolean;
  desiredGeneration: string | null;
  lastPhase: NetworkPhase | null;
  fault: string | null;
  unsettled: boolean;
  updatedAt: number | null;
  /** This is historical status, never a current kernel observation. */
  readiness: 'unknown' | 'fault';
  terminalPath: 'unverified';
}
export interface NetworkObservation {
  scope: NetworkScope;
  localReady: true;
  checkedAt: number;
  generation: string;
  planSha256: string;
  terminalPath: 'unverified';
}
export interface NetworkActiveCheckResult {
  status: NetworkStatus;
  observation: NetworkObservation | null;
}
const phases = ['guarding', 'preparing', 'starting-core', 'authorizing-core', 'probing',
  'activating', 'ready', 'settling', 'containing', 'blocked', 'fault'];
const faults = ['NETWORK_APPLY_FAILED', 'NETWORK_RECOVERY_REQUIRED', 'NETWORK_RECOVERY_FAILED',
  'NETWORK_COMMAND_UNSETTLED', 'NETWORK_CONTAINMENT_FAILED', 'NETWORK_HEALTH_FAILED'];
const fail: (code: string) => never = code => { throw new NetworkTransactionError(code); };
const errno = (error: unknown) => (error as NodeJS.ErrnoException)?.code;

function fields(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('NETWORK_EVIDENCE_INVALID');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const found = Reflect.ownKeys(descriptors);
  if (found.length !== keys.length || found.some(key => typeof key !== 'string' || !keys.includes(key))) fail('NETWORK_EVIDENCE_INVALID');
  const result: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    if (!descriptors[key].enumerable || !('value' in descriptors[key])) fail('NETWORK_EVIDENCE_INVALID');
    result[key] = descriptors[key].value;
  }
  return result;
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}
function revision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value < Number.MAX_SAFE_INTEGER;
}
function timestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}
function status(state: Journal | null, scope: NetworkScope): NetworkStatus {
  return { scope, revision: state?.revision ?? 0, desiredEnabled: state !== null,
    desiredGeneration: state?.deployment.generation ?? null, lastPhase: state?.phase ?? null,
    fault: state?.fault ?? null, unsettled: state?.unsettled ?? false, updatedAt: state?.updatedAt ?? null,
    readiness: state?.phase === 'fault' ? 'fault' : 'unknown', terminalPath: 'unverified' };
}
/** Separate root-owned network journal in production; trusted ancestors required.
 * Reuses the application store's proven cross-process lock and dead-owner checks.
 * Its candidates directory is reserved for subsequent core/network integration. */
class JournalStore {
  private readonly lock: FileTransactionStore;
  private readonly scope: NetworkScope;
  constructor(root: string, scope: NetworkScope) { this.lock = new FileTransactionStore(root); this.scope = scope; }
  async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    let outcome: { value: T } | { error: unknown } | undefined;
    try {
      // Keep domain errors outside FileTransactionStore's storage-error mapping.
      await this.lock.exclusive(async () => {
        try { outcome = { value: await operation() }; } catch (error) { outcome = { error }; }
      });
    } catch (error) {
      fail(error instanceof TransactionError && error.code === 'STORE_LOCKED' ? 'NETWORK_BUSY' : 'NETWORK_STORE_IO');
    }
    if (!outcome) fail('NETWORK_STORE_IO');
    if ('error' in outcome) throw outcome.error;
    return outcome.value;
  }
  async read(): Promise<Journal | null> {
    try {
      try { await inspectPrivateDirectory(this.lock.root); }
      catch (error) { if (errno(error) === 'ENOENT') return null; throw error; }
      let text: string;
      try { text = await privateRead(join(this.lock.root, 'network-state.json'), 65_536); }
      catch (error) { if (errno(error) === 'ENOENT') return null; throw error; }
      const value = fields(JSON.parse(text), ['schemaVersion', 'scope', 'revision', 'deployment',
        'planSha256', 'phase', 'fault', 'unsettled', 'updatedAt']);
      const plan = renderNetworkPlan(value.deployment);
      if (value.schemaVersion !== 1 || value.scope !== this.scope || !revision(value.revision) || value.revision === 0 ||
        plan.sha256 !== value.planSha256 || !phases.includes(value.phase as string) ||
        (value.fault !== null && !faults.includes(value.fault as string)) || typeof value.unsettled !== 'boolean' ||
        !timestamp(value.updatedAt) || (value.unsettled && ['ready', 'blocked'].includes(value.phase as string)) ||
        (value.phase === 'ready' && value.fault !== null) || (value.phase === 'fault' && value.fault === null)) fail('NETWORK_STORE_CORRUPT');
      return { ...value, deployment: plan.deployment } as unknown as Journal;
    } catch (error) {
      if (error instanceof NetworkTransactionError && error.code === 'NETWORK_STORE_CORRUPT') throw error;
      fail('NETWORK_STORE_CORRUPT');
    }
  }
  async write(state: Journal): Promise<void> {
    if (!revision(state.revision + 1)) fail('NETWORK_STORE_LIMIT');
    state.revision++;
    try { await atomicWrite(this.lock.root, 'network-state.json', JSON.stringify(state)); }
    catch { fail('NETWORK_STORE_IO'); }
  }
}

/** Durable orchestration only. A separately reviewed native driver is required. */
export class NetworkCoordinator {
  private readonly store: JournalStore;
  private readonly driver: NetworkDriver;
  private readonly scope: NetworkScope;
  private readonly clock: () => number;
  private lastTime = 0;
  private recoveredRevision: number | null = null;
  private activeProof: { revision: number; evidence: NetworkEvidence } | null = null;
  constructor(root: string, driver: NetworkDriver, clock = Date.now) {
    if (!driver || !['production', 'fixture'].includes(driver.scope)) fail('NETWORK_DRIVER_INVALID');
    this.driver = driver;
    this.scope = driver.scope;
    this.clock = clock;
    this.store = new JournalStore(root, driver.scope);
  }
  private now(): number {
    const value = this.clock();
    if (!timestamp(value) || value < this.lastTime) fail('NETWORK_CLOCK_UNTRUSTED');
    this.lastTime = value;
    return value;
  }
  private fresh(value: unknown, now: number): void {
    if (!timestamp(value) || now < value || now - value > 30_000) fail('NETWORK_EVIDENCE_STALE');
  }
  private identity(input: unknown, plan: NetworkPlan): NetworkIdentity {
    const keys = ['scope', 'generation', 'planSha256', 'checkedAt', 'bootId', 'corePid', 'corePidStartTime',
      'coreUnitControlGroup', 'coreCgroupKernelId', 'serviceUid', 'binarySha256', 'unitSha256',
      'processAndUnitVerified', 'socketCgroupIsolationVerified'];
    if (plan.deployment.management) keys.push('management');
    const value = fields(input, keys), now = this.now();
    this.fresh(value.checkedAt, now);
    if (value.scope !== this.scope || value.generation !== plan.deployment.generation || value.planSha256 !== plan.sha256 ||
      typeof value.bootId !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value.bootId) ||
      !Number.isSafeInteger(value.corePid) || (value.corePid as number) <= 1 || (value.corePid as number) > 0x7fff_ffff ||
      typeof value.corePidStartTime !== 'string' || !/^[1-9]\d{0,19}$/.test(value.corePidStartTime) ||
      value.coreUnitControlGroup !== '/system.slice/coproxy-mihomo.service' ||
      typeof value.coreCgroupKernelId !== 'string' || !/^[1-9]\d{0,19}$/.test(value.coreCgroupKernelId) ||
      value.serviceUid !== plan.deployment.core.serviceUid || value.binarySha256 !== plan.deployment.core.binarySha256 ||
      value.unitSha256 !== plan.deployment.core.unitSha256 || value.processAndUnitVerified !== true ||
      value.socketCgroupIsolationVerified !== true) fail('NETWORK_IDENTITY_MISMATCH');
    if (plan.deployment.management) {
      const management = fields(value.management, ['pid', 'pidStartTime', 'serviceUid', 'unitControlGroup', 'cgroupKernelId']);
      if (!Number.isSafeInteger(management.pid) || (management.pid as number) <= 1 || (management.pid as number) > 0x7fff_ffff ||
        management.pid === value.corePid || typeof management.pidStartTime !== 'string' || !/^[1-9]\d{0,19}$/.test(management.pidStartTime) ||
        management.serviceUid !== plan.deployment.management.serviceUid || management.serviceUid === value.serviceUid ||
        management.unitControlGroup !== '/system.slice/coproxy-management.service' || typeof management.cgroupKernelId !== 'string' ||
        !/^[1-9]\d{0,19}$/.test(management.cgroupKernelId) || management.cgroupKernelId === value.coreCgroupKernelId) fail('NETWORK_IDENTITY_MISMATCH');
    } else if (this.scope === 'production') fail('NETWORK_IDENTITY_MISMATCH');
    return freeze({ ...value } as unknown as NetworkIdentity);
  }
  private sameIdentity(left: NetworkIdentity, right: NetworkIdentity): void {
    const normalized = (value: NetworkIdentity) => ({ ...value, checkedAt: 0 });
    if (JSON.stringify(normalized(left)) !== JSON.stringify(normalized(right))) fail('NETWORK_IDENTITY_CHANGED');
  }
  private evidence(input: unknown, plan: NetworkPlan, expected: NetworkIdentity): NetworkEvidence {
    const value = fields(input, ['identity', 'checkedAt', 'checks']);
    const identity = this.identity(value.identity, plan);
    this.sameIdentity(expected, identity);
    this.fresh(value.checkedAt, this.now());
    const result = fields(value.checks, checks);
    if (checks.some(key => result[key] !== true)) fail('NETWORK_EVIDENCE_INVALID');
    return freeze({ identity, checkedAt: value.checkedAt as number, checks: { ...result } } as NetworkEvidence);
  }
  private async write(state: Journal, phase: NetworkPhase): Promise<void> {
    state.phase = phase;
    state.updatedAt = this.now();
    await this.store.write(state);
  }
  private async locked<T>(operation: () => Promise<T>): Promise<T> {
    let completed = false;
    try {
      return await this.store.exclusive(async () => { const value = await operation(); completed = true; return value; });
    } catch (error) {
      // The callback can commit successfully and still fail while releasing or
      // syncing the lock. Such a failed request must not retain an apply gate.
      if (completed) { this.recoveredRevision = null; this.activeProof = null; }
      throw error;
    }
  }
  private async driverCall<T>(operation: () => Promise<T>): Promise<T> {
    try { return await operation(); }
    catch (error) {
      if ((error instanceof NetworkCommandError || error instanceof NetworkDriverError) && error.childSettled === true) {
        throw new NetworkDriverError(true);
      }
      throw new NetworkDriverError(false);
    }
  }
  private async mutation(state: Journal, operation: () => Promise<void>, bestEffortJournal = false): Promise<boolean> {
    let storageFailed = false;
    state.unsettled = true;
    try { await this.write(state, state.phase); }
    catch (error) { if (!bestEffortJournal) throw error; storageFailed = true; }
    await this.driverCall(operation);
    state.unsettled = false;
    try { await this.write(state, state.phase); }
    catch (error) { if (!bestEffortJournal) throw error; storageFailed = true; }
    return storageFailed;
  }
  private async contain(state: Journal, plan: NetworkPlan, reason: string, settled: boolean): Promise<void> {
    this.activeProof = null;
    this.recoveredRevision = null;
    state.fault = settled ? reason : 'NETWORK_COMMAND_UNSETTLED';
    state.unsettled = !settled;
    if (!settled) {
      await this.write(state, 'fault');
      fail('NETWORK_COMMAND_UNSETTLED');
    }
    // Persistence failure must not prevent containment of an already enabled
    // path. The earlier durable intent still forces blocking on next recovery.
    let storageFailed = false;
    try { await this.write(state, 'containing'); } catch { storageFailed = true; }
    try {
      storageFailed = await this.mutation(state, () => this.driver.installBlockedGuard(plan), true) || storageFailed;
      storageFailed = await this.mutation(state, () => this.driver.retainBlockedResources(plan), true) || storageFailed;
    } catch (error) {
      state.unsettled = !(error instanceof NetworkDriverError && error.childSettled);
      state.fault = state.unsettled ? 'NETWORK_COMMAND_UNSETTLED' : 'NETWORK_CONTAINMENT_FAILED';
      await this.write(state, 'fault');
      fail(state.fault);
    }
    await this.write(state, 'blocked');
    if (storageFailed) fail('NETWORK_STORE_IO');
  }
  /** Read-only; never converts a saved ready phase into live readiness. */
  async status(): Promise<NetworkStatus> { return status(await this.store.read(), this.scope); }

  /** Fresh observation of this instance's successful activation. Saved ready is
   * never authorization, and monitoring never recovers or reactivates a path. */
  async checkActive(): Promise<NetworkActiveCheckResult> {
    try {
      // Acquiring the file lock creates its directory. Keep a never-enabled
      // installation untouched, as status/recover do for the same case.
      if (await this.store.read() === null) {
        this.activeProof = null;
        return { status: status(null, this.scope), observation: null };
      }
      return await this.locked(async () => {
        const state = await this.store.read();
        if (!state || ['blocked', 'fault'].includes(state.phase)) {
          this.activeProof = null;
          return { status: status(state, this.scope), observation: null };
        }
        const proof = this.activeProof;
        if (state.phase !== 'ready' || state.unsettled || this.recoveredRevision !== state.revision ||
          !proof || proof.revision !== state.revision) fail('NETWORK_RECOVERY_REQUIRED');
        const plan = freeze(renderNetworkPlan(state.deployment));
        let quiescenceProven = false;
        try {
          // A settled rejection only describes that call. Until successful
          // independent proof, earlier work must remain fenced as unsettled.
          await this.driverCall(() => this.driver.assertSettled(plan));
          quiescenceProven = true;
          this.sameIdentity(proof.evidence.identity,
            this.identity(await this.driverCall(() => this.driver.observeIdentity(plan)), plan));
          const verified = this.evidence(await this.driverCall(() => this.driver.verifyActive(plan, proof.evidence)),
            plan, proof.evidence.identity);
          return { status: status(state, this.scope), observation: { scope: this.scope, localReady: true as const,
            checkedAt: verified.checkedAt, generation: plan.deployment.generation, planSha256: plan.sha256,
            terminalPath: 'unverified' as const } };
        } catch (error) {
          const settled = quiescenceProven && (!(error instanceof NetworkDriverError) || error.childSettled);
          await this.contain(state, plan, 'NETWORK_HEALTH_FAILED', settled);
          fail('NETWORK_HEALTH_FAILED');
        }
      });
    } catch (error) {
      // A contender did not own the lock and cannot revoke the successful
      // check/apply currently holding it in this same coordinator instance.
      if (!(error instanceof NetworkTransactionError && error.code === 'NETWORK_BUSY')) this.activeProof = null;
      throw error;
    }
  }

  async apply(input: unknown, expectedRevision: number): Promise<{ status: NetworkStatus; observation: NetworkObservation }> {
    let plan: NetworkPlan;
    try {
      plan = freeze(renderNetworkPlan(input));
      if (this.scope === 'production' && !plan.deployment.management) fail('NETWORK_INPUT_INVALID');
    } catch { fail('NETWORK_INPUT_INVALID'); }
    if (!revision(expectedRevision)) fail('NETWORK_REVISION_INVALID');
    return this.locked(async () => {
      const previous = await this.store.read();
      if ((previous?.revision ?? 0) !== expectedRevision) fail('NETWORK_REVISION_CONFLICT');
      if (previous && this.recoveredRevision !== previous.revision) fail('NETWORK_RECOVERY_REQUIRED');
      if (previous && !['ready', 'blocked'].includes(previous.phase)) fail('NETWORK_RECOVERY_REQUIRED');
      if (previous && !sameNetworkProtection(previous.deployment, plan.deployment)) fail('NETWORK_PROTECTION_CHANGE_UNSUPPORTED');
      try { await this.driverCall(() => this.driver.preflight(plan, 'apply')); }
      catch (error) {
        if (!(error instanceof NetworkDriverError && error.childSettled)) {
          this.recoveredRevision = null; this.activeProof = null;
        }
        fail('NETWORK_PREFLIGHT_FAILED');
      }
      this.recoveredRevision = null;
      this.activeProof = null;
      const state: Journal = { schemaVersion: 1, scope: this.scope, revision: previous?.revision ?? 0,
        deployment: plan.deployment, planSha256: plan.sha256, phase: 'guarding', fault: null, unsettled: false, updatedAt: this.now() };
      // This durable enable intent precedes every network or core mutation.
      await this.store.write(state);
      try {
        await this.mutation(state, () => this.driver.installBlockedGuard(plan));
        await this.write(state, 'preparing');
        await this.mutation(state, () => this.driver.prepareBlocked(plan));
        await this.write(state, 'starting-core');
        await this.mutation(state, () => this.driver.ensureCore(plan));
        const identity = this.identity(await this.driverCall(() => this.driver.observeIdentity(plan)), plan);
        await this.write(state, 'authorizing-core');
        this.identity(identity, plan);
        await this.mutation(state, () => this.driver.authorizeCore(plan, identity));
        await this.write(state, 'probing');
        const evidence = this.evidence(await this.driverCall(() => this.driver.probe(plan, identity)), plan, identity);
        await this.write(state, 'activating');
        this.sameIdentity(identity, this.identity(await this.driverCall(() => this.driver.observeIdentity(plan)), plan));
        this.evidence(evidence, plan, identity);
        await this.mutation(state, () => this.driver.activate(plan, evidence));
        const verified = this.evidence(await this.driverCall(() => this.driver.verifyActive(plan, evidence)), plan, identity);
        this.evidence(verified, plan, identity);
        await this.write(state, 'ready');
        this.recoveredRevision = state.revision;
        this.activeProof = { revision: state.revision, evidence: verified };
        return { status: status(state, this.scope), observation: { scope: this.scope, localReady: true as const,
          checkedAt: verified.checkedAt, generation: plan.deployment.generation, planSha256: plan.sha256,
          terminalPath: 'unverified' as const } };
      } catch (error) {
        const settled = !(error instanceof NetworkDriverError) || error.childSettled;
        await this.contain(state, plan, 'NETWORK_APPLY_FAILED', settled);
        fail('NETWORK_APPLY_FAILED');
      }
    });
  }

  /** Every enabled startup, including saved ready, returns to verified blocking.
   * Recovery never resumes activation; a new explicit apply and fresh evidence
   * are required. A fresh journal remains untouched. */
  async recover(): Promise<NetworkStatus> {
    this.recoveredRevision = null;
    this.activeProof = null;
    if (await this.store.read() === null) return status(null, this.scope);
    return this.locked(async () => {
      const state = await this.store.read();
      if (!state) return status(null, this.scope);
      const plan = freeze(renderNetworkPlan(state.deployment));
      let quiescenceProven = false;
      try {
        // Check receipt provenance/platform without repairing or requiring the
        // bound pending worker to have exited before explicit convergence.
        await this.driverCall(() => this.driver.preflight(plan, 'settle'));
        state.fault = 'NETWORK_RECOVERY_REQUIRED';
        state.unsettled = true;
        await this.write(state, 'settling');
        await this.driverCall(() => this.driver.settlePending(plan));
        // A crash can happen before recording a failed command or after an
        // uncertain fsync. Never treat a saved false flag as quiescence proof.
        await this.driverCall(() => this.driver.assertSettled(plan));
        quiescenceProven = true;
        state.unsettled = false;
        await this.driverCall(() => this.driver.preflight(plan, 'recover'));
      } catch (error) {
        state.unsettled = !quiescenceProven || !(error instanceof NetworkDriverError && error.childSettled);
        state.fault = state.unsettled ? 'NETWORK_COMMAND_UNSETTLED' : 'NETWORK_RECOVERY_FAILED';
        await this.write(state, 'fault');
        fail(state.fault);
      }
      state.unsettled = false;
      await this.contain(state, plan, 'NETWORK_RECOVERY_REQUIRED', true);
      this.recoveredRevision = state.revision;
      return status(state, this.scope);
    });
  }
}
