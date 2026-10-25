import { deployRelease, InstallError, type InstallOptions } from '../../packages/deployment/install.ts';

try {
  const args = process.argv.slice(2), values: Record<string, string> = {};
  let apply = false;
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (key === '--apply' && !apply) { apply = true; continue; }
    if (!['--payload', '--input', '--manifest-sha256', '--operation', '--reviewed-configuration-sha256'].includes(key) || values[key] ||
      !args[index + 1] || args[index + 1].startsWith('--')) throw new InstallError('INSTALL_ARGUMENTS_INVALID');
    values[key] = args[++index];
  }
  if (!values['--payload'] || !values['--input'] || !values['--manifest-sha256']) throw new InstallError('INSTALL_ARGUMENTS_INVALID');
  const result = await deployRelease({ payload: values['--payload'], input: values['--input'],
    manifestSha256: values['--manifest-sha256'], operation: (values['--operation'] ?? 'install') as InstallOptions['operation'],
    reviewedConfigurationSha256: values['--reviewed-configuration-sha256'], apply });
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
} catch (error) {
  // Never expose paths, child output, private settings, or secret-bearing JSON.
  process.stderr.write((error instanceof InstallError ? error.code : 'INSTALL_PREFLIGHT_OR_APPLY_FAILED') + '\n');
  process.exitCode = 1;
}
