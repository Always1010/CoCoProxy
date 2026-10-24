import test from 'node:test';
import assert from 'node:assert/strict';
import { renderNetworkPlan, type NetworkPlanInput } from '../packages/network/plan.ts';
import { NetworkReadbackError, nftSnapshotFromEcho, verifyNetworkReadback, type NetworkReadbackInput } from '../packages/network/readback.ts';

const deployment: NetworkPlanInput = { schemaVersion: 1, generation: 'a'.repeat(64),
  core: { serviceUid: 12345, binarySha256: 'b'.repeat(64), unitSha256: 'c'.repeat(64) },
  ingressInterface: 'lan-test', gatewayIPv4: '192.0.2.2', prefixLength: 24,
  routerIPv4: '192.0.2.1', routerMAC: '02:00:00:00:00:01', clientIPv4: '192.0.2.3', dnsPort: 15353,
  tun: { interface: 'coproxy-tun', mtu: 1500 }, marks: { mask: 0xff00, capture: 0x100, egress: 0x200, return: 0x300 },
  tables: { capture: 10003, egress: 10002, return: 10001 }, priorities: { capture: 10003, egress: 10002, return: 10001 } };
const plan = renderNetworkPlan(deployment);
const builtin = [{ priority: 0, src: 'all', table: 'local' },
  { priority: 32766, src: 'all', table: 'main' }, { priority: 32767, src: 'all', table: 'default' }];
function ownedRules() {
  return plan.rules.map(r => ({ priority: r.priority, src: 'all', table: r.table,
    fwmark: '0x' + r.mark.toString(16), fwmask: '0x' + r.mask.toString(16),
    ...(r.role === 'return' ? { iif: deployment.tun.interface, dst: deployment.clientIPv4 } : {}) }));
}
function ownedRoutes() {
  return [...plan.blackholes.map(r => ({ type: r.type, dst: 'default', table: r.table, protocol: '186', metric: r.metric, flags: [] })),
    ...plan.egressRoutes.map(r => ({ dst: r.destination.replace('/32', ''), table: r.table, protocol: 186, metric: r.metric,
      dev: r.interface, ...('via' in r ? { gateway: r.via } : {}),
      ...('scope' in r ? { scope: r.scope } : {}), ...('preferredSource' in r ? { prefsrc: r.preferredSource } : {}), flags: [] }))];
}
function nftFixture() {
  const nftables: Record<string, unknown>[] = [{ metainfo: { version: '1.0.6', release_name: 'Synthetic', json_schema_version: 1 } }];
  for (const [table, definitions] of Object.entries({ coproxy_guard: [
    ['input_guard', 'filter', 'input', -10], ['forward_guard', 'filter', 'forward', -10], ['output_guard', 'filter', 'output', -10]],
  coproxy_data: [['classify_ingress', 'filter', 'prerouting', -150], ['classify_output', 'route', 'output', -150],
    ['classify_return', 'filter', 'prerouting', -149]] })) {
    nftables.push({ table: { family: 'inet', name: table, handle: 1 } });
    for (const [name, type, hook, prio] of definitions) {
      nftables.push({ chain: { family: 'inet', table, name, type, hook, prio, policy: 'accept', handle: 2 } });
      nftables.push({ rule: { family: 'inet', table, chain: name, handle: 3,
        expr: [{ match: { op: '==', left: { meta: { key: 'mark' } }, right: 256 } }, { drop: null }] } });
    }
  }
  return { nftables };
}
function snapshot(): NetworkReadbackInput {
  return { nft: JSON.stringify(nftFixture()), ipv4Rules: JSON.stringify([...builtin, ...ownedRules()]),
    ipv4Routes: JSON.stringify(ownedRoutes()) };
}
const expected = { nft: JSON.stringify(nftFixture()), rules: 'complete' as const, routes: 'prepared' as const };
function verify(raw = snapshot(), want = expected) { return verifyNetworkReadback(deployment, raw, want); }
function reject(raw: NetworkReadbackInput) {
  assert.throws(() => verify(raw), (error: unknown) => {
    assert.ok(error instanceof NetworkReadbackError);
    assert.equal(error.message, 'NETWORK_READBACK_INVALID');
    assert.equal(Object.hasOwn(error, 'cause'), false); return true;
  });
}

test('exact kernel structure and route subsets normalize only documented nonsemantic differences', () => {
  const original = verify();
  assert.equal(original.rulesPresent.length, 3); assert.equal(original.routesPresent.length, 7);
  const raw = snapshot(), parsed = JSON.parse(raw.nft);
  for (const wrapper of parsed.nftables) for (const value of Object.values(wrapper) as Record<string, unknown>[]) {
    if ('handle' in value) value.handle = 987654;
  }
  raw.nft = JSON.stringify(parsed);
  assert.throws(() => verify(raw), NetworkReadbackError);
  const renumbered = verify(raw, { ...expected, nft: raw.nft });
  assert.equal(renumbered.nftSha256, original.nftSha256);
  assert.notEqual(renumbered.nftIdentitySha256, original.nftIdentitySha256);
  const empty = { nft: '{"nftables":[]}', ipv4Rules: JSON.stringify(builtin), ipv4Routes: '[]' };
  assert.equal(verifyNetworkReadback(deployment, empty, { nft: empty.nft, rules: 'absent', routes: 'absent' }).routesPresent.length, 0);
  raw.nft = expected.nft;
  raw.ipv4Rules = JSON.stringify([...builtin, ownedRules()[0]]);
  raw.ipv4Routes = JSON.stringify([ownedRoutes()[0]]);
  assert.equal(verifyNetworkReadback(deployment, raw, { ...expected, rules: 'partial', routes: 'partial' }).routesPresent.length, 1);
  assert.throws(() => verify(raw), NetworkReadbackError);
});

test('wrong hook priority, changed or reordered expressions and additional objects fail closed', () => {
  for (const mutate of [
    (n: ReturnType<typeof nftFixture>) => { (n.nftables.find(x => 'chain' in x)!.chain as Record<string, unknown>).prio = -9; },
    (n: ReturnType<typeof nftFixture>) => { const r = n.nftables.find(x => 'rule' in x)!.rule as { expr: unknown[] }; r.expr.reverse(); },
    (n: ReturnType<typeof nftFixture>) => { const r = n.nftables.find(x => 'rule' in x)!.rule as { expr: unknown[] }; r.expr.push({ accept: null }); },
    (n: ReturnType<typeof nftFixture>) => { n.nftables.push({ flowtable: { name: 'foreign' } }); },
    (n: ReturnType<typeof nftFixture>) => { n.nftables.push({ table: { family: 'inet', name: 'foreign', handle: 20 } }); },
    (n: ReturnType<typeof nftFixture>) => { (n.nftables.find(x => 'rule' in x)!.rule as Record<string, unknown>).comment = 'coproxy'; },
  ]) {
    const n = nftFixture(); mutate(n); reject({ ...snapshot(), nft: JSON.stringify(n) });
  }
});

test('RPDB rejects foreign bypass, duplicates, changed selectors and occupied priorities', () => {
  for (const rules of [
    [...builtin, ...ownedRules(), { priority: 100, src: 'all', table: 'main' }],
    [...builtin, ...ownedRules(), ownedRules()[0]],
    [...builtin, ...ownedRules().map((r, i) => i === 0 ? { ...r, fwmask: '0xffff' } : r)],
    [...builtin, ...ownedRules().map((r, i) => i === 0 ? { ...r, suppress_prefixlength: 0 } : r)],
    [...builtin.slice(1), ...ownedRules()],
    [...builtin, ...ownedRules().map((r, i) => i === 0 ? { ...r, table: 'main' } : r)],
  ]) reject({ ...snapshot(), ipv4Rules: JSON.stringify(rules) });
  const detached = { ...snapshot(), ipv4Rules: JSON.stringify([...builtin,
    ...ownedRules().map(r => r.priority === deployment.priorities.return ? { ...r, iif_detached: null } : r)]) };
  for (const routes of ['partial', 'prepared', 'retained'] as const) {
    assert.equal(verifyNetworkReadback(deployment, detached, { ...expected, routes }).rulesPresent.length, 3);
  }
  const capture = { dst: 'default', dev: 'coproxy-tun', table: deployment.tables.capture, protocol: 186, metric: 10, scope: 'link' };
  assert.throws(() => verifyNetworkReadback(deployment, { ...detached,
    ipv4Routes: JSON.stringify([...ownedRoutes(), capture]) }, { ...expected, routes: 'active' }), NetworkReadbackError);
  for (const rules of [
    [...builtin, ...ownedRules().map(r => r.priority === deployment.priorities.return ? { ...r, iif_detached: true } : r)],
    [...builtin, ...ownedRules().map(r => r.priority === deployment.priorities.egress ? { ...r, iif_detached: null } : r)],
    [...builtin.map((r, i) => i === 0 ? { ...r, iif_detached: null } : r), ...ownedRules()],
  ]) reject({ ...snapshot(), ipv4Rules: JSON.stringify(rules) });
});

test('routes reject foreign occupation, unsafe attributes, capture during blocking and local client delivery', () => {
  for (const routes of [
    [...ownedRoutes(), ownedRoutes()[0]],
    [...ownedRoutes(), { dst: '203.0.113.0/24', table: deployment.tables.capture, dev: 'lan-test' }],
    ownedRoutes().map((r, i) => i === 0 ? { ...r, protocol: 187 } : r),
    ownedRoutes().map((r, i) => i === 3 ? { ...r, gateway: '192.0.2.99' } : r),
    ownedRoutes().map((r, i) => i === 3 ? { ...r, flags: ['onlink'] } : r),
    [...ownedRoutes(), { dst: 'default', dev: 'coproxy-tun', table: 'main' }],
    [...ownedRoutes(), { dst: '192.0.2.3', dev: 'lan-test', table: 'local', type: 'local' }],
    [...ownedRoutes(), { dst: 'default', dev: 'lan-test', table: 'local', type: 'unicast' }],
    [...ownedRoutes(), { dst: 'default', dev: 'coproxy-tun', table: deployment.tables.capture, protocol: 186, metric: 10, scope: 'link' }],
    ownedRoutes().map((r, i) => i === 0 ? { ...r, nhid: 8 } : r),
  ]) reject({ ...snapshot(), ipv4Routes: JSON.stringify(routes) });
  const active = { ...snapshot(), ipv4Routes: JSON.stringify([...ownedRoutes(),
    { dst: 'default', dev: 'coproxy-tun', table: deployment.tables.capture, protocol: 186, metric: 10, scope: 'link' }]) };
  assert.equal(verifyNetworkReadback(deployment, active, { ...expected, routes: 'active' }).routesPresent.length, 8);
  const kernelRoutes = [{ dst: '198.18.0.0/30', dev: 'coproxy-tun', protocol: 'kernel', scope: 'link', prefsrc: '198.18.0.1', flags: [] },
    { type: 'local', dst: '198.18.0.1', dev: 'coproxy-tun', table: 'local', protocol: 'kernel', scope: 'host', prefsrc: '198.18.0.1', flags: [] },
    { type: 'broadcast', dst: '198.18.0.3', dev: 'coproxy-tun', table: 'local', protocol: 'kernel', scope: 'link', prefsrc: '198.18.0.1', flags: [] }];
  const withKernel = { ...snapshot(), ipv4Routes: JSON.stringify([
    ...ownedRoutes().map(r => ({ ...r, protocol: 'bgp' })), ...kernelRoutes]) };
  assert.equal(verify(withKernel).routesPresent.length, 7);
  for (const bad of [{ ...kernelRoutes[0], protocol: 'static' }, { ...kernelRoutes[0], dst: '198.18.0.0/24' },
    { ...kernelRoutes[0], metric: 10 }, { ...kernelRoutes[1], prefsrc: '198.18.0.2' }]) {
    reject({ ...snapshot(), ipv4Routes: JSON.stringify([...ownedRoutes(), bad]) });
  }
});

test('malformed, duplicate-key, hostile input and unknown fields never run supplied code or leak diagnostics', () => {
  for (const text of ['{', '{"nftables":[],"nftables":[]}', '{"nftables":[],"secret":"redact"}', '{"__proto__":{}}',
    '{"nftables":[],"secret":9007199254740992}', ' '.repeat(4_194_305)]) reject({ ...snapshot(), nft: text });
  let called = 0;
  for (const raw of [{ ...snapshot(), get nft() { called++; return ''; } },
    new Proxy({}, { ownKeys() { called++; throw new Error('secret'); } })]) {
    assert.throws(() => verifyNetworkReadback(deployment, raw as NetworkReadbackInput, expected), NetworkReadbackError);
  }
  assert.equal(called, 0);
});

test('trusted JSON commit echo reconstructs create/replace and rejects missing or unrelated changes', () => {
  const fixture = nftFixture();
  const counts = { coproxy_guard: { input_guard: 1, forward_guard: 1, output_guard: 1 },
    coproxy_data: { classify_ingress: 1, classify_output: 1, classify_return: 1 } };
  const updates = [{ table: 'coproxy_guard' as const, operation: 'create' as const, ruleCounts: counts.coproxy_guard },
    { table: 'coproxy_data' as const, operation: 'create' as const, ruleCounts: counts.coproxy_data }];
  const echoEntries = fixture.nftables.map(o => 'metainfo' in o ? o : { add: o });
  const echo = JSON.stringify({ nftables: echoEntries });
  const created = nftSnapshotFromEcho('{"nftables":[]}', echo, updates);
  assert.equal(verify({ ...snapshot(), nft: created }).nftSha256, verify().nftSha256);
  const replacement = fixture.nftables.filter(o => 'rule' in o && (o.rule as { table: string }).table === 'coproxy_guard');
  const replacementEcho = JSON.stringify({ nftables: replacement.map(o => ({ add: o })) });
  const replaced = nftSnapshotFromEcho(created, replacementEcho,
    [{ ...updates[0], operation: 'replace' }]);
  assert.equal(verify({ ...snapshot(), nft: replaced }).nftSha256, verify().nftSha256);
  for (const badEcho of [JSON.stringify({ nftables: echoEntries.slice(0, -1) }),
    JSON.stringify({ nftables: [...echoEntries, echoEntries[1]] }),
    JSON.stringify({ nftables: [...echoEntries, { delete: { table: { family: 'inet', name: 'foreign' } } }] })]) {
    assert.throws(() => nftSnapshotFromEcho('{"nftables":[]}', badEcho, updates), NetworkReadbackError);
  }
  assert.throws(() => nftSnapshotFromEcho(created, echo, updates), NetworkReadbackError);
  assert.throws(() => nftSnapshotFromEcho(created, replacementEcho,
    [{ ...updates[0], operation: 'replace', ruleCounts: { ...counts.coproxy_guard, input_guard: 2 } }]), NetworkReadbackError);
});
