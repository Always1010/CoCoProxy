import { spawn } from 'node:child_process';
import type { ChildProcessByStdio } from 'node:child_process';
import { posix } from 'node:path';
import type { Readable } from 'node:stream';
import { RuntimeError } from './types.ts';

export interface CommandLimits { timeoutMs?: number; maxOutputBytes?: number }

/** Bounded client execution. Killing systemctl does not cancel its systemd job. */
export function runRuntimeCommand(binary: string, args: string[], limits: CommandLimits = {}): Promise<string> {
  const timeout = limits.timeoutMs ?? 15_000;
  const maximum = limits.maxOutputBytes ?? 16_384;
  if (process.platform !== 'linux' || typeof binary !== 'string' || !posix.isAbsolute(binary) || /[\u0000-\u001f\u007f]/.test(binary) ||
      !Array.isArray(args) || args.length > 64 || args.some(arg => typeof arg !== 'string' || arg.length > 16_384 || /[\u0000-\u001f\u007f]/.test(arg)) ||
      !Number.isSafeInteger(timeout) || timeout < 1 || timeout > 60_000 ||
      !Number.isSafeInteger(maximum) || maximum < 1 || maximum > 1_048_576) throw new RuntimeError('RUNTIME_COMMAND_INVALID');
  return new Promise((resolve, reject) => {
    let child: ChildProcessByStdio<null, Readable, Readable>;
    try {
      child = spawn(binary, args, { shell: false, detached: true, windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin', LANG: 'C', SYSTEMD_COLORS: '0', SYSTEMD_PAGER: '' } });
    } catch { reject(new RuntimeError('RUNTIME_COMMAND_FAILED')); return; }
    const chunks: Buffer[] = [];
    let bytes = 0;
    let failure: string | null = null;
    let closed = false;
    let closeCode: number | null = null;
    let escalated = false;
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let finalTimer: ReturnType<typeof setTimeout> | undefined;
    const signal = (name: NodeJS.Signals) => { try { if (child.pid) process.kill(-child.pid, name); } catch { /* already gone */ } };
    const finish = (forced = false) => {
      if (settled || (!closed && !forced) || (failure !== null && !escalated)) return;
      settled = true;
      clearTimeout(timer); clearTimeout(killTimer); clearTimeout(finalTimer);
      if (failure !== null) reject(new RuntimeError(failure));
      else if (closeCode !== 0) reject(new RuntimeError('RUNTIME_COMMAND_FAILED'));
      else {
        try { resolve(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
        catch { reject(new RuntimeError('RUNTIME_COMMAND_INVALID_OUTPUT')); }
      }
    };
    const fail = (code: string) => {
      if (failure !== null || settled) return;
      failure = code;
      signal('SIGTERM');
      killTimer = setTimeout(() => {
        signal('SIGKILL'); escalated = true;
        child.stdout.destroy(); child.stderr.destroy(); finish();
        if (!settled) finalTimer = setTimeout(() => { child.unref(); finish(true); }, 250);
      }, 250);
    };
    const timer = setTimeout(() => fail('RUNTIME_COMMAND_TIMEOUT'), timeout);
    const consume = (chunk: Buffer, retain: boolean) => {
      bytes += chunk.length;
      if (bytes > maximum) fail('RUNTIME_COMMAND_OUTPUT_LIMIT');
      else if (retain) chunks.push(chunk);
    };
    child.stdout.on('data', data => consume(data, true));
    child.stderr.on('data', data => consume(data, false));
    child.on('error', () => { if (!child.pid) { failure = 'RUNTIME_COMMAND_UNAVAILABLE'; escalated = true; } else fail('RUNTIME_COMMAND_FAILED'); });
    child.on('close', code => { closed = true; closeCode = code; finish(); });
  });
}
