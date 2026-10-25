import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chown, chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderRuntimePlan } from '../packages/runtime/plan.ts';
import { assertRuntimeLaunch } from '../packages/runtime/launch-authorization.ts';
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

test('launch authorization binds stable state and every in-flight start to its live transaction', async () => {
  const previous = 'a'.repeat(64), target = 'b'.repeat(64), ownerToken = '00000000-0000-4000-8000-000000000001';
  const state: Awaited<ReturnType<FileTransactionStore['readState']>> = {
    version: 1, desired: target, active: previous, fault: null, checkedAt: null, pending: null,
  };
  let live = false;
  const reader = { readState: async () => structuredClone(state),
    hasLiveLockOwner: async (token: string | undefined) => live && token === ownerToken };
  const denied = { code: 'RUNTIME_RECOVERY_REQUIRED' };
  await assertRuntimeLaunch(reader, previous);
  await assert.rejects(assertRuntimeLaunch(reader, target), denied);
  for (const phase of ['activating', 'confirming', 'restoring', 'recovering-target'] as const) {
    state.active = phase === 'recovering-target' ? null : previous;
    state.fault = phase === 'recovering-target' ? 'RESTORE_FAILED' : null;
    state.pending = { id: ownerToken, previous, target, phase, ownerToken };
    const generation = phase === 'restoring' ? previous : target;
    const other = phase === 'restoring' ? target : previous;
    live = false;
    await assert.rejects(assertRuntimeLaunch(reader, generation), denied);
    live = true;
    await assertRuntimeLaunch(reader, generation);
    await assert.rejects(assertRuntimeLaunch(reader, other), denied);
    // Missing legacy bindings and unrelated current locks cannot authorize a start.
    delete state.pending.ownerToken;
    await assert.rejects(assertRuntimeLaunch(reader, generation), denied);
    state.pending.ownerToken = '00000000-0000-4000-8000-000000000002';
    await assert.rejects(assertRuntimeLaunch(reader, generation), denied);
  }
  for (const phase of ['validating', 'fault'] as const) {
    state.active = phase === 'fault' ? null : previous;
    state.fault = phase === 'fault' ? 'RESTORE_FAILED' : null;
    state.pending = { id: ownerToken, previous, target, phase, ownerToken };
    await assert.rejects(assertRuntimeLaunch(reader, target), denied);
    await assert.rejects(assertRuntimeLaunch(reader, previous), denied);
  }
  // The durable commit point survives writer exit, including pending cleanup crashes.
  state.active = target;
  state.fault = null;
  state.pending = { id: ownerToken, previous, target, phase: 'committed', ownerToken };
  live = false;
  await assertRuntimeLaunch(reader, target);
  await assert.rejects(assertRuntimeLaunch(reader, previous), denied);
  state.active = previous;
  state.pending = { id: ownerToken, previous, target, phase: 'restoring', ownerToken };
  live = true;
  const racing = { ...reader, hasLiveLockOwner: async () => { state.pending!.phase = 'fault'; return true; } };
  await assert.rejects(assertRuntimeLaunch(racing, previous), denied);
  state.pending = { id: ownerToken, previous, target, phase: 'activating', ownerToken };
  const advancing = { ...reader, hasLiveLockOwner: async () => { state.pending!.phase = 'confirming'; return true; } };
  await assertRuntimeLaunch(advancing, target);
});

function candidate(): Candidate {
  return compileConfig({ schemaVersion: 1, deployment: {
    mixedPort: 17890, controllerPort: 19090, controllerSecret: secret,
    dnsPort: 15353, bootstrapResolvers: ['192.0.2.53'],
  }, policy: { rules: ['MATCH,DIRECT'] } });
}

async function fixture(t: test.TestContext, variant: 'good' | 'missing' | 'hash' | 'tun' | 'fault' | 'recovering' |
  'recovering-target' | 'wrong-target' | 'applying' | 'confirming' | 'abandoned-restore' | 'abandoned-confirm' | 'wrong-active' = 'good') {
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
  const forward = variant === 'recovering-target' || variant === 'wrong-target';
  if (variant === 'fault' || variant === 'recovering' || forward) await writeFile(statePath, JSON.stringify({ version: 1, desired: variant === 'recovering-target' ? target.id : 'b'.repeat(64), active: null,
    pending: { id: '00000000-0000-4000-8000-000000000001', previous: forward ? 'c'.repeat(64) : target.id, target: variant === 'recovering-target' ? target.id : 'b'.repeat(64), phase: forward ? 'recovering-target' : variant === 'fault' ? 'fault' : 'restoring' },
    fault: 'RESTORE_FAILED', checkedAt: new Date().toISOString() }), { mode: 0o600 });
  else if (['applying', 'confirming', 'abandoned-restore', 'abandoned-confirm'].includes(variant)) {
    const previous = variant.startsWith('abandoned-') ? 'c'.repeat(64) : null;
    await writeFile(statePath, JSON.stringify({ version: 1, desired: target.id, active: previous,
      pending: { id: '00000000-0000-4000-8000-000000000001', previous, target: target.id,
        phase: variant === 'abandoned-restore' ? 'restoring' : variant === 'applying' ? 'activating' : 'confirming',
        ownerToken: '00000000-0000-4000-8000-000000000002' },
      fault: null, checkedAt: null }), { mode: 0o600 });
  } else await writeFile(statePath, JSON.stringify({ version: 1, desired: target.id,
    active: variant === 'wrong-active' ? 'c'.repeat(64) : target.id,
    pending: null, fault: null, checkedAt: null }), { mode: 0o600 });
  const selectionPath = join(stateDirectory, 'selection.json');
  if (variant !== 'missing') await writeFile(selectionPath, JSON.stringify({ schemaVersion: 1, generation: target.id }), { mode: 0o600 });
  await writeFile(settingsPath, JSON.stringify(settings), { mode: 0o600 });
  if (process.geteuid!() === 0) {
    // Only disposable fixture files change ownership; the child proves non-root execution.
    const paths = [root, stateDirectory, join(stateDirectory, 'candidates'), staged.path, binaryPath, settingsPath];
    if (variant !== 'missing') paths.push(selectionPath);
    paths.push(statePath);
    for (const path of paths) await chown(path, uid, uid);
  }
  await chmod(root, 0o700);
  return { root, settings, settingsPath, output, staged, uid };
}

async function launch(f: Awaited<ReturnType<typeof fixture>>, holdTransaction = false) {
  // This child owns the private store under the service UID, including when the
  // test runner is root. execve preserves the lock holder's PID in this fixture.
  const script = `import {FileTransactionStore} from ${JSON.stringify(new URL('../packages/transaction/index.ts', import.meta.url).href)};
    import {runCore} from ${JSON.stringify(new URL('../apps/runtime/launch-core.ts', import.meta.url).href)};
    const store = new FileTransactionStore(${JSON.stringify(f.settings.stateDirectory)});
    await store.exclusive(async ownerToken => {
      const state = await store.readState(); state.pending.ownerToken = ownerToken;
      await store.writeState(state); await runCore(${JSON.stringify(f.settingsPath)});
    });`;
  const args = holdTransaction ? ['--experimental-strip-types', '--input-type=module', '--eval', script] :
    ['--experimental-strip-types', launcher, '--settings', f.settingsPath];
  const child = spawn(process.execPath, args, {
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
  for (const variant of ['good', 'applying', 'confirming', 'recovering', 'recovering-target'] as const) {
    const f = await fixture(t, variant);
    const result = await launch(f, variant !== 'good');
    assert.equal(result.exit, 0, result.stderr);
    assert.equal(result.stdout, '');
    const record = JSON.parse(await readFile(f.output, 'utf8'));
    assert.equal(record.pid, result.pid);
    assert.equal(record.inherited, undefined);
    assert.deepEqual(record.args, ['-d', join(f.settings.stateDirectory, 'core-home'), '-f', f.staged.path]);
  }
});

test('launcher refuses missing selection, hash mismatch, enabled TUN and persistent fault before exec', { skip: !linuxExec }, async t => {
  for (const [variant, code] of [['missing', 'RUNTIME_SELECTION_MISSING'], ['hash', 'BINARY_UNTRUSTED'], ['tun', 'CANDIDATE_UNTRUSTED'], ['fault', 'RUNTIME_RECOVERY_REQUIRED'], ['wrong-target', 'RUNTIME_RECOVERY_REQUIRED'], ['recovering', 'RUNTIME_RECOVERY_REQUIRED'], ['recovering-target', 'RUNTIME_RECOVERY_REQUIRED'], ['abandoned-restore', 'RUNTIME_RECOVERY_REQUIRED'], ['abandoned-confirm', 'RUNTIME_RECOVERY_REQUIRED'], ['wrong-active', 'RUNTIME_RECOVERY_REQUIRED']] as const) {
    const f = await fixture(t, variant);
    const result = await launch(f);
    assert.equal(result.exit, 1);
    assert.equal(result.stdout, '');
    assert.ok(result.stderr.includes(JSON.stringify({ error: { code } })), result.stderr);
    assert.ok(!result.stderr.includes(f.root));
    await assert.rejects(readFile(f.output), { code: 'ENOENT' });
  }
});
