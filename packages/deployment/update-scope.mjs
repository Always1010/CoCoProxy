import { createHash } from 'node:crypto';

const fail = code => { throw Object.assign(new Error(code), { code }); };
const sourceInput = entry => !/^(docs|tests|\.github)\//u.test(entry.path) && !/\.md$/iu.test(entry.path);
const identity = entries => createHash('sha256').update(JSON.stringify(entries.map(entry => [entry.path, entry.mode, entry.oid])
  .sort((a, b) => a[0].localeCompare(b[0], 'en')))).digest('hex');
export function parseComponents(value = 'all') {
  if (!['all', 'frontend', 'backend', 'core'].includes(value)) fail('BUILD_COMPONENTS_UNSUPPORTED');
  return value;
}

// Documentation/tests do not enter a bundle. Everything else outside the UI
// is conservative: an unknown build input requires a full build and update.
export function backendInputSha256(entries) {
  const inputs = entries.filter(entry => !entry.path.startsWith('integrations/metacubexd/overlay/packages/ui/')
    && sourceInput(entry));
  return identity(inputs);
}

// UI has no imports from the root apps/packages. Keep shared build tooling and
// upstream inputs in this identity so backend-only builds cannot hide UI drift.
export function reusedInputSha256(entries, components, management) {
  if (components === 'core') {
    if (!management || typeof management !== 'object' || Array.isArray(management)) fail('BUILD_COMPONENT_INPUT_INVALID');
    const metadata = Object.entries(management).sort(([a], [b]) => a.localeCompare(b, 'en'));
    const inputs = entries.filter(entry => sourceInput(entry)
      && !['integrations/metacubexd/components.json', 'integrations/metacubexd/review.json'].includes(entry.path));
    return identity([...inputs, { path: '@management-inputs', mode: 'json', oid: createHash('sha256').update(JSON.stringify(metadata)).digest('hex') }]);
  }
  if (components !== 'backend') fail('BUILD_COMPONENTS_UNSUPPORTED');
  return identity(entries.filter(entry => sourceInput(entry) && (!/^(apps|packages)\//u.test(entry.path)
    || entry.path === 'packages/deployment/update-scope.mjs')
    && !entry.path.startsWith('integrations/metacubexd/overlay/apps/server/')));
}

export function validateComponentUpdate(value) {
  if (!value || Object.keys(value).sort().join(',') !== 'baseManifestSha256,components,reusedInputSha256,schemaVersion'
    || value.schemaVersion !== 1 || !['backend', 'core'].includes(value.components)
    || ![value.reusedInputSha256, value.baseManifestSha256].every(item => typeof item === 'string' && /^[a-f0-9]{64}$/u.test(item))) fail('BUILD_COMPONENT_BASE_INVALID');
  return value;
}

export function validateFrontendUpdate(value) {
  if (!value || Object.keys(value).sort().join(',') !== 'backendInputSha256,baseManifestSha256,schemaVersion'
    || value.schemaVersion !== 1 || ![value.backendInputSha256, value.baseManifestSha256].every(item => typeof item === 'string' && /^[a-f0-9]{64}$/u.test(item))) {
    fail('BUILD_FRONTEND_BASE_INVALID');
  }
  return value;
}
