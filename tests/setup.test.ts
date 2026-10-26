import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { parseSetupEnvironment, createSetupDeployment, routerParameters } from '../packages/setup/input.ts';
import { inspectSetup, parseServiceIdentity, type DoctorHost } from '../packages/setup/doctor.ts';
import { renderDeploymentPlan } from '../packages/deployment/plan.ts';
import { AUTOMATIC_GATEWAY_CORE_SHA256 } from '../packages/gateway/profile.ts';

const sample = JSON.parse(await readFile(new URL('../examples/setup-environment.json', import.meta.url), 'utf8'));
const release = { manifestSha256: 'b'.repeat(64), binarySha256: AUTOMATIC_GATEWAY_CORE_SHA256, serviceUid: 12345 };
test('setup derives matching release paths, DNS ports and a private random secret from environment facts', () => {
  const environment = parseSetupEnvironment(sample);
  const input = createSetupDeployment(environment, release) as any;
  const second = createSetupDeployment(environment, release) as any;
  const target = '/opt/cocoproxy/releases/' + release.manifestSha256;
  assert.equal(input.runtime.binaryPath, target + '/bin/mihomo');
  assert.equal(input.management.serverEntry, target + '/server/.output/server/index.mjs');
  assert.equal(input.runtime.automaticGateway.dnsPort, input.management.deployment.dnsPort);
  assert.equal(input.runtime.automaticGateway.prefixLength, 24);
  assert.match(input.management.deployment.controllerSecret, /^[a-f0-9]{64}$/);
  assert.notEqual(input.management.deployment.controllerSecret, second.management.deployment.controllerSecret);
  assert.equal(renderDeploymentPlan(input).files.length, 8);
  assert.equal(routerParameters(environment).dnsPort, input.management.deployment.dnsPort);
  assert.equal(routerParameters(environment).contract, 'cocoproxy-router-contract/v1');
});
test('setup preserves an existing internal identity and refuses silent custom-layout changes', () => {
  const environment = parseSetupEnvironment(sample), previous = createSetupDeployment(environment, release) as any;
  const input = createSetupDeployment(environment, { ...release, manifestSha256: 'c'.repeat(64) }, previous) as any;
  assert.equal(input.management.deployment.controllerSecret, previous.management.deployment.controllerSecret);
  assert.notEqual(input.runtime.sourceDirectory, previous.runtime.sourceDirectory);
  previous.runtime.automaticGateway.tunStack = 'mixed';
  previous.runtime.automaticGateway.tunGso = true;
  const tuned = createSetupDeployment(environment, release, previous) as any;
  assert.equal(tuned.runtime.automaticGateway.tunStack, 'mixed');
  assert.equal(tuned.runtime.automaticGateway.tunGso, true);
  assert.throws(() => createSetupDeployment(environment, release, null));
  assert.throws(() => createSetupDeployment(environment, { ...release, serviceUid: 12346 }, previous), { code: 'SETUP_SERVICE_IDENTITY_CHANGED' });
  previous.runtime.stateDirectory = '/var/lib/cocoproxy-custom';
  assert.throws(() => createSetupDeployment(environment, release, previous), { code: 'SETUP_CUSTOM_LAYOUT_REQUIRES_EXISTING_INSTALLER' });
});
test('setup reuses final deployment validation and refuses ambiguous or unsupported environment input', () => {
  for (const change of [
    { ports: { dns: 13000 } }, { ports: { typo: 15353 } }, { system: { releaseParent: '/tmp/release' } },
    { management: { ...sample.management, origin: 'https://gateway.example/path' } },
    { network: { ...sample.network, clientCIDR: '192.0.3.0/24' } },
    { management: { ...sample.management, bootstrapResolvers: ['https://resolver.example'] } },
  ]) assert.throws(() => parseSetupEnvironment({ ...sample, ...change }), { code: 'SETUP_ENVIRONMENT_INVALID' });
});
test('managed HTTPS is included in the same deployment plan and retained by upgrade generation', () => {
  const environment = parseSetupEnvironment({ ...sample, https: { mode: 'managed',
    certificatePath: '/etc/cocoproxy/web/server.crt', privateKeyPath: '/etc/cocoproxy/web/server.key' } });
  const previous = createSetupDeployment(environment, release) as any;
  assert.equal(renderDeploymentPlan(previous).files.length, 10);
  assert.equal(previous.web.nginxPath, '/usr/sbin/nginx');
  const retained = createSetupDeployment(parseSetupEnvironment(sample), release, previous) as any;
  assert.deepEqual(retained.web, previous.web);
  assert.throws(() => parseSetupEnvironment({ ...sample, https: { mode: 'external', privateKeyPath: '/etc/private.key' } }));
});
test('upgrade environment resolution preserves omitted ports, network resources and probe permission', () => {
  const customized = { ...sample, ports: { management: 13001, mixed: 17891, controller: 19091, dns: 15354 },
    resources: { egressMark: 3030, egressTable: 3030, egressPriority: 7000, tunMtu: 1400 },
    management: { ...sample.management, probeOrigins: ['https://probe.example'] } };
  const previous = createSetupDeployment(parseSetupEnvironment(customized), release) as any;
  const environment = parseSetupEnvironment({ ...sample, management: { origin: sample.management.origin,
    bootstrapResolvers: sample.management.bootstrapResolvers, subscriptionOrigins: sample.management.subscriptionOrigins } }, previous);
  const next = createSetupDeployment(environment, { ...release, manifestSha256: 'd'.repeat(64) }, previous) as any;
  assert.equal(next.management.listenPort, 13001);
  assert.equal(next.management.deployment.dnsPort, 15354);
  assert.equal(next.runtime.automaticGateway.egressTable, 3030);
  assert.equal(next.runtime.automaticGateway.tunMtu, 1400);
  assert.deepEqual(next.management.controllerPolicy.allowedProbeOrigins, ['https://probe.example']);
  const override = parseSetupEnvironment({ ...sample, ports: { dns: 15355 } }, previous);
  assert.equal(override.ports.dns, 15355);
  assert.equal(override.ports.management, 13001);
  assert.throws(() => parseSetupEnvironment(sample, null));
});
test('service identity rejects duplicate UIDs, interactive identities and mismatched explicit UID', () => {
  const account = 'cocoproxy:x:12345:12345::/nonexistent:/usr/sbin/nologin';
  assert.equal(parseServiceIdentity(account, 'cocoproxy'), 12345);
  assert.throws(() => parseServiceIdentity(account + '\nother:x:12345:1::/:/bin/false', 'cocoproxy'));
  assert.throws(() => parseServiceIdentity(account.replace('nologin', 'bash'), 'cocoproxy'));
  assert.throws(() => parseServiceIdentity(account, 'cocoproxy', 12346));
});
test('doctor aggregates independent failures without invoking mutation commands or exposing raw failures', async () => {
  const calls: string[] = [];
  const host: DoctorHost = { platform: 'linux', architecture: 'arm64', uid: 0, nodeVersion: '22.18.0',
    read: async path => { calls.push(path); return '0'; }, resolve: async path => path,
    stat: async path => { calls.push(path); throw new Error('PRIVATE RAW ERROR'); },
    run: async (path, args) => { calls.push(path + ' ' + args.join(' ')); throw new Error('PRIVATE RAW ERROR'); } };
  const result = await inspectSetup(sample, host);
  assert.equal(result.readyForInstallPreflight, false);
  assert.ok(result.checks.filter(c => c.status !== 'pass').length > 8);
  assert.ok(calls.includes('/usr/bin/python3 --version'));
  assert.ok(calls.includes('/usr/sbin/nft -j list ruleset'));
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE RAW ERROR|192\.0\.2|subscription\.example/);
  assert.ok(calls.every(call => !/prepare|remove|restart|enable|sysctl\s+-w/.test(call)));
});
test('doctor requires every necessary check including the configured Node executable to pass', async () => {
  const host: DoctorHost = { platform: 'linux', architecture: 'arm64', uid: 0, nodeVersion: '22.18.0',
    read: async () => '1', resolve: async path => path,
    stat: async path => ({ directory: ['/run/systemd/system', '/etc/polkit-1/rules.d'].includes(path),
      characterDevice: path === '/dev/net/tun', uid: 0, mode: 0o755, link: false }),
    run: async (path, args) => {
      if (path.endsWith('getent')) return 'cocoproxy:x:12345:12345::/nonexistent:/usr/sbin/nologin';
      if (path.endsWith('node')) return 'v22.18.0';
      if (path.endsWith('python3')) return 'Python 3.11.0';
      if (path.endsWith('systemctl')) return 'systemd 252';
      if (path.endsWith('nft')) return args.includes('--version') ? 'nftables v1.0' : '{"nftables":[]}';
      if (args.includes('-Version')) return 'ip utility, iproute2';
      if (args.includes('address')) return JSON.stringify([{ flags: ['UP'], addr_info: [{ family: 'inet', local: '192.0.2.2', prefixlen: 24 }] }]);
      return '[]';
    } };
  assert.equal((await inspectSetup(sample, host)).readyForInstallPreflight, true);
  const oldNode = { ...host, run: async (path: string, args: string[]) => path.endsWith('node') ? 'v18.20.0' : host.run(path, args) };
  const old = await inspectSetup(sample, oldNode);
  assert.equal(old.readyForInstallPreflight, false);
  assert.equal(old.checks.find(c => c.id === 'configured-node-version')?.status, 'fail');
  const unknown = await inspectSetup(sample, { ...host, read: async () => { throw new Error('PRIVATE RAW ERROR'); } });
  assert.equal(unknown.readyForInstallPreflight, false);
  assert.equal(unknown.checks.find(c => c.id === 'forwarding')?.status, 'unknown');
  const failed = await inspectSetup(sample, { ...host, read: async () => '0' });
  assert.equal(failed.readyForInstallPreflight, false);
  assert.equal(failed.checks.find(c => c.id === 'forwarding')?.status, 'fail');
});
test('unified entry rejects mutation flags on read-only commands before reading private inputs', () => {
  for (const args of [['doctor', '--apply'], ['inspect', '--router-disabled'], ['prepare', '--apply'],
    ['initialize', '--admin-input', '/synthetic-private-login']]) {
    const result = spawnSync(process.execPath, ['--experimental-strip-types', 'apps/setup/main.ts', ...args], {
      cwd: new URL('..', import.meta.url), encoding: 'utf8', windowsHide: true,
    });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr.trim(), 'SETUP_ARGUMENTS_INVALID');
  }
});
