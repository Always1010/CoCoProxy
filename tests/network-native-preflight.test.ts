import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import test, { mock } from 'node:test';
import { fencedNetworkCommandDigest, type FencedCommandInspection } from '../packages/network/fenced-command.ts';
import { ResourceJournalError, type NativeResourceReceipt } from '../packages/network/resource-journal.ts';
import { renderNetworkPlan, type NetworkPlanInput } from '../packages/network/plan.ts';
import { renderNetworkRules } from '../packages/network/rules.ts';
import { nftSnapshotFromEcho } from '../packages/network/readback.ts';
import { sameNetworkProtection } from '../packages/network/protection.ts';

// Module mocks are confined to a child process; no production dependency
// injection or host Linux/network access is needed for these boundary tests.
if (!process.env.COCOPROXY_NATIVE_PREFLIGHT_MOCKS) {
  test('native read-only preflight boundary fixtures', () => {
    const child = spawnSync(process.execPath, ['--experimental-strip-types', '--experimental-test-module-mocks', '--test',
      fileURLToPath(import.meta.url)], { encoding: 'utf8', windowsHide: true,
      env: { ...process.env, COCOPROXY_NATIVE_PREFLIGHT_MOCKS: '1' } });
    assert.equal(child.status, 0, child.stdout + child.stderr);
  });
} else {
  const deployment: NetworkPlanInput = { schemaVersion: 1, generation: 'a'.repeat(64),
    core: { serviceUid: 12345, binarySha256: 'b'.repeat(64), unitSha256: 'c'.repeat(64) },
    ingressInterface: 'lan-test', gatewayIPv4: '192.0.2.2', prefixLength: 24,
    routerIPv4: '192.0.2.1', routerMAC: '02:00:00:00:00:01', clientIPv4: '192.0.2.3', dnsPort: 15353,
    tun: { interface: 'cocoproxy-tun', mtu: 1500 }, marks: { mask: 0xff00, capture: 0x100, egress: 0x200, return: 0x300 },
    tables: { capture: 10003, egress: 10002, return: 10001 }, priorities: { capture: 10003, egress: 10002, return: 10001 } };
  const plan = renderNetworkPlan(deployment);
  const proof = { outerUser: 'user:[100]', outerNet: 'net:[101]', cgroups: { core: '/fixture/core', management: null } };
  const tools = { ipBinary: '/usr/sbin/ip', nftBinary: '/usr/sbin/nft' } as const;
  const builtin = [{ priority: 0, src: 'all', table: 'local' }, { priority: 32766, src: 'all', table: 'main' },
    { priority: 32767, src: 'all', table: 'default' }];
  const sha = (raw: string) => createHash('sha256').update(raw).digest('hex');
  let receipt: NativeResourceReceipt | null = null, inspection: FencedCommandInspection = { state: 'absent' };
  let rules: unknown[] = builtin, routes: unknown[] = [], nft = '{"nftables":[]}', reads = 0, drift = false, snapshots = 0;
  let writable = false, writes = 0, mutations = 0, locks = 0, failWrite = false, handle = 10;
  const forbidden = () => { throw new Error('forbidden mutation'); };
  Object.defineProperty(process, 'platform', { value: 'linux' });
  Object.defineProperty(process, 'geteuid', { value: () => 0 });
  mock.module('node:fs/promises', { namedExports: {
    realpath: async (path: string) => path,
    lstat: async (path: string) => ({ uid: 0, mode: 0o755, ino: 1, dev: 1, size: path.endsWith('/ip') ? 12 : 13,
      mtimeMs: 0, ctimeMs: 0, isSymbolicLink: () => false, isDirectory: () => true, isFile: () => true }),
    readlink: async (path: string) => path.endsWith('/user') ? 'user:[200]' : 'net:[201]',
    readFile: async (path: string) => path.endsWith('boot_id') ? 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' :
      Buffer.from(path.endsWith('/ip') ? 'synthetic-ip' : 'synthetic-nft'),
  } });
  mock.module('../packages/storage/private-files.ts', { namedExports: { privateDirectory: async () => { if (!writable) forbidden(); } } });
  mock.module('../packages/network/resource-journal.ts', { namedExports: { ResourceJournalError,
    ResourceJournal: class {
      root: string;
      constructor(root: string) { this.root = root; }
      async read() { reads++; return receipt && drift && reads > 1 ? { ...receipt, revision: receipt.revision + 1 } : receipt; }
      async exclusive<T>(operation: () => Promise<T>): Promise<T> { if (!writable) forbidden(); locks++; return operation(); }
      async write(value: NativeResourceReceipt) {
        if (!writable) forbidden();
        if (failWrite) throw new ResourceJournalError('NETWORK_RESOURCE_STORE_IO');
        writes++; receipt = structuredClone({ ...value, revision: value.revision + 1 }); return receipt;
      }
    },
  } });
  mock.module('../packages/network/command.ts', { namedExports: {
    NetworkCommandError: class extends Error {},
    runNetworkCommand: async (_binary: string, args: string[]) => {
      snapshots++;
      if (JSON.stringify(args) === JSON.stringify(['-j', '-n', '-a', 'list', 'ruleset'])) return nft;
      if (JSON.stringify(args) === JSON.stringify(['-j', '-4', 'rule', 'show'])) return JSON.stringify(rules);
      if (JSON.stringify(args) === JSON.stringify(['-j', '-4', 'route', 'show', 'table', 'all'])) return JSON.stringify(routes);
      if (writable && args[0] === '-c') return '';
      return forbidden();
    },
  } });
  mock.module('../packages/network/fenced-command.ts', { namedExports: { fencedNetworkCommandDigest,
    inspectFencedNetworkCommand: async () => inspection,
    settleFencedNetworkCommand: async () => {
      if (!writable) return forbidden();
      mutations++; return inspection.state === 'running' ? (inspection = { ...inspection, state: 'settled' }) : inspection;
    },
    runFencedNetworkCommand: async (_directory: string, _token: string, binary: string, args: string[]) => {
      if (!writable) return forbidden();
      mutations++;
      if (binary.endsWith('/ip')) {
        const blackhole = plan.blackholes.find(route => args.includes(String(route.table)));
        assert.ok(blackhole); routes.push({ type: 'blackhole', dst: 'default', table: blackhole.table,
          protocol: 186, metric: blackhole.metric, flags: [] }); return '';
      }
      const create = args[3].includes('add table inet cocoproxy_guard'), echo: unknown[] = [];
      const source = renderNetworkRules(deployment, { mode: 'blocked', fixtureCgroups: proof.cgroups });
      const definitions: Record<string, [string, string, string, number][]> = { cocoproxy_guard: [
        ['input_guard', 'filter', 'input', -10], ['forward_guard', 'filter', 'forward', -10], ['output_guard', 'filter', 'output', -10]],
      cocoproxy_data: [['classify_ingress', 'filter', 'prerouting', -150], ['classify_output', 'route', 'output', -150],
        ['classify_return', 'filter', 'prerouting', -149]] };
      const updates = Object.entries(definitions).map(([table, chains]) => {
        assert.ok(table === 'cocoproxy_guard' || table === 'cocoproxy_data');
        if (create) echo.push({ add: { table: { family: 'inet', name: table, handle: handle++ } } });
        const ruleCounts: Record<string, number> = {};
        for (const [name, type, hook, prio] of chains) {
          if (create) echo.push({ add: { chain: { family: 'inet', table, name, type, hook, prio, policy: 'accept', handle: handle++ } } });
          else echo.push({ flush: { chain: { family: 'inet', table, name } } });
          const script = table === 'cocoproxy_guard' ? source.nft.guard.create : source.nft.data.create;
          ruleCounts[name] = script.split('\n').filter(line => line.startsWith(`add rule inet ${table} ${name} `)).length;
          for (let index = 0; index < ruleCounts[name]; index++) echo.push({ add: { rule: { family: 'inet', table,
            chain: name, handle: handle++, expr: [{ drop: null }] } } });
        }
        return { table: table as 'cocoproxy_guard' | 'cocoproxy_data', operation: create ? 'create' as const : 'replace' as const, ruleCounts };
      });
      const output = JSON.stringify({ nftables: echo }); nft = nftSnapshotFromEcho(nft, output, updates); return output;
    },
  } });
  const { NativeNetworkSession, NativeNetworkError } = await import('../packages/network/native.ts');
  function saved(): NativeResourceReceipt {
    const source = Object.fromEntries((['blocked', 'core-only', 'active'] as const).map(mode => [mode,
      renderNetworkRules(deployment, { mode, fixtureCgroups: proof.cgroups })]));
    return { schemaVersion: 1, revision: 1, scope: 'fixture', deployment, pending: null,
      context: { bootID: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', userNS: 'user:[200]', netNS: 'net:[201]',
        ip: { path: tools.ipBinary, sha256: sha('synthetic-ip') }, nft: { path: tools.nftBinary, sha256: sha('synthetic-nft') },
        rendererSHA: sha(JSON.stringify(source)), planSHA: plan.sha256 },
      state: { expectedNft: '{"nftables":[]}', ruleIds: [], routeIds: [], mode: null, prepared: false, capture: false } };
  }
  function reset() { receipt = null; inspection = { state: 'absent' }; rules = builtin; routes = []; nft = '{"nftables":[]}';
    reads = 0; drift = false; snapshots = 0; writable = false; writes = 0; mutations = 0; locks = 0; failWrite = false; handle = 10; }
  const preflight = (purpose: 'apply' | 'recover' = 'apply') => NativeNetworkSession.preflightFixture(deployment, tools, proof, '/authority', purpose);
  const settled = () => NativeNetworkSession.assertSettledFixture(deployment, tools, proof, '/authority');
  const code = (expected: string) => (error: unknown) => {
    assert.ok(error instanceof NativeNetworkError); assert.equal(error.code, expected); assert.equal(error.message, expected);
    assert.equal(Object.hasOwn(error, 'cause'), false); return true;
  };
  test('fresh preflight and settlement perform fixed reads without initializing authority storage', async () => {
    reset(); const observed = await preflight();
    assert.equal(observed.scope, 'fixture'); assert.equal(observed.initialized, false); assert.equal(observed.revision, 0);
    assert.equal(observed.pending, false); assert.equal(observed.terminalPath, 'unverified'); assert.ok(Object.isFrozen(observed));
    assert.equal(snapshots, 3); await settled(); assert.equal(snapshots, 6);
    routes = [{ type: 'blackhole', dst: 'default', table: plan.blackholes[0].table, protocol: 186, metric: plan.blackholes[0].metric, flags: [] }];
    await assert.rejects(preflight(), code('NETWORK_PREFLIGHT_FAILED'));
  });
  test('historical receipt requires actual membership and detects context or revision drift', async () => {
    reset(); receipt = saved(); assert.equal((await preflight()).recoveryRequired, true);
    const before = JSON.stringify(receipt); await settled(); assert.equal(JSON.stringify(receipt), before);
    receipt.context.netNS = 'net:[999]'; await assert.rejects(preflight(), code('NETWORK_RESOURCE_CONTEXT_CHANGED'));
    receipt = saved(); reads = 0; drift = true; await assert.rejects(preflight(), code('NETWORK_RESOURCE_STALE'));
    drift = false; receipt = saved(); receipt.state.ruleIds = [plan.rules[0].priority];
    await assert.rejects(preflight(), code('NETWORK_RESOURCE_OBSERVATION_INVALID'));
  });
  test('pending is only inspected, binds command and worker identity, and never settles live workers', async () => {
    reset(); receipt = saved();
    const args = renderNetworkRules(deployment, { mode: 'blocked', fixtureCgroups: proof.cgroups }).ip.blackholes[0].args;
    receipt.pending = { token: '12345678-abcd-abcd-abcd-123456789abc', commandSHA: fencedNetworkCommandDigest(tools.ipBinary, args),
      operation: { kind: 'ip', category: 'blackhole', index: 0 } };
    const before = JSON.stringify(receipt);
    inspection = { state: 'running' }; await assert.rejects(settled(), code('NETWORK_COMMAND_UNSETTLED'));
    await assert.rejects(preflight('recover'), code('NETWORK_COMMAND_UNSETTLED'));
    inspection = { state: 'uncertain' }; await assert.rejects(settled(), code('NETWORK_COMMAND_UNSETTLED'));
    inspection = { state: 'settled', receipt: { version: 1, token: receipt.pending.token, commandSHA: receipt.pending.commandSHA,
      bootID: receipt.context.bootID, userNS: receipt.context.userNS, netNS: receipt.context.netNS, uid: 0,
      pid: 2000, pgid: 2000, sid: 2000, startTime: '123' } };
    await settled(); assert.equal(snapshots, 0);
    routes = [{ type: 'blackhole', dst: 'default', table: plan.blackholes[0].table, protocol: 186, metric: plan.blackholes[0].metric, flags: [] }];
    assert.equal((await preflight('recover')).pending, true); assert.equal(JSON.stringify(receipt), before);
    inspection.receipt!.netNS = 'net:[999]'; await assert.rejects(settled(), code('NETWORK_RESOURCE_PENDING_INVALID'));
    inspection = { state: 'absent' }; receipt.pending.commandSHA = '0'.repeat(64);
    await assert.rejects(settled(), code('NETWORK_RESOURCE_PENDING_INVALID'));
  });
  test('fixture proof cannot become production and platform errors are sanitized', async () => {
    reset(); await assert.rejects(NativeNetworkSession.preflightFixture(deployment, tools,
      { ...proof, outerNet: 'net:[201]' }, '/authority'), code('NETWORK_NATIVE_UNSUPPORTED'));
    await assert.rejects(NativeNetworkSession.preflightFixture(deployment, tools, undefined!, '/authority'), code('NETWORK_PREFLIGHT_FAILED'));
    await assert.rejects(NativeNetworkSession.preflightFixture(deployment,
      { ...tools, ipBinary: '/synthetic-private-value/ip' as typeof tools.ipBinary }, proof, '/authority'), code('NETWORK_TOOL_UNTRUSTED'));
  });
  const target = { ...deployment, generation: 'd'.repeat(64),
    core: { ...deployment.core, binarySha256: 'e'.repeat(64), unitSha256: 'f'.repeat(64) } };
  test('target preflight uses the authenticated previous renderer and reports the target generation', async () => {
    reset(); receipt = saved(); const before = JSON.stringify(receipt);
    const observed = await NativeNetworkSession.preflightFixture(target, tools, proof, '/authority');
    assert.equal(observed.binding, 'previous-generation'); assert.equal(observed.generation, target.generation);
    assert.equal(observed.planSha256, renderNetworkPlan(target).sha256); assert.equal(JSON.stringify(receipt), before);
    await NativeNetworkSession.assertSettledFixture(target, tools, proof, '/authority');
    assert.equal((await preflight()).binding, 'current');
    await assert.rejects(NativeNetworkSession.preflightFixture({ ...target, dnsPort: 15354 }, tools, proof, '/authority'),
      code('NETWORK_PROTECTION_CHANGE_UNSUPPORTED'));
    receipt.context.rendererSHA = '0'.repeat(64);
    await assert.rejects(NativeNetworkSession.preflightFixture(target, tools, proof, '/authority'), code('NETWORK_RESOURCE_CONTEXT_CHANGED'));
    reset(); assert.equal((await preflight()).binding, 'absent');
  });
  test('explicit update opens old binding, requires recovery and atomically rebinds without kernel mutation', async () => {
    reset(); writable = true; receipt = saved();
    await assert.rejects(NativeNetworkSession.fixture(target, tools, proof, '/authority'), code('NETWORK_RESOURCE_CONTEXT_CHANGED'));
    const session = await NativeNetworkSession.openForUpdateFixture(target, tools, proof, '/authority');
    assert.equal(session.plan.sha256, plan.sha256); assert.equal(writes, 0);
    await assert.rejects(session.rebind(target), code('NETWORK_RECOVERY_REQUIRED'));
    await session.recoverBlocked();
    const stale = await NativeNetworkSession.openForUpdateFixture(target, tools, proof, '/authority');
    const before = structuredClone(receipt!), oldMutations = mutations, oldWrites = writes;
    await session.rebind(target);
    assert.equal(mutations, oldMutations); assert.equal(writes, oldWrites + 1);
    assert.equal(receipt!.revision, before.revision + 1); assert.deepEqual(receipt!.state, before.state);
    assert.deepEqual(receipt!.deployment, renderNetworkPlan(target).deployment);
    assert.equal(receipt!.context.planSHA, renderNetworkPlan(target).sha256);
    assert.notEqual(receipt!.context.rendererSHA, before.context.rendererSHA);
    assert.equal(session.plan.sha256, renderNetworkPlan(target).sha256); assert.ok(Object.isFrozen(session.plan));
    assert.equal((await session.inspect()).mode, 'blocked');
    await assert.rejects(stale.rebind(target), code('NETWORK_RESOURCE_STALE'));
    const reopened = await NativeNetworkSession.fixture(target, tools, proof, '/authority');
    await assert.rejects(reopened.inspect(), code('NETWORK_RECOVERY_REQUIRED'));
    await assert.rejects(NativeNetworkSession.fixture(deployment, tools, proof, '/authority'), code('NETWORK_RESOURCE_CONTEXT_CHANGED'));
  });
  test('rebind rejects protection changes and journal failure preserves the old binding and poisons the instance', async () => {
    reset(); writable = true;
    let session = await NativeNetworkSession.fixture(deployment, tools, proof, '/authority');
    await assert.rejects(session.rebind(target), code('NETWORK_PHASE_INVALID'));
    await assert.rejects(session.installBlocked(), code('NETWORK_SESSION_UNAVAILABLE'));
    reset(); writable = true; session = await NativeNetworkSession.fixture(deployment, tools, proof, '/authority');
    await session.installBlocked();
    const before = JSON.stringify(receipt), oldMutations = mutations;
    failWrite = true;
    await assert.rejects(session.rebind(target), (error: unknown) => error instanceof ResourceJournalError && error.code === 'NETWORK_RESOURCE_STORE_IO');
    assert.equal(JSON.stringify(receipt), before); assert.equal(session.plan.sha256, plan.sha256); assert.equal(mutations, oldMutations);
    await assert.rejects(session.inspect(), code('NETWORK_SESSION_UNAVAILABLE'));
    failWrite = false;
    session = await NativeNetworkSession.openForUpdateFixture(target, tools, proof, '/authority');
    assert.equal(session.plan.sha256, plan.sha256);
    await assert.rejects(NativeNetworkSession.openForUpdateFixture({ ...target, dnsPort: 15354 }, tools, proof, '/authority'),
      code('NETWORK_PROTECTION_CHANGE_UNSUPPORTED'));
    await session.recoverBlocked();
    await assert.rejects(session.rebind({ ...target, core: { ...target.core, serviceUid: 12346 } }), code('NETWORK_PROTECTION_CHANGE_UNSUPPORTED'));
  });
  test('settle preflight and explicit settlement validate worker provenance without adopting changing kernel state', async () => {
    reset(); writable = true; receipt = saved();
    const args = renderNetworkRules(deployment, { mode: 'blocked', fixtureCgroups: proof.cgroups }).ip.blackholes[0].args;
    receipt.pending = { token: '12345678-abcd-abcd-abcd-123456789abc', commandSHA: fencedNetworkCommandDigest(tools.ipBinary, args),
      operation: { kind: 'ip', category: 'blackhole', index: 0 } };
    inspection = { state: 'running', receipt: { version: 1, token: receipt.pending.token, commandSHA: receipt.pending.commandSHA,
      bootID: receipt.context.bootID, userNS: receipt.context.userNS, netNS: receipt.context.netNS, uid: 0,
      pid: 2000, pgid: 2000, sid: 2000, startTime: '123' } };
    receipt.state.ruleIds = [plan.rules[0].priority]; // Changing resources cannot be compared until the writer settles.
    const before = JSON.stringify(receipt);
    assert.equal((await NativeNetworkSession.preflightFixture(target, tools, proof, '/authority', 'settle')).binding, 'previous-generation');
    assert.equal(snapshots, 0); assert.equal(locks, 0); assert.equal(mutations, 0);
    inspection.receipt!.commandSHA = '0'.repeat(64);
    await assert.rejects(NativeNetworkSession.settlePendingFixture(target, tools, proof, '/authority'), code('NETWORK_RESOURCE_PENDING_INVALID'));
    assert.equal(mutations, 0);
    inspection.receipt!.commandSHA = receipt.pending.commandSHA;
    await NativeNetworkSession.settlePendingFixture(target, tools, proof, '/authority');
    assert.equal(inspection.state, 'settled'); assert.equal(mutations, 1); assert.equal(writes, 0); assert.equal(snapshots, 0);
    assert.equal(JSON.stringify(receipt), before);
    await NativeNetworkSession.assertSettledFixture(target, tools, proof, '/authority');
    await assert.rejects(NativeNetworkSession.preflightFixture(target, tools, proof, '/authority', 'recover'), code('NETWORK_RESOURCE_OBSERVATION_INVALID'));
    reset(); writable = true; await NativeNetworkSession.settlePendingFixture(target, tools, proof, '/authority');
    assert.equal(receipt, null); assert.equal(locks, 0); assert.equal(writes, 0); assert.equal(snapshots, 3);
  });
  test('network protection compares complete validated plans and excludes only three artifact fields', () => {
    assert.equal(sameNetworkProtection(deployment, target), true);
    for (const different of [{ ...target, dnsPort: 15354 }, { ...target, tun: { ...target.tun, mtu: 1400 } },
      { ...target, routerMAC: '02:00:00:00:00:02' }, { ...target, management: { serviceUid: 12346 } },
      { ...target, core: { ...target.core, serviceUid: 12346 } }]) assert.equal(sameNetworkProtection(deployment, different), false);
    assert.throws(() => sameNetworkProtection(deployment, { ...target, generation: 'invalid' }));
  });
}
