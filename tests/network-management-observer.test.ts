import assert from 'node:assert/strict';
import { posix } from 'node:path';
import test from 'node:test';
import { NetworkCommandError } from '../packages/network/command.ts';
import { MANAGEMENT_CONTROL_GROUP } from '../packages/network/identity.ts';
import { observeGatewayManagement, observeGatewayManagementFixture, type GatewayManagementFileMetadata,
  type GatewayManagementFixtureReader, type GatewayManagementObservation, type GatewayManagementRequest } from '../packages/network/management-observer.ts';

const pid = 65432, uid = 12345, boot = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const fragment = '/etc/systemd/system/coproxy-management.service', proc = `/proc/${pid}`;
function metadata(mode = 0o100644n): GatewayManagementFileMetadata {
  return { dev: 1n, ino: 100n, uid: 0n, mode, nlink: 1n, size: 100n, mtimeNs: 1n, ctimeNs: 1n };
}
function fixture() {
  const input = { systemctlPath: '/usr/bin/systemctl', managementUid: uid };
  const properties = { LoadState: 'loaded', ActiveState: 'active', SubState: 'running', MainPID: String(pid), Job: '',
    ControlGroup: MANAGEMENT_CONTROL_GROUP, User: String(uid), FragmentPath: fragment, DropInPaths: '', NeedDaemonReload: 'no' };
  const files = new Map<string, Buffer>(), links = new Map<string, string>(), meta = new Map<string, GatewayManagementFileMetadata>();
  for (const path of ['/usr/bin/systemctl', fragment]) {
    meta.set(path, metadata(path.endsWith('systemctl') ? 0o100755n : 0o100644n));
    for (let directory = posix.dirname(path);; directory = posix.dirname(directory)) {
      meta.set(directory, metadata(0o040755n)); if (directory === '/') break;
    }
  }
  const mountinfo = '1 0 0:1 / /proc rw - proc proc rw\n2 0 0:2 / /sys/fs/cgroup rw - cgroup2 cgroup rw\n';
  files.set('/proc/self/mountinfo', Buffer.from(mountinfo));
  files.set('/proc/sys/kernel/random/boot_id', Buffer.from(boot + '\n'));
  for (const owner of ['1', 'self']) files.set(`/proc/${owner}/uid_map`, Buffer.from('0 0 4294967295\n'));
  files.set('/proc/1/status', Buffer.from('Uid:\t0\t0\t0\t0\nNSpid:\t1\n'));
  files.set('/proc/self/status', Buffer.from(`Uid:\t0\t0\t0\t0\nNSpid:\t${process.pid}\n`));
  const status = `Uid:\t${uid}\t${uid}\t${uid}\t${uid}\nNSpid:\t${pid}\n`;
  files.set(proc + '/status', Buffer.from(status));
  const stat = (start = '12345678') => `${pid} (synthetic (management)) S ${Array(18).fill('0').join(' ')} ${start} 0\n`;
  files.set(proc + '/stat', Buffer.from(stat())); files.set(proc + '/cgroup', Buffer.from(`0::${MANAGEMENT_CONTROL_GROUP}\n`));
  for (const [index, name] of ['user', 'net', 'pid', 'cgroup', 'mnt'].entries()) {
    for (const owner of ['1', 'self', String(pid)]) links.set(`/proc/${owner}/ns/${name}`, `${name}:[${100 + index}]`);
  }
  links.set(proc + '/ns/mnt', 'mnt:[999]');
  const calls: string[] = [], model = { afterFirst: undefined as (() => void) | undefined, queries: 0, clocks: 0, finishedAt: 100050 };
  const reader: GatewayManagementFixtureReader = {
    platform: 'linux', root: true,
    async read(path, maximum) { calls.push('read:' + path); const value = files.get(path); if (!value || value.length > maximum) throw new Error('private-error'); return Buffer.from(value); },
    async link(path) { const value = links.get(path); if (!value) throw new Error('private-error'); return value; },
    async realpath(path) { return path; },
    async metadata(path) { const value = meta.get(path); if (!value) throw new Error('private-error'); return { ...value }; },
    async fsType(path) { return path === '/proc' ? 0x9fa0n : 0x63677270n; },
    async command(binary, args) {
      assert.equal(binary, '/usr/bin/systemctl');
      assert.deepEqual(args, ['--no-ask-password', '--no-pager', 'show',
        '--property=LoadState,ActiveState,SubState,MainPID,Job,ControlGroup,User,FragmentPath,DropInPaths,NeedDaemonReload', 'coproxy-management.service']);
      if (model.queries++ === 1) model.afterFirst?.();
      calls.push('query'); return Object.entries(properties).map(([key, value]) => `${key}=${value}\n`).join('');
    },
    now() { return model.clocks++ === 0 ? 100000 : model.finishedAt; },
  };
  return { input, reader, files, links, meta, model, properties, calls, stat, status, mountinfo,
    observe: () => observeGatewayManagementFixture(input, reader) };
}
function unverified(value: GatewayManagementObservation) {
  assert.equal(value.scope, 'fixture'); assert.equal(value.verified, false); assert.equal(value.facts, null);
  assert.equal(value.reason, 'NETWORK_MANAGEMENT_UNVERIFIED');
  assert.doesNotMatch(JSON.stringify(value), /private-error|\/proc\/|\/etc\/|\/usr\//);
}
test('management PID comes from stable fixed systemd service and has fixture provenance', async () => {
  const f = fixture(), result = await f.observe();
  assert.equal(result.verified, true); assert.equal(result.scope, 'fixture'); assert.equal(result.commandsSettled, true);
  assert.deepEqual(result.facts, { managementPid: pid, managementPidStartTime: '12345678', managementUid: uid,
    bootId: boot, managementUnitControlGroup: MANAGEMENT_CONTROL_GROUP });
  assert.equal(f.model.queries, 2); assert.equal(result.checkedAt, f.model.finishedAt);
});
test('management observer rejects caller PID, getters and proxy without running input code or queries', async t => {
  for (const kind of ['pid', 'getter', 'proxy', 'uid', 'path', 'symbol'] as const) await t.test(kind, async () => {
    const f = fixture(); let invoked = false; let input: unknown = f.input;
    if (kind === 'pid') input = { ...f.input, managementPid: pid };
    if (kind === 'getter') input = { systemctlPath: f.input.systemctlPath, get managementUid() { invoked = true; return uid; } };
    if (kind === 'proxy') input = new Proxy(f.input, { ownKeys() { invoked = true; return []; } });
    if (kind === 'uid') input = { ...f.input, managementUid: 0 };
    if (kind === 'path') input = { ...f.input, systemctlPath: '/usr/bin/../bin/systemctl' };
    if (kind === 'symbol') input = { ...f.input, [Symbol('extra')]: true };
    unverified(await observeGatewayManagementFixture(input as GatewayManagementRequest, f.reader));
    assert.equal(invoked, false); assert.equal(f.model.queries, 0);
  });
});
test('management unit authority cannot come from jobs, mutable files, aliases or other services', async t => {
  for (const kind of ['inactive', 'unloaded', 'substate', 'pid1', 'uid', 'job', 'dropin', 'reload', 'group', 'fragment',
    'owner', 'parent', 'hardlink', 'symlink', 'systemctl', 'canonical', 'duplicate', 'unknown'] as const) await t.test(kind, async () => {
    const f = fixture();
    if (kind === 'inactive') f.properties.ActiveState = 'inactive';
    if (kind === 'unloaded') f.properties.LoadState = 'not-found';
    if (kind === 'substate') f.properties.SubState = 'exited';
    if (kind === 'pid1') f.properties.MainPID = '1';
    if (kind === 'uid') f.properties.User = 'root';
    if (kind === 'job') f.properties.Job = '99';
    if (kind === 'dropin') f.properties.DropInPaths = '/synthetic.conf';
    if (kind === 'reload') f.properties.NeedDaemonReload = 'yes';
    if (kind === 'group') f.properties.ControlGroup = '/other.service';
    if (kind === 'fragment') f.properties.FragmentPath = '/other.service';
    if (kind === 'owner') f.meta.get(fragment)!.uid = 123n;
    if (kind === 'parent') f.meta.get('/etc/systemd')!.mode = 0o040777n;
    if (kind === 'hardlink') f.meta.get(fragment)!.nlink = 2n;
    if (kind === 'symlink') f.meta.get(fragment)!.mode = 0o120777n;
    if (kind === 'systemctl') f.meta.get('/usr/bin/systemctl')!.mode = 0o100777n;
    if (kind === 'canonical') f.reader.realpath = async () => '/untrusted';
    if (kind === 'duplicate' || kind === 'unknown') {
      const command = f.reader.command; f.reader.command = async (...args) => await command(...args) + (kind === 'duplicate' ? 'MainPID=65432\n' : 'Unknown=yes\n');
    }
    unverified(await f.observe());
  });
});
test('management source fails closed on process identity and untrusted host views', async t => {
  for (const kind of ['uids', 'nspid', 'duplicate-nspid', 'dead', 'group', 'namespace', 'self-namespace', 'uid-map',
    'root-status', 'procfs', 'proc-overlay', 'cgroup-overlay', 'cgroup-root', 'platform', 'root'] as const) await t.test(kind, async () => {
    const f = fixture();
    if (kind === 'uids') f.files.set(proc + '/status', Buffer.from(f.status.replace(`${uid}\t${uid}`, `${uid}\t0`)));
    if (kind === 'nspid') f.files.set(proc + '/status', Buffer.from(f.status.replace(`NSpid:\t${pid}`, `NSpid:\t${pid}\t1`)));
    if (kind === 'duplicate-nspid') f.files.set(proc + '/status', Buffer.from(f.status + `NSpid:\t${pid}\n`));
    if (kind === 'dead') f.files.set(proc + '/stat', Buffer.from(f.stat().replace(') S ', ') Z ')));
    if (kind === 'group') f.files.set(proc + '/cgroup', Buffer.from('0::/other.service\n'));
    if (kind === 'namespace') f.links.set(proc + '/ns/net', 'net:[999]');
    if (kind === 'self-namespace') f.links.set('/proc/self/ns/mnt', 'mnt:[999]');
    if (kind === 'uid-map') f.files.set('/proc/self/uid_map', Buffer.from('0 100000 65536\n'));
    if (kind === 'root-status') f.files.set('/proc/self/status', Buffer.from(`Uid:\t0\t0\t1\t0\nNSpid:\t${process.pid}\n`));
    if (kind === 'procfs') f.reader.fsType = async () => 0n;
    if (kind === 'proc-overlay') f.files.set('/proc/self/mountinfo', Buffer.from(f.mountinfo + `3 1 0:3 / ${proc} rw - tmpfs tmpfs rw\n`));
    if (kind === 'cgroup-overlay') f.files.set('/proc/self/mountinfo', Buffer.from(f.mountinfo + '3 2 0:3 / /sys/fs/cgroup/system.slice rw - tmpfs tmpfs rw\n'));
    if (kind === 'cgroup-root') f.files.set('/proc/self/mountinfo', Buffer.from(f.mountinfo.replace('/ /sys/fs/cgroup', '/partial /sys/fs/cgroup')));
    if (kind === 'platform') f.reader.platform = 'win32';
    if (kind === 'root') f.reader.root = false;
    unverified(await f.observe());
  });
});
test('management observations reject replacement and unstable evidence between queries', async t => {
  for (const kind of ['pid', 'start', 'boot', 'unit', 'binary', 'namespace', 'clock-backwards', 'clock-slow'] as const) await t.test(kind, async () => {
    const f = fixture(); f.model.afterFirst = () => {
      if (kind === 'pid') f.properties.MainPID = '65433';
      if (kind === 'start') f.files.set(proc + '/stat', Buffer.from(f.stat('12345679')));
      if (kind === 'boot') f.files.set('/proc/sys/kernel/random/boot_id', Buffer.from(boot.replace('aaaa', 'bbbb')));
      if (kind === 'unit') f.meta.get(fragment)!.ctimeNs++;
      if (kind === 'binary') f.meta.get('/usr/bin/systemctl')!.ctimeNs++;
      if (kind === 'namespace') f.links.set(proc + '/ns/mnt', 'mnt:[1000]');
      if (kind === 'clock-backwards') f.model.finishedAt = 99999;
      if (kind === 'clock-slow') f.model.finishedAt = 105001;
    };
    unverified(await f.observe());
  });
});
test('management failures preserve process settlement and cannot become production fixture evidence', async () => {
  for (const error of [new NetworkCommandError('private-error'), new NetworkCommandError('private-error', false), new Error('private-error')]) {
    const f = fixture(); f.reader.command = async () => { throw error; };
    const result = await f.observe(); unverified(result);
    assert.equal(result.commandsSettled, error instanceof NetworkCommandError && error.childSettled);
  }
  for (const kind of ['read', 'parse'] as const) {
    const failed = fixture();
    if (kind === 'read') failed.reader.read = async () => { throw new Error('private-error'); };
    if (kind === 'parse') failed.reader.command = async () => 'not-a-systemd-property\n';
    const result = await failed.observe(); unverified(result); assert.equal(result.commandsSettled, true);
  }
  const f = fixture();
  unverified(await observeGatewayManagementFixture(f.input, undefined as unknown as GatewayManagementFixtureReader));
  if (process.platform !== 'linux' || process.geteuid?.() !== 0) {
    const result = await observeGatewayManagement(f.input);
    assert.equal(result.scope, 'production'); assert.equal(result.verified, false); assert.equal(result.facts, null);
  }
});
