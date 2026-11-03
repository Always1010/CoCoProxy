import { constants } from 'node:fs';
import { lstat, open, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, posix } from 'node:path';
import { FileTransactionStore } from '../transaction/index.ts';
import { loadRuntimeCandidate, readSelection, verifyBinary } from './settings.ts';
import { SystemdMihomoRuntime } from './systemd.ts';
import { readRuntimeLifecycle } from './lifecycle.ts';
import { privateRead } from '../storage/private-files.ts';
import { parseWorkspaceDocument } from '../management/workspace.ts';
import { BANDWIDTH_LIMITS } from '../management/bandwidth.ts';
import { buildBandwidthConfig, checkBandwidthEgress, runBandwidthTransfer, type TransferInput, type BandwidthReport } from '../management/bandwidth-transport.ts';
import { parseBandwidthWorkerSettings, type BandwidthWorkerSettings } from './bandwidth-worker-plan.ts';
import { BANDWIDTH_FRAME_LIMIT, bandwidthError, parseBandwidthJob, parseBandwidthReport, workerErrorCode, type BandwidthJob } from './bandwidth-protocol.ts';

/** No credentials in this root-controlled file. Do not accept settings from a socket request. */
export async function loadBandwidthWorkerSettings(path: string): Promise<BandwidthWorkerSettings> {
  if (!posix.isAbsolute(path) || posix.normalize(path) !== path) throw bandwidthError();
  for (let current = dirname(path);; current = dirname(current)) {
    const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o022) !== 0) throw bandwidthError();
    if (current === '/') break;
  }
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.uid !== 0 || (before.mode & 0o022) !== 0 || before.size > 16384) throw bandwidthError();
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const after = await handle.stat();
    if (after.dev !== before.dev || after.ino !== before.ino || after.uid !== before.uid || after.mode !== before.mode || after.size !== before.size) throw bandwidthError();
    const buffer = Buffer.alloc(16385);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 16384) throw bandwidthError();
    return parseBandwidthWorkerSettings(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead))));
  } finally { await handle.close(); }
}

export type BandwidthWorkerHost = {
  prepare: (job: BandwidthJob, signal: AbortSignal) => Promise<Omit<TransferInput, 'signal' | 'report'>>;
  current: (job: BandwidthJob) => Promise<boolean>;
  transfer?: typeof runBandwidthTransfer;
};

/** Only committed data is read; all task files live in the worker unit's private /tmp. */
export function createBandwidthWorkerHost(settings: BandwidthWorkerSettings): BandwidthWorkerHost {
  const { runtime: policy } = settings;
  const store = new FileTransactionStore(policy.stateDirectory), runtime = new SystemdMihomoRuntime(policy);
  const current = async (job: BandwidthJob) => {
    const status = await store.status();
    if (!settings.enabled || status.active !== job.generation || status.transaction !== null || status.fault !== null
        || await readSelection(policy) !== job.generation || (await readRuntimeLifecycle(policy.stateDirectory)).paused) return false;
    if (job.kind === 'automatic') {
      const workspace = parseWorkspaceDocument(JSON.parse(await privateRead(join(policy.stateDirectory, 'workspace.json'), 1048576)));
      if (workspace.revision !== job.workspaceRevision) return false;
    }
    return true;
  };
  return {
    current,
    async prepare(job, signal) {
      if (!settings.enabled) throw bandwidthError('BANDWIDTH_DISABLED');
      if (!await current(job)) throw bandwidthError('ACTIVE_CONFLICT');
      const { candidate } = await loadRuntimeCandidate(policy, job.generation);
      const binaryPath = await verifyBinary(policy);
      const executable = await lstat(binaryPath);
      if (executable.uid !== 0 || (executable.mode & 0o022) !== 0) throw bandwidthError('BANDWIDTH_CONFIG_INVALID');
      if (!(await runtime.observe(job.generation)).ready) throw bandwidthError('CONTROLLER_UNAVAILABLE');
      let limits: TransferInput['limits'] = { ...BANDWIDTH_LIMITS };
      let verification: TransferInput['verification'];
      if (job.kind === 'automatic') {
        const workspace = parseWorkspaceDocument(JSON.parse(await privateRead(join(policy.stateDirectory, 'workspace.json'), 1048576)));
        if (workspace.revision !== job.workspaceRevision) throw bandwidthError('ACTIVE_CONFLICT');
        const edits = workspace.mode === 'local' ? workspace.local : workspace.subscriptionOverrides[workspace.mode === 'legacy' ? 'legacy' : workspace.subscriptionId ?? ''];
        const group = edits?.automatic?.[job.group!], s = group?.bandwidth;
        if (workspace.runMode === 'direct' || group?.enabled === false || !s?.enabled
            || ![...(group?.preferred ?? []), ...(group?.fallback ?? [])].includes(job.node)) throw bandwidthError('BANDWIDTH_DISABLED');
        limits = { durationMs: s.durationSeconds * 1000, maxBytes: s.taskMiB * 1048576, timeoutMs: s.timeoutSeconds * 1000 };
        verification = { targetMbps: s.targetMbps, warmupMs: s.warmupSeconds * 1000, minSampleMs: s.minSampleSeconds * 1000 };
      }
      const isolated = buildBandwidthConfig(candidate.config, job.node, 23456);
      checkBandwidthEgress(isolated, process.platform, await readFile('/proc/self/status', 'utf8'));
      signal.throwIfAborted();
      if (!await current(job)) throw bandwidthError('ACTIVE_CONFLICT');
      return { config: candidate.config, binaryPath, stateDirectory: tmpdir(), node: job.node, generation: job.generation,
        ...(job.group ? { group: job.group } : {}), limits, ...(verification ? { verification } : {}) };
    },
  };
}

/** One active job across every connection, including reconnects during cancellation cleanup. */
export function createBandwidthWorkerServer(host: BandwidthWorkerHost, options: { singleTask?: boolean } = {}) {
  let active: { abort: AbortController; done: Promise<void> } | undefined, used = false;
  const connections = new Set<Socket>();
  const server = createServer({ allowHalfOpen: true }, socket => {
    connections.add(socket); socket.setEncoding('utf8');
    let buffer = '', job: BandwidthJob | undefined, frames = 0;
    let abort: AbortController | undefined;
    const send = (message: object) => {
      if (!socket.destroyed && !socket.writableEnded) {
        if (socket.writableLength > 65536) { abort?.abort(); socket.destroy(); return; }
        socket.write(JSON.stringify({ version: 1, id: job?.id ?? '', ...message }) + '\n');
      }
    };
    const initial = setTimeout(() => socket.destroy(), 2000);
    socket.on('data', chunk => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > BANDWIDTH_FRAME_LIMIT) { abort?.abort(); socket.destroy(); return; }
      for (;;) {
        const end = buffer.indexOf('\n'); if (end < 0) break;
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        try {
          const request = JSON.parse(line);
          if (++frames > 2) throw bandwidthError();
          if (job) {
            if (Object.keys(request).length !== 1 || request.cancel !== job.id) throw bandwidthError();
            abort?.abort(); continue;
          }
          job = parseBandwidthJob(request); clearTimeout(initial);
          if (active || options.singleTask && used) { send({ type: 'error', code: 'BANDWIDTH_BUSY' }); socket.end(); return; }
          used = true;
          abort = new AbortController();
          const selected = job, stop = abort;
          const task = { abort: stop, done: Promise.resolve() }; active = task;
          task.done = (async () => {
            let directory: string | undefined, timedOut = false, invalid = false, monitoring = false;
            const beganAt = Date.now();
            let deadline = setTimeout(() => { timedOut = true; stop.abort(); }, 30000);
            const monitor = setInterval(() => {
              if (monitoring || stop.signal.aborted) return;
              monitoring = true;
              void host.current(selected).then(ok => { if (!ok) { invalid = true; stop.abort(); } }, () => { invalid = true; stop.abort(); })
                .finally(() => { monitoring = false; });
            }, 1000);
            let result: { reason: string | null } | undefined, failure: string | undefined;
            let lastReport = 0, phase: string | undefined;
            try {
              const input = await host.prepare(selected, stop.signal);
              clearTimeout(deadline);
              const remaining = input.limits.timeoutMs - (Date.now() - beganAt);
              if (remaining <= 0) { timedOut = true; stop.abort(); }
              else deadline = setTimeout(() => { timedOut = true; stop.abort(); }, remaining);
              if (stop.signal.aborted) throw bandwidthError('BANDWIDTH_CANCELLED');
              directory = await mkdtemp(join(input.stateDirectory, 'cocoproxy-worker-'));
              result = await (host.transfer ?? runBandwidthTransfer)({ ...input, stateDirectory: directory, signal: stop.signal,
                report: (update: BandwidthReport) => {
                  const important = update.phase !== undefined && update.phase !== phase || update.latency !== undefined
                    || update.download !== undefined && update.download.status !== 'running'
                    || update.upload !== undefined && update.upload.status !== 'running' || update.reason !== undefined;
                  if (important || Date.now() - lastReport >= 200) {
                    lastReport = Date.now(); phase = update.phase ?? phase;
                    send({ type: 'report', report: parseBandwidthReport(update) });
                  }
                } });
              if (!await host.current(selected)) throw bandwidthError('ACTIVE_CONFLICT');
            } catch (error) { failure = workerErrorCode(error); }
            finally {
              clearTimeout(deadline); clearInterval(monitor);
              if (directory) await rm(directory, { recursive: true, force: true }).catch(() => { failure = 'BANDWIDTH_WORKER_UNAVAILABLE'; });
              if (active === task) active = undefined;
              // Stop accepting before publishing completion. systemd retains its listener and can queue the next job.
              if (options.singleTask) server.close();
              if (invalid) failure = 'ACTIVE_CONFLICT';
              else if (timedOut) failure = 'BANDWIDTH_TIMEOUT';
              else if (stop.signal.aborted) failure = 'BANDWIDTH_CANCELLED';
              send(failure ? { type: 'error', code: failure } : { type: 'result', reason: result?.reason ?? null });
              socket.end();
            }
          })();
        } catch { abort?.abort(); socket.destroy(); return; }
      }
    });
    socket.on('end', () => { abort?.abort(); if (!job) socket.end(); });
    socket.on('error', () => { abort?.abort(); });
    socket.on('close', () => { clearTimeout(initial); abort?.abort(); connections.delete(socket); });
  });
  server.maxConnections = 4;
  return { server, busy: () => !!active,
    async close() {
      active?.abort.abort(); for (const socket of connections) socket.destroy();
      await active?.done;
      await new Promise<void>(resolve => server.close(() => resolve()));
    } };
}
