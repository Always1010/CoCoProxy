import { createHash, randomUUID } from 'node:crypto';
import type { JsonObject } from '../config/index.ts';
import { ManagementError, exactRecord, readJsonBody, type Principal } from './http.ts';
import { runBandwidthTransfer, type BandwidthDirection, type BandwidthPhase, type BandwidthReport } from './bandwidth-transport.ts';

export const BANDWIDTH_LIMITS = Object.freeze({ durationMs: 6000, maxBytes: 200_000_000, timeoutMs: 30_000 });
export const BANDWIDTH_SERVER = Object.freeze({ name: 'Cloudflare', url: 'https://speed.cloudflare.com' });
type Phase = BandwidthPhase | 'cancelling' | 'complete' | 'partial' | 'failed' | 'cancelled';
export type BandwidthTask = {
  id: string; node: string; generation: string; phase: Phase; running: boolean; owned: boolean;
  reason: string | null; bytesUsed: number; startedAt: number; phaseStartedAt: number; finishedAt: number | null;
  latency: { idle: number | null; download: number | null; upload: number | null };
  download: BandwidthDirection; upload: BandwidthDirection;
};
export type BandwidthTarget = { config: JsonObject; binaryPath: string; stateDirectory: string };
const pending = (): BandwidthDirection => ({ status: 'pending', mbps: null, liveMbps: null, bytes: 0 });
const errorCodes = new Set(['ACTIVE_CONFLICT', 'CONTROLLER_UNAVAILABLE', 'BANDWIDTH_UNAVAILABLE', 'BANDWIDTH_NODE_INVALID',
  'BANDWIDTH_TIMEOUT', 'BANDWIDTH_LIMIT', 'BANDWIDTH_SAMPLE_INSUFFICIENT', 'BANDWIDTH_UPLOAD_FAILED',
  'BANDWIDTH_DOWNLOAD_FAILED', 'BANDWIDTH_TLS_FAILED', 'BANDWIDTH_CORE_FAILED', 'BANDWIDTH_CONFIG_INVALID', 'BANDWIDTH_BYTE_LIMIT', 'BANDWIDTH_CANCELLED']);
function failure(error: unknown): string {
  const value = error as { code?: unknown; message?: unknown } | null;
  for (const code of [value?.code, value?.message]) if (typeof code === 'string' && errorCodes.has(code)) return code;
  return 'BANDWIDTH_UNAVAILABLE';
}

/** One service process, one task. Never mutate or hold the production configuration lock while transferring. */
export function createBandwidthService(options: {
  snapshot: (node: string, generation: string, signal: AbortSignal) => Promise<BandwidthTarget>;
  isCurrent: (generation: string) => Promise<boolean>;
  enabled?: boolean;
  transfer?: typeof runBandwidthTransfer;
}) {
  let current: { task: BandwidthTask; owner: string; abort: AbortController; completion: Promise<void>; stopReason: string | null } | undefined;
  let stopped = false;
  const transfer = options.transfer ?? runBandwidthTransfer;

  function owner(request: Request, principal: Principal): string | null {
    const client = request.headers.get('x-cocoproxy-bandwidth-client');
    if (!client || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(client)) return null;
    // Bind a tab's opaque id to its authenticated browser. Neither cookies nor this digest are exposed.
    const identity = principal.deviceId ?? request.headers.get('cookie') ?? '';
    return createHash('sha256').update(JSON.stringify([principal.username, identity, client])).digest('hex');
  }
  function status(key: string | null) {
    return { available: options.enabled !== false && !stopped, limits: BANDWIDTH_LIMITS, server: BANDWIDTH_SERVER,
      task: current ? structuredClone({ ...current.task, owned: key !== null && current.owner === key }) : null };
  }
  function stop(job: NonNullable<typeof current>, reason: string) {
    if (!job.task.running || job.stopReason) return;
    job.stopReason = reason;
    job.task.phase = 'cancelling';
    job.task.phaseStartedAt = Date.now();
    job.abort.abort();
  }
  async function execute(job: NonNullable<typeof current>): Promise<void> {
    const task = job.task;
    const deadline = setTimeout(() => stop(job, 'BANDWIDTH_TIMEOUT'), BANDWIDTH_LIMITS.timeoutMs);
    let checking = false;
    const monitor = setInterval(() => {
      if (checking || job.stopReason) return;
      checking = true;
      void options.isCurrent(task.generation).then(valid => { if (!valid) stop(job, 'ACTIVE_CONFLICT'); },
        () => stop(job, 'CONTROLLER_UNAVAILABLE')).finally(() => { checking = false; });
    }, 1000);
    let reason: string | null = null;
    const report = (update: BandwidthReport) => {
      if (update.phase && !job.stopReason && update.phase !== task.phase) {
        task.phase = update.phase; task.phaseStartedAt = Date.now();
      }
      if (update.bytesUsed !== undefined) {
        task.bytesUsed = Math.max(task.bytesUsed, update.bytesUsed);
        if (task.bytesUsed > BANDWIDTH_LIMITS.maxBytes) stop(job, 'BANDWIDTH_LIMIT');
      }
      if (update.download) task.download = { ...update.download };
      if (update.upload) task.upload = { ...update.upload };
      if (update.latency) task.latency = { ...update.latency };
    };
    try {
      const target = await options.snapshot(task.node, task.generation, job.abort.signal);
      job.abort.signal.throwIfAborted();
      const result = await transfer({ ...target, node: task.node, limits: BANDWIDTH_LIMITS, signal: job.abort.signal, report });
      reason = result.reason;
      if (!job.stopReason && !await options.isCurrent(task.generation)) reason = 'ACTIVE_CONFLICT';
    } catch (error) { reason = failure(error); }
    finally {
      clearTimeout(deadline); clearInterval(monitor);
      // The transfer resolves only after sockets and the isolated child are gone.
      task.reason = job.stopReason ?? reason;
      for (const direction of [task.download, task.upload]) {
        direction.liveMbps = null;
        if (direction.status === 'running' || direction.status === 'pending') {
          direction.status = job.stopReason === 'BANDWIDTH_CANCELLED' ? 'cancelled' : 'failed';
          direction.mbps = null;
        }
      }
      const successful = [task.download, task.upload].filter(value => value.status === 'success').length;
      if (!task.reason && successful < 2) task.reason = 'BANDWIDTH_SAMPLE_INSUFFICIENT';
      task.phase = task.reason === 'BANDWIDTH_CANCELLED' ? 'cancelled'
        : ['ACTIVE_CONFLICT', 'CONTROLLER_UNAVAILABLE'].includes(task.reason ?? '') ? 'failed'
          : successful === 2 && !task.reason ? 'complete' : successful ? 'partial' : 'failed';
      task.running = false; task.finishedAt = Date.now(); task.phaseStartedAt = task.finishedAt;
    }
  }

  return {
    async fetch(request: Request, principal: Principal) {
      const url = new URL(request.url);
      if (url.search) throw new ManagementError('INVALID_REQUEST');
      const key = owner(request, principal);
      if (url.pathname === '/api/cocoproxy/bandwidth' && request.method === 'GET') return status(key);
      if (!key) throw new ManagementError('BANDWIDTH_CLIENT_REQUIRED');
      if (url.pathname === '/api/cocoproxy/bandwidth' && request.method === 'POST') {
        const body = exactRecord(await readJsonBody(request, 2048), ['node', 'expectedActive']);
        if (typeof body.node !== 'string' || !body.node.trim() || body.node.length > 256 || /[\u0000-\u001f\u007f]/.test(body.node) ||
            typeof body.expectedActive !== 'string' || !/^[a-f0-9]{64}$/.test(body.expectedActive)) throw new ManagementError('INVALID_REQUEST');
        if (stopped || options.enabled === false) throw new ManagementError('BANDWIDTH_DISABLED', 503);
        if (current?.task.running) throw new ManagementError('BANDWIDTH_BUSY', 409);
        const now = Date.now();
        const job = { task: { id: randomUUID(), node: body.node, generation: body.expectedActive, phase: 'preparing', running: true, owned: false,
          reason: null, bytesUsed: 0, startedAt: now, phaseStartedAt: now, finishedAt: null,
          latency: { idle: null, download: null, upload: null }, download: pending(), upload: pending() } as BandwidthTask,
          owner: key, abort: new AbortController(), completion: Promise.resolve(), stopReason: null as string | null };
        current = job; // Reserve synchronously before any snapshot/core I/O.
        job.completion = execute(job);
        return status(key);
      }
      if (url.pathname === '/api/cocoproxy/bandwidth/cancel' && request.method === 'POST') {
        const body = exactRecord(await readJsonBody(request, 256), ['id']);
        if (typeof body.id !== 'string' || body.id !== current?.task.id) throw new ManagementError('BANDWIDTH_TASK_CONFLICT', 409);
        if (current.owner !== key) throw new ManagementError('BANDWIDTH_NOT_OWNER', 403);
        stop(current, 'BANDWIDTH_CANCELLED');
        return status(key);
      }
      throw new ManagementError('NOT_FOUND', 404);
    },
    async close() {
      stopped = true;
      if (current) { stop(current, 'BANDWIDTH_CANCELLED'); await current.completion; }
    },
  };
}
