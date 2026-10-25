import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import type { JsonObject } from '../packages/config/index.ts';
import { FileTransactionStore } from '../packages/transaction/index.ts';
import { WorkspaceStore, parseWorkspaceSettings } from '../packages/management/workspace.ts';
import type { Workspace, WorkspaceSettings } from '../packages/management/workspace.ts';

const deployment = { mixedPort: 17890, controllerPort: 19090, dnsPort: 15353,
  controllerSecret: 'EXAMPLE_ONLY_DEPLOYMENT_SECRET', bootstrapResolvers: ['192.0.2.53'] };
const node = { name: 'synthetic-node', type: 'socks5', server: '192.0.2.10', port: 1080 };
const profile: JsonObject = { proxies: [node],
  'proxy-groups': [
    { name: 'Provider', type: 'select', proxies: ['Auto', 'synthetic-node', 'DIRECT', 'REJECT'] },
    { name: 'Auto', type: 'url-test', proxies: ['synthetic-node'], url: 'https://probe.example/generate_204', interval: 300, tolerance: 50 },
  ], rules: ['DOMAIN-SUFFIX,provider.example,Provider', 'MATCH,Provider'], 'tcp-concurrent': true };

function settings(changes: Partial<WorkspaceSettings> = {}): WorkspaceSettings {
  return { mode: 'local', subscriptionId: null, sourceIds: [], runMode: 'rule',
    local: { selections: {}, rules: [] }, subscriptionOverrides: {}, ...changes };
}
function withoutRevision({ revision: _revision, ...value }: Workspace): WorkspaceSettings { return value; }
type View = { workspace: Workspace; active: string | null; pending: boolean; error?: string;
  groups: { name: string; type: string; selected: string; options: string[] }[];
  nodes: string[]; rules: { value: string; source: string; editable: boolean }[]; ruleCount: number };

async function directory(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'coproxy-workspace-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function fixture(t: TestContext) {
  // Keep the pure settings/store test runnable without the optional YAML runtime.
  const [{ createManagementApplication }, { decodeSubscriptionProfile }] = await Promise.all([
    import('../packages/management/application.ts'), import('../packages/subscriptions/yaml.ts'),
  ]);
  const root = await directory(t), state = join(root, 'state');
  const payloads = new Map<string, string>();
  const events: string[] = [];
  let failActivation = false;
  const runtime = {
    validate: async () => { events.push('validate'); },
    activate: async () => { events.push('activate'); if (failActivation) throw new Error('EXAMPLE_ONLY_RUNTIME_DIAGNOSTIC'); },
    confirm: async () => { events.push('confirm'); return true; },
    restore: async () => { events.push('restore'); },
    observe: async (generation: string) => ({ ready: true, generation, checkedAt: new Date().toISOString(), reason: null }),
  };
  const action = createManagementApplication({ stateDirectory: state, deployment, runtime,
    sourceDecoder: decodeSubscriptionProfile, sourceClient: { fetch: async url => {
      const text = payloads.get(url);
      if (text === undefined) throw new Error('Synthetic source missing');
      return { status: 'modified' as const, text };
    } } });
  async function call<T = unknown>(path: string, method = 'GET', body?: unknown): Promise<T> {
    const request = new Request(`https://management.example/api/coproxy${path}`, { method,
      headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return await action(request, { username: 'synthetic-admin', expiresAt: Date.now() + 60_000 }) as T;
  }
  async function source(id: string, input: JsonObject) {
    const url = `https://subscription.example/${id}?token=EXAMPLE_ONLY_TOKEN`;
    payloads.set(url, JSON.stringify(input));
    const configured = await call<{ revision: number }>(`/sources/${id}`, 'PUT', { expectedRevision: 0, url });
    return await call<{ revision: number }>(`/sources/${id}/refresh`, 'POST', { expectedRevision: configured.revision });
  }
  const view = () => call<View>('/workspace');
  const save = async (value: WorkspaceSettings, expectedRevision: number) => (await call<{ workspace: Workspace }>('/workspace', 'PUT', { settings: value, expectedRevision })).workspace;
  const apply = (workspace: Workspace, expectedActive: string | null) => call<{ active: string; workspaceRevision: number }>('/workspace/apply', 'POST', { expectedRevision: workspace.revision, expectedActive });
  const candidate = async (id: string) => JSON.parse(await readFile(await new FileTransactionStore(state).readCandidate(id), 'utf8')) as JsonObject;
  return { state, events, call, view, save, apply, source, candidate, payloads, fail: () => { failActivation = true; } };
}

test('workspace settings enforce schema and durable compare-and-save without aliasing', async t => {
  const store = new WorkspaceStore(join(await directory(t), 'state'));
  assert.equal(await store.read(), null);
  const input = settings({ local: { selections: { Other: 'REJECT' }, rules: ['DOMAIN,synthetic.example,REJECT'] } });
  const saved = await store.save(input, 0);
  input.local.rules.push('MATCH,DIRECT');
  input.local.selections.Other = 'DIRECT';
  assert.equal(saved.revision, 1);
  assert.deepEqual((await store.read())!.local, { selections: { Other: 'REJECT' }, rules: ['DOMAIN,synthetic.example,REJECT'] });
  await assert.rejects(store.save(settings(), 0), { code: 'WORKSPACE_CONFLICT' });
  for (const invalid of [settings({ sourceIds: ['duplicate', 'duplicate'] }), settings({ mode: 'subscription' }),
    { ...settings(), injected: true }, settings({ runMode: 'invalid' as WorkspaceSettings['runMode'] })]) {
    assert.throws(() => parseWorkspaceSettings(invalid));
  }
  let invoked = false;
  const accessor = settings();
  Object.defineProperty(accessor.local.selections, 'Proxy', { enumerable: true, get() { invoked = true; return 'DIRECT'; } });
  assert.throws(() => parseWorkspaceSettings(accessor));
  assert.equal(invoked, false);
  assert.equal((await store.read())!.revision, 1);
  await writeFile(join(store.root, 'workspace.json'), '{broken', { mode: 0o600 });
  await assert.rejects(store.read(), { code: 'WORKSPACE_CORRUPT' });
});

test('legacy migration retains manual and automatic groups and waits for an explicit scheme choice', async t => {
  const f = await fixture(t);
  await f.call('/draft', 'PUT', { expectedRevision: 0, policy: profile });
  const initial = await f.view();
  assert.equal(initial.workspace.mode, 'legacy');
  assert.equal(initial.workspace.revision, 0);
  assert.equal(initial.error, undefined);
  assert.deepEqual(initial.groups.map(group => [group.name, group.type]), [['Provider', 'select'], ['Auto', 'url-test']]);
  assert.deepEqual(initial.rules.map(rule => rule.value), profile.rules);
  assert.deepEqual(initial.workspace.local, { selections: {}, rules: [] });
  assert.deepEqual(f.events, []);
  const legacy = await f.save(withoutRevision(initial.workspace), 0);
  const active = await f.apply(legacy, null);
  assert.deepEqual((await f.candidate(active.active))['proxy-groups'], profile['proxy-groups']);
  assert.equal((await f.view()).pending, false);
});

test('full subscription and local schemes preserve their own rules and selections across switches', async t => {
  const f = await fixture(t);
  await f.source('provider', { ...profile, 'mixed-port': 9999, dns: { nameserver: ['198.51.100.53'] } });
  const fullSettings = settings({ mode: 'subscription', subscriptionId: 'provider', sourceIds: ['missing-unused'],
    subscriptionOverrides: { provider: { selections: { Provider: 'REJECT' }, rules: ['DOMAIN,override.example,DIRECT'] } } });
  const full = await f.save(fullSettings, 0);
  let view = await f.view();
  assert.equal(view.error, undefined);
  assert.equal(view.groups.find(group => group.name === 'Provider')!.selected, 'REJECT');
  assert.deepEqual(view.rules.map(rule => rule.source), ['user', 'subscription', 'subscription']);
  const fullActive = await f.apply(full, null);
  const fullConfig = await f.candidate(fullActive.active);
  assert.equal(fullConfig['tcp-concurrent'], true);
  assert.deepEqual((fullConfig['proxy-groups'] as JsonObject[])[1], (profile['proxy-groups'] as JsonObject[])[1]);
  assert.equal(fullConfig['mixed-port'], deployment.mixedPort);
  assert.equal(fullConfig.secret, deployment.controllerSecret);
  const localSettings = { ...fullSettings, mode: 'local' as const, sourceIds: ['provider'],
    local: { selections: { Other: 'DIRECT', OpenAI: 'REJECT' }, rules: ['DOMAIN,local.example,REJECT'] } };
  const local = await f.save(localSettings, full.revision);
  view = await f.view();
  assert.ok(view.ruleCount > 11_000);
  assert.deepEqual(view.rules[0], { value: 'DOMAIN,local.example,REJECT', source: 'user', editable: true });
  assert.equal(view.groups.find(group => group.name === 'Other')!.selected, 'DIRECT');
  const localActive = await f.apply(local, fullActive.active);
  assert.equal((await f.candidate(localActive.active))['tcp-concurrent'], undefined);
  const back = await f.save({ ...localSettings, mode: 'subscription', sourceIds: ['missing-unused'] }, local.revision);
  view = await f.view();
  assert.equal(view.groups.find(group => group.name === 'Provider')!.selected, 'REJECT');
  assert.deepEqual(view.workspace.local, localSettings.local);
  assert.deepEqual(view.rules.map(rule => rule.value), ['DOMAIN,override.example,DIRECT', ...profile.rules as string[]]);
  const restored = await f.apply(back, localActive.active);
  assert.equal(restored.active, fullActive.active);
});

test('revision and active CAS reject stale actions before runtime activation or selection persistence', async t => {
  const f = await fixture(t);
  const saved = await f.save(settings(), 0);
  await assert.rejects(f.save(settings({ runMode: 'direct' }), 0), { code: 'WORKSPACE_CONFLICT', status: 409 });
  const active = await f.apply(saved, null);
  const events = [...f.events];
  await assert.rejects(f.apply(saved, null), { code: 'ACTIVE_CONFLICT', status: 409 });
  await assert.rejects(f.call('/workspace/select', 'POST', { expectedRevision: saved.revision, expectedActive: null, group: 'Proxy', name: 'DIRECT' }), { code: 'ACTIVE_CONFLICT', status: 409 });
  await assert.rejects(f.call('/workspace/select', 'POST', { expectedRevision: 0, expectedActive: active.active, group: 'Proxy', name: 'DIRECT' }), { code: 'WORKSPACE_CONFLICT', status: 409 });
  assert.deepEqual(f.events, events);
  const view = await f.view();
  assert.equal(view.active, active.active);
  assert.equal(view.workspace.revision, saved.revision);
  assert.equal(view.groups.find(group => group.name === 'Proxy')!.selected, 'REJECT');
});

test('failed selection apply restores the active generation while keeping reviewable pending preferences', async t => {
  const f = await fixture(t);
  const saved = await f.save(settings(), 0);
  const active = await f.apply(saved, null);
  f.fail();
  await assert.rejects(f.call('/workspace/select', 'POST', { expectedRevision: saved.revision, expectedActive: active.active, group: 'Proxy', name: 'DIRECT' }), { code: 'ACTIVATION_FAILED', status: 503 });
  const view = await f.view();
  assert.equal(view.active, active.active);
  assert.equal(view.pending, true);
  assert.equal(view.workspace.revision, saved.revision + 1);
  assert.equal(view.workspace.local.selections.Proxy, 'DIRECT');
  assert.equal(f.events.at(-1), 'restore');
  assert.equal((await new FileTransactionStore(f.state).status()).transaction, null);
});

test('missing sources and node-only subscriptions fail explicitly without replacing the active config', async t => {
  const f = await fixture(t);
  const saved = await f.save(settings(), 0);
  const active = await f.apply(saved, null);
  const missing = await f.save(settings({ sourceIds: ['missing'] }), saved.revision);
  assert.equal((await f.view()).error, 'SOURCE_NOT_FOUND');
  await assert.rejects(f.apply(missing, active.active), { code: 'SOURCE_NOT_FOUND', status: 404 });
  await f.source('nodes', { proxies: [node] });
  const noProfile = await f.save(settings({ mode: 'subscription', subscriptionId: 'nodes' }), missing.revision);
  assert.equal((await f.view()).error, 'PROFILE_RULES_REQUIRED');
  await assert.rejects(f.apply(noProfile, active.active), { code: 'PROFILE_RULES_REQUIRED', status: 400 });
  assert.equal((await f.view()).active, active.active);
  assert.deepEqual(f.events, ['validate', 'activate', 'confirm']);
});

test('full profiles reject unknown group members, cycles and overrides of automatic groups', async t => {
  const f = await fixture(t);
  const badProfiles: JsonObject[] = [
    { ...profile, 'proxy-groups': [{ name: 'Provider', type: 'select', proxies: ['missing'] }] },
    { ...profile, 'proxy-groups': [{ name: 'Provider', type: 'select', proxies: ['Loop'] }, { name: 'Loop', type: 'select', proxies: ['Provider'] }] },
  ];
  let expectedRevision = 0;
  for (const [index, bad] of badProfiles.entries()) {
    const id = `invalid${index}`;
    await f.source(id, bad);
    const saved = await f.save(settings({ mode: 'subscription', subscriptionId: id }), expectedRevision);
    expectedRevision = saved.revision;
    assert.equal((await f.view()).error, 'GROUP_REFERENCE_INVALID');
    await assert.rejects(f.apply(saved, null), { code: 'GROUP_REFERENCE_INVALID', status: 400 });
  }
  await f.source('valid', profile);
  const automatic = await f.save(settings({ mode: 'subscription', subscriptionId: 'valid',
    subscriptionOverrides: { valid: { selections: { Auto: 'synthetic-node' }, rules: [] } } }), expectedRevision);
  assert.equal((await f.view()).error, 'GROUP_SELECTION_UNSUPPORTED');
  await assert.rejects(f.apply(automatic, null), { code: 'GROUP_SELECTION_UNSUPPORTED', status: 400 });
  assert.deepEqual(f.events, []);
});

test('refresh detects stale selection overrides and source deletion leaves the active generation intact', async t => {
  const f = await fixture(t);
  const metadata = await f.source('provider', profile);
  const saved = await f.save(settings({ mode: 'subscription', subscriptionId: 'provider',
    subscriptionOverrides: { provider: { selections: { Provider: 'synthetic-node' }, rules: [] } } }), 0);
  const active = await f.apply(saved, null);
  f.payloads.set('https://subscription.example/provider?token=EXAMPLE_ONLY_TOKEN', JSON.stringify({ proxies: [node],
    'proxy-groups': [{ name: 'Provider', type: 'select', proxies: ['DIRECT', 'REJECT'] }], rules: ['MATCH,Provider'] }));
  const refreshed = await f.call<{ revision: number }>('/sources/provider/refresh', 'POST', { expectedRevision: metadata.revision });
  assert.equal((await f.view()).error, 'GROUP_SELECTION_CONFLICT');
  await assert.rejects(f.apply(saved, active.active), { code: 'GROUP_SELECTION_CONFLICT', status: 409 });
  await f.call('/sources/provider', 'DELETE', { expectedRevision: refreshed.revision });
  const view = await f.view();
  assert.equal(view.error, 'SOURCE_NOT_FOUND');
  assert.equal(view.active, active.active);
  assert.equal(view.pending, true);
  assert.equal(view.workspace.subscriptionOverrides.provider.selections.Provider, 'synthetic-node');
  assert.deepEqual(f.events, ['validate', 'activate', 'confirm']);
});
