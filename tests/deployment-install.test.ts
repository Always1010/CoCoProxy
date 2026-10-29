import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { link, mkdtemp, mkdir, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { assertMaintenanceLifecycle, assertReviewedUpgradeConfiguration, compatibleOwnedFiles, configurationReviewDigest, deployRelease,
  parseDeploymentLock, prepareUpgrade, stageUpgrade, preparedReleaseIdentity, assertPreparedReleaseIdentity, releaseTarget, validateReceipt, verifyRelease, assertFrontendFiles, assertComponentReuse, type Receipt } from '../packages/deployment/install.ts';
import { assertDeploymentStateCompatibility } from '../packages/deployment/install.ts';
import { inspectStateCompatibility, type UpgradeStateHost } from '../packages/deployment/upgrade-assessment.ts';
import { DEPLOYMENT_STATE_COMPATIBILITY } from '../packages/deployment/compatibility.ts';
import { assessRecoveryCredential, assertFinalizableReceipt, deploymentOwnerGone, inspectDeployment, recoverDeployment } from '../packages/deployment/maintenance.ts';
import { renderDeploymentPlan } from '../packages/deployment/plan.ts';
import { assessRuntimePreservation } from '../packages/deployment/runtime-preservation.ts';

const digest = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const code = (expected: string) => (error: any) => error.code === expected;

test('prepared releases bind the previous installation, target, exact input and runtime preservation mode', () => {
  const identity = preparedReleaseIdentity('a'.repeat(64), 'b'.repeat(64), Buffer.from('input'), true);
  assert.doesNotThrow(() => assertPreparedReleaseIdentity(structuredClone(identity), identity));
  for (const changed of [preparedReleaseIdentity('c'.repeat(64), 'b'.repeat(64), Buffer.from('input'), true),
    preparedReleaseIdentity('a'.repeat(64), 'c'.repeat(64), Buffer.from('input'), true),
    preparedReleaseIdentity('a'.repeat(64), 'b'.repeat(64), Buffer.from('changed input'), true),
    preparedReleaseIdentity('a'.repeat(64), 'b'.repeat(64), Buffer.from('input'), false), null, { ...identity, foreign: true }]) {
    assert.throws(() => assertPreparedReleaseIdentity(changed, identity), code('INSTALL_PREPARED_RELEASE_CHANGED'));
  }
});

test('runtime preservation permits management changes but rejects boot, runtime, dependency and state contract changes', () => {
  const paths = ['bin/mihomo', 'source/apps/runtime/launch-core.ts', 'source/packages/runtime/settings.ts',
    'source/packages/runtime/systemd.ts', 'source/packages/transaction/index.ts', 'source/packages/management/http.ts',
    'source/packages/management/startup.ts', 'source/node_modules/yaml/package.json', 'server/.output/server/index.mjs'];
  const base = { files: paths.map(path => ({ path, sha256: digest(path), size: 10, mode: '0644' })), coreSHA: digest('core'),
    compatibility: { schemaVersion: 1 }, buildInputs: { schemaVersion: 2, inputs: [{
      path: 'integrations/metacubexd/overlay/apps/server/plugins/boot-kernel.ts', oid: digest('boot'), mode: '0644' }] } };
  const next = structuredClone(base);
  for (const file of next.files.filter(file => file.path.endsWith('/http.ts') || file.path.startsWith('server/'))) file.sha256 = digest('new manager');
  assert.equal(assessRuntimePreservation(base, next).eligible, true);
  for (const path of paths.filter(path => !path.endsWith('/http.ts') && !path.startsWith('server/'))) {
    const changed = structuredClone(next); changed.files.find(file => file.path === path)!.sha256 = digest('changed');
    assert.equal(assessRuntimePreservation(base, changed).eligible, false, path);
  }
  assert.equal(assessRuntimePreservation(base, { ...next, compatibility: { schemaVersion: 2 } }).eligible, false);
  assert.equal(assessRuntimePreservation(base, { ...next, buildInputs: undefined }).eligible, false);
  const changedBoot = structuredClone(next); changedBoot.buildInputs.inputs[0].oid = digest('changed boot');
  assert.equal(assessRuntimePreservation(base, changedBoot).eligible, false);
  const unknown = structuredClone(next); unknown.files.push({ path: 'source/unknown-runtime.ts', sha256: digest('unknown'), size: 1, mode: '0644' });
  assert.equal(assessRuntimePreservation(base, unknown).eligible, false);
});

test('backend updates bind the installed base and preserve all UI files and the reviewed core', () => {
  const file = { path: 'server/.output/public/index.html', size: 2, mode: '0644', sha256: digest('UI') };
  const previous = { files: [file], coreSHA: digest('core'), frontendInputSha256: digest('inputs') };
  const next = { ...previous, componentUpdate: { schemaVersion: 1 as const, components: 'backend' as const, baseManifestSha256: digest('base'), reusedInputSha256: digest('inputs') } };
  assert.doesNotThrow(() => assertComponentReuse(previous, next, digest('base')));
  const version2 = { ...next, inputSchemaVersion: 2, componentUpdate: { ...next.componentUpdate, schemaVersion: 2 as const } };
  assert.throws(() => assertComponentReuse(previous, version2, digest('base')), code('INSTALL_COMPONENT_BASE_CHANGED'));
  assert.doesNotThrow(() => assertComponentReuse({ ...previous, inputSchemaVersion: 2 }, version2, digest('base')));
  assert.throws(() => assertComponentReuse(previous, next, digest('other base')), code('INSTALL_COMPONENT_BASE_CHANGED'));
  assert.throws(() => assertComponentReuse(previous, { ...next, files: [{ ...file, sha256: digest('changed UI') }] }, digest('base')), code('INSTALL_REUSED_PAYLOAD_CHANGED'));
  assert.throws(() => assertComponentReuse(previous, { ...next, coreSHA: digest('changed core') }, digest('base')), code('INSTALL_REUSED_PAYLOAD_CHANGED'));
});

test('core updates permit a new reviewed binary only with unchanged complete server output', () => {
  const files = ['server/.output/public/index.html', 'server/.output/server/index.mjs'].map(path => ({ path, size: 2, mode: '0644', sha256: digest(path) }));
  const previous = { files, coreSHA: digest('core'), serverInputSha256: digest('inputs') };
  const next = { ...previous, coreSHA: digest('new core'), componentUpdate: { schemaVersion: 1 as const, components: 'core' as const, baseManifestSha256: digest('base'), reusedInputSha256: digest('inputs') } };
  assert.doesNotThrow(() => assertComponentReuse(previous, next, digest('base')));
  assert.throws(() => assertComponentReuse(previous, { ...next, files: files.map(file => ({ ...file, sha256: digest('changed server') })) }, digest('base')), code('INSTALL_REUSED_PAYLOAD_CHANGED'));
});

test('management updates allow frontend and backend changes but bind the installed core bytes and base', () => {
  const core = { path: 'bin/mihomo', size: 4, mode: '0755', sha256: digest('core') };
  const ui = { path: 'server/.output/public/index.html', size: 2, mode: '0644', sha256: digest('UI') };
  const server = { ...ui, path: 'server/.output/server/index.mjs', sha256: digest('server') };
  const previous = { files: [core, ui, server], coreSHA: core.sha256 };
  const next = { ...previous, files: [core, { ...ui, sha256: digest('new UI') }, { ...server, sha256: digest('new server') }],
    componentUpdate: { schemaVersion: 1 as const, components: 'management' as const, baseManifestSha256: digest('base'), reusedInputSha256: core.sha256 } };
  assert.doesNotThrow(() => assertComponentReuse(previous, next, digest('base')));
  assert.throws(() => assertComponentReuse(previous, next, digest('other base')), code('INSTALL_COMPONENT_BASE_CHANGED'));
  assert.throws(() => assertComponentReuse(previous, { ...next, coreSHA: digest('new core') }, digest('base')), code('INSTALL_REUSED_PAYLOAD_CHANGED'));
  assert.throws(() => assertComponentReuse(previous, { ...next, files: next.files.map(file => file.path === 'bin/mihomo' ? { ...file, mode: '0644' } : file) }, digest('base')), code('INSTALL_REUSED_PAYLOAD_CHANGED'));
});

test('frontend updates allow only the manager unit to change while preserving runtime paths and owned settings', () => {
  const previous = ['/etc/systemd/system/cocoproxy-management.service', '/etc/systemd/system/cocoproxy-mihomo.service', '/etc/sample/runtime.json']
    .map(path => ({ path, mode: '0644', owner: 'root' as const, sensitive: false, sha256: digest(path) }));
  const next = previous.map(file => file.path.endsWith('management.service') ? { ...file, sha256: digest('new manager') } : file);
  assert.doesNotThrow(() => assertFrontendFiles(previous, next));
  assert.throws(() => assertFrontendFiles(previous, next.map(file => file.path.endsWith('mihomo.service') ? { ...file, sha256: digest('changed core') } : file)), code('INSTALL_FRONTEND_SCOPE_CHANGED'));
  const parent = '/opt/sample/releases/'; const runtime = parent + 'a'.repeat(64); const manager = parent + 'b'.repeat(64);
  assert.equal(releaseTarget({ runtime: { sourceDirectory: runtime + '/source', binaryPath: runtime + '/bin/mihomo' }, management: { serverEntry: manager + '/server/.output/server/index.mjs' } }, 'b'.repeat(64)), manager);
});

test('maintenance refuses enabled automatic recovery until it has been explicitly paused', () => {
  assertMaintenanceLifecycle({ schemaVersion: 1, enabled: true, paused: true });
  assertMaintenanceLifecycle({ schemaVersion: 1, enabled: false, paused: false });
  assert.throws(() => assertMaintenanceLifecycle({ schemaVersion: 1, enabled: true, paused: false }), code('INSTALL_LIFECYCLE_MUST_BE_PAUSED'));
  for (const value of [null, {}, { schemaVersion: 1, enabled: false }, { schemaVersion: 1, enabled: 'false', paused: true }]) {
    assert.throws(() => assertMaintenanceLifecycle(value), code('INSTALL_LIFECYCLE_INVALID'));
  }
});

test('upgrade apply refuses invalid complete content, unknown readers and missing observations with different fixed errors', async () => {
  const valid = JSON.stringify({ version: 1, desired: null, active: null, pending: null, fault: null, checkedAt: null });
  let bytes = valid;
  const host: UpgradeStateHost = { read: async path => path === 'state.json' ? bytes : null, list: async () => [] };
  const complete = await inspectStateCompatibility(host, DEPLOYMENT_STATE_COMPATIBILITY);
  assert.doesNotThrow(() => assertDeploymentStateCompatibility(complete.findings));
  bytes = '{"version":1}';
  const damaged = await inspectStateCompatibility(host, DEPLOYMENT_STATE_COMPATIBILITY);
  assert.equal(damaged.findings[0].status, 'supported-version');
  assert.throws(() => assertDeploymentStateCompatibility(damaged.findings), code('INSTALL_STATE_CONTENT_UNSUPPORTED'));
  bytes = 'PRIVATE INVALID JSON';
  const malformed = await inspectStateCompatibility(host, DEPLOYMENT_STATE_COMPATIBILITY);
  assert.throws(() => assertDeploymentStateCompatibility(malformed.findings), code('INSTALL_STATE_CONTENT_UNSUPPORTED'));
  bytes = '{"version":2}';
  const future = await inspectStateCompatibility(host, DEPLOYMENT_STATE_COMPATIBILITY);
  assert.throws(() => assertDeploymentStateCompatibility(future.findings), code('INSTALL_STATE_SCHEMA_UNSUPPORTED'));
  bytes = valid;
  const legacy = await inspectStateCompatibility(host, { schemaVersion: 1, stateSchemas: DEPLOYMENT_STATE_COMPATIBILITY.stateSchemas });
  assert.throws(() => assertDeploymentStateCompatibility(legacy.findings), code('INSTALL_STATE_COMPATIBILITY_NOT_DECLARED'));
  const unavailable = await inspectStateCompatibility({ ...host, read: async () => { throw new Error('PRIVATE EACCES'); } }, DEPLOYMENT_STATE_COMPATIBILITY);
  assert.throws(() => assertDeploymentStateCompatibility(unavailable.findings), code('INSTALL_STATE_INSPECTION_UNAVAILABLE'));
  assert.doesNotMatch(JSON.stringify(unavailable.findings), /PRIVATE|EACCES/);
});

test('upgrade adds only the early guard to a verified previous seven-file gateway receipt', async () => {
  const input = JSON.parse(await readFile(new URL('../examples/automatic-gateway-deployment.json', import.meta.url), 'utf8'));
  const current = renderDeploymentPlan(input).files.map(({ content, ...file }) => ({ ...file, sha256: digest(content) }));
  const previous = current.filter(file => !file.path.endsWith('/cocoproxy-gateway-guard.service'));
  assert.equal(previous.length, 7);
  assert.equal(compatibleOwnedFiles(previous, current, true), true);
  assert.equal(compatibleOwnedFiles(previous, current, false), false);
  assert.equal(compatibleOwnedFiles(current, previous, true), false);
  const foreign = current.map(file => file.path.endsWith('/cocoproxy-gateway-guard.service') ? { ...file, path: '/etc/systemd/system/foreign.service' } : file);
  assert.equal(compatibleOwnedFiles(previous, foreign, true), false);
  assert.equal(compatibleOwnedFiles(previous.slice(1), current, true), false);
  const managedWeb = [...current, ...['/etc/cocoproxy/web/nginx.conf', '/etc/systemd/system/cocoproxy-web.service']
    .map(path => ({ path, owner: 'root' as const, mode: '0644' as const, sensitive: false, sha256: digest('synthetic web') }))];
  assert.equal(compatibleOwnedFiles(current, managedWeb, true), true);
  assert.equal(compatibleOwnedFiles(current, managedWeb, false), false);
  assert.equal(compatibleOwnedFiles(previous, managedWeb, true), false);
  assert.equal(compatibleOwnedFiles(current, managedWeb.map(file => file.path.endsWith('nginx.conf') ? { ...file, owner: 12345 } : file), true), false);
  assert.equal(compatibleOwnedFiles(managedWeb, current, true), false);
});
async function fixture(t: any) {
  const root = await mkdtemp(join(tmpdir(), 'cocoproxy-install-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = [];
  for (const path of ['bin/mihomo', 'source/apps/runtime/launch-core.ts', 'server/.output/server/index.mjs']) {
    await mkdir(join(root, path, '..'), { recursive: true });
    const bytes = Buffer.from('synthetic:' + path);
    await writeFile(join(root, path), bytes);
    files.push({ path, size: bytes.length, sha256: digest(bytes), mode: path === 'bin/mihomo' ? '0755' : '0644' });
  }
  const manifest: any = { schemaVersion: 1, scope: 'local-explicit-proxy-payload',
    components: { mihomo: { binarySha256: files[0].sha256 } }, files };
  async function save() {
    const bytes = JSON.stringify(manifest);
    await writeFile(join(root, 'manifest.json'), bytes);
    return digest(bytes);
  }
  return { root, manifest, save, hash: await save() };
}

test('read-only artifact verification binds every file and rejects tampering and extra local data', async t => {
  const f = await fixture(t), before = await readFile(join(f.root, 'manifest.json'));
  assert.equal((await verifyRelease(f.root, f.hash)).files.length, 3);
  assert.deepEqual(await readFile(join(f.root, 'manifest.json')), before);
  await assert.rejects(verifyRelease(f.root, '0'.repeat(64)), code('INSTALL_MANIFEST_HASH_MISMATCH'));
  await writeFile(join(f.root, 'bin/mihomo'), 'changed');
  await assert.rejects(verifyRelease(f.root, f.hash), code('INSTALL_PAYLOAD_HASH_MISMATCH'));
  await writeFile(join(f.root, 'bin/mihomo'), 'synthetic:bin/mihomo');
  await mkdir(join(f.root, '.local'));
  await assert.rejects(verifyRelease(f.root, f.hash), code('INSTALL_PAYLOAD_UNLISTED'));
});

test('manifest traversal, duplicate casing, unlisted objects and linked payloads are rejected', async t => {
  const f = await fixture(t), original = structuredClone(f.manifest);
  for (const path of ['../escape', 'source/../../escape', 'source/.local/private.json', '/etc/passwd', 'source/a\\b']) {
    f.manifest.files[0].path = path;
    await assert.rejects(verifyRelease(f.root, await f.save()), code('INSTALL_MANIFEST_PATH_INVALID'));
  }
  f.manifest.files = structuredClone(original.files);
  f.manifest.files.push({ ...f.manifest.files[1], path: 'source/APPS/runtime/launch-core.ts' });
  await assert.rejects(verifyRelease(f.root, await f.save()), code('INSTALL_MANIFEST_INVALID'));
  f.manifest.files = structuredClone(original.files);
  await f.save();
  if (process.platform !== 'win32') {
    await symlink('mihomo', join(f.root, 'bin/alias'));
    await assert.rejects(verifyRelease(f.root, await f.save()), code('INSTALL_PAYLOAD_LINK'));
    await unlink(join(f.root, 'bin/alias'));
  }
  await link(join(f.root, 'bin/mihomo'), join(f.root, 'bin/alias'));
  await assert.rejects(verifyRelease(f.root, await f.save()), code('INSTALL_PAYLOAD_UNLISTED'));
});

test('deployment target is explicit, versioned by manifest, and cannot replace shared directories', async () => {
  const input = JSON.parse(await readFile(new URL('../examples/deployment-plan.json', import.meta.url), 'utf8'));
  const hash = 'a'.repeat(64), target = '/opt/cocoproxy/releases/' + hash;
  input.runtime.sourceDirectory = target + '/source';
  input.runtime.binaryPath = target + '/bin/mihomo';
  input.management.serverEntry = target + '/server/.output/server/index.mjs';
  assert.equal(releaseTarget(input, hash), target);
  assert.equal(renderDeploymentPlan(input).files.length, 5);
  input.runtime.sourceDirectory = '/opt/source';
  assert.throws(() => releaseTarget(input, hash), code('INSTALL_RELEASE_LAYOUT_REQUIRED'));
  input.runtime.sourceDirectory = '/opt/cocoproxy/releases/' + hash + '/source';
  input.management.serverEntry = '/usr/bin/unrelated';
  assert.throws(() => releaseTarget(input, hash), code('INSTALL_RELEASE_LAYOUT_REQUIRED'));
});

test('unsupported host never creates installation storage even when apply is requested', { skip: process.platform === 'linux' }, async () => {
  await assert.rejects(stageUpgrade({ payload: '/missing', input: '/missing', manifestSha256: '0'.repeat(64) }), code('INSTALL_LINUX_ROOT_REQUIRED'));
  await assert.rejects(deployRelease({ payload: '/missing', input: '/missing', manifestSha256: '0'.repeat(64),
    operation: 'install', apply: true }), code('INSTALL_LINUX_ROOT_REQUIRED'));
  await assert.rejects(prepareUpgrade({ payload: '/missing', input: '/missing', manifestSha256: '0'.repeat(64) }), code('INSTALL_LINUX_ROOT_REQUIRED'));
  await assert.rejects(inspectDeployment(), code('INSTALL_LINUX_ROOT_REQUIRED'));
  await assert.rejects(recoverDeployment({ apply: true }), code('INSTALL_LINUX_ROOT_REQUIRED'));
});


test('configuration migration requires an explicit review bound to both manifests, old owned settings and exact new input bytes', () => {
  const review = { previousManifestSha256: 'a'.repeat(64), manifestSha256: 'b'.repeat(64), inputSha256: digest('synthetic new input'),
    previousConfiguration: [{ path: '/etc/cocoproxy/runtime.json', sha256: 'c'.repeat(64) },
      { path: '/etc/cocoproxy/management.json', sha256: 'd'.repeat(64) }] };
  assert.throws(() => assertReviewedUpgradeConfiguration(review, undefined, false), code('INSTALL_CONFIGURATION_CHANGE_REQUIRES_REVIEW'));
  assert.equal(assertReviewedUpgradeConfiguration(review, undefined, true), false);
  const approved = configurationReviewDigest(review);
  assert.equal(configurationReviewDigest({ ...review, previousConfiguration: [...review.previousConfiguration].reverse() }), approved);
  assert.equal(assertReviewedUpgradeConfiguration(review, approved, false), true);
  for (const changed of [{ ...review, inputSha256: digest('different new input') },
    { ...review, previousManifestSha256: 'e'.repeat(64) }, { ...review, manifestSha256: 'f'.repeat(64) },
    { ...review, previousConfiguration: [{ ...review.previousConfiguration[0], sha256: 'e'.repeat(64) }, review.previousConfiguration[1]] }]) {
    assert.throws(() => assertReviewedUpgradeConfiguration(changed, approved, false), code('INSTALL_CONFIGURATION_REVIEW_MISMATCH'));
  }
  assert.throws(() => assertReviewedUpgradeConfiguration(review, 'invalid', true), code('INSTALL_CONFIGURATION_REVIEW_MISMATCH'));
});

test('recovery refuses ambiguous legacy intent, uninstall, mismatched receipt and live owner identity', () => {
  const id = '12345678-1234-1234-1234-123456789abc';
  const lock = parseDeploymentLock({ schemaVersion: 1, id, pid: 12345, bootId: 'abcdef12-1234-1234-1234-123456789abc', startTime: '1234' });
  const hash = 'a'.repeat(64);
  const receipt: Receipt = { schemaVersion: 1, status: 'pending', release: '/opt/cocoproxy/releases/' + hash,
    manifestSha256: hash, files: [{ path: '/etc/cocoproxy/runtime.json', owner: 12345, mode: '0600', sensitive: true, sha256: hash }],
    serviceUid: 12345, stateDirectory: '/var/lib/cocoproxy', credentialPath: '/etc/cocoproxy/admin.json', transaction: { id, operation: 'upgrade' } };
  assert.deepEqual(validateReceipt(receipt), receipt);
  assertFinalizableReceipt(receipt, lock);
  for (const changed of [{ ...receipt, transaction: undefined }, { ...receipt, transaction: { id, operation: 'uninstall' as const } },
    { ...receipt, transaction: { id: '00000000-1234-1234-1234-123456789abc', operation: 'upgrade' as const } },
    { ...receipt, status: 'uninstalled' as const }]) {
    assert.throws(() => assertFinalizableReceipt(changed, lock), code('INSTALL_RECOVERY_NOT_FINALIZABLE'));
  }
  assert.throws(() => parseDeploymentLock(12345), code('INSTALL_LOCK_LEGACY_OR_INVALID'));
  assert.throws(() => parseDeploymentLock({ ...lock, startTime: null }), code('INSTALL_LOCK_LEGACY_OR_INVALID'));
  assert.equal(deploymentOwnerGone(lock, { bootId: lock.bootId, startTime: lock.startTime }), false);
  assert.equal(deploymentOwnerGone(lock, { bootId: lock.bootId, startTime: null }), true);
  assert.equal(deploymentOwnerGone(lock, { bootId: lock.bootId, startTime: '9999' }), true);
  assert.equal(deploymentOwnerGone(lock, { bootId: '00000000-1234-1234-1234-123456789abc', startTime: lock.startTime }), true);
  for (const changed of [{ ...receipt, files: [receipt.files[0], receipt.files[0]] },
    { ...receipt, files: [{ ...receipt.files[0], owner: 99999 }] },
    { ...receipt, files: [{ ...receipt.files[0], path: '/etc/../escape' }] },
    { ...receipt, files: [{ ...receipt.files[0], mode: '0666' }] }]) {
    assert.throws(() => validateReceipt(changed));
  }
});

test('maintenance CLI rejects apply on read-only operations and unrelated recovery inputs without disclosing them', () => {
  for (const args of [['--operation', 'inspect', '--apply'], ['--operation', 'prepare', '--apply'],
    ['--operation', 'recover', '--input', '/synthetic-private-input']]) {
    const result = spawnSync(process.execPath, ['--no-warnings', '--experimental-strip-types', 'apps/deployment/main.ts', ...args],
      { cwd: new URL('..', import.meta.url), encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr.trim(), 'INSTALL_ARGUMENTS_INVALID');
  }
});

test('recovery permits an uninitialized first install but never bypasses existing credential trust checks', async () => {
  const receipt: Receipt = { schemaVersion: 1, status: 'pending', release: '/opt/cocoproxy/releases/' + 'a'.repeat(64),
    manifestSha256: 'a'.repeat(64), files: [], serviceUid: 12345, stateDirectory: '/var/lib/cocoproxy',
    credentialPath: '/etc/cocoproxy/admin.json', transaction: { id: '12345678-1234-1234-1234-123456789abc', operation: 'install' } };
  let present = false, trustError = '', parentError = '', bytes = 'synthetic credential';
  const checked: string[] = [];
  const host = {
    info: async (path: string) => { assert.equal(path, receipt.credentialPath); return present ? {} as any : null; },
    rootPath: async (path: string) => { checked.push('parent'); assert.equal(path, '/etc/cocoproxy'); if (parentError) throw { code: parentError }; },
    privateFile: async (path: string, uid: number) => {
      checked.push('private'); assert.equal(path, receipt.credentialPath); assert.equal(uid, receipt.serviceUid);
      if (!present) throw { code: 'ENOENT' };
      if (trustError) throw { code: trustError };
    },
    read: async () => Buffer.from(bytes),
  };
  assert.deepEqual(await assessRecoveryCredential(receipt, host), { status: 'initialization-required', sha256: null });
  assert.deepEqual(checked, ['parent']);
  for (const transaction of [undefined, { ...receipt.transaction!, operation: 'upgrade' as const },
    { ...receipt.transaction!, operation: 'uninstall' as const }]) {
    await assert.rejects(assessRecoveryCredential({ ...receipt, transaction }, host), code('INSTALL_RECOVERY_CREDENTIAL_REQUIRED'));
  }
  parentError = 'INSTALL_PATH_UNTRUSTED';
  await assert.rejects(assessRecoveryCredential(receipt, host), code(parentError));
  parentError = ''; present = true; checked.length = 0;
  const existing = await assessRecoveryCredential(receipt, host);
  assert.deepEqual(existing, { status: 'preserved', sha256: digest('synthetic credential') });
  assert.deepEqual(checked, ['parent', 'private']);
  for (const failure of ['INSTALL_PRIVATE_FILE_OWNERSHIP', 'INSTALL_PATH_UNTRUSTED']) {
    trustError = failure;
    await assert.rejects(assessRecoveryCredential(receipt, host), code(failure));
  }
  trustError = '';
  const absent = { status: 'initialization-required' as const, sha256: null };
  await assert.rejects(assessRecoveryCredential(receipt, host, absent), code('INSTALL_RECOVERY_EVIDENCE_CHANGED'));
  bytes = 'changed credential';
  await assert.rejects(assessRecoveryCredential(receipt, host, existing), code('INSTALL_RECOVERY_EVIDENCE_CHANGED'));
  present = false;
  await assert.rejects(assessRecoveryCredential(receipt, host, existing), code('INSTALL_RECOVERY_EVIDENCE_CHANGED'));
  assert.deepEqual(await assessRecoveryCredential(receipt, host, absent), absent);
});

