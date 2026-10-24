import assert from 'node:assert/strict';
import test from 'node:test';
import { NetworkCommandError } from '../packages/network/command.ts';
import { GATEWAY_CORE_SHA256 } from '../packages/network/config.ts';
import { renderNetworkPlan } from '../packages/network/plan.ts';
import { observeSocketSourcesFixture, type SocketSourceBinding, type SocketSourceFixtureReader,
  type SocketSourceObservation } from '../packages/network/sockets.ts';

const plan = renderNetworkPlan({ schemaVersion: 1, generation: 'a'.repeat(64),
  core: { serviceUid: 12345, binarySha256: GATEWAY_CORE_SHA256, unitSha256: 'c'.repeat(64) },
  ingressInterface: 'lan-test', gatewayIPv4: '192.0.2.2', prefixLength: 24, routerIPv4: '192.0.2.1',
  routerMAC: '02:00:00:00:00:01', clientIPv4: '192.0.2.3', dnsPort: 15353,
  tun: { interface: 'coproxy-tun', mtu: 1500 }, marks: { mask: 0xff00, capture: 0x100, egress: 0x200, return: 0x300 },
  tables: { capture: 10003, egress: 10002, return: 10001 }, priorities: { capture: 10003, egress: 10002, return: 10001 } });
const boot = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
function binding(): SocketSourceBinding {
  return { bootId: boot, core: { pid: 1001, startTime: '12345678', uid: 12345, cgroupKernelId: '777' },
    management: { pid: 1002, startTime: '12345679', uid: 12346, cgroupKernelId: '888' } };
}
interface Socket {
  inode: string; cookie: string; family: number; protocol: string; uid: number; state: number;
  localAddress: string; remoteAddress: string; localPort: number; remotePort: number; ifindex: number;
  mark: number | null; cgroupID: string | null;
}
function model() {
  const socket = (inode: string, overrides: Partial<Socket> = {}): Socket => ({ inode, cookie: String(Number(inode) + 10000),
    family: 4, protocol: 'tcp', uid: 12345, state: 10, localAddress: '192.0.2.2', remoteAddress: '0.0.0.0',
    localPort: 15353, remotePort: 0, ifindex: 0, mark: 512, cgroupID: '777', ...overrides });
  return { schemaVersion: 1, bootId: boot, userNS: 'user:[100]', netNS: 'net:[200]', processes: [
    { pid: 1001, startTime: '12345678', uids: [12345, 12345, 12345, 12345], inodes: ['101', '102', '103', '104', '301'] },
    { pid: 1002, startTime: '12345679', uids: [12346, 12346, 12346, 12346], inodes: ['201', '302'] },
  ], uidPeers: [{ uid: 12345, pids: [1001] }, { uid: 12346, pids: [1002] }], sockets: [
    socket('101'), socket('102', { protocol: 'udp', state: 7 }),
    socket('103', { localAddress: '127.0.0.1', localPort: 19090, mark: 0 }),
    socket('104', { protocol: 'udp', state: 1, localPort: 40000, remoteAddress: '203.0.113.80', remotePort: 443 }),
    socket('201', { uid: 12346, localAddress: '127.0.0.1', localPort: 18080, mark: 0, cgroupID: '888' }),
  ], nonInet: [{ inode: '301', family: 'unix' }, { inode: '302', family: 'netlink' }], unknown: [] as string[] };
}
type Model = ReturnType<typeof model>;
function fixture(first: Model | string = model(), second: Model | string = first, times = [1000, 1010]) {
  let dumps = 0, ticks = 0;
  const calls: number[][] = [];
  const reader: SocketSourceFixtureReader = {
    async dump(pids) {
      calls.push([...pids]); const value = dumps++ === 0 ? first : second;
      return typeof value === 'string' ? value : JSON.stringify(value) + '\n';
    },
    now() { return times[Math.min(ticks++, times.length - 1)]; },
  };
  return { reader, calls };
}
function unverified(result: SocketSourceObservation): void {
  assert.equal(result.scope, 'fixture'); assert.equal(result.verified, false);
  assert.equal(result.reason, 'NETWORK_SOCKET_UNVERIFIED');
  assert.doesNotMatch(JSON.stringify(result), /192\.0\.2\.|203\.0\.113\.|user:\[|net:\[|cookie|cgroupID|startTime|inodes/);
}
async function rejectModel(change: (data: Model) => void) {
  const data = model(); change(data);
  unverified(await observeSocketSourcesFixture(plan, binding(), { stage: 'ready' }, fixture(data).reader));
}

test('socket sources verify real DNS listener shapes, dedicated process identities and UDP/TCP upstream without leaking raw facts', async t => {
  for (const protocol of ['udp', 'tcp']) await t.test(protocol, async () => {
    const data = model(); data.sockets[3].protocol = protocol;
    const f = fixture(data), result = await observeSocketSourcesFixture(plan, binding(), { stage: 'ready' }, f.reader);
    assert.equal(result.scope, 'fixture'); assert.equal(result.verified, true); assert.equal(result.reason, null);
    assert.equal(result.commandsSettled, true);
    assert.equal(result.stage, 'ready'); assert.equal(result.checkedAt, 1010);
    assert.equal(result.planSha256, plan.sha256); assert.equal(result.generation, plan.deployment.generation);
    assert.ok(Object.values(result.checks).every(Boolean));
    assert.deepEqual(result.counts, { core: 4, management: 1, upstream: 1 });
    assert.deepEqual(f.calls, [[1001, 1002], [1001, 1002]]);
    assert.doesNotMatch(JSON.stringify(result), /192\.0\.2\.|203\.0\.113\.|cookie|cgroupID|uids/);
  });
  const data = model();
  data.sockets = data.sockets.filter(socket => socket.inode !== '104');
  data.processes[0].inodes = data.processes[0].inodes.filter(inode => inode !== '104');
  const identity = await observeSocketSourcesFixture(plan, binding(), { stage: 'identity' }, fixture(data).reader);
  assert.equal(identity.verified, true); assert.equal(identity.checks.upstreamObserved, false);
  const ready = await observeSocketSourcesFixture(plan, binding(), { stage: 'ready' }, fixture(data).reader);
  unverified(ready); assert.equal(ready.checks.upstreamObserved, false);
});

test('missing marks, wrong cgroup/UID and shared file descriptors never acquire socket authority', async t => {
  const changes: Array<[string, (data: Model) => void]> = [
    ['core mark unavailable', data => { data.sockets[0].mark = null; }],
    ['management mark unavailable must not become zero', data => { data.sockets[4].mark = null; }],
    ['core cgroup', data => { data.sockets[3].cgroupID = '888'; }],
    ['management cgroup', data => { data.sockets[4].cgroupID = '777'; }],
    ['missing cgroup', data => { data.sockets[0].cgroupID = null; }],
    ['core socket UID', data => { data.sockets[0].uid = 12346; }],
    ['management socket UID', data => { data.sockets[4].uid = 12345; }],
    ['one effective/saved UID differs', data => { data.processes[0].uids[2] = 0; }],
    ['management reserves egress mark', data => { data.sockets[4].mark = 512; }],
    ['core wrong reserved mark', data => { data.sockets[3].mark = 256; }],
    ['INET fd shared by both processes', data => { data.processes[1].inodes.push('101'); }],
    ['non-INET fd shared by both processes', data => { data.processes[1].inodes.push('301'); }],
    ['extra process with core UID', data => { data.uidPeers[0].pids.push(1003); }],
    ['extra process with management UID', data => { data.uidPeers[1].pids.push(1003); }],
  ];
  for (const [name, change] of changes) await t.test(name, () => rejectModel(change));
  for (const role of ['same UID', 'same cgroup', 'same PID'] as const) await t.test(role, async () => {
    const target = binding();
    if (role === 'same UID') target.management.uid = target.core.uid;
    if (role === 'same cgroup') target.management.cgroupKernelId = target.core.cgroupKernelId;
    if (role === 'same PID') target.management.pid = target.core.pid;
    const f = fixture();
    unverified(await observeSocketSourcesFixture(plan, target, { stage: 'identity' }, f.reader));
    assert.equal(f.calls.length, 0);
  });
  await t.test('explicit management UID binds the plan before dumping', async () => {
    const managedPlan = renderNetworkPlan({ ...plan.deployment, management: { serviceUid: 12346 } });
    const matching = await observeSocketSourcesFixture(managedPlan, binding(), { stage: 'identity' }, fixture().reader);
    assert.equal(matching.verified, true); assert.equal(matching.planSha256, managedPlan.sha256);
    const wrong = binding(); wrong.management.uid = 12347;
    const f = fixture();
    unverified(await observeSocketSourcesFixture(managedPlan, wrong, { stage: 'identity' }, f.reader));
    assert.equal(f.calls.length, 0);
  });
});

test('DNS source proof requires exactly one gateway TCP LISTEN and UDP CLOSE listener on the same planned port', async t => {
  const changes: Array<[string, (data: Model) => void]> = [
    ['IPv4 wildcard', data => { data.sockets[0].localAddress = '0.0.0.0'; }],
    ['IPv6 wildcard', data => { Object.assign(data.sockets[1], { family: 6, localAddress: '::', remoteAddress: '::' }); }],
    ['TCP and UDP use different ports', data => { data.sockets[1].localPort++; }],
    ['TCP not LISTEN', data => { data.sockets[0].state = 1; }],
    ['UDP not CLOSE', data => { data.sockets[1].state = 1; }],
    ['missing UDP listener', data => {
      data.sockets.splice(1, 1); data.processes[0].inodes = data.processes[0].inodes.filter(inode => inode !== '102');
    }],
    ['duplicate TCP listener', data => {
      data.sockets.push({ ...data.sockets[0], inode: '105', cookie: '10105' }); data.processes[0].inodes.push('105');
    }],
    ['DNS mark zero', data => { data.sockets[0].mark = 0; }],
  ];
  for (const [name, change] of changes) await t.test(name, () => rejectModel(change));
});

test('every requested socket FD is classified once; unknown or contradictory inventory fails closed', async t => {
  const changes: Array<[string, (data: Model) => void]> = [
    ['unknown FD', data => { data.processes[0].inodes.push('999'); data.unknown.push('999'); }],
    ['unclassified FD', data => { data.processes[0].inodes.push('999'); }],
    ['unrequested socket', data => { data.sockets.push({ ...data.sockets[3], inode: '999', cookie: '10999' }); }],
    ['INET/non-INET duplicate', data => { data.nonInet.push({ inode: '101', family: 'unix' }); }],
    ['duplicate socket cookie', data => { data.sockets[1].cookie = data.sockets[0].cookie; }],
    ['missing non-INET classification', data => { data.nonInet.pop(); }],
    ['unexpected process', data => { data.processes.push({ pid: 1003, startTime: '99', uids: [12347, 12347, 12347, 12347], inodes: [] }); }],
  ];
  for (const [name, change] of changes) await t.test(name, () => rejectModel(change));
});

test('critical DNS cookies and process/namespace bindings stay stable while legitimate temporary upstream sockets can change', async t => {
  const changes: Array<[string, (data: Model) => void]> = [
    ['DNS TCP cookie replaced', data => { data.sockets[0].cookie = '99999'; }],
    ['DNS UDP cookie replaced', data => { data.sockets[1].cookie = '99999'; }],
    ['user namespace', data => { data.userNS = 'user:[101]'; }],
    ['network namespace', data => { data.netNS = 'net:[201]'; }],
    ['boot changed', data => { data.bootId = 'bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee'; }],
    ['process start time', data => { data.processes[0].startTime = '12345680'; }],
    ['UID peer appeared', data => { data.uidPeers[0].pids.push(1003); }],
  ];
  for (const [name, change] of changes) await t.test(name, async () => {
    const after = model(); change(after);
    unverified(await observeSocketSourcesFixture(plan, binding(), { stage: 'ready' }, fixture(model(), after).reader));
  });
  await t.test('upstream socket replaced between dumps', async () => {
    const after = model();
    Object.assign(after.sockets[3], { inode: '105', cookie: '10105', localPort: 40001, remotePort: 8443 });
    after.processes[0].inodes[3] = '105';
    assert.equal((await observeSocketSourcesFixture(plan, binding(), { stage: 'ready' }, fixture(model(), after).reader)).verified, true);
  });
  for (const [name, times] of [['too slow', [1000, 6001]], ['backward', [1000, 999]],
    ['invalid final time', [1000, NaN]], ['infinite final time', [1000, Infinity]]] as const) await t.test(name, async () => {
    const data = model();
    unverified(await observeSocketSourcesFixture(plan, binding(), { stage: 'ready' }, fixture(data, data, [...times]).reader));
  });
});

test('unconnected UDP and incomplete TCP do not count as an observed upstream endpoint', async t => {
  for (const [name, change] of [
    ['unconnected UDP', { state: 7, remoteAddress: '0.0.0.0', remotePort: 0 }],
    ['TCP SYN pending', { protocol: 'tcp', state: 2 }],
    ['loopback remote', { remoteAddress: '127.0.0.2' }],
    ['multicast remote', { remoteAddress: '224.0.0.1' }],
    ['missing remote port', { remotePort: 0 }],
  ] as Array<[string, Partial<Socket>]>) await t.test(name, async () => {
    const data = model(); Object.assign(data.sockets[3], change);
    const identity = await observeSocketSourcesFixture(plan, binding(), { stage: 'identity' }, fixture(data).reader);
    assert.equal(identity.verified, true); assert.equal(identity.counts?.upstream, 0);
    unverified(await observeSocketSourcesFixture(plan, binding(), { stage: 'ready' }, fixture(data).reader));
  });
});

test('malicious binding descriptors and proxies are rejected before dumping or executing their code', async () => {
  let invoked = false;
  const getter = binding();
  Object.defineProperty(getter, 'core', { enumerable: true, get() { invoked = true; return binding().core; } });
  const nestedGetter = binding();
  Object.defineProperty(nestedGetter.core, 'uid', { enumerable: true, get() { invoked = true; return 12345; } });
  const proxy = new Proxy({}, { getPrototypeOf() { invoked = true; throw new Error('synthetic-private'); } });
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  const nestedProxy = binding(); nestedProxy.management = proxy as unknown as SocketSourceBinding['management'];
  for (const target of [getter, nestedGetter, proxy, revoked.proxy, nestedProxy]) {
    const f = fixture();
    unverified(await observeSocketSourcesFixture(plan, target as SocketSourceBinding, { stage: 'identity' }, f.reader));
    assert.equal(f.calls.length, 0);
  }
  assert.equal(invoked, false);
});

test('malformed, duplicate, incomplete and oversized helper JSON cannot become evidence', async t => {
  const original = JSON.stringify(model());
  const missing = model() as unknown as Record<string, unknown>; delete missing.nonInet;
  const socketMissing = model(); delete (socketMissing.sockets[0] as unknown as Record<string, unknown>).mark;
  const tooManySockets = model();
  tooManySockets.sockets = Array.from({ length: 4097 }, (_, index) => ({ ...tooManySockets.sockets[3], inode: String(index + 1000), cookie: String(index + 11000) }));
  assert.ok(Buffer.byteLength(JSON.stringify(tooManySockets)) < 1_048_576, 'socket cardinality case stays below the independent byte limit');
  const invalid: Array<[string, string]> = [
    ['malformed', '{'], ['non-object', '[]'], ['missing field', JSON.stringify(missing)],
    ['missing mark', JSON.stringify(socketMissing)],
    ['duplicate key', original.replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1')],
    ['escaped duplicate key', original.replace('"schemaVersion":1', '"schemaVersion":1,"\\u0073chemaVersion":1')],
    ['noncanonical whitespace', original + ' '], ['trailing content', original + '{}'],
    ['byte limit', ' '.repeat(1_048_577)], ['socket count limit', JSON.stringify(tooManySockets)],
  ];
  for (const [name, raw] of invalid) await t.test(name, async () => {
    const result = await observeSocketSourcesFixture(plan, binding(), { stage: 'ready' }, fixture(raw).reader);
    unverified(result); assert.equal(result.commandsSettled, true);
  });
  for (const error of [new NetworkCommandError('synthetic-private'), new NetworkCommandError('synthetic-private', false),
    Object.assign(new Error('synthetic-private'), { childSettled: false })]) {
    const f = fixture(); let dumps = 0;
    f.reader.dump = async () => { dumps++; throw error; };
    const result = await observeSocketSourcesFixture(plan, binding(), { stage: 'ready' }, f.reader);
    unverified(result);
    assert.equal(result.commandsSettled, !(error instanceof NetworkCommandError && error.childSettled === false));
    assert.equal(dumps, 1); assert.doesNotMatch(JSON.stringify(result), /synthetic-private/);
  }
});
