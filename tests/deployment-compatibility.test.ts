import test from 'node:test';
import assert from 'node:assert/strict';
import { assessStateSchema, DEPLOYMENT_STATE_COMPATIBILITY } from '../packages/deployment/compatibility.ts';

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
