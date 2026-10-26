import { canonicalJson, ConfigError, type Candidate, type JsonObject } from '../config/index.ts';
import { buildLocalPolicy, localGroupChoices, serviceCatalog } from '../routing/index.ts';
import { FileTransactionStore, TransactionManager, TransactionError } from '../transaction/index.ts';
import { SubscriptionStore, SubscriptionError } from '../subscriptions/index.ts';
import { WorkspaceStore, WorkspaceError, initialWorkspace, parseWorkspaceSettings, type WorkspaceSettings, type RoutingOverrides, type Workspace } from './workspace.ts';
import { ManagementError, exactRecord, readJsonBody } from './http.ts';
import { describeTcpNode, probeTcpEndpoint, tcpEndpoint } from './tcp-delay.ts';
import { memoizePolicyCompiler } from './shared-work.ts';
import { createHash, randomUUID } from 'node:crypto';
import { DEFAULT_AUTO_PROBES, parseAutoProbeSettings, type AutoGroupPolicy, type AutoProbeSettings, type ProbeTarget } from './automatic-policy.ts';
import type { AutoSnapshot, ProbeResult } from './automatic-selector.ts';
import { readAutomaticBindings, writeAutomaticBindings, type AutomaticBindings } from './automatic-bindings.ts';
import { readRuntimeLifecycle } from '../runtime/lifecycle.ts';
import { selectionChanges } from '../runtime/selections.ts';
import { privateRead } from '../storage/private-files.ts';
import { SiteProbeStore, siteScope } from './site-probes.ts';

type Plan = { workspace: Workspace; policy: JsonObject; nodeDnsPolicy?: JsonObject; captures: { id: string; revision: number; digest: string }[]; legacy?: string;
  automatic: { scope: string; key: string; signatures: Record<string, string>; policies: Record<string, AutoGroupPolicy>; choices: Record<string, string[]> }; bindingKey: string };
const asGroups = (policy: JsonObject): JsonObject[] => Array.isArray(policy['proxy-groups']) ? policy['proxy-groups'].filter((value): value is JsonObject => !!value && typeof value === 'object' && !Array.isArray(value)) : [];
const asNodes = (policy: JsonObject): JsonObject[] => Array.isArray(policy.proxies) ? policy.proxies as JsonObject[] : [];
function invalid(code = 'WORKSPACE_INVALID'): never { throw new WorkspaceError(code); }
const emptyOverrides = (): RoutingOverrides => ({ selections: {}, rules: [] });
const settingsOf = ({ revision: _revision, ...settings }: Workspace) => settings;
const hash = (value: unknown) => createHash('sha256').update(canonicalJson(value as JsonObject)).digest('hex');
const scopeOf = (workspace: Workspace) => JSON.stringify([workspace.mode, workspace.mode === 'subscription' ? workspace.subscriptionId : workspace.sourceIds]);
const editsOf = (workspace: Workspace) => workspace.mode === 'local' ? workspace.local : workspace.subscriptionOverrides[workspace.mode === 'legacy' ? 'legacy' : workspace.subscriptionId ?? ''] ?? emptyOverrides();
const activePolicies = (workspace: Workspace) => Object.fromEntries(Object.entries(editsOf(workspace).automatic ?? {}).filter(([, policy]) => policy.enabled !== false));

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
  compile: (policy: JsonObject, nodeDnsPolicy?: JsonObject) => Candidate;
  legacyPolicy: () => Promise<JsonObject | null>;
  observeSelections?: () => Promise<{ generation: string; selections: Record<string, string> }>;
  allowedProbeOrigins?: readonly string[];
  automaticStatus?: () => unknown;
  automaticProbe?: (snapshot: AutoSnapshot, node: string, target: ProbeTarget) => Promise<ProbeResult>;
}) {
  const preferences = new WorkspaceStore(options.stateDirectory);
  const sites = new SiteProbeStore(options.stateDirectory, options.allowedProbeOrigins?.length !== 0);
  const { subscriptions, store, manager } = options;
  const cachedCompile = memoizePolicyCompiler(input => options.compile(input.policy as JsonObject, input.nodeDnsPolicy as JsonObject | undefined));
  const compile = (plan: Plan) => cachedCompile({ policy: plan.policy, ...(plan.nodeDnsPolicy ? { nodeDnsPolicy: plan.nodeDnsPolicy } : {}) });
  const building = new Map<string, Promise<Plan>>();
  let tcpProbes = 0;
  let testingProbes = false;
  let automaticChanging = false;
  let snapshotCache: { revision: number; generation: string; expires: number; value: AutoSnapshot } | undefined;

  function checkProbePermission(probes: AutoProbeSettings): void {
    const permitted = options.allowedProbeOrigins ?? ['https://www.gstatic.com'];
    if (![probes.primary, probes.secondary].every(target => permitted.includes(new URL(target.url).origin))) invalid('AUTO_PROBE_DENIED');
  }

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

  function build(workspace: Workspace, repair = false): Promise<Plan> {
    // Bindings may change without changing user intent/revision.
    return readAutomaticBindings(options.stateDirectory).catch(error => {
      if (Object.keys(activePolicies(workspace)).length) throw error;
      return null; // Corrupt automatic state must not prevent an explicit manual recovery.
    }).then(bindings => buildWithBindings(workspace, repair, bindings));
  }
  function buildWithBindings(workspace: Workspace, repair: boolean, bindings: AutomaticBindings | null): Promise<Plan> {
    const key = canonicalJson({ workspace: workspace as unknown as JsonObject, repair, bindings: bindings as unknown as JsonObject });
    const existing = building.get(key);
    if (existing) return existing;
    const pending = buildPlan(workspace, repair, bindings).finally(() => { building.delete(key); });
    building.set(key, pending);
    return pending;
  }

  async function buildPlan(workspace: Workspace, repair: boolean, bindings: AutomaticBindings | null): Promise<Plan> {
    const captures: Plan['captures'] = [];
    const nodeDnsPolicy: JsonObject = {};
    async function snapshot(id: string) {
      const metadata = await subscriptions.status(id);
      if (!metadata) throw new SubscriptionError('SOURCE_NOT_FOUND');
      const result = await subscriptions.snapshot(id, metadata.revision);
      captures.push({ id, revision: metadata.revision, digest: result.sha256 });
      for (const [host, resolvers] of Object.entries(result.nodeDnsPolicy ?? {})) {
        if (nodeDnsPolicy[host] !== undefined && canonicalJson(nodeDnsPolicy[host]) !== canonicalJson(resolvers)) invalid('NODE_DNS_POLICY_CONFLICT');
        nodeDnsPolicy[host] = resolvers;
      }
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
    const scope = scopeOf(workspace), policies = activePolicies(workspace);
    const signatures: Record<string, string> = Object.create(null);
    const nodes = asNodes(policy), groups = asGroups(policy);
    const choices = Object.fromEntries(groups.map(group => [String(group.name), Array.isArray(group.proxies) ? [...group.proxies] as string[] : []]));
    if (Object.keys(policies).length || workspace.autoProbes) checkProbePermission(workspace.autoProbes ?? DEFAULT_AUTO_PROBES);
    for (const [name, automatic] of Object.entries(policies)) {
      const group = groups.find(group => group.name === name);
      const pool = [...automatic.preferred, ...automatic.fallback];
      if (!group || group.type !== 'select' || !Array.isArray(group.proxies) || pool.some(target =>
        !nodes.some(node => node.name === target) || !(group.proxies as string[]).includes(target))) {
        if (repair) continue;
        invalid('AUTO_GROUP_INVALID');
      }
      signatures[name] = hash({ automatic, nodes: pool.map(target => nodes.find(node => node.name === target)) });
      const binding = bindings?.scope === scope ? bindings.targets[name] : undefined;
      const selected = binding?.signature === signatures[name] && pool.includes(binding.target) ? binding.target :
        pool.includes(String(group.proxies[0])) ? String(group.proxies[0]) : automatic.preferred[0];
      // Only concrete permitted candidates and REJECT are reachable in this group.
      group.proxies = [selected, ...pool.filter(target => target !== selected), 'REJECT'];
    }
    return { workspace, policy, captures, automatic: { scope, signatures, policies, choices,
      key: hash({ scope, policies, signatures, probes: workspace.autoProbes ?? DEFAULT_AUTO_PROBES, mode: workspace.runMode }) },
      bindingKey: hash(bindings), ...(Object.keys(nodeDnsPolicy).length ? { nodeDnsPolicy } : {}), ...(legacy ? { legacy } : {}) };
  }

  async function apply(workspace: Workspace, expectedActive: unknown, automatic = false) {
    if (!(expectedActive === null || (typeof expectedActive === 'string' && /^[a-f0-9]{64}$/.test(expectedActive)))) invalid();
    const plan = await build(workspace);
    const candidate = compile(plan);
    // Bind the UI's exact settings and snapshots before staging; never recapture
    // an unrelated editor's latest settings as though the caller approved them.
    await store.stage(candidate);
    const result = await manager.apply(candidate.id, expectedActive as string | null, async () => {
      try {
        if ((await load()).revision !== workspace.revision) invalid('WORKSPACE_CONFLICT');
        if (automatic && (await readRuntimeLifecycle(options.stateDirectory)).paused) invalid('AUTO_PAUSED');
        if (Object.keys(plan.automatic.policies).length && hash(await readAutomaticBindings(options.stateDirectory)) !== plan.bindingKey) invalid('AUTO_STATE_CONFLICT');
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
    try { plan = await build(workspace); candidate = compile(plan); }
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
      options: plan!.automatic.choices[String(group.name)] ?? [] })) : [];
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
      ruleCount: allRules.length, invalidSelections, automatic: options.automaticStatus?.() ?? { groups: [], events: [] },
      allowedProbeOrigins: [...(options.allowedProbeOrigins ?? ['https://www.gstatic.com'])], ...(error ? { error } : {}) };
  }

  async function automaticSnapshot(fresh = false): Promise<AutoSnapshot | null> {
    if (automaticChanging) return null;
    const workspace = await load();
    if (workspace.runMode === 'direct' || !Object.keys(activePolicies(workspace)).length) return null;
    const state = await store.status();
    if (!state.active || state.transaction || state.fault || !options.observeSelections) return null;
    // The 1 s decision timer normally reads only small state files. Compiling
    // the complete routing template and observing the core is bounded to 30 s;
    // every write below independently refreshes and verifies this evidence.
    if (!fresh && snapshotCache?.revision === workspace.revision && snapshotCache.generation === state.active && snapshotCache.expires > Date.now()) {
      return structuredClone(snapshotCache.value);
    }
    let plan = await build(workspace);
    if (automaticChanging) return null;
    if (compile(plan).id !== state.active) {
      // A crash can happen after the private binding is written but before the
      // configuration transaction commits. Repair only selection differences
      // belonging to automatic groups; real pending user edits stay pending.
      await store.exclusive(async () => {
        if (automaticChanging) return;
        const settled = await store.status();
        if (settled.active !== state.active || settled.transaction || settled.fault || (await load()).revision !== workspace.revision) return;
        const currentPlan = await build(workspace);
        const active = JSON.parse(await privateRead(await store.readCandidate(state.active!))) as JsonObject;
        const differences = selectionChanges(active, compile(currentPlan).config);
        if (!differences || differences.some(change => !currentPlan.automatic.policies[change.group])) return;
        const observed = await options.observeSelections!();
        if (observed.generation !== state.active) return;
        const bindings = await readAutomaticBindings(options.stateDirectory);
        const repaired: AutomaticBindings = bindings?.scope === currentPlan.automatic.scope ? structuredClone(bindings) :
          { version: 1, scope: currentPlan.automatic.scope, targets: {}, events: [] };
        for (const change of differences) {
          const committed = asGroups(active).find(group => group.name === change.group)?.proxies;
          const selected = Array.isArray(committed) ? committed[0] : null;
          const policy = currentPlan.automatic.policies[change.group];
          if (typeof selected !== 'string' || observed.selections[change.group] !== selected || ![...policy.preferred, ...policy.fallback].includes(selected)) return;
          repaired.targets[change.group] = { signature: currentPlan.automatic.signatures[change.group], target: selected };
        }
        delete repaired.pendingEvent;
        await writeAutomaticBindings(options.stateDirectory, repaired);
      });
      plan = await build(workspace);
      if (compile(plan).id !== state.active) return null;
    }
    const observed = await options.observeSelections();
    if (observed.generation !== state.active) return null;
    // The prepared event shares the durable automatic binding. Recover only
    // after the full candidate and observed controller agree with committed active.
    const journal = await readAutomaticBindings(options.stateDirectory);
    if (journal?.pendingEvent) await store.exclusive(async () => {
      const current = await readAutomaticBindings(options.stateDirectory), e = current?.pendingEvent;
      if (!current || !e || e.id !== journal.pendingEvent!.id || (await store.status()).active !== state.active || (await load()).revision !== workspace.revision) return;
      if (current.scope === plan.automatic.scope && e.revision === workspace.revision && e.signature === plan.automatic.signatures[e.group] && observed.selections[e.group] === e.to) {
        const { signature: _signature, revision: _revision, ...confirmed } = e;
        current.events = [...current.events.filter(event => event.id !== e.id), confirmed].slice(-50);
      }
      delete current.pendingEvent;
      await writeAutomaticBindings(options.stateDirectory, current);
    });
    const value = { key: plan.automatic.key, generation: state.active, probes: workspace.autoProbes ?? DEFAULT_AUTO_PROBES,
      groups: Object.entries(plan.automatic.policies).map(([name, policy]) => ({ name, current: observed.selections[name], policy }))
        .filter(group => typeof group.current === 'string' && [...group.policy.preferred, ...group.policy.fallback].includes(group.current)) };
    snapshotCache = { revision: workspace.revision, generation: state.active, expires: Date.now() + 30_000, value };
    return structuredClone(value);
  }

  async function automaticSwitch(snapshot: AutoSnapshot, name: string, target: string, reason: string): Promise<boolean> {
    if (automaticChanging) return false;
    const live = await automaticSnapshot(true);
    const source = snapshot.groups.find(group => group.name === name);
    const group = live?.groups.find(group => group.name === name);
    if (!live || !group || !source || live.key !== snapshot.key || live.generation !== snapshot.generation || group.current !== source.current ||
        ![...group.policy.preferred, ...group.policy.fallback].includes(target) || target === source.current || automaticChanging) return false;
    automaticChanging = true;
    try {
    const workspace = await load(), plan = await build(workspace);
    let before: AutomaticBindings | null = null;
    let proposed: AutomaticBindings;
    await store.exclusive(async () => {
      if ((await readRuntimeLifecycle(options.stateDirectory)).paused) throw new TransactionError('AUTO_PAUSED');
      if ((await load()).revision !== workspace.revision || (await store.status()).active !== snapshot.generation ||
          hash(await readAutomaticBindings(options.stateDirectory)) !== plan.bindingKey) throw new TransactionError('AUTO_STATE_CONFLICT');
      before = await readAutomaticBindings(options.stateDirectory);
      proposed = before?.scope === plan.automatic.scope ? structuredClone(before) : { version: 1, scope: plan.automatic.scope, targets: {}, events: [] };
      proposed.targets[name] = { signature: plan.automatic.signatures[name], target };
      proposed.pendingEvent = { id: randomUUID(), at: Date.now(), group: name, from: source.current, to: target,
        reason: /^[a-z_-]{1,80}$/i.test(reason) ? reason : 'automatic', signature: plan.automatic.signatures[name], revision: workspace.revision };
      await writeAutomaticBindings(options.stateDirectory, proposed);
    });
    try {
      await apply(workspace, snapshot.generation, true);
    } catch {
      // Roll back this binding only. A newer editor/selection must never be overwritten.
      await store.exclusive(async () => {
        const current = await readAutomaticBindings(options.stateDirectory);
        if (hash(current) === hash(proposed)) await writeAutomaticBindings(options.stateDirectory,
          before ?? { version: 1, scope: plan.automatic.scope, targets: {}, events: [] });
      });
      return false;
    }
    await store.exclusive(async () => {
      const current = await readAutomaticBindings(options.stateDirectory);
      if (current?.scope === plan.automatic.scope && current.pendingEvent?.id === proposed.pendingEvent?.id) {
        const { signature: _signature, revision: _revision, ...confirmed } = current.pendingEvent!;
        current.events = [...current.events, { ...confirmed, at: Date.now() }].slice(-50);
        delete current.pendingEvent;
        await writeAutomaticBindings(options.stateDirectory, current);
      }
    }).catch(() => { /* A confirmed switch must not be retried when event storage alone fails. */ });
    return true;
    } finally { automaticChanging = false; snapshotCache = undefined; }
  }

  async function automaticRoute(request: Request): Promise<unknown> {
    const path = new URL(request.url).pathname;
    if (path === '/api/cocoproxy/automatic/status' && request.method === 'GET') {
      const status = options.automaticStatus?.() as { groups: unknown[]; events: unknown[] } | undefined;
      const bindings = await readAutomaticBindings(options.stateDirectory);
      const current = await load();
      return { groups: status?.groups ?? [], events: bindings?.scope === scopeOf(current) ? bindings.events : status?.events ?? [] };
    }
    if (path === '/api/cocoproxy/automatic/probes' && request.method === 'GET') return { defaults: DEFAULT_AUTO_PROBES,
      allowedOrigins: [...(options.allowedProbeOrigins ?? ['https://www.gstatic.com'])] };
    if (path === '/api/cocoproxy/automatic/test' && request.method === 'POST') {
      if (!options.automaticProbe) invalid('AUTO_PROBE_UNAVAILABLE');
      if (testingProbes) invalid('AUTO_PROBE_BUSY');
      const body = exactRecord(await readJsonBody(request, 8192), ['expectedRevision', 'expectedActive', 'probes']);
      let probes: AutoProbeSettings;
      try { probes = parseAutoProbeSettings(body.probes); } catch { return invalid('AUTO_SETTINGS_INVALID'); }
      checkProbePermission(probes);
      const workspace = await load(), state = await store.status();
      if (workspace.revision !== body.expectedRevision || !state.active || state.active !== body.expectedActive || state.transaction || state.fault) invalid('WORKSPACE_CONFLICT');
      const plan = await build(workspace);
      if (compile(plan).id !== state.active || !options.observeSelections) invalid('WORKSPACE_PENDING');
      const observed = await options.observeSelections();
      if (observed.generation !== state.active) invalid('ACTIVE_CONFLICT');
      const nodes = new Set(asNodes(plan.policy).map(node => String(node.name)));
      const node = Object.values(observed.selections).find(target => nodes.has(target));
      if (!node) invalid('AUTO_PROBE_UNAVAILABLE');
      if (testingProbes) invalid('AUTO_PROBE_BUSY');
      testingProbes = true;
      try {
        const snapshot = { key: plan.automatic.key, generation: state.active, probes, groups: [] };
        const primary = await options.automaticProbe(snapshot, node, probes.primary);
        const secondary = await options.automaticProbe(snapshot, node, probes.secondary);
        if ((await load()).revision !== workspace.revision || (await store.status()).active !== state.active) invalid('WORKSPACE_CONFLICT');
        return { ok: primary.ok && secondary.ok, primary, secondary };
      } finally { testingProbes = false; }
    }
    throw new ManagementError('NOT_FOUND', 404);
  }

  const handler = async (request: Request): Promise<unknown> => {
    const path = new URL(request.url).pathname;
    if (path === '/api/cocoproxy/workspace/sites') {
      const describe = async () => {
        const current = await load();
        const settings = await sites.read();
        const scope = siteScope(current);
        const groups = asGroups((await build(current, true)).policy).map(group => String(group.name));
        return { revision: settings.revision, scope, workspaceRevision: current.revision,
          targets: sites.targets(settings).map(target => ({ ...target, permitted: sites.enabled, builtin: !target.id.startsWith('custom-') })),
          selections: settings.groups[scope] ?? {}, groups };
      };
      if (request.method === 'GET') return describe();
      if (request.method === 'PUT') {
        const body = exactRecord(await readJsonBody(request, 16384), ['expectedRevision', 'expectedWorkspaceRevision', 'scope'], ['group', 'selected', 'add', 'remove']);
        await sites.update(body.expectedRevision, async settings => {
          const current = await load();
          if (current.revision !== body.expectedWorkspaceRevision || siteScope(current) !== body.scope) throw new ManagementError('SITE_SETTINGS_CONFLICT', 409);
          if (body.remove !== undefined) {
            if (typeof body.remove !== 'string' || !settings.custom.some(target => target.id === body.remove)) throw new ManagementError('SITE_SETTINGS_INVALID');
            if (Object.values(settings.groups).some(groups => Object.values(groups).some(ids => ids.includes(body.remove as string)))) throw new ManagementError('SITE_TARGET_IN_USE', 409);
            settings.custom = settings.custom.filter(target => target.id !== body.remove);
          }
          let added: string | undefined;
          if (body.add !== undefined) {
            const target = exactRecord(body.add, ['name', 'url']);
            added = sites.add(settings, target.name, target.url).id;
          }
          if (body.group !== undefined) {
            const groups = asGroups((await build(current, true)).policy);
            if (typeof body.group !== 'string' || !groups.some(group => group.name === body.group) || !Array.isArray(body.selected)) throw new ManagementError('SITE_SETTINGS_INVALID');
            const selected = [...body.selected, ...(added ? [added] : [])];
            const targets = sites.targets(settings);
            if (selected.some(id => !targets.some(target => target.id === id && sites.enabled))) throw new ManagementError('SITE_TARGET_DENIED');
            (settings.groups[body.scope as string] ??= Object.create(null))[body.group] = selected as string[];
          } else if (body.selected !== undefined) throw new ManagementError('SITE_SETTINGS_INVALID');
        });
        return describe();
      }
    }
    if (path === '/api/cocoproxy/workspace' && request.method === 'GET') return view();
    if (path === '/api/cocoproxy/workspace/tcp-delay' && request.method === 'POST') {
      const body = exactRecord(await readJsonBody(request, 8192), ['expectedRevision', 'expectedActive', 'name', 'fingerprint']);
      if (typeof body.name !== 'string' || typeof body.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(body.fingerprint)) invalid();
      if (tcpProbes >= 8) throw new ManagementError('TCP_PROBE_BUSY', 429);
      tcpProbes++;
      try {
        const current = await load();
        if (body.expectedRevision !== current.revision) invalid('WORKSPACE_CONFLICT');
        if (!body.expectedActive || (await store.status()).active !== body.expectedActive) invalid('ACTIVE_CONFLICT');
        const plan = await build(current);
        if (compile(plan).id !== body.expectedActive) invalid('WORKSPACE_PENDING');
        const node = asNodes(plan.policy).find(node => node.name === body.name);
        if (!node || describeTcpNode(node).fingerprint !== body.fingerprint) invalid('TCP_NODE_CONFLICT');
        const endpoint = tcpEndpoint(node);
        const result = endpoint ? await probeTcpEndpoint(endpoint, request.signal) : { status: 'not-applicable', delay: null };
        if ((await load()).revision !== current.revision || (await store.status()).active !== body.expectedActive) invalid('WORKSPACE_CONFLICT');
        return { name: body.name, fingerprint: body.fingerprint, ...result, checkedAt: new Date().toISOString() };
      } finally { tcpProbes--; }
    }
    if (path === '/api/cocoproxy/workspace' && request.method === 'PUT') {
      const body = exactRecord(await readJsonBody(request), ['expectedRevision', 'settings']);
      const current = await load();
      if (body.expectedRevision !== current.revision) invalid('WORKSPACE_CONFLICT');
      const settings = await seedLegacyChoices(current, parseWorkspaceSettings(body.settings));
      // Validate automatic pools and probe permissions before persisting any settings.
      if (Object.keys(activePolicies({ ...settings, revision: current.revision })).length || settings.autoProbes) {
        await build({ ...settings, revision: current.revision });
      }
      if (settings.mode !== 'subscription' && settings.sourceIds.length !== 1 &&
          (await subscriptions.list()).some(source => source.snapshotCurrent)) invalid('SOURCE_REQUIRED');
      return { workspace: await preferences.save(settings, current.revision) };
    }
    if (path === '/api/cocoproxy/workspace/apply' && request.method === 'POST') {
      const body = exactRecord(await readJsonBody(request, 512), ['expectedRevision', 'expectedActive']);
      const workspace = await load();
      if (body.expectedRevision !== workspace.revision) invalid('WORKSPACE_CONFLICT');
      return apply(workspace, body.expectedActive);
    }
    if (path === '/api/cocoproxy/workspace/select' && request.method === 'POST') {
      const body = exactRecord(await readJsonBody(request, 8192), ['expectedRevision', 'expectedActive', 'group', 'name']);
      const current = await load();
      if (body.expectedRevision !== current.revision) invalid('WORKSPACE_CONFLICT');
      if (typeof body.group !== 'string' || typeof body.name !== 'string') invalid();
      if ((await store.status()).active !== body.expectedActive) invalid('ACTIVE_CONFLICT');
      const plan = await build(current);
      if (compile(plan).id !== body.expectedActive) invalid('WORKSPACE_PENDING');
      const settings = await seedLegacyChoices(current, settingsOf(current), plan);
      const edits = current.mode === 'local' ? settings.local : settings.subscriptionOverrides[current.mode === 'legacy' ? 'legacy' : current.subscriptionId!] ?? emptyOverrides();
      const automatic = edits.automatic?.[body.group];
      if (automatic) edits.automatic![body.group] = { ...automatic, enabled: false };
      if (current.mode !== 'local') settings.subscriptionOverrides[current.mode === 'legacy' ? 'legacy' : current.subscriptionId!] = edits;
      const group = asGroups((await build({ ...settings, revision: current.revision })).policy).find(group => group.name === body.group);
      if (!group || !Array.isArray(group.proxies) || !group.proxies.includes(body.name)) invalid('GROUP_SELECTION_CONFLICT');
      if (group.type !== 'select') invalid('GROUP_SELECTION_UNSUPPORTED');
      edits.selections[body.group] = body.name;
      if (current.mode !== 'local') settings.subscriptionOverrides[current.mode === 'legacy' ? 'legacy' : current.subscriptionId!] = edits;
      const next = { ...settings, revision: current.revision + 1 };
      compile(await build(next));
      const saved = await preferences.save(settings, current.revision);
      return apply(saved, body.expectedActive);
    }
    throw new ManagementError('NOT_FOUND', 404);
  };
  return Object.assign(handler, { automaticSnapshot, automaticSwitch, automaticRoute });
}
