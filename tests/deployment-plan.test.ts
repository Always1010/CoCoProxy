import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { isAbsolute, join, basename } from 'node:path';
import { DeploymentPlanError, renderDeploymentPlan } from '../packages/deployment/plan.ts';
import { AUTOMATIC_GATEWAY_CORE_SHA256 } from '../packages/gateway/profile.ts';

function input() {
  return { schemaVersion: 1, runtime: {
    schemaVersion: 1, stateDirectory: '/var/lib/coproxy', binaryPath: '/opt/coproxy/bin/mihomo',
    binarySha256: 'a'.repeat(64), systemctlPath: '/usr/bin/systemctl', nodePath: '/usr/bin/node',
    sourceDirectory: '/opt/coproxy/source', settingsPath: '/etc/coproxy/runtime.json',
    unitPath: '/etc/systemd/system/coproxy-mihomo.service', serviceUid: 12345,
  }, management: {
    origin: 'https://management.example', listenPort: 13000, serviceUser: 'coproxy',
    serverEntry: '/opt/coproxy/server/.output/server/index.mjs', settingsPath: '/etc/coproxy/management.json',
    credentialPath: '/etc/coproxy/admin.json', unitPath: '/etc/systemd/system/coproxy-management.service',
    policyPath: '/etc/polkit-1/rules.d/50-coproxy-management.rules',
    deployment: { mixedPort: 17890, controllerPort: 19090, controllerSecret: 'SYNTHETIC_CONTROLLER_SECRET',
      dnsPort: 15353, bootstrapResolvers: ['192.0.2.53'] },
  } };
}

function automaticInput() {
  const value = input();
  return { ...value, runtime: { ...value.runtime, binarySha256: AUTOMATIC_GATEWAY_CORE_SHA256,
    automaticGateway: { schemaVersion: 1, ingressInterface: 'lan-test', gatewayIPv4: '192.0.2.2', routerIPv4: '192.0.2.1',
      routerMAC: '02:00:00:00:00:01', clientIPv4: '192.0.2.3', prefixLength: 24, dnsPort: 15353,
      egressMark: 65536, egressTable: 2024, egressPriority: 8000, tunMtu: 1500 } } };
}

test('installed systemd parser accepts both generated unit definitions', {
  skip: process.platform !== 'linux' || !process.env.COPROXY_TEST_SYSTEMD_ANALYZE,
}, async t => {
  const binary = process.env.COPROXY_TEST_SYSTEMD_ANALYZE!;
  assert.ok(isAbsolute(binary));
  const root = await mkdtemp(join(tmpdir(), 'coproxy-unit-syntax-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const value of [input(), automaticInput()]) {
    const directory = await mkdtemp(join(root, 'profile-'));
    const units: string[] = [];
    for (const file of renderDeploymentPlan(value).files.filter(file => file.path.endsWith('.service'))) {
      const path = join(directory, basename(file.path));
      await writeFile(path, file.content, { mode: 0o600 }); units.push(path);
    }
    await new Promise<void>((resolve, reject) => execFile(binary, ['verify', '--man=no', ...units], {
      timeout: 15_000, maxBuffer: 65_536, windowsHide: true,
    }, error => error ? reject(new Error('SYSTEMD_UNIT_SYNTAX_REJECTED')) : resolve()));
  }
});

test('native deployment adds one root oneshot without granting management network privileges', () => {
  const plan = renderDeploymentPlan(automaticInput());
  assert.equal(plan.files.length, 7);
  const core = plan.files.find(file => file.path.endsWith('/coproxy-mihomo.service'))!;
  const manager = plan.files.find(file => file.path.endsWith('/coproxy-management.service'))!;
  const network = plan.files.find(file => file.path.endsWith('/coproxy-gateway-network.service'))!;
  assert.match(core.content, /^Requires=coproxy-gateway-network.service$/m);
  assert.match(core.content, /^BindsTo=coproxy-gateway-network.service$/m);
  assert.match(core.content, /^AmbientCapabilities=CAP_NET_ADMIN CAP_NET_RAW$/m);
  assert.match(manager.content, /^CapabilityBoundingSet=$/m);
  assert.doesNotMatch(manager.content, /AmbientCapabilities/);
  assert.equal(network.owner, 'root');
  assert.doesNotMatch(network.content, /ExecStop|Restart=|WantedBy/);
  const rootSettings = plan.files.find(file => file.path.endsWith('/gateway-network.json'))!;
  assert.equal(rootSettings.owner, 'root'); assert.equal(rootSettings.mode, '0600');
  assert.ok(plan.directories.some(dir => dir.path === '/var/lib/coproxy-gateway-network' && dir.owner === 'root' && dir.mode === '0700'));
  for (const dependency of ['/usr/bin/python3', '/usr/sbin/ip', '/usr/sbin/nft', '/usr/bin/ip', '/usr/bin/nft']) {
    const collision = automaticInput(); collision.management.settingsPath = dependency;
    assert.throws(() => renderDeploymentPlan(collision), DeploymentPlanError);
  }
});

test('deployment proposal shares the private runtime identity and pins core bytes without starting anything', () => {
  const value = input();
  const plan = renderDeploymentPlan(value);
  assert.deepEqual(renderDeploymentPlan(value), plan);
  assert.equal(plan.sensitive, true);
  assert.equal(plan.files.length, 5);
  const find = (path: string) => plan.files.find(file => file.path === path)!;
  const core = find(value.runtime.unitPath);
  const runtime = JSON.parse(find(value.runtime.settingsPath).content);
  const server = find(value.management.unitPath);
  const settings = JSON.parse(find(value.management.settingsPath).content);
  assert.equal(runtime.unitSha256, createHash('sha256').update(core.content).digest('hex'));
  for (const unit of [core, server]) {
    assert.equal(unit.owner, 'root'); assert.equal(unit.mode, '0644');
    assert.match(unit.content, /^Type=exec$/m);
    assert.match(unit.content, /^User=12345$/m);
    assert.match(unit.content, /^NoNewPrivileges=true$/m);
    assert.match(unit.content, /^ProtectSystem=strict$/m);
    assert.match(unit.content, /^ReadWritePaths="\/var\/lib\/coproxy"$/m);
  }
  assert.match(server.content, /^Environment="NITRO_HOST=127\.0\.0\.1"$/m);
  assert.match(server.content, /^Environment="NITRO_PORT=13000"$/m);
  assert.match(server.content, /^Environment="COPROXY_MANAGEMENT_CONFIG=\/etc\/coproxy\/management\.json"$/m);
  assert.doesNotMatch(server.content, /Wants=|Requires=|coproxy-mihomo|ExecStartPre|ExecStartPost|Condition|ExecReload|AmbientCapabilities|CAP_NET_ADMIN/);
  assert.equal(settings.runtimeSettingsPath, value.runtime.settingsPath);
  assert.equal(settings.credentialPath, value.management.credentialPath);
  assert.deepEqual(settings.deployment, value.management.deployment);
  assert.deepEqual(settings.controllerPolicy.allowedProbeOrigins, ['https://www.gstatic.com']);
  assert.equal(settings.schemaVersion, 1);
  for (const path of [value.runtime.settingsPath, value.management.settingsPath]) {
    assert.equal(find(path).owner, 12345); assert.equal(find(path).mode, '0600'); assert.equal(find(path).sensitive, true);
  }
  assert.deepEqual(plan.directories[0], { path: '/var/lib/coproxy', mode: '0700', owner: 12345 });
  assert.equal(plan.files.some(file => file.path === value.management.credentialPath), false);
  assert.equal(plan.files.filter(file => file.content.includes(value.management.deployment.controllerSecret)).length, 1);
  assert.match(plan.requirements.join('\n'), /expectedActive CAS/);
  assert.match(plan.requirements.join('\n'), /唯一解析为非 root UID 12345/);
});

test('generated polkit code grants exactly start/stop for one account and one unit', () => {
  const plan = renderDeploymentPlan(input());
  const code = plan.files.find(file => file.path.endsWith('.rules'))!.content;
  let rule: (action: { id: string; lookup: (key: string) => unknown }, subject: { user: string }) => unknown = () => assert.fail();
  runInNewContext(code, { polkit: { Result: { YES: 'yes', NO: 'no' }, addRule(value: typeof rule) { rule = value; } } });
  const check = (user: string, id: string, unit?: string, verb?: string) => rule({ id,
    lookup: key => key === 'unit' ? unit : key === 'verb' ? verb : undefined }, { user });
  const action = 'org.freedesktop.systemd1.manage-units';
  for (const verb of ['start', 'stop']) assert.equal(check('coproxy', action, 'coproxy-mihomo.service', verb), 'yes');
  for (const verb of [undefined, '', 'restart', 'reload', 'try-restart', 'reload-or-restart', 'enable', 'start\n']) {
    assert.equal(check('coproxy', action, 'coproxy-mihomo.service', verb), 'no');
  }
  for (const unit of [undefined, 'other.service', 'coproxy-management.service', 'coproxy-mihomo@x.service']) {
    assert.equal(check('coproxy', action, unit, 'start'), 'no');
  }
  for (const user of ['root', 'other', '12345']) assert.equal(check(user, action, 'coproxy-mihomo.service', 'start'), undefined);
  assert.equal(check('coproxy', 'org.freedesktop.systemd1.manage-unit-files', undefined, 'enable'), 'no');
  assert.equal(check('coproxy', 'org.freedesktop.systemd1.reload-daemon'), undefined);
  assert.equal(check('coproxy', 'org.freedesktop.policykit.exec'), undefined);
  assert.doesNotMatch(code, /polkit\.spawn|AUTH_ADMIN|YES_KEEP|sudo/);
});

test('systemd arguments and environments escape words without allowing unit or shell injection', () => {
  const value = input();
  value.management.serverEntry = '/opt/server "quoted"\\$HOME%instance/index.mjs';
  value.management.settingsPath = '/etc/coproxy/config "quoted"\\$HOME%i.json';
  value.runtime.stateDirectory = '/var/lib/coproxy "quoted"\\%i';
  const plan = renderDeploymentPlan(value);
  const unit = plan.files.find(file => file.path === value.management.unitPath)!.content;
  assert.ok(unit.includes('ExecStart="/usr/bin/node" "/opt/server \\"quoted\\"\\\\$$HOME%%instance/index.mjs"\n'));
  assert.ok(unit.includes('Environment="COPROXY_MANAGEMENT_CONFIG=/etc/coproxy/config \\"quoted\\"\\\\$HOME%%i.json"\n'));
  assert.ok(unit.includes('ReadWritePaths="/var/lib/coproxy \\"quoted\\"\\\\%%i"\n'));
  assert.equal(unit.split('\n').filter(line => line.startsWith('ExecStart=')).length, 1);
});

test('deployment rejects root, overlapping trust boundaries and paths hidden by its sandbox', () => {
  const cases: unknown[] = [];
  const change = (section: 'runtime' | 'management', key: string, value: unknown) => {
    const candidate = input(); (candidate[section] as Record<string, unknown>)[key] = value; cases.push(candidate);
  };
  change('runtime', 'serviceUid', 0);
  change('runtime', 'unitPath', '/opt/coproxy-mihomo.service');
  change('management', 'unitPath', '/etc/systemd/system/other.service');
  change('management', 'policyPath', '/etc/polkit-1/rules.d/00-everything.rules');
  change('management', 'serviceUser', 'root');
  change('management', 'serviceUser', 'coproxy" || true');
  change('management', 'settingsPath', input().runtime.settingsPath);
  change('management', 'credentialPath', input().management.settingsPath);
  change('management', 'serverEntry', '/var/lib/coproxy/server/index.mjs');
  change('runtime', 'sourceDirectory', '/var/lib/coproxy/source');
  change('runtime', 'stateDirectory', '/opt/coproxy');
  change('runtime', 'stateDirectory', '/var/lib');
  change('runtime', 'nodePath', input().management.serverEntry + '/node');
  change('management', 'settingsPath', input().runtime.sourceDirectory + '/management.json');
  for (const directory of ['/root', '/home/user', '/run/user/12345', '/tmp', '/var/tmp', '/dev', '/proc', '/sys']) {
    change('management', 'serverEntry', directory + '/server.mjs');
    change('runtime', 'stateDirectory', directory + '/state');
  }
  for (const unsafe of ['relative', '/', '/opt/../server.mjs', '/opt//server.mjs', '/opt/server\nUser=0', '/opt/server\0.mjs', '/opt/server\u2028mjs', '/opt/\ud800server.mjs']) {
    change('management', 'serverEntry', unsafe);
  }
  for (const value of cases) assert.throws(() => renderDeploymentPlan(value), DeploymentPlanError);
});

test('deployment validates exact origins, unprivileged distinct ports and bounded trusted policies', () => {
  const good = input(); good.management.origin = 'http://127.0.0.1:13000';
  assert.doesNotThrow(() => renderDeploymentPlan(good));
  const bad: unknown[] = [];
  for (const origin of ['http://management.example:13000', 'https://name:password@management.example',
    'https://management.example/', 'https://management.example?token=secret', 'http://127.0.0.1.evil:13000',
    'http://127.0.0.1:13001']) {
    const value = input(); value.management.origin = origin; bad.push(value);
  }
  for (const port of [0, 80, 1023, 65536, 1.5, 17890]) {
    const value = input(); value.management.listenPort = port; bad.push(value);
  }
  const privileged = input(); privileged.management.deployment.dnsPort = 53; bad.push(privileged);
  const options: Record<string, unknown>[] = [
    { subscriptionPolicy: { allowedOrigins: ['http://feeds.example'] } },
    { subscriptionPolicy: { allowedOrigins: ['https://feeds.example/?token=secret'] } },
    { subscriptionPolicy: { allowedOrigins: ['https://feeds.example'], timeoutMs: 0 } },
    { subscriptionPolicy: { allowedOrigins: ['https://feeds.example'], resolve: () => [] } },
    { controllerPolicy: { allowedProbeOrigins: ['https://probe.example/'] } },
    { controllerPolicy: { allowedProbeOrigins: Array(17).fill('https://probe.example') } },
  ];
  for (const extra of options) { const value = input(); Object.assign(value.management, extra); bad.push(value); }
  for (const value of bad) assert.throws(() => renderDeploymentPlan(value), DeploymentPlanError);
  const approved = input();
  Object.assign(approved.management, { subscriptionPolicy: { allowedOrigins: ['https://feeds.example'],
    allowedHttpOrigins: ['http://legacy-feed.example:8080'],
    timeoutMs: 1000, allowPrivateAddresses: false }, controllerPolicy: { allowedProbeOrigins: ['https://probe.example'] } });
  const settings = JSON.parse(renderDeploymentPlan(approved).files.find(file => file.path === approved.management.settingsPath)!.content);
  assert.deepEqual(settings.subscriptionPolicy.allowedOrigins, ['https://feeds.example']);
  assert.deepEqual(settings.subscriptionPolicy.allowedHttpOrigins, ['http://legacy-feed.example:8080']);
  assert.deepEqual(settings.controllerPolicy.allowedProbeOrigins, ['https://probe.example']);
  const disabled = input();
  Object.assign(disabled.management, { controllerPolicy: { allowedProbeOrigins: [] } });
  const disabledSettings = JSON.parse(renderDeploymentPlan(disabled).files.find(file => file.path === disabled.management.settingsPath)!.content);
  assert.deepEqual(disabledSettings.controllerPolicy.allowedProbeOrigins, []);
});

test('deployment accepts data only and errors do not expose secrets or evaluate accessors', () => {
  let calls = 0;
  const value = input();
  Object.defineProperty(value.management, 'serverEntry', { enumerable: true, get() { calls++; return '/opt/server.mjs'; } });
  const array = ['192.0.2.53'];
  Object.defineProperty(array, '0', { enumerable: true, get() { calls++; return '192.0.2.53'; } });
  const nested = input(); nested.management.deployment.bootstrapResolvers = array;
  const inherited = input(); Object.setPrototypeOf(inherited.management, { hidden: true });
  const circular = input(); Object.assign(circular.management, { controllerPolicy: circular });
  const extra = input(); Object.assign(extra.management, { password: 'SYNTHETIC_ADMIN_PASSWORD' });
  const toJSON = input(); Object.assign(toJSON.management.deployment, { toJSON() { calls++; return {}; } });
  const proxy = new Proxy(input(), { ownKeys() { calls++; return []; } });
  for (const candidate of [null, [], {}, value, nested, inherited, circular, extra, toJSON, proxy]) {
    assert.throws(() => renderDeploymentPlan(candidate), error => {
      assert.ok(error instanceof DeploymentPlanError);
      assert.equal(error.message, 'DEPLOYMENT_PLAN_INVALID');
      assert.equal(error.code, 'DEPLOYMENT_PLAN_INVALID');
      return true;
    });
  }
  assert.equal(calls, 0);
});
