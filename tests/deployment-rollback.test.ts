import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { rollbackDeployment, type DeploymentRollbackHost, type RollbackContext } from '../packages/deployment/rollback.ts';
import { InstallError, type Receipt, type DeploymentLock } from '../packages/deployment/install.ts';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const STORE = '/var/lib/cocoproxy-deployment';
const id = '12345678-1234-1234-1234-123456789abc';
const lock: DeploymentLock = { schemaVersion: 1, id, pid: 12345, bootId: 'abcdef12-1234-1234-1234-123456789abc', startTime: '1234' };
const code = (expected: string) => (error: any) => error.code === expected;

function fixture() {
  const files = [
    { path: '/etc/cocoproxy/runtime.json', mode: '0600' as const, owner: 12345, sensitive: true, content: 'old runtime' },
    { path: '/etc/systemd/system/cocoproxy-management.service', mode: '0644' as const, owner: 'root' as const, sensitive: false, content: 'old manager' },
  ];
  const previous: Receipt = { schemaVersion: 1, status: 'complete', release: '/opt/sample/releases/' + 'a'.repeat(64), manifestSha256: 'a'.repeat(64),
    serviceUid: 12345, stateDirectory: '/var/lib/sample', credentialPath: '/etc/sample/administrator.json',
    files: files.map(({ content, ...file }) => ({ ...file, sha256: digest(content) })) };
  let receipt: Receipt = { ...structuredClone(previous), status: 'pending', manifestSha256: 'b'.repeat(64), release: '/opt/sample/releases/' + 'b'.repeat(64),
    transaction: { id, operation: 'upgrade' }, files: previous.files.map(file => ({ ...file, sha256: digest(file.path) })) };
  const disk = new Map(files.map(file => [file.path, { content: file.content, uid: file.owner === 'root' ? 0 : file.owner, mode: file.mode }]));
  disk.get(files[0].path)!.content = files[0].path; // A partial apply: runtime new, management still old.
  let currentLock: { bytes: Buffer; value: DeploymentLock } | null = { bytes: Buffer.from(JSON.stringify(lock)), value: lock };
  const events: string[] = [];
  let failWrite = false, ownerAlive = false, unsafeState = false, degraded = false;
  const host: DeploymentRollbackHost = {
    readReceipt: async () => ({ bytes: Buffer.from(JSON.stringify(receipt)), receipt: structuredClone(receipt) }),
    lock: async () => currentLock,
    ownerGone: async () => !ownerAlive,
    prepare: async () => {
      if (unsafeState) throw new InstallError('INSTALL_ROLLBACK_STATE_INCOMPATIBLE');
      return { plan: { schemaVersion: 1, sensitive: true, files, directories: [], requirements: [], steps: [] },
        input: { runtime: { systemctlPath: '/usr/bin/systemctl' } }, usageCompatibility: degraded ? 'degraded-schema' : 'supported' };
    },
    quiescent: async () => { events.push('quiescent'); },
    exists: async path => disk.has(path),
    owned: async owned => {
      for (const file of owned) {
        const actual = disk.get(file.path);
        if (!actual || digest(actual.content) !== file.sha256 || actual.uid !== (file.owner === 'root' ? 0 : file.owner) || actual.mode !== file.mode)
          throw new InstallError('INSTALL_OWNED_FILE_CHANGED');
      }
    },
    claim: async () => {
      events.push('claim');
      currentLock ??= { bytes: Buffer.from(JSON.stringify(lock)), value: lock };
      return currentLock.bytes;
    },
    write: async (path, bytes, mode, uid = 0) => {
      events.push('write:' + path);
      if (failWrite) throw new InstallError('INSTALL_SYNTHETIC_WRITE_FAILED');
      if (path === STORE + '/receipt.json') receipt = JSON.parse(bytes);
      else disk.set(path, { content: bytes, uid, mode: mode.toString(8).padStart(4, '0') as '0600' | '0644' });
    },
    remove: async path => { events.push('remove:' + path); if (path === STORE + '/install.lock') currentLock = null; else disk.delete(path); },
    reload: async () => { events.push('reload'); },
  };
  const context: RollbackContext = { previousInput: {}, previousReceipt: previous, manifestSha256: 'b'.repeat(64) };
  return { host, context, disk, events, receipt: () => receipt, current: () => receipt,
    noLock: () => { currentLock = null; }, usePreviousReceipt: () => { receipt = structuredClone(previous); },
    failWrite: () => { failWrite = true; }, ownerAlive: () => { ownerAlive = true; }, unsafeState: () => { unsafeState = true; }, degraded: () => { degraded = true; } };
}

test('rollback restores a partial upgrade before publishing old receipt and removing its matching locks', async () => {
  const f = fixture();
  const result = await rollbackDeployment(f.context, { host: f.host });
  assert.equal(result.restored, true);
  assert.equal(result.usageCompatibility, 'supported');
  assert.deepEqual(f.receipt(), f.context.previousReceipt);
  assert.equal(f.disk.get('/etc/cocoproxy/runtime.json')!.content, 'old runtime');
  assert.equal(f.disk.get('/etc/systemd/system/cocoproxy-management.service')!.content, 'old manager');
  assert.ok(f.events.indexOf('reload') < f.events.indexOf('write:' + STORE + '/receipt.json'));
  assert.deepEqual(f.events.slice(-2), ['remove:' + STORE + '/install.lock', 'remove:' + STORE + '/recovery.lock']);
});

test('rollback rejects third-party byte, owner and mode drift, live owners and incompatible private state before mutation', async () => {
  for (const mutation of [
    (f: ReturnType<typeof fixture>) => { f.disk.get('/etc/cocoproxy/runtime.json')!.content = 'third-party'; },
    (f: ReturnType<typeof fixture>) => { f.disk.get('/etc/cocoproxy/runtime.json')!.uid = 54321; },
    (f: ReturnType<typeof fixture>) => { f.disk.get('/etc/cocoproxy/runtime.json')!.mode = '0644'; },
    (f: ReturnType<typeof fixture>) => { f.ownerAlive(); },
    (f: ReturnType<typeof fixture>) => { f.unsafeState(); },
    (f: ReturnType<typeof fixture>) => { f.current().transaction!.id = '00000000-1234-1234-1234-123456789abc'; },
  ]) {
    const f = fixture(); mutation(f);
    await assert.rejects(rollbackDeployment(f.context, { host: f.host }));
    assert.ok(!f.events.includes('claim'));
    assert.ok(!f.events.some(event => event.startsWith('write:') || event.startsWith('remove:')));
  }
});

test('rollback failure retains transaction evidence and never marks the previous receipt complete', async () => {
  const f = fixture(); f.failWrite();
  await assert.rejects(rollbackDeployment(f.context, { host: f.host }), code('INSTALL_SYNTHETIC_WRITE_FAILED'));
  assert.equal(f.receipt().status, 'pending');
  assert.ok(f.events.includes('claim'));
  assert.ok(!f.events.some(event => event.startsWith('remove:') || event === 'reload'));
});

test('rollback reports explicitly degraded usage without changing retained private database files', async () => {
  const f = fixture(); f.degraded();
  f.disk.set('/var/lib/sample/usage.sqlite', { content: 'synthetic schema 2 history', uid: 12345, mode: '0600' });
  const result = await rollbackDeployment(f.context, { host: f.host });
  assert.equal(result.usageCompatibility, 'degraded-schema');
  assert.equal(f.disk.get('/var/lib/sample/usage.sqlite')!.content, 'synthetic schema 2 history');
  assert.ok(!f.events.some(event => event.includes('usage.sqlite')));
});

test('management-only rollback rejects changed pinned runtime before mutating files', async () => {
  const f = fixture(); f.context.preserveRuntime = true;
  f.current().runtimeManifestSha256 = f.context.previousReceipt.manifestSha256;
  await assert.rejects(rollbackDeployment(f.context, { host: f.host }), code('INSTALL_ROLLBACK_RUNTIME_CHANGED'));
  assert.deepEqual(f.events, []);
});

test('rollback accepts failure before the first live write with the original receipt and no installer lock', async () => {
  const f = fixture(); f.usePreviousReceipt(); f.noLock(); f.context.preserveRuntime = true;
  f.disk.get('/etc/cocoproxy/runtime.json')!.content = 'old runtime';
  const result = await rollbackDeployment(f.context, { host: f.host });
  assert.equal(result.services, 'runtime-preserved');
  assert.deepEqual(f.receipt(), f.context.previousReceipt);
  assert.ok(!f.events.some(event => event.startsWith('write:/etc/')));
});
