import { lstat, realpath, unlink } from 'node:fs/promises';
import { basename, posix } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { validateWithMihomo } from '../mihomo/validator.ts';
import { atomicWrite, inspectPrivateDirectory, syncDirectory } from '../storage/private-files.ts';
import type { RuntimeAdapter } from '../transaction/index.ts';
import { runRuntimeCommand } from './command.ts';
import { assertManagedUnit, inspectCore, observeCore } from './observer.ts';
import { loadRuntimeCandidate, loadRuntimeCandidateReadonly, parseRuntimeSettings, readRuntimeSelection, verifyBinary } from './settings.ts';
import { selectionChanges, setControllerSelection } from './selections.ts';
import { RuntimeError } from './types.ts';
import type { CoreObservation, RuntimeProcessIdentity, RuntimeSettings, RuntimeSelection, RuntimeUnitState } from './types.ts';
import { measurePhase } from '../diagnostics/operation-timing.ts';

const unitName = 'cocoproxy-mihomo.service';
const networkAuditIntervalMs = 30_000;
const properties = ['LoadState', 'ActiveState', 'SubState', 'MainPID', 'Job', 'FragmentPath', 'DropInPaths', 'NeedDaemonReload', 'User'];

export function parseUnitState(output: string): RuntimeUnitState {
  if (typeof output !== 'string' || Buffer.byteLength(output) > 16_384 || /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/.test(output)) throw new RuntimeError('UNIT_STATE_INVALID');
  const values = new Map<string, string>();
  for (const line of output.replace(/\n$/, '').split('\n')) {
    const offset = line.indexOf('=');
    const key = line.slice(0, offset);
    if (offset < 1 || !properties.includes(key) || values.has(key) || /[\r\u0000]/.test(line)) throw new RuntimeError('UNIT_STATE_INVALID');
    values.set(key, line.slice(offset + 1));
  }
  if (properties.some(key => !values.has(key)) || !/^(0|[1-9]\d*)$/.test(values.get('MainPID')!) ||
      ['LoadState', 'ActiveState', 'SubState'].some(key => !/^[a-z][a-z-]*$/.test(values.get(key) ?? '')) ||
      !Number.isSafeInteger(Number(values.get('MainPID'))) || !['yes', 'no'].includes(values.get('NeedDaemonReload')!)) throw new RuntimeError('UNIT_STATE_INVALID');
  return { loadState: values.get('LoadState')!, activeState: values.get('ActiveState')!, subState: values.get('SubState')!,
    mainPid: Number(values.get('MainPID')), jobPending: !['', '0'].includes(values.get('Job')!),
    fragmentPath: values.get('FragmentPath')!, hasDropIns: values.get('DropInPaths') !== '',
    needsReload: values.get('NeedDaemonReload') === 'yes', user: values.get('User')! };
}

/** Injected seams are for tests; private deployment JSON cannot supply code. */
export interface RuntimeDependencies {
  command: typeof runRuntimeCommand;
  assertUnit: typeof assertManagedUnit;
  binary: typeof verifyBinary;
  validate: typeof validateWithMihomo;
  observe: typeof observeCore;
  verifySystemctl: (settings: RuntimeSettings) => Promise<string>;
  inspect: typeof inspectCore;
  load: typeof loadRuntimeCandidate;
  readSelection: typeof readRuntimeSelection;
  writeSelection: (settings: RuntimeSettings, selection: RuntimeSelection) => Promise<void>;
  setSelection: typeof setControllerSelection;
  platform: NodeJS.Platform;
  now: () => number;
}

async function writeSelection(settings: RuntimeSettings, selection: RuntimeSelection): Promise<void> {
  await inspectPrivateDirectory(settings.stateDirectory);
  await atomicWrite(settings.stateDirectory, 'selection.json', JSON.stringify(selection));
}

async function verifySystemctl(settings: RuntimeSettings): Promise<string> {
  try {
    const path = await realpath(settings.systemctlPath);
    const info = await lstat(path);
    if (!info.isFile() || info.uid !== 0 || (info.mode & 0o022) !== 0 || (info.mode & 0o111) === 0) throw new Error();
    return path;
  } catch { throw new RuntimeError('SYSTEMCTL_UNTRUSTED'); }
}

/** The installed systemd unit alone owns the core process and crash restarts. */
export class SystemdMihomoRuntime implements RuntimeAdapter {
  readonly settings: RuntimeSettings;
  private readonly deps: RuntimeDependencies;
  private networkCheckedAt = -Infinity;
  private hotConfirmation?: { generation: string; process: RuntimeProcessIdentity };
  constructor(settings: RuntimeSettings, dependencies: Partial<RuntimeDependencies> = {}) {
    this.settings = Object.freeze(parseRuntimeSettings(settings));
    this.deps = { command: runRuntimeCommand, assertUnit: assertManagedUnit, binary: verifyBinary,
      validate: validateWithMihomo, observe: observeCore, verifySystemctl, inspect: inspectCore,
      load: loadRuntimeCandidateReadonly, readSelection: readRuntimeSelection, writeSelection,
      setSelection: setControllerSelection, platform: process.platform, now: () => performance.now(), ...dependencies };
  }

  private async command(action: string, extra: string[] = []): Promise<string> {
    if (this.deps.platform !== 'linux') throw new RuntimeError('RUNTIME_PLATFORM_UNSUPPORTED');
    const binary = await this.deps.verifySystemctl(this.settings);
    return this.deps.command(binary, ['--no-ask-password', '--no-pager', action, ...extra, unitName]);
  }

  private async unit(): Promise<RuntimeUnitState> {
    const state = parseUnitState(await this.command('show', [`--property=${properties.join(',')}`]));
    await this.deps.assertUnit(this.settings, state);
    return state;
  }

  private async candidate(path: string, generation?: string) {
    const id = generation ?? basename(path, '.json');
    const loaded = await this.deps.load(this.settings, id);
    if (loaded.path !== path) throw new RuntimeError('CANDIDATE_UNTRUSTED');
    return loaded;
  }

  async validate(path: string, previousGeneration: string | null = null): Promise<void> {
    this.hotConfirmation = undefined;
    const loaded = await this.candidate(path);
    const unit = await this.unit();
    const binary = await this.deps.binary(this.settings);
    if (previousGeneration) {
      try {
        const selected = await this.deps.readSelection(this.settings);
        const previous = await this.deps.load(this.settings, previousGeneration);
        // A committed, currently healthy config with the same pinned deployment
        // already proves syntax. Reordering existing selectors adds no new config.
        if (selected?.generation === previousGeneration &&
            selectionChanges(previous.candidate.config, loaded.candidate.config) !== null &&
            (await this.deps.inspect(this.settings, previousGeneration, unit)).ready) return;
      } catch { /* Unavailable or migrated predecessors require full validation. */ }
    }
    await this.deps.validate(loaded.candidate, { binaryPath: binary });
  }

  private async stopAndConfirm(): Promise<void> {
    await this.unit();
    // A timed out systemctl client may leave a job running. An explicit stop
    // replaces a conflicting start; never start a successor until Job/PID clear.
    for (let attempt = 0; attempt < 2; attempt++) {
      try { await this.command('stop'); } catch { /* inspect actual manager state */ }
      const state = await this.unit();
      if (state.mainPid === 0 && !state.jobPending && ['inactive', 'failed'].includes(state.activeState)) return;
      if (attempt === 0) await delay(100);
    }
    throw new RuntimeError('RUNTIME_UNSETTLED');
  }

  private async select(generation: string): Promise<void> {
    await this.deps.writeSelection(this.settings, { schemaVersion: 1, generation });
  }

  private async hotSelect(target: Awaited<ReturnType<typeof loadRuntimeCandidate>>, generation: string): Promise<boolean> {
    let selected: RuntimeSelection | null;
    let previous: Awaited<ReturnType<typeof loadRuntimeCandidate>>;
    try {
      selected = await this.deps.readSelection(this.settings);
      if (!selected) return false;
      previous = await this.deps.load(this.settings, selected.generation);
    } catch {
      // Reviewed deployment migrations may deliberately invalidate the old
      // candidate. Eligibility failure must not block a verified cold start.
      return false;
    }
    const changes = selectionChanges(previous.candidate.config, target.candidate.config);
    if (changes === null) return false;
    const unit = await this.unit();
    const before = await this.deps.inspect(this.settings, selected.generation, unit);
    if (!before.ready || !before.process) return false;
    // The physical process may span many committed selections. Keep one fixed
    // base candidate rather than trusting an unbounded receipt ancestry.
    let base = previous;
    if (before.process.baseGeneration !== selected.generation) {
      try { base = await this.deps.load(this.settings, before.process.baseGeneration); }
      catch { return false; }
    }
    if (selectionChanges(base.candidate.config, target.candidate.config) === null) return false;
    const deadline = performance.now() + 3000;
    for (let offset = 0; offset < changes.length; offset += 4) {
      if (performance.now() >= deadline) throw new RuntimeError('RUNTIME_HOT_SELECTION_TIMEOUT');
      // Settle every request before rollback: a late PUT must never overwrite
      // choices in the restored predecessor's newly started controller.
      const results = await Promise.allSettled(changes.slice(offset, offset + 4).map(change =>
        this.deps.setSelection(target.controller.port, target.controller.secret, change.group, change.name)));
      if (results.some(result => result.status === 'rejected')) throw new RuntimeError('CONTROLLER_SELECTION_FAILED');
    }
    await this.deps.writeSelection(this.settings, { schemaVersion: 1, generation, hot: before.process });
    this.hotConfirmation = { generation, process: before.process };
    return true;
  }

  async activate(path: string, generation: string): Promise<void> {
    this.hotConfirmation = undefined;
    const target = await this.candidate(path, generation);
    await this.deps.binary(this.settings);
    if (await this.hotSelect(target, generation)) return;
    await this.stopAndConfirm();
    await this.select(generation);
    try { await this.command('start'); }
    catch {
      await this.stopAndConfirm();
      throw new RuntimeError('RUNTIME_START_FAILED');
    }
  }

  async observe(generation: string): Promise<CoreObservation> {
    const unit = await this.unit();
    if ((await this.deps.readSelection(this.settings))?.generation !== generation) return { ready: false, generation,
      checkedAt: new Date().toISOString(), reason: 'SELECTION_MISMATCH' };
    return this.deps.observe(this.settings, generation, unit);
  }

  /** Stable physical process identity for accounting; hot configuration selections do not reset usage. */
  async accountingIdentity(generation: string): Promise<RuntimeProcessIdentity> {
    const inspection = await this.deps.inspect(this.settings, generation, await this.unit());
    if (!inspection.ready || !inspection.process) throw new RuntimeError('RUNTIME_OBSERVATION_UNAVAILABLE');
    return inspection.process;
  }

  async confirm(generation: string): Promise<boolean> {
    const hot = this.hotConfirmation;
    this.hotConfirmation = undefined;
    if (hot?.generation === generation) {
      // One post-PUT inspection is the transaction confirmation. A different
      // process cannot become the expected physical process by waiting longer.
      const after = await this.deps.inspect(this.settings, generation, await this.unit());
      return after.ready && !!after.process && after.process.pid === hot.process.pid &&
        after.process.bootId === hot.process.bootId && after.process.startTime === hot.process.startTime &&
        after.process.baseGeneration === hot.process.baseGeneration;
    }
    const deadline = performance.now() + 10_000;
    do {
      if ((await this.observe(generation)).ready) return true;
      if (performance.now() >= deadline) break;
      await delay(100);
    } while (performance.now() < deadline);
    return false;
  }

  /** Read-only scheduling hint. Repair eligibility is checked again under the shared lock. */
  async needsReconcile(generation: string): Promise<boolean> {
    if (!(await this.observe(generation)).ready) return true;
    return !!this.settings.automaticGateway && this.deps.now() - this.networkCheckedAt >= networkAuditIntervalMs;
  }

  /** Called only under the shared transaction lock, for the committed active. */
  async reconcile(path: string, generation: string): Promise<boolean> {
    await this.candidate(path, generation);
    const unit = await this.unit();
    // Let systemd finish its own start/stop/restart job before another request.
    if (unit.jobPending || ['activating', 'deactivating', 'reloading'].includes(unit.activeState)) return false;
    if (this.settings.automaticGateway) {
      const binary = await this.deps.verifySystemctl(this.settings);
      // Reload reruns the fixed root prerequisite check without BindsTo stops.
      // A failed first boot prepare leaves the oneshot inactive; start it first.
      await measurePhase('network', async () => {
        await this.deps.command(binary, ['--no-ask-password', '--no-pager', 'start', 'cocoproxy-gateway-network.service']);
        await this.deps.command(binary, ['--no-ask-password', '--no-pager', 'reload', 'cocoproxy-gateway-network.service']);
      });
      this.networkCheckedAt = this.deps.now();
    }
    if ((await measurePhase('observe', () => this.observe(generation))).ready) return true;
    await this.restore(path, generation);
    return true;
  }

  async restore(previousPath: string | null, previousGeneration: string | null): Promise<void> {
    this.hotConfirmation = undefined;
    if ((previousPath === null) !== (previousGeneration === null)) throw new RuntimeError('RUNTIME_RESTORE_INVALID');
    await this.stopAndConfirm();
    if (previousPath === null || previousGeneration === null) {
      try { await unlink(posix.join(this.settings.stateDirectory, 'selection.json')); }
      catch (error) { if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw new RuntimeError('SELECTION_UNTRUSTED'); }
      await syncDirectory(this.settings.stateDirectory);
      return;
    }
    await this.candidate(previousPath, previousGeneration);
    await this.deps.binary(this.settings);
    await this.select(previousGeneration);
    try {
      await this.command('start');
      if (await this.confirm(previousGeneration)) return;
    } catch { /* settle before reporting restoration failure */ }
    await this.stopAndConfirm();
    throw new RuntimeError('RUNTIME_RESTORE_FAILED');
  }
}
