import type { BandwidthDirection, BandwidthReport } from '../management/bandwidth-transport.ts';

export const BANDWIDTH_PROTOCOL_VERSION = 1;
export const BANDWIDTH_FRAME_LIMIT = 16384;
export type BandwidthJob = { version: 1; id: string; generation: string; node: string; kind: 'manual' | 'automatic'; group?: string; workspaceRevision?: number };
export const BANDWIDTH_WORKER_ERRORS = new Set(['BANDWIDTH_WORKER_UNAVAILABLE', 'BANDWIDTH_PATH_UNAVAILABLE', 'BANDWIDTH_BUSY',
  'BANDWIDTH_CANCELLED', 'BANDWIDTH_TIMEOUT', 'BANDWIDTH_UNAVAILABLE', 'BANDWIDTH_CONFIG_INVALID', 'BANDWIDTH_BYTE_LIMIT',
  'BANDWIDTH_SAMPLE_INSUFFICIENT', 'BANDWIDTH_DISABLED', 'ACTIVE_CONFLICT', 'CONTROLLER_UNAVAILABLE', 'BANDWIDTH_NODE_INVALID']);
export const bandwidthError = (code = 'BANDWIDTH_WORKER_UNAVAILABLE') => Object.assign(new Error(code), { code });
export function workerErrorCode(error: unknown): string {
  const code = (error as { code?: unknown })?.code;
  return typeof code === 'string' && BANDWIDTH_WORKER_ERRORS.has(code) ? code : 'BANDWIDTH_WORKER_UNAVAILABLE';
}
function exact(value: unknown, keys: string[], optional: string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || keys.some(k => !Object.hasOwn(value, k))
      || Object.keys(value).some(k => !keys.includes(k) && !optional.includes(k))) throw bandwidthError();
  return value as Record<string, unknown>;
}
export function parseBandwidthJob(input: unknown): BandwidthJob {
  const value = exact(input, ['version', 'id', 'generation', 'node', 'kind'], ['group', 'workspaceRevision']);
  if (value.version !== BANDWIDTH_PROTOCOL_VERSION || typeof value.id !== 'string' || !/^[a-f0-9-]{36}$/.test(value.id)
      || typeof value.generation !== 'string' || !/^[a-f0-9]{64}$/.test(value.generation)
      || typeof value.node !== 'string' || !value.node.trim() || value.node.length > 256 || /[\u0000-\u001f\u007f]/u.test(value.node)
      || !['manual', 'automatic'].includes(String(value.kind))
      || (value.kind === 'automatic' ? typeof value.group !== 'string' || !value.group.trim() || value.group.length > 256
        || /[\u0000-\u001f\u007f]/u.test(value.group) || !Number.isSafeInteger(value.workspaceRevision) || Number(value.workspaceRevision) < 0
        : value.group !== undefined || value.workspaceRevision !== undefined)) throw bandwidthError();
  return value as BandwidthJob;
}
const number = (v: unknown, max: number) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max;
function direction(input: unknown): void {
  const value = exact(input, ['status', 'mbps', 'liveMbps', 'bytes'], ['sampleMs', 'warmupMs']);
  if (!['pending', 'running', 'success', 'insufficient', 'failed', 'cancelled'].includes(String(value.status))
      || !number(value.bytes, 200000000) || [value.mbps, value.liveMbps].some(v => v !== null && !number(v, 1000000))
      || ['sampleMs', 'warmupMs'].some(k => value[k] !== undefined && !number(value[k], 40000))) throw bandwidthError();
}
export function parseBandwidthReport(input: unknown): BandwidthReport {
  const value = exact(input, [], ['phase', 'bytesUsed', 'download', 'upload', 'latency', 'reason']);
  if (value.phase !== undefined && !['preparing', 'latency', 'download', 'upload', 'finishing'].includes(String(value.phase))) throw bandwidthError();
  if (value.bytesUsed !== undefined && !number(value.bytesUsed, 200000000)) throw bandwidthError();
  if (value.download !== undefined) direction(value.download);
  if (value.upload !== undefined) direction(value.upload);
  if (value.latency !== undefined) {
    const latencies = exact(value.latency, ['idle', 'download', 'upload']);
    if (Object.values(latencies).some(v => v !== null && !number(v, 40000))) throw bandwidthError();
  }
  if (value.reason !== undefined && value.reason !== null && !BANDWIDTH_WORKER_ERRORS.has(String(value.reason))) throw bandwidthError();
  return value as BandwidthReport & { download?: BandwidthDirection };
}
