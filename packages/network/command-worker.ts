// Fixed internal entry point. This module is never selected by client input.
import { spawn } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { fencedCommandSHA, fencedProcessIdentity, fencedReceiptName, fencedResultName,
  fencedPrivateRead, fencedPrivateWrite, inspectFencedDirectory, sameFencedIdentity, validateFencedCommand } from './fenced-command.ts';
import type { FencedCommandReceipt, FencedCommandScope, FencedWorkerIdentity } from './fenced-command.ts';
import type { NetworkCommandOptions } from './command.ts';

interface Init { type: 'init'; root: string; token: string; commandSHA: string; binary: string; args: string[]; options: NetworkCommandOptions; scope?: FencedCommandScope }
let init: Init | undefined, worker: FencedWorkerIdentity | undefined;
let acknowledged = false, stopping = false, completed = false;
let child: ReturnType<typeof spawn> | undefined;
let commandTimer: ReturnType<typeof setTimeout> | undefined;
let killTimer: ReturnType<typeof setTimeout> | undefined;
let failure: string | undefined;
const chunks: Buffer[] = [];
let bytes = 0;

const killGroup = (signal: NodeJS.Signals) => { try { process.kill(-process.pid, signal); } catch { process.exit(1); } };
async function storeResult(ok: boolean, stdout: string, code: string): Promise<void> {
  if (!init || !worker) return;
  await fencedPrivateWrite(init.root, fencedResultName(init.token), JSON.stringify({ version: 1, token: init.token,
    commandSHA: init.commandSHA, worker, ok, stdoutBase64: Buffer.from(stdout, 'utf8').toString('base64'), code }), init.scope);
}
function stop(reason?: string): void {
  if (stopping || completed) return;
  stopping = true; failure = reason;
  clearTimeout(commandTimer); clearTimeout(startTimer);
  if (!acknowledged) { process.exit(1); }
  // The leader catches its own TERM, retaining the final KILL even when its tool exits.
  killTimer = setTimeout(() => killGroup('SIGKILL'), 300);
  killGroup('SIGTERM');
  if (reason) void storeResult(false, '', reason).catch(() => {});
}
process.on('SIGTERM', () => stop());
process.on('SIGINT', () => stop());
process.on('disconnect', () => stop());
const startTimer = setTimeout(() => stop(), 5000);

async function execute(): Promise<void> {
  if (!init || !worker || stopping || acknowledged || !process.connected) return;
  const receipt = JSON.parse(await fencedPrivateRead(init.root, fencedReceiptName(init.token), 8192, init.scope)) as FencedCommandReceipt;
  if (receipt.version !== 1 || receipt.token !== init.token || receipt.commandSHA !== init.commandSHA ||
    !sameFencedIdentity(receipt, worker) || stopping || !process.connected) return stop();
  acknowledged = true; clearTimeout(startTimer);
  const maximum = init.options.maxOutputBytes ?? 1_048_576;
  const input = init.options.input;
  const hasInput = typeof input === 'string' && input.length > 0;
  commandTimer = setTimeout(() => stop('NETWORK_COMMAND_TIMEOUT'), init.options.timeoutMs ?? 15_000);
  child = spawn(init.binary, init.args, { detached: false, shell: false, windowsHide: true,
    stdio: [hasInput ? 'pipe' : 'ignore', 'pipe', 'pipe'], env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C', LC_ALL: 'C' } });
  const consume = (chunk: Buffer, retain: boolean) => {
    bytes += chunk.length;
    if (bytes > maximum) stop('NETWORK_COMMAND_OUTPUT_LIMIT');
    else if (retain && !stopping) chunks.push(chunk);
  };
  child.stdout!.on('data', chunk => consume(chunk, true));
  child.stderr!.on('data', chunk => consume(chunk, false));
  if (hasInput) child.stdin!.on('error', () => { if (!completed) stop('NETWORK_COMMAND_FAILED'); });
  child.once('error', () => { failure = 'NETWORK_COMMAND_UNAVAILABLE'; });
  child.once('close', code => { void finish(code); });
  if (hasInput) child.stdin!.end(input);
}
async function finish(code: number | null): Promise<void> {
  if (stopping || completed) return;
  clearTimeout(commandTimer);
  let stdout = '';
  if (!failure && code !== 0) failure = 'NETWORK_COMMAND_FAILED';
  if (!failure) {
    try { stdout = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks)); }
    catch { failure = 'NETWORK_COMMAND_INVALID_OUTPUT'; }
  }
  // Even a zero-exit client must not leave descendants capable of a late mutation.
  // Trusted ip/nft do not daemonize; treat any remaining member as a failed job.
  try {
    for (const entry of await readdir('/proc')) {
      if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue;
      let stat: string;
      try { stat = await readFile(`/proc/${entry}/stat`, 'utf8'); }
      catch (cause) { if (['ENOENT', 'ESRCH'].includes((cause as NodeJS.ErrnoException)?.code ?? '')) continue; throw cause; }
      const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
      if (Number(fields[2]) === process.pid && !['Z', 'X'].includes(fields[0]!)) return stop('NETWORK_COMMAND_FAILED');
    }
  } catch { stop(); return; }
  if (failure) return stop(failure);
  // Keep the group leader alive until file + rename + directory fsync all finish.
  try { await storeResult(!failure, failure ? '' : stdout, failure ?? ''); }
  catch { stop(); return; }
  if (stopping) return;
  completed = true; clearTimeout(killTimer);
  if (process.connected) process.disconnect();
  process.exit(failure ? 1 : 0);
}
process.on('message', message => {
  if (!message || typeof message !== 'object' || stopping || completed) return;
  const value = message as Init | { type: 'ack'; token: string; commandSHA: string };
  if (value.type === 'init' && !init) {
    init = value;
    void (async () => {
      validateFencedCommand(value.binary, value.args, value.options);
      if (!/^[A-Za-z0-9_-]{16,96}$/.test(value.token) || fencedCommandSHA(value.binary, value.args, value.options) !== value.commandSHA) throw new Error();
      await inspectFencedDirectory(value.root, value.scope);
      const { state: _state, ...identity } = await fencedProcessIdentity(process.pid);
      worker = identity;
      if (!stopping && process.connected) process.send!({ type: 'ready' });
    })().catch(() => stop());
  } else if (value.type === 'ack' && init && value.token === init.token && value.commandSHA === init.commandSHA) {
    void execute().catch(() => stop());
  }
});
