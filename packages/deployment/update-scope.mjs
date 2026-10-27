import { createHash } from 'node:crypto';

const fail = code => { throw Object.assign(new Error(code), { code }); };
export function parseComponents(value = 'all') {
  if (!['all', 'frontend'].includes(value)) fail('BUILD_COMPONENTS_UNSUPPORTED');
  return value;
}

// Documentation/tests do not enter a bundle. Everything else outside the UI
// is conservative: an unknown build input requires a full build and update.
export function backendInputSha256(entries) {
  const inputs = entries.filter(entry => !entry.path.startsWith('integrations/metacubexd/overlay/packages/ui/')
    && !/^(docs|tests|\.github)\//u.test(entry.path) && !/\.md$/iu.test(entry.path));
  return createHash('sha256').update(JSON.stringify(inputs.map(entry => [entry.path, entry.mode, entry.oid])
    .sort((a, b) => a[0].localeCompare(b[0], 'en')))).digest('hex');
}

export function validateFrontendUpdate(value) {
  if (!value || Object.keys(value).sort().join(',') !== 'backendInputSha256,baseManifestSha256,schemaVersion'
    || value.schemaVersion !== 1 || ![value.backendInputSha256, value.baseManifestSha256].every(item => typeof item === 'string' && /^[a-f0-9]{64}$/u.test(item))) {
    fail('BUILD_FRONTEND_BASE_INVALID');
  }
  return value;
}
