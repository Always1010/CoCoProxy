import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { canonicalJson, compileConfig } from '../packages/config/index.ts';
import { FileTransactionStore } from '../packages/transaction/index.ts';
import { createAdminCredential, type AdminCredential } from '../packages/management/auth.ts';
import { TrustedDeviceStore } from '../packages/management/trusted-devices.ts';
import { createManagementGateway } from '../packages/management/http.ts';
import { WorkspaceStore, initialWorkspace } from '../packages/management/workspace.ts';
import { SubscriptionStore } from '../packages/subscriptions/index.ts';
import { capturePreservation, summarizePreservation } from '../packages/deployment/preservation.ts';
import type { RuntimeSettings } from '../packages/runtime/types.ts';

const origin = 'https://management.example';
const credential = await createAdminCredential({ username: 'synthetic-admin', password: 'synthetic-preservation-password' });
const input = JSON.parse(await readFile(new URL('../examples/explicit-proxy.json', import.meta.url), 'utf8'));
const candidate = compileConfig(input);
const settings: RuntimeSettings = { schemaVersion: 1, stateDirectory: '/synthetic/state', binaryPath: '/synthetic/core',
  binarySha256: 'a'.repeat(64), systemctlPath: '/usr/bin/systemctl', unitPath: '/etc/systemd/system/cocoproxy-mihomo.service', unitSha256: 'b'.repeat(64), serviceUid: 12345 };
type Snapshot = ReturnType<typeof summarizePreservation> & { directories: Record<string, unknown> };
function compare(before: Snapshot, after: Snapshot, frozen = false): any {
  const code = 'import importlib.util,json,sys; s=importlib.util.spec_from_file_location("coordinator",sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); d=json.load(sys.stdin); print(json.dumps(m.compare_preservation(d["before"],d["after"],d["frozen"])))';
  const result = spawnSync('python', ['-B', '-c', code, fileURLToPath(new URL('../scripts/remote-deploy.py', import.meta.url))],
    { input: JSON.stringify({ before, after, frozen }), encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout);
}
const find = (result: any, id: string) => result.checks.find((item: any) => item.id === id);

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'cocoproxy-preservation-')); t.after(() => rm(root, { recursive: true, force: true }));
  let now = 2_000_000_000_000;
  const files = new FileTransactionStore(root); await files.stage(candidate);
  await files.writeState({ version: 1, desired: candidate.id, active: candidate.id, pending: null, fault: null, checkedAt: new Date(now).toISOString() });
  await writeFile(join(root, 'selection.json'), JSON.stringify({ schemaVersion: 1, generation: candidate.id,
    hot: { pid: 1234, bootId: '12345678-1234-1234-1234-123456789abc', startTime: '123', baseGeneration: candidate.id } }), { mode: 0o600 });
  const { revision: _, ...workspace } = initialWorkspace(null, ['sourceA']);
  workspace.local = { selections: { 'Example Select': 'Example Proxy' }, rules: ['MATCH,REJECT'],
    automatic: { 'Example Select': { preferred: ['Example Proxy'], fallback: [], returnToPreferred: true } } };
  await new WorkspaceStore(root).save(workspace, 0);
  await new SubscriptionStore(root).configure({ id: 'sourceA', url: 'https://subscription.example/config?synthetic-token=private' }, 0);
  await writeFile(join(root, 'automatic-selections.json'), JSON.stringify({ version: 1, scope: 'synthetic-scope',
    targets: { 'Example Select': { signature: 'a'.repeat(64), target: 'Example Proxy' } }, events: [] }), { mode: 0o600 });
  await writeFile(join(root, 'automatic-history.json'), JSON.stringify({ version: 1, scopes: [] }), { mode: 0o600 });
  let devices = await TrustedDeviceStore.load(root, credential, origin, () => now);
  const grant = await devices.issue('90days', 'synthetic-device');
  const project = async (selectedOrigin = origin, selectedCredential: AdminCredential = credential) => {
    const paths = { transaction: 'state.json', lifecycle: 'lifecycle.json', trustedDevices: 'auth/trusted-devices.json',
      workspace: 'workspace.json', siteProbes: 'site-probes.json', draft: 'draft.json', automaticSelections: 'automatic-selections.json',
      automaticHistory: 'automatic-history.json', selection: 'selection.json' };
    const documents = {} as Parameters<typeof summarizePreservation>[0];
    for (const [id, path] of Object.entries(paths)) {
      try { documents[id as keyof typeof documents] = await readFile(join(root, path), 'utf8'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; documents[id as keyof typeof documents] = null; }
    }
    const sources = { sourceA: await readFile(join(root, 'subscriptions/sourceA.json'), 'utf8') };
    const capsule = summarizePreservation(documents, sources, canonicalJson(candidate.config), { origin: selectedOrigin, credential: selectedCredential, settings, now });
    return { ...capsule, directories: { state: { present: true, entries: createHash('sha256').update(JSON.stringify((await readdir(root)).sort())).digest('hex') } } };
  };
  return { root, grant, project, advance(ms: number) { now += ms; }, async restart() {
    devices = await TrustedDeviceStore.load(root, credential, origin, () => now);
    return devices;
  } };
}

test('real stores project to secret-free preservation capsules and the coordinator compares the stopped file window', async t => {
  const f = await fixture(t), before = await f.project(), after = await f.project();
  assert.equal(before.ready, true); assert.equal(compare(before, after, true).status, 'pass');
  const serialized = JSON.stringify(before);
  for (const secret of [f.grant.token, f.grant.device.id, credential.hash, 'Example Proxy', 'synthetic-token=private']) assert.equal(serialized.includes(secret), false);
  const changed = structuredClone(after); changed.files.trustedDevices = null;
  assert.equal(find(compare(before, changed, true), 'known-state-files').status, 'fail');
  const lostHistory = structuredClone(after); lostHistory.files.automaticHistory = null;
  assert.equal(find(compare(before, lostHistory), 'automatic-switch-history').status, 'unknown');
  const added: Snapshot = structuredClone(after); added.directories.auth = { present: true, entries: 'new' };
  assert.equal(find(compare(before, added, true), 'state-directories').status, 'fail');
  assert.equal(compare(before, after).authentication.status, 'not-run');
});

test('preservation accepts the same abandoned atomic files as the business readers', {
  skip: process.platform === 'win32' || process.geteuid?.() === 0,
}, async t => {
  const f = await fixture(t);
  const runtimeSettingsPath = join(f.root, 'runtime.json'), managementSettingsPath = join(f.root, 'management.json');
  const credentialPath = join(f.root, 'administrator.json');
  await writeFile(credentialPath, JSON.stringify(credential), { mode: 0o600 });
  await writeFile(runtimeSettingsPath, JSON.stringify({ ...settings, stateDirectory: f.root, serviceUid: process.geteuid!() }), { mode: 0o600 });
  await writeFile(managementSettingsPath, JSON.stringify({ schemaVersion: 1, origin, credentialPath, runtimeSettingsPath }), { mode: 0o600 });
  for (const directory of ['subscriptions', 'candidates']) {
    await writeFile(join(f.root, directory, '.write-12345678-1234-4234-8234-123456789abc'), 'unfinished atomic write', { mode: 0o600 });
  }
  assert.equal((await capturePreservation(managementSettingsPath)).ready, true);
  await writeFile(join(f.root, 'subscriptions', 'unexpected-file'), 'not a known temporary name', { mode: 0o600 });
  await assert.rejects(capturePreservation(managementSettingsPath), { code: 'REMOTE_PRESERVATION_SNAPSHOT_UNAVAILABLE' });
});

test('same trusted device identity survives renewal while automatic events and hot process evidence may change', async t => {
  const f = await fixture(t), before = await f.project();
  f.advance(86400001); const restoredDevices = await f.restart(); await restoredDevices.renew(f.grant.token);
  assert.equal(restoredDevices.check(f.grant.token)?.id, f.grant.device.id);
  await writeFile(join(f.root, 'selection.json'), JSON.stringify({ schemaVersion: 1, generation: candidate.id }), { mode: 0o600 });
  const automatic = JSON.parse(await readFile(join(f.root, 'automatic-selections.json'), 'utf8'));
  automatic.events.push({ at: 1234, group: 'Example Select', from: 'Example Proxy', to: 'Example Proxy', reason: 'failure-recovery' });
  await writeFile(join(f.root, 'automatic-selections.json'), JSON.stringify(automatic), { mode: 0o600 });
  const after = await f.project(), result = compare(before, after);
  assert.notEqual(before.files.trustedDevices, after.files.trustedDevices);
  assert.notEqual(before.files.selection, after.files.selection); assert.equal(result.status, 'pass');
  assert.equal(find(result, 'trusted-devices').status, 'pass');
});

test('lost stable device identities require review independently of valid schemas, and expired devices may be pruned', async t => {
  const f = await fixture(t), before = await f.project();
  const changed = structuredClone(before); changed.trusted.devices[0].stable = 'f'.repeat(64);
  const result = compare(before, changed); assert.equal(find(result, 'content-readability').status, 'pass');
  assert.equal(find(result, 'trusted-devices').status, 'unknown'); assert.equal(result.status, 'unknown');
  const pruned = structuredClone(before); pruned.observedAt += 91 * 86400000; pruned.trusted.devices = [];
  assert.equal(find(compare(before, pruned), 'trusted-devices').status, 'not-applicable');
  const broken = structuredClone(before); broken.contentChecks.push({ id: 'workspace', status: 'fail', code: 'REMOTE_PRESERVATION_CONTENT_INVALID', evidenceScope: 'current-reader-content-validation' });
  assert.equal(find(compare(before, broken), 'content-readability').status, 'unknown');
});

test('origin or administrator changes invalidate actual old authorization without classifying valid stored data as corruption', async t => {
  const f = await fixture(t), before = await f.project();
  const replacement = await createAdminCredential({ username: 'synthetic-admin', password: 'replacement-preservation-password' });
  for (const [selectedOrigin, selectedCredential] of [[origin + ':8443', credential], [origin, replacement]] as const) {
    const devices = await TrustedDeviceStore.load(f.root, selectedCredential, selectedOrigin);
    assert.equal(devices.check(f.grant.token), null);
    const denied = await createManagementGateway({ origin: selectedOrigin, credential: selectedCredential, trustedDevices: devices }, async () => ({})).fetch(
      new Request(selectedOrigin + '/api/cocoproxy/private', { headers: { cookie: '__Host-cocoproxy_device=' + f.grant.token } }));
    assert.equal(denied.status, 401);
    const after = await f.project(selectedOrigin, selectedCredential), result = compare(before, after);
    assert.equal(after.ready, true); assert.equal(after.trusted.binding, 'invalidated');
    assert.equal(find(result, 'content-readability').status, 'pass'); assert.equal(find(result, 'administrator-binding').code, 'REMOTE_PRESERVATION_REAUTH_REQUIRED');
  }
});

test('a declared matching schema never proves content or an unsettled runtime is ready for an upgrade baseline', async t => {
  const empty = Object.fromEntries(['transaction', 'lifecycle', 'trustedDevices', 'workspace', 'siteProbes', 'draft', 'automaticSelections', 'selection'].map(id => [id, null])) as Parameters<typeof summarizePreservation>[0];
  const context = { origin, credential, settings, now: 2_000_000_000_000 };
  assert.equal(summarizePreservation(empty, {}, null, context).runtime.coherent, true); // Never configured or started.
  const selected = { ...empty, transaction: JSON.stringify({ version: 1, desired: candidate.id, active: candidate.id, pending: null, fault: null, checkedAt: null }) };
  assert.equal(summarizePreservation(selected, {}, canonicalJson(candidate.config), context).runtime.coherent, false); // Active cannot borrow a missing selection.
  const fault = { ...empty, transaction: JSON.stringify({ version: 1, desired: candidate.id, active: null, fault: 'RESTORE_FAILED', checkedAt: null,
    pending: { id: '12345678-1234-1234-1234-123456789abc', target: candidate.id, previous: null, phase: 'fault' } }) };
  const recovery = summarizePreservation(fault, {}, null, context);
  assert.equal(recovery.contentChecks.find(item => item.id === 'transaction')?.status, 'pass');
  assert.equal(recovery.runtime.code, 'REMOTE_PRESERVATION_RUNTIME_RECOVERY_REQUIRED');
  const f = await fixture(t);
  await writeFile(join(f.root, 'workspace.json'), '{"version":1}', { mode: 0o600 });
  const corrupt = await f.project(); assert.equal(corrupt.ready, false); assert.equal(corrupt.contentChecks.find(item => item.id === 'workspace')?.status, 'fail');
  await writeFile(join(f.root, 'selection.json'), JSON.stringify({ schemaVersion: 1, generation: 'f'.repeat(64) }), { mode: 0o600 });
  const mismatch = await f.project(); assert.equal(mismatch.runtime.coherent, false); assert.equal(mismatch.runtime.code, 'REMOTE_PRESERVATION_RUNTIME_RECOVERY_REQUIRED');
});
