import { lstat, realpath, unlink } from 'node:fs/promises';
import { posix } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { validateWithMihomo } from '../mihomo/validator.ts';
import { atomicWrite, inspectPrivateDirectory, syncDirectory } from '../storage/private-files.ts';
import type { RuntimeAdapter } from '../transaction/index.ts';
import { runRuntimeCommand } from './command.ts';
import { assertManagedUnit, observeCore } from './observer.ts';
import { loadRuntimeCandidate, parseRuntimeSettings, readSelection, verifyBinary } from './settings.ts';
import { RuntimeError } from './types.ts';
import type { CoreObservation, RuntimeSettings, RuntimeUnitState } from './types.ts';

const unitName = 'coproxy-mihomo.service';
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
}

async function verifySystemctl(settings: RuntimeSettings): Promise<string> {
  try {
    const path = await realpath(settings.systemctlPath);
    const info = await lstat(path);
    if (!info.isFile() || info.uid !== 0 || (info.mode & 0o022) !== 0 || (info.mode & 0o111) === 0) throw new Error();
    return path;
  } catch { throw new RuntimeError('SYSTEMCTL_UNTRUSTED'); }
}

/** Sole lifecycle owner is the installed systemd unit. This class has no watchdog. */
export class SystemdMihomoRuntime implements RuntimeAdapter {
  readonly settings: RuntimeSettings;
  private readonly deps: RuntimeDependencies;
  constructor(settings: RuntimeSettings, dependencies: Partial<RuntimeDependencies> = {}) {
    this.settings = Object.freeze(parseRuntimeSettings(settings));
    this.deps = { command: runRuntimeCommand, assertUnit: assertManagedUnit, binary: verifyBinary,
      validate: validateWithMihomo, observe: observeCore, verifySystemctl, ...dependencies };
  }

  private async command(action: string, extra: string[] = []): Promise<string> {
    if (process.platform !== 'linux') throw new RuntimeError('RUNTIME_PLATFORM_UNSUPPORTED');
    const binary = await this.deps.verifySystemctl(this.settings);
    return this.deps.command(binary, ['--no-ask-password', '--no-pager', action, ...extra, unitName]);
  }

  private async unit(): Promise<RuntimeUnitState> {
    const state = parseUnitState(await this.command('show', [`--property=${properties.join(',')}`]));
    await this.deps.assertUnit(this.settings, state);
    return state;
  }

  private async candidate(path: string, generation?: string) {
    const id = generation ?? posix.basename(path, '.json');
    const loaded = await loadRuntimeCandidate(this.settings, id);
    if (loaded.path !== path) throw new RuntimeError('CANDIDATE_UNTRUSTED');
    return loaded;
  }

  async validate(path: string): Promise<void> {
    const loaded = await this.candidate(path);
    await this.unit();
    const binary = await this.deps.binary(this.settings);
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
    await inspectPrivateDirectory(this.settings.stateDirectory);
    await atomicWrite(this.settings.stateDirectory, 'selection.json', JSON.stringify({ schemaVersion: 1, generation }));
  }

  async activate(path: string, generation: string): Promise<void> {
    await this.candidate(path, generation);
    await this.deps.binary(this.settings);
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
    if (await readSelection(this.settings) !== generation) return { ready: false, generation,
      checkedAt: new Date().toISOString(), reason: 'SELECTION_MISMATCH' };
    return this.deps.observe(this.settings, generation, unit);
  }

  async confirm(generation: string): Promise<boolean> {
    const deadline = performance.now() + 10_000;
    do {
      if ((await this.observe(generation)).ready) return true;
      if (performance.now() >= deadline) break;
      await delay(100);
    } while (performance.now() < deadline);
    return false;
  }

  async restore(previousPath: string | null, previousGeneration: string | null): Promise<void> {
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
