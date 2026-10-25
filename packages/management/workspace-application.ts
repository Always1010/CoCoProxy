import { canonicalJson, ConfigError, type Candidate, type JsonObject } from '../config/index.ts';
import { buildLocalPolicy, serviceCatalog } from '../routing/index.ts';
import { FileTransactionStore, TransactionManager } from '../transaction/index.ts';
import { SubscriptionStore, SubscriptionError } from '../subscriptions/index.ts';
import { WorkspaceStore, WorkspaceError, initialWorkspace, type RoutingOverrides, type Workspace } from './workspace.ts';
import { ManagementError, exactRecord, readJsonBody } from './http.ts';

type Plan = { workspace: Workspace; policy: JsonObject; captures: { id: string; revision: number; digest: string }[] };
const asGroups = (policy: JsonObject): JsonObject[] => Array.isArray(policy['proxy-groups']) ? policy['proxy-groups'].filter((value): value is JsonObject => !!value && typeof value === 'object' && !Array.isArray(value)) : [];
const asNodes = (policy: JsonObject): JsonObject[] => Array.isArray(policy.proxies) ? policy.proxies as JsonObject[] : [];
function invalid(code = 'WORKSPACE_INVALID'): never { throw new WorkspaceError(code); }
const emptyOverrides = (): RoutingOverrides => ({ selections: {}, rules: [] });
const settingsOf = ({ revision: _revision, ...settings }: Workspace) => settings;

/** Check group references before a candidate reaches the runtime validator. */
function checkReferences(policy: JsonObject): void {
  const groups = asGroups(policy);
  const groupNames = new Set(groups.map(group => String(group.name)));
  const names = new Set(['DIRECT', 'REJECT', 'REJECT-DROP', 'PASS', 'COMPATIBLE', ...asNodes(policy).map(node => String(node.name)), ...groupNames]);
  const references = new Map<string, string[]>();
  for (const group of groups) {
    if (!Array.isArray(group.proxies) || !group.proxies.length || group.proxies.some(name => typeof name !== 'string' || !names.has(name))) invalid('GROUP_REFERENCE_INVALID');
    references.set(String(group.name), group.proxies.filter((name): name is string => typeof name === 'string' && groupNames.has(name)));
  }
  const complete = new Set<string>(), visiting = new Set<string>();
  const visit = (name: string) => {
    if (visiting.has(name)) invalid('GROUP_REFERENCE_INVALID');
    if (complete.has(name)) return;
    visiting.add(name);
    for (const next of references.get(name) ?? []) visit(next);
    visiting.delete(name); complete.add(name);
  };
  for (const name of groupNames) visit(name);
}

function overridePolicy(input: JsonObject, edits: RoutingOverrides, runMode: Workspace['runMode'], managed = true): JsonObject {
  const policy = structuredClone(input);
  if (managed) policy.profile = { 'store-selected': false };
  const groups = asGroups(policy);
  for (const [name, selected] of Object.entries(edits.selections)) {
    const group = groups.find(group => group.name === name);
    if (!group || !Array.isArray(group.proxies) || !group.proxies.includes(selected)) invalid('GROUP_SELECTION_CONFLICT');
    // Automatic groups retain their algorithm. A manual choice uses Mihomo's
    // supported selector semantics only; it must not silently change a url-test.
    if (group.type !== 'select') invalid('GROUP_SELECTION_UNSUPPORTED');
    group.proxies = [selected, ...group.proxies.filter(value => value !== selected)];
  }
  policy['proxy-groups'] = groups;
  policy.mode = 'rule';
  const original = Array.isArray(policy.rules) ? policy.rules : [];
  policy.rules = [...edits.rules, ...original];
  if (runMode === 'direct') policy.rules = ['MATCH,DIRECT'];
  if (runMode === 'global') {
    const target = groups.find(group => group.type === 'select')?.name ?? groups[0]?.name ?? asNodes(policy)[0]?.name;
    if (typeof target !== 'string') invalid('PROFILE_NO_PROXY');
    policy.rules = [`MATCH,${target}`];
  }
  checkReferences(policy);
  return policy;
}

export function createWorkspaceApplication(options: {
  stateDirectory: string;
  subscriptions: SubscriptionStore;
  store: FileTransactionStore;
  manager: TransactionManager;
  compile: (policy: JsonObject) => Candidate;
  legacyPolicy: () => Promise<JsonObject | null>;
}) {
  const preferences = new WorkspaceStore(options.stateDirectory);
  const { subscriptions, store, manager } = options;

  async function load(): Promise<Workspace> {
    return await preferences.read() ?? initialWorkspace(await options.legacyPolicy(), (await subscriptions.list()).filter(source => source.snapshotCurrent).map(source => source.id));
  }

  async function build(workspace: Workspace): Promise<Plan> {
    const captures: Plan['captures'] = [];
    async function snapshot(id: string) {
      const metadata = await subscriptions.status(id);
      if (!metadata) throw new SubscriptionError('SOURCE_NOT_FOUND');
      const result = await subscriptions.snapshot(id, metadata.revision);
      captures.push({ id, revision: metadata.revision, digest: result.sha256 });
      return result;
    }
    let policy: JsonObject;
    if (workspace.mode === 'subscription') {
      if (!workspace.subscriptionId) invalid('PROFILE_REQUIRED');
      const source = await snapshot(workspace.subscriptionId);
      if (!source.policy || !Array.isArray(source.policy.rules) || !source.policy.rules.length) invalid('PROFILE_RULES_REQUIRED');
      policy = overridePolicy(source.policy, workspace.subscriptionOverrides[workspace.subscriptionId] ?? emptyOverrides(), workspace.runMode);
    } else {
      const base = workspace.mode === 'legacy' ? await options.legacyPolicy() : null;
      const proxies = base ? [...asNodes(base)] : [];
      const names = new Map(proxies.map(proxy => [String(proxy.name), canonicalJson(proxy)]));
      for (const id of workspace.sourceIds) {
        for (const proxy of (await snapshot(id)).proxies) {
          const existing = names.get(String(proxy.name));
          // Legacy deployments may already have imported the same snapshot.
          if (existing !== undefined && workspace.mode === 'legacy' && existing === canonicalJson(proxy)) continue;
          if (existing !== undefined) invalid('NAME_CONFLICT');
          proxies.push(proxy); names.set(String(proxy.name), canonicalJson(proxy));
        }
      }
      if (workspace.mode === 'local') {
        policy = { ...buildLocalPolicy({ proxies, selections: workspace.local.selections, rules: workspace.local.rules, mode: workspace.runMode }),
          profile: { 'store-selected': false } };
      } else {
        if (!base) invalid('PROFILE_REQUIRED');
        policy = overridePolicy({ ...base, proxies }, workspace.subscriptionOverrides.legacy ?? emptyOverrides(), workspace.runMode, workspace.revision > 0);
      }
    }
    return { workspace, policy, captures };
  }

  async function apply(workspace: Workspace, expectedActive: unknown) {
    if (!(expectedActive === null || (typeof expectedActive === 'string' && /^[a-f0-9]{64}$/.test(expectedActive)))) invalid();
    const plan = await build(workspace);
    const candidate = options.compile(plan.policy);
    // Bind the UI's exact settings and snapshots before staging; never recapture
    // an unrelated editor's latest settings as though the caller approved them.
    if ((await load()).revision !== workspace.revision) invalid('WORKSPACE_CONFLICT');
    for (const capture of plan.captures) {
      const snapshot = await subscriptions.snapshot(capture.id, capture.revision);
      if (snapshot.sha256 !== capture.digest) invalid('SOURCE_CONFLICT');
    }
    await store.stage(candidate);
    const result = await manager.apply(candidate.id, expectedActive as string | null);
    return { ...result, active: candidate.id, workspaceRevision: workspace.revision };
  }

  async function view() {
    const workspace = await load();
    const status = await store.status();
    const sources = await subscriptions.list();
    let plan: Plan | undefined, candidate: Candidate | undefined, error: string | undefined;
    try { plan = await build(workspace); candidate = options.compile(plan.policy); }
    catch (cause) {
      error = cause instanceof WorkspaceError || cause instanceof SubscriptionError || cause instanceof ConfigError ? cause.code : 'WORKSPACE_UNAVAILABLE';
    }
    const policy = plan?.policy;
    const user = workspace.mode === 'local' ? workspace.local : workspace.subscriptionOverrides[workspace.mode === 'legacy' ? 'legacy' : workspace.subscriptionId ?? ''] ?? emptyOverrides();
    const groups = policy ? asGroups(policy).map(group => ({ name: String(group.name), type: String(group.type),
      selected: String(Array.isArray(group.proxies) ? group.proxies[0] ?? '' : ''), options: Array.isArray(group.proxies) ? group.proxies as string[] : [] })) : [];
    const allRules = policy && Array.isArray(policy.rules) ? policy.rules as string[] : [];
    return { workspace, sources, active: status.active, pending: !candidate || candidate.id !== status.active,
      groups, nodes: policy ? asNodes(policy).map(proxy => String(proxy.name)) : [],
      catalog: serviceCatalog.map(({ id, name, default: enabled }) => ({ id, name, default: enabled })),
      rules: allRules.slice(0, 2000).map((value, index) => ({ value, source: workspace.runMode === 'rule' && index < user.rules.length ? 'user' :
        workspace.mode === 'local' ? 'template' : workspace.mode === 'subscription' ? 'subscription' : 'legacy', editable: index < user.rules.length && workspace.runMode === 'rule' })),
      ruleCount: allRules.length, ...(error ? { error } : {}) };
  }

  return async (request: Request): Promise<unknown> => {
    const path = new URL(request.url).pathname;
    if (path === '/api/coproxy/workspace' && request.method === 'GET') return view();
    if (path === '/api/coproxy/workspace' && request.method === 'PUT') {
      const body = exactRecord(await readJsonBody(request), ['expectedRevision', 'settings']);
      const current = await load();
      if (body.expectedRevision !== current.revision) invalid('WORKSPACE_CONFLICT');
      return { workspace: await preferences.save(body.settings, current.revision) };
    }
    if (path === '/api/coproxy/workspace/apply' && request.method === 'POST') {
      const body = exactRecord(await readJsonBody(request, 512), ['expectedRevision', 'expectedActive']);
      const workspace = await load();
      if (body.expectedRevision !== workspace.revision) invalid('WORKSPACE_CONFLICT');
      return apply(workspace, body.expectedActive);
    }
    if (path === '/api/coproxy/workspace/select' && request.method === 'POST') {
      const body = exactRecord(await readJsonBody(request, 8192), ['expectedRevision', 'expectedActive', 'group', 'name']);
      const current = await load();
      if (body.expectedRevision !== current.revision) invalid('WORKSPACE_CONFLICT');
      if (typeof body.group !== 'string' || typeof body.name !== 'string') invalid();
      if ((await store.status()).active !== body.expectedActive) invalid('ACTIVE_CONFLICT');
      const plan = await build(current);
      if (options.compile(plan.policy).id !== body.expectedActive) invalid('WORKSPACE_PENDING');
      const group = asGroups(plan.policy).find(group => group.name === body.group);
      if (!group || !Array.isArray(group.proxies) || !group.proxies.includes(body.name)) invalid('GROUP_SELECTION_CONFLICT');
      if (group.type !== 'select') invalid('GROUP_SELECTION_UNSUPPORTED');
      const settings = settingsOf(current);
      const edits = current.mode === 'local' ? settings.local : settings.subscriptionOverrides[current.mode === 'legacy' ? 'legacy' : current.subscriptionId!] ?? emptyOverrides();
      edits.selections[body.group] = body.name;
      if (current.mode !== 'local') settings.subscriptionOverrides[current.mode === 'legacy' ? 'legacy' : current.subscriptionId!] = edits;
      const next = { ...settings, revision: current.revision + 1 };
      options.compile((await build(next)).policy);
      const saved = await preferences.save(settings, current.revision);
      return apply(saved, body.expectedActive);
    }
    throw new ManagementError('NOT_FOUND', 404);
  };
}
