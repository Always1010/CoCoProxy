import assert from 'node:assert/strict';
import test from 'node:test';
import { createAdminCredential, SessionStore } from '../packages/management/auth.ts';
import { createManagementGateway, ManagementError } from '../packages/management/http.ts';
import { createUpdaterHandler, unavailableUpdates, type UpdateCommand } from '../packages/management/updater.ts';
import { DEFAULT_UPDATE_SETTINGS } from '../packages/updater/policy.ts';

const origin = 'https://updates.example';
test('update controls require authentication and same-origin before dispatch, validate exact policy, and keep optimistic revision', async () => {
  const calls: UpdateCommand[] = [];
  const handler = createUpdaterHandler(async command => { calls.push(command); return unavailableUpdates(); });
  const credential = await createAdminCredential({ username: 'admin', password: 'synthetic-updater-password' });
  const sessions = new SessionStore();
  const token = sessions.issue('admin').token;
  const gateway = createManagementGateway({ origin, credential, sessions }, handler);
  const request = (path: string, body: unknown, cookie = true, source = origin) => new Request(origin + '/api/cocoproxy/updates' + path, {
    method: path === '/settings' ? 'PUT' : 'POST', headers: { origin: source, 'content-type': 'application/json', ...(cookie ? { cookie: '__Host-cocoproxy_session=' + token } : {}) }, body: JSON.stringify(body),
  });
  assert.equal((await gateway.fetch(request('/check', {}, false))).status, 401);
  assert.equal((await gateway.fetch(request('/install', { expectedVersion: '1.2.3' }, true, 'https://foreign.example'))).status, 403);
  assert.equal(calls.length, 0);
  for (const intervalDays of [0, 366, 1.5, '7']) assert.equal((await gateway.fetch(request('/settings', { expectedRevision: 3, settings: { ...DEFAULT_UPDATE_SETTINGS, intervalDays } }))).status, 400);
  assert.equal((await gateway.fetch(request('/settings', { expectedRevision: 3, settings: { ...DEFAULT_UPDATE_SETTINGS, socketPath: '/other.sock' } }))).status, 400);
  assert.equal((await gateway.fetch(request('/install', { expectedVersion: '1.2.3', url: 'https://foreign.example' }))).status, 400);
  assert.equal(calls.length, 0);
  assert.equal((await gateway.fetch(request('/settings', { expectedRevision: 3, settings: { ...DEFAULT_UPDATE_SETTINGS, enabled: true, intervalDays: 365 } }))).status, 200);
  assert.deepEqual(calls[0], { action: 'configure', expectedRevision: 3, settings: { ...DEFAULT_UPDATE_SETTINGS, enabled: true, intervalDays: 365 } });
  assert.equal((await gateway.fetch(request('/install', { expectedVersion: '1.2.3' }))).status, 200);
  assert.deepEqual(calls[1], { action: 'install', expectedVersion: '1.2.3' });
});

test('missing native updater has disabled read-only status while writes fail', async () => {
  const handler = createUpdaterHandler(async () => { throw new ManagementError('UPDATER_UNAVAILABLE', 503); });
  assert.deepEqual(await handler(new Request(origin + '/api/cocoproxy/updates')), unavailableUpdates());
  await assert.rejects(handler(new Request(origin + '/api/cocoproxy/updates/check', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })), (error: unknown) => error instanceof ManagementError && error.status === 503);
});
