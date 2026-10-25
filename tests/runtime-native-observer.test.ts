import assert from 'node:assert/strict';
import test from 'node:test';
import { AUTOMATIC_GATEWAY_CORE_SHA256 } from '../packages/gateway/profile.ts';
import { observeCoreFixture, type CoreObserverFixtureReader } from '../packages/runtime/observer.ts';
import type { RuntimeSettings, RuntimeUnitState } from '../packages/runtime/types.ts';

const generation = 'a'.repeat(64), pid = 43210, uid = 12345;
const binary = '/opt/coproxy/mihomo', home = '/var/lib/coproxy/core-home';
const path = `/var/lib/coproxy/candidates/${generation}.json`, proc = `/proc/${pid}`;
const errno = (code: string) => Object.assign(new Error('synthetic private diagnostic'), { code });
function fixture() {
  const settings: RuntimeSettings = { schemaVersion: 1, stateDirectory: '/var/lib/coproxy', binaryPath: binary,
    binarySha256: AUTOMATIC_GATEWAY_CORE_SHA256, systemctlPath: '/usr/bin/systemctl',
    unitPath: '/etc/systemd/system/coproxy-mihomo.service', unitSha256: 'b'.repeat(64), serviceUid: uid,
    automaticGateway: { schemaVersion: 1, ingressInterface: 'lan-test', gatewayIPv4: '192.0.2.2', routerIPv4: '192.0.2.1',
      routerMAC: '02:00:00:00:00:01', clientIPv4: '192.0.2.3', prefixLength: 24, dnsPort: 15353,
      egressMark: 0x200, egressTable: 10002, egressPriority: 8000, tunMtu: 1500 } };
  const unit: RuntimeUnitState = { loadState: 'loaded', activeState: 'active', subState: 'running', mainPid: pid,
    jobPending: false, fragmentPath: settings.unitPath, hasDropIns: false, needsReload: false, user: String(uid) };
  const stat = (start = '42') => `${pid} (core with ) space) S ${'0 '.repeat(18)}${start}\n`;
  const files = new Map([
    [`${proc}/stat`, stat()], [`${proc}/status`, `Uid:\t${uid}\t${uid}\t${uid}\t${uid}\nCapPrm:\t0000000000003000\n`],
    [`${proc}/cmdline`, [binary, '-d', home, '-f', path, ''].join('\0')],
    [`${proc}/cgroup`, '0::/system.slice/coproxy-mihomo.service\n'],
    [`${proc}/net/tcp`, 'header\n0: 0100007F:4A92 00000000:0000 0A 0 0 0 0 0 777\n'],
  ]);
  const faults = new Map<string, string>(), calls = { unit: 0, binary: 0, version: 0 };
  let afterVersion: () => void = () => {};
  const reader: CoreObserverFixtureReader = {
    async read(name, max) { if (faults.has(name)) throw errno(faults.get(name)!); const value = Buffer.from(files.get(name) ?? ''); assert.ok(value.length <= max); return value; },
    async realpath(name) { if (faults.has(name)) throw errno(faults.get(name)!); assert.ok([binary, `${proc}/exe`].includes(name)); return binary; },
    async entries(name) { assert.equal(name, `${proc}/fd`); if (faults.has(name)) throw errno(faults.get(name)!); return ['7']; },
    async link(name) { assert.equal(name, `${proc}/fd/7`); if (faults.has(name)) throw errno(faults.get(name)!); return 'socket:[777]'; },
    async unit(_settings, state) {
      calls.unit++;
      if (state.fragmentPath !== settings.unitPath || state.user !== String(uid) || state.hasDropIns || state.needsReload) throw new Error();
    },
    async binary() { calls.binary++; return binary; },
    async candidate() { return { candidate: { id: generation, sha256: generation, config: {} }, path, home,
      controller: { port: 19090, secret: 'synthetic-controller-secret' } }; },
    async version(port, secret) { calls.version++; assert.equal(port, 19090); assert.equal(secret, 'synthetic-controller-secret'); afterVersion(); },
  };
  return { settings, unit, files, faults, calls, reader, stat, afterVersion(fn: () => void) { afterVersion = fn; },
    observe() { return observeCoreFixture(settings, generation, unit, reader); } };
}

test('native capability permission denials use explicitly limited unit/controller evidence', { skip: process.platform !== 'linux' }, async () => {
  for (const operation of [`${proc}/exe`, `${proc}/fd`, `${proc}/fd/7`]) {
    for (const code of ['EACCES', 'EPERM']) {
      const f = fixture(); f.faults.set(operation, code);
      const result = await f.observe();
      assert.equal(result.ready, true, `${operation} ${code}`);
      assert.equal(result.evidence, 'native-unit-and-controller'); assert.equal(result.scope, 'fixture');
      assert.deepEqual(f.calls, { unit: 2, binary: 2, version: 1 });
      assert.ok(!JSON.stringify(result).includes('synthetic-controller-secret'));
    }
  }
  const strict = await fixture().observe();
  assert.equal(strict.ready, true); assert.equal(strict.evidence, 'proc-exe-and-fd');
});

test('restricted observation never accepts explicit mode, unknown errors, bad identity or untrusted unit', { skip: process.platform !== 'linux' }, async () => {
  for (const operation of [`${proc}/exe`, `${proc}/fd`, `${proc}/fd/7`]) {
    const explicit = fixture(); delete explicit.settings.automaticGateway; explicit.faults.set(operation, 'EACCES');
    assert.equal((await explicit.observe()).ready, false);
    for (const code of ['ENOENT', 'EIO']) {
      const f = fixture(); f.faults.set(operation, code);
      assert.equal((await f.observe()).ready, false);
    }
  }
  const mutations: ((f: ReturnType<typeof fixture>) => void)[] = [
    f => { f.unit.fragmentPath += '.other'; }, f => { f.unit.user = '54321'; },
    f => { f.unit.mainPid++; }, f => { f.unit.hasDropIns = true; }, f => { f.unit.needsReload = true; },
    f => { f.files.set(`${proc}/stat`, f.stat().replace(String(pid), '43211')); },
    f => { f.files.set(`${proc}/status`, `Uid:\t${uid}\t${uid}\t0\t${uid}\nCapPrm:\t3000\n`); },
    f => { f.files.set(`${proc}/status`, `Uid:\t${uid}\t${uid}\t${uid}\t${uid}\nCapPrm:\t0\n`); },
    f => { f.files.set(`${proc}/cmdline`, ['other', '-d', home, '-f', path, ''].join('\0')); },
    f => { f.files.set(`${proc}/cmdline`, [binary, 'extra', '-d', home, '-f', path, ''].join('\0')); },
    f => { f.files.set(`${proc}/cmdline`, [binary, '-d', home, '-f', path + '.other', ''].join('\0')); },
    f => { f.files.set(`${proc}/cgroup`, '0::/system.slice/other.service\n'); },
    f => { f.faults.set(`${proc}/net/tcp`, 'EACCES'); },
    f => { f.reader.unit = async () => { throw new Error(); }; },
    f => { f.reader.binary = async () => { throw new Error(); }; },
  ];
  for (const mutate of mutations) {
    const f = fixture(); f.faults.set(`${proc}/exe`, 'EACCES'); mutate(f);
    const result = await f.observe(); assert.equal(result.ready, false); assert.equal(result.evidence, undefined);
  }
});

test('native restriction still requires authenticated controller and stable identity after its reply', { skip: process.platform !== 'linux' }, async () => {
  const rejected = fixture(); rejected.faults.set(`${proc}/fd`, 'EACCES');
  rejected.reader.version = async () => { throw new Error('private controller response'); };
  assert.equal((await rejected.observe()).reason, 'CONTROLLER_UNREADY');
  const notOwned = fixture(); notOwned.faults.set(`${proc}/exe`, 'EACCES'); notOwned.reader.link = async () => 'socket:[999]';
  assert.equal((await notOwned.observe()).reason, 'CONTROLLER_NOT_OWNED');
  const wrongExe = fixture(); wrongExe.reader.realpath = async name => name.endsWith('/exe') ? '/opt/other/core' : binary;
  assert.equal((await wrongExe.observe()).reason, 'PROCESS_UNVERIFIED');
  for (const changed of ['pid', 'unit', 'binary']) {
    const f = fixture(); f.faults.set(`${proc}/exe`, 'EACCES');
    f.afterVersion(() => {
      if (changed === 'pid') f.files.set(`${proc}/stat`, f.stat('43'));
      if (changed === 'unit') f.reader.unit = async () => { throw new Error(); };
      if (changed === 'binary') f.reader.binary = async () => { throw new Error(); };
    });
    assert.equal((await f.observe()).reason, 'PROCESS_CHANGED');
  }
});
