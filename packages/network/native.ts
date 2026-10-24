import { lstat, readlink, realpath } from 'node:fs/promises';
import { dirname } from 'node:path';
import { runNetworkCommand } from './command.ts';
import { renderNetworkPlan, type NetworkPlan } from './plan.ts';
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
type Mode = NetworkRulesOptions['mode'];
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

/** Process-local fixed operation session. No browser command interface, receipt
 * adoption, supervisor ownership, durable recovery or complete host preflight. */
export class NativeNetworkSession {
  readonly scope: 'production' | 'fixture';
  readonly plan: NetworkPlan;
  private readonly ip: string;
  private readonly nft: string;
  private readonly source: Record<Mode, NetworkRules>;
  private expectedNft = empty;
  private readonly ruleIds = new Set<number>();
  private readonly routeIds = new Set<string>();
  private mode: Mode | null = null;
  private prepared = false;
  private capture = false;
  private busy = false;
  private poisoned = false;
  private constructor(plan: NetworkPlan, ip: string, nft: string, fixtureCgroups?: NetworkRulesOptions['fixtureCgroups']) {
    this.plan = plan; this.ip = ip; this.nft = nft;
    this.scope = fixtureCgroups ? 'fixture' : 'production';
    this.source = Object.fromEntries((['blocked', 'core-only', 'active'] as const).map(mode => [mode,
      renderNetworkRules(plan.deployment, { mode, ...(fixtureCgroups ? { fixtureCgroups } : {}) })])) as Record<Mode, NetworkRules>;
  }
  static async create(input: unknown, tools: NativeNetworkTools): Promise<NativeNetworkSession> {
    if (process.platform !== 'linux' || process.geteuid?.() !== 0) fail('NETWORK_NATIVE_UNSUPPORTED');
    for (const name of ['user', 'net']) if (await readlink(`/proc/self/ns/${name}`) !== await readlink(`/proc/1/ns/${name}`)) fail('NETWORK_NATIVE_UNSUPPORTED');
    return this.build(input, tools);
  }
  /** Explicit verified-new-namespace fixture; can never create production scope. */
  static async fixture(input: unknown, tools: NativeNetworkTools, proof: { outerUser: string; outerNet: string;
    cgroups: NonNullable<NetworkRulesOptions['fixtureCgroups']> }): Promise<NativeNetworkSession> {
    if (process.platform !== 'linux' || !proof.cgroups || !/^user:\[\d+\]$/.test(proof.outerUser) || !/^net:\[\d+\]$/.test(proof.outerNet) ||
      await readlink('/proc/self/ns/user') === proof.outerUser || await readlink('/proc/self/ns/net') === proof.outerNet) fail('NETWORK_NATIVE_UNSUPPORTED');
    return this.build(input, tools, proof.cgroups);
  }
  private static async build(input: unknown, tools: NativeNetworkTools, fixtureCgroups?: NetworkRulesOptions['fixtureCgroups']) {
    const plan = immutable(renderNetworkPlan(input));
    const ip = await tool(tools.ipBinary, 'ip', !!fixtureCgroups);
    const nft = await tool(tools.nftBinary, 'nft', !!fixtureCgroups);
    const session = new NativeNetworkSession(plan, ip, nft, fixtureCgroups);
    await session.readback('absent', 'absent');
    return session;
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
  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (this.busy || this.poisoned) fail('NETWORK_SESSION_UNAVAILABLE');
    this.busy = true;
    try { return await operation(); }
    catch (error) { this.poisoned = true; throw error; }
    finally { this.busy = false; }
  }
  private async nftMode(mode: Mode): Promise<void> {
    const source = this.source[mode];
    const operation = this.mode === null ? 'create' as const : 'replace' as const;
    const scripts = [source.nft.guard[operation], source.nft.data[operation]];
    // In nft 1.0.9, --json with text --file input can silently do nothing.
    // The command-buffer argv path parses text and returns real JSON commit
    // echo. Keep it a single bounded argv, never a shell command string.
    const command = scripts.map(script => script.trim().split('\n').join('; ')).join('; ') + ';';
    if (command.length > 16_384 || /[\u0000-\u001f\u007f]/.test(command)) fail('NETWORK_BATCH_INVALID');
    const updates: NftEchoUpdate[] = scripts.map((script, index) => {
      const table = index === 0 ? 'coproxy_guard' : 'coproxy_data';
      const chains = index === 0 ? ['input_guard', 'forward_guard', 'output_guard'] : ['classify_ingress', 'classify_output', 'classify_return'];
      return { table, operation, ruleCounts: Object.fromEntries(chains.map(chain => [chain,
        script.split('\n').filter(line => line.startsWith(`add rule inet ${table} ${chain} `)).length])) };
    });
    await runNetworkCommand(this.nft, ['-c', '-j', '-n', command]);
    const echo = await runNetworkCommand(this.nft, ['-j', '-n', '-e', command]);
    const expected = nftSnapshotFromEcho(this.expectedNft, echo, updates);
    // Do not adopt an arbitrary post-operation list as its own expected value.
    const raw = await this.snapshot();
    this.membership(verifyNetworkReadback(this.plan.deployment, raw, { nft: expected, rules: this.prepared ? 'complete' : 'partial',
      routes: this.prepared ? this.capture ? 'active' : 'prepared' : 'partial' }));
    this.expectedNft = expected;
    this.mode = mode;
  }
  async installBlocked(): Promise<void> {
    return this.exclusive(async () => { await this.readback(); await this.nftMode('blocked'); });
  }
  async prepare(): Promise<void> {
    return this.exclusive(async () => {
      if (this.mode !== 'blocked' || this.prepared || this.capture) fail('NETWORK_PHASE_INVALID');
      const source = this.source.blocked;
      let observed = await this.readback('partial', 'partial');
      for (const [index, step] of source.ip.blackholes.entries()) {
        const name = 'blackhole:' + this.plan.blackholes[index].role;
        if (!observed.routesPresent.includes(name)) { await runNetworkCommand(this.ip, step.args); this.routeIds.add(name); }
        observed = await this.readback('partial', 'partial');
      }
      for (const [index, step] of source.ip.rules.entries()) {
        if (!observed.rulesPresent.includes(this.plan.rules[index].priority)) {
          await runNetworkCommand(this.ip, step.args); this.ruleIds.add(this.plan.rules[index].priority);
        }
        observed = await this.readback('partial', 'partial');
      }
      for (const [index, step] of source.ip.prepareRoutes.entries()) {
        if (!observed.routesPresent.includes('egress:' + index)) { await runNetworkCommand(this.ip, step.args); this.routeIds.add('egress:' + index); }
        observed = await this.readback('partial', 'partial');
      }
      await this.readback('complete', 'prepared');
      this.prepared = true;
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
      for (const step of this.source.active.ip.activateCapture) await runNetworkCommand(this.ip, step.args);
      this.routeIds.add('capture');
      this.capture = true;
      await this.readback();
      await this.nftMode('active');
    });
  }
  async retainBlocked(): Promise<void> {
    return this.exclusive(async () => {
      await this.readback(); await this.nftMode('blocked');
      if (this.capture) {
        for (const step of this.source.blocked.ip.withdrawCapture) await runNetworkCommand(this.ip, step.args);
        this.routeIds.delete('capture');
        this.capture = false;
      }
      const observed = await this.readback('partial', 'partial');
      for (const [index, step] of this.source.blocked.ip.blackholes.entries()) {
        const name = 'blackhole:' + this.plan.blackholes[index].role;
        if (!observed.routesPresent.includes(name)) { await runNetworkCommand(this.ip, step.args); this.routeIds.add(name); }
      }
      const retained = await this.readback('partial', 'partial');
      if (retained.routesPresent.includes('capture') || this.plan.blackholes.some(route => !retained.routesPresent.includes('blackhole:' + route.role))) fail('NETWORK_BLOCKING_UNVERIFIED');
    });
  }
  /** Current same-process readback; no persisted readiness or terminal claim. */
  async inspect() {
    return this.exclusive(async () => ({ scope: this.scope, generation: this.plan.deployment.generation,
      planSha256: this.plan.sha256, mode: this.mode, ...await this.readback(), terminalPath: 'unverified' as const }));
  }
}
