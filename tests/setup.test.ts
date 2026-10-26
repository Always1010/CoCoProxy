import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { parseSetupEnvironment, createSetupDeployment, routerParameters } from '../packages/setup/input.ts';
import { inspectSetup, parseServiceIdentity, type DoctorHost } from '../packages/setup/doctor.ts';
import { ManagedWebError } from '../packages/setup/https.ts';
import { renderDeploymentPlan } from '../packages/deployment/plan.ts';
import { AUTOMATIC_GATEWAY_CORE_SHA256 } from '../packages/gateway/profile.ts';
import { assertDeploymentAccount } from '../packages/deployment/install.ts';

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
  assert.throws(() => parseServiceIdentity('', 'cocoproxy'), { code: 'SETUP_SERVICE_ACCOUNT_REQUIRED' });
  assert.throws(() => parseServiceIdentity(account + '\n' + account, 'cocoproxy'), { code: 'SETUP_SERVICE_ACCOUNT_REQUIRED' });
  for (const accounts of [account + '\nother:x:12345:1::/:/bin/false', account.replace('nologin', 'bash'),
    account.replace(':12345:12345:', ':0:12345:'), account.replace(':12345:12345:', ':4294967295:12345:'),
    account.replace(':12345:12345:', ':1e4:12345:'), account + ':extra']) {
    assert.throws(() => parseServiceIdentity(accounts, 'cocoproxy'), { code: 'SETUP_SERVICE_ACCOUNT_INVALID' });
  }
  assert.throws(() => parseServiceIdentity(account, 'cocoproxy', 12346), { code: 'SETUP_SERVICE_ACCOUNT_INVALID' });
  for (const name of ['root', 'nobody', 'invalid.name']) {
    assert.throws(() => parseServiceIdentity(account.replace('cocoproxy:', name + ':'), name), { code: 'SETUP_SERVICE_ACCOUNT_INVALID' });
  }
});
test('service identity accepts only the installer system shell paths', () => {
  const account = (shell: string) => 'cocoproxy:x:12345:12345::/nonexistent:' + shell;
  for (const shell of ['/usr/sbin/nologin', '/sbin/nologin', '/bin/false', '/usr/bin/false']) {
    assert.equal(parseServiceIdentity(account(shell), 'cocoproxy', 12345), 12345);
  }
  for (const shell of ['/opt/custom/nologin', '/opt/custom/false', '/bin/bash', 'nologin', '/usr/sbin/nologin/']) {
    assert.throws(() => parseServiceIdentity(account(shell), 'cocoproxy'), { code: 'SETUP_SERVICE_ACCOUNT_INVALID' });
  }
});
test('installer keeps its account error code for invalid service identity requests', async () => {
  for (const [name, uid] of [['root', 12345], ['nobody', 12345], ['invalid.name', 12345],
    ['cocoproxy', 0], ['cocoproxy', 1.5], ['cocoproxy', 4_294_967_295]] as const) {
    await assert.rejects(assertDeploymentAccount(name, uid), { code: 'INSTALL_DEDICATED_ACCOUNT_REQUIRED' });
  }
});
test('doctor blocks account shells outside the installer allowlist', async () => {
  const host = readyDoctorHost();
  for (const shell of ['/opt/custom/nologin', '/opt/custom/false']) {
    const result = await inspectSetup(sample, { ...host, run: async (path, args) => path.endsWith('getent')
      ? 'cocoproxy:x:12345:12345::/nonexistent:' + shell : host.run(path, args) });
    assert.equal(result.serviceUid, null);
    assert.equal(result.checks.find(check => check.id === 'service-account')?.status, 'fail');
    assert.equal(result.readyForInstallPreflight, false);
  }
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
function readyDoctorHost(): DoctorHost {
  return { platform: 'linux', architecture: 'arm64', uid: 0, nodeVersion: '22.18.0',
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
}

test('doctor requires every necessary check including the configured Node executable to pass', async () => {
  const host = readyDoctorHost();
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

test('doctor blocks managed HTTPS on failed or unavailable evidence and keeps private details out of its report', async () => {
  const environment = { ...sample, https: { mode: 'managed', certificatePath: '/etc/cocoproxy/tls/server.crt',
    privateKeyPath: '/etc/cocoproxy/tls/server.key' } };
  const host = readyDoctorHost();
  let calls = 0;
  const managedWeb: NonNullable<DoctorHost['managedWeb']> = async input => {
    calls++;
    assert.equal(input.serviceUid, 12345);
    assert.equal(input.origin, sample.management.origin);
    assert.equal(input.gatewayIPv4, sample.network.gatewayIPv4);
    assert.equal(input.listenPort, 13000);
    assert.deepEqual(input.web, { schemaVersion: 1, nginxPath: '/usr/sbin/nginx',
      certificatePath: environment.https.certificatePath, privateKeyPath: environment.https.privateKeyPath });
  };
  const success = await inspectSetup(environment, { ...host, managedWeb });
  assert.equal(success.readyForInstallPreflight, true);
  assert.equal(success.checks.find(c => c.id === 'managed-https')?.status, 'pass');
  assert.equal(calls, 1);
  await inspectSetup(sample, { ...host, managedWeb });
  assert.equal(calls, 1);
  for (const code of ['SETUP_HTTPS_CERTIFICATE_EXPIRED', 'SETUP_HTTPS_CERTIFICATE_NAME_MISMATCH',
    'SETUP_HTTPS_KEY_MISMATCH', 'SETUP_HTTPS_FILE_UNTRUSTED', 'SETUP_HTTPS_PATH_UNTRUSTED']) {
    const failed = await inspectSetup(environment, { ...host, managedWeb: async () => { throw new ManagedWebError(code); } });
    assert.equal(failed.readyForInstallPreflight, false);
    assert.equal(failed.checks.find(c => c.id === 'managed-https')?.status, 'fail');
    assert.equal(failed.checks.find(c => c.id === 'managed-https')?.code, code);
    assert.ok(failed.checks.find(c => c.id === 'router-contract'));
  }
  const unavailable = async () => { throw new Error('PRIVATE RAW ERROR /etc/private/server.key'); };
  for (const unavailableHost of [host, { ...host, uid: 1000, managedWeb }, { ...host, managedWeb: unavailable },
    { ...host, run: async () => { throw new Error('PRIVATE RAW ERROR'); }, managedWeb }]) {
    const result = await inspectSetup(environment, unavailableHost);
    assert.equal(result.readyForInstallPreflight, false);
    assert.equal(result.checks.find(c => c.id === 'managed-https')?.status, 'unknown');
    assert.equal(result.checks.find(c => c.id === 'managed-https')?.code, 'SETUP_HTTPS_PREFLIGHT_UNAVAILABLE');
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE RAW ERROR|\/etc\/private|gateway\.example|server\.key/);
  }
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
