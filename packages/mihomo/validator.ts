import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { canonicalJson } from '../config/index.ts';
import type { Candidate } from '../config/index.ts';

export class MihomoValidationError extends Error {
  code: string;

  constructor(code: string) {
    super(code);
    this.name = 'MihomoValidationError';
    this.code = code;
  }
}

export interface ValidationOptions {
  binaryPath: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

/** Validate only: never download a binary, start a service, or change routing. */
export async function validateWithMihomo(
  candidate: Candidate,
  options: ValidationOptions,
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const maxOutputBytes = options.maxOutputBytes ?? 65_536;
  if (!isAbsolute(options.binaryPath)) {
    throw new MihomoValidationError('BINARY_PATH_MUST_BE_ABSOLUTE');
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000
      || !Number.isInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > 1_048_576) {
    throw new MihomoValidationError('INVALID_VALIDATION_LIMIT');
  }
  let binary: string;
  try {
    binary = await realpath(options.binaryPath);
    if (!(await stat(binary)).isFile()) throw new Error();
  } catch {
    throw new MihomoValidationError('BINARY_UNAVAILABLE');
  }
  const work = await mkdtemp(join(tmpdir(), 'cocoproxy-validate-'));
  try {
    const home = join(work, 'home');
    const config = join(work, 'candidate.json');
    await mkdir(home, { mode: 0o700 });
    await writeFile(config, canonicalJson(candidate.config) + '\n', { mode: 0o600, flag: 'wx' });
    await runValidation(binary, ['-t', '-d', home, '-f', config], work, timeoutMs, maxOutputBytes);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

function runValidation(
  binary: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  maxOutputBytes: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    // A separate Linux process group lets timeout cleanup include descendants.
    const grouped = process.platform === 'linux';
    const child = spawn(binary, args, {
      cwd,
      shell: false,
      detached: grouped,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let bytes = 0;
    let failure: string | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let finalTimer: ReturnType<typeof setTimeout> | undefined;
    let finished = false;
    let closed = false;
    let closeCode: number | null = null;
    let escalated = false;
    const signal = (name: NodeJS.Signals) => {
      try {
        if (grouped && child.pid) process.kill(-child.pid, name);
        else child.kill(name);
      } catch { /* The process may already have exited. */ }
    };
    const fail = (code: string) => {
      if (failure || finished) return;
      failure = code;
      signal('SIGTERM');
      killTimer = setTimeout(() => {
        signal('SIGKILL');
        escalated = true;
        // A detached descendant can inherit these pipes after leaving the
        // process group. Do not let it prevent close or retain secret output.
        child.stdout.destroy();
        child.stderr.destroy();
        finish();
        if (!finished) finalTimer = setTimeout(() => {
          child.unref();
          finish(true);
        }, 250);
      }, 250);
    };
    const timer = setTimeout(() => fail('VALIDATION_TIMEOUT'), timeoutMs);
    const finish = (forced = false) => {
      // Even if the direct child exits on SIGTERM, finish group cleanup before
      // settling: descendants may have closed stdio and ignored termination.
      if (finished || (!closed && !forced) || (failure && !escalated)) return;
      finished = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (finalTimer) clearTimeout(finalTimer);
      if (failure) reject(new MihomoValidationError(failure));
      else if (closeCode !== 0) reject(new MihomoValidationError('CORE_CONFIG_REJECTED'));
      else resolve();
    };
    const consume = (data: Buffer) => {
      bytes += data.byteLength;
      // Deliberately do not persist or return core output: it may contain secrets.
      if (bytes > maxOutputBytes) fail('VALIDATION_OUTPUT_LIMIT');
    };
    child.stdout.on('data', consume);
    child.stderr.on('data', consume);
    child.on('error', () => {
      failure ??= 'VALIDATION_EXEC_FAILED';
      if (!child.pid) escalated = true;
    });
    child.on('close', (code) => {
      closed = true;
      closeCode = code;
      finish();
    });
  });
}
