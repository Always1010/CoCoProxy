import assert from 'node:assert/strict';
import test from 'node:test';
import { NetworkCommandError } from '../packages/network/command.ts';
import { GATEWAY_CORE_SHA256 } from '../packages/network/config.ts';
import { observeNetworkLink, observeNetworkLinkFixture, type NetworkLinkFixtureReader, type NetworkLinkOptions } from '../packages/network/link.ts';
import { renderNetworkPlan } from '../packages/network/plan.ts';

const plan = renderNetworkPlan({ schemaVersion: 1, generation: 'a'.repeat(64),
  core: { serviceUid: 12345, binarySha256: GATEWAY_CORE_SHA256, unitSha256: 'c'.repeat(64) },
  ingressInterface: 'lan-test', gatewayIPv4: '192.0.2.2', prefixLength: 24, routerIPv4: '192.0.2.1',
  routerMAC: '02:00:00:00:00:01', clientIPv4: '192.0.2.3', dnsPort: 15353,
  tun: { interface: 'cocoproxy-tun', mtu: 1500 }, marks: { mask: 0xff00, capture: 0x100, egress: 0x200, return: 0x300 },
  tables: { capture: 10003, egress: 10002, return: 10001 }, priorities: { capture: 10003, egress: 10002, return: 10001 } });
const options: NetworkLinkOptions = { ipBinary: '/usr/sbin/ip', probeIPv4: '203.0.113.80' };
type Row = Record<string, unknown>;
function data() {
  const link: Row = { ifindex: 7, ifname: 'lan-test', flags: ['BROADCAST', 'MULTICAST', 'UP', 'LOWER_UP'],
    mtu: 1500, qdisc: 'noqueue', operstate: 'UP', group: 'default', txqlen: 1000,
    link_type: 'ether', address: '02:00:00:00:00:02', broadcast: 'ff:ff:ff:ff:ff:ff',
    link_index: 8, link_netnsid: 0, promiscuity: 0, allmulti: 0, min_mtu: 68, max_mtu: 65535,
    num_tx_queues: 1, num_rx_queues: 1, gso_max_size: 65536, gso_max_segs: 65535,
    linkmode: 'DEFAULT', linkinfo: { info_kind: 'veth', info_data: {} } };
  const address: Row = { ...structuredClone(link), addr_info: [
    { family: 'inet', local: '192.0.2.2', prefixlen: 24, broadcast: '192.0.2.255', scope: 'global',
      label: 'lan-test', valid_life_time: 4294967295, preferred_life_time: 4294967295 },
    { family: 'inet6', local: 'fe80::2', prefixlen: 64, scope: 'link', valid_life_time: 4294967295, preferred_life_time: 4294967295 },
  ] };
  // iproute2 omits dev in neighbour JSON when the command already filters dev.
  const neighbour: Row = { dst: '192.0.2.1', lladdr: '02:00:00:00:00:01', state: ['PERMANENT'] };
  const route: Row = { dst: '203.0.113.80', from: '192.0.2.2', gateway: '192.0.2.1', dev: 'lan-test',
    table: '10002', mark: 512, uid: 12345, flags: [], cache: [] };
  return { link, address, neighbour, route };
}
type Data = ReturnType<typeof data>;
function reader(before = data(), after = before, times = [1000, 1010]) {
  const commands: string[][] = []; let reads = 0, ticks = 0;
  const fixture: NetworkLinkFixtureReader = { platform: 'linux', root: true,
    now() { return times[Math.min(ticks++, times.length - 1)]; },
    async command(args) {
      commands.push([...args]);
      const source = reads++ < 4 ? before : after;
      if (args.includes('link')) return JSON.stringify([source.link]);
      if (args.includes('address')) return JSON.stringify([source.address]);
      if (args.includes('neigh')) return JSON.stringify([source.neighbour]);
      if (args.includes('route')) return JSON.stringify([source.route]);
      throw new Error('unexpected command');
    } };
  return { fixture, commands };
}
async function rejects(change: (value: Data) => void) {
  const value = data(); change(value);
  const result = await observeNetworkLinkFixture(plan, options, reader(value).fixture);
  assert.equal(result.verified, false);
  assert.equal(result.reason, 'NETWORK_LINK_UNVERIFIED');
  assert.ok(Object.values(result.checks).every(value => value === false));
  assert.equal(result.planSha256, plan.sha256);
  assert.equal(result.generation, plan.deployment.generation);
  assert.ok(!JSON.stringify(result).includes('192.0.2.'));
}

test('two stable read-only rounds prove exact ethernet link, current neighbour and marked service route without returning topology', async () => {
  const { fixture, commands } = reader();
  const result = await observeNetworkLinkFixture(plan, options, fixture);
  assert.equal(result.scope, 'fixture'); assert.equal(result.verified, true);
  assert.equal(result.commandsSettled, true);
  assert.equal(result.checkedAt, 1010); assert.equal(result.reason, null);
  assert.equal(result.planSha256, plan.sha256); assert.equal(result.generation, plan.deployment.generation);
  assert.ok(Object.values(result.checks).every(value => value === true));
  assert.deepEqual(commands.slice(0, 4), [
    ['-d', '-j', 'link', 'show', 'dev', 'lan-test'],
    ['-d', '-j', 'address', 'show', 'dev', 'lan-test'],
    ['-j', '-4', 'neigh', 'show', 'to', '192.0.2.1', 'dev', 'lan-test'],
    ['-j', '-4', '-N', 'route', 'get', '203.0.113.80', 'from', '192.0.2.2', 'mark', '512', 'uid', '12345'],
  ]);
  assert.deepEqual(commands.slice(4), commands.slice(0, 4));
  assert.ok(commands.flat().every(word => !['sysctl', 'replace', 'add', 'del', 'flush', 'ping', 'arping'].includes(word)));
  assert.doesNotMatch(JSON.stringify(result), /192\.0\.2\.|203\.0\.113\.|lan-test|lladdr|raw|02:00:/);
});

test('physical ether shape, explicit dev and REACHABLE state are supported; dynamic timers are not identity', async () => {
  const before = data(), after = data();
  for (const row of [before.link, before.address, after.link, after.address]) {
    delete row.linkinfo; delete row.link_index; delete row.link_netnsid;
    row.carrier = 1;
  }
  for (const row of [before.neighbour, after.neighbour]) {
    row.dev = 'lan-test'; row.state = ['REACHABLE']; row.router = null; row.confirmed = 1; row.used = 2;
  }
  after.neighbour.confirmed = 2;
  (after.address.addr_info as Row[])[0].valid_life_time = 3600;
  (after.address.addr_info as Row[])[0].preferred_life_time = 1800;
  after.route.table = 10002; before.route.prefsrc = '192.0.2.2'; after.route.prefsrc = '192.0.2.2';
  assert.equal((await observeNetworkLinkFixture(plan, options, reader(before, after).fixture)).verified, true);
});

test('real iproute2 veth output may omit info_data, IPv4 broadcast and address-side link metadata', async () => {
  const value = data();
  value.link.linkinfo = { info_kind: 'veth' };
  value.address.linkinfo = { info_kind: 'veth' };
  value.link.inet6_addr_gen_mode = 'eui64';
  delete value.address.linkmode;
  delete (value.address.addr_info as Row[])[0].broadcast;
  delete value.neighbour.dev;
  value.route.mark = 512;
  value.route.table = '10002';
  assert.equal((await observeNetworkLinkFixture(plan, options, reader(value).fixture)).verified, true);
  value.neighbour.state = ['DELAY'];
  assert.equal((await observeNetworkLinkFixture(plan, options, reader(value).fixture)).verified, false);
});

test('wrong link identity, carrier, virtual role, master, address alias and capacity remain unverified', async () => {
  const changes: Array<(value: Data) => void> = [
    value => { value.link.ifname = 'foreign'; }, value => { value.link.ifindex = 0; },
    value => { value.link.flags = ['UP']; }, value => { value.link.flags = ['UP', 'LOWER_UP', 'NO-CARRIER']; },
    value => { value.link.operstate = 'DOWN'; }, value => { value.link.carrier = 0; },
    value => { value.link.mtu = 1400; }, value => { value.link.link_type = 'loopback'; },
    value => { value.link.master = 'foreign-bridge'; }, value => { value.link.linkinfo = { info_kind: 'bridge' }; },
    value => { value.link.linkinfo = { info_kind: 'tun' }; }, value => { value.link.linkinfo = { info_kind: 'vlan' }; },
    value => { value.link.promiscuity = 1; }, value => { value.link.proto_down = true; },
    value => { value.link.flags = ['UP', 'LOWER_UP', 'UP']; }, value => { value.address.address = '02:00:00:00:00:04'; },
    value => { (value.address.addr_info as Row[])[0].local = '192.0.2.4'; },
    value => { (value.address.addr_info as Row[])[0].prefixlen = 25; },
    value => { (value.address.addr_info as Row[])[0].label = 'lan-test:alias'; },
    value => { (value.address.addr_info as Row[])[0].secondary = true; },
    value => { (value.address.addr_info as Row[])[0].preferred_life_time = 0; },
    value => { (value.address.addr_info as Row[]).push({ ...(value.address.addr_info as Row[])[0] }); },
    value => { (value.address.addr_info as Row[]).push({ family: 'inet', local: '192.0.2.4', prefixlen: 24, scope: 'global' }); },
    value => { (value.address.addr_info as Row[])[1].local = '2001:db8::2'; },
  ];
  for (const change of changes) await rejects(change);
});

test('only exact MAC REACHABLE or PERMANENT neighbours can supply a ready observation', async () => {
  for (const state of ['STALE', 'DELAY', 'PROBE', 'FAILED', 'INCOMPLETE', 'NOARP', 'NONE']) {
    await rejects(value => { value.neighbour.state = [state]; });
  }
  for (const change of [
    (value: Data) => { value.neighbour.dst = '192.0.2.4'; },
    (value: Data) => { value.neighbour.lladdr = '02:00:00:00:00:03'; },
    (value: Data) => { value.neighbour.dev = 'foreign'; },
    (value: Data) => { value.neighbour.state = ['REACHABLE', 'PERMANENT']; },
    (value: Data) => { value.neighbour.flags = ['proxy']; },
  ]) await rejects(change);
});

test('route lookup must independently return exact mark, source, UID, table, via, device and destination', async () => {
  const changes: Array<(value: Data) => void> = [
    value => { value.route.dst = '203.0.113.81'; }, value => { value.route.from = '192.0.2.3'; },
    value => { value.route.prefsrc = '192.0.2.3'; }, value => { value.route.gateway = '192.0.2.4'; },
    value => { value.route.dev = 'cocoproxy-tun'; }, value => { value.route.mark = 0x100; },
    value => { value.route.mark = '512'; }, value => { value.route.mark = '0x200'; },
    value => { value.route.uid = 0; }, value => { value.route.table = 'main'; },
    value => { value.route.type = 'blackhole'; }, value => { value.route.flags = ['linkdown']; },
    value => { value.route.nexthops = [{ gateway: '192.0.2.1' }]; }, value => { delete value.route.mark; },
    value => { delete value.route.table; }, value => { delete value.route.from; },
  ];
  for (const change of changes) await rejects(change);
});

test('replacement between commands or rounds and snapshots beyond the five second window are rejected', async () => {
  const before = data(), after = data(); after.link.ifindex = 8; after.address.ifindex = 8;
  assert.equal((await observeNetworkLinkFixture(plan, options, reader(before, after).fixture)).verified, false);
  const changed = data(); changed.neighbour.state = ['REACHABLE'];
  assert.equal((await observeNetworkLinkFixture(plan, options, reader(before, changed).fixture)).verified, false);
  for (const times of [[1000, 6001], [1000, 999], [1000, NaN]]) {
    assert.equal((await observeNetworkLinkFixture(plan, options, reader(before, before, times).fixture)).verified, false);
  }
});

test('malformed, duplicate, oversized or structurally ambiguous JSON never becomes a proof', async () => {
  const raw = JSON.stringify([data().link]);
  const invalid = ['', '{}', 'null', '[]', '[{},{}]', raw.replace('"ifindex":7', '"ifindex":7,"ifindex":7'),
    raw.replace('"ifindex":7', '"ifindex":7,"\\u0069findex":7'),
    raw.replace('"ifindex":7', '"ifindex":7,"__proto__":{}'),
    raw.replace('"ifindex":7', '"ifindex":7,"unknown":false'),
    raw.replace('"ifindex":7', '"ifindex":-0'), raw + 'garbage', ' '.repeat(65_537),
    '['.repeat(18) + ']'.repeat(18)];
  for (const output of invalid) {
    const fixture = reader().fixture; fixture.command = async () => output;
    const result = await observeNetworkLinkFixture(plan, options, fixture);
    assert.equal(result.verified, false);
    assert.equal(result.commandsSettled, true);
    assert.equal(result.scope, 'fixture');
  }
  for (const error of [new NetworkCommandError('synthetic-private'), new NetworkCommandError('synthetic-private', false),
    Object.assign(new Error('synthetic-private'), { childSettled: false })]) {
    const fixture = reader().fixture; let commands = 0;
    fixture.command = async () => { commands++; throw error; };
    const result = await observeNetworkLinkFixture(plan, options, fixture);
    assert.equal(result.scope, 'fixture'); assert.equal(result.verified, false);
    assert.equal(result.commandsSettled, !(error instanceof NetworkCommandError && error.childSettled === false));
    assert.equal(result.reason, 'NETWORK_LINK_UNVERIFIED'); assert.equal(commands, 1);
    assert.doesNotMatch(JSON.stringify(result), /synthetic-private/);
  }
});

test('trusted probe inputs, current plan binding and production/fixture scope cannot be bypassed', async () => {
  for (const probeIPv4 of ['192.0.2.1', '192.0.2.2', '192.0.2.3', '192.0.2.80', '198.18.0.1', '198.19.255.254',
    '127.0.0.1', '169.254.1.1', '0.0.0.1', '224.0.0.1', '255.255.255.255', '::1', '203.000.113.80']) {
    const fixture = reader();
    assert.equal((await observeNetworkLinkFixture(plan, { ...options, probeIPv4 }, fixture.fixture)).verified, false);
    assert.equal(fixture.commands.length, 0);
  }
  const fixture = reader();
  assert.equal((await observeNetworkLinkFixture({ ...plan, sha256: 'b'.repeat(64) }, options, fixture.fixture)).verified, false);
  assert.equal(fixture.commands.length, 0);
  for (const patch of [{ platform: 'win32' }, { root: false }]) {
    assert.equal((await observeNetworkLinkFixture(plan, options, { ...reader().fixture, ...patch })).verified, false);
  }
  assert.equal((await observeNetworkLinkFixture(plan, { ...options, ipBinary: '/tmp/ip' } as unknown as NetworkLinkOptions,
    reader().fixture)).verified, false);
  if (process.platform !== 'linux') {
    const production = await observeNetworkLink(plan, options);
    assert.equal(production.scope, 'production'); assert.equal(production.verified, false);
  }
});
