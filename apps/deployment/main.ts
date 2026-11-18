import { writeSync } from 'node:fs';
import { deployRelease, prepareUpgrade, stageUpgrade, InstallError, type InstallOptions } from '../../packages/deployment/install.ts';
import { inspectDeployment, recoverDeployment } from '../../packages/deployment/maintenance.ts';

function reportCandidates(): InstallOptions['onCandidates'] {
  if (process.env.COCOPROXY_UPDATE_REPORT !== '1') return undefined;
  let last = -Infinity;
  return (completed, total) => {
    const now = performance.now();
    if (completed !== 0 && completed !== total && now - last < 500) return;
    try { writeSync(3, JSON.stringify({ event: 'candidates', completed, total }) + '\n'); }
    catch { /* Deployment must be able to finish when telemetry is disconnected. */ }
    last = now;
  };
}

try {
  const args = process.argv.slice(2), values: Record<string, string> = {};
  let apply = false;
  let preserveRuntime = false;
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (key === '--apply' && !apply) { apply = true; continue; }
    if (key === '--preserve-runtime' && !preserveRuntime) { preserveRuntime = true; continue; }
    if (!['--payload', '--input', '--manifest-sha256', '--operation', '--reviewed-configuration-sha256', '--reviewed-recovery-sha256', '--candidate-evidence'].includes(key) || values[key] ||
      !args[index + 1] || args[index + 1].startsWith('--')) throw new InstallError('INSTALL_ARGUMENTS_INVALID');
    values[key] = args[++index];
  }
  const operation = values['--operation'] ?? 'install';
  let result: unknown;
  if (operation === 'inspect' || operation === 'recover') {
    if (preserveRuntime) throw new InstallError('INSTALL_ARGUMENTS_INVALID');
    if (Object.keys(values).some(key => !['--operation', ...(operation === 'recover' ? ['--reviewed-recovery-sha256'] : [])].includes(key)) ||
      operation === 'inspect' && apply) throw new InstallError('INSTALL_ARGUMENTS_INVALID');
    result = operation === 'inspect' ? await inspectDeployment() :
      await recoverDeployment({ apply, reviewedRecoverySha256: values['--reviewed-recovery-sha256'] });
  } else {
    if (!values['--payload'] || !values['--input'] || !values['--manifest-sha256'] || values['--reviewed-recovery-sha256'] ||
      operation === 'prepare' && (apply || values['--reviewed-configuration-sha256'])) throw new InstallError('INSTALL_ARGUMENTS_INVALID');
    if (operation === 'stage' && (!apply || values['--reviewed-configuration-sha256'])) throw new InstallError('INSTALL_ARGUMENTS_INVALID');
    const options = { payload: values['--payload'], input: values['--input'], manifestSha256: values['--manifest-sha256'], preserveRuntime,
      candidateEvidence: values['--candidate-evidence'], onCandidates: reportCandidates() };
    result = operation === 'prepare' ? await prepareUpgrade(options) : operation === 'stage' ? await stageUpgrade(options) : await deployRelease({ ...options,
      operation: operation as InstallOptions['operation'], reviewedConfigurationSha256: values['--reviewed-configuration-sha256'], apply });
  }
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
} catch (error) {
  // Never expose paths, child output, private settings, or secret-bearing JSON.
  process.stderr.write((error instanceof InstallError ? error.code : 'INSTALL_PREFLIGHT_OR_APPLY_FAILED') + '\n');
  process.exitCode = 1;
}
