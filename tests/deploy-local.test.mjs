import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { cp, mkdir, mkdtemp, readFile, lstat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { deployFromLocalBuild, parseDeployLocalOptions } from '../scripts/deploy-local.mjs';
import { collectInstallAnswers, createTerminal, detectLocalInstallation, planSystemPreparation, preparationSummary,
  writePrivateInput, needsUpdateRouterAdapter, collectRouterAdapter } from '../scripts/local-install.mjs';

const release = { output: '/srv/synthetic-build/releases/current', manifestSha256: 'a'.repeat(64), commit: 'b'.repeat(40) };
function deploymentHarness() {
  const events = [], controller = new AbortController(); let locked = false;
  return { events, dependencies: {
    source: '/srv/synthetic-source', assertTarget: async () => {},
    resolvePaths: async () => ({ source: '/srv/synthetic-source', workspace: '/srv/synthetic-build' }),
    lock: async (_paths, action) => { locked = true; events.push('lock'); try { return await action({ signal: controller.signal,
      assertHeld: () => assert.equal(locked, true) }); } finally { locked = false; events.push('unlock'); } },
    readBuild: async () => { assert.equal(locked, true); events.push('verify'); return release; },
    detect: async () => 'existing',
    adapterMissing: async () => false,
    run: async (_command, _args, options) => { assert.ok(options.signal instanceof AbortSignal); assert.equal(options.signal.aborted, false); },
    deploy: async (args, run) => { assert.equal(locked, true); events.push({ deploy: args }); await run('synthetic', []); },
    wizard: async () => assert.fail('existing installation must never prompt for initialization'),
  } };
}

test('source deployment holds workspace lock through full verification and public local coordinator, forwards maintenance options', async () => {
  const { events, dependencies } = deploymentHarness();
  await deployFromLocalBuild(['--router-config', '/private/router.json', '--web-unit', 'cocoproxy-web.service', '--preview'], dependencies);
  assert.deepEqual(events, ['lock', 'verify', 'verify', { deploy: ['--local', '--payload', release.output, '--manifest-sha256', release.manifestSha256,
    '--router-config', '/private/router.json', '--web-unit', 'cocoproxy-web.service', '--preview'] }, 'unlock']);
});

test('missing/failed build aborts before host installation detection and never falls back to residual payload', async () => {
  const { events, dependencies } = deploymentHarness();
  dependencies.readBuild = async () => { throw Object.assign(new Error(), { code: 'LOCAL_BUILD_NOT_READY' }); };
  dependencies.detect = async () => assert.fail('no installation inspection after unverified build');
  await assert.rejects(deployFromLocalBuild([], dependencies), { code: 'LOCAL_BUILD_NOT_READY' });
  assert.deepEqual(events, ['lock', 'unlock']);
});

test('frontend build scope bypasses router wizard and cannot enter first installation', async () => {
  const { events, dependencies } = deploymentHarness();
  dependencies.readBuild = async () => ({ ...release, components: 'frontend' });
  dependencies.adapterMissing = async () => assert.fail('frontend must not require router maintenance');
  await deployFromLocalBuild([], dependencies);
  assert.ok(events.some(event => event.deploy));
  dependencies.detect = async () => 'first';
  await assert.rejects(deployFromLocalBuild([], dependencies), { code: 'LOCAL_FRONTEND_EXISTING_INSTALL_REQUIRED' });
});

test('management updates forward the verified payload and cannot enter first installation', async () => {
  const { events, dependencies } = deploymentHarness();
  dependencies.readBuild = async () => ({ ...release, components: 'management' });
  await deployFromLocalBuild([], dependencies);
  assert.ok(events.some(event => event.deploy));
  dependencies.detect = async () => 'first';
  await assert.rejects(deployFromLocalBuild([], dependencies), { code: 'LOCAL_COMPONENT_EXISTING_INSTALL_REQUIRED' });
});

test('fresh install receives private file arguments; changed build during interactive setup prevents deployment', async () => {
  const { events, dependencies } = deploymentHarness(); let reads = 0;
  dependencies.detect = async () => 'first';
  dependencies.wizard = async ({ deploy }) => deploy({ environment: '/run/synthetic-private/environment.json', administrator: '/run/synthetic-private/admin.json' });
  await deployFromLocalBuild([], dependencies);
  assert.deepEqual(events.find(event => event.deploy).deploy.slice(-4), ['--environment', '/run/synthetic-private/environment.json', '--admin-input', '/run/synthetic-private/admin.json']);
  events.length = 0;
  dependencies.readBuild = async () => ({ ...release, commit: ++reads === 1 ? release.commit : 'c'.repeat(40) });
  await assert.rejects(deployFromLocalBuild([], dependencies), { code: 'LOCAL_BUILD_CHANGED' });
  assert.equal(events.some(event => event.deploy), false);
});

test('explicit first-install inputs work without wizard and existing updates reject reinitialization inputs', async () => {
  const { dependencies } = deploymentHarness();
  const args = ['--environment', '/private/environment.json', '--admin-input', '/private/admin.json'];
  assert.throws(() => parseDeployLocalOptions(args.slice(0, 2)), { code: 'LOCAL_FIRST_INSTALL_INPUT_PAIR_REQUIRED' });
  await assert.rejects(deployFromLocalBuild(args, dependencies), { code: 'LOCAL_EXISTING_INSTALL_INPUT_REJECTED' });
  dependencies.detect = async () => 'first';
  await deployFromLocalBuild(args, dependencies);
});

function installationHost(files = {}) {
  return {
    info: async path => files[path] === undefined ? (path === '/' || ['/etc', '/var', '/var/lib'].includes(path)
      ? { directory: true, uid: 0, mode: 0o755 } : path === '/etc/cocoproxy-install' || path === '/var/lib/cocoproxy-deployment'
        ? { directory: true, uid: 0, mode: 0o700 } : null)
      : { file: true, uid: 0, mode: 0o600, nlink: 1, size: 128, ...files[path].stat },
    resolve: async path => path,
    read: async path => JSON.stringify(files[path].json),
  };
}

test('missing, damaged and partial installation evidence never enters first-install wizard', async () => {
  assert.equal(await detectLocalInstallation(installationHost()), 'first');
  const receipt = '/var/lib/cocoproxy-deployment/receipt.json', input = '/etc/cocoproxy-install/deployment.json';
  for (const files of [
    { [receipt]: { json: { status: 'pending' } } },
    { [receipt]: { json: { status: 'complete' } } },
    { [input]: { json: {} } },
    { '/etc/cocoproxy/runtime.json': { json: {} } },
    { '/etc/cocoproxy-install/remote-last.json': { json: { status: 'failed' } } },
    { [receipt]: { stat: { link: true }, json: { status: 'complete' } }, [input]: { json: {} } },
  ]) await assert.rejects(detectLocalInstallation(installationHost(files)), { code: 'LOCAL_INSTALL_STATE_REQUIRES_REVIEW' });
  assert.equal(await detectLocalInstallation(installationHost({ [receipt]: { json: { status: 'complete' } }, [input]: { json: {} } })), 'existing');
});

test('a later automatic-gateway update guides missing router maintenance adapter and reuses saved references', async () => {
  const receipt = '/var/lib/cocoproxy-deployment/receipt.json', input = '/etc/cocoproxy-install/deployment.json';
  const state = { [receipt]: { json: { status: 'complete', manifestSha256: 'c'.repeat(64) } },
    [input]: { json: { runtime: { automaticGateway: {} } } } };
  assert.equal(await needsUpdateRouterAdapter(release.manifestSha256, installationHost(state)), true);
  assert.equal(await needsUpdateRouterAdapter('c'.repeat(64), installationHost(state)), false);
  assert.equal(await needsUpdateRouterAdapter(release.manifestSha256, installationHost({ ...state,
    '/etc/cocoproxy-install/router-ssh.json': { json: { host: '192.0.2.1' } } })), false);
  const { events, dependencies } = deploymentHarness();
  dependencies.adapterMissing = async () => true;
  dependencies.routerWizard = async ({ deploy }) => deploy('--router-config', '/run/synthetic/router.json');
  await deployFromLocalBuild([], dependencies);
  assert.deepEqual(events.find(event => event.deploy).deploy.slice(-2), ['--router-config', '/run/synthetic/router.json']);
  delete dependencies.routerWizard;
  await assert.rejects(deployFromLocalBuild([], dependencies), { code: 'LOCAL_ROUTER_ADAPTER_REQUIRED' });
  const values = ['2', '192.0.2.1', 'root', '2222', '/root/private/router-key', '/root/private/known-hosts'];
  assert.deepEqual(await collectRouterAdapter({ write: () => {}, prompt: async () => values.shift() }), { flag: '--router-config',
    config: { host: '192.0.2.1', user: 'root', port: 2222, identityFile: '/root/private/router-key', knownHostsFile: '/root/private/known-hosts' } });
});

async function syntheticAnswers() {
  const values = ['lan-test', '192.0.2.2', '192.0.2.1', '02:00:00:00:00:01', '192.0.2.0/24',
    'https://gateway.example:13443', '198.51.100.53', 'https://subscription.example', 'https://probe.example', 'cocoproxy', '2', 'admin'];
  return collectInstallAnswers({ prompt: async () => values.shift(), secret: async () => 'synthetic-private-password', write: () => {} }, '/usr/bin/node');
}

test('wizard validates operator facts, plans fixed packages and never includes admin password in review summary', async () => {
  const answers = await syntheticAnswers();
  const commands = [];
  const plan = await planSystemPreparation(answers, {
    info: async path => path === '/usr/sbin/ip' ? { file: true } : null,
    read: async () => '0\n', run: async (command, args) => { commands.push([command, args]); return 'root:x:0:0:root:/root:/bin/bash\n'; },
  });
  assert.deepEqual(commands, [['/usr/bin/getent', ['passwd']]]);
  assert.equal(plan.packages.includes('iproute2'), false);
  assert.equal(plan.packages.includes('polkitd'), true);
  assert.equal(plan.packages.some(name => /node|curl|npm/.test(name)), false);
  assert.equal(plan.enableForwarding, true);
  assert.equal(plan.createAccount, true);
  const summary = preparationSummary(answers, plan);
  assert.equal(summary.includes(answers.administrator.password), false);
  assert.match(summary, /自签名/);
  await assert.rejects(planSystemPreparation(answers, {
    info: async () => null, read: async () => '0', run: async () => 'cocoproxy:x:12345:12345::/home/cocoproxy:/bin/bash\n',
  }), { code: 'LOCAL_SERVICE_ACCOUNT_CONFLICT' });
});

test('hidden password input never echoes bytes and restores TTY mode on completion or Ctrl-C', async () => {
  const input = new PassThrough(), output = new PassThrough();
  input.isTTY = output.isTTY = true; input.isRaw = false;
  input.setRawMode = mode => { input.isRaw = mode; };
  let displayed = ''; output.on('data', chunk => { displayed += chunk; });
  const terminal = createTerminal(input, output);
  const secret = terminal.secret('Password');
  input.write('synthetic-password\r');
  assert.equal(await secret, 'synthetic-password');
  assert.equal(displayed.includes('synthetic-password'), false);
  assert.equal(input.isRaw, false);
  const cancelled = terminal.secret('Again'); input.write('\u0003');
  await assert.rejects(cancelled, { code: 'LOCAL_INSTALL_CANCELLED' });
  assert.equal(input.isRaw, false);
  assert.throws(() => createTerminal(new PassThrough(), output), { code: 'LOCAL_FIRST_INSTALL_TTY_OR_INPUTS_REQUIRED' });
});

test('private wizard inputs are exclusive files and retain only required JSON', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cocoproxy-local-input-test-'));
  try {
    const path = join(directory, 'admin.json');
    await writePrivateInput(path, { username: 'synthetic', password: 'synthetic-password' });
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { username: 'synthetic', password: 'synthetic-password' });
    if (process.platform !== 'win32') assert.equal((await lstat(path)).mode & 0o777, 0o600);
    await assert.rejects(writePrivateInput(path, {}), { code: 'EEXIST' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('fresh clone deployment entry loads without source node_modules or setup dependency graph', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cocoproxy-local-clean-clone-'));
  try {
    for (const path of ['scripts/deploy-local.mjs', 'scripts/local-install.mjs', 'scripts/deploy-ssh.mjs',
      'scripts/local-release-state.mjs', 'scripts/build-release.mjs', 'packages/deployment/update-scope.mjs', 'packages/deployment/service-account.ts', 'packages/deployment/path-evidence.ts']) {
      const target = join(directory, path);
      await mkdir(dirname(target), { recursive: true });
      await cp(resolve(path), target);
    }
    const { stdout, stderr } = await promisify(execFile)(process.execPath, ['--experimental-strip-types', join(directory, 'scripts/deploy-local.mjs'), '--help'], { windowsHide: true });
    assert.match(stdout, /源码本机部署/);
    assert.equal(stderr.includes('ERR_MODULE_NOT_FOUND'), false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
