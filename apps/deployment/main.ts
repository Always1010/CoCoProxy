import { deployRelease, prepareUpgrade, InstallError, type InstallOptions } from '../../packages/deployment/install.ts';
import { inspectDeployment, recoverDeployment } from '../../packages/deployment/maintenance.ts';

try {
  const args = process.argv.slice(2), values: Record<string, string> = {};
  let apply = false;
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (key === '--apply' && !apply) { apply = true; continue; }
    if (!['--payload', '--input', '--manifest-sha256', '--operation', '--reviewed-configuration-sha256', '--reviewed-recovery-sha256'].includes(key) || values[key] ||
      !args[index + 1] || args[index + 1].startsWith('--')) throw new InstallError('INSTALL_ARGUMENTS_INVALID');
    values[key] = args[++index];
  }
  const operation = values['--operation'] ?? 'install';
  let result: unknown;
  if (operation === 'inspect' || operation === 'recover') {
    if (Object.keys(values).some(key => !['--operation', ...(operation === 'recover' ? ['--reviewed-recovery-sha256'] : [])].includes(key)) ||
      operation === 'inspect' && apply) throw new InstallError('INSTALL_ARGUMENTS_INVALID');
    result = operation === 'inspect' ? await inspectDeployment() :
      await recoverDeployment({ apply, reviewedRecoverySha256: values['--reviewed-recovery-sha256'] });
  } else {
    if (!values['--payload'] || !values['--input'] || !values['--manifest-sha256'] || values['--reviewed-recovery-sha256'] ||
      operation === 'prepare' && (apply || values['--reviewed-configuration-sha256'])) throw new InstallError('INSTALL_ARGUMENTS_INVALID');
    const options = { payload: values['--payload'], input: values['--input'], manifestSha256: values['--manifest-sha256'] };
    result = operation === 'prepare' ? await prepareUpgrade(options) : await deployRelease({ ...options,
      operation: operation as InstallOptions['operation'], reviewedConfigurationSha256: values['--reviewed-configuration-sha256'], apply });
  }
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
} catch (error) {
  // Never expose paths, child output, private settings, or secret-bearing JSON.
  process.stderr.write((error instanceof InstallError ? error.code : 'INSTALL_PREFLIGHT_OR_APPLY_FAILED') + '\n');
  process.exitCode = 1;
}
