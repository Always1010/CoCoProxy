import test from 'node:test';
import assert from 'node:assert/strict';
import { observeNetworkReadiness, observeNetworkReadinessFixture } from '../packages/network/probe.ts';
import type { NetworkProbeFixtureReader, NetworkProbeIdentity, NetworkProbeOptions } from '../packages/network/probe.ts';
import { renderNetworkPlan } from '../packages/network/plan.ts';

const plan = renderNetworkPlan({ schemaVersion: 1, generation: 'a'.repeat(64),
  core: { serviceUid: 12345, binarySha256: 'b'.repeat(64), unitSha256: 'c'.repeat(64) },
  ingressInterface: 'lan-test', gatewayIPv4: '192.0.2.2', prefixLength: 24,
  routerIPv4: '192.0.2.1', routerMAC: '02:00:00:00:00:01', clientIPv4: '192.0.2.3', dnsPort: 15353,
  tun: { interface: 'coproxy-tun', mtu: 1500 },
  marks: { mask: 0xff00, capture: 0x100, egress: 0x200, return: 0x300 },
  tables: { capture: 10003, egress: 10002, return: 10001 }, priorities: { capture: 10003, egress: 10002, return: 10001 } });
const identity: NetworkProbeIdentity = { corePid: 101, corePidStartTime: '123456', serviceUid: 12345,
  bootId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' };
const options: NetworkProbeOptions = { queryDomain: 'probe.invalid', expectedIPv4: '198.51.100.77', ipBinary: '/usr/sbin/ip' };

function answer(query: Buffer, cname = false): Buffer {
  const header = Buffer.from(query.subarray(0, 12)); header.writeUInt16BE(0x8180, 2); header.writeUInt16BE(cname ? 2 : 1, 6);
  const a = Buffer.from([0, 1, 0, 1, 0, 0, 0, 5, 0, 4, 198, 51, 100, 77]);
  const alias = Buffer.from([5, ...Buffer.from('alias'), 7, ...Buffer.from('invalid'), 0]);
  return Buffer.concat([header, query.subarray(12), Buffer.from([0xc0, 12]),
    ...(cname ? [Buffer.from([0, 5, 0, 1, 0, 0, 0, 5, 0, alias.length]), alias, alias] : []), a]);
}

function fixture() {
  const data = new Map<string, string>([
    ['/proc/self/mountinfo', '1 0 0:1 / /proc rw - proc proc rw\n' +
      '2 1 0:2 / /proc/sys/fs/binfmt_misc rw - autofs systemd-1 rw\n' +
      '3 2 0:3 / /proc/sys/fs/binfmt_misc rw - binfmt_misc binfmt_misc rw\n'],
    ['/proc/sys/kernel/random/boot_id', identity.bootId + '\n'],
    ['/proc/101/stat', `101 (synthetic ) comm) S ${Array(18).fill('0').join(' ')} 123456 0\n`],
    ['/proc/101/status', 'Uid:\t12345\t12345\t12345\t12345\n'],
    ['/proc/101/fdinfo/5', 'pos:\t0\nflags:\t0100002\niff:\tcoproxy-tun\n'],
  ]);
  for (const [index, protocol] of ['udp', 'tcp'].entries()) {
    data.set(`/proc/101/net/${protocol}`, '  sl local_address rem_address st tx_queue rx_queue tr tm->when retrnsmt uid timeout inode\n' +
      `0: 020200C0:3BF9 00000000:0000 ${protocol === 'tcp' ? '0A' : '07'} 00000000:00000000 00:00000000 00000000 12345 0 ${300 + index} 2\n`);
    data.set(`/proc/101/net/${protocol}6`, '  sl local_address remote_address st\n');
  }
  const queries: Buffer[] = [];
  const reader: NetworkProbeFixtureReader = {
    platform: 'linux', root: true,
    async read(path) { if (!data.has(path)) throw new Error('secret synthetic details'); return data.get(path)!; },
    async link(path) {
      if (path.includes('/ns/')) return `${path.split('/').at(-1)}:[1234]`;
      return ({ '3': 'socket:[300]', '4': 'socket:[301]', '5': '/dev/net/tun' } as Record<string, string>)[path.split('/').at(-1)!];
    },
    async entries() { return ['3', '4', '5']; }, async procType() { return 0x9fa0n; }, async tunDevice() { return true; },
    async address() { return JSON.stringify([{ ifname: 'coproxy-tun', ifindex: 9, mtu: 1500, flags: ['UP'],
      linkinfo: { info_kind: 'tun', info_data: { type: 'tun' } }, addr_info: [{ family: 'inet', local: '198.18.0.1', prefixlen: 30 }] }]); },
    async exchange(protocol, query, address, port, timeoutMs) {
      assert.equal(protocol, queries.length === 0 ? 'udp' : 'tcp');
      assert.equal(address, plan.deployment.gatewayIPv4); assert.equal(port, plan.deployment.dnsPort); assert.equal(timeoutMs, 1000);
      queries.push(Buffer.from(query)); return answer(query, protocol === 'tcp');
    },
  };
  return { data, queries, reader };
}

test('fresh UDP and TCP DNS answers plus exact PID socket/TUN facts produce fixture-only local checks', async () => {
  const f = fixture();
  // Completed TCP DNS exchanges legitimately leave same-port TIME_WAIT entries.
  f.data.set('/proc/101/net/tcp', f.data.get('/proc/101/net/tcp')! +
    '1: 020200C0:3BF9 0100007F:ABCD 06 00000000:00000000 00:00000000 00000000 0 0 0 2\n');
  const result = await observeNetworkReadinessFixture(plan, identity, options, f.reader);
  assert.equal(result.verified, true); assert.equal(result.scope, 'fixture'); assert.equal(result.terminalPath, 'unverified');
  assert.equal(Object.values(result.checks).every(Boolean), true); assert.equal(f.queries.length, 2);
  assert.notDeepEqual(f.queries[0].subarray(12), f.queries[1].subarray(12));
  assert.equal(JSON.stringify(result).includes('probe.invalid'), false); assert.equal(Object.hasOwn(result, 'ready'), false);
});

test('ownership, namespace, mount, PID reuse and exact TUN configuration fail closed without raw details', async () => {
  const changes: ((f: ReturnType<typeof fixture>) => void)[] = [
    f => { f.reader.root = false; },
    f => { f.data.set('/proc/101/net/udp', f.data.get('/proc/101/net/udp')!.replace('020200C0', '00000000')); },
    f => { f.data.set('/proc/101/net/tcp', f.data.get('/proc/101/net/tcp')!.replace('12345 0 301', '54321 0 301')); },
    f => { f.reader.entries = async () => ['3', '5']; },
    f => { f.data.set('/proc/101/fdinfo/5', 'iff:\tunrelated\n'); },
    f => { f.reader.tunDevice = async () => false; },
    f => { f.reader.address = async () => '[{"ifname":"coproxy-tun","mtu":1400}]'; },
    f => { const original = f.reader.link; f.reader.link = async path => path === '/proc/101/ns/net' ? 'net:[9999]' : original(path); },
    f => { f.data.set('/proc/self/mountinfo', f.data.get('/proc/self/mountinfo')! + '2 1 0:2 / /proc/101/net rw - tmpfs tmpfs rw\n'); },
    f => { const original = f.reader.read; let count = 0; f.reader.read = async path => {
      const text = await original(path); return path === '/proc/101/stat' && ++count > 1 ? text.replace('123456', '999999') : text;
    }; },
  ];
  for (const change of changes) {
    const f = fixture(); change(f); const result = await observeNetworkReadinessFixture(plan, identity, options, f.reader);
    assert.equal(result.verified, false); assert.equal(result.reason, 'NETWORK_PROBE_UNVERIFIED');
    assert.equal(Object.values(result.checks).some(Boolean), false); assert.equal(JSON.stringify(result).includes('secret'), false);
  }
});

test('wrong DNS ID/question, RCODE, truncation, unexpected A, unrelated answer and malformed compression are rejected', async () => {
  const mutations: ((packet: Buffer) => Buffer)[] = [
    packet => { packet.writeUInt16BE(packet.readUInt16BE() ^ 1); return packet; },
    packet => { packet[13] = packet[13] === 97 ? 98 : 97; return packet; },
    packet => { packet[3] |= 3; return packet; },
    packet => { packet[2] |= 2; return packet; },
    packet => { packet[packet.length - 1] = 78; return packet; },
    packet => packet.subarray(0, packet.length - 1),
    packet => { packet[packet.length - 15] = 0xff; return packet; },
    packet => Buffer.concat([packet, Buffer.from([0])]),
  ];
  for (const mutate of mutations) {
    const f = fixture(); f.reader.exchange = async (_protocol, query) => mutate(answer(query));
    assert.equal((await observeNetworkReadinessFixture(plan, identity, options, f.reader)).verified, false);
  }
  const f = fixture(); f.reader.exchange = async () => { throw new Error('sensitive query response'); };
  assert.equal((await observeNetworkReadinessFixture(plan, identity, options, f.reader)).verified, false);
});

test('production cannot use synthetic reader and unsupported hosts stay unverified', async () => {
  if (process.platform === 'linux') return;
  const result = await observeNetworkReadiness(plan, identity, options);
  assert.equal(result.scope, 'production'); assert.equal(result.verified, false);
});
