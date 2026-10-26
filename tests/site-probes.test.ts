import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SiteProbeStore, siteScope, siteUrl } from '../packages/management/site-probes.ts';

test('site settings persist isolated scheme choices, reject stale writes and enforce target permissions', async t => {
  const root = await mkdtemp(join(tmpdir(), 'site-probes-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new SiteProbeStore(root);
  const scope = siteScope({ mode: 'local', subscriptionId: null, sourceIds: ['pool'] });
  const other = siteScope({ mode: 'subscription', subscriptionId: 'pool', sourceIds: ['pool'] });
  assert.notEqual(scope, other);
  const saved = await store.update(0, settings => {
    const target = store.add(settings, 'Example', 'https://probe.example/check');
    settings.groups[scope] = { Proxy: ['google', target.id] };
    settings.groups[other] = { Proxy: ['claude'] };
  });
  assert.deepEqual((await new SiteProbeStore(root).read()).groups, saved.groups);
  assert.ok((await store.allowedUrls()).includes('https://probe.example/check'));
  await assert.rejects(store.update(0, () => {}), { code: 'SITE_SETTINGS_CONFLICT' });
  await assert.rejects(store.update(1, settings => { settings.groups[scope]!.Proxy = ['unknown']; }), { code: 'SITE_SETTINGS_INVALID' });
  assert.equal((await store.read()).revision, 1);
  const urls = await store.allowedUrls();
  assert.ok(urls.includes('https://github.com/') && urls.includes('https://chatgpt.com/'));
  const disabled = new SiteProbeStore(root, false);
  await assert.rejects(disabled.update(1, settings => { disabled.add(settings, 'Disabled', 'https://disabled.example/'); }), { code: 'SITE_TARGET_DENIED' });
  assert.deepEqual(await disabled.allowedUrls(), []);
  for (const value of ['http://probe.example/', 'https://127.0.0.1/', 'https://localhost/', 'https://router.local/',
    'https://user:secret@probe.example/', 'https://probe.example/?token=secret', 'https://probe.example/#secret']) {
    assert.throws(() => siteUrl(value), { code: 'SITE_SETTINGS_INVALID' });
  }
});
