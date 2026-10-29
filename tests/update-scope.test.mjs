import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createBuildInputs, validateBuildInputs } from '../packages/deployment/update-scope.mjs';

const ui = 'integrations/metacubexd/overlay/packages/ui/pages/example.vue';
const baseline = {
  'package.json': JSON.stringify({ name: 'synthetic', version: '1.0.0', type: 'module', engines: { node: '>=22' },
    dependencies: { ws: '1.0.0' }, scripts: { 'test:overlay': 'node --test', 'dev:ui': 'node scripts/dev-ui.mjs', typecheck: 'tsc' } }),
  'package-lock.json': JSON.stringify({ version: '1.0.0', lockfileVersion: 3, packages: {
    '': { version: '1.0.0', dependencies: { ws: '1.0.0' } }, 'node_modules/ws': { version: '1.0.0', integrity: 'synthetic' } } }),
  [ui]: 'original UI',
  'apps/management/server.ts': 'original API',
  'scripts/release-layout.mjs': 'original packager',
  'scripts/dev-ui.mjs': 'original preview',
};
const hash = text => createHash('sha256').update(text).digest('hex');
async function inputs(files = baseline, modes = {}) {
  const entries = Object.entries(files).map(([path, content]) => ({ path, mode: modes[path] ?? '0644', oid: hash(content) }));
  return createBuildInputs(entries, entry => Promise.resolve(files[entry.path]));
}
const editJSON = (path, edit) => { const value = JSON.parse(baseline[path]); edit(value); return { ...baseline, [path]: JSON.stringify(value) }; };
const keys = ['backendInputSha256', 'frontendInputSha256', 'serverInputSha256'];

test('local previews, tests and root release versions do not invalidate reusable components', async () => {
  const base = await inputs();
  for (const changed of [
    { ...baseline, 'scripts/dev-ui.mjs': 'updated preview', 'tests/example.test.ts': 'test', 'docs/example.md': 'docs' },
    editJSON('package.json', pkg => { pkg.version = '1.0.1'; pkg.scripts['test:overlay'] += ' extra.test.ts'; pkg.scripts['test:new'] = 'node --test'; }),
    editJSON('package-lock.json', lock => { lock.version = '1.0.1'; lock.packages[''].version = '1.0.1'; }),
  ]) {
    const next = await inputs(changed);
    for (const key of keys) assert.equal(next[key], base[key], key);
    assert.notDeepEqual(next.inputs, base.inputs, 'the manifest still records harmless changes for diagnosis');
  }
  assert.ok(!JSON.stringify(base.inputs).includes('original API'));
});

test('component isolation retains real dependencies, build tooling, permissions, deletions and unknown inputs', async () => {
  const base = await inputs();
  const frontend = await inputs({ ...baseline, [ui]: 'updated UI' });
  assert.equal(frontend.backendInputSha256, base.backendInputSha256);
  assert.notEqual(frontend.frontendInputSha256, base.frontendInputSha256);
  const backend = await inputs({ ...baseline, 'apps/management/server.ts': 'updated API' });
  assert.notEqual(backend.backendInputSha256, base.backendInputSha256);
  assert.equal(backend.frontendInputSha256, base.frontendInputSha256);
  const deleted = { ...baseline }; delete deleted['apps/management/server.ts'];
  assert.notEqual((await inputs(deleted)).backendInputSha256, base.backendInputSha256);
  for (const changed of [
    editJSON('package.json', pkg => { pkg.dependencies.ws = '2.0.0'; }),
    editJSON('package.json', pkg => { pkg.engines.node = '>=24'; }),
    editJSON('package.json', pkg => { pkg.scripts.typecheck = 'other compiler'; }),
    editJSON('package.json', pkg => { pkg.scripts['new-command'] = 'unknown'; }),
    editJSON('package-lock.json', lock => { lock.packages['node_modules/ws'].integrity = 'changed'; }),
    { ...baseline, 'scripts/release-layout.mjs': 'updated packager' },
    { ...baseline, 'unknown-input.json': '{}' },
  ]) {
    const next = await inputs(changed);
    for (const key of keys) assert.notEqual(next[key], base[key], key);
  }
  const permissions = await inputs(baseline, { 'scripts/release-layout.mjs': '0755' });
  for (const key of keys) assert.notEqual(permissions[key], base[key], key);
  assert.throws(() => validateBuildInputs({ ...base, backendInputSha256: '0'.repeat(64) }), { code: 'BUILD_COMPONENT_INPUT_INVALID' });
  await assert.rejects(inputs({ ...baseline, '.local/private.json': '{}' }), { code: 'BUILD_COMPONENT_INPUT_INVALID' });
});
