import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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
});
test('setup preserves an existing internal identity and refuses silent custom-layout changes', () => {
  const environment = parseSetupEnvironment(sample), previous = createSetupDeployment(environment, release) as any;
  const input = createSetupDeployment(environment, { ...release, manifestSha256: 'c'.repeat(64) }, previous) as any;
  assert.equal(input.management.deployment.controllerSecret, previous.management.deployment.controllerSecret);
  assert.notEqual(input.runtime.sourceDirectory, previous.runtime.sourceDirectory);
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
