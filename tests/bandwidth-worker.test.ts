import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { chmod, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { connect, createServer } from 'node:net';
import { createBandwidthWorkerClient } from '../packages/management/bandwidth-worker-client.ts';
import { createBandwidthWorkerHost, createBandwidthWorkerServer, type BandwidthWorkerHost } from '../packages/runtime/bandwidth-worker.ts';
import { bandwidthError, parseBandwidthJob } from '../packages/runtime/bandwidth-protocol.ts';
import type { TransferInput } from '../packages/management/bandwidth-transport.ts';
import { initialWorkspace } from '../packages/management/workspace.ts';

const generation = 'a'.repeat(64);
function input(root: string, signal = new AbortController().signal): TransferInput {
  return { config: { proxies: [{ name: 'node-a', password: 'synthetic-private-secret' }] }, binaryPath: '/synthetic/ignored-binary',
    node: 'node-a', generation, stateDirectory: root, signal, limits: { durationMs: 6000, timeoutMs: 30000, maxBytes: 200000000 }, report: () => {} };
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function fixture(host: (root: string) => BandwidthWorkerHost, options: { singleTask?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'bandwidth-worker-'));
  const socketPath = join(root, 'worker.sock'), worker = createBandwidthWorkerServer(host(root), options);
  worker.server.listen(socketPath); await once(worker.server, 'listening'); await chmod(socketPath, 0o600);
  const client = createBandwidthWorkerClient({ socketPath });
  return { root, worker, client, socketPath, async close() { await worker.close(); await rm(root, { recursive: true, force: true }); } };
}

test('worker protocol rejects supplied programs, endpoints and configurations', () => {
  const job = { version: 1, id: '12345678-1234-1234-1234-123456789abc', generation, node: 'node-a', kind: 'manual' };
  assert.equal(parseBandwidthJob(job).node, 'node-a');
  for (const extra of [{ config: {} }, { url: 'https://arbitrary.example/' }, { binaryPath: '/synthetic/command' }, { limits: {} }])
    assert.throws(() => parseBandwidthJob({ ...job, ...extra }));
  assert.throws(() => parseBandwidthJob({ ...job, version: 2 }));
  assert.throws(() => parseBandwidthJob({ ...job, kind: 'automatic' }));
  const automatic = { ...job, kind: 'automatic', group: 'synthetic-group', workspaceRevision: 3 };
  assert.equal(parseBandwidthJob(automatic).workspaceRevision, 3);
  for (const workspaceRevision of [undefined, -1, 0.5, '3']) assert.throws(() => parseBandwidthJob({ ...automatic, workspaceRevision }));
  assert.throws(() => parseBandwidthJob({ ...job, workspaceRevision: 3 }));
});

test('a socket-activated single-task instance stops accepting before reporting completion', async () => {
  const f = await fixture(root => ({ current: async () => true, prepare: async () => input(root), transfer: async () => ({ reason: null }) }), { singleTask: true });
  try {
    await f.client.transfer(input(f.root));
    assert.equal(f.worker.server.listening, false);
  } finally { await f.close(); }
});

test('automatic work rejects a stale workspace revision before loading or starting a core', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bandwidth-revision-'));
  try {
    await writeFile(join(root, 'state.json'), JSON.stringify({ version: 1, desired: generation, active: generation,
      pending: null, fault: null, checkedAt: null }), { mode: 0o600 });
    await writeFile(join(root, 'selection.json'), JSON.stringify({ schemaVersion: 1, generation }), { mode: 0o600 });
    const { revision: _revision, ...settings } = initialWorkspace(null, []);
    await writeFile(join(root, 'workspace.json'), JSON.stringify({ version: 1, revision: 3, settings }), { mode: 0o600 });
    const host = createBandwidthWorkerHost({ schemaVersion: 1, enabled: true, runtime: { schemaVersion: 1,
      stateDirectory: root, serviceUid: process.geteuid?.() || 1001, binaryPath: '/synthetic/no-binary', binarySha256: 'b'.repeat(64),
      unitPath: '/etc/systemd/system/cocoproxy-mihomo.service', unitSha256: 'c'.repeat(64), systemctlPath: '/usr/bin/systemctl' } });
    const job = parseBandwidthJob({ version: 1, id: '12345678-1234-1234-1234-123456789abc', generation,
      node: 'node-a', kind: 'automatic', group: 'synthetic-group', workspaceRevision: 3 });
    assert.equal(await host.current(job), true);
    assert.equal(await host.current({ ...job, workspaceRevision: 2 }), false);
    await assert.rejects(host.prepare({ ...job, workspaceRevision: 2 }, new AbortController().signal), { code: 'ACTIVE_CONFLICT' });
    await writeFile(join(root, 'workspace.json'), JSON.stringify({ version: 1, revision: 4, settings }));
    assert.equal(await host.current(job), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('socket worker derives the transfer from its own trusted snapshot and cleans task files before replying', async () => {
  const reports: unknown[] = [];
  const f = await fixture(root => ({ current: async () => true,
    prepare: async job => {
      assert.deepEqual(Object.keys(job).sort(), ['generation', 'id', 'kind', 'node', 'version']);
      return { ...input(root), config: { 'interface-name': 'synthetic-egress', 'routing-mark': 123 }, binaryPath: '/synthetic/trusted-binary' };
    },
    transfer: async task => {
      assert.equal(task.config['routing-mark'], 123); assert.equal(task.config['interface-name'], 'synthetic-egress');
      assert.equal(task.binaryPath, '/synthetic/trusted-binary');
      assert.notEqual(task.stateDirectory, root);
      task.report({ phase: 'download', bytesUsed: 1000, download: { status: 'success', mbps: 6, liveMbps: null, bytes: 1000 } });
      return { reason: null };
    } }));
  try {
    assert.equal((await f.client.availability()).available, true);
    assert.deepEqual(await f.client.transfer({ ...input(f.root), report: update => reports.push(update) }), { reason: null });
    assert.ok(JSON.stringify(reports).includes('"mbps":6'));
    assert.ok(!JSON.stringify(reports).includes('synthetic-private-secret'));
    assert.deepEqual(await readdir(f.root), ['worker.sock']);
  } finally { await f.close(); }
});

test('cancellation holds both worker and caller until cleanup and rejects concurrent work', async () => {
  const entered = deferred(), cleanup = deferred();
  const f = await fixture(root => ({ current: async () => true, prepare: async () => input(root),
    transfer: async task => {
      entered.resolve();
      await new Promise<void>(resolve => task.signal.addEventListener('abort', () => resolve(), { once: true }));
      await cleanup.promise; return { reason: null };
    } }));
  const abort = new AbortController(); let completed = false;
  const running = f.client.transfer(input(f.root, abort.signal)).finally(() => { completed = true; });
  // Attach rejection handling before cancellation so Node does not see an unhandled rejection.
  const cancelled = assert.rejects(running, { code: 'BANDWIDTH_CANCELLED' });
  try {
    await entered.promise; abort.abort();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(completed, false); assert.equal(f.worker.busy(), true);
    await assert.rejects(f.client.transfer(input(f.root)), { code: 'BANDWIDTH_BUSY' });
    cleanup.resolve(); await cancelled;
    assert.equal(f.worker.busy(), false); assert.deepEqual(await readdir(f.root), ['worker.sock']);
  } finally { cleanup.resolve(); await cancelled; await f.close(); }
});

test('changed generations and failed egress never return valid bandwidth and errors stay sanitized', async () => {
  let current = true, unavailable = false;
  const f = await fixture(root => ({ current: async () => current,
    prepare: async () => { if (unavailable) throw bandwidthError('BANDWIDTH_PATH_UNAVAILABLE'); return input(root); },
    transfer: async () => { current = false; return { reason: null }; } }));
  try {
    await assert.rejects(f.client.transfer(input(f.root)), { code: 'ACTIVE_CONFLICT' });
    current = true; unavailable = true;
    await assert.rejects(f.client.transfer(input(f.root)), { code: 'BANDWIDTH_PATH_UNAVAILABLE' });
    assert.deepEqual(await readdir(f.root), ['worker.sock']);
    const malformed = connect(f.socketPath); await once(malformed, 'connect');
    malformed.write(JSON.stringify({ version: 1, config: { secret: 'synthetic-private-secret' } }) + '\n');
    malformed.resume(); await once(malformed, 'close');
  } finally { await f.close(); }
});

test('timeout requests cancellation and waits for worker cleanup before rejecting', async () => {
  const entered = deferred(), cleanup = deferred();
  const f = await fixture(root => ({ current: async () => true, prepare: async () => input(root), transfer: async task => {
    entered.resolve();
    await new Promise<void>(resolve => task.signal.addEventListener('abort', () => resolve(), { once: true }));
    await cleanup.promise; return { reason: null };
  } }));
  let completed = false;
  const task = input(f.root); task.limits.timeoutMs = 80;
  const running = f.client.transfer(task).finally(() => { completed = true; });
  const rejected = assert.rejects(running, { code: 'BANDWIDTH_TIMEOUT' });
  try {
    await entered.promise; await new Promise(resolve => setTimeout(resolve, 120));
    assert.equal(completed, false); assert.equal(f.worker.busy(), true);
    cleanup.resolve(); await rejected;
  } finally { cleanup.resolve(); await rejected; await f.close(); }
});

test('lost or incompatible responses retain the reservation and failures after bytes are never called not-started', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bandwidth-channel-')), path = join(root, 'worker.sock');
  let mode = 'version';
  const server = createServer(socket => { socket.once('data', bytes => {
    const job = JSON.parse(bytes.toString());
    if (mode === 'lost') { socket.destroy(); return; }
    if (mode === 'after-bytes') {
      socket.write(JSON.stringify({ version: 1, id: job.id, type: 'report', report: { bytesUsed: 1000 } }) + '\n');
      socket.end(JSON.stringify({ version: 1, id: job.id, type: 'error', code: 'BANDWIDTH_WORKER_UNAVAILABLE' }) + '\n');
    } else socket.end(JSON.stringify({ version: 2, id: job.id, type: 'result', reason: null }) + '\n');
  }); });
  server.listen(path); await once(server, 'listening'); await chmod(path, 0o600);
  const client = createBandwidthWorkerClient({ socketPath: path }), reports: { bytesUsed?: number }[] = [];
  const task = { ...input(root), group: 'synthetic-group', workspaceRevision: 3, verification: { targetMbps: 8, warmupMs: 2000, minSampleMs: 3000 }, report: (update: { bytesUsed?: number }) => reports.push(update) };
  try {
    for (mode of ['version', 'lost', 'after-bytes']) {
      reports.length = 0;
      await assert.rejects(client.transfer(task), { code: 'BANDWIDTH_UNAVAILABLE' });
      assert.equal(reports.at(-1)?.bytesUsed, mode === 'after-bytes' ? 1000 : task.limits.maxBytes);
    }
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
});
