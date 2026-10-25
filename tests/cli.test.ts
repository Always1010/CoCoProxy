import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const executable = join(root, 'apps/cli/main.ts');
const syntheticSecret = 'synthetic-cli-sensitive-value';
const input = {
  schemaVersion: 1,
  deployment: {
    mixedPort: 17890, controllerPort: 19090, dnsPort: 15353,
    controllerSecret: syntheticSecret, bootstrapResolvers: ['192.0.2.53'],
  },
  policy: { rules: ['MATCH,DIRECT'], proxies: [], 'proxy-groups': [] },
};

function cli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, ['--experimental-strip-types', executable, ...args], {
      cwd: root, timeout: 15_000, maxBuffer: 65_536, windowsHide: true,
    }, (error, stdout, stderr) => {
      if (error && typeof error.code !== 'number') return reject(error);
      resolve({ code: typeof error?.code === 'number' ? error.code : 0, stdout, stderr });
    });
  });
}

async function fixture(run: (dir: string, file: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'cocoproxy-cli-test-'));
  try {
    const file = join(dir, 'input.json');
    await writeFile(file, JSON.stringify(input), { mode: 0o600 });
    await run(dir, file);
  } finally { await rm(dir, { recursive: true, force: true }); }
}

test('compile writes private output and never prints credentials or overwrites', async () => {
  await fixture(async (dir, file) => {
    const output = join(dir, 'config.json');
    const result = await cli(['compile', '--input', file, '--output', output]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).runtime, 'not_started');
    assert.ok(!result.stdout.includes(syntheticSecret));
    assert.equal(JSON.parse(await readFile(output, 'utf8')).secret, syntheticSecret);
    assert.equal((await stat(output)).mode & 0o777, 0o600);
    const second = await cli(['compile', '--input', file, '--output', output]);
    assert.equal(second.code, 1);
    assert.equal(JSON.parse(second.stderr).error.code, 'OUTPUT_EXISTS');
  });
});

test('deployment plan reads a private input and saves sensitive proposals without installing or printing them', async () => {
  await fixture(async (dir) => {
    const definition = JSON.parse(await readFile(join(root, 'examples/deployment-plan.json'), 'utf8'));
    definition.management.deployment.controllerSecret = syntheticSecret;
    const file = join(dir, 'deployment.json');
    await writeFile(file, JSON.stringify(definition), { mode: 0o600 });
    const output = join(dir, 'plan.json');
    const result = await cli(['deployment-plan', '--input', file, '--output', output]);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { planned: true, fileCount: 5, scope: 'explicit_proxy_deployment', runtime: 'not_started' });
    assert.ok(!result.stdout.includes(syntheticSecret));
    const plan = JSON.parse(await readFile(output, 'utf8'));
    assert.equal(plan.sensitive, true);
    assert.equal(plan.files.length, 5);
    assert.ok(plan.files.some((item: { content: string }) => item.content.includes(syntheticSecret)));
    if (process.platform !== 'win32') assert.equal((await stat(output)).mode & 0o777, 0o600);
    const duplicate = await cli(['deployment-plan', '--input', file, '--output', output]);
    assert.equal(JSON.parse(duplicate.stderr).error.code, 'OUTPUT_EXISTS');
    definition.management.password = syntheticSecret;
    await writeFile(file, JSON.stringify(definition));
    const invalid = await cli(['deployment-plan', '--input', file, '--output', join(dir, 'invalid.json')]);
    assert.equal(JSON.parse(invalid.stderr).error.code, 'DEPLOYMENT_PLAN_INVALID');
    assert.ok(!invalid.stderr.includes(syntheticSecret));
  });
});

test('stage and status do not imply a running service', async () => {
  await fixture(async (dir, file) => {
    const state = join(dir, 'state');
    const staged = await cli(['stage', '--input', file, '--state-dir', state]);
    assert.equal(staged.code, 0, staged.stderr);
    assert.equal(JSON.parse(staged.stdout).runtime, 'not_started');
    const result = await cli(['status', '--state-dir', state]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).active, null);
    assert.equal(JSON.parse(result.stdout).readiness, 'unknown');
    assert.ok(!result.stdout.includes(syntheticSecret));
  });
});

test('invalid JSON and argument errors are bounded and redact input', async () => {
  await fixture(async (dir) => {
    const file = join(dir, 'broken.json');
    await writeFile(file, '{"secret":"' + syntheticSecret);
    const result = await cli(['compile', '--input', file, '--output', join(dir, 'config.json')]);
    assert.equal(result.code, 1);
    assert.equal(JSON.parse(result.stderr).error.code, 'INVALID_JSON');
    assert.ok(!result.stderr.includes(syntheticSecret));
    const relative = await cli(['status', '--state-dir', 'runtime']);
    assert.equal(JSON.parse(relative.stderr).error.code, 'ABSOLUTE_PATH_REQUIRED');
    const duplicate = await cli(['status', '--state-dir', dir, '--state-dir', dir]);
    assert.equal(JSON.parse(duplicate.stderr).error.code, 'INVALID_ARGUMENTS');
  });
});

test('oversized input is rejected before compiling', async () => {
  await fixture(async (dir, file) => {
    await writeFile(file, ' '.repeat(1_048_577));
    const result = await cli(['compile', '--input', file, '--output', join(dir, 'config.json')]);
    assert.equal(JSON.parse(result.stderr).error.code, 'INVALID_INPUT_SIZE');
  });
});

test('invalid UTF-8 cannot silently alter a credential', async () => {
  await fixture(async (dir, file) => {
    const parts = JSON.stringify(input).split(syntheticSecret);
    await writeFile(file, Buffer.concat([Buffer.from(parts[0]), Buffer.from([0xff]), Buffer.from(parts[1])]));
    const result = await cli(['compile', '--input', file, '--output', join(dir, 'config.json')]);
    assert.equal(result.code, 1);
    assert.equal(JSON.parse(result.stderr).error.code, 'INVALID_JSON');
  });
});

test('validation cannot silently substitute a mock or download a missing core', async () => {
  await fixture(async (dir, file) => {
    const result = await cli(['validate', '--input', file, '--mihomo-bin', join(dir, 'missing')]);
    assert.equal(result.code, 1);
    assert.equal(JSON.parse(result.stderr).error.code, 'BINARY_UNAVAILABLE');
    assert.equal(result.stdout, '');
  });
});

test('draft CLI separates revisioned saving, capture and runtime application', async () => {
  await fixture(async (dir, file) => {
    const state = join(dir, 'draft-store');
    assert.deepEqual(JSON.parse((await cli(['draft-status', '--state-dir', state])).stdout), { draft: null });
    await assert.rejects(stat(state), { code: 'ENOENT' });
    const saved = await cli(['draft-save', '--input', file, '--state-dir', state, '--expected-revision', '0']);
    assert.equal(saved.code, 0, saved.stderr);
    assert.equal(JSON.parse(saved.stdout).revision, 1);
    assert.ok(!saved.stdout.includes(syntheticSecret));
    const conflict = await cli(['draft-save', '--input', file, '--state-dir', state, '--expected-revision', '0']);
    assert.equal(JSON.parse(conflict.stderr).error.code, 'DRAFT_CONFLICT');
    const staged = await cli(['draft-stage', '--state-dir', state, '--expected-revision', '1']);
    assert.equal(staged.code, 0, staged.stderr);
    assert.equal(JSON.parse(staged.stdout).stagedRevision, 1);
    assert.equal(JSON.parse(staged.stdout).generation, JSON.parse(saved.stdout).generation);
    assert.equal(JSON.parse((await cli(['status', '--state-dir', state])).stdout).active, null);
    const metadata = await cli(['draft-status', '--state-dir', state]);
    assert.ok(!metadata.stdout.includes(syntheticSecret));
    const invalid = await cli(['draft-stage', '--state-dir', state, '--expected-revision', '1e0']);
    assert.equal(JSON.parse(invalid.stderr).error.code, 'INVALID_REVISION');
  });
});

test('source CLI keeps URL credentials out of arguments and public metadata', async () => {
  await fixture(async (dir) => {
    const state = join(dir, 'source-store');
    const file = join(dir, 'source.json');
    await writeFile(file, JSON.stringify({ id: 'primary', url: 'https://subscription.example/nodes?token=' + syntheticSecret }), { mode: 0o600 });
    const result = await cli(['source-configure', '--input', file, '--state-dir', state, '--expected-revision', '0']);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).revision, 1);
    assert.ok(!result.stdout.includes(syntheticSecret));
    const status = await cli(['source-status', '--source-id', 'primary', '--state-dir', state]);
    assert.equal(status.code, 0, status.stderr);
    assert.ok(!status.stdout.includes(syntheticSecret));
    const conflict = await cli(['source-configure', '--input', file, '--state-dir', state, '--expected-revision', '0']);
    assert.equal(JSON.parse(conflict.stderr).error.code, 'SOURCE_CONFLICT');
    const pending = await cli(['source-stage', '--source-id', 'primary', '--input', file, '--state-dir', state, '--expected-revision', '1']);
    assert.equal(JSON.parse(pending.stderr).error.code, 'SOURCE_PENDING');
    const policy = join(dir, 'policy.json');
    await writeFile(policy, JSON.stringify({ allowedOrigins: [], rejectUnauthorized: false }));
    const denied = await cli(['source-refresh', '--source-id', 'primary', '--state-dir', state, '--expected-revision', '1', '--policy', policy]);
    assert.equal(JSON.parse(denied.stderr).error.code, 'INVALID_HTTPS_POLICY');
    assert.equal(JSON.parse((await cli(['source-status', '--source-id', 'primary', '--state-dir', state])).stdout).source.revision, 1);
  });
});

test('runtime CLI produces a private review plan and refuses mismatched state before service control', async () => {
  await fixture(async (dir) => {
    const file = join(dir, 'deployment.json');
    const output = join(dir, 'plan.json');
    await writeFile(file, JSON.stringify({ schemaVersion: 1, stateDirectory: '/var/lib/cocoproxy',
      binaryPath: '/opt/cocoproxy/bin/mihomo', binarySha256: 'a'.repeat(64), systemctlPath: '/usr/bin/systemctl',
      nodePath: '/usr/bin/node', sourceDirectory: '/opt/cocoproxy/source', settingsPath: '/etc/cocoproxy/runtime.json',
      unitPath: '/etc/systemd/system/cocoproxy-mihomo.service', serviceUid: 12345 }), { mode: 0o600 });
    const result = await cli(['runtime-plan', '--input', file, '--output', output]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).runtime, 'not_started');
    const plan = JSON.parse(await readFile(output, 'utf8'));
    assert.match(plan.unit, /^KillMode=control-group$/m);
    assert.equal((await stat(output)).mode & 0o777, 0o600);
    const settings = join(dir, 'settings.json');
    await writeFile(settings, JSON.stringify(plan.settings), { mode: 0o600 });
    const mismatched = await cli(['runtime-apply', '--state-dir', join(dir, 'unused-state'), '--runtime-settings', settings,
      '--generation', 'b'.repeat(64), '--expected-active', 'none']);
    assert.equal(JSON.parse(mismatched.stderr).error.code, 'RUNTIME_STATE_MISMATCH');
    await assert.rejects(stat(join(dir, 'unused-state')), { code: 'ENOENT' });
    plan.settings.stateDirectory = join(dir, 'absent-state');
    await writeFile(settings, JSON.stringify(plan.settings));
    const status = await cli(['runtime-status', '--state-dir', plan.settings.stateDirectory, '--runtime-settings', settings]);
    assert.equal(status.code, 0, status.stderr);
    assert.equal(JSON.parse(status.stdout).core, null);
    assert.equal(JSON.parse(status.stdout).scope, 'core_only');
    await assert.rejects(stat(plan.settings.stateDirectory), { code: 'ENOENT' });
    const lifecycleArgs = ['--state-dir', plan.settings.stateDirectory, '--runtime-settings', settings];
    const lifecycle = await cli(['runtime-lifecycle-status', ...lifecycleArgs]);
    assert.equal(lifecycle.code, 0, lifecycle.stderr);
    assert.deepEqual(JSON.parse(lifecycle.stdout).lifecycle, { schemaVersion: 1, enabled: false, paused: false });
    await assert.rejects(stat(plan.settings.stateDirectory), { code: 'ENOENT' });
    const premature = await cli(['runtime-enable', ...lifecycleArgs]);
    assert.equal(JSON.parse(premature.stderr).error.code, 'RUNTIME_RECOVERY_REQUIRED');
    const invalid = await cli(['runtime-apply', '--state-dir', plan.settings.stateDirectory, '--runtime-settings', settings,
      '--generation', 'invalid', '--expected-active', 'none']);
    assert.equal(JSON.parse(invalid.stderr).error.code, 'INVALID_GENERATION');
    await assert.rejects(stat(plan.settings.stateDirectory), { code: 'ENOENT' });
    const paused = await cli(['runtime-pause', ...lifecycleArgs]);
    assert.equal(paused.code, 0, paused.stderr);
    assert.deepEqual(JSON.parse(paused.stdout).lifecycle, { schemaVersion: 1, enabled: false, paused: true });
    assert.equal(JSON.parse(paused.stdout).servicesChanged, false);
    const resume = await cli(['runtime-resume', ...lifecycleArgs]);
    assert.equal(JSON.parse(resume.stderr).error.code, 'RUNTIME_LIFECYCLE_NOT_ENABLED');
    const disabled = await cli(['runtime-disable', ...lifecycleArgs]);
    assert.equal(disabled.code, 0, disabled.stderr);
    assert.equal(JSON.parse(disabled.stdout).routerChanged, false);
  });
});

test('admin initialization reads private input, writes only a salted credential and never overwrites it', async () => {
  await fixture(async (dir) => {
    const file = join(dir, 'login.json');
    const output = join(dir, 'admin.json');
    await writeFile(file, JSON.stringify({ username: 'synthetic-admin', password: syntheticSecret }), { mode: 0o600 });
    const result = await cli(['admin-init', '--input', file, '--output', output]);
    assert.equal(result.code, 0, result.stderr);
    assert.ok(!result.stdout.includes(syntheticSecret));
    const credential = await readFile(output, 'utf8');
    assert.ok(!credential.includes(syntheticSecret));
    assert.equal(JSON.parse(credential).algorithm, 'scrypt-v1');
    assert.equal((await stat(output)).mode & 0o777, 0o600);
    const duplicate = await cli(['admin-init', '--input', file, '--output', output]);
    assert.equal(JSON.parse(duplicate.stderr).error.code, 'OUTPUT_EXISTS');
    assert.equal(await readFile(output, 'utf8'), credential);
  });
});
