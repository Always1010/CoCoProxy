import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createServer } from 'node:net';
import { once } from 'node:events';
import type { TestContext } from 'node:test';
import type { JsonObject } from '../packages/config/index.ts';
import { FileTransactionStore } from '../packages/transaction/index.ts';
import { WorkspaceStore, parseWorkspaceSettings } from '../packages/management/workspace.ts';
import { memoizePolicyCompiler } from '../packages/management/shared-work.ts';
import { compileConfig } from '../packages/config/index.ts';
import type { Workspace, WorkspaceSettings } from '../packages/management/workspace.ts';

const deployment = { mixedPort: 17890, controllerPort: 19090, dnsPort: 15353,
  controllerSecret: 'EXAMPLE_ONLY_DEPLOYMENT_SECRET', bootstrapResolvers: ['192.0.2.53'] };
const node = { name: 'synthetic-node', type: 'socks5', server: '192.0.2.10', port: 1080 };
const profile: JsonObject = { proxies: [node],
  'proxy-groups': [
    { name: 'Provider', type: 'select', proxies: ['Auto', 'synthetic-node', 'DIRECT', 'REJECT'] },
    { name: 'Auto', type: 'url-test', proxies: ['synthetic-node'], url: 'https://probe.example/generate_204', interval: 300, tolerance: 50 },
  ], rules: ['DOMAIN-SUFFIX,provider.example,Provider', 'MATCH,Provider'], 'tcp-concurrent': true };

test('compiled policy reuse is immutable and invalidates on content even at the same workspace revision', () => {
  let compilations = 0;
  const compile = memoizePolicyCompiler(policy => {
    compilations++;
    return compileConfig({ schemaVersion: 1, deployment, policy });
  });
  const policy: JsonObject = { rules: ['MATCH,DIRECT'] };
  const first = compile(policy);
  assert.equal(compile(structuredClone(policy)), first);
  assert.throws(() => (first.config.rules as string[]).push('MATCH,REJECT'), TypeError);
  policy.rules = ['MATCH,REJECT'];
  assert.notEqual(compile(policy).id, first.id);
  assert.equal(compilations, 2);
  assert.throws(() => compile({ dns: {} }));
  assert.equal(compile(policy).id, compile(policy).id);
  assert.equal(compilations, 3); // Failed compilations never replace the last verified entry.
  compile({ rules: ['MATCH,DIRECT'], extension: null });
  for (const extension of [Infinity, NaN]) assert.throws(() => compile({ rules: ['MATCH,DIRECT'], extension }), { code: 'INVALID_INPUT' });
  let invoked = false;
  const accessor: JsonObject = { rules: ['MATCH,DIRECT'] };
  Object.defineProperty(accessor, 'extension', { enumerable: true, get: () => { invoked = true; return null; } });
  assert.throws(() => compile(accessor), { code: 'INVALID_INPUT' });
  assert.equal(invoked, false);
});

function settings(changes: Partial<WorkspaceSettings> = {}): WorkspaceSettings {
  return { mode: 'local', subscriptionId: null, sourceIds: [], runMode: 'rule',
    local: { selections: {}, rules: [] }, subscriptionOverrides: {}, ...changes };
}
function withoutRevision({ revision: _revision, ...value }: Workspace): WorkspaceSettings { return value; }
type View = { workspace: Workspace; active: string | null; pending: boolean; error?: string;
  groups: { name: string; type: string; selected: string; activeSelected: string | null; options: string[] }[];
  nodes: string[]; tcpNodes: { name: string; fingerprint: string; applicable: boolean }[];
  rules: { value: string; source: string; editable: boolean }[]; ruleCount: number; invalidSelections: string[] };

async function directory(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'cocoproxy-workspace-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function fixture(t: TestContext, deploymentOverrides: JsonObject = {}) {
  // Keep the pure settings/store test runnable without the optional YAML runtime.
  const [{ createManagementApplication }, { decodeSubscriptionProfile }] = await Promise.all([
    import('../packages/management/application.ts'), import('../packages/subscriptions/yaml.ts'),
  ]);
  const root = await directory(t), state = join(root, 'state');
  const payloads = new Map<string, string>();
  const events: string[] = [];
  let failActivation = false;
  let observedChoices: Record<string, string> | null = null;
  const runtime = {
    validate: async () => { events.push('validate'); },
    activate: async () => { events.push('activate'); if (failActivation) throw new Error('EXAMPLE_ONLY_RUNTIME_DIAGNOSTIC'); },
    confirm: async () => { events.push('confirm'); return true; },
    restore: async () => { events.push('restore'); },
    observe: async (generation: string) => ({ ready: true, generation, checkedAt: new Date().toISOString(), reason: null }),
  };
  const action = createManagementApplication({ stateDirectory: state, deployment: { ...deployment, ...deploymentOverrides }, runtime,
    observeSelections: async () => {
      const generation = (await new FileTransactionStore(state).status()).active;
      if (!generation || !observedChoices) throw new Error('Synthetic core unavailable');
      return { generation, selections: observedChoices };
    },
    sourceDecoder: decodeSubscriptionProfile, sourceClient: { fetch: async url => {
      const text = payloads.get(url);
      if (text === undefined) throw new Error('Synthetic source missing');
      return { status: 'modified' as const, text };
    } } });
  async function call<T = unknown>(path: string, method = 'GET', body?: unknown): Promise<T> {
    const request = new Request(`https://management.example/api/cocoproxy${path}`, { method,
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
  return { state, events, call, view, save, apply, source, candidate, payloads, fail: () => { failActivation = true; },
    observe: (choices: Record<string, string>) => { observedChoices = choices; } };
}

test('workspace binds private node DNS to captured sources in local and subscription modes', async t => {
  const f = await fixture(t);
  const resolver = 'https://resolver.example/private/EXAMPLE_ONLY_TOKEN';
  const input = { ...profile, proxies: [{ ...node, server: 'entry.example' }],
    dns: { 'nameserver-policy': { 'entry.example': resolver } } };
  await f.source('provider', input);
  const saved = await f.save(settings({ sourceIds: ['provider'] }), 0);
  const active = await f.apply(saved, null);
  assert.deepEqual(((await f.candidate(active.active)).dns as JsonObject)['proxy-server-nameserver-policy'], { 'entry.example': [resolver] });
  assert.equal(JSON.stringify(await f.view()).includes('EXAMPLE_ONLY_TOKEN'), false);
  assert.equal((await f.view()).pending, false);
  const full = await f.save(settings({ mode: 'subscription', subscriptionId: 'provider' }), saved.revision);
  const next = await f.apply(full, active.active);
  assert.deepEqual(((await f.candidate(next.active)).dns as JsonObject)['proxy-server-nameserver-policy'], { 'entry.example': [resolver] });
  const admin = await fixture(t, { nodeNameserverPolicy: { 'entry.example': ['https://admin.example/dns-query'] } });
  await admin.source('provider', input);
  const configured = await admin.save(settings({ sourceIds: ['provider'] }), 0);
  const overridden = await admin.apply(configured, null);
  assert.deepEqual(((await admin.candidate(overridden.active)).dns as JsonObject)['proxy-server-nameserver-policy'], { 'entry.example': ['https://admin.example/dns-query'] });
});

test('conflicting node DNS from multiple sources blocks application without leaking resolver paths', async t => {
  const f = await fixture(t);
  for (const [id, resolver] of [['first', 'https://one.example/EXAMPLE_ONLY_PRIVATE'], ['second', 'https://two.example/EXAMPLE_ONLY_PRIVATE']]) {
    const metadata = await f.source(id, { proxies: [{ ...node, name: id, server: 'entry.example' }], rules: ['MATCH,DIRECT'], dns: { 'nameserver-policy': { 'entry.example': resolver } } });
    assert.equal((metadata as unknown as { snapshotCurrent: boolean }).snapshotCurrent, true);
  }
  // Older persisted workspaces may contain multiple sources; the current UI
  // permits one source, but compilation must still reject ambiguous DNS.
  const saved = await new WorkspaceStore(f.state).save(settings({ sourceIds: ['first', 'second'] }), 0);
  await assert.rejects(f.apply(saved, null), { code: 'NODE_DNS_POLICY_CONFLICT' });
  assert.equal(f.events.length, 0);
});

test('refresh keeps a local node source as nodes while recovering dedicated DNS from a full upstream file', async t => {
  const f = await fixture(t);
  await f.source('provider', { proxies: [{ ...node, server: 'entry.example' }] });
  const saved = await f.save(settings({ sourceIds: ['provider'] }), 0);
  const initial = await f.apply(saved, null);
  const url = [...f.payloads.keys()][0];
  f.payloads.set(url, JSON.stringify({ proxies: [{ ...node, server: 'entry.example' }], mode: 'Rule',
    rules: ['GEOIP,CN,DIRECT', 'MATCH,REJECT'], dns: { 'nameserver-policy': { 'entry.example': 'https://resolver.example/EXAMPLE_ONLY_PRIVATE' } } }));
  const view = await f.view();
  const sources = await f.call<{ sources: { id: string; revision: number }[] }>('/sources');
  const refreshed = await f.call<{ kind: string }>('/sources/provider/refresh', 'POST', { expectedRevision: sources.sources[0].revision });
  assert.equal(refreshed.kind, 'nodes');
  const active = await f.apply(view.workspace, initial.active);
  const candidate = await f.candidate(active.active);
  assert.deepEqual((candidate.dns as JsonObject)['proxy-server-nameserver-policy'], { 'entry.example': ['https://resolver.example/EXAMPLE_ONLY_PRIVATE'] });
  assert.ok((candidate.rules as string[]).includes('RULE-SET,cocoproxy-domestic-domain-v2,Domestic'));
});

test('workspace TCP tests bind to the active node and revision without applying configuration', async t => {
  const server = createServer(socket => socket.resume());
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const f = await fixture(t);
  const port = (server.address() as { port: number }).port;
  await f.source('tcp-source', { proxies: [{ name: 'tcp-test-node', type: 'socks5', server: '127.0.0.1', port }] });
  const current = await f.view();
  const saved = await f.save(settings({ sourceIds: ['tcp-source'] }), current.workspace.revision);
  await f.apply(saved, current.active);
  const view = await f.view();
  const metadata = view.tcpNodes[0];
  const body = { expectedRevision: view.workspace.revision, expectedActive: view.active, name: metadata.name, fingerprint: metadata.fingerprint };
  const before = f.events.length;
  const result = await f.call<{ status: string; delay: number; fingerprint: string }>('/workspace/tcp-delay', 'POST', body);
  assert.equal(result.status, 'success');
  assert.ok(result.delay >= 0);
  assert.equal(result.fingerprint, metadata.fingerprint);
  assert.equal(f.events.length, before);
  assert.equal((await f.view()).workspace.revision, view.workspace.revision);
  assert.deepEqual(Object.keys(metadata).sort(), ['applicable', 'fingerprint', 'name']);
  await assert.rejects(f.call('/workspace/tcp-delay', 'POST', { ...body, name: 'foreign-node' }), { code: 'TCP_NODE_CONFLICT' });
  await assert.rejects(f.call('/workspace/tcp-delay', 'POST', { ...body, fingerprint: '0'.repeat(64) }), { code: 'TCP_NODE_CONFLICT' });
  await assert.rejects(f.call('/workspace/tcp-delay', 'POST', { ...body, expectedRevision: -1 }), { code: 'WORKSPACE_CONFLICT' });
  await assert.rejects(f.call('/workspace/tcp-delay', 'POST', { ...body, host: '192.0.2.20' }), { code: 'INVALID_REQUEST' });
});

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

test('opening the new workspace keeps an already applied legacy config current without creating preferences', async t => {
  const f = await fixture(t);
  await f.call('/draft', 'PUT', { expectedRevision: 0, policy: profile });
  const staged = await f.call<{ generation: string }>('/stage', 'POST', { expectedRevision: 1 });
  await f.call('/apply', 'POST', { generation: staged.generation, expectedActive: null });
  const before = [...f.events];
  const opened = await f.view();
  assert.equal(opened.active, staged.generation);
  assert.equal(opened.pending, false);
  assert.equal(opened.workspace.revision, 0);
  assert.deepEqual(f.events, before);
  assert.equal(await new WorkspaceStore(f.state).read(), null);
});

test('legacy runtime cache choices are displayed and captured before managed migration', async t => {
  const f = await fixture(t);
  const second = { ...node, name: 'second-node' };
  const legacy = { proxies: [node, second], 'proxy-groups': [{ name: 'Proxy', type: 'select', proxies: ['synthetic-node', 'second-node'] }], rules: ['MATCH,Proxy'] };
  await f.source('provider', { proxies: [node, second] });
  await f.call('/draft', 'PUT', { expectedRevision: 0, policy: legacy });
  const staged = await f.call<{ generation: string }>('/stage', 'POST', { expectedRevision: 1 });
  await f.call('/apply', 'POST', { generation: staged.generation, expectedActive: null });
  f.observe({ Proxy: 'second-node' });
  const opened = await f.view();
  assert.equal(opened.pending, false);
  assert.equal(opened.groups[0].selected, 'second-node');
  assert.deepEqual(opened.workspace.subscriptionOverrides.legacy.selections, {});
  const migrated = await f.save({ ...withoutRevision(opened.workspace), mode: 'local' }, 0);
  assert.equal(migrated.local.selections.Proxy, 'second-node');
  assert.equal(migrated.subscriptionOverrides.legacy.selections.Proxy, 'second-node');
  const active = await f.apply(migrated, staged.generation);
  assert.equal((((await f.candidate(active.active))['proxy-groups'] as JsonObject[])[0].proxies as string[])[0], 'second-node');
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
    local: { selections: { Other: 'DIRECT', Overseas: 'REJECT', OpenAI: 'REJECT' }, rules: ['DOMAIN,local.example,REJECT'] } };
  const local = await f.save(localSettings, full.revision);
  view = await f.view();
  assert.ok(view.rules.some(rule => rule.value === 'RULE-SET,cocoproxy-domestic-domain-v2,Domestic'));
  assert.ok(view.rules.some(rule => rule.value === 'RULE-SET,cocoproxy-overseas-domain-v1,Overseas'));
  assert.deepEqual(view.rules[0], { value: 'DOMAIN,local.example,REJECT', source: 'user', editable: true });
  assert.equal(view.groups.find(group => group.name === 'Other')!.selected, 'DIRECT');
  assert.equal(view.groups.find(group => group.name === 'Overseas')!.selected, 'REJECT');
  const localActive = await f.apply(local, fullActive.active);
  assert.equal((await f.candidate(localActive.active))['tcp-concurrent'], true);
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
  f.observe({ Proxy: 'REJECT' });
  f.fail();
  await assert.rejects(f.call('/workspace/select', 'POST', { expectedRevision: saved.revision, expectedActive: active.active, group: 'Proxy', name: 'DIRECT' }), { code: 'ACTIVATION_FAILED', status: 503 });
  const view = await f.view();
  assert.equal(view.active, active.active);
  assert.equal(view.pending, true);
  assert.equal(view.workspace.revision, saved.revision + 1);
  assert.equal(view.workspace.local.selections.Proxy, 'DIRECT');
  assert.equal(view.groups.find(group => group.name === 'Proxy')!.activeSelected, 'REJECT');
  assert.equal(view.groups.find(group => group.name === 'Proxy')!.selected, 'DIRECT');
  assert.equal(f.events.at(-1), 'restore');
  assert.equal((await new FileTransactionStore(f.state).status()).transaction, null);
});

test('available subscriptions require one current local source and reject cancellation without changing preferences', async t => {
  const f = await fixture(t);
  await f.source('provider', profile);
  await f.source('replacement', profile);
  await f.call('/draft', 'PUT', { expectedRevision: 0, policy: profile });
  const initial = await f.view();
  assert.equal(initial.workspace.mode, 'legacy');
  assert.deepEqual(initial.workspace.sourceIds, ['provider']);
  await assert.rejects(f.save(settings(), initial.workspace.revision), { code: 'SOURCE_REQUIRED', status: 400 });
  assert.deepEqual((await f.view()).workspace.sourceIds, ['provider']);
  const saved = await f.save(settings({ sourceIds: ['provider'] }), initial.workspace.revision);
  const next = await f.save(settings({ sourceIds: ['replacement'] }), saved.revision);
  assert.deepEqual(next.sourceIds, ['replacement']);
  const activeSource = await f.call<{ source: { revision: number } }>('/sources/replacement');
  await assert.rejects(f.call('/sources/replacement', 'DELETE', { expectedRevision: activeSource.source.revision }), { code: 'SOURCE_IN_USE', status: 409 });
  const previousSource = await f.call<{ source: { revision: number } }>('/sources/provider');
  await f.call('/sources/provider', 'DELETE', { expectedRevision: previousSource.source.revision });
  assert.deepEqual((await f.view()).workspace.sourceIds, ['replacement']);
});

test('workspace and source changes between capture and transaction entry reject stale activation', async t => {
  const f = await fixture(t);
  const metadata = await f.source('provider', profile);
  const saved = await f.save(settings({ mode: 'subscription', subscriptionId: 'provider' }), 0);
  const stage = FileTransactionStore.prototype.stage;
  let mutation: (() => Promise<unknown>) | null = () => f.save(settings({ sourceIds: ['provider'] }), saved.revision);
  FileTransactionStore.prototype.stage = async function(candidate) {
    const result = await stage.call(this, candidate);
    if (this.root === f.state && mutation) { const mutate = mutation; mutation = null; await mutate(); }
    return result;
  };
  try {
    await assert.rejects(f.apply(saved, null), { code: 'WORKSPACE_CONFLICT', status: 409 });
    const current = (await f.view()).workspace;
    const reset = await f.save(settings({ mode: 'subscription', subscriptionId: 'provider' }), current.revision);
    mutation = () => f.call('/sources/provider', 'PUT', { expectedRevision: metadata.revision, name: 'renamed-provider' });
    await assert.rejects(f.apply(reset, null), { code: 'SOURCE_CONFLICT', status: 409 });
    assert.deepEqual(f.events, []);
    const status = await new FileTransactionStore(f.state).status();
    assert.equal(status.active, null);
    assert.equal(status.transaction, null);
  } finally { FileTransactionStore.prototype.stage = stage; }
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

test('refresh detects stale selections and protects the current source without replacing the active generation', async t => {
  const f = await fixture(t);
  const metadata = await f.source('provider', profile);
  const saved = await f.save(settings({ mode: 'subscription', subscriptionId: 'provider',
    subscriptionOverrides: { provider: { selections: { Provider: 'synthetic-node' }, rules: [] } } }), 0);
  const active = await f.apply(saved, null);
  f.payloads.set('https://subscription.example/provider?token=EXAMPLE_ONLY_TOKEN', JSON.stringify({ proxies: [node],
    'proxy-groups': [{ name: 'Provider', type: 'select', proxies: ['DIRECT', 'REJECT'] }], rules: ['MATCH,Provider'] }));
  const refreshed = await f.call<{ revision: number }>('/sources/provider/refresh', 'POST', { expectedRevision: metadata.revision });
  const repair = await f.view();
  assert.equal(repair.error, 'GROUP_SELECTION_CONFLICT');
  assert.deepEqual(repair.groups.find(group => group.name === 'Provider')!.options, ['DIRECT', 'REJECT']);
  assert.deepEqual(repair.invalidSelections, ['Provider']);
  await assert.rejects(f.apply(saved, active.active), { code: 'GROUP_SELECTION_CONFLICT', status: 409 });
  await assert.rejects(f.call('/sources/provider', 'DELETE', { expectedRevision: refreshed.revision }), { code: 'SOURCE_IN_USE', status: 409 });
  const view = await f.view();
  assert.equal(view.error, 'GROUP_SELECTION_CONFLICT');
  assert.equal(view.active, active.active);
  assert.equal(view.pending, true);
  assert.equal(view.workspace.subscriptionOverrides.provider.selections.Provider, 'synthetic-node');
  assert.deepEqual(f.events, ['validate', 'activate', 'confirm']);
});
