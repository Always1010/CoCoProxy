import { createHash } from 'node:crypto';

const fail = code => { throw Object.assign(new Error(code), { code }); };
const sourceInput = entry => !/^(docs|tests|\.github)\//u.test(entry.path) && !/\.md$/iu.test(entry.path);
export function parseComponents(value = 'all') {
  if (!['all', 'frontend', 'backend', 'management', 'core'].includes(value)) fail('BUILD_COMPONENTS_UNSUPPORTED');
  return value;
}

export const INPUT_SCHEMA_VERSION = 2;
const ui = 'integrations/metacubexd/overlay/packages/ui/';
const catalogs = ['integrations/metacubexd/components.json', 'integrations/metacubexd/review.json'];
const previewFiles = new Set(['scripts/dev-ui.mjs', 'scripts/ui-preview/server.mjs', 'scripts/ui-preview/fixtures.mjs', 'scripts/ui-preview/PreviewPanel.vue']);
const canonicalJSON = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const sha = value => createHash('sha256').update(value).digest('hex');
const inputKey = entry => `${entry.path}\0${entry.field ?? ''}`;
const active = entry => !['ignored', 'metadata'].includes(entry.scope);
function inputIdentity(entries) {
  return sha(JSON.stringify([...entries].sort((a, b) => inputKey(a).localeCompare(inputKey(b), 'en'))
    .map(entry => [entry.path, entry.field ?? '', entry.mode, entry.oid])));
}
function inputDigests(inputs) {
  return {
    backendInputSha256: inputIdentity(inputs.filter(entry => active(entry) && entry.scope !== 'frontend')),
    frontendInputSha256: inputIdentity(inputs.filter(entry => active(entry) && entry.scope !== 'backend')),
    serverInputSha256: inputIdentity(inputs.filter(entry => active(entry) && (!catalogs.includes(entry.path) || entry.field === '/management'))),
  };
}
function inputScope(path) {
  if (!sourceInput({ path }) || previewFiles.has(path)) return 'ignored';
  if (path.startsWith(ui)) return 'frontend';
  if ((/^(apps|packages)\//u.test(path) && !path.startsWith('packages/deployment/'))
    || path.startsWith('integrations/metacubexd/overlay/apps/server/')) return 'backend';
  return 'shared';
}
const pointer = key => key.replaceAll('~', '~0').replaceAll('/', '~1');

/** Read committed blobs, never working-tree metadata. Only explicit harmless fields are excluded. */
export async function createBuildInputs(entries, readBlob) {
  const inputs = [];
  const readJSON = async entry => JSON.parse(Buffer.from(await readBlob(entry)).toString('utf8'));
  const field = (entry, name, value, scope = 'shared') => inputs.push({ path: entry.path, field: name,
    mode: entry.mode, oid: sha(canonicalJSON(value)), scope });
  for (const entry of entries) {
    if (entry.path === 'package.json') {
      const pkg = await readJSON(entry);
      for (const [key, value] of Object.entries(pkg)) {
        if (key === 'scripts' && value && typeof value === 'object' && !Array.isArray(value)) {
          // Keep an empty marker: adding/removing the scripts object is still a build-input change.
          field(entry, '/scripts', {});
          for (const [name, command] of Object.entries(value)) field(entry, `/scripts/${pointer(name)}`, command,
            name === 'test' || name.startsWith('test:') || name === 'dev:ui' ? 'ignored' : 'shared');
        } else field(entry, `/${pointer(key)}`, value, key === 'version' ? 'metadata' : 'shared');
      }
    } else if (entry.path === 'package-lock.json') {
      const lock = await readJSON(entry);
      if (Object.hasOwn(lock, 'version')) { field(entry, '/version', lock.version, 'metadata'); delete lock.version; }
      const root = lock.packages?.[''];
      if (root && Object.hasOwn(root, 'version')) { field(entry, '/packages//version', root.version, 'metadata'); delete root.version; }
      field(entry, '', lock);
    } else {
      inputs.push({ ...entry, scope: inputScope(entry.path) });
      if (entry.path === catalogs[0]) {
        const management = (await readJSON(entry)).management;
        if (!management || typeof management !== 'object' || Array.isArray(management)) fail('BUILD_COMPONENT_INPUT_INVALID');
        field(entry, '/management', management);
      }
    }
  }
  inputs.sort((a, b) => inputKey(a).localeCompare(inputKey(b), 'en'));
  const result = { schemaVersion: INPUT_SCHEMA_VERSION, ...inputDigests(inputs), inputs };
  return validateBuildInputs(result);
}

export function validateBuildInputs(value) {
  if (value?.schemaVersion !== INPUT_SCHEMA_VERSION || !Array.isArray(value.inputs) || value.inputs.length > 24000) fail('BUILD_COMPONENT_INPUT_INVALID');
  const keys = new Set();
  for (const entry of value.inputs) {
    if (!entry || typeof entry.path !== 'string' || !entry.path || /[\\\x00-\x1f\x7f:]/u.test(entry.path)
      || entry.path.split('/').some(part => !part || ['.', '..', '.git', '.local', 'node_modules'].includes(part))
      || (entry.field !== undefined && (typeof entry.field !== 'string' || /[\x00-\x1f\x7f]/u.test(entry.field)))
      || !['0644', '0755'].includes(entry.mode) || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(entry.oid)
      || !['frontend', 'backend', 'shared', 'ignored', 'metadata'].includes(entry.scope) || keys.has(inputKey(entry))) fail('BUILD_COMPONENT_INPUT_INVALID');
    keys.add(inputKey(entry));
  }
  for (const [key, digest] of Object.entries(inputDigests(value.inputs))) if (value[key] !== digest) fail('BUILD_COMPONENT_INPUT_INVALID');
  return value;
}

export function validateComponentUpdate(value) {
  if (!value || Object.keys(value).sort().join(',') !== 'baseManifestSha256,components,reusedInputSha256,schemaVersion'
    || ![1, 2].includes(value.schemaVersion) || !['backend', 'management', 'core'].includes(value.components)
    || ![value.reusedInputSha256, value.baseManifestSha256].every(item => typeof item === 'string' && /^[a-f0-9]{64}$/u.test(item))) fail('BUILD_COMPONENT_BASE_INVALID');
  return value;
}

export function validateFrontendUpdate(value) {
  if (!value || Object.keys(value).sort().join(',') !== 'backendInputSha256,baseManifestSha256,schemaVersion'
    || ![1, 2].includes(value.schemaVersion) || ![value.backendInputSha256, value.baseManifestSha256].every(item => typeof item === 'string' && /^[a-f0-9]{64}$/u.test(item))) {
    fail('BUILD_FRONTEND_BASE_INVALID');
  }
  return value;
}
