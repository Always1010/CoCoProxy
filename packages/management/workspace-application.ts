import { canonicalJson, ConfigError, type Candidate, type JsonObject } from '../config/index.ts';
import { buildLocalPolicy, localGroupChoices, serviceCatalog } from '../routing/index.ts';
import { FileTransactionStore, TransactionManager, TransactionError } from '../transaction/index.ts';
import { SubscriptionStore, SubscriptionError } from '../subscriptions/index.ts';
import { WorkspaceStore, WorkspaceError, initialWorkspace, parseWorkspaceSettings, type WorkspaceSettings, type RoutingOverrides, type Workspace } from './workspace.ts';
import { ManagementError, exactRecord, readJsonBody } from './http.ts';
import { describeTcpNode, probeTcpEndpoint, tcpEndpoint } from './tcp-delay.ts';

type Plan = { workspace: Workspace; policy: JsonObject; captures: { id: string; revision: number; digest: string }[]; legacy?: string };
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

function overridePolicy(input: JsonObject, edits: RoutingOverrides, runMode: Workspace['runMode'], managed = true, repair = false): JsonObject {
  const policy = structuredClone(input);
  if (managed) policy.profile = { 'store-selected': false };
  const groups = asGroups(policy);
  for (const [name, selected] of Object.entries(edits.selections)) {
    const group = groups.find(group => group.name === name);
    if (!group || !Array.isArray(group.proxies) || !group.proxies.includes(selected)) {
      if (repair) continue;
      invalid('GROUP_SELECTION_CONFLICT');
    }
    // Automatic groups retain their algorithm. A manual choice uses Mihomo's
    // supported selector semantics only; it must not silently change a url-test.
    if (group.type !== 'select') { if (repair) continue; invalid('GROUP_SELECTION_UNSUPPORTED'); }
    group.proxies = [selected, ...group.proxies.filter(value => value !== selected)];
  }
  policy['proxy-groups'] = groups;
  policy.mode = 'rule';
  const original = Array.isArray(policy.rules) ? policy.rules : [];
  policy.rules = [...(repair ? [] : edits.rules), ...original];
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
  observeSelections?: () => Promise<{ generation: string; selections: Record<string, string> }>;
}) {
  const preferences = new WorkspaceStore(options.stateDirectory);
  const { subscriptions, store, manager } = options;
  let tcpProbes = 0;

  async function load(): Promise<Workspace> {
    return await preferences.read() ?? initialWorkspace(await options.legacyPolicy(), (await subscriptions.list()).filter(source => source.snapshotCurrent).map(source => source.id));
  }

  async function seedLegacyChoices(current: Workspace, settings: WorkspaceSettings, plan?: Plan): Promise<WorkspaceSettings> {
    if (current.mode !== 'legacy' || current.revision !== 0 || !options.observeSelections) return settings;
    // Reading the old core's selection cache is necessary only for migration;
    // later choices belong to the versioned workspace, never a second cache.
    try {
      const observed = await options.observeSelections();
      if (observed.generation !== (await store.status()).active) return settings;
      const captured = plan ?? await build(current);
      const choices: Record<string, string> = {};
      for (const group of asGroups(captured.policy)) {
        const selected = observed.selections[String(group.name)];
        if (group.type === 'select' && Array.isArray(group.proxies) && group.proxies.includes(selected)) choices[String(group.name)] = selected;
      }
      settings.subscriptionOverrides.legacy ??= emptyOverrides();
      settings.subscriptionOverrides.legacy.selections = { ...choices, ...settings.subscriptionOverrides.legacy.selections };
      const primary = choices.Proxy ?? Object.values(choices).find(selected => asNodes(captured.policy).some(node => node.name === selected));
      if (settings.mode === 'local' && !settings.local.selections.Proxy && primary &&
          canonicalJson(settings.sourceIds) === canonicalJson(current.sourceIds)) {
        for (const id of settings.sourceIds) {
          if ((await subscriptions.snapshot(id)).proxies.some(node => node.name === primary)) { settings.local.selections.Proxy = primary; break; }
        }
      }
    } catch { /* An offline core does not prevent saving a repairable draft. */ }
    return settings;
  }

  async function build(workspace: Workspace, repair = false): Promise<Plan> {
    const captures: Plan['captures'] = [];
    async function snapshot(id: string) {
      const metadata = await subscriptions.status(id);
      if (!metadata) throw new SubscriptionError('SOURCE_NOT_FOUND');
      const result = await subscriptions.snapshot(id, metadata.revision);
      captures.push({ id, revision: metadata.revision, digest: result.sha256 });
      return result;
    }
    let policy: JsonObject, legacy: string | undefined;
    if (workspace.mode === 'subscription') {
      if (!workspace.subscriptionId) invalid('PROFILE_REQUIRED');
      const source = await snapshot(workspace.subscriptionId);
      if (!source.policy || !Array.isArray(source.policy.rules) || !source.policy.rules.length) invalid('PROFILE_RULES_REQUIRED');
      policy = overridePolicy(source.policy, workspace.subscriptionOverrides[workspace.subscriptionId] ?? emptyOverrides(), workspace.runMode, true, repair);
    } else {
      const base = workspace.mode === 'legacy' ? await options.legacyPolicy() : null;
      if (base) legacy = canonicalJson(base);
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
        const selections = { ...workspace.local.selections };
        if (repair) for (const [id, selected] of Object.entries(selections)) {
          if (!localGroupChoices(proxies, id).includes(selected)) selections[id] = id === 'Proxy' ? String(proxies[0]?.name ?? 'REJECT') : id === 'Domestic' ? 'DIRECT' : 'Proxy';
        }
        policy = { ...buildLocalPolicy({ proxies, selections, rules: repair ? [] : workspace.local.rules, mode: workspace.runMode }),
          profile: { 'store-selected': false } };
      } else {
        if (!base) invalid('PROFILE_REQUIRED');
        policy = overridePolicy({ ...base, proxies }, workspace.subscriptionOverrides.legacy ?? emptyOverrides(), workspace.runMode, workspace.revision > 0, repair);
      }
    }
    return { workspace, policy, captures, ...(legacy ? { legacy } : {}) };
  }

  async function apply(workspace: Workspace, expectedActive: unknown) {
    if (!(expectedActive === null || (typeof expectedActive === 'string' && /^[a-f0-9]{64}$/.test(expectedActive)))) invalid();
    const plan = await build(workspace);
    const candidate = options.compile(plan.policy);
    // Bind the UI's exact settings and snapshots before staging; never recapture
    // an unrelated editor's latest settings as though the caller approved them.
    await store.stage(candidate);
    const result = await manager.apply(candidate.id, expectedActive as string | null, async () => {
      try {
        if ((await load()).revision !== workspace.revision) invalid('WORKSPACE_CONFLICT');
        if (plan.legacy !== undefined && canonicalJson(await options.legacyPolicy()) !== plan.legacy) invalid('DRAFT_CONFLICT');
        for (const capture of plan.captures) {
          const snapshot = await subscriptions.snapshot(capture.id, capture.revision);
          if (snapshot.sha256 !== capture.digest) invalid('SOURCE_CONFLICT');
        }
      } catch (cause) {
        throw new TransactionError(cause instanceof WorkspaceError || cause instanceof SubscriptionError ? cause.code : 'WORKSPACE_UNAVAILABLE');
      }
    });
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
      // Invalid selections/rules remain blocked for application, but retain
      // usable base options so users can repair them through the normal UI.
      try { plan = await build(workspace, true); } catch { /* missing/broken sources remain explicit errors */ }
    }
    const policy = plan?.policy;
    const user = workspace.mode === 'local' ? workspace.local : workspace.subscriptionOverrides[workspace.mode === 'legacy' ? 'legacy' : workspace.subscriptionId ?? ''] ?? emptyOverrides();
    const groups = policy ? asGroups(policy).map(group => ({ name: String(group.name), type: String(group.type),
      selected: String(Array.isArray(group.proxies) ? group.proxies[0] ?? '' : ''), activeSelected: null as string | null,
      options: Array.isArray(group.proxies) ? group.proxies as string[] : [] })) : [];
    if (status.active && options.observeSelections) {
      try {
        const observed = await options.observeSelections();
        if (observed.generation === status.active) for (const group of groups) {
          const selected = observed.selections[group.name];
          if (typeof selected === 'string') group.activeSelected = selected;
          if (candidate?.id === status.active && group.options.includes(selected)) group.selected = selected;
        }
      } catch { /* Core availability is represented separately from persisted intent. */ }
    }
    const allRules = policy && Array.isArray(policy.rules) ? policy.rules as string[] : [];
    const invalidSelections = Object.entries(user.selections).filter(([name, selected]) => {
      const group = groups.find(group => group.name === name);
      return !group || group.type !== 'select' || !group.options.includes(selected);
    }).map(([name]) => name);
    return { workspace, sources, active: status.active, pending: !candidate || candidate.id !== status.active,
      groups, nodes: policy ? asNodes(policy).map(proxy => String(proxy.name)) : [],
      tcpNodes: policy ? asNodes(policy).map(describeTcpNode) : [],
      catalog: serviceCatalog.map(({ id, name, default: enabled }) => ({ id, name, default: enabled })),
      rules: allRules.slice(0, 2000).map((value, index) => ({ value, source: !error && workspace.runMode === 'rule' && index < user.rules.length ? 'user' :
        workspace.mode === 'local' ? 'template' : workspace.mode === 'subscription' ? 'subscription' : 'legacy', editable: !error && index < user.rules.length && workspace.runMode === 'rule' })),
      ruleCount: allRules.length, invalidSelections, ...(error ? { error } : {}) };
  }

  return async (request: Request): Promise<unknown> => {
    const path = new URL(request.url).pathname;
    if (path === '/api/coproxy/workspace' && request.method === 'GET') return view();
    if (path === '/api/coproxy/workspace/tcp-delay' && request.method === 'POST') {
      const body = exactRecord(await readJsonBody(request, 8192), ['expectedRevision', 'expectedActive', 'name', 'fingerprint']);
      if (typeof body.name !== 'string' || typeof body.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(body.fingerprint)) invalid();
      if (tcpProbes >= 8) throw new ManagementError('TCP_PROBE_BUSY', 429);
      tcpProbes++;
      try {
        const current = await load();
        if (body.expectedRevision !== current.revision) invalid('WORKSPACE_CONFLICT');
        if (!body.expectedActive || (await store.status()).active !== body.expectedActive) invalid('ACTIVE_CONFLICT');
        const plan = await build(current);
        if (options.compile(plan.policy).id !== body.expectedActive) invalid('WORKSPACE_PENDING');
        const node = asNodes(plan.policy).find(node => node.name === body.name);
        if (!node || describeTcpNode(node).fingerprint !== body.fingerprint) invalid('TCP_NODE_CONFLICT');
        const endpoint = tcpEndpoint(node);
        const result = endpoint ? await probeTcpEndpoint(endpoint, request.signal) : { status: 'not-applicable', delay: null };
        if ((await load()).revision !== current.revision || (await store.status()).active !== body.expectedActive) invalid('WORKSPACE_CONFLICT');
        return { name: body.name, fingerprint: body.fingerprint, ...result, checkedAt: new Date().toISOString() };
      } finally { tcpProbes--; }
    }
    if (path === '/api/coproxy/workspace' && request.method === 'PUT') {
      const body = exactRecord(await readJsonBody(request), ['expectedRevision', 'settings']);
      const current = await load();
      if (body.expectedRevision !== current.revision) invalid('WORKSPACE_CONFLICT');
      const settings = await seedLegacyChoices(current, parseWorkspaceSettings(body.settings));
      if (settings.mode !== 'subscription' && settings.sourceIds.length !== 1 &&
          (await subscriptions.list()).some(source => source.snapshotCurrent)) invalid('SOURCE_REQUIRED');
      return { workspace: await preferences.save(settings, current.revision) };
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
      const settings = await seedLegacyChoices(current, settingsOf(current), plan);
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
