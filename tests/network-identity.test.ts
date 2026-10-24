import test from 'node:test';
import assert from 'node:assert/strict';
import { CORE_CONTROL_GROUP, MANAGEMENT_CONTROL_GROUP, observeCoreCgroup, observeCoreCgroupFixture } from '../packages/network/identity.ts';
import type { CgroupFixtureReader, CoreCgroupRequest } from '../packages/network/identity.ts';

const root = '/sys/fs/cgroup';
const request: CoreCgroupRequest = { corePid: 101, managementPid: 202, serviceUid: 12345,
  bootId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', corePidStartTime: '123456' };

function fixture() {
  const data = new Map<string, string>([
    ['/proc/self/mountinfo', '1 0 0:1 / /proc rw - proc proc rw\n2 0 0:2 / /sys/fs/cgroup rw - cgroup2 cgroup rw\n' +
      '3 1 0:3 / /proc/sys/fs/binfmt_misc rw - autofs systemd-1 rw\n' +
      '4 3 0:4 / /proc/sys/fs/binfmt_misc rw - binfmt_misc binfmt_misc rw\n'],
    ['/proc/sys/kernel/random/boot_id', request.bootId + '\n'],
  ]);
  for (const [pid, group] of [[101, CORE_CONTROL_GROUP], [202, MANAGEMENT_CONTROL_GROUP]] as const) {
    data.set(`/proc/${pid}/stat`, `${pid} (synthetic ) comm) S ${Array(18).fill('0').join(' ')} ${pid === 101 ? '123456' : '234567'} 0\n`);
    data.set(`/proc/${pid}/status`, 'Uid:\t12345\t12345\t12345\t12345\n' +
      ['CapInh', 'CapPrm', 'CapEff', 'CapAmb'].map(name => `${name}:\t0000000000000000\n`).join('') + 'NoNewPrivs:\t1\n');
    data.set(`/proc/${pid}/cgroup`, `0::${group}\n`);
    data.set(`${root}${group}/cgroup.type`, 'domain\n');
    data.set(`${root}${group}/cgroup.subtree_control`, '\n');
    data.set(`${root}${group}/cgroup.procs`, `${pid}\n`);
  }
  const reader: CgroupFixtureReader = {
    platform: 'linux', arch: 'arm64', kernelRelease: '6.1.0-synthetic',
    async read(path) { if (!data.has(path)) throw new Error('synthetic private error'); return data.get(path)!; },
    async metadata(path) { return { uid: 0n, mode: path.includes('/cgroup.') ? 0o100644n : 0o040755n,
      dev: 1n, ino: path.includes('management') ? 9007199254741001n : 9007199254740999n, ctimeNs: 1n }; },
    async entries() { return [{ name: 'cgroup.procs', directory: false, symlink: false }]; },
    async fsType(path) { return path === '/proc' ? 0x9fa0n : 0x63677270n; },
    async link(path) { return `${path.split('/').at(-1)}:[12345]`; },
  };
  return { data, reader };
}

test('synthetic identity accepts unrelated binfmt_misc mounts, preserves 64-bit IDs and never claims production scope or ready', async () => {
  const { reader } = fixture();
  const result = await observeCoreCgroupFixture(request, reader);
  assert.equal(result.verified, true);
  assert.equal(result.scope, 'fixture');
  assert.equal(result.identity?.coreCgroupKernelId, '9007199254740999');
  assert.equal(result.identity?.corePidStartTime, request.corePidStartTime);
  assert.equal(result.identity?.managementUnitControlGroup, MANAGEMENT_CONTROL_GROUP);
  assert.equal(Object.hasOwn(result, 'ready'), false);
  assert.ok(Number.isSafeInteger(result.checkedAt));
});

test('cgroup identity accepts a separately bound management UID without changing the identity output shape', async () => {
  const shared = fixture(), separate = fixture();
  separate.data.set('/proc/202/status', separate.data.get('/proc/202/status')!.replace('12345\t12345\t12345\t12345', '12346\t12346\t12346\t12346'));
  const before = await observeCoreCgroupFixture(request, shared.reader);
  const after = await observeCoreCgroupFixture({ ...request, managementUid: 12346 }, separate.reader);
  assert.equal(after.verified, true); assert.equal(after.scope, 'fixture');
  assert.deepEqual(after.identity, before.identity);
  assert.equal(Object.hasOwn(after.identity!, 'managementUid'), false);
  assert.equal((await observeCoreCgroupFixture({ ...request, managementUid: undefined }, shared.reader)).verified, true);
});

test('cgroup identity requires every management UID field to match its separately bound identity', async () => {
  for (let index = 0; index < 4; index++) {
    const f = fixture(), uids = Array(4).fill('12346'); uids[index] = index === 0 ? '0' : '12345';
    f.data.set('/proc/202/status', f.data.get('/proc/202/status')!.replace('12345\t12345\t12345\t12345', uids.join('\t')));
    const result = await observeCoreCgroupFixture({ ...request, managementUid: 12346 }, f.reader);
    assert.equal(result.verified, false); assert.equal(result.identity, null); assert.equal(result.reason, 'NETWORK_CGROUP_UNVERIFIED');
  }
  const f = fixture();
  assert.equal((await observeCoreCgroupFixture({ ...request, managementUid: 12346 }, f.reader)).verified, false);
});

test('invalid management UID values and executable input descriptors fail before reading kernel state', async () => {
  const f = fixture(); let read = false, invoked = false;
  f.reader.read = async () => { read = true; throw new Error('synthetic private error'); };
  for (const managementUid of [0, -1, 1.5, NaN, Infinity, 4294967295, Number.MAX_SAFE_INTEGER, '12346', null, {}, 1n]) {
    const result = await observeCoreCgroupFixture({ ...request, managementUid } as unknown as CoreCgroupRequest, f.reader);
    assert.equal(result.verified, false); assert.equal(result.identity, null); assert.equal(result.scope, 'fixture');
  }
  const accessor = Object.defineProperty({ ...request }, 'managementUid', {
    enumerable: true, get() { invoked = true; throw new Error('synthetic private error'); },
  });
  const proxy = new Proxy({ ...request, managementUid: 12346 }, { ownKeys() { invoked = true; throw new Error('synthetic private error'); } });
  for (const input of [accessor, proxy]) assert.equal((await observeCoreCgroupFixture(input, f.reader)).verified, false);
  assert.equal(invoked, false); assert.equal(read, false);
});

test('wrong mount, namespace, permissions, foreign member and child groups fail closed', async () => {
  const changes: ((f: ReturnType<typeof fixture>) => void)[] = [
    f => { f.reader.fsType = async () => 1n; },
    f => { f.data.set('/proc/self/mountinfo', f.data.get('/proc/self/mountinfo')!.replace('/ /sys/fs/cgroup', '/subtree /sys/fs/cgroup')); },
    f => { f.data.set('/proc/self/mountinfo', f.data.get('/proc/self/mountinfo')! + '3 2 0:3 / /sys/fs/cgroup/system.slice ro - tmpfs tmpfs ro\n'); },
    f => { f.data.set('/proc/self/mountinfo', f.data.get('/proc/self/mountinfo')! + '5 1 0:5 / /proc/sys/kernel/random/boot_id ro - tmpfs tmpfs ro\n'); },
    f => { f.data.set('/proc/self/mountinfo', f.data.get('/proc/self/mountinfo')! + '5 1 0:5 / /proc/101/status ro - tmpfs tmpfs ro\n'); },
    f => { f.data.set('/proc/self/mountinfo', f.data.get('/proc/self/mountinfo')! + `5 1 0:5 / /proc/${process.pid}/mountinfo ro - tmpfs tmpfs ro\n`); },
    f => { f.reader.link = async path => path.includes('/101/') ? 'net:[6789]' : `${path.split('/').at(-1)}:[12345]`; },
    f => { const original = f.reader.metadata; f.reader.metadata = async path => ({ ...await original(path), mode: 0o040775n }); },
    f => { f.data.set(`${root}${CORE_CONTROL_GROUP}/cgroup.procs`, '101\n303\n'); },
    f => { f.reader.entries = async () => [{ name: 'foreign', directory: true, symlink: false }]; },
    f => { f.data.set('/proc/101/cgroup', `0::${MANAGEMENT_CONTROL_GROUP}\n`); },
    f => { f.data.set('/proc/202/status', f.data.get('/proc/202/status')!.replace('CapEff:\t0000000000000000', 'CapEff:\t0000000000200000')); },
    f => { f.reader.arch = 'arm'; },
  ];
  for (const change of changes) {
    const f = fixture(); change(f);
    const result = await observeCoreCgroupFixture(request, f.reader);
    assert.equal(result.verified, false);
    assert.equal(result.identity, null);
    assert.equal(result.reason, 'NETWORK_CGROUP_UNVERIFIED');
    assert.equal(JSON.stringify(result).includes('private'), false);
  }
});

test('PID reuse, cgroup replacement and boot change during observation discard all evidence', async () => {
  for (const target of ['/proc/101/stat', '/proc/sys/kernel/random/boot_id', `${root}${CORE_CONTROL_GROUP}`]) {
    const f = fixture(); let count = 0;
    if (target.startsWith('/proc')) {
      const original = f.reader.read;
      f.reader.read = async path => {
        const value = await original(path);
        return path === target && ++count > 1 ? value.replace(/123456|aaaaaaaa/, '999999') : value;
      };
    } else {
      const original = f.reader.metadata;
      f.reader.metadata = async path => ({ ...await original(path), ctimeNs: path === target ? BigInt(++count) : 1n });
    }
    const result = await observeCoreCgroupFixture(request, f.reader);
    assert.equal(result.verified, false);
    assert.equal(result.identity, null);
  }
});

test('production entry has no alternate root or injected reader and rejects this non-Linux test host', async t => {
  if (process.platform === 'linux') { t.skip('positive live observation requires independently deployed fixed units'); return; }
  const result = await observeCoreCgroup(request);
  assert.equal(result.scope, 'production');
  assert.equal(result.verified, false);
  assert.equal(result.identity, null);
});
