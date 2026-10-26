import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createReadStream } from 'node:fs';
import { chmod, lstat, mkdtemp, realpath, rename, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { canonicalJson, compileConfig } from '../packages/config/index.ts';
import type { Candidate } from '../packages/config/index.ts';
import { assertManagedUnit, observeCore } from '../packages/runtime/observer.ts';
import { loadRuntimeCandidate, loadRuntimeCandidateReadonly, loadRuntimeSettings, parseRuntimeSettings, readSelection, verifyBinary } from '../packages/runtime/settings.ts';
import { RuntimeError } from '../packages/runtime/types.ts';
import type { RuntimeSettings, RuntimeUnitState } from '../packages/runtime/types.ts';
import { FileTransactionStore } from '../packages/transaction/index.ts';

const secret = 'synthetic-runtime-sensitive-value';
const linux = process.platform === 'linux';
const liveSkip = !linux || process.geteuid!() === 0;
const base = (): RuntimeSettings => ({ schemaVersion: 1, stateDirectory: '/var/lib/cocoproxy',
  binaryPath: '/opt/cocoproxy/mihomo', binarySha256: 'a'.repeat(64), systemctlPath: '/usr/bin/systemctl',
  unitPath: '/etc/systemd/system/cocoproxy-mihomo.service', unitSha256: 'b'.repeat(64), serviceUid: 1001 });
const unit = (pid: number): RuntimeUnitState => ({ loadState: 'loaded', activeState: 'active', subState: 'running',
  mainPid: pid, jobPending: false, fragmentPath: base().unitPath, hasDropIns: false, needsReload: false, user: String(base().serviceUid) });
const code = (expected: string) => (error: unknown): boolean => {
  assert.ok(error instanceof RuntimeError);
  assert.equal(error.message, expected);
  assert.equal(error.code, expected);
  assert.ok(!String(error).includes(secret));
  return true;
};

async function directory(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'cocoproxy-runtime-evidence-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function candidate(port = 19090): Candidate {
  return compileConfig({ schemaVersion: 1, deployment: {
    mixedPort: port === 17890 ? 17891 : 17890, controllerPort: port, dnsPort: port === 15353 ? 15354 : 15353,
    controllerSecret: secret, bootstrapResolvers: ['192.0.2.53'],
  }, policy: { rules: ['MATCH,DIRECT'], 'log-level': 'warning', 'unified-delay': true },
  sources: [{ id: 'synthetic-source', proxies: [{ name: 'synthetic-proxy', type: 'socks5', server: '192.0.2.10', port: 1080 }] }] });
}

function changed(good: Candidate, change: Candidate['config']): Candidate {
  const config = { ...good.config, ...change };
  const id = createHash('sha256').update(canonicalJson(config)).digest('hex');
  return { id, sha256: id, config };
}

test('runtime settings accept only exact plain JSON and normalized POSIX paths', () => {
  assert.deepEqual(parseRuntimeSettings(base()), base());
  assert.equal(parseRuntimeSettings({ ...base(), stateDirectory: '/a/literal\\backslash' }).stateDirectory, '/a/literal\\backslash');
  let accessed = false;
  const getter = Object.defineProperty(base(), 'binaryPath', { enumerable: true, get() { accessed = true; return secret; } });
  const invalid = [getter, Object.assign(Object.create({ inherited: true }), base()), { ...base(), extra: secret },
    { ...base(), serviceUid: 0 }, { ...base(), serviceUid: 1.5 }, { ...base(), serviceUid: Number.MAX_SAFE_INTEGER + 1 },
    { ...base(), binarySha256: 'A'.repeat(64) }, { ...base(), unitPath: '/etc/systemd/system/other.service' },
    ...['relative', '//var/lib/cocoproxy', '/var/../lib/cocoproxy', '/var/lib/cocoproxy/', '/bad\npath', '/bad\u0000path']
      .map(stateDirectory => ({ ...base(), stateDirectory }))];
  for (const input of invalid) assert.throws(() => parseRuntimeSettings(input), code('INVALID_RUNTIME_SETTINGS'));
  assert.equal(accessed, false);
});

test('runtime settings are read from a private bounded file', { skip: !linux }, async t => {
  const root = await directory(t);
  const path = join(root, 'runtime.json');
  await writeFile(path, JSON.stringify(base()), { mode: 0o600 });
  assert.deepEqual(await loadRuntimeSettings(path), base());
  await chmod(path, 0o644);
  await assert.rejects(loadRuntimeSettings(path), code('INVALID_RUNTIME_SETTINGS'));
  await chmod(path, 0o600);
  await writeFile(path, ' '.repeat(64 * 1024 + 1));
  await assert.rejects(loadRuntimeSettings(path), code('INVALID_RUNTIME_SETTINGS'));
});

test('binary verification pins bytes, executable mode and ownership permissions', { skip: !linux }, async t => {
  const root = await directory(t);
  const path = join(root, 'core-fixture');
  const bytes = '#!/bin/sh\nexit 0\n';
  const timestamp = new Date('2020-01-01T00:00:00Z');
  await writeFile(path, bytes, { mode: 0o700 });
  await utimes(path, timestamp, timestamp);
  const settings = { ...base(), serviceUid: process.geteuid!() || 1001, binaryPath: path,
    binarySha256: createHash('sha256').update(bytes).digest('hex') };
  assert.equal(await verifyBinary(settings), await realpath(path));
  assert.equal(await verifyBinary(settings), await realpath(path));
  await assert.rejects(verifyBinary({ ...settings, binarySha256: '0'.repeat(64) }), code('BINARY_UNTRUSTED'));
  await verifyBinary(settings);
  await writeFile(path, '#!/bin/sh\nexit 1\n');
  await utimes(path, timestamp, timestamp);
  await assert.rejects(verifyBinary(settings), code('BINARY_UNTRUSTED'));
  await writeFile(path, bytes);
  await verifyBinary(settings);
  const replacement = join(root, 'replacement');
  await writeFile(replacement, '#!/bin/sh\nexit 1\n', { mode: 0o700 });
  await utimes(replacement, timestamp, timestamp);
  await rename(replacement, path);
  await assert.rejects(verifyBinary(settings), code('BINARY_UNTRUSTED'));
  await writeFile(path, bytes);
  await verifyBinary(settings);
  await chmod(path, 0o720);
  await assert.rejects(verifyBinary(settings), code('BINARY_UNTRUSTED'));
  await chmod(path, 0o600);
  await assert.rejects(verifyBinary(settings), code('BINARY_UNTRUSTED'));
});

test('candidate recompile preserves proxies and policy while rejecting forged deployment fields', { skip: !linux }, async t => {
  const root = await directory(t);
  const settings = { ...base(), stateDirectory: root };
  const store = new FileTransactionStore(root);
  const good = candidate();
  const staged = await store.stage(good);
  const loaded = await loadRuntimeCandidate(settings, good.id);
  assert.equal(loaded.path, staged.path);
  assert.equal(loaded.home, join(root, 'core-home'));
  assert.equal(loaded.candidate.id, good.id);
  assert.deepEqual(loaded.candidate.config.proxies, good.config.proxies);
  assert.deepEqual(loaded.controller, { port: 19090, secret });
  // Neither the first return value nor a warm-cache return can poison the
  // private compiled proof or the controller credentials of a later lookup.
  for (const result of [loaded, await loadRuntimeCandidate(settings, good.id)]) {
    result.candidate.config.secret = 'caller-modified';
    (result.candidate.config.rules as string[]).push('MATCH,REJECT');
    result.controller.secret = 'caller-modified';
  }
  const isolated = await loadRuntimeCandidate(settings, good.id);
  assert.deepEqual(isolated.candidate.config, good.config);
  assert.deepEqual(isolated.controller, { port: 19090, secret });
  const snapshot = await loadRuntimeCandidateReadonly(settings, good.id);
  assert.equal(await loadRuntimeCandidateReadonly(settings, good.id), snapshot);
  assert.notEqual(snapshot, isolated);
  for (const value of [snapshot, snapshot.candidate, snapshot.candidate.config, snapshot.controller,
    snapshot.candidate.config.rules, snapshot.candidate.config.proxies,
    (snapshot.candidate.config.proxies as Candidate['config'][])[0]]) assert.ok(Object.isFrozen(value));
  assert.throws(() => { snapshot.controller.secret = 'caller-modified'; }, TypeError);
  assert.throws(() => { (snapshot.candidate.config.rules as string[]).push('MATCH,REJECT'); }, TypeError);
  assert.equal(Object.isFrozen(isolated), false);
  assert.equal(Object.isFrozen(isolated.candidate.config.rules), false);
  const modifications: Candidate['config'][] = [{ tun: { enable: true } }, { listeners: [] }, { 'allow-lan': true },
    { 'external-controller': '0.0.0.0:19090' }, { dns: { ...(good.config.dns as object), nameserver: ['198.51.100.53'] } },
    { 'rule-providers': {} }];
  for (const modification of modifications) {
    const forged = changed(good, modification);
    await store.stage(forged);
    await assert.rejects(loadRuntimeCandidate(settings, forged.id), code('CANDIDATE_UNTRUSTED'));
  }
  await assert.rejects(loadRuntimeCandidate(settings, '../' + secret), code('INVALID_RUNTIME_GENERATION'));
  await loadRuntimeCandidate(settings, good.id);
  await writeFile(staged.path, canonicalJson({ ...good.config, secret: 'changed-in-place' }));
  await assert.rejects(loadRuntimeCandidate(settings, good.id), code('CANDIDATE_UNTRUSTED'));
  await assert.rejects(loadRuntimeCandidateReadonly(settings, good.id), code('CANDIDATE_UNTRUSTED'));
  await writeFile(staged.path, canonicalJson(good.config));
  await loadRuntimeCandidate(settings, good.id);
  await chmod(staged.path, 0o644);
  await assert.rejects(loadRuntimeCandidate(settings, good.id), code('CANDIDATE_UNTRUSTED'));
  await assert.rejects(loadRuntimeCandidateReadonly(settings, good.id), code('CANDIDATE_UNTRUSTED'));
  await chmod(staged.path, 0o600);
  await loadRuntimeCandidate(settings, good.id);
  await rm(staged.path);
  const replacement = join(root, 'replacement.json');
  await writeFile(replacement, canonicalJson(good.config), { mode: 0o600 });
  await symlink(replacement, staged.path);
  await assert.rejects(loadRuntimeCandidate(settings, good.id), code('CANDIDATE_UNTRUSTED'));
  await assert.rejects(loadRuntimeCandidateReadonly(settings, good.id), code('CANDIDATE_UNTRUSTED'));
});

test('selection lookup is private, exact and read-only when absent', { skip: !linux }, async t => {
  const root = await directory(t);
  const settings = { ...base(), stateDirectory: join(root, 'absent') };
  assert.equal(await readSelection(settings), null);
  await assert.rejects(lstat(settings.stateDirectory), { code: 'ENOENT' });
  settings.stateDirectory = root;
  const path = join(root, 'selection.json');
  await writeFile(path, JSON.stringify({ schemaVersion: 1, generation: candidate().id }), { mode: 0o600 });
  assert.equal(await readSelection(settings), candidate().id);
  for (const value of [{ schemaVersion: 1, generation: secret }, { schemaVersion: 1, generation: candidate().id, extra: true }]) {
    await writeFile(path, JSON.stringify(value));
    await assert.rejects(readSelection(settings), code('SELECTION_UNTRUSTED'));
  }
  await rm(path);
  const target = join(root, 'target');
  await writeFile(target, JSON.stringify({ schemaVersion: 1, generation: candidate().id }), { mode: 0o600 });
  await symlink(target, path);
  await assert.rejects(readSelection(settings), code('SELECTION_UNTRUSTED'));
});

test('managed unit verification rejects drift and a unit owned by the service user', { skip: liveSkip }, async t => {
  const root = await directory(t);
  const path = join(root, 'cocoproxy-mihomo.service');
  const bytes = '[Service]\nUser=1001\n';
  await writeFile(path, bytes, { mode: 0o600 });
  const settings = { ...base(), unitPath: path, unitSha256: createHash('sha256').update(bytes).digest('hex'), serviceUid: process.geteuid!() };
  const state = { ...unit(process.pid), fragmentPath: path, user: String(settings.serviceUid) };
  await assert.rejects(assertManagedUnit(settings, state), code('UNIT_UNTRUSTED'));
  for (const drift of [{ hasDropIns: true }, { needsReload: true }, { user: 'root' }, { loadState: 'not-found' }]) {
    await assert.rejects(assertManagedUnit(settings, { ...state, ...drift }), code('UNIT_UNTRUSTED'));
  }
});

let binaryHash: Promise<string> | undefined;
function nodeHash(): Promise<string> {
  return binaryHash ??= (async () => {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(process.execPath)) hash.update(chunk);
    return hash.digest('hex');
  })();
}

async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

async function coreFixture(t: test.TestContext, behavior = 'ok', argsMatch = true) {
  const root = await directory(t);
  const port = await freePort();
  const good = candidate(port);
  const store = new FileTransactionStore(root);
  const staged = await store.stage(good);
  const settings: RuntimeSettings = { ...base(), stateDirectory: root, binaryPath: process.execPath,
    binarySha256: await nodeHash(), serviceUid: process.geteuid!() };
  // This is a Node HTTP fixture. It provides real /proc/socket evidence, not
  // Mihomo semantic validation or systemd deployment acceptance.
  const script = `
    const http = require('node:http');
    const server = http.createServer((request, response) => {
      if (${JSON.stringify(behavior)} === 'hang') return;
      if (request.url !== '/version' || request.headers.authorization !== 'Bearer ' + ${JSON.stringify(secret)}) {
        response.writeHead(401); response.end(${JSON.stringify(secret)}); return;
      }
      if (${JSON.stringify(behavior)} === 'redirect') { response.writeHead(302, { Location: 'http://192.0.2.1/' }); response.end(); return; }
      if (${JSON.stringify(behavior)} === 'oversize') { response.end(JSON.stringify({ version: 'x'.repeat(4096) })); return; }
      if (${JSON.stringify(behavior)} === 'reject') { response.writeHead(500); response.end(${JSON.stringify(secret)}); return; }
      response.end(JSON.stringify({ version: 'synthetic-core-fixture' }));
    });
    server.on('error', () => process.exit(2));
    server.listen(${port}, '127.0.0.1', () => process.send('listening'));
  `;
  const child = spawn(process.execPath, ['-e', script, '--', '-d', join(root, 'core-home'), '-f', argsMatch ? staged.path : staged.path + '.other'],
    { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
  });
  await new Promise<void>((resolve, reject) => {
    const deadline = setTimeout(() => { cleanup(); reject(new Error('fixture startup timeout')); }, 5000);
    const cleanup = () => { clearTimeout(deadline); child.off('message', onMessage); child.off('error', onError); child.off('exit', onExit); };
    const onMessage = () => { cleanup(); resolve(); };
    const onError = (error: Error) => { cleanup(); reject(error); };
    const onExit = () => { cleanup(); reject(new Error('fixture failed to bind reserved port')); };
    child.once('message', onMessage); child.once('error', onError); child.once('exit', onExit);
  });
  assert.ok(child.pid);
  return { settings, good, state: { ...unit(child.pid), user: String(settings.serviceUid) }, root };
}

test('live readiness ties exact generation and executable identity to its listening socket', { skip: liveSkip, timeout: 15_000 }, async t => {
  const { settings, good, state } = await coreFixture(t);
  const observed = await observeCore(settings, good.id, state);
  assert.equal(observed.ready, true);
  assert.equal(observed.reason, null);
  assert.equal(observed.generation, good.id);
  assert.ok(Number.isFinite(Date.parse(observed.checkedAt)));
  assert.equal((await observeCore(settings, good.id, { ...state, jobPending: true })).ready, false);
  // The live controller belongs to the fixture child, never this test runner.
  assert.equal((await observeCore(settings, good.id, { ...state, mainPid: process.pid })).ready, false);
  const other = changed(good, { 'log-level': 'info' });
  await new FileTransactionStore(settings.stateDirectory).stage(other);
  assert.equal((await observeCore(settings, other.id, state)).reason, 'PROCESS_UNVERIFIED');
});

test('matching argv cannot claim another process controller socket', { skip: liveSkip, timeout: 15_000 }, async t => {
  const { settings, good, state, root } = await coreFixture(t);
  const inert = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', '--', '-d', join(root, 'core-home'), '-f',
    new FileTransactionStore(root).candidatePath(good.id)], { stdio: 'ignore' });
  t.after(async () => { if (inert.exitCode !== null || inert.signalCode !== null) return; const exited = once(inert, 'exit'); inert.kill('SIGKILL'); await exited; });
  await once(inert, 'spawn');
  assert.ok(inert.pid);
  const observed = await observeCore(settings, good.id, { ...state, mainPid: inert.pid });
  assert.equal(observed.ready, false);
  assert.equal(observed.reason, 'CONTROLLER_NOT_OWNED');
});

test('readiness rejects wrong argv and does not expose controller diagnostics or secrets', { skip: liveSkip, timeout: 20_000 }, async t => {
  for (const behavior of ['reject', 'redirect', 'oversize']) {
    const { settings, good, state } = await coreFixture(t, behavior);
    const observed = await observeCore(settings, good.id, state);
    assert.equal(observed.reason, 'CONTROLLER_UNREADY');
    assert.ok(!JSON.stringify(observed).includes(secret));
    assert.ok(!JSON.stringify(observed).includes(settings.stateDirectory));
  }
  const { settings, good, state } = await coreFixture(t, 'ok', false);
  assert.equal((await observeCore(settings, good.id, state)).reason, 'PROCESS_UNVERIFIED');
});

test('controller deadline includes a response which never arrives', { skip: liveSkip, timeout: 15_000 }, async t => {
  const { settings, good, state } = await coreFixture(t, 'hang');
  const started = performance.now();
  const observed = await observeCore(settings, good.id, state);
  assert.equal(observed.ready, false);
  assert.equal(observed.reason, 'CONTROLLER_UNREADY');
  assert.ok(performance.now() - started < 5000);
  assert.ok(!JSON.stringify(observed).includes(secret));
});
