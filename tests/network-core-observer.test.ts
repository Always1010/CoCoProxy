import assert from 'node:assert/strict';
import { posix } from 'node:path';
import test from 'node:test';
import { canonicalJson } from '../packages/config/index.ts';
import { NetworkCommandError } from '../packages/network/command.ts';
import { validateGatewayCandidate } from '../packages/network/candidate.ts';
import { compileGatewayPreview, GATEWAY_CORE_SHA256 } from '../packages/network/config.ts';
import { observeGatewayCore, observeGatewayCoreFixture, type GatewayCoreFixtureReader,
  type GatewayCoreFileMetadata, type GatewayCoreObservation } from '../packages/network/core-observer.ts';
import { CORE_CONTROL_GROUP } from '../packages/network/identity.ts';
import { GATEWAY_CREDENTIAL_PATH, renderGatewayRuntimePlan } from '../packages/network/runtime-plan.ts';

const secret = 'synthetic-private-controller-secret';
const pid = 65432, boot = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const proc = `/proc/${pid}`, credential = `${proc}/root${GATEWAY_CREDENTIAL_PATH}`;
function metadata(overrides: Partial<GatewayCoreFileMetadata> = {}): GatewayCoreFileMetadata {
  return { dev: 1n, ino: 100n, uid: 0n, mode: 0o100755n, size: 100n, nlink: 1n, mtimeNs: 1n, ctimeNs: 1n, ...overrides };
}
function fixture() {
  const runtime = renderGatewayRuntimePlan({ schemaVersion: 1, stateDirectory: '/var/lib/coproxy-observer-fixture',
    coreHome: '/var/lib/coproxy-observer-home', binaryPath: '/opt/coproxy/bin/mihomo', binarySha256: GATEWAY_CORE_SHA256,
    systemctlPath: '/usr/bin/systemctl', unitPath: '/etc/systemd/system/coproxy-mihomo.service', serviceUid: 12345 });
  const preview = compileGatewayPreview({ schemaVersion: 1, base: { schemaVersion: 1,
    deployment: { mixedPort: 17890, controllerPort: 19090, controllerSecret: secret, dnsPort: 15353, bootstrapResolvers: ['192.0.2.53'] },
    policy: { proxies: [], rules: ['MATCH,REJECT'] } }, network: { schemaVersion: 1,
    core: { serviceUid: 12345, binarySha256: GATEWAY_CORE_SHA256, unitSha256: runtime.settings.unitSha256 },
    ingressInterface: 'lan-test', gatewayIPv4: '192.0.2.2', prefixLength: 24, routerIPv4: '192.0.2.1',
    routerMAC: '02:00:00:00:00:01', clientIPv4: '192.0.2.3', dnsPort: 15353,
    tun: { interface: 'coproxy-tun', mtu: 1500 }, marks: { mask: 0xff00, capture: 0x100, egress: 0x200, return: 0x300 },
    tables: { capture: 10003, egress: 10002, return: 10001 }, priorities: { capture: 10003, egress: 10002, return: 10001 } } });
  const settings = { runtime: runtime.settings, coreHome: runtime.coreHome };
  const files = new Map<string, Buffer>(), links = new Map<string, string>(), meta = new Map<string, GatewayCoreFileMetadata>();
  const digests = new Map([[runtime.settings.binaryPath, GATEWAY_CORE_SHA256], [`${proc}/exe`, GATEWAY_CORE_SHA256],
    [runtime.settings.unitPath, runtime.settings.unitSha256]]);
  const directories = new Set<string>();
  for (const file of [runtime.settings.binaryPath, runtime.settings.unitPath, '/usr/bin/systemctl']) {
    for (let directory = posix.dirname(file);; directory = posix.dirname(directory)) {
      directories.add(directory); if (directory === '/') break;
    }
  }
  meta.set(runtime.settings.binaryPath, metadata()); meta.set(`${proc}/exe`, metadata());
  meta.set(runtime.settings.unitPath, metadata({ ino: 200n, mode: 0o100644n }));
  meta.set('/usr/bin/systemctl', metadata({ ino: 300n }));
  const config = Buffer.from(canonicalJson(preview.candidate.config));
  meta.set(credential, metadata({ ino: 400n, mode: 0o100400n, uid: 12345n, size: BigInt(config.length) }));
  files.set(credential, config);
  files.set('/proc/self/mountinfo', Buffer.from('1 0 0:1 / /proc rw - proc proc rw\n'));
  files.set('/proc/sys/kernel/random/boot_id', Buffer.from(boot + '\n'));
  const stat = (startTime: string) => `${pid} (synthetic core (name)) S ${Array(18).fill('0').join(' ')} ${startTime} 0 0\n`;
  files.set(`${proc}/stat`, Buffer.from(stat('12345678')));
  files.set(`${proc}/status`, Buffer.from('Name:\tsynthetic-core\nUid:\t12345\t12345\t12345\t12345\n'));
  files.set(`${proc}/cgroup`, Buffer.from(`0::${CORE_CONTROL_GROUP}\n`));
  files.set(`${proc}/cmdline`, Buffer.from([runtime.settings.binaryPath, '-d', runtime.coreHome, '-f', GATEWAY_CREDENTIAL_PATH, ''].join('\0')));
  const header = '  sl  local_address rem_address st tx_queue rx_queue tr tm->when retrnsmt uid timeout inode\n';
  const port = (19090).toString(16).toUpperCase();
  const tcp = (address = '0100007F', inode = '9001') => header + `0: ${address}:${port} 00000000:0000 0A 0:0 00:0 00000000 12345 0 ${inode}\n`;
  files.set(`${proc}/net/tcp`, Buffer.from(tcp())); files.set(`${proc}/net/tcp6`, Buffer.from(header));
  links.set(`${proc}/fd/7`, 'socket:[9001]');
  for (const [index, name] of ['user', 'net', 'pid', 'cgroup', 'mnt'].entries()) {
    const value = `${name}:[${100 + index}]`;
    for (const owner of ['1', 'self', String(pid)]) links.set(`/proc/${owner}/ns/${name}`, value);
  }
  // PrivateTmp/ProtectSystem legitimately give the service its own mount namespace.
  links.set(`${proc}/ns/mnt`, 'mnt:[900]');
  const model = {
    properties: { LoadState: 'loaded', ActiveState: 'active', SubState: 'running', MainPID: String(pid), Job: '',
      FragmentPath: runtime.settings.unitPath, DropInPaths: '', NeedDaemonReload: 'no', User: '12345', ControlGroup: CORE_CONTROL_GROUP },
    afterVersion: undefined as (() => void) | undefined,
    startedAt: 1_000_000, finishedAt: 1_000_050, clockCalls: 0, procType: 0x9fa0n,
  };
  const calls: string[] = [];
  const reader: GatewayCoreFixtureReader = {
    platform: 'linux', root: true,
    async read(path, maximum) {
      calls.push('read:' + path); const value = files.get(path);
      if (!value || value.length > maximum) throw new Error(secret);
      return Buffer.from(value);
    },
    async link(path) { calls.push('link:' + path); const value = links.get(path); if (!value) throw new Error(secret); return value; },
    async realpath(path) { return path === `${proc}/exe` ? runtime.settings.binaryPath : path; },
    async metadata(path) {
      const value = meta.get(path); if (value) return { ...value };
      if (directories.has(path)) return metadata({ mode: 0o040755n, ino: 500n, nlink: 2n });
      throw new Error(secret);
    },
    async entries(path) { assert.equal(path, `${proc}/fd`); return ['7']; },
    async fsType(path) { assert.equal(path, '/proc'); return model.procType; },
    async digest(path) { const value = digests.get(path); if (!value) throw new Error(secret); return value; },
    async command(binary, args) {
      calls.push('unit'); assert.equal(binary, '/usr/bin/systemctl');
      assert.equal(args.at(-1), 'coproxy-mihomo.service'); assert.equal(args[2], 'show');
      return Object.entries(model.properties).map(([name, value]) => `${name}=${value}\n`).join('');
    },
    async candidate(input, generation, expected) {
      calls.push('candidate'); assert.equal(input.unitSha256, runtime.settings.unitSha256); assert.equal(generation, preview.candidate.id);
      return { ...validateGatewayCandidate(preview.candidate, expected), path: runtime.settings.stateDirectory + '/candidates/' + generation + '.json' };
    },
    async version(port, credentialSecret) {
      calls.push('version'); assert.equal(port, 19090); assert.equal(credentialSecret, secret); model.afterVersion?.();
    },
    now() { return model.clockCalls++ === 0 ? model.startedAt : model.finishedAt; },
  };
  return { runtime, preview, settings, reader, files, links, meta, digests, model, calls, stat, tcp,
    observe: () => observeGatewayCoreFixture(settings, preview.networkPlan.deployment, reader) };
}
function unverified(value: GatewayCoreObservation): void {
  assert.equal(value.scope, 'fixture'); assert.equal(value.verified, false); assert.equal(value.facts, null);
  assert.equal(value.reason, 'NETWORK_CORE_UNVERIFIED'); assert.equal(value.terminalPath, 'unverified');
  const raw = JSON.stringify(value);
  assert.equal(raw.includes(secret), false); assert.equal(raw.includes('/proc/'), false); assert.equal(raw.includes('/opt/'), false);
}

test('gateway core observer binds unit, live executable, exact command, service credential and authenticated controller', async () => {
  const f = fixture(), value = await f.observe();
  assert.equal(value.verified, true); assert.equal(value.scope, 'fixture'); assert.equal(value.checkedAt, f.model.finishedAt);
  assert.equal(value.commandsSettled, true);
  assert.deepEqual(value.facts, { generation: f.preview.candidate.id, planSha256: f.preview.networkPlan.sha256, bootId: boot,
    corePid: pid, corePidStartTime: '12345678', serviceUid: 12345, binarySha256: GATEWAY_CORE_SHA256,
    unitSha256: f.runtime.settings.unitSha256, coreUnitControlGroup: CORE_CONTROL_GROUP });
  assert.equal(f.calls.filter(call => call === 'unit').length, 2);
  assert.equal(f.calls.filter(call => call === 'read:' + credential).length, 2);
  assert.equal(f.calls.filter(call => call === 'version').length, 1);
  assert.equal(f.calls.some(call => call.includes('selected-core.json')), false);
  assert.equal(Object.hasOwn(value.facts!, 'socketCgroupIsolationVerified'), false);
  assert.equal(Object.hasOwn(value, 'ready'), false); assert.equal(value.terminalPath, 'unverified');
});

test('gateway core observer authenticates the actual service credential rather than the root selection', async t => {
  for (const kind of ['missing', 'wrong-generation', 'noncanonical', 'writable', 'symlink', 'hardlink'] as const) {
    await t.test(kind, async () => {
      const f = fixture();
      // A correct root-side selection cannot rescue a stale or replaced service-side credential.
      f.files.set(f.runtime.selectedPath, Buffer.from(canonicalJson(f.preview.candidate.config)));
      if (kind === 'missing') f.files.delete(credential);
      if (kind === 'wrong-generation') f.files.set(credential, Buffer.from(canonicalJson({ ...f.preview.candidate.config, secret: 'other' })));
      if (kind === 'noncanonical') f.files.set(credential, Buffer.concat([f.files.get(credential)!, Buffer.from('\n')]));
      if (kind === 'writable') f.meta.get(credential)!.mode = 0o100600n;
      if (kind === 'symlink') f.meta.get(credential)!.mode = 0o120400n;
      if (kind === 'hardlink') f.meta.get(credential)!.nlink = 2n;
      unverified(await f.observe()); assert.equal(f.calls.includes('version'), false);
    });
  }
});

test('gateway core observer refuses untrusted unit, process, namespaces, executable and controller ownership', async t => {
  for (const kind of ['job', 'dropin', 'reload', 'group', 'unit-hash', 'binary-hash', 'exe-inode', 'exe-hash',
    'uids', 'namespace', 'cmdline', 'foreign-fd', 'wildcard', 'ipv6-listener'] as const) {
    await t.test(kind, async () => {
      const f = fixture();
      if (kind === 'job') f.model.properties.Job = '99';
      if (kind === 'dropin') f.model.properties.DropInPaths = '/etc/systemd/system/synthetic.conf';
      if (kind === 'reload') f.model.properties.NeedDaemonReload = 'yes';
      if (kind === 'group') f.model.properties.ControlGroup = '/system.slice/other.service';
      if (kind === 'unit-hash') f.digests.set(f.runtime.settings.unitPath, '0'.repeat(64));
      if (kind === 'binary-hash') f.digests.set(f.runtime.settings.binaryPath, '0'.repeat(64));
      if (kind === 'exe-inode') f.meta.get(`${proc}/exe`)!.ino++;
      if (kind === 'exe-hash') f.digests.set(`${proc}/exe`, '0'.repeat(64));
      if (kind === 'uids') f.files.set(`${proc}/status`, Buffer.from('Uid:\t12345\t12345\t0\t12345\n'));
      if (kind === 'namespace') f.links.set(`${proc}/ns/net`, 'net:[999]');
      if (kind === 'cmdline') f.files.set(`${proc}/cmdline`, Buffer.from([f.runtime.settings.binaryPath, '-d', f.runtime.coreHome, '-f', f.runtime.selectedPath, ''].join('\0')));
      if (kind === 'foreign-fd') f.links.set(`${proc}/fd/7`, 'socket:[7777]');
      if (kind === 'wildcard') f.files.set(`${proc}/net/tcp`, Buffer.from(f.tcp('00000000')));
      if (kind === 'ipv6-listener') f.files.set(`${proc}/net/tcp6`, Buffer.from(f.tcp('00000000000000000000000000000000')));
      unverified(await f.observe()); assert.equal(f.calls.includes('version'), false);
    });
  }
});

test('gateway core observer discards evidence changed during authenticated version probing', async t => {
  for (const kind of ['pid', 'start-time', 'boot', 'credential-inode', 'binary-ctime', 'unit', 'socket', 'clock-backward', 'too-slow'] as const) {
    await t.test(kind, async () => {
      const f = fixture();
      f.model.afterVersion = () => {
        if (kind === 'pid') f.model.properties.MainPID = '65433';
        if (kind === 'start-time') f.files.set(`${proc}/stat`, Buffer.from(f.stat('12345679')));
        if (kind === 'boot') f.files.set('/proc/sys/kernel/random/boot_id', Buffer.from('bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee\n'));
        if (kind === 'credential-inode') f.meta.get(credential)!.ino++;
        if (kind === 'binary-ctime') { f.meta.get(f.runtime.settings.binaryPath)!.ctimeNs++; f.meta.get(`${proc}/exe`)!.ctimeNs++; }
        if (kind === 'unit') f.meta.get(f.runtime.settings.unitPath)!.ctimeNs++;
        if (kind === 'socket') { f.files.set(`${proc}/net/tcp`, Buffer.from(f.tcp('0100007F', '9002'))); f.links.set(`${proc}/fd/7`, 'socket:[9002]'); }
        if (kind === 'clock-backward') f.model.finishedAt = f.model.startedAt - 1;
        if (kind === 'too-slow') f.model.finishedAt = f.model.startedAt + 5001;
      };
      unverified(await f.observe()); assert.ok(f.calls.includes('version'));
    });
  }
});

test('gateway core observer rejects unsupported privilege and unsafe host views before asserting facts', async t => {
  for (const kind of ['platform', 'root', 'procfs', 'proc-overlay', 'binary-parent', 'systemctl-owner'] as const) {
    await t.test(kind, async () => {
      const f = fixture();
      if (kind === 'platform') f.reader.platform = 'win32';
      if (kind === 'root') f.reader.root = false;
      if (kind === 'procfs') f.model.procType = 0n;
      if (kind === 'proc-overlay') f.files.set('/proc/self/mountinfo', Buffer.from(`1 0 0:1 / /proc rw - proc proc rw\n2 1 0:2 / ${proc}/root ro - tmpfs tmpfs ro\n`));
      if (kind === 'binary-parent') f.meta.set('/opt/coproxy', metadata({ mode: 0o040777n }));
      if (kind === 'systemctl-owner') f.meta.get('/usr/bin/systemctl')!.uid = 12345n;
      unverified(await f.observe()); assert.equal(f.calls.includes('version'), false);
    });
  }
});

test('gateway observer errors and malformed fixture readers remain fixed failures with fixture provenance', async () => {
  const f = fixture();
  f.reader.version = async () => { throw new Error(secret); };
  const failedVersion = await f.observe(); unverified(failedVersion); assert.equal(failedVersion.commandsSettled, true);
  for (const error of [new NetworkCommandError(secret), new NetworkCommandError(secret, false),
    Object.assign(new Error(secret), { childSettled: false })]) {
    const failed = fixture(); let commands = 0;
    failed.reader.command = async () => { commands++; throw error; };
    const value = await failed.observe(); unverified(value);
    assert.equal(value.commandsSettled, !(error instanceof NetworkCommandError && error.childSettled === false));
    assert.equal(commands, 1); assert.equal(failed.calls.includes('version'), false);
  }
  unverified(await observeGatewayCoreFixture(f.settings, f.preview.networkPlan.deployment, undefined as unknown as GatewayCoreFixtureReader));
  if (process.platform !== 'linux' || process.geteuid?.() !== 0) {
    const production = await observeGatewayCore(f.settings, f.preview.networkPlan.deployment);
    assert.equal(production.scope, 'production'); assert.equal(production.verified, false); assert.equal(production.facts, null);
  }
});
