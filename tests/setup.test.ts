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
import { inspectDeployment, type DeploymentInspectionHost } from '../packages/deployment/maintenance.ts';
import { assertMaintenanceLifecycle, InstallError, type Receipt } from '../packages/deployment/install.ts';
import { createHash } from 'node:crypto';
import { parseListeningSockets, listenerOverlap, setupListeningTargets } from '../packages/setup/listening.ts';
import { assertPrivatePath, assertRootControlledPath, type PathEvidenceHost } from '../packages/deployment/path-evidence.ts';
import { policyRuleConflicts, routeConflicts, firewallConflicts, tunConflicts, NetworkObservationError } from '../packages/deployment/network-evidence.ts';

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
test('router mapping uses one environment and keeps each interface, MAC and DNS port role distinct', () => {
  const environment = parseSetupEnvironment({ ...sample, ports: { dns: 15354 },
    router: { ...sample.router, dnsListenPort: 2053, enabled: true } });
  const input = createSetupDeployment(environment, release) as any;
  const parameters = routerParameters(environment);
  assert.equal(parameters.configTemplate.link.interface, sample.router.lanInterface);
  assert.notEqual(parameters.configTemplate.link.interface, environment.network.ingressInterface);
  assert.equal(parameters.configTemplate.link.gatewayMac, sample.router.gatewayMAC);
  assert.equal(parameters.deliveryMAC, sample.network.routerMAC);
  assert.notEqual(parameters.deliveryMAC, parameters.configTemplate.link.gatewayMac);
  assert.equal(parameters.configTemplate.dns.gatewayPort, input.management.deployment.dnsPort);
  assert.equal(parameters.configTemplate.dns.listenPort, 2053);
  assert.equal(parameters.configTemplate.clientCIDR, input.runtime.automaticGateway.clientCIDR);
  assert.equal(parameters.configTemplate.link.gatewayAddress, input.runtime.automaticGateway.gatewayIPv4);
  assert.deepEqual(parameters.prerequisites.bootstrapResolvers, input.management.deployment.bootstrapResolvers);
  assert.deepEqual(parameters.prerequisites.baseDNS, { address: '127.0.0.1', port: 53, localDomains: ['lan'], unqualifiedNames: true });
  assert.equal(parameters.prerequisites.endToEnd, 'unverified');
  assert.equal(parameters.configTemplate.enabled, true);
  assert.equal(Object.hasOwn(parameters.configTemplate, 'revision'), false);
  assert.doesNotMatch(JSON.stringify(parameters), /controllerSecret|setup-validation-only/);
});
test('legacy environment remains usable but a complete router output needs explicitly confirmed router facts', () => {
  const { router, ...legacy } = sample;
  const environment = parseSetupEnvironment(legacy);
  assert.doesNotThrow(() => createSetupDeployment(environment, release));
  assert.throws(() => routerParameters(environment), { code: 'SETUP_ROUTER_CONFIRMATION_REQUIRED' });
  for (const change of [{ lanInterface: undefined }, { gatewayMAC: sample.network.routerMAC },
    { gatewayMAC: '01:00:00:00:00:02' }, { enabled: undefined }, { baseDNSIndependentConfirmed: false },
    { dnsListenPort: 53 }, { localDomains: [] }, { localDomains: ['lan', 'lan'] }, { localDomains: ['bad..lan'] }]) {
    const candidate = JSON.parse(JSON.stringify({ ...legacy, router: { ...router, ...change } }));
    assert.throws(() => parseSetupEnvironment(candidate), { code: 'SETUP_ROUTER_FACTS_INVALID' });
  }
  assert.throws(() => parseSetupEnvironment({ ...sample, router: { ...router, adapter: 'unknown-adapter' } }),
    { code: 'SETUP_ROUTER_ADAPTER_UNSUPPORTED' });
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
  assert.ok(calls.includes('/usr'));
  assert.ok(!calls.includes('/usr/bin/python3 --version'));
  assert.ok(!calls.includes('/usr/sbin/nft -j list ruleset'));
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE RAW ERROR|192\.0\.2|subscription\.example/);
  assert.ok(calls.every(call => !/prepare|remove|restart|enable|sysctl\s+-w/.test(call)));
});
test('doctor reports invalid environment input while still collecting independent host observations', async () => {
  const host = readyDoctorHost();
  const result = await inspectSetup({ ...sample, privateSecret: 'PRIVATE INPUT VALUE' }, host);
  assert.equal(result.readyForInstallPreflight, false);
  assert.equal(result.checks.find(check => check.id === 'environment')?.status, 'fail');
  assert.equal(result.checks.find(check => check.id === 'environment')?.code, 'SETUP_ENVIRONMENT_INVALID');
  assert.equal(result.checks.find(check => check.id === 'systemd')?.status, 'pass');
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE INPUT VALUE/);
});
test('doctor distinguishes missing accounts from unavailable account observations', async () => {
  const host = readyDoctorHost();
  const missing = await inspectSetup(sample, { ...host, run: async (path, args) => path.endsWith('getent') ? '' : host.run(path, args) });
  assert.equal(missing.checks.find(check => check.id === 'service-account')?.status, 'fail');
  assert.equal(missing.checks.find(check => check.id === 'service-account')?.code, 'SETUP_SERVICE_ACCOUNT_REQUIRED');
  const unavailable = await inspectSetup(sample, { ...host, run: async (path, args) => {
    if (path.endsWith('getent')) throw Object.assign(new Error('PRIVATE OBSERVATION'), { code: 'EACCES' });
    return host.run(path, args);
  } });
  assert.equal(unavailable.checks.find(check => check.id === 'service-account')?.status, 'unknown');
  assert.equal(unavailable.readyForInstallPreflight, false);
  assert.doesNotMatch(JSON.stringify(unavailable), /PRIVATE OBSERVATION|EACCES/);
});
test('doctor keeps six partial layers and reports independent failures with fixed public reasons', async () => {
  const host = readyDoctorHost();
  const result = await inspectSetup(sample, { ...host,
    stat: async path => {
      if (path === '/run/systemd/system') throw Object.assign(new Error('PRIVATE PATH'), { code: 'ENOENT' });
      if (path === '/etc/polkit-1/rules.d') throw Object.assign(new Error('PRIVATE ACCESS'), { code: 'EACCES' });
      return host.stat(path);
    },
    read: async () => '0',
    run: async (path, args) => {
      if (path.endsWith('python3')) return 'Python 3.8.20';
      if (path.endsWith('getent')) throw Object.assign(new Error('PRIVATE COMMAND'), { code: 'EIO' });
      if (args.includes('route')) return 'PRIVATE MALFORMED JSON';
      if (path.endsWith('nft') && args.includes('tables')) return '{"unexpected":[]}';
      return host.run(path, args);
    },
  });
  assert.deepEqual(result.layers.map(layer => layer.id), ['foundation', 'components', 'identity', 'network', 'management', 'installation']);
  assert.equal(result.layers.find(layer => layer.id === 'installation')?.coverage, 'partial');
  assert.ok(result.layers.find(layer => layer.id === 'installation')!.checkIds.includes('installation-receipt'));
  assert.ok(result.layers.every(layer => ['partial', 'not-assessed'].includes(layer.coverage)));
  for (const check of result.checks) {
    assert.ok(result.layers.some(layer => layer.id === check.layer && layer.checkIds.includes(check.id)));
    for (const field of ['id', 'code', 'reason', 'action', 'message'] as const) assert.ok(check[field].length > 0);
    assert.equal(typeof check.required, 'boolean');
  }
  for (const [id, status, code] of [
    ['systemd', 'fail', 'SETUP_REQUIRED_COMPONENT_MISSING'], ['python', 'fail', 'SETUP_REQUIREMENT_NOT_MET'],
    ['polkit', 'unknown', 'SETUP_CHECK_UNAVAILABLE'], ['service-account', 'unknown', 'SETUP_CHECK_UNAVAILABLE'],
    ['routes', 'unknown', 'SETUP_OBSERVATION_INVALID'], ['firewall', 'unknown', 'SETUP_OBSERVATION_INVALID'],
    ['forwarding', 'fail', 'SETUP_REQUIREMENT_NOT_MET'],
  ]) {
    const check = result.checks.find(item => item.id === id);
    assert.equal(check?.status, status, id);
    assert.equal(check?.code, code, id);
  }
  assert.equal(result.readyForInstallPreflight, false);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|EACCES|ENOENT|EIO|192\.0\.2|subscription\.example/);
});
test('doctor only treats explicit missing-tool observations as failure and keeps malformed query evidence unknown', async () => {
  const host = readyDoctorHost();
  for (const [code, status] of [['ENOENT', 'fail'], ['EACCES', 'unknown'], ['ETIMEDOUT', 'unknown'], ['COMMAND_EXIT_1', 'unknown']]) {
    const result = await inspectSetup(sample, { ...host, run: async (path, args) => {
      if (path.endsWith('/ip') && args.includes('-Version')) throw Object.assign(new Error('PRIVATE ERROR'), { code });
      return host.run(path, args);
    } });
    assert.equal(result.checks.find(check => check.id === 'ip')?.status, status, code);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE ERROR/);
  }
  const malformed = await inspectSetup(sample, { ...host, run: async (path, args) => path.endsWith('getent')
    ? 'PRIVATE INVALID PASSWD OUTPUT' : host.run(path, args) });
  assert.equal(malformed.checks.find(check => check.id === 'service-account')?.status, 'unknown');
  assert.equal(malformed.checks.find(check => check.id === 'service-account')?.code, 'SETUP_OBSERVATION_INVALID');
  const unreadableForwarding = await inspectSetup(sample, { ...host, read: async () => 'PRIVATE INVALID SYSCTL' });
  assert.equal(unreadableForwarding.checks.find(check => check.id === 'forwarding')?.status, 'unknown');
  assert.equal(unreadableForwarding.checks.find(check => check.id === 'forwarding')?.code, 'SETUP_OBSERVATION_INVALID');
  assert.doesNotMatch(JSON.stringify(unreadableForwarding), /PRIVATE INVALID SYSCTL/);
  const complete = await inspectSetup(sample, host);
  assert.equal(complete.schemaVersion, 1);
  assert.equal(complete.readyForInstallPreflight, true);
  assert.equal(complete.layers.find(layer => layer.id === 'installation')?.coverage, 'partial');
});
function readyDoctorHost(): DoctorHost {
  return { platform: 'linux', architecture: 'arm64', uid: 0, nodeVersion: '22.18.0',
    read: async () => '1', resolve: async path => path,
    inspection: async () => ({ installed: false, readOnly: true, findings: [] }),
    stat: async path => {
      if (['/var/lib/cocoproxy', '/var/lib/cocoproxy-gateway-network', '/var/lib/cocoproxy-deployment', '/etc/cocoproxy'].includes(path) ||
        path.startsWith('/var/lib/cocoproxy-gateway-network/') || path.startsWith('/var/lib/cocoproxy-web-') || path.startsWith('/run/cocoproxy-web') ||
        path.startsWith('/opt/cocoproxy/releases/')) throw Object.assign(new Error('synthetic absent'), { code: 'ENOENT' });
      const file = ['/usr/bin/node', '/usr/bin/systemctl', '/usr/bin/python3', '/usr/bin/getent', '/usr/sbin/ip', '/usr/sbin/nft', '/usr/bin/ss'].includes(path);
      return { directory: !file && path !== '/dev/net/tun', file,
        characterDevice: path === '/dev/net/tun', uid: 0, mode: 0o755, link: false, nlink: 1 };
    },
    run: async (path, args) => {
      if (path.endsWith('getent')) return 'cocoproxy:x:12345:12345::/nonexistent:/usr/sbin/nologin';
      if (path.endsWith('/ss')) return '';
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

test('doctor aggregates untrusted tool ancestors, deployment links, wrong owners and traversal failures without running unsafe tools', async () => {
  const base = readyDoctorHost(), commands: string[] = [];
  const result = await inspectSetup(sample, { ...base, stat: async path => {
    if (path === '/usr/bin') return { ...await base.stat(path), mode: 0o777 };
    if (path === '/opt/cocoproxy') return { ...await base.stat(path), link: true };
    if (path === '/var/lib/cocoproxy') return { directory: true, file: false, characterDevice: false, link: false, uid: 999, mode: 0o700, nlink: 1 };
    if (path === '/etc') return { ...await base.stat(path), mode: 0o750 };
    return base.stat(path);
  }, run: async (path, args) => { commands.push(path); return base.run(path, args); } });
  for (const id of ['python', 'systemctl', 'service-account', 'node-path', 'systemctl-path', 'release-parent']) {
    assert.equal(result.checks.find(check => check.id === id)?.status, 'fail', id);
  }
  assert.ok(!commands.some(path => path.startsWith('/usr/bin/')));
  assert.equal(result.readyForInstallPreflight, false);
  assert.equal(result.checks.find(check => check.id === 'service-paths')?.status, 'unknown');
  assert.doesNotMatch(JSON.stringify(result), /999|\/opt\/cocoproxy|synthetic absent/);
  const traversal = await inspectSetup(sample, { ...base, stat: async path => path === '/opt/cocoproxy'
    ? { ...await base.stat(path), mode: 0o750 } : base.stat(path) });
  assert.equal(traversal.checks.find(check => check.id === 'service-paths')?.code, 'INSTALL_SERVICE_TRAVERSE_REQUIRED');
  const wrongOwner = await inspectSetup(sample, { ...base, stat: async path => path === '/var/lib/cocoproxy'
    ? { directory: true, file: false, characterDevice: false, link: false, uid: 999, mode: 0o700, nlink: 1 } : base.stat(path) });
  assert.equal(wrongOwner.checks.find(check => check.id === 'deployment-directory-1')?.code, 'INSTALL_DIRECTORY_OWNERSHIP_CONFLICT');
});

test('doctor follows root-owned distro tool links and keeps incomplete path observations unknown', async () => {
  const base = readyDoctorHost();
  const merged = await inspectSetup(sample, { ...base,
    resolve: async path => path === '/usr/bin/node' ? '/usr/libexec/node' : path,
    stat: async path => path === '/usr/bin/node' ? { ...await base.stat(path), link: true, mode: 0o777 }
      : path === '/usr/libexec/node' ? { ...await base.stat('/usr/bin/node') } : base.stat(path),
  });
  assert.equal(merged.checks.find(check => check.id === 'node-path')?.status, 'pass');
  const incomplete = await inspectSetup(sample, { ...base, stat: async path => {
    const { file, nlink, ...oldObservation } = await base.stat(path);
    return oldObservation;
  }, run: async () => { throw new Error('must not execute with incomplete trust evidence'); } });
  assert.equal(incomplete.checks.find(check => check.id === 'python')?.status, 'unknown');
  assert.equal(incomplete.checks.find(check => check.id === 'node-path')?.status, 'unknown');
  assert.equal(incomplete.readyForInstallPreflight, false);
});

test('shared network predicates detect reserved resources and conservative numeric, masked and negated mark overlap', () => {
  const n = { egressPriority: 8000, egressTable: 2024, egressMark: 65536, clientCIDR: '192.0.2.0/24' };
  assert.deepEqual(policyRuleConflicts([{ priority: 8001, fwmark: '0x10000' }], n), ['INSTALL_RULE_CONFLICT', 'INSTALL_RULE_MARK_CONFLICT']);
  for (const rule of [
    { priority: 100, fwmark: 65536 }, { priority: 100, fwmark: '0x10000/0xff0000' },
    { priority: 100, fwmark: '0', fwmask: '0x0' }, { priority: 100, src: 'all', fwmark: '0x20000', not: null },
    { priority: 100, fwmark: '2023' },
  ]) assert.deepEqual(policyRuleConflicts([rule], n), ['INSTALL_RULE_MARK_CONFLICT']);
  assert.deepEqual(policyRuleConflicts([{ priority: 100, fwmark: '0x20000', fwmask: '0xffff0000' }], n), []);
  assert.deepEqual(policyRuleConflicts([{ priority: 100, fwmark: '0', fwmask: '0', not: null }], n), []);
  assert.deepEqual(policyRuleConflicts([{ priority: 9005 }], n), ['INSTALL_RULE_CONFLICT']);
  for (const table of [2024, '22024', 2022]) assert.deepEqual(routeConflicts([{ dst: 'default', table }], n), ['INSTALL_ROUTE_CONFLICT']);
  assert.deepEqual(routeConflicts([{ table: 'main', dst: '198.51.100.0/24' }], n), []);
  assert.deepEqual(firewallConflicts({ nftables: [{ table: { family: 'inet', name: 'mihomo' } }] }), ['INSTALL_NFT_CONFLICT']);
  assert.deepEqual(firewallConflicts({ nftables: [{ table: { family: 'inet', name: 'cocoproxy_host_guard' } }] }), ['INSTALL_NFT_CONFLICT']);
  assert.deepEqual(tunConflicts([{ ifname: 'cocoproxy-tun' }]), ['INSTALL_TUN_CONFLICT']);
  for (const malformed of [[{}], [{ priority: 100, fwmark: 'private malformed value' }], [{ priority: 100, fwmask: 255 }],
    [{ priority: 100, fwmark: '0', fwmask: '0', not: null, src: '198.51.100.0/24' }]]) {
    assert.throws(() => policyRuleConflicts(malformed, n), NetworkObservationError);
  }
});

test('doctor reports conflicts in valid network JSON and retained network receipts independently without mutation', async () => {
  const base = readyDoctorHost(), calls: string[] = [];
  const receipt = '/var/lib/cocoproxy-gateway-network/network-receipt.json';
  const result = await inspectSetup(sample, { ...base, stat: async path => path === receipt
    ? { directory: false, file: true, characterDevice: false, link: false, uid: 0, mode: 0o600, nlink: 1 }
    : path === '/var/lib/cocoproxy-gateway-network' ? { directory: true, file: false, characterDevice: false, link: false, uid: 0, mode: 0o700, nlink: 1 } : base.stat(path),
    read: async path => path === receipt ? '{"schemaVersion":1,"status":"complete"}' : base.read(path),
    run: async (path, args) => {
      calls.push(path + ' ' + args.join(' '));
      if (args.includes('rule')) return JSON.stringify([{ priority: 8000, fwmark: '0x10000' }]);
      if (args.includes('route')) return JSON.stringify([{ table: 22024, dst: 'default' }]);
      if (args.includes('tables')) return JSON.stringify({ nftables: [{ table: { family: 'inet', name: 'cocoproxy_auto_guard' } }] });
      if (args.includes('link')) return JSON.stringify([{ ifname: 'cocoproxy-tun' }]);
      return base.run(path, args);
    },
  });
  for (const [id, code] of [['policy-rules', 'INSTALL_RULE_CONFLICT'], ['routes', 'INSTALL_ROUTE_CONFLICT'],
    ['firewall', 'INSTALL_NFT_CONFLICT'], ['tun-name', 'INSTALL_TUN_CONFLICT'], ['network-receipt', 'INSTALL_NETWORK_REMOVE_REQUIRED']]) {
    assert.equal(result.checks.find(check => check.id === id)?.code, code, id);
    assert.equal(result.checks.find(check => check.id === id)?.status, 'fail', id);
  }
  assert.deepEqual(result.checks.find(check => check.id === 'policy-rules')?.conflicts, ['INSTALL_RULE_CONFLICT', 'INSTALL_RULE_MARK_CONFLICT']);
  assert.ok(calls.every(call => !/prepare|remove|delete|flush|replace/.test(call)));
  assert.doesNotMatch(JSON.stringify(result), /192\.0\.2|0x10000|network-receipt\.json/);
  const malformed = await inspectSetup(sample, { ...base, run: async (path, args) => args.includes('rule')
    ? JSON.stringify([{ priority: 100, fwmark: 'private invalid mark' }]) : base.run(path, args) });
  assert.equal(malformed.checks.find(check => check.id === 'policy-rules')?.status, 'unknown');
  assert.doesNotMatch(JSON.stringify(malformed), /private invalid mark/);
  for (const [status, expected] of [['removed', 'pass'], ['incomplete', 'fail'], ['unrecognized', 'unknown']]) {
    const observed = await inspectSetup(sample, { ...base, stat: async path => path === receipt
      ? { directory: false, file: true, characterDevice: false, link: false, uid: 0, mode: 0o600, nlink: 1 }
      : path === '/var/lib/cocoproxy-gateway-network' ? { directory: true, file: false, characterDevice: false, link: false, uid: 0, mode: 0o700, nlink: 1 } : base.stat(path),
      read: async path => path === receipt ? JSON.stringify({ schemaVersion: 1, status }) : base.read(path),
    });
    assert.equal(observed.checks.find(check => check.id === 'network-receipt')?.status, expected);
  }
});

function installationFixture() {
  const bytes = Buffer.from('synthetic managed settings');
  const receipt: Receipt = { schemaVersion: 1, status: 'complete', manifestSha256: 'b'.repeat(64),
    release: '/opt/cocoproxy/releases/' + 'b'.repeat(64), serviceUid: 12345, stateDirectory: '/var/lib/cocoproxy',
    credentialPath: '/etc/cocoproxy/admin.json', files: [{ path: '/etc/cocoproxy/runtime.json', owner: 'root', mode: '0600',
      sensitive: true, sha256: createHash('sha256').update(bytes).digest('hex') }] };
  const records = new Map<string, Buffer>([['/etc/cocoproxy/runtime.json', bytes]]);
  const unit = Buffer.from('synthetic management unit');
  records.set('/etc/systemd/system/cocoproxy-management.service', unit);
  receipt.files.push({ path: '/etc/systemd/system/cocoproxy-management.service', owner: 'root', mode: '0644', sensitive: false,
    sha256: createHash('sha256').update(unit).digest('hex') });
  const options = { releaseMatches: true, lifecycle: { schemaVersion: 1, enabled: false, paused: false }, unreadable: false };
  const store = '/var/lib/cocoproxy-deployment';
  const pathHost: PathEvidenceHost = { resolve: async path => path, info: async path => {
    const file = path === store + '/receipt.json' || records.has(path);
    if (!file && /\.(?:json|lock)$/.test(path)) return null;
    return { file, directory: !file, link: false, uid: 0, mode: file ? path.endsWith('.service') ? 0o644 : 0o600 : path === store ? 0o700 : 0o755, nlink: 1 };
  } };
  const host: DeploymentInspectionHost = {
    info: async path => { const stat = await pathHost.info(path); return stat ? { ...stat,
      isFile: () => stat.file, isDirectory: () => stat.directory, isSymbolicLink: () => stat.link } : null; },
    rootPath: path => assertRootControlledPath(path, pathHost), privateFile: (path, uid) => assertPrivatePath(path, uid, pathHost),
    read: async path => {
      if (path === store + '/receipt.json') return Buffer.from(JSON.stringify(receipt));
      if (options.unreadable && path === '/etc/cocoproxy/runtime.json') throw Object.assign(new Error('PRIVATE READ'), { code: 'EACCES' });
      const value = records.get(path); if (!value) throw Object.assign(new Error('PRIVATE ABSENT'), { code: 'ENOENT' }); return value;
    },
    list: async () => [], release: async () => { if (!options.releaseMatches) throw new InstallError('INSTALL_PAYLOAD_HASH_MISMATCH'); },
    maintenance: async () => assertMaintenanceLifecycle(options.lifecycle),
    processIdentity: async () => ({ bootId: '11111111-1111-1111-1111-111111111111', startTime: '100' }),
  };
  return { host, receipt, records, options, store };
}

test('shared installation inspection reads receipt, byte drift, maintenance and lifecycle claims through a read-only host', async () => {
  const fixture = installationFixture();
  const clean = await inspectDeployment({ host: fixture.host });
  assert.ok(clean.installed === true);
  assert.equal(clean.files[0].status, 'matches-receipt');
  assert.equal(clean.maintenance.status, 'ready');
  assert.equal(clean.lifecycleClaim.present, false);
  fixture.records.set('/etc/cocoproxy/runtime.json', Buffer.from('changed bytes'));
  fixture.records.set(fixture.store + '/lifecycle-claim.lock', Buffer.from('private claim'));
  fixture.options.lifecycle = { schemaVersion: 1, enabled: true, paused: false };
  const changed = await inspectDeployment({ host: fixture.host });
  assert.ok(changed.installed === true);
  assert.equal(changed.files[0].status, 'changed');
  assert.equal(changed.lifecycleClaim.present, true);
  assert.equal(changed.maintenance.status, 'running');
  fixture.options.unreadable = true;
  const unreadable = await inspectDeployment({ host: fixture.host });
  assert.ok(unreadable.installed === true);
  assert.equal(unreadable.files[0].status, 'INSTALL_INSPECTION_UNAVAILABLE');
});

test('doctor aggregates installed drift, pending transactions, live locks and maintenance instead of treating inspection failure as absence', async () => {
  const fixture = installationFixture(), base = readyDoctorHost();
  const clean = await inspectSetup(sample, { ...base, inspection: () => inspectDeployment({ host: fixture.host }) });
  assert.ok(clean.checks.filter(check => check.layer === 'installation').every(check => check.status === 'pass'));
  fixture.receipt.status = 'pending';
  fixture.receipt.transaction = { operation: 'upgrade', id: '22222222-2222-2222-2222-222222222222' };
  fixture.records.set('/etc/cocoproxy/runtime.json', Buffer.from('private drift'));
  fixture.records.set(fixture.store + '/install.lock', Buffer.from(JSON.stringify({ schemaVersion: 1, id: fixture.receipt.transaction.id,
    pid: 123, bootId: '11111111-1111-1111-1111-111111111111', startTime: '100' })));
  fixture.records.set(fixture.store + '/lifecycle.json', Buffer.from(JSON.stringify({ schemaVersion: 1,
    id: '33333333-3333-3333-3333-333333333333', status: 'pending', action: 'pause-maintenance' })));
  fixture.options.lifecycle = { schemaVersion: 1, enabled: true, paused: false };
  const broken = await inspectSetup(sample, { ...base, inspection: () => inspectDeployment({ host: fixture.host }) });
  for (const [id, code] of [['installation-receipt', 'SETUP_INSTALLATION_INCOMPLETE'], ['installation-files', 'SETUP_INSTALLATION_DRIFT'],
    ['installation-locks', 'SETUP_INSTALLATION_BUSY'], ['installation-maintenance', 'SETUP_MAINTENANCE_REQUIRED']]) {
    assert.equal(broken.checks.find(check => check.id === id)?.code, code, id);
    assert.equal(broken.checks.find(check => check.id === id)?.status, 'fail', id);
  }
  assert.doesNotMatch(JSON.stringify(broken), /private drift|runtime\.json|22222222/);
  const unavailable = await inspectSetup(sample, { ...base, inspection: async () => { throw new Error('PRIVATE INSPECTION'); } });
  assert.ok(unavailable.checks.filter(check => check.layer === 'installation').every(check => check.status === 'unknown'));
  assert.equal(unavailable.readyForInstallPreflight, false);
});

test('listener parsing preserves address and protocol distinctions and leaves ambiguous IPv6 wildcard binding unresolved', () => {
  const targets = setupListeningTargets(parseSetupEnvironment(sample));
  const controller = targets.find(target => target.id === 'controller-port')!;
  const sockets = parseListeningSockets('tcp LISTEN 0 4096 192.0.2.99:19090 0.0.0.0:*\nudp UNCONN 0 0 127.0.0.1:19090 0.0.0.0:*', 4);
  assert.ok(sockets.every(socket => listenerOverlap(socket, controller) === 'no'));
  assert.equal(listenerOverlap(parseListeningSockets('tcp LISTEN 0 4096 [::]:19090 [::]:*', 6)[0], controller), 'possible');
  assert.equal(listenerOverlap(parseListeningSockets('tcp LISTEN 0 4096 [::ffff:7f00:1]:19090 *:*', 6)[0], controller), 'yes');
  assert.equal(parseListeningSockets('udp UNCONN 0 0 [fe80::1]%enp1s0:19090 *:*', 6)[0].address, 'fe80::1');
  assert.equal(listenerOverlap(parseListeningSockets('tcp LISTEN 0 4096 0.0.0.0:19090 0.0.0.0:* users:(("foreign",pid=42,fd=3))', 4)[0], controller), 'yes');
  assert.throws(() => parseListeningSockets('PRIVATE MALFORMED LISTENERS', 4), { code: 'SETUP_OBSERVATION_INVALID' });
});

test('doctor distinguishes free, foreign, verified owned and unproven occupied ports without exposing process details', async () => {
  const fixture = installationFixture(), base = readyDoctorHost();
  const listening = 'tcp LISTEN 0 4096 127.0.0.1:13000 0.0.0.0:* users:(("node",pid=42,fd=3))';
  const listenerHost: DoctorHost = { ...base, run: async (path, args) => path.endsWith('/ss') ? args.includes('-4') && !args.includes('-B') ? listening : '' : base.run(path, args) };
  const foreign = await inspectSetup(sample, listenerHost);
  assert.equal(foreign.checks.find(check => check.id === 'management-port')?.code, 'SETUP_PORT_CONFLICT');
  assert.equal(foreign.checks.find(check => check.id === 'dns-port')?.status, 'pass');
  const ownedHost: DoctorHost = { ...listenerHost, inspection: () => inspectDeployment({ host: fixture.host }),
    resolve: async path => path === '/proc/42/exe' ? '/usr/bin/node' : base.resolve(path),
    read: async path => path === '/proc/42/cgroup' ? '0::/system.slice/cocoproxy-management.service' : base.read(path),
    run: async (path, args) => args.includes('show') && args.includes('cocoproxy-management.service')
      ? 'MainPID=42\nFragmentPath=/etc/systemd/system/cocoproxy-management.service\nDropInPaths=\nNeedDaemonReload=no' : listenerHost.run(path, args),
  };
  const owned = await inspectSetup(sample, ownedHost);
  assert.equal(owned.checks.find(check => check.id === 'management-port')?.code, 'SETUP_PORT_OWNED_REQUIRES_STOP');
  const unknown = await inspectSetup(sample, { ...ownedHost, read: async path => {
    if (path.includes('/proc/')) throw new Error('PRIVATE PROCESS'); return base.read(path);
  } });
  assert.equal(unknown.checks.find(check => check.id === 'management-port')?.code, 'SETUP_PORT_OWNERSHIP_UNKNOWN');
  const unowned = await inspectSetup(sample, { ...ownedHost, resolve: async path => path === '/proc/42/exe' ? '/usr/bin/foreign' : base.resolve(path) });
  assert.equal(unowned.checks.find(check => check.id === 'management-port')?.code, 'SETUP_PORT_CONFLICT');
  const connected = await inspectSetup(sample, { ...base, run: async (path, args) => path.endsWith('/ss')
    ? args.includes('-4') && !args.includes('-B') ? 'udp ESTAB 0 0 192.0.2.2:15353 192.0.2.3:12345' : '' : base.run(path, args) });
  assert.equal(connected.checks.find(check => check.id === 'dns-port')?.status, 'unknown');
  const oldSs = await inspectSetup(sample, { ...base, run: async (path, args) => {
    if (path.endsWith('/ss') && args.includes('-B')) throw new Error('unsupported capability'); return base.run(path, args);
  } });
  assert.equal(oldSs.checks.find(check => check.id === 'dns-port')?.status, 'pass');
  assert.equal(oldSs.checks.find(check => check.id === 'bound-sockets')?.code, 'SETUP_PORT_BOUND_SCOPE_UNAVAILABLE');
  assert.equal(oldSs.readyForInstallPreflight, true);
  const bound = await inspectSetup(sample, { ...base, run: async (path, args) => path.endsWith('/ss')
    ? args.includes('-4') && args.includes('-B') ? 'tcp UNDEF 0 0 127.0.0.1:13000 0.0.0.0:*' : '' : base.run(path, args) });
  assert.equal(bound.checks.find(check => check.id === 'management-port')?.status, 'unknown');
  assert.equal(bound.readyForInstallPreflight, false);
  assert.doesNotMatch(JSON.stringify(owned) + JSON.stringify(unknown), /PRIVATE PROCESS|pid=42|\/proc\/42/);
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
  assert.equal(success.readyForInstallPreflight, true, JSON.stringify(success.checks.filter(check => check.required && check.status !== 'pass')));
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
    const result = spawnSync(process.execPath, ['--no-warnings', '--experimental-strip-types', 'apps/setup/main.ts', ...args], {
      cwd: new URL('..', import.meta.url), encoding: 'utf8', windowsHide: true,
    });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr.trim(), 'SETUP_ARGUMENTS_INVALID');
  }
});
