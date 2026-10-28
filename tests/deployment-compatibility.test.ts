import test from 'node:test';
import assert from 'node:assert/strict';
import { assessStateSchema, assessStateContent, DEPLOYMENT_STATE_COMPATIBILITY, type StateStore } from '../packages/deployment/compatibility.ts';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { UsageStore, inspectUsageDatabase, USAGE_DATABASE } from '../packages/management/usage.ts';
import { createHash } from 'node:crypto';
import { compileConfig, canonicalJson } from '../packages/config/index.ts';
import { parseStoredCandidate } from '../packages/transaction/index.ts';
import { recompileRuntimeCandidate } from '../packages/runtime/settings.ts';
import { initialWorkspace } from '../packages/management/workspace.ts';
import { createUpgradeAssessment, inspectStateCompatibility, stateDirectoryExists, type UpgradeAssessmentContext, type UpgradeStateHost } from '../packages/deployment/upgrade-assessment.ts';
import { parseRuntimeSettings } from '../packages/runtime/settings.ts';
import { renderDeploymentPlan } from '../packages/deployment/plan.ts';

const configInput = JSON.parse(await readFile(new URL('../examples/explicit-proxy.json', import.meta.url), 'utf8'));

test('state compatibility refuses newer or unknown schemas without guessing a data migration', () => {
  assert.equal(assessStateSchema('workspace', 1, DEPLOYMENT_STATE_COMPATIBILITY), 'supported-version');
  assert.equal(assessStateSchema('siteProbes', 1, DEPLOYMENT_STATE_COMPATIBILITY), 'supported-version');
  assert.equal(assessStateSchema('siteProbes', 1, { schemaVersion: 1, stateSchemas: { workspace: 1 } }), 'not-declared');
  assert.equal(assessStateSchema('trustedDevices', 2, DEPLOYMENT_STATE_COMPATIBILITY), 'supported-version');
  assert.equal(assessStateSchema('trustedDevices', 1, DEPLOYMENT_STATE_COMPATIBILITY), 'supported-version');
  assert.equal(assessStateSchema('trustedDevices', 3, DEPLOYMENT_STATE_COMPATIBILITY), 'unsupported-version');
  assert.equal(assessStateSchema('transaction', 1, undefined), 'not-declared');
  assert.equal(assessStateSchema('workspace', 1, { schemaVersion: 1, stateSchemas: {} }), 'not-declared');
  for (const value of [undefined, null, '1', 0, -1, 1.5]) {
    assert.equal(assessStateSchema('workspace', value, DEPLOYMENT_STATE_COMPATIBILITY), 'invalid');
  }
});

test('content assessment reuses complete readers and refuses broken fields even at a declared matching schema', () => {
  const candidate = compileConfig(configInput), { revision: _, ...settings } = initialWorkspace(null, []);
  const valid: Record<StateStore, unknown> = {
    transaction: { version: 1, desired: null, active: null, pending: null, fault: null, checkedAt: null },
    lifecycle: { schemaVersion: 1, enabled: false, paused: false },
    trustedDevices: { schemaVersion: 1, credentialFingerprint: 'a'.repeat(64), devices: [] },
    draft: { version: 1, revision: 1, input: configInput, generation: candidate.id, updatedAt: '2026-01-01T00:00:00.000Z' },
    workspace: { version: 1, revision: 1, settings },
    siteProbes: { version: 1, revision: 0, custom: [], groups: {} },
    automaticSelections: { version: 1, scope: 'synthetic', targets: {}, events: [] },
    automaticHistory: { version: 1, scopes: [] },
    automaticBandwidth: { version: 1, charges: [], switches: [] },
    usage: { schemaVersion: 1, integrity: 'ok' },
    selection: { schemaVersion: 1, generation: candidate.id },
    subscription: { version: 1, id: 'sourceA', url: 'https://subscription.example/config', revision: 1, definitionRevision: 1,
      snapshot: null, etag: null, lastAttempt: null, lastError: null },
  };
  for (const [store, input] of Object.entries(valid) as [StateStore, unknown][]) {
    const good = assessStateContent(store, input, DEPLOYMENT_STATE_COMPATIBILITY, 'sourceA');
    assert.equal(good.status, 'supported', store); assert.equal(good.content, 'valid', store);
    const minimal = ['lifecycle', 'trustedDevices', 'selection', 'usage'].includes(store) ? { schemaVersion: 1 }
      : { version: 1 };
    const bad = assessStateContent(store, minimal, DEPLOYMENT_STATE_COMPATIBILITY, 'sourceA');
    assert.equal(bad.status, 'unsupported', store); assert.equal(bad.code, 'DEPLOYMENT_STATE_CONTENT_INVALID', store);
  }
  // Both documents are structurally valid. Whether a changed binding resets state is a separate assessment.
  assert.equal(assessStateContent('trustedDevices', { ...(valid.trustedDevices as object), credentialFingerprint: 'c'.repeat(64) }, DEPLOYMENT_STATE_COMPATIBILITY).status, 'supported');
});

test('schema declarations alone do not establish a complete or unknown reader contract', () => {
  const state = { version: 1, desired: null, active: null, pending: null, fault: null, checkedAt: null };
  const legacy = assessStateContent('transaction', state, { schemaVersion: 1, stateSchemas: { transaction: 1 } });
  assert.equal(legacy.status, 'unknown'); assert.equal(legacy.content, 'valid');
  assert.equal(legacy.code, 'DEPLOYMENT_STATE_CONTENT_READER_NOT_DECLARED');
  const unknown = assessStateContent('transaction', state, { ...DEPLOYMENT_STATE_COMPATIBILITY, contentReaders: { transaction: 'unreviewed-reader' } });
  assert.equal(unknown.status, 'unknown'); assert.equal(unknown.code, 'DEPLOYMENT_STATE_CONTENT_READER_UNKNOWN');
  assert.equal(assessStateContent('transaction', { ...state, version: 2 }, DEPLOYMENT_STATE_COMPATIBILITY).status, 'unsupported');
});

test('upgrade inspects the real SQLite reader, rejects undeclared targets and blocks unsupported stored versions', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'cocoproxy-usage-compatibility-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await UsageStore.open(directory); store.close();
  const host: UpgradeStateHost = { read: async () => null, list: async () => [], usage: () => inspectUsageDatabase(directory) };
  const result = await inspectStateCompatibility(host, DEPLOYMENT_STATE_COMPATIBILITY);
  assert.equal(result.findings.find(item => item.store === 'usage')?.contentCompatibility.status, 'supported');
  const undeclared = await inspectStateCompatibility(host, { schemaVersion: 1, stateSchemas: {}, contentReaders: {} });
  assert.equal(undeclared.findings.find(item => item.store === 'usage')?.contentCompatibility.status, 'unknown');
  const db = new DatabaseSync(join(directory, USAGE_DATABASE)); db.exec('PRAGMA user_version=2'); db.close();
  const incompatible = await inspectStateCompatibility(host, DEPLOYMENT_STATE_COMPATIBILITY);
  assert.equal(incompatible.findings.find(item => item.store === 'usage')?.contentCompatibility.status, 'unsupported');
});

test('retained candidate readers share canonical bytes, generation and runtime recompile validation without running a core', () => {
  const candidate = compileConfig(configInput), bytes = canonicalJson(candidate.config);
  const settings = { schemaVersion: 1 as const, stateDirectory: '/synthetic/state', binaryPath: '/synthetic/core', binarySha256: 'a'.repeat(64),
    systemctlPath: '/usr/bin/systemctl', unitPath: '/etc/systemd/system/cocoproxy-mihomo.service', unitSha256: 'b'.repeat(64), serviceUid: 12345 };
  const config = parseStoredCandidate(bytes, candidate.id);
  assert.equal(recompileRuntimeCandidate(config, settings, candidate.id).id, candidate.id);
  const pretty = JSON.stringify(candidate.config, null, 2);
  assert.throws(() => parseStoredCandidate(pretty, createHash('sha256').update(pretty).digest('hex')), { code: 'CANDIDATE_TAMPERED' });
  assert.throws(() => parseStoredCandidate(bytes, 'f'.repeat(64)), { code: 'CANDIDATE_TAMPERED' });
  assert.throws(() => recompileRuntimeCandidate({ ...config, 'external-controller': '0.0.0.0:19090' }, settings, candidate.id), { code: 'CANDIDATE_UNTRUSTED' });
});

function upgradeFixture() {
  const active = compileConfig(configInput), previous = compileConfig({ ...configInput, policy: { ...configInput.policy, 'log-level': 'warning' } });
  const runtime = { schemaVersion: 1 as const, stateDirectory: '/synthetic/state', binaryPath: '/synthetic/core', binarySha256: 'a'.repeat(64),
    systemctlPath: '/usr/bin/systemctl', unitPath: '/etc/systemd/system/cocoproxy-mihomo.service', unitSha256: 'b'.repeat(64), serviceUid: 12345 };
  const credential = { schemaVersion: 1, algorithm: 'scrypt-v1', username: 'admin', salt: Buffer.alloc(16, 1).toString('base64url'), hash: Buffer.alloc(64, 2).toString('base64url') };
  const management = { origin: 'https://gateway.example:8443', credentialPath: '/synthetic/admin.json', deployment: configInput.deployment };
  const fingerprint = createHash('sha256').update(JSON.stringify({ origin: management.origin, credential })).digest('hex');
  const files = new Map<string, string>([
    ['state.json', JSON.stringify({ version: 1, active: active.id, desired: active.id, pending: null, fault: null, checkedAt: null })],
    ['lifecycle.json', JSON.stringify({ schemaVersion: 1, enabled: true, paused: false })],
    ['auth/trusted-devices.json', JSON.stringify({ schemaVersion: 1, credentialFingerprint: fingerprint, devices: [] })],
    ['candidates/' + active.id + '.json', canonicalJson(active.config)], ['candidates/' + previous.id + '.json', canonicalJson(previous.config)],
  ]);
  const calls: string[] = [];
  const host: UpgradeStateHost = { read: async (path, maximum) => { calls.push('read:' + path);
    const value = files.get(path); if (value !== undefined && Buffer.byteLength(value) > maximum) throw new Error('bounded'); return value ?? null; },
    list: async path => { calls.push('list:' + path); return [...files.keys()].filter(key => key.startsWith(path + '/')).map(key => key.slice(path.length + 1)); } };
  const context: UpgradeAssessmentContext = { targetDeclaration: DEPLOYMENT_STATE_COMPATIBILITY,
    currentRuntime: runtime, targetRuntime: { ...runtime, binaryPath: '/synthetic/new-core' }, currentManagement: management, targetManagement: management,
    credential, credentialObserved: true, networkReceipt: { observation: 'absent' } };
  return { context, host, files, active, calls };
}

test('upgrade preparation checks observed formats and identity without running a core or disclosing private values', async () => {
  const fixture = upgradeFixture();
  const result = await createUpgradeAssessment(fixture.context, fixture.host);
  assert.deepEqual(Object.keys(result.assessments), ['state', 'configuration', 'historyCandidates', 'network', 'identity']);
  for (const assessment of Object.values(result.assessments)) assert.equal(assessment.status, 'supported', assessment.code);
  assert.ok(fixture.calls.every(call => /^(read|list):/.test(call)));
  assert.doesNotMatch(JSON.stringify(result), /EXAMPLE_ONLY|subscription\.example|gateway\.example|\/synthetic\/|"salt"|"hash"/);
});

test('synthetic legacy declarations, broken complete data, missing history references and unavailable observations remain distinct', async () => {
  const old = upgradeFixture();
  old.context.targetDeclaration = { schemaVersion: 1, stateSchemas: DEPLOYMENT_STATE_COMPATIBILITY.stateSchemas };
  const undeclared = await createUpgradeAssessment(old.context, old.host);
  assert.equal(undeclared.assessments.state.status, 'unknown');
  assert.equal(undeclared.assessments.configuration.status, 'unknown');
  assert.equal(undeclared.assessments.historyCandidates.status, 'unknown');
  const broken = upgradeFixture(); broken.files.set('auth/trusted-devices.json', '{"schemaVersion":1}');
  const damaged = await createUpgradeAssessment(broken.context, broken.host);
  assert.equal(damaged.assessments.state.status, 'unsupported');
  assert.ok(damaged.assessments.state.checks!.some(item => item.code === 'DEPLOYMENT_STATE_CONTENT_INVALID'));
  const missing = upgradeFixture(); missing.files.delete('candidates/' + missing.active.id + '.json');
  assert.ok((await createUpgradeAssessment(missing.context, missing.host)).assessments.historyCandidates.checks!
    .some(item => item.code === 'UPGRADE_REFERENCED_CANDIDATE_MISSING'));
  const unavailable = upgradeFixture();
  const unreadable = await createUpgradeAssessment(unavailable.context, { ...unavailable.host, read: async (path, maximum) => {
    if (path.startsWith('candidates/')) throw new Error('PRIVATE PATH EACCES'); return unavailable.host.read(path, maximum);
  } });
  assert.equal(unreadable.assessments.historyCandidates.status, 'unknown');
  assert.doesNotMatch(JSON.stringify(unreadable), /PRIVATE PATH|EACCES/);
});

test('valid origin changes require reauthorization rather than damaged-state handling', async () => {
  const fixture = upgradeFixture();
  fixture.context.targetManagement = { ...fixture.context.currentManagement, origin: 'https://next.example:8443' };
  const changedOrigin = await createUpgradeAssessment(fixture.context, fixture.host);
  assert.equal(changedOrigin.assessments.state.status, 'supported');
  assert.equal(changedOrigin.assessments.identity.status, 'unsupported');
  assert.ok(changedOrigin.assessments.identity.checks!.some(item => item.code === 'UPGRADE_IDENTITY_REAUTHORIZATION_REQUIRED'));
});

test('gateway assessment separates static bindings and trusted receipt headers from unverified complete resources and live ownership', async () => {
  const fixture = upgradeFixture();
  const gateway = JSON.parse(await readFile(new URL('../examples/automatic-gateway-deployment.json', import.meta.url), 'utf8'));
  const plan = renderDeploymentPlan(gateway);
  const runtime = parseRuntimeSettings(JSON.parse(plan.files.find(file => file.path === gateway.runtime.settingsPath)!.content));
  fixture.context.currentRuntime = runtime; fixture.context.targetRuntime = runtime;
  fixture.context.networkReceipt = { observation: 'read', value: { schemaVersion: 1, status: 'complete', resources: 'not assessed' } };
  const complete = await createUpgradeAssessment(fixture.context, fixture.host);
  assert.equal(complete.assessments.network.status, 'unknown');
  assert.equal(complete.assessments.network.checks![0].status, 'supported');
  assert.ok(complete.assessments.network.checks!.some(item => item.code === 'UPGRADE_NETWORK_RESOURCES_NOT_ASSESSED' && item.status === 'unknown'));
  fixture.context.networkReceipt.value = { schemaVersion: 1, status: 'incomplete' };
  assert.equal((await createUpgradeAssessment(fixture.context, fixture.host)).assessments.network.status, 'unsupported');
  fixture.context.networkReceipt.value = { schemaVersion: 1, status: ['complete'] };
  assert.ok((await createUpgradeAssessment(fixture.context, fixture.host)).assessments.network.checks!
    .some(item => item.code === 'UPGRADE_NETWORK_RECEIPT_HEADER_INVALID'));
});

test('uninitialized state preserves missing-parent semantics while existing untrusted ancestors and actual subscription limits remain visible', async () => {
  const trusted: string[] = [];
  const absent = { info: async (path: string) => ['/srv', '/'].includes(path) ? { isDirectory: () => true } : null,
    rootPath: async (path: string) => { trusted.push(path); } };
  assert.equal(await stateDirectoryExists('/srv/new/parent/state', absent), false);
  assert.deepEqual(trusted, ['/srv']);
  await assert.rejects(stateDirectoryExists('/srv/new/parent/state', { ...absent, rootPath: async () => { throw new Error('untrusted existing ancestor'); } }));
  const fixture = upgradeFixture();
  const limited = await inspectStateCompatibility({ ...fixture.host, list: async path => path === 'subscriptions'
    ? Array.from({ length: 101 }, (_, index) => 'source' + index + '.json') : fixture.host.list(path) }, DEPLOYMENT_STATE_COMPATIBILITY);
  assert.ok(limited.findings.some(item => item.store === 'subscription' && item.contentCompatibility.code === 'DEPLOYMENT_STATE_COLLECTION_LIMIT'));
});
