import { posix, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadRuntimeSettings, readSelection, verifyBinary, loadRuntimeCandidate } from '../../packages/runtime/settings.ts';
import { RuntimeError } from '../../packages/runtime/types.ts';
import { privateDirectory } from '../../packages/storage/private-files.ts';
import { FileTransactionStore } from '../../packages/transaction/index.ts';

/** Replaces the service process, preserving systemd's MainPID and cgroup. */
export async function runCore(settingsPath: string): Promise<void> {
  if (process.platform !== 'linux' || typeof process.execve !== 'function') {
    throw new RuntimeError('RUNTIME_EXEC_UNSUPPORTED');
  }
  try {
    const settings = await loadRuntimeSettings(settingsPath);
    if (typeof process.geteuid !== 'function' || process.geteuid() === 0 || process.geteuid() !== settings.serviceUid) {
      throw new RuntimeError('RUNTIME_IDENTITY_INVALID');
    }
    const state = await new FileTransactionStore(settings.stateDirectory).readState();
    const generation = await readSelection(settings);
    // A fault cannot reboot into its last failed selection. Explicit recover
    // first persists `restoring` and may launch only that transaction's previous
    // generation; otherwise a fault would also prevent its own recovery.
    if (state.fault !== null && !(state.pending?.phase === 'restoring' && generation !== null &&
        state.pending.previous === generation)) throw new RuntimeError('RUNTIME_RECOVERY_REQUIRED');
    if (generation === null) throw new RuntimeError('RUNTIME_SELECTION_MISSING');
    const binary = await verifyBinary(settings);
    const { path, home } = await loadRuntimeCandidate(settings, generation);
    await privateDirectory(home);
    // The controller cannot inherit proxy settings, loader injections or core
    // feature switches from an operator's shell or the launcher environment.
    const environment = { PATH: '/usr/bin:/bin', LANG: 'C', HOME: home };
    try { process.execve(binary, [binary, '-d', home, '-f', path], environment); }
    catch { throw new RuntimeError('RUNTIME_EXEC_FAILED'); }
    throw new RuntimeError('RUNTIME_EXEC_FAILED');
  } catch (error) {
    if (error instanceof RuntimeError) throw error;
    throw new RuntimeError('RUNTIME_LAUNCH_FAILED');
  }
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  try {
    if (args.length === 1 && args[0] === '--help') {
      process.stdout.write('Usage: launch-core.ts --settings <absolute-settings-path>\n');
      return;
    }
    if (args.length !== 2 || args[0] !== '--settings' || !posix.isAbsolute(args[1]) ||
        posix.normalize(args[1]) !== args[1] || /[\u0000-\u001f\u007f-\u009f]/.test(args[1])) {
      throw new RuntimeError('RUNTIME_ARGUMENT_INVALID');
    }
    await runCore(args[1]);
  } catch (error) {
    const code = error instanceof RuntimeError ? error.code : 'RUNTIME_LAUNCH_FAILED';
    process.stderr.write(JSON.stringify({ error: { code } }) + '\n');
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
