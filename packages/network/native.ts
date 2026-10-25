import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, readlink, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { privateDirectory } from '../storage/private-files.ts';
import { NetworkCommandError, runNetworkCommand } from './command.ts';
import { fencedNetworkCommandDigest, inspectFencedNetworkCommand, runFencedNetworkCommand, settleFencedNetworkCommand,
  type FencedCommandInspection, type FencedCommandScope } from './fenced-command.ts';
import { ResourceJournal, ResourceJournalError, type NativeResourceContext, type NativeResourceOperation, type NativeResourceReceipt,
  type NativeResourceState } from './resource-journal.ts';
import { renderNetworkPlan, type NetworkPlan } from './plan.ts';
import { sameNetworkProtection } from './protection.ts';
import { nftSnapshotFromEcho, verifyNetworkReadback, type NftEchoUpdate, type NetworkReadbackInput } from './readback.ts';
import { renderNetworkRules, type NetworkRules, type NetworkRulesOptions } from './rules.ts';

export class NativeNetworkError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.name = 'NativeNetworkError'; this.code = code; }
}
export interface NativeNetworkTools {
  ipBinary: '/usr/sbin/ip' | '/usr/bin/ip' | '/sbin/ip';
  nftBinary: '/usr/sbin/nft' | '/usr/bin/nft' | '/sbin/nft';
}
export interface NativeNetworkFixtureProof {
  outerUser: string;
  outerNet: string;
  cgroups: NonNullable<NetworkRulesOptions['fixtureCgroups']>;
}
/** Current observation only; neither an authority handle nor a readiness claim. */
export interface NativeNetworkPreflight {
  scope: 'production' | 'fixture';
  initialized: boolean;
  recoveryRequired: boolean;
  pending: boolean;
  revision: number;
  generation: string;
  planSha256: string;
  binding: 'absent' | 'current' | 'previous-generation';
  terminalPath: 'unverified';
}
type Mode = NetworkRulesOptions['mode'];
type PreflightPurpose = 'apply' | 'recover' | 'settle';
const empty = '{"nftables":[]}';
const fail: (code: string) => never = code => { throw new NativeNetworkError(code); };
function immutable<T>(value: T): T {
  if (value && typeof value === 'object') { for (const nested of Object.values(value)) immutable(nested); Object.freeze(value); }
  return value;
}

async function tool(path: string, name: 'ip' | 'nft', fixture: boolean): Promise<string> {
  if (![ `/usr/sbin/${name}`, `/usr/bin/${name}`, `/sbin/${name}` ].includes(path)) fail('NETWORK_TOOL_UNTRUSTED');
  const binary = await realpath(path);
  if (![`/usr/sbin/${name}`, `/usr/bin/${name}`].includes(binary)) fail('NETWORK_TOOL_UNTRUSTED');
  for (let current = binary;; current = dirname(current)) {
    const info = await lstat(current);
    if ((info.uid !== 0 && !(fixture && info.uid === 65534)) || (info.mode & 0o022) !== 0 || info.isSymbolicLink() ||
      (current === binary ? !info.isFile() || (info.mode & 0o111) === 0 : !info.isDirectory())) fail('NETWORK_TOOL_UNTRUSTED');
    if (current === '/') break;
  }
  return binary;
}

/** Fixed resource operations. Persistent sessions recover only to blocked;
 * core identity, supervisor ownership and host preflight remain separate. */
export class NativeNetworkSession {
  readonly scope: 'production' | 'fixture';
  private boundPlan: NetworkPlan;
  get plan(): NetworkPlan { return this.boundPlan; }
  private readonly ip: string;
  private readonly nft: string;
  private source: Record<Mode, NetworkRules>;
  private readonly fixtureCgroups: NetworkRulesOptions['fixtureCgroups'];
  private expectedNft = empty;
  private readonly ruleIds = new Set<number>();
  private readonly routeIds = new Set<string>();
  private mode: Mode | null = null;
  private prepared = false;
  private capture = false;
  private busy = false;
  private poisoned = false;
  private journal: ResourceJournal | null = null;
  private receipt: NativeResourceReceipt | null = null;
  private recoveryRequired = false;
  private commandScope: FencedCommandScope = 'production';
  private constructor(plan: NetworkPlan, ip: string, nft: string, fixtureCgroups?: NetworkRulesOptions['fixtureCgroups']) {
    this.boundPlan = plan; this.ip = ip; this.nft = nft;
    this.scope = fixtureCgroups ? 'fixture' : 'production';
    this.source = immutable(Object.fromEntries((['blocked', 'core-only', 'active'] as const).map(mode => [mode,
      renderNetworkRules(plan.deployment, { mode, ...(fixtureCgroups ? { fixtureCgroups } : {}) })])) as Record<Mode, NetworkRules>);
    this.fixtureCgroups = fixtureCgroups ? immutable({ core: this.source.blocked.cgroups.core.path,
      management: this.source.blocked.cgroups.management?.path ?? null }) : undefined;
  }
  static async create(input: unknown, tools: NativeNetworkTools, directory?: string): Promise<NativeNetworkSession> {
    await this.productionPlatform();
    return this.build(input, tools, undefined, directory);
  }
  /** Explicit verified-new-namespace fixture; can never create production scope. */
  static async fixture(input: unknown, tools: NativeNetworkTools, proof: NativeNetworkFixtureProof, directory?: string): Promise<NativeNetworkSession> {
    await this.fixturePlatform(proof);
    return this.build(input, tools, proof.cgroups, directory, { scope: 'fixture', outerUser: proof.outerUser, outerNet: proof.outerNet });
  }
  /** Explicit update boundary: reopen the exact old receipt, never adopt a
   * target renderer for old resources. Existing receipts still require recovery. */
  static async openForUpdate(input: unknown, tools: NativeNetworkTools, directory: string): Promise<NativeNetworkSession> {
    await this.productionPlatform();
    if (typeof directory !== 'string') fail('NETWORK_RESOURCE_STORE_UNSAFE');
    return this.build(input, tools, undefined, directory, 'production', true);
  }
  static async openForUpdateFixture(input: unknown, tools: NativeNetworkTools, proof: NativeNetworkFixtureProof,
    directory: string): Promise<NativeNetworkSession> {
    await this.fixturePlatform(proof);
    if (typeof directory !== 'string') fail('NETWORK_RESOURCE_STORE_UNSAFE');
    return this.build(input, tools, proof.cgroups, directory,
      { scope: 'fixture', outerUser: proof.outerUser, outerNet: proof.outerNet }, true);
  }
  private static async productionPlatform(): Promise<void> {
    if (process.platform !== 'linux' || process.geteuid?.() !== 0) fail('NETWORK_NATIVE_UNSUPPORTED');
    for (const name of ['user', 'net']) if (await readlink(`/proc/self/ns/${name}`) !== await readlink(`/proc/1/ns/${name}`)) fail('NETWORK_NATIVE_UNSUPPORTED');
  }
  private static async fixturePlatform(proof: NativeNetworkFixtureProof): Promise<void> {
    if (process.platform !== 'linux' || !proof.cgroups || !/^user:\[\d+\]$/.test(proof.outerUser) || !/^net:\[\d+\]$/.test(proof.outerNet) ||
      await readlink('/proc/self/ns/user') === proof.outerUser || await readlink('/proc/self/ns/net') === proof.outerNet) fail('NETWORK_NATIVE_UNSUPPORTED');
  }
  /** Strictly read-only: no directory, receipt, lock, worker or repair is created. */
  static async preflight(input: unknown, tools: NativeNetworkTools, directory?: string,
    purpose: PreflightPurpose = 'apply'): Promise<NativeNetworkPreflight> {
    return this.readOnly(input, tools, directory, purpose, false);
  }
  /** Read-only quiescence proof for the exact pending journal command; never signals. */
  static async assertSettled(input: unknown, tools: NativeNetworkTools, directory?: string): Promise<void> {
    await this.readOnly(input, tools, directory, 'recover', true);
  }
  static async preflightFixture(input: unknown, tools: NativeNetworkTools, proof: NativeNetworkFixtureProof, directory?: string,
    purpose: PreflightPurpose = 'apply'): Promise<NativeNetworkPreflight> {
    return this.readOnly(input, tools, directory, purpose, false, proof, true);
  }
  static async assertSettledFixture(input: unknown, tools: NativeNetworkTools, proof: NativeNetworkFixtureProof,
    directory?: string): Promise<void> {
    await this.readOnly(input, tools, directory, 'recover', true, proof, true);
  }
  /** Explicit worker settlement boundary. Does not advance the resource receipt
   * or repair network state; caller must durably fence before invoking it. */
  static async settlePending(input: unknown, tools: NativeNetworkTools, directory: string): Promise<void> {
    await this.settlePendingAt(input, tools, directory);
  }
  static async settlePendingFixture(input: unknown, tools: NativeNetworkTools, proof: NativeNetworkFixtureProof,
    directory: string): Promise<void> {
    if (!proof) fail('NETWORK_NATIVE_UNSUPPORTED');
    await this.settlePendingAt(input, tools, directory, proof);
  }
  private static async settlePendingAt(input: unknown, tools: NativeNetworkTools, directory: string,
    proof?: NativeNetworkFixtureProof): Promise<void> {
    if (typeof directory !== 'string') fail('NETWORK_RESOURCE_STORE_UNSAFE');
    const observed = await this.readOnly(input, tools, directory, 'settle', true, proof, !!proof);
    // Preserve the absent authority as absent, including its directory.
    if (!observed.initialized) return;
    const journal = new ResourceJournal(directory, observed.scope);
    await journal.exclusive(async () => {
      const current = await this.readOnly(input, tools, directory, 'settle', true, proof, !!proof);
      const receipt = await journal.read();
      if (!receipt || receipt.revision !== current.revision) fail('NETWORK_RESOURCE_STALE');
      if (!sameNetworkProtection(input, receipt.deployment)) fail('NETWORK_PROTECTION_CHANGE_UNSUPPORTED');
      const session = new NativeNetworkSession(immutable(renderNetworkPlan(receipt.deployment)),
        await tool(tools.ipBinary, 'ip', !!proof), await tool(tools.nftBinary, 'nft', !!proof), proof?.cgroups);
      session.commandScope = proof ? { scope: 'fixture', outerUser: proof.outerUser, outerNet: proof.outerNet } : 'production';
      if (JSON.stringify(receipt.context) !== JSON.stringify(await session.context())) fail('NETWORK_RESOURCE_CONTEXT_CHANGED');
      if (receipt.pending) {
        await session.pendingInspection(receipt, journal.root);
        const settled = await settleFencedNetworkCommand(join(journal.root, 'commands'), receipt.pending.token, session.commandScope);
        if (!['absent', 'settled'].includes(settled.state)) fail('NETWORK_COMMAND_UNSETTLED');
        // Validate the settled worker again; unknown workers are never adopted.
        const verified = await session.pendingInspection(receipt, journal.root);
        if (!['absent', 'settled'].includes(verified.state)) fail('NETWORK_COMMAND_UNSETTLED');
      }
      if (JSON.stringify(await journal.read()) !== JSON.stringify(receipt)) fail('NETWORK_RESOURCE_STALE');
      if (JSON.stringify(receipt.context) !== JSON.stringify(await session.context())) fail('NETWORK_RESOURCE_CONTEXT_CHANGED');
    });
  }
  private static async readOnly(input: unknown, tools: NativeNetworkTools, directory: string | undefined,
    purpose: PreflightPurpose, settlementOnly: boolean, proof?: NativeNetworkFixtureProof, fixture = false): Promise<NativeNetworkPreflight> {
    try {
      if (fixture) await this.fixturePlatform(proof!); else await this.productionPlatform();
      return await this.observe(input, tools, directory, purpose, settlementOnly, proof);
    } catch (error) {
      if (error instanceof NativeNetworkError || error instanceof ResourceJournalError || error instanceof NetworkCommandError) throw error;
      fail('NETWORK_PREFLIGHT_FAILED');
    }
  }
  private static async observe(input: unknown, tools: NativeNetworkTools, directory: string | undefined,
    purpose: PreflightPurpose, settlementOnly: boolean, proof?: NativeNetworkFixtureProof): Promise<NativeNetworkPreflight> {
    if (!['apply', 'recover', 'settle'].includes(purpose)) fail('NETWORK_PHASE_INVALID');
    const plan = immutable(renderNetworkPlan(input));
    const ip = await tool(tools.ipBinary, 'ip', !!proof), nft = await tool(tools.nftBinary, 'nft', !!proof);
    let session = new NativeNetworkSession(plan, ip, nft, proof?.cgroups);
    const journal = directory === undefined ? null : new ResourceJournal(directory, session.scope);
    const previous = await journal?.read() ?? null;
    if (previous) {
      if (!sameNetworkProtection(previous.deployment, plan.deployment)) fail('NETWORK_PROTECTION_CHANGE_UNSUPPORTED');
      session = new NativeNetworkSession(immutable(renderNetworkPlan(previous.deployment)), ip, nft, proof?.cgroups);
    }
    session.commandScope = proof ? { scope: 'fixture', outerUser: proof.outerUser, outerNet: proof.outerNet } : 'production';
    const context = await session.context();
    if (previous && JSON.stringify(previous.context) !== JSON.stringify(context)) fail('NETWORK_RESOURCE_CONTEXT_CHANGED');
    let pending: FencedCommandInspection | undefined;
    if (previous?.pending) {
      session.restore(previous.state);
      pending = await session.pendingInspection(previous, journal!.root);
      if (purpose !== 'settle' && !['absent', 'settled'].includes(pending.state)) fail('NETWORK_COMMAND_UNSETTLED');
    }
    if ((!settlementOnly && purpose !== 'settle') || !previous) {
      if (!previous) await session.readback('absent', 'absent');
      else {
        // Candidate expectations derive only from durable ownership and the exact
        // pending command. Listing the kernel never establishes ownership.
        const candidates: NativeResourceState[] = [previous.state];
        if (previous.pending && pending?.receipt) {
          const operation = previous.pending.operation;
          if (operation.kind === 'nft' && pending.result?.ok) {
            const expectedNft = nftSnapshotFromEcho(previous.state.expectedNft, pending.result.stdout,
              session.nftCommand(operation.mode, operation.operation).updates);
            // A successful atomic nft commit cannot still have the old handles.
            candidates[0] = { ...previous.state, expectedNft, mode: operation.mode };
          } else if (operation.kind === 'ip') {
            session.restore(previous.state); session.ipAfter(operation); candidates.push(session.state());
          }
        }
        const raw = await session.snapshot();
        const accepted = candidates.some(state => {
          session.restore(state);
          try {
            const observed = verifyNetworkReadback(session.plan.deployment, raw, { nft: state.expectedNft, rules: 'partial', routes: 'partial' });
            if (purpose === 'recover' && state.capture && !observed.routesPresent.includes('capture')) {
              session.capture = false; session.routeIds.delete('capture');
            }
            session.membership(observed); return true;
          } catch { return false; }
        });
        if (!accepted) fail('NETWORK_RESOURCE_OBSERVATION_INVALID');
      }
    }
    // This detects changes during observation. The caller still owns the global
    // writer fence; a read-only observation cannot reserve future kernel state.
    if (JSON.stringify(await journal?.read() ?? null) !== JSON.stringify(previous)) fail('NETWORK_RESOURCE_STALE');
    if (JSON.stringify(await session.context()) !== JSON.stringify(context)) fail('NETWORK_RESOURCE_CONTEXT_CHANGED');
    const binding: NativeNetworkPreflight['binding'] = previous === null ? 'absent' :
      session.plan.sha256 === plan.sha256 ? 'current' : 'previous-generation';
    return immutable({ scope: session.scope, initialized: previous !== null, recoveryRequired: previous !== null,
      pending: previous?.pending !== null && previous?.pending !== undefined, revision: previous?.revision ?? 0,
      generation: plan.deployment.generation, planSha256: plan.sha256,
      binding, terminalPath: 'unverified' as const });
  }
  private static async build(input: unknown, tools: NativeNetworkTools, fixtureCgroups?: NetworkRulesOptions['fixtureCgroups'], directory?: string,
    commandScope: FencedCommandScope = 'production', update = false) {
    const plan = immutable(renderNetworkPlan(input));
    const ip = await tool(tools.ipBinary, 'ip', !!fixtureCgroups);
    const nft = await tool(tools.nftBinary, 'nft', !!fixtureCgroups);
    let session = new NativeNetworkSession(plan, ip, nft, fixtureCgroups);
    session.commandScope = commandScope;
    if (directory === undefined) await session.readback('absent', 'absent');
    else {
      session.journal = new ResourceJournal(directory, session.scope);
      await session.journal.exclusive(async () => {
        const previous = await session.journal!.read();
        if (previous && update) {
          if (!sameNetworkProtection(previous.deployment, plan.deployment)) fail('NETWORK_PROTECTION_CHANGE_UNSUPPORTED');
          const journal = session.journal;
          session = new NativeNetworkSession(immutable(renderNetworkPlan(previous.deployment)), ip, nft, fixtureCgroups);
          session.commandScope = commandScope; session.journal = journal;
        }
        const context = await session.context();
        if (previous) {
          // Namespace/boot/tool changes require a separately reviewed migration.
          // Never import an old active receipt into a different execution domain.
          if (JSON.stringify(previous.context) !== JSON.stringify(context)) fail('NETWORK_RESOURCE_CONTEXT_CHANGED');
          session.receipt = previous;
          session.restore(previous.state);
          session.recoveryRequired = true;
        } else {
          await session.readback('absent', 'absent');
          session.receipt = await session.journal!.write({ schemaVersion: 1, revision: 0, scope: session.scope,
            context, state: session.state(), pending: null, deployment: session.plan.deployment });
        }
        await privateDirectory(join(session.journal!.root, 'commands'));
      });
    }
    return session;
  }
  private async context(): Promise<NativeResourceContext> {
    const sha = (raw: string | Buffer) => createHash('sha256').update(raw).digest('hex');
    const binary = async (path: string, name: 'ip' | 'nft') => {
      if (await tool(path, name, this.scope === 'fixture') !== path) fail('NETWORK_TOOL_UNTRUSTED');
      const before = await lstat(path);
      if (before.size > 16_777_216) fail('NETWORK_TOOL_UNTRUSTED');
      const raw = await readFile(path), after = await lstat(path);
      if (before.ino !== after.ino || before.dev !== after.dev || before.size !== raw.length ||
        before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) fail('NETWORK_TOOL_UNTRUSTED');
      return { path, sha256: sha(raw) };
    };
    return { bootID: (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim(),
      userNS: await readlink('/proc/self/ns/user'), netNS: await readlink('/proc/self/ns/net'),
      ip: await binary(this.ip, 'ip'), nft: await binary(this.nft, 'nft'), rendererSHA: sha(JSON.stringify(this.source)), planSHA: this.plan.sha256 };
  }
  private state(): NativeResourceState {
    return { expectedNft: this.expectedNft, ruleIds: [...this.ruleIds].sort((a, b) => a - b),
      routeIds: [...this.routeIds].sort(), mode: this.mode, prepared: this.prepared, capture: this.capture };
  }
  private async pendingInspection(receipt: NativeResourceReceipt, directory: string): Promise<FencedCommandInspection> {
    const pending = receipt.pending;
    if (!pending) fail('NETWORK_RESOURCE_PENDING_INVALID');
    const operation = pending.operation, binary = operation.kind === 'nft' ? this.nft : this.ip;
    const args = operation.kind === 'nft' ? ['-j', '-n', '-e', this.nftCommand(operation.mode, operation.operation).command] : this.ipStep(operation);
    if ((operation.kind === 'nft' && operation.reset) || fencedNetworkCommandDigest(binary, args) !== pending.commandSHA)
      fail('NETWORK_RESOURCE_PENDING_INVALID');
    const inspection = await inspectFencedNetworkCommand(join(directory, 'commands'), pending.token, this.commandScope);
    if (inspection.receipt) {
      const worker = inspection.receipt, context = receipt.context;
      if (worker.commandSHA !== pending.commandSHA || worker.bootID !== context.bootID || worker.userNS !== context.userNS ||
        worker.netNS !== context.netNS || worker.uid !== process.geteuid?.()) fail('NETWORK_RESOURCE_PENDING_INVALID');
    }
    return inspection;
  }
  private restore(state: NativeResourceState): void {
    this.expectedNft = state.expectedNft; this.mode = state.mode; this.prepared = state.prepared; this.capture = state.capture;
    this.ruleIds.clear(); state.ruleIds.forEach(id => this.ruleIds.add(id));
    this.routeIds.clear(); state.routeIds.forEach(id => this.routeIds.add(id));
  }
  private async save(): Promise<void> {
    if (this.journal && this.receipt) this.receipt = await this.journal.write({ ...this.receipt, state: this.state(), pending: null });
  }
  private async mutation(operation: NativeResourceOperation, binary: string, args: readonly string[]): Promise<string> {
    if (!this.journal) return runNetworkCommand(binary, args);
    if (!this.receipt || this.receipt.pending) fail('NETWORK_RECOVERY_REQUIRED');
    const token = randomUUID();
    this.receipt = await this.journal.write({ ...this.receipt, state: this.recoveryRequired ? this.receipt.state : this.state(), pending: {
      token, commandSHA: fencedNetworkCommandDigest(binary, args), operation } });
    return runFencedNetworkCommand(join(this.journal.root, 'commands'), token, binary, args, {}, this.commandScope);
  }
  private async snapshot(): Promise<NetworkReadbackInput> {
    // The tools and arguments are fixed, all values originate in validated
    // deployment data. Never use shell or accept a caller's arbitrary argv.
    const nft = await runNetworkCommand(this.nft, ['-j', '-n', '-a', 'list', 'ruleset']);
    const ipv4Rules = await runNetworkCommand(this.ip, ['-j', '-4', 'rule', 'show']);
    const ipv4Routes = await runNetworkCommand(this.ip, ['-j', '-4', 'route', 'show', 'table', 'all']);
    return { nft, ipv4Rules, ipv4Routes };
  }
  private async readback(rules: 'absent' | 'partial' | 'complete' = this.prepared ? 'complete' : 'partial',
    routes: 'absent' | 'partial' | 'prepared' | 'active' = this.prepared ? this.capture ? 'active' : 'prepared' : 'partial') {
    return this.membership(verifyNetworkReadback(this.plan.deployment, await this.snapshot(), { nft: this.expectedNft, rules, routes }));
  }
  private membership<T extends { rulesPresent: readonly number[]; routesPresent: readonly string[] }>(value: T): T {
    // A partial semantic match is not ownership. Only operations successfully
    // issued by this session may expand its known RPDB/route membership.
    if (value.rulesPresent.length !== this.ruleIds.size || value.rulesPresent.some(id => !this.ruleIds.has(id)) ||
      value.routesPresent.length !== this.routeIds.size || value.routesPresent.some(id => !this.routeIds.has(id))) fail('NETWORK_RESOURCE_MEMBERSHIP_CHANGED');
    return value;
  }
  private async exclusive<T>(operation: () => Promise<T>, recovery = false): Promise<T> {
    if (this.busy || this.poisoned) fail('NETWORK_SESSION_UNAVAILABLE');
    this.busy = true;
    try {
      const execute = async () => {
        if (this.journal) {
          const current = await this.journal.read();
          if (!current || current.revision !== this.receipt?.revision) fail('NETWORK_RESOURCE_STALE');
          if (JSON.stringify(current.context) !== JSON.stringify(await this.context())) fail('NETWORK_RESOURCE_CONTEXT_CHANGED');
        }
        if (this.recoveryRequired && !recovery) fail('NETWORK_RECOVERY_REQUIRED');
        return operation();
      };
      return this.journal ? await this.journal.exclusive(execute) : await execute();
    }
    catch (error) {
      if (!(error instanceof NativeNetworkError && error.code === 'NETWORK_RECOVERY_REQUIRED')) this.poisoned = true;
      throw error;
    }
    finally { this.busy = false; }
  }
  private nftCommand(mode: Mode, operation: 'create' | 'replace') {
    const source = this.source[mode];
    const scripts = [source.nft.guard[operation], source.nft.data[operation]];
    // In nft 1.0.9, --json with text --file input can silently do nothing.
    // The command-buffer argv path parses text and returns real JSON commit
    // echo. Keep it a single bounded argv, never a shell command string.
    const command = scripts.map(script => script.trim().split('\n').join('; ')).join('; ') + ';';
    if (command.length > 16_384 || /[\u0000-\u001f\u007f]/.test(command)) fail('NETWORK_BATCH_INVALID');
    const updates: NftEchoUpdate[] = scripts.map((script, index) => {
      const table = index === 0 ? 'cocoproxy_guard' : 'cocoproxy_data';
      const chains = index === 0 ? ['input_guard', 'forward_guard', 'output_guard'] : ['classify_ingress', 'classify_output', 'classify_return'];
      return { table, operation, ruleCounts: Object.fromEntries(chains.map(chain => [chain,
        script.split('\n').filter(line => line.startsWith(`add rule inet ${table} ${chain} `)).length])) };
    });
    return { command, updates };
  }
  private async nftMode(mode: Mode): Promise<void> {
    const operation = this.mode === null ? 'create' as const : 'replace' as const;
    const { command, updates } = this.nftCommand(mode, operation);
    await runNetworkCommand(this.nft, ['-c', '-j', '-n', command]);
    const echo = await this.mutation({ kind: 'nft', mode, operation, reset: false }, this.nft, ['-j', '-n', '-e', command]);
    const expected = nftSnapshotFromEcho(this.expectedNft, echo, updates);
    // Do not adopt an arbitrary post-operation list as its own expected value.
    const raw = await this.snapshot();
    this.membership(verifyNetworkReadback(this.plan.deployment, raw, { nft: expected, rules: this.prepared ? 'complete' : 'partial',
      routes: this.prepared ? this.capture ? 'active' : 'prepared' : 'partial' }));
    this.expectedNft = expected;
    this.mode = mode;
    await this.save();
  }
  private ipStep(operation: Extract<NativeResourceOperation, { kind: 'ip' }>): readonly string[] {
    const { category, index } = operation, ip = this.source.blocked.ip;
    const steps = category === 'blackhole' ? ip.blackholes : category === 'rule' ? ip.rules :
      category === 'egress' ? ip.prepareRoutes : category === 'capture-add' ? ip.activateCapture : ip.withdrawCapture;
    if (!steps[index]) fail('NETWORK_PHASE_INVALID');
    return steps[index].args;
  }
  private ipAfter(operation: Extract<NativeResourceOperation, { kind: 'ip' }>): void {
    const { category, index } = operation;
    if (category === 'rule') this.ruleIds.add(this.plan.rules[index].priority);
    else if (category === 'blackhole') this.routeIds.add('blackhole:' + this.plan.blackholes[index].role);
    else if (category === 'egress') this.routeIds.add('egress:' + index);
    else if (category === 'capture-add') { this.routeIds.add('capture'); this.capture = true; }
    else { this.routeIds.delete('capture'); this.capture = false; }
  }
  private async ipMutation(category: Extract<NativeResourceOperation, { kind: 'ip' }>['category'], index: number): Promise<void> {
    const operation = { kind: 'ip' as const, category, index };
    await this.mutation(operation, this.ip, this.ipStep(operation));
    this.ipAfter(operation);
    await this.readback('partial', 'partial');
    await this.save();
  }
  async installBlocked(): Promise<void> {
    return this.exclusive(async () => { await this.readback(); await this.nftMode('blocked'); });
  }
  async prepare(): Promise<void> {
    return this.exclusive(async () => {
      if (this.mode !== 'blocked' || this.capture) fail('NETWORK_PHASE_INVALID');
      if (this.prepared) { await this.readback(); return; }
      const source = this.source.blocked;
      let observed = await this.readback('partial', 'partial');
      for (const index of source.ip.blackholes.keys()) {
        const name = 'blackhole:' + this.plan.blackholes[index].role;
        if (!observed.routesPresent.includes(name)) await this.ipMutation('blackhole', index);
        observed = await this.readback('partial', 'partial');
      }
      for (const index of source.ip.rules.keys()) {
        if (!observed.rulesPresent.includes(this.plan.rules[index].priority)) {
          await this.ipMutation('rule', index);
        }
        observed = await this.readback('partial', 'partial');
      }
      for (const index of source.ip.prepareRoutes.keys()) {
        if (!observed.routesPresent.includes('egress:' + index)) await this.ipMutation('egress', index);
        observed = await this.readback('partial', 'partial');
      }
      await this.readback('complete', 'prepared');
      this.prepared = true;
      await this.save();
    });
  }
  /** Caller must freshly prove the exact core identity and socket isolation. */
  async authorizeCore(): Promise<void> {
    return this.exclusive(async () => {
      if (!this.prepared || this.mode !== 'blocked') fail('NETWORK_PHASE_INVALID');
      await this.readback(); await this.nftMode('core-only');
    });
  }
  /** Caller must freshly prove all runtime evidence immediately before invoking. */
  async activate(): Promise<void> {
    return this.exclusive(async () => {
      if (!this.prepared || this.mode !== 'core-only' || this.capture) fail('NETWORK_PHASE_INVALID');
      await this.readback();
      await this.ipMutation('capture-add', 0);
      await this.readback();
      await this.nftMode('active');
    });
  }
  async retainBlocked(): Promise<void> {
    return this.exclusive(() => this.retain());
  }
  /** Atomically transfer a recovered, blocked persistent receipt to a new
   * generation of the identical protection. No kernel command is mutated and
   * this operation confers no authority to start or authorize a core. */
  async rebind(input: unknown): Promise<void> {
    return this.exclusive(async () => {
      if (!this.journal || !this.receipt || this.receipt.pending || this.mode !== 'blocked' || this.capture) fail('NETWORK_PHASE_INVALID');
      const plan = immutable(renderNetworkPlan(input));
      if (!sameNetworkProtection(this.plan.deployment, plan.deployment)) fail('NETWORK_PROTECTION_CHANGE_UNSUPPORTED');
      const target = new NativeNetworkSession(plan, this.ip, this.nft, this.fixtureCgroups);
      // Compare every executable nft/IP form and cgroup path in every mode.
      // The renderer's generation and plan digest are metadata, not commands.
      const rendered = (source: Record<Mode, NetworkRules>) => JSON.stringify(
        Object.fromEntries((['blocked', 'core-only', 'active'] as const).map(mode => [mode,
          { scope: source[mode].scope, cgroups: source[mode].cgroups, nft: source[mode].nft, ip: source[mode].ip }])));
      if (rendered(this.source) !== rendered(target.source)) fail('NETWORK_PROTECTION_CHANGE_UNSUPPORTED');
      if (JSON.stringify(await this.journal.read()) !== JSON.stringify(this.receipt)) fail('NETWORK_RESOURCE_STALE');
      await this.readback();
      // Recheck the old binding after observation, before publishing the new
      // deployment/context/state in one atomic journal replacement.
      if (JSON.stringify(await this.context()) !== JSON.stringify(this.receipt.context)) fail('NETWORK_RESOURCE_CONTEXT_CHANGED');
      const context = await target.context();
      const { rendererSHA: _oldRenderer, planSHA: _oldPlan, ...oldDomain } = this.receipt.context;
      const { rendererSHA: _newRenderer, planSHA: _newPlan, ...newDomain } = context;
      if (JSON.stringify(oldDomain) !== JSON.stringify(newDomain)) fail('NETWORK_RESOURCE_CONTEXT_CHANGED');
      this.receipt = await this.journal.write({ ...this.receipt, deployment: plan.deployment, context, state: this.state(), pending: null });
      this.boundPlan = plan; this.source = target.source;
    });
  }
  private async retain(): Promise<void> {
    await this.readback(); await this.nftMode('blocked');
    if (this.capture) await this.ipMutation('capture-remove', 0);
    const observed = await this.readback('partial', 'partial');
    for (const index of this.source.blocked.ip.blackholes.keys()) {
      const name = 'blackhole:' + this.plan.blackholes[index].role;
      if (!observed.routesPresent.includes(name)) await this.ipMutation('blackhole', index);
    }
    const retained = await this.readback('partial', 'partial');
    if (retained.routesPresent.includes('capture') || this.plan.blackholes.some(route => !retained.routesPresent.includes('blackhole:' + route.role))) fail('NETWORK_BLOCKING_UNVERIFIED');
  }
  /** Explicit mutation boundary. Reading a receipt never restores active state. */
  async recoverBlocked(): Promise<void> {
    return this.exclusive(async () => {
      if (!this.journal || !this.receipt || !this.recoveryRequired) fail('NETWORK_PHASE_INVALID');
      const pending = this.receipt.pending;
      let after: NativeResourceState | undefined;
      if (pending) {
        const op = pending.operation;
        const binary = op.kind === 'nft' ? this.nft : this.ip;
        const args = op.kind === 'nft' ? ['-j', '-n', '-e', this.nftCommand(op.mode, op.operation).command] : this.ipStep(op);
        if ((op.kind === 'nft' && op.reset) || fencedNetworkCommandDigest(binary, args) !== pending.commandSHA) fail('NETWORK_RESOURCE_PENDING_INVALID');
        await this.pendingInspection(this.receipt, this.journal.root);
        const settled = await settleFencedNetworkCommand(join(this.journal.root, 'commands'), pending.token, this.commandScope);
        if (!['absent', 'settled'].includes(settled.state)) fail('NETWORK_COMMAND_UNSETTLED');
        if (settled.receipt) {
          const worker = settled.receipt, context = this.receipt.context;
          if (worker.commandSHA !== pending.commandSHA || worker.bootID !== context.bootID || worker.userNS !== context.userNS ||
            worker.netNS !== context.netNS || worker.uid !== process.geteuid!()) fail('NETWORK_RESOURCE_PENDING_INVALID');
          if (op.kind === 'nft') {
            if (settled.result?.ok) {
              const expectedNft = nftSnapshotFromEcho(this.expectedNft, settled.result.stdout, this.nftCommand(op.mode, op.operation).updates);
              after = { ...this.state(), expectedNft, mode: op.mode };
            }
          } else {
            this.ipAfter(op); after = this.state(); this.restore(this.receipt.state);
          }
        }
      }
      const raw = await this.snapshot();
      const accept = (state: NativeResourceState): boolean => {
        this.restore(state);
        try {
          const observed = verifyNetworkReadback(this.plan.deployment, raw, { nft: this.expectedNft, rules: 'partial', routes: 'partial' });
          // TUN destruction removes its route in the kernel. Accept only that
          // exact disappearance, solely on the path that immediately blocks.
          if (this.capture && !observed.routesPresent.includes('capture')) {
            this.capture = false; this.routeIds.delete('capture');
          }
          this.membership(observed); return true;
        } catch { return false; }
      };
      if (after && pending?.operation.kind === 'nft') {
        if (!accept(after)) fail('NETWORK_RECOVERY_UNVERIFIED');
      } else if (!accept(this.receipt.state) && !(after && accept(after))) fail('NETWORK_RECOVERY_UNVERIFIED');
      // No current listing becomes an authoritative nft reference. Missing
      // commit echo with changed rules remains an explicit recovery failure.
      const adopted = this.state();
      // Keep the last owned capture claim until blocked commits. The route's
      // exact absence will be rechecked after another crash; never publish an
      // impossible active-without-capture receipt or discard adopted membership.
      if (adopted.mode === 'active' && !adopted.capture) {
        adopted.capture = true; adopted.routeIds = [...adopted.routeIds, 'capture'].sort();
      }
      this.receipt = await this.journal.write({ ...this.receipt, state: adopted, pending: null });
      await this.nftMode('blocked');
      this.recoveryRequired = false;
      await this.retain();
    }, true);
  }
  /** Current independent readback; no persisted readiness or terminal claim. */
  async inspect() {
    return this.exclusive(async () => ({ scope: this.scope, generation: this.plan.deployment.generation,
      planSha256: this.plan.sha256, mode: this.mode, ...await this.readback(), terminalPath: 'unverified' as const }));
  }
}
