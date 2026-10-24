import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chown, chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderRuntimePlan } from '../packages/runtime/plan.ts';
import { RuntimeError } from '../packages/runtime/types.ts';
import { compileConfig } from '../packages/config/index.ts';
import { FileTransactionStore } from '../packages/transaction/index.ts';
import type { Candidate } from '../packages/config/index.ts';
import type { RuntimeSettings } from '../packages/runtime/types.ts';

function planInput() {
  return { schemaVersion: 1, stateDirectory: '/var/lib/coproxy', binaryPath: '/opt/coproxy/bin/mihomo',
    binarySha256: 'a'.repeat(64), systemctlPath: '/usr/bin/systemctl', nodePath: '/usr/bin/node',
    sourceDirectory: '/opt/coproxy/source', settingsPath: '/etc/coproxy/runtime.json',
    unitPath: '/etc/systemd/system/coproxy-mihomo.service', serviceUid: 12345 };
}

test('runtime plan pins the entire deterministic service text and selected executable identity', () => {
  const input = planInput();
  const rendered = renderRuntimePlan(input);
  assert.deepEqual(renderRuntimePlan({ ...input }), rendered);
  assert.equal(rendered.settings.unitSha256, createHash('sha256').update(rendered.unit, 'utf8').digest('hex'));
  assert.equal(rendered.settings.binarySha256, input.binarySha256);
  assert.equal(rendered.settings.serviceUid, input.serviceUid);
  assert.match(rendered.unit, /^User=12345$/m);
  assert.match(rendered.unit, /^ExecStart="\/usr\/bin\/node" "--experimental-strip-types" "\/opt\/coproxy\/source\/apps\/runtime\/launch-core.ts" "--settings" "\/etc\/coproxy\/runtime.json"$/m);
  assert.match(rendered.unit, /^ProtectSystem=strict$/m);
  assert.match(rendered.unit, /^ProtectHome=true$/m);
  assert.match(rendered.unit, /^ReadWritePaths="\/var\/lib\/coproxy"$/m);
  assert.match(rendered.unit, /^WantedBy=multi-user.target\n$/m);
  assert.doesNotMatch(rendered.unit, /ExecReload|CAP_NET_ADMIN|AmbientCapabilities/);
  const changed = renderRuntimePlan({ ...input, serviceUid: input.serviceUid + 1 });
  assert.notEqual(changed.settings.unitSha256, rendered.settings.unitSha256);
});

test('runtime plan escapes systemd words, specifiers and command environment expansion', () => {
  const rendered = renderRuntimePlan({ ...planInput(),
    sourceDirectory: '/opt/source with "quotes"\\and%spec',
    settingsPath: '/etc/config $HOME ${TOKEN}%i.json',
    stateDirectory: '/var/lib/private "state"\\%i',
  });
  const exec = rendered.unit.split('\n').find(line => line.startsWith('ExecStart='))!;
  assert.ok(exec.includes('"/opt/source with \\"quotes\\"\\\\and%%spec/apps/runtime/launch-core.ts"'));
  assert.ok(exec.endsWith('"/etc/config $$HOME $${TOKEN}%%i.json"'));
  assert.ok(rendered.unit.includes('ReadWritePaths="/var/lib/private \\"state\\"\\\\%%i"\n'));
  assert.equal(rendered.unit.split('\n').filter(line => line.startsWith('ExecStart=')).length, 1);
});

test('runtime plan rejects root, hidden deployment paths and injected or non-data input', () => {
  let getterCalled = false;
  const getter = { ...planInput() };
  Object.defineProperty(getter, 'nodePath', { enumerable: true, get() { getterCalled = true; return '/usr/bin/node'; } });
  const inputs: unknown[] = [null, [], 'plan', {}, { ...planInput(), serviceUid: 0 },
    { ...planInput(), serviceUid: -1 }, { ...planInput(), serviceUid: 1.5 },
    { ...planInput(), serviceUid: 4_294_967_295 }, { ...planInput(), binarySha256: 'A'.repeat(64) },
    { ...planInput(), extra: true }, { ...planInput(), schemaVersion: 2 },
    { ...planInput(), unitPath: '/etc/systemd/system/other.service' }, getter];
  for (const key of ['stateDirectory', 'binaryPath', 'nodePath', 'sourceDirectory', 'settingsPath']) {
    for (const value of ['/home/user/file', '/root/file', '/run/user/1000/file', 'relative', '/opt/../file', '/opt//file', '/']) {
      inputs.push({ ...planInput(), [key]: value });
    }
  }
  for (const key of ['stateDirectory', 'binaryPath', 'systemctlPath', 'nodePath', 'sourceDirectory', 'settingsPath', 'unitPath']) {
    for (const control of ['\n', '\r', '\0', '\t', '\u007f']) inputs.push({ ...planInput(), [key]: '/opt/' + control + 'injected' });
  }
  for (const input of inputs) assert.throws(() => renderRuntimePlan(input), (error: unknown) => {
    assert.ok(error instanceof RuntimeError);
    assert.equal(error.code, 'RUNTIME_PLAN_INVALID');
    return true;
  });
  assert.equal(getterCalled, false);
  // Prefix matching must preserve ordinary installation directory names.
  assert.doesNotThrow(() => renderRuntimePlan({ ...planInput(), sourceDirectory: '/homebrew/coproxy' }));
});

const linuxExec = process.platform === 'linux' && typeof process.execve === 'function';
const launcher = fileURLToPath(new URL('../apps/runtime/launch-core.ts', import.meta.url));
const secret = 'SYNTHETIC_LAUNCHER_PRIVATE_SECRET';

function candidate(): Candidate {
  return compileConfig({ schemaVersion: 1, deployment: {
    mixedPort: 17890, controllerPort: 19090, controllerSecret: secret,
    dnsPort: 15353, bootstrapResolvers: ['192.0.2.53'],
  }, policy: { rules: ['MATCH,DIRECT'] } });
}

async function fixture(t: test.TestContext, variant: 'good' | 'missing' | 'hash' | 'tun' | 'fault' | 'recovering' = 'good') {
  const root = await mkdtemp(join(tmpdir(), 'coproxy-launcher-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateDirectory = join(root, 'state');
  const binaryPath = join(root, 'fixture-core');
  const output = join(root, 'exec-result.json');
  const settingsPath = join(root, 'runtime.json');
  const uid = process.geteuid!() === 0 ? 65534 : process.geteuid!();
  const script = `#!${process.execPath}\n` +
    `require('node:fs').writeFileSync(${JSON.stringify(output)}, JSON.stringify({pid:process.pid,args:process.argv.slice(2),inherited:process.env.COPROXY_FIXTURE_OUTPUT}), {mode:0o600});\n`;
  await writeFile(binaryPath, script, { mode: 0o700 });
  const settings: RuntimeSettings = { schemaVersion: 1, stateDirectory, binaryPath,
    binarySha256: variant === 'hash' ? '0'.repeat(64) : createHash('sha256').update(script).digest('hex'),
    systemctlPath: '/usr/bin/systemctl', unitPath: '/etc/systemd/system/coproxy-mihomo.service',
    unitSha256: 'a'.repeat(64), serviceUid: uid };
  let target = candidate();
  if (variant === 'tun') {
    const config = { ...target.config, tun: { enable: true } };
    // This fixture has a correct digest but intentionally bypasses the compiler.
    const { canonicalJson } = await import('../packages/config/index.ts');
    const sha256 = createHash('sha256').update(canonicalJson(config)).digest('hex');
    target = { id: sha256, sha256, config };
  }
  const staged = await new FileTransactionStore(stateDirectory).stage(target);
  const statePath = join(stateDirectory, 'state.json');
  if (variant === 'fault' || variant === 'recovering') await writeFile(statePath, JSON.stringify({ version: 1, desired: 'b'.repeat(64), active: null,
    pending: { id: '00000000-0000-4000-8000-000000000001', previous: target.id, target: 'b'.repeat(64), phase: variant === 'fault' ? 'fault' : 'restoring' },
    fault: 'RESTORE_FAILED', checkedAt: new Date().toISOString() }), { mode: 0o600 });
  const selectionPath = join(stateDirectory, 'selection.json');
  if (variant !== 'missing') await writeFile(selectionPath, JSON.stringify({ schemaVersion: 1, generation: target.id }), { mode: 0o600 });
  await writeFile(settingsPath, JSON.stringify(settings), { mode: 0o600 });
  if (process.geteuid!() === 0) {
    // Only disposable fixture files change ownership; the child proves non-root execution.
    const paths = [root, stateDirectory, join(stateDirectory, 'candidates'), staged.path, binaryPath, settingsPath];
    if (variant !== 'missing') paths.push(selectionPath);
    if (variant === 'fault' || variant === 'recovering') paths.push(statePath);
    for (const path of paths) await chown(path, uid, uid);
  }
  await chmod(root, 0o700);
  return { root, settings, settingsPath, output, staged, uid };
}

async function launch(f: Awaited<ReturnType<typeof fixture>>) {
  const child = spawn(process.execPath, ['--experimental-strip-types', launcher, '--settings', f.settingsPath], {
    env: { ...process.env, COPROXY_FIXTURE_OUTPUT: f.output },
    ...(process.geteuid!() === 0 ? { uid: f.uid, gid: f.uid } : {}),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
  const exit = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  }).finally(() => clearTimeout(timer));
  assert.ok(!stdout.includes(secret) && !stderr.includes(secret));
  return { pid: child.pid, exit, stdout, stderr };
}

test('launcher exec replaces its child PID and passes only pinned core arguments', { skip: !linuxExec }, async t => {
  for (const variant of ['good', 'recovering'] as const) {
    const f = await fixture(t, variant);
    const result = await launch(f);
    assert.equal(result.exit, 0, result.stderr);
    assert.equal(result.stdout, '');
    const record = JSON.parse(await readFile(f.output, 'utf8'));
    assert.equal(record.pid, result.pid);
    assert.equal(record.inherited, undefined);
    assert.deepEqual(record.args, ['-d', join(f.settings.stateDirectory, 'core-home'), '-f', f.staged.path]);
  }
});

test('launcher refuses missing selection, hash mismatch, enabled TUN and persistent fault before exec', { skip: !linuxExec }, async t => {
  for (const [variant, code] of [['missing', 'RUNTIME_SELECTION_MISSING'], ['hash', 'BINARY_UNTRUSTED'], ['tun', 'CANDIDATE_UNTRUSTED'], ['fault', 'RUNTIME_RECOVERY_REQUIRED']] as const) {
    const f = await fixture(t, variant);
    const result = await launch(f);
    assert.equal(result.exit, 1);
    assert.equal(result.stdout, '');
    assert.ok(result.stderr.includes(JSON.stringify({ error: { code } })), result.stderr);
    assert.ok(!result.stderr.includes(f.root));
    await assert.rejects(readFile(f.output), { code: 'ENOENT' });
  }
});
