import test from 'node:test';
import assert from 'node:assert/strict';
import { assessStateSchema, assessStateContent, DEPLOYMENT_STATE_COMPATIBILITY, type StateStore } from '../packages/deployment/compatibility.ts';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { compileConfig, canonicalJson } from '../packages/config/index.ts';
import { parseStoredCandidate } from '../packages/transaction/index.ts';
import { recompileRuntimeCandidate } from '../packages/runtime/settings.ts';
import { initialWorkspace } from '../packages/management/workspace.ts';

const configInput = JSON.parse(await readFile(new URL('../examples/explicit-proxy.json', import.meta.url), 'utf8'));

test('state compatibility refuses newer or unknown schemas without guessing a data migration', () => {
  assert.equal(assessStateSchema('notifications', 1, DEPLOYMENT_STATE_COMPATIBILITY), 'supported-version');
  assert.equal(assessStateSchema('siteProbes', 1, DEPLOYMENT_STATE_COMPATIBILITY), 'supported-version');
  assert.equal(assessStateSchema('siteProbes', 1, { schemaVersion: 1, stateSchemas: { workspace: 1 } }), 'not-declared');
  assert.equal(assessStateSchema('trustedDevices', 2, DEPLOYMENT_STATE_COMPATIBILITY), 'unsupported-version');
  assert.equal(assessStateSchema('transaction', 1, undefined), 'not-declared');
  assert.equal(assessStateSchema('workspace', 1, { schemaVersion: 1, stateSchemas: {} }), 'not-declared');
  for (const value of [undefined, null, '1', 0, -1, 1.5]) {
    assert.equal(assessStateSchema('notifications', value, DEPLOYMENT_STATE_COMPATIBILITY), 'invalid');
  }
});

test('content assessment reuses complete readers and refuses broken fields even at a declared matching schema', () => {
  const candidate = compileConfig(configInput), { revision: _, ...settings } = initialWorkspace(null, []);
  const valid: Record<StateStore, unknown> = {
    transaction: { version: 1, desired: null, active: null, pending: null, fault: null, checkedAt: null },
    lifecycle: { schemaVersion: 1, enabled: false, paused: false },
    trustedDevices: { schemaVersion: 1, credentialFingerprint: 'a'.repeat(64), devices: [] },
    notifications: { epoch: 'b'.repeat(64), state: { version: 1, keys: null, events: [], subscriptions: [], jobs: [], phases: {} } },
    draft: { version: 1, revision: 1, input: configInput, generation: candidate.id, updatedAt: '2026-01-01T00:00:00.000Z' },
    workspace: { version: 1, revision: 1, settings },
    siteProbes: { version: 1, revision: 0, custom: [], groups: {} },
    automaticSelections: { version: 1, scope: 'synthetic', targets: {}, events: [] },
    selection: { schemaVersion: 1, generation: candidate.id },
    subscription: { version: 1, id: 'sourceA', url: 'https://subscription.example/config', revision: 1, definitionRevision: 1,
      snapshot: null, etag: null, lastAttempt: null, lastError: null },
  };
  for (const [store, input] of Object.entries(valid) as [StateStore, unknown][]) {
    const good = assessStateContent(store, input, DEPLOYMENT_STATE_COMPATIBILITY, 'sourceA');
    assert.equal(good.status, 'supported', store); assert.equal(good.content, 'valid', store);
    const minimal = ['lifecycle', 'trustedDevices', 'selection'].includes(store) ? { schemaVersion: 1 }
      : store === 'notifications' ? { epoch: 'b'.repeat(64), state: { version: 1 } } : { version: 1 };
    const bad = assessStateContent(store, minimal, DEPLOYMENT_STATE_COMPATIBILITY, 'sourceA');
    assert.equal(bad.status, 'unsupported', store); assert.equal(bad.code, 'DEPLOYMENT_STATE_CONTENT_INVALID', store);
  }
  // Both envelopes are structurally valid. Whether a changed binding resets state is a separate assessment.
  assert.equal(assessStateContent('trustedDevices', { ...(valid.trustedDevices as object), credentialFingerprint: 'c'.repeat(64) }, DEPLOYMENT_STATE_COMPATIBILITY).status, 'supported');
  assert.equal(assessStateContent('notifications', { ...(valid.notifications as object), epoch: 'd'.repeat(64) }, DEPLOYMENT_STATE_COMPATIBILITY).status, 'supported');
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

test('historical candidate readers share canonical bytes, generation and runtime recompile validation without running a core', () => {
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
