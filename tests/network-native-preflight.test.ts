import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import test, { mock } from 'node:test';
import { fencedNetworkCommandDigest, type FencedCommandInspection } from '../packages/network/fenced-command.ts';
import { ResourceJournalError, type NativeResourceReceipt } from '../packages/network/resource-journal.ts';
import { renderNetworkPlan, type NetworkPlanInput } from '../packages/network/plan.ts';
import { renderNetworkRules } from '../packages/network/rules.ts';

// Module mocks are confined to a child process; no production dependency
// injection or host Linux/network access is needed for these boundary tests.
if (!process.env.COPROXY_NATIVE_PREFLIGHT_MOCKS) {
  test('native read-only preflight boundary fixtures', () => {
    const child = spawnSync(process.execPath, ['--experimental-strip-types', '--experimental-test-module-mocks', '--test',
      fileURLToPath(import.meta.url)], { encoding: 'utf8', windowsHide: true,
      env: { ...process.env, COPROXY_NATIVE_PREFLIGHT_MOCKS: '1' } });
    assert.equal(child.status, 0, child.stdout + child.stderr);
  });
} else {
  const deployment: NetworkPlanInput = { schemaVersion: 1, generation: 'a'.repeat(64),
    core: { serviceUid: 12345, binarySha256: 'b'.repeat(64), unitSha256: 'c'.repeat(64) },
    ingressInterface: 'lan-test', gatewayIPv4: '192.0.2.2', prefixLength: 24,
    routerIPv4: '192.0.2.1', routerMAC: '02:00:00:00:00:01', clientIPv4: '192.0.2.3', dnsPort: 15353,
    tun: { interface: 'coproxy-tun', mtu: 1500 }, marks: { mask: 0xff00, capture: 0x100, egress: 0x200, return: 0x300 },
    tables: { capture: 10003, egress: 10002, return: 10001 }, priorities: { capture: 10003, egress: 10002, return: 10001 } };
  const plan = renderNetworkPlan(deployment);
  const proof = { outerUser: 'user:[100]', outerNet: 'net:[101]', cgroups: { core: '/fixture/core', management: null } };
  const tools = { ipBinary: '/usr/sbin/ip', nftBinary: '/usr/sbin/nft' } as const;
  const builtin = [{ priority: 0, src: 'all', table: 'local' }, { priority: 32766, src: 'all', table: 'main' },
    { priority: 32767, src: 'all', table: 'default' }];
  const sha = (raw: string) => createHash('sha256').update(raw).digest('hex');
  let receipt: NativeResourceReceipt | null = null, inspection: FencedCommandInspection = { state: 'absent' };
  let rules: unknown[] = builtin, routes: unknown[] = [], nft = '{"nftables":[]}', reads = 0, drift = false, snapshots = 0;
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
  mock.module('../packages/storage/private-files.ts', { namedExports: { privateDirectory: forbidden } });
  mock.module('../packages/network/resource-journal.ts', { namedExports: { ResourceJournalError,
    ResourceJournal: class {
      root: string;
      constructor(root: string) { this.root = root; }
      async read() { reads++; return receipt && drift && reads > 1 ? { ...receipt, revision: receipt.revision + 1 } : receipt; }
      exclusive = forbidden;
      write = forbidden;
    },
  } });
  mock.module('../packages/network/command.ts', { namedExports: {
    NetworkCommandError: class extends Error {},
    runNetworkCommand: async (_binary: string, args: string[]) => {
      snapshots++;
      if (JSON.stringify(args) === JSON.stringify(['-j', '-n', '-a', 'list', 'ruleset'])) return nft;
      if (JSON.stringify(args) === JSON.stringify(['-j', '-4', 'rule', 'show'])) return JSON.stringify(rules);
      if (JSON.stringify(args) === JSON.stringify(['-j', '-4', 'route', 'show', 'table', 'all'])) return JSON.stringify(routes);
      return forbidden();
    },
  } });
  mock.module('../packages/network/fenced-command.ts', { namedExports: { fencedNetworkCommandDigest,
    inspectFencedNetworkCommand: async () => inspection, runFencedNetworkCommand: forbidden, settleFencedNetworkCommand: forbidden,
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
  function reset() { receipt = null; inspection = { state: 'absent' }; rules = builtin; routes = []; reads = 0; drift = false; snapshots = 0; }
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
}
