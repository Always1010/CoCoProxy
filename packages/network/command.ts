import { spawn } from 'node:child_process';
import { posix } from 'node:path';

export class NetworkCommandError extends Error {
  readonly code: string;
  /** False forbids issuing a recovery mutation alongside an unsettled process. */
  readonly childSettled: boolean;
  constructor(code: string, childSettled = true) {
    super(code); this.name = 'NetworkCommandError'; this.code = code; this.childSettled = childSettled;
  }
}

export interface NetworkCommandOptions {
  input?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

/** Bounded transport for trusted fixed ip/nft clients, not an authorization API. */
export async function runNetworkCommand(binary: string, args: readonly string[], options: NetworkCommandOptions = {}): Promise<string> {
  const timeout = options.timeoutMs ?? 15_000;
  const maximum = options.maxOutputBytes ?? 1_048_576;
  if (process.platform !== 'linux' || typeof binary !== 'string' || !posix.isAbsolute(binary) ||
    /[\u0000-\u001f\u007f]/.test(binary) || !Array.isArray(args) || args.length > 64 ||
    args.some(arg => typeof arg !== 'string' || arg.length > 16_384 || /[\u0000-\u001f\u007f]/.test(arg)) ||
    !Number.isSafeInteger(timeout) || timeout < 1 || timeout > 60_000 ||
    !Number.isSafeInteger(maximum) || maximum < 1 || maximum > 4_194_304 ||
    (options.input !== undefined && (typeof options.input !== 'string' || options.input.includes('\0') ||
      Buffer.byteLength(options.input) > 262_144))) throw new NetworkCommandError('NETWORK_COMMAND_INVALID');
  return new Promise((resolve, reject) => {
    const hasInput = !!options.input?.length;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(binary, [...args], { shell: false, detached: true, windowsHide: true,
        stdio: [hasInput ? 'pipe' : 'ignore', 'pipe', 'pipe'], env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C', LC_ALL: 'C' } });
    } catch { reject(new NetworkCommandError('NETWORK_COMMAND_UNAVAILABLE')); return; }
    let bytes = 0, closed = false, escalated = false, settled = false;
    let code: number | null = null, failure: string | null = null;
    const chunks: Buffer[] = [];
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let finalTimer: ReturnType<typeof setTimeout> | undefined;
    const signal = (name: NodeJS.Signals) => { try { if (child.pid) process.kill(-child.pid, name); } catch {} };
    const finish = (forced = false) => {
      if (settled || (!closed && !forced) || (failure !== null && !escalated)) return;
      settled = true;
      clearTimeout(timer); clearTimeout(killTimer); clearTimeout(finalTimer);
      if (!closed) reject(new NetworkCommandError('NETWORK_COMMAND_UNSETTLED', false));
      else if (failure) reject(new NetworkCommandError(failure));
      else if (code !== 0) reject(new NetworkCommandError('NETWORK_COMMAND_FAILED'));
      else {
        try { resolve(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
        catch { reject(new NetworkCommandError('NETWORK_COMMAND_INVALID_OUTPUT')); }
      }
    };
    const fail = (reason: string) => {
      if (failure || settled) return;
      failure = reason;
      signal('SIGTERM');
      // Wait through escalation even if the immediate client exits first: its
      // descendants must not race a subsequent blocked-state restoration.
      killTimer = setTimeout(() => {
        signal('SIGKILL'); escalated = true;
        child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy();
        finish();
        if (!settled) finalTimer = setTimeout(() => { child.unref(); finish(true); }, 250);
      }, 250);
    };
    const timer = setTimeout(() => fail('NETWORK_COMMAND_TIMEOUT'), timeout);
    const consume = (chunk: Buffer, retain: boolean) => {
      bytes += chunk.length;
      if (bytes > maximum) fail('NETWORK_COMMAND_OUTPUT_LIMIT');
      else if (retain && !failure) chunks.push(chunk);
    };
    child.stdout!.on('data', chunk => consume(chunk, true));
    child.stderr!.on('data', chunk => consume(chunk, false));
    child.stdin?.on('error', () => { if (!closed) fail('NETWORK_COMMAND_FAILED'); });
    child.once('error', () => {
      if (!child.pid) { failure = 'NETWORK_COMMAND_UNAVAILABLE'; escalated = true; }
      else fail('NETWORK_COMMAND_FAILED');
    });
    child.once('close', exit => { closed = true; code = exit; finish(); });
    if (hasInput) child.stdin!.end(options.input);
  });
}
