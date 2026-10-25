import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, readlink, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { types } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { canonicalJson } from '../config/index.ts';
import { assertManagedUnit } from '../runtime/observer.ts';
import { parseUnitState } from '../runtime/systemd.ts';
import { parseRuntimeSettings, verifyBinary } from '../runtime/settings.ts';
import type { RuntimeSettings, RuntimeUnitState } from '../runtime/types.ts';
import { atomicWrite, inspectPrivateDirectory, privateDirectory, privateRead } from '../storage/private-files.ts';
import { FileTransactionStore } from '../transaction/index.ts';
import { validateWithMihomo } from '../mihomo/validator.ts';
import { loadGatewayCandidate } from './candidate.ts';
import { runNetworkCommand } from './command.ts';
import { fencedNetworkCommandDigest, inspectFencedNetworkCommand, runFencedNetworkCommand,
  settleFencedNetworkCommand, sameFencedIdentity, type FencedCommandInspection } from './fenced-command.ts';
import { renderNetworkPlan, type NetworkPlanInput } from './plan.ts';
import { renderGatewayRuntimePlan } from './runtime-plan.ts';
import { NetworkDriverError } from './transaction.ts';

const unit = 'cocoproxy-mihomo.service';
const group = '/system.slice/' + unit;
const properties = 'LoadState,ActiveState,SubState,MainPID,Job,FragmentPath,DropInPaths,NeedDaemonReload,User';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const digest = /^[a-f0-9]{64}$/;
const errno = (error: unknown) => (error as NodeJS.ErrnoException)?.code;
const fail: (settled?: boolean) => never = (settled = false) => { throw new NetworkDriverError(settled); };
export interface GatewayCoreSettings { runtime: RuntimeSettings; coreHome: string }
type Action = 'start' | 'stop';
interface Pending { action: Action; token: string; commandSHA: string; context: { bootID: string; userNS: string; netNS: string; uid: number } }
interface Journal { schemaVersion: 1; scope: 'production' | 'fixture'; revision: number; settingsSHA: string; selected: string | null; pending: Pending | null }
interface UnitObservation { state: RuntimeUnitState; controlGroup: string }

/** Trusted test seams; the fixture factory cannot produce production scope. */
export interface GatewayRuntimeFixtureDependencies {
  preflight(): Promise<void>;
  show(): Promise<UnitObservation>;
  candidate: typeof loadGatewayCandidate;
  validate: typeof validateWithMihomo;
  command(token: string, action: Action, args: readonly string[]): Promise<void>;
  inspect(token: string, settle: boolean): Promise<FencedCommandInspection>;
  emptyCgroup(): Promise<void>;
}

async function rootPath(path: string, directory: boolean, owner = 0, privateMode = false, executable = !directory): Promise<void> {
  for (let current = path;; current = dirname(current)) {
    const stat = await lstat(current), leaf = current === path;
    if (stat.isSymbolicLink() || stat.uid !== (leaf ? owner : 0) ||
      (stat.mode & (leaf && privateMode ? 0o077 : 0o022)) !== 0 ||
      (leaf && !directory ? !stat.isFile() || stat.nlink !== 1 || (executable && !(stat.mode & 0o111)) : !stat.isDirectory())) fail(true);
    if (current === '/') break;
  }
}

/** Root-owned selection, systemd credential snapshot, and durable manager jobs.
 * This is a core lifecycle component, not a complete network driver or readiness proof. */
export class GatewayCoreRuntime {
  readonly scope: 'production' | 'fixture';
  readonly settings: RuntimeSettings;
  readonly coreHome: string;
  readonly credentialPath: string;
  private readonly selectedPath: string;
  private readonly settingsSHA: string;
  private readonly store: FileTransactionStore;
  private readonly deps: GatewayRuntimeFixtureDependencies;
  private busy = false;
  private constructor(input: GatewayCoreSettings, scope: 'production' | 'fixture', fixture?: GatewayRuntimeFixtureDependencies) {
    if (!input || typeof input !== 'object' || types.isProxy(input)) fail(true);
    const descriptors = Object.getOwnPropertyDescriptors(input);
    if (Reflect.ownKeys(descriptors).length !== 2 || !['runtime', 'coreHome'].every(key =>
      descriptors[key]?.enumerable && 'value' in descriptors[key])) fail(true);
    if (types.isProxy(descriptors.runtime.value) || typeof descriptors.coreHome.value !== 'string') fail(true);
    input = { runtime: parseRuntimeSettings(descriptors.runtime.value), coreHome: descriptors.coreHome.value };
    const proposed = renderGatewayRuntimePlan({ schemaVersion: 1, stateDirectory: input.runtime.stateDirectory,
      binaryPath: input.runtime.binaryPath, binarySha256: input.runtime.binarySha256, systemctlPath: input.runtime.systemctlPath,
      unitPath: input.runtime.unitPath, serviceUid: input.runtime.serviceUid, coreHome: input.coreHome });
    if (canonicalJson(proposed.settings as unknown as Parameters<typeof canonicalJson>[0]) !==
      canonicalJson(input.runtime as unknown as Parameters<typeof canonicalJson>[0])) fail(true);
    this.settings = Object.freeze(proposed.settings); this.coreHome = proposed.coreHome;
    this.credentialPath = proposed.credentialPath; this.selectedPath = proposed.selectedPath;
    this.settingsSHA = hash(JSON.stringify([this.settings, this.coreHome]));
    this.store = new FileTransactionStore(this.settings.stateDirectory);
    this.scope = scope;
    this.deps = scope === 'fixture' ? fixture! : this.productionDependencies();
  }
  static production(input: GatewayCoreSettings): GatewayCoreRuntime {
    if (process.platform !== 'linux' || process.geteuid?.() !== 0) fail(true);
    return new GatewayCoreRuntime(input, 'production');
  }
  static fixture(input: GatewayCoreSettings, dependencies: GatewayRuntimeFixtureDependencies): GatewayCoreRuntime {
    const names = ['preflight', 'show', 'candidate', 'validate', 'command', 'inspect', 'emptyCgroup'];
    if (!dependencies || typeof dependencies !== 'object' || types.isProxy(dependencies)) fail(true);
    const descriptors = Object.getOwnPropertyDescriptors(dependencies);
    if (Reflect.ownKeys(descriptors).length !== names.length || names.some(key =>
      !descriptors[key]?.enumerable || !('value' in descriptors[key]) || typeof descriptors[key].value !== 'function')) fail(true);
    return new GatewayCoreRuntime(input, 'fixture', Object.freeze({ ...dependencies }));
  }
  private args(action: Action): string[] { return ['--no-ask-password', '--no-pager', action, unit]; }
  private productionDependencies(): GatewayRuntimeFixtureDependencies {
    const systemctl = async () => {
      const binary = await realpath(this.settings.systemctlPath);
      if (binary !== '/usr/bin/systemctl') fail(true);
      await rootPath(binary, false); return binary;
    };
    return {
      preflight: async () => {
        for (const name of ['user', 'net']) if (await readlink(`/proc/self/ns/${name}`) !== await readlink(`/proc/1/ns/${name}`)) fail(true);
        await rootPath(this.settings.stateDirectory, true, 0, true);
        await rootPath(this.coreHome, true, this.settings.serviceUid, true);
        if (await realpath(this.settings.binaryPath) !== this.settings.binaryPath) fail(true);
        await rootPath(this.settings.binaryPath, false);
        await verifyBinary(this.settings); await systemctl();
      },
      show: async () => {
        const binary = await systemctl();
        await rootPath(this.settings.unitPath, false, 0, false, false);
        const state = parseUnitState(await runNetworkCommand(binary,
          ['--no-ask-password', '--no-pager', 'show', '--property=' + properties, unit]));
        await assertManagedUnit(this.settings, state);
        const text = await runNetworkCommand(binary, ['--no-ask-password', '--no-pager', 'show', '--property=ControlGroup', '--value', unit]);
        const controlGroup = text.replace(/\n$/, '');
        if (![group, ''].includes(controlGroup) || (state.mainPid > 0 && controlGroup !== group)) fail(true);
        return { state, controlGroup };
      },
      candidate: loadGatewayCandidate, validate: validateWithMihomo,
      command: async (token, _action, args) => {
        const binary = await systemctl();
        await runFencedNetworkCommand(join(this.store.root, 'commands'), token, binary, args,
          { timeoutMs: 20_000, maxOutputBytes: 16_384 });
      },
      inspect: (token, settle) => (settle ? settleFencedNetworkCommand : inspectFencedNetworkCommand)(join(this.store.root, 'commands'), token),
      emptyCgroup: async () => {
        try {
          const events = await readFile('/sys/fs/cgroup' + group + '/cgroup.events', 'utf8');
          if (!/^populated 0$/m.test(events) || !/^\s*$/.test(await readFile('/sys/fs/cgroup' + group + '/cgroup.procs', 'utf8'))) fail();
        } catch (error) { if (errno(error) !== 'ENOENT') throw error; }
      },
    };
  }
  private checkPlan(input: NetworkPlanInput): NetworkPlanInput {
    try {
      const plan = renderNetworkPlan(input).deployment;
      if (plan.core.binarySha256 !== this.settings.binarySha256 || plan.core.unitSha256 !== this.settings.unitSha256 ||
        plan.core.serviceUid !== this.settings.serviceUid) fail(true);
      return plan;
    } catch { return fail(true); }
  }
  private async read(): Promise<Journal | null> {
    try {
      let raw: string;
      try {
        await inspectPrivateDirectory(this.store.root);
        const path = join(this.store.root, 'gateway-core-state.json'), before = await lstat(path);
        if (!before.isFile() || before.nlink !== 1) fail();
        raw = await privateRead(path, 16_384);
        const after = await lstat(path);
        if (after.nlink !== 1 || before.ino !== after.ino || before.dev !== after.dev) fail();
      }
      catch (error) { if (errno(error) === 'ENOENT') return null; throw error; }
      const value = JSON.parse(raw) as Journal;
      if (!value || JSON.stringify(value) !== raw || Object.keys(value).sort().join(',') !== 'pending,revision,schemaVersion,scope,selected,settingsSHA' ||
        value.schemaVersion !== 1 || value.scope !== this.scope || !Number.isSafeInteger(value.revision) || value.revision < 1 || value.revision >= Number.MAX_SAFE_INTEGER ||
        value.settingsSHA !== this.settingsSHA || (value.selected !== null && (typeof value.selected !== 'string' || !digest.test(value.selected)))) fail();
      if (value.pending !== null) {
        const p = value.pending;
        if (!p || Object.keys(p).sort().join(',') !== 'action,commandSHA,context,token' || !['start', 'stop'].includes(p.action) ||
          typeof p.token !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(p.token) ||
          p.commandSHA !== this.commandSHA(p.action) || !p.context || Object.keys(p.context).sort().join(',') !== 'bootID,netNS,uid,userNS' ||
          typeof p.context.bootID !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(p.context.bootID) ||
          typeof p.context.userNS !== 'string' || !/^user:\[[1-9]\d{0,19}\]$/.test(p.context.userNS) ||
          typeof p.context.netNS !== 'string' || !/^net:\[[1-9]\d{0,19}\]$/.test(p.context.netNS) ||
          !Number.isSafeInteger(p.context.uid) || p.context.uid < 0 || p.context.uid > 0xffff_ffff) fail();
      }
      return value;
    } catch { return fail(); }
  }
  private async write(state: Journal): Promise<Journal> {
    if (state.revision >= Number.MAX_SAFE_INTEGER - 1) fail();
    const next = { ...state, revision: state.revision + 1 };
    await atomicWrite(this.store.root, 'gateway-core-state.json', JSON.stringify(next)); return next;
  }
  private commandSHA(action: Action): string {
    // /bin/systemctl is a deployment alias; the transport always uses this canonical binary.
    return fencedNetworkCommandDigest('/usr/bin/systemctl', this.args(action), { timeoutMs: 20_000, maxOutputBytes: 16_384 });
  }
  private async inspectPending(state: Journal, settle: boolean): Promise<FencedCommandInspection | null> {
    if (!state.pending) return null;
    // A signal must never precede the journal/receipt binding proof. In particular,
    // a syntactically valid receipt for another command is not recovery authority.
    const before = await this.deps.inspect(state.pending.token, false);
    this.checkPendingInspection(state.pending, before);
    if (before.state === 'uncertain') fail();
    if (!settle || before.state !== 'running') {
      if (before.state === 'running') fail();
      return before;
    }
    const value = await this.deps.inspect(state.pending.token, true);
    this.checkPendingInspection(state.pending, value);
    if (!value.receipt || !sameFencedIdentity(before.receipt!, value.receipt) || value.state !== 'settled') fail();
    const after = await this.deps.inspect(state.pending.token, false);
    this.checkPendingInspection(state.pending, after);
    if (!after.receipt || !sameFencedIdentity(before.receipt!, after.receipt) || after.state !== 'settled') fail();
    return after;
  }
  private checkPendingInspection(expected: Pending, value: FencedCommandInspection): void {
    if (!['absent', 'settled', 'running', 'uncertain'].includes(value.state) ||
      (value.state === 'absent' ? value.receipt !== undefined || value.result !== undefined : !value.receipt)) fail();
    if (value.receipt) {
      if (value.receipt.token !== expected.token || value.receipt.commandSHA !== expected.commandSHA || ['bootID', 'userNS', 'netNS', 'uid'].some(key =>
        value.receipt![key as keyof typeof expected.context] !== expected.context[key as keyof typeof expected.context])) fail();
      if (value.result && (value.result.token !== expected.token || value.result.commandSHA !== expected.commandSHA ||
        !sameFencedIdentity(value.result.worker, value.receipt))) fail();
    }
  }
  private async locked<T>(operation: () => Promise<T>): Promise<T> {
    if (this.busy) fail(); this.busy = true;
    let outcome: { value: T } | { error: unknown } | undefined;
    try {
      await this.store.exclusive(async () => {
        try { outcome = { value: await operation() }; } catch (error) { outcome = { error }; }
      });
      if (!outcome) fail();
      if ('error' in outcome) throw outcome.error;
      return outcome.value;
    } catch (error) { if (error instanceof NetworkDriverError) throw error; return fail(); }
    finally { this.busy = false; }
  }
  private async issue(state: Journal, action: Action, assertBlocked: () => Promise<void>): Promise<Journal> {
    const context = { bootID: (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim(),
      userNS: await readlink('/proc/self/ns/user'), netNS: await readlink('/proc/self/ns/net'), uid: process.geteuid!() };
    state = await this.write({ ...state, pending: { action, token: randomUUID(), commandSHA: this.commandSHA(action), context } });
    await assertBlocked();
    await this.deps.command(state.pending!.token, action, this.args(action));
    const finished = await this.inspectPending(state, false);
    if (!finished?.receipt || finished.result?.ok !== true || finished.result.code !== '') fail();
    const observed = await this.deps.show();
    if (observed.state.jobPending || (action === 'stop' ? observed.state.mainPid !== 0 ||
      !['inactive', 'failed'].includes(observed.state.activeState) : observed.state.mainPid <= 1 ||
      observed.state.activeState !== 'active' || observed.state.subState !== 'running' || observed.controlGroup !== group)) fail();
    if (action === 'stop') await this.deps.emptyCgroup();
    return this.write({ ...state, pending: null });
  }
  /** Read-only. A saved selection or running unit does not mean gateway readiness. */
  async preflight(input: NetworkPlanInput): Promise<void> {
    return this.observing(async () => {
      const plan = this.checkPlan(input);
      await this.deps.preflight(); await this.deps.show(); await this.read();
      await this.candidate(plan);
    });
  }
  private async candidate(plan: NetworkPlanInput) {
    const target = await this.deps.candidate(this.settings, plan.generation, plan);
    // systemd credentials have a cumulative size limit. Reserve space and reject
    // oversized config before any stop, selection or start mutation.
    if (Buffer.byteLength(canonicalJson(target.candidate.config)) > 1_000_000) fail(true);
    return target;
  }
  /** Read-only proof. Unknown workers or a live systemd job keep the fence. */
  async assertSettled(): Promise<void> {
    return this.observing(async () => {
      await this.deps.preflight();
      const state = await this.read(); if (state) await this.inspectPending(state, false);
      if ((await this.deps.show()).state.jobPending) fail();
    });
  }
  /** Read-only recovery authority check; it does not require a candidate or kill a worker. */
  async preflightSettlement(): Promise<void> {
    return this.observing(async () => {
      await this.deps.preflight();
      const state = await this.read();
      if (state?.pending) {
        const inspection = await this.deps.inspect(state.pending.token, false);
        this.checkPendingInspection(state.pending, inspection);
        if (inspection.state === 'uncertain') fail();
      }
      if ((await this.deps.show()).state.jobPending && !state?.pending) fail();
    });
  }
  private async settleOld(state: Journal): Promise<void> {
    const before = await this.inspectPending(state, true);
    // systemctl clients and manager jobs have independent lifetimes. Only a
    // journal-bound old operation can explain a job; never cancel an arbitrary job.
    for (let attempt = 0; (await this.deps.show()).state.jobPending; attempt++) {
      if (!state.pending || attempt === 10) fail();
      await delay(100);
    }
    const after = await this.inspectPending(state, false);
    if (before?.receipt ? !after?.receipt || !sameFencedIdentity(before.receipt, after.receipt) : after?.receipt) fail();
  }
  /** Caller has durably fenced settlement under the unique outer network lock.
   * Only the bound old worker may be terminated; no fresh business operation is issued. */
  async settlePending(): Promise<void> {
    return this.observing(async () => {
      if (this.busy) fail();
      await this.deps.preflight();
      const state = await this.read();
      if (!state?.pending) {
        if ((await this.deps.show()).state.jobPending) fail();
        return;
      }
      // exclusive() initializes storage. Settlement is permitted to use existing
      // storage only, including the candidates directory that this lock expects.
      await inspectPrivateDirectory(this.store.root);
      await inspectPrivateDirectory(join(this.store.root, 'candidates'));
      await this.locked(async () => {
        if (JSON.stringify(await this.read()) !== JSON.stringify(state)) fail();
        await this.settleOld(state);
        if (JSON.stringify(await this.read()) !== JSON.stringify(state)) fail();
        await this.inspectPending(state, false);
      });
    });
  }
  private async observing<T>(operation: () => Promise<T>): Promise<T> {
    try { return await operation(); }
    catch (error) { if (error instanceof NetworkDriverError) throw error; return fail(); }
  }
  /** Caller holds the unique outer network lock and supplies a fresh blocked readback. */
  async ensure(input: NetworkPlanInput, assertBlocked: () => Promise<void>): Promise<void> {
    if (typeof assertBlocked !== 'function') fail(true);
    const plan = this.checkPlan(input);
    return this.locked(async () => {
      await this.preflight(plan);
      const target = await this.candidate(plan);
      await this.deps.validate(target.candidate, { binaryPath: this.settings.binaryPath });
      await assertBlocked();
      let state = await this.read() ?? { schemaVersion: 1 as const, scope: this.scope, revision: 0, settingsSHA: this.settingsSHA, selected: null, pending: null };
      await privateDirectory(join(this.store.root, 'commands'));
      await this.settleOld(state);
      state = await this.issue(state, 'stop', assertBlocked);
      await atomicWrite(this.store.root, 'selected-core.json', canonicalJson(target.candidate.config));
      state = await this.write({ ...state, selected: plan.generation });
      await assertBlocked();
      await this.issue(state, 'start', assertBlocked);
    });
  }
  /** Explicit recovery mutation; this never starts a core or removes a guard. */
  async recoverStopped(assertBlocked: () => Promise<void>): Promise<void> {
    if (typeof assertBlocked !== 'function') fail(true);
    return this.locked(async () => {
      await this.deps.preflight(); await this.deps.show(); await assertBlocked();
      const state = await this.read() ?? { schemaVersion: 1 as const, scope: this.scope, revision: 0, settingsSHA: this.settingsSHA, selected: null, pending: null };
      await privateDirectory(join(this.store.root, 'commands'));
      await this.settleOld(state);
      await this.issue(state, 'stop', assertBlocked);
    });
  }
  /** Unit/selection facts only. DNS, process and socket identity still require independent observation. */
  async inspect() {
    return this.observing(async () => {
      await this.deps.preflight();
      const state = await this.read(), observed = await this.deps.show();
      if (state?.selected && hash(await privateRead(this.selectedPath)) !== state.selected) fail(true);
      return { scope: this.scope, generation: state?.selected ?? null, operationPending: state?.pending !== null && state?.pending !== undefined,
        mainPid: observed.state.mainPid, jobPending: observed.state.jobPending, controlGroup: observed.controlGroup,
        readiness: 'unknown' as const };
    });
  }
}
