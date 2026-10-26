import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { link, mkdtemp, mkdir, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { assertMaintenanceLifecycle, assertReviewedUpgradeConfiguration, compatibleOwnedFiles, configurationReviewDigest, deployRelease,
  parseDeploymentLock, prepareUpgrade, releaseTarget, validateReceipt, verifyRelease, type Receipt } from '../packages/deployment/install.ts';
import { assertFinalizableReceipt, deploymentOwnerGone, inspectDeployment, recoverDeployment } from '../packages/deployment/maintenance.ts';
import { renderDeploymentPlan } from '../packages/deployment/plan.ts';

const digest = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const code = (expected: string) => (error: any) => error.code === expected;

test('maintenance refuses enabled automatic recovery until it has been explicitly paused', () => {
  assertMaintenanceLifecycle({ schemaVersion: 1, enabled: true, paused: true });
  assertMaintenanceLifecycle({ schemaVersion: 1, enabled: false, paused: false });
  assert.throws(() => assertMaintenanceLifecycle({ schemaVersion: 1, enabled: true, paused: false }), code('INSTALL_LIFECYCLE_MUST_BE_PAUSED'));
  for (const value of [null, {}, { schemaVersion: 1, enabled: false }, { schemaVersion: 1, enabled: 'false', paused: true }]) {
    assert.throws(() => assertMaintenanceLifecycle(value), code('INSTALL_LIFECYCLE_INVALID'));
  }
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
    const result = spawnSync(process.execPath, ['--experimental-strip-types', 'apps/deployment/main.ts', ...args],
      { cwd: new URL('..', import.meta.url), encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr.trim(), 'INSTALL_ARGUMENTS_INVALID');
  }
});

