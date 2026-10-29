type File = { path: string; sha256: string; size: number; mode: string };
type Release = { files: File[]; coreSHA: string; compatibility?: unknown;
  buildInputs?: { schemaVersion: number; inputs: { path: string; oid: string; mode: string; field?: string }[] } };

// Default deny: new runtime dependencies and unknown payload paths require
// maintenance. Management entry/recovery and automatic writers stay pinned too.
function managementOnly(path: string): boolean {
  if (path.startsWith('server/.output/')) return true;
  if (path.startsWith('source/packages/management/')) {
    return !/\/(?:startup|service|workspace-application|automatic-[^/]+|bandwidth-selector|bandwidth-policy)\.ts$/u.test(path);
  }
  return path === 'README.md' || path === 'cocoproxy' ||
    path.startsWith('source/packages/deployment/') || path.startsWith('source/apps/deployment/') ||
    ['source/scripts/cocoproxy-setup.sh', 'source/scripts/deploy-ssh.mjs', 'source/scripts/remote-deploy.py',
      'source/scripts/router-ssh-hook.py'].includes(path);
}

/** Both manifests have already passed full byte verification. No filenames or
 * private state values are needed in the public decision. */
export function assessRuntimePreservation(previous: Release, next: Release) {
  const result = (eligible: boolean, code: string) => ({ eligible, code });
  if (previous.coreSHA !== next.coreSHA) return result(false, 'RUNTIME_CORE_CHANGED');
  if (!previous.compatibility || !next.compatibility ||
      JSON.stringify(previous.compatibility) !== JSON.stringify(next.compatibility)) {
    return result(false, 'RUNTIME_STATE_CONTRACT_CHANGED');
  }
  // These boot inputs are compiled into opaque server output. File manifests
  // alone cannot prove that a new management process leaves core startup alone.
  const bootInputs = (release: Release) => release.buildInputs?.schemaVersion === 2
    ? release.buildInputs.inputs.filter(entry => /^integrations\/metacubexd\/overlay\/apps\/server\/(?:plugins\/|lib\/|nitro\.config\.ts$)/u.test(entry.path))
      .map(entry => [entry.path, entry.field ?? '', entry.mode, entry.oid]).sort((a, b) => a[0].localeCompare(b[0], 'en')) : [];
  const previousBoot = bootInputs(previous), nextBoot = bootInputs(next);
  if (!previousBoot.some(entry => entry[0].endsWith('/plugins/boot-kernel.ts')) ||
      JSON.stringify(previousBoot) !== JSON.stringify(nextBoot)) return result(false, 'RUNTIME_BOOT_INPUTS_CHANGED_OR_MISSING');
  const pinned = (release: Release) => release.files.filter(file => !managementOnly(file.path))
    .map(file => [file.path, file.sha256, file.size, file.mode]).sort((a, b) => String(a[0]).localeCompare(String(b[0]), 'en'));
  const required = ['bin/mihomo', 'source/apps/runtime/launch-core.ts', 'source/packages/runtime/settings.ts',
    'source/packages/runtime/systemd.ts', 'source/packages/transaction/index.ts'];
  if (!required.every(path => previous.files.some(file => file.path === path) && next.files.some(file => file.path === path))) {
    return result(false, 'RUNTIME_EVIDENCE_INCOMPLETE');
  }
  return JSON.stringify(pinned(previous)) === JSON.stringify(pinned(next))
    ? result(true, 'RUNTIME_FILES_AND_CONTRACT_UNCHANGED') : result(false, 'RUNTIME_PROTECTED_FILES_CHANGED');
}
