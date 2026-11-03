import { randomUUID } from 'node:crypto';
import { connect } from 'node:net';
import { lstat } from 'node:fs/promises';
import { BANDWIDTH_WORKER_SOCKET } from '../runtime/bandwidth-worker-plan.ts';
import { BANDWIDTH_FRAME_LIMIT, BANDWIDTH_WORKER_ERRORS, bandwidthError, parseBandwidthJob, parseBandwidthReport } from '../runtime/bandwidth-protocol.ts';
import type { TransferInput } from './bandwidth-transport.ts';

export function createBandwidthWorkerClient(options: { socketPath?: string; settingsPath?: string } = {}) {
  const path = options.socketPath ?? BANDWIDTH_WORKER_SOCKET;
  let cached: { available: boolean; key: string; reason: string | null } = { available: false, key: 'initial', reason: 'BANDWIDTH_WORKER_UNAVAILABLE' };
  let checked = 0, checking: Promise<typeof cached> | undefined;
  async function availability() {
    if (Date.now() - checked < 5000) return cached;
    if (checking) return checking;
    checking = (async () => {
      try {
        const stat = await lstat(path, { bigint: true });
        if (!stat.isSocket() || stat.isSymbolicLink() || stat.uid !== BigInt(process.geteuid?.() ?? -1) || (stat.mode & 0o077n) !== 0n) throw bandwidthError();
        let policy = '';
        if (options.settingsPath) {
          const settings = await lstat(options.settingsPath, { bigint: true });
          if (!settings.isFile() || settings.isSymbolicLink() || settings.uid !== 0n || (settings.mode & 0o022n) !== 0n) throw bandwidthError();
          policy = [settings.dev, settings.ino, settings.ctimeNs, settings.size].join(':');
        }
        if (!options.socketPath) {
          for (const unit of ['cocoproxy-bandwidth.service', 'cocoproxy-bandwidth.socket']) {
            const installed = await lstat('/etc/systemd/system/' + unit, { bigint: true });
            if (!installed.isFile() || installed.isSymbolicLink() || installed.uid !== 0n || (installed.mode & 0o022n) !== 0n) throw bandwidthError();
            policy += ':' + [installed.dev, installed.ino, installed.ctimeNs].join(':');
          }
        }
        cached = { available: true, key: [stat.dev, stat.ino, stat.ctimeNs, policy].join(':'), reason: null };
      } catch { cached = { available: false, key: 'unavailable', reason: 'BANDWIDTH_WORKER_UNAVAILABLE' }; }
      checked = Date.now(); return cached;
    })().finally(() => { checking = undefined; });
    return checking;
  }
  return {
    availability, state: () => cached,
    async transfer(input: TransferInput): Promise<{ reason: string | null }> {
      if (input.signal.aborted) throw bandwidthError('BANDWIDTH_CANCELLED');
      if (!(await availability()).available) throw bandwidthError();
      const job = parseBandwidthJob({ version: 1, id: randomUUID(), generation: input.generation, node: input.node,
        kind: input.verification ? 'automatic' : 'manual', ...(input.verification ? { group: input.group, workspaceRevision: input.workspaceRevision } : {}) });
      return new Promise((resolve, reject) => {
        const socket = connect(path);
        let buffer = '', sent = false, cancelling = false, timedOut = false, observedBytes = 0;
        let terminal: { reason: string | null } | { error: string } | undefined, frames = 0;
        const abort = () => {
          if (sent && !cancelling && !socket.destroyed) { cancelling = true; socket.end(JSON.stringify({ cancel: job.id }) + '\n'); }
        };
        const timeout = setTimeout(() => { timedOut = true; abort(); }, input.limits.timeoutMs);
        // Leave room for the trusted service's 45 s cgroup lifetime and stop timeout if IPC fails.
        const watchdog = setTimeout(() => socket.destroy(bandwidthError('BANDWIDTH_TIMEOUT')), 50000);
        input.signal.addEventListener('abort', abort, { once: true });
        socket.setEncoding('utf8');
        socket.once('connect', () => { socket.write(JSON.stringify(job) + '\n'); sent = true; if (input.signal.aborted || timedOut) abort(); });
        socket.on('data', chunk => {
          buffer += chunk;
          if (Buffer.byteLength(buffer) > BANDWIDTH_FRAME_LIMIT * 2) { socket.destroy(bandwidthError()); return; }
          for (;;) {
            const end = buffer.indexOf('\n'); if (end < 0) break;
            const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
            try {
              if (terminal || Buffer.byteLength(line) > BANDWIDTH_FRAME_LIMIT || ++frames > 20000) throw bandwidthError();
              const message = JSON.parse(line);
              if (message.id !== job.id || message.version !== 1) throw bandwidthError();
              if (message.type === 'report' && Object.keys(message).length === 4) {
                const report = parseBandwidthReport(message.report);
                observedBytes = Math.max(observedBytes, report.bytesUsed ?? 0);
                try { input.report(report); } catch { /* Report observers cannot skip worker cleanup. */ }
              }
              else if (message.type === 'result' && Object.keys(message).length === 4
                  && (message.reason === null || BANDWIDTH_WORKER_ERRORS.has(message.reason))) terminal = { reason: message.reason };
              else if (message.type === 'error' && Object.keys(message).length === 4 && BANDWIDTH_WORKER_ERRORS.has(message.code)) terminal = { error: message.code };
              else throw bandwidthError();
            } catch { socket.destroy(bandwidthError()); return; }
          }
        });
        let failure: Error | undefined;
        socket.once('error', error => { failure = error; });
        socket.once('close', () => {
          clearTimeout(timeout); clearTimeout(watchdog); input.signal.removeEventListener('abort', abort);
          if (sent && (!terminal || failure || buffer) && input.verification) {
            // A lost channel cannot prove the final byte count or that cleanup finished. Retain the durable maximum.
            try { input.report({ bytesUsed: input.limits.maxBytes }); } catch { /* Preserve termination. */ }
          }
          if (input.signal.aborted) reject(bandwidthError('BANDWIDTH_CANCELLED'));
          else if (timedOut) reject(bandwidthError('BANDWIDTH_TIMEOUT'));
          else if (failure || buffer || !terminal) reject(bandwidthError(sent ? 'BANDWIDTH_UNAVAILABLE' : 'BANDWIDTH_WORKER_UNAVAILABLE'));
          else if ('error' in terminal) reject(bandwidthError(terminal.error === 'BANDWIDTH_WORKER_UNAVAILABLE' && observedBytes > 0
            ? 'BANDWIDTH_UNAVAILABLE' : terminal.error));
          else resolve(terminal);
        });
      });
    },
  };
}
