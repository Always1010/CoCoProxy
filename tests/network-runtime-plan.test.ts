import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { compileGatewayPreview, GATEWAY_CORE_SHA256 } from '../packages/network/config.ts';
import { GATEWAY_CREDENTIAL_PATH, GatewayRuntimePlanError, renderGatewayRuntimePlan } from '../packages/network/runtime-plan.ts';
import { parseRuntimeSettings } from '../packages/runtime/settings.ts';

function input() {
  return { schemaVersion: 1, stateDirectory: '/var/lib/coproxy-network', binaryPath: '/opt/coproxy/bin/mihomo',
    binarySha256: GATEWAY_CORE_SHA256, systemctlPath: '/usr/bin/systemctl',
    unitPath: '/etc/systemd/system/coproxy-mihomo.service', serviceUid: 12345, coreHome: '/var/lib/coproxy-core' };
}

test('installed systemd parser accepts credential units with ordinary and escaped deployment paths without starting services',
  { skip: process.platform !== 'linux', timeout: 20_000 }, async t => {
    try { await access('/usr/bin/systemd-analyze'); }
    catch { t.skip('systemd-analyze is unavailable; unit syntax is unverified'); return; }
    const root = await mkdtemp(join(tmpdir(), 'coproxy-unit-syntax-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    for (const suffix of ['simple', 'space "quote"\\%i/$VALUE']) {
      const plan = renderGatewayRuntimePlan({ ...input(), binaryPath: '/usr/bin/true',
        stateDirectory: join(root, 'state ' + suffix), coreHome: join(root, 'home ' + suffix) });
      await mkdir(plan.settings.stateDirectory, { recursive: true, mode: 0o700 });
      await mkdir(plan.coreHome, { recursive: true, mode: 0o700 });
      await writeFile(plan.selectedPath, '{}', { mode: 0o600 });
      const unitPath = join(root, 'coproxy-mihomo.service');
      await writeFile(unitPath, plan.unit, { mode: 0o600 });
      await writeFile(join(root, 'coproxy-network.service'), '[Service]\nType=oneshot\nExecStart=/usr/bin/true\nRemainAfterExit=yes\n', { mode: 0o600 });
      // These are parser inputs only; /usr/bin/true is never executed. No unit
      // is installed, no daemon reload occurs, and no system manager is called.
      const result = await promisify(execFile)('/usr/bin/systemd-analyze', ['verify', '--man=no', unitPath],
        { timeout: 8_000, maxBuffer: 65_536, env: { PATH: '/usr/bin:/bin', LANG: 'C' } });
      assert.equal(result.stderr, '');
    }
  });
const invalid = (error: unknown) => error instanceof GatewayRuntimePlanError &&
  error.code === 'GATEWAY_RUNTIME_PLAN_INVALID' && error.message === error.code && !('cause' in error);

test('gateway runtime plan generates deterministic direct credential launch and a separate root/service filesystem contract', () => {
  const source = input(), plan = renderGatewayRuntimePlan(source);
  assert.deepEqual(renderGatewayRuntimePlan({ ...source }), plan);
  assert.deepEqual(parseRuntimeSettings(plan.settings), plan.settings);
  assert.equal(plan.settings.unitSha256, createHash('sha256').update(plan.unit).digest('hex'));
  assert.equal(plan.settings.binarySha256, GATEWAY_CORE_SHA256);
  assert.equal(plan.selectedPath, '/var/lib/coproxy-network/selected-core.json');
  assert.equal(plan.coreHome, '/var/lib/coproxy-core');
  assert.equal(plan.credentialPath, GATEWAY_CREDENTIAL_PATH);
  assert.equal(plan.credentialPath, '/run/credentials/coproxy-mihomo.service/core-config');
  assert.deepEqual(plan.filesystem, { directories: [
    { path: source.stateDirectory, uid: 0, mode: 0o700 },
    { path: source.stateDirectory + '/candidates', uid: 0, mode: 0o700 },
    { path: source.coreHome, uid: source.serviceUid, mode: 0o700 },
  ], selectedFile: { path: plan.selectedPath, uid: 0, mode: 0o600 } });
  assert.match(plan.unit, /^User=12345$/m);
  assert.match(plan.unit, /^LoadCredential="core-config:\/var\/lib\/coproxy-network\/selected-core.json"$/m);
  assert.match(plan.unit, /^ExecStart="\/opt\/coproxy\/bin\/mihomo" "-d" "\/var\/lib\/coproxy-core" "-f" "%d\/core-config"$/m);
  assert.equal(plan.unit.split('\n').filter(line => line.startsWith('ExecStart=')).length, 1);
  assert.doesNotMatch(plan.unit, /launch-core|node|Environment=|SetCredential=|ExecReload|\[Install\]|WantedBy=/);
  source.serviceUid++;
  assert.equal(plan.settings.serviceUid, 12345);
  assert.notEqual(renderGatewayRuntimePlan(source).settings.unitSha256, plan.settings.unitSha256);
});

test('gateway core lifecycle and privileges remain bounded by the network helper', () => {
  const { unit } = renderGatewayRuntimePlan(input());
  for (const line of [
    'Requires=coproxy-network.service', 'After=coproxy-network.service', 'BindsTo=coproxy-network.service',
    'Restart=no', 'KillMode=control-group', 'TimeoutStartSec=10', 'TimeoutStopSec=10', 'UMask=0077',
    'AmbientCapabilities=CAP_NET_ADMIN CAP_NET_RAW', 'CapabilityBoundingSet=CAP_NET_ADMIN CAP_NET_RAW',
    'NoNewPrivileges=true', 'PrivateTmp=true', 'ProtectSystem=strict', 'ProtectHome=true',
    'ProtectControlGroups=true', 'ProtectKernelTunables=true', 'ProtectKernelModules=true', 'ProtectKernelLogs=true',
    'RestrictSUIDSGID=true', 'RestrictRealtime=true', 'RestrictNamespaces=true', 'LockPersonality=true',
    'StandardInput=null', 'StandardOutput=journal', 'StandardError=journal',
    'LogRateLimitIntervalSec=30s', 'LogRateLimitBurst=200',
  ]) assert.ok(unit.split('\n').includes(line), line);
  assert.deepEqual(unit.split('\n').filter(line => line.startsWith('ReadWritePaths=')), ['ReadWritePaths="/var/lib/coproxy-core"']);
  assert.doesNotMatch(unit, /CAP_SYS_ADMIN|User=0|RestartSec=|PrivateNetwork=|PrivateUsers=|PrivateDevices=/);
});

test('systemd words escape quotes, backslashes, specifiers and command variable expansion', () => {
  const plan = renderGatewayRuntimePlan({ ...input(),
    binaryPath: '/opt/synthetic "core"\\%i/$BIN',
    stateDirectory: '/var/lib/synthetic "state"\\%i/$STATE',
    coreHome: '/var/lib/synthetic "home"\\%i/$HOME ${TOKEN}',
  });
  assert.ok(plan.unit.includes(String.raw`LoadCredential="core-config:/var/lib/synthetic \"state\"\\%%i/$STATE/selected-core.json"`));
  const exec = plan.unit.split('\n').find(line => line.startsWith('ExecStart='))!;
  assert.ok(exec.includes(String.raw`"/opt/synthetic \"core\"\\%%i/$$BIN"`));
  assert.ok(exec.includes('/$$HOME $${TOKEN}"'));
  assert.ok(exec.endsWith('"-f" "%d/core-config"'));
  assert.ok(plan.unit.includes(String.raw`ReadWritePaths="/var/lib/synthetic \"home\"\\%%i/$HOME ` + '${TOKEN}"'));
  assert.equal(plan.unit.split('\n').filter(line => line.startsWith('LoadCredential=')).length, 1);
});

test('plan rejects malformed identity, hidden or overlapping paths and writable executable placement', () => {
  const values: unknown[] = [null, [], {}, 'plan', { ...input(), extra: true }, { ...input(), schemaVersion: 2 },
    { ...input(), binarySha256: 'b'.repeat(64) }, { ...input(), binarySha256: GATEWAY_CORE_SHA256.toUpperCase() },
    { ...input(), unitPath: '/etc/systemd/system/other.service' },
    { ...input(), systemctlPath: '/usr/local/bin/systemctl' }, { ...input(), systemctlPath: '/opt/systemctl' },
    { ...input(), coreHome: '/var/lib/coproxy-network/home' },
    { ...input(), coreHome: '/var/lib/coproxy-network' },
    { ...input(), stateDirectory: '/var/lib/coproxy-core/state' },
    { ...input(), binaryPath: '/var/lib/coproxy-core/mihomo' },
    { ...input(), binaryPath: '/var/lib/coproxy-network/mihomo' },
    { ...input(), unitPath: '/var/lib/coproxy-core/coproxy-mihomo.service' },
    { ...input(), coreHome: '/opt/coproxy/bin' },
  ];
  for (const serviceUid of [0, -1, 1.5, NaN, Infinity, 4_294_967_295, '12345', 1n]) values.push({ ...input(), serviceUid });
  for (const key of ['stateDirectory', 'binaryPath', 'systemctlPath', 'unitPath', 'coreHome']) {
    for (const path of ['/home', '/home/synthetic/file', '/root', '/root/file', '/run/user', '/run/user/123/file',
      '/', 'relative', '/opt//file', '/opt/../file', '/opt/file/', '/opt/file\nExecStart=malicious', '/opt/\0file',
      '/opt/\u007ffile', '/opt/\u2028file', '/opt/\u2029file']) values.push({ ...input(), [key]: path });
  }
  for (const value of values) assert.throws(() => renderGatewayRuntimePlan(value), invalid);
  assert.doesNotThrow(() => renderGatewayRuntimePlan({ ...input(), systemctlPath: '/bin/systemctl' }));
  assert.doesNotThrow(() => renderGatewayRuntimePlan({ ...input(), coreHome: '/homebrew/coproxy-core' }));
  assert.doesNotThrow(() => renderGatewayRuntimePlan({ ...input(), coreHome: '/var/lib/coproxy-network-core' }));
});

test('strict data input never invokes getters, proxies, prototype methods or toJSON', () => {
  let invoked = false;
  const getter = { ...input() };
  Object.defineProperty(getter, 'coreHome', { enumerable: true, get() { invoked = true; return '/var/lib/synthetic'; } });
  const hidden = { ...input() };
  Object.defineProperty(hidden, 'coreHome', { enumerable: false, value: '/var/lib/synthetic' });
  const proxy = new Proxy({}, { getPrototypeOf() { invoked = true; throw new Error('sensitive'); } });
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  for (const value of [getter, hidden, proxy, revoked.proxy, Object.assign(Object.create({ toJSON() { invoked = true; } }), input()),
    { ...input(), [Symbol('synthetic')]: true }, { ...input(), toJSON() { invoked = true; } }]) {
    assert.throws(() => renderGatewayRuntimePlan(value), invalid);
  }
  assert.equal(invoked, false);
  assert.deepEqual(renderGatewayRuntimePlan(Object.assign(Object.create(null), input())), renderGatewayRuntimePlan(input()));
});

test('unit SHA feeds gateway compilation without generation appearing in the unit', () => {
  const plan = renderGatewayRuntimePlan(input());
  const preview = compileGatewayPreview({ schemaVersion: 1,
    base: { schemaVersion: 1, deployment: { mixedPort: 17890, controllerPort: 19090,
      controllerSecret: 'synthetic-secret', dnsPort: 15353, bootstrapResolvers: ['192.0.2.53'] }, policy: { rules: ['MATCH,REJECT'] } },
    network: { schemaVersion: 1, core: { serviceUid: plan.settings.serviceUid,
      binarySha256: plan.settings.binarySha256, unitSha256: plan.settings.unitSha256 },
    ingressInterface: 'lan-test', gatewayIPv4: '192.0.2.2', prefixLength: 24, routerIPv4: '192.0.2.1',
    routerMAC: '02:00:00:00:00:01', clientIPv4: '192.0.2.3', dnsPort: 15353,
    tun: { interface: 'coproxy-tun', mtu: 1500 }, marks: { mask: 0xff00, capture: 0x100, egress: 0x200, return: 0x300 },
    tables: { capture: 10003, egress: 10002, return: 10001 }, priorities: { capture: 10003, egress: 10002, return: 10001 } } });
  assert.equal(preview.networkPlan.deployment.core.unitSha256, plan.settings.unitSha256);
  assert.doesNotMatch(plan.unit, new RegExp(preview.candidate.id));
  assert.deepEqual(renderGatewayRuntimePlan(input()), plan);
});
