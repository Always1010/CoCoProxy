import { fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import type { Stats } from 'node:fs';
import { lstat, open, readFile, readlink, readdir } from 'node:fs/promises';
import { dirname, join, posix } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { atomicWrite } from '../storage/private-files.ts';
import { NetworkCommandError } from './command.ts';
import type { NetworkCommandOptions } from './command.ts';

export interface FencedWorkerIdentity {
  bootID: string; pid: number; startTime: string; userNS: string; netNS: string; uid: number; pgid: number; sid: number;
}
export interface FencedCommandReceipt extends FencedWorkerIdentity { version: 1; token: string; commandSHA: string }
export interface FencedCommandResult {
  version: 1; token: string; commandSHA: string; worker: FencedWorkerIdentity;
  ok: boolean; stdout: string; code: string;
}
export interface FencedCommandInspection {
  state: 'absent' | 'settled' | 'running' | 'uncertain';
  receipt?: FencedCommandReceipt; result?: FencedCommandResult;
}
/** Fixture proof comes only from the trusted outer namespace test supervisor. */
export type FencedCommandScope = 'production' | { scope: 'fixture'; outerUser: string; outerNet: string };
const error = (code: string, settled = true): NetworkCommandError => new NetworkCommandError(code, settled);
/** All ancestors must be immutable to other UIDs; root-owned sticky temp roots are safe boundaries. */
export async function inspectFencedDirectory(root: string, scope: FencedCommandScope = 'production'): Promise<void> {
  try {
    let unmappedRoot = false;
    if (scope !== 'production') {
      if (!exactKeys(scope, ['scope', 'outerUser', 'outerNet']) || scope.scope !== 'fixture' ||
        typeof scope.outerUser !== 'string' || !/^user:\[\d+\]$/.test(scope.outerUser) ||
        typeof scope.outerNet !== 'string' || !/^net:\[\d+\]$/.test(scope.outerNet)) throw new Error();
      const [user, net] = await Promise.all([readlink('/proc/self/ns/user'), readlink('/proc/self/ns/net')]);
      if (user === scope.outerUser || net === scope.outerNet) throw new Error();
      unmappedRoot = true;
    }
    if (process.platform !== 'linux' || typeof root !== 'string' || !posix.isAbsolute(root) || posix.normalize(root) !== root ||
      root.length > 4096 || /[\u0000-\u001f\u007f]/.test(root)) throw new Error();
    for (let current = root;; current = dirname(current)) {
      const stat = await lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink() || ![0, process.geteuid!(), ...(unmappedRoot ? [65534] : [])].includes(stat.uid)) throw new Error();
      if (current === root) {
        if (stat.uid !== process.geteuid!() || (stat.mode & 0o7777) !== 0o700) throw new Error();
      } else if ((stat.mode & 0o022) !== 0 && !((stat.uid === 0 || (unmappedRoot && stat.uid === 65534)) && (stat.mode & 0o1000) !== 0)) throw new Error();
      if (current === '/') break;
    }
  } catch { throw error('NETWORK_COMMAND_FENCE_UNSAFE', false); }
}
function checkPrivateStat(stat: Stats): void {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.geteuid!() ||
    (stat.mode & 0o7777) !== 0o600) throw error('NETWORK_COMMAND_FENCE_UNSAFE', false);
}
/** Fixed basenames only; reject hardlinks as well as symlinks before consuming state. */
export async function fencedPrivateRead(root: string, name: string, limit: number, scope: FencedCommandScope = 'production'): Promise<string> {
  await inspectFencedDirectory(root, scope);
  if (!/^job-[A-Za-z0-9_-]{16,96}\.(start|result)\.json$/.test(name) || !Number.isSafeInteger(limit) || limit < 1 || limit > 6 * 1024 * 1024)
    throw error('NETWORK_COMMAND_FENCE_UNSAFE', false);
  const path = join(root, name), before = await lstat(path); checkPrivateStat(before);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat(); checkPrivateStat(stat);
    if (stat.ino !== before.ino || stat.dev !== before.dev || stat.size > limit) throw error('NETWORK_COMMAND_FENCE_CORRUPT', false);
    const buffer = Buffer.alloc(limit + 1); let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break; length += bytesRead;
    }
    if (length > limit) throw error('NETWORK_COMMAND_FENCE_CORRUPT', false);
    checkPrivateStat(await handle.stat());
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, length));
  } finally { await handle.close(); }
}
export async function fencedPrivateWrite(root: string, name: string, contents: string, scope: FencedCommandScope = 'production'): Promise<void> {
  await inspectFencedDirectory(root, scope);
  if (!/^job-[A-Za-z0-9_-]{16,96}\.(start|result)\.json$/.test(name) || Buffer.byteLength(contents) > 6 * 1024 * 1024)
    throw error('NETWORK_COMMAND_FENCE_UNSAFE', false);
  try { checkPrivateStat(await lstat(join(root, name))); }
  catch (cause) { if ((cause as NodeJS.ErrnoException)?.code !== 'ENOENT') throw cause; }
  await atomicWrite(root, name, contents);
  await inspectFencedDirectory(root, scope); checkPrivateStat(await lstat(join(root, name)));
}
export const fencedReceiptName = (token: string): string => { checkToken(token); return `job-${token}.start.json`; };
export const fencedResultName = (token: string): string => { checkToken(token); return `job-${token}.result.json`; };
function checkToken(token: string): void {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{16,96}$/.test(token)) throw error('NETWORK_COMMAND_INVALID');
}
export function fencedCommandSHA(binary: string, args: readonly string[], options: NetworkCommandOptions = {}): string {
  return createHash('sha256').update(JSON.stringify([binary, args, options.input ?? '', options.timeoutMs ?? 15_000,
    options.maxOutputBytes ?? 1_048_576])).digest('hex');
}
export const fencedNetworkCommandDigest = fencedCommandSHA;
export function validateFencedCommand(binary: string, args: readonly string[], options: NetworkCommandOptions): void {
  const timeout = options.timeoutMs ?? 15_000, maximum = options.maxOutputBytes ?? 1_048_576;
  if (process.platform !== 'linux' || typeof binary !== 'string' || binary.length > 4096 || !posix.isAbsolute(binary) ||
    /[\u0000-\u001f\u007f]/.test(binary) || !Array.isArray(args) || args.length > 64 ||
    args.some(arg => typeof arg !== 'string' || arg.length > 16_384 || /[\u0000-\u001f\u007f]/.test(arg)) ||
    !Number.isSafeInteger(timeout) || timeout < 1 || timeout > 60_000 ||
    !Number.isSafeInteger(maximum) || maximum < 1 || maximum > 4_194_304 ||
    (options.input !== undefined && (typeof options.input !== 'string' || options.input.includes('\0') ||
      Buffer.byteLength(options.input) > 262_144))) throw error('NETWORK_COMMAND_INVALID');
}

/** /proc identity is read twice around namespace/status reads to reject a reused PID. */
export async function fencedProcessIdentity(pid: number): Promise<FencedWorkerIdentity & { state: string }> {
  const path = `/proc/${pid}`;
  const first = await readFile(`${path}/stat`, 'utf8');
  const fields = first.slice(first.lastIndexOf(')') + 2).trim().split(/\s+/);
  const [bootID, userNS, netNS, status] = await Promise.all([
    readFile('/proc/sys/kernel/random/boot_id', 'utf8'), readlink(`${path}/ns/user`),
    readlink(`${path}/ns/net`), readFile(`${path}/status`, 'utf8'),
  ]);
  const second = await readFile(`${path}/stat`, 'utf8');
  const again = second.slice(second.lastIndexOf(')') + 2).trim().split(/\s+/);
  const uid = /^Uid:\s+\d+\s+(\d+)/m.exec(status)?.[1];
  if (!uid || fields[19] !== again[19] || fields[2] !== again[2] || fields[3] !== again[3]) throw error('NETWORK_COMMAND_UNSETTLED', false);
  return { bootID: bootID.trim(), pid, startTime: fields[19]!, userNS, netNS, uid: Number(uid),
    pgid: Number(fields[2]), sid: Number(fields[3]), state: again[0]! };
}
export function sameFencedIdentity(left: FencedWorkerIdentity, right: FencedWorkerIdentity): boolean {
  return ['bootID', 'pid', 'startTime', 'userNS', 'netNS', 'uid', 'pgid', 'sid'].every(key =>
    left[key as keyof FencedWorkerIdentity] === right[key as keyof FencedWorkerIdentity]);
}
const identityKeys = ['bootID', 'pid', 'startTime', 'userNS', 'netNS', 'uid', 'pgid', 'sid'];
function exactKeys(value: unknown, keys: readonly string[]): boolean {
  return !!value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function validIdentity(value: FencedWorkerIdentity): boolean {
  return !!value && typeof value === 'object' && typeof value.bootID === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value.bootID) &&
    Number.isSafeInteger(value.pid) && value.pid > 1 && value.pid <= 2_147_483_647 && value.pgid === value.pid && value.sid === value.pid &&
    Number.isSafeInteger(value.uid) && value.uid >= 0 && value.uid <= 4_294_967_295 && typeof value.startTime === 'string' && /^[1-9]\d{0,29}$/.test(value.startTime) &&
    typeof value.userNS === 'string' && /^user:\[\d{1,20}\]$/.test(value.userNS) && typeof value.netNS === 'string' && /^net:\[\d{1,20}\]$/.test(value.netNS);
}
async function optionalJSON(root: string, name: string, limit: number, scope: FencedCommandScope): Promise<unknown | undefined> {
  try { return JSON.parse(await fencedPrivateRead(root, name, limit, scope)); }
  catch (cause) { if ((cause as NodeJS.ErrnoException)?.code === 'ENOENT') return undefined; throw error('NETWORK_COMMAND_FENCE_CORRUPT', false); }
}
async function receiptAt(root: string, token: string, scope: FencedCommandScope): Promise<FencedCommandReceipt | undefined> {
  const value = await optionalJSON(root, fencedReceiptName(token), 8192, scope) as FencedCommandReceipt | undefined;
  if (value === undefined) return undefined;
  if (!exactKeys(value, [...identityKeys, 'version', 'token', 'commandSHA']) || !validIdentity(value) || value.version !== 1 || value.token !== token || typeof value.commandSHA !== 'string' || !/^[0-9a-f]{64}$/.test(value.commandSHA))
    throw error('NETWORK_COMMAND_FENCE_CORRUPT', false);
  return value;
}
async function resultAt(root: string, receipt: FencedCommandReceipt, scope: FencedCommandScope): Promise<FencedCommandResult | undefined> {
  const raw = await optionalJSON(root, fencedResultName(receipt.token), 6 * 1024 * 1024, scope) as (Omit<FencedCommandResult, 'stdout'> & { stdoutBase64: string }) | undefined;
  if (raw === undefined) return undefined;
  if (!exactKeys(raw, ['version', 'token', 'commandSHA', 'worker', 'ok', 'stdoutBase64', 'code']) ||
    !raw || typeof raw.stdoutBase64 !== 'string' || raw.stdoutBase64.length > 5_592_408 || !exactKeys(raw.worker, identityKeys)) throw error('NETWORK_COMMAND_FENCE_CORRUPT', false);
  const bytes = Buffer.from(raw.stdoutBase64, 'base64');
  if (bytes.toString('base64') !== raw.stdoutBase64) throw error('NETWORK_COMMAND_FENCE_CORRUPT', false);
  let stdout: string;
  try { stdout = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { throw error('NETWORK_COMMAND_FENCE_CORRUPT', false); }
  const { stdoutBase64: _encoded, ...rest } = raw;
  const value: FencedCommandResult = { ...rest, stdout };
  if (!value || value.version !== 1 || value.token !== receipt.token || value.commandSHA !== receipt.commandSHA ||
    !validIdentity(value.worker) || !sameFencedIdentity(value.worker, receipt) || typeof value.ok !== 'boolean' ||
    typeof value.stdout !== 'string' || Buffer.byteLength(value.stdout) > 4_194_304 ||
    !['', 'NETWORK_COMMAND_FAILED', 'NETWORK_COMMAND_UNAVAILABLE', 'NETWORK_COMMAND_INVALID_OUTPUT',
      'NETWORK_COMMAND_TIMEOUT', 'NETWORK_COMMAND_OUTPUT_LIMIT'].includes(value.code) ||
    (value.ok ? value.code !== '' : value.stdout !== '' || value.code === '')) throw error('NETWORK_COMMAND_FENCE_CORRUPT', false);
  return value;
}

/** A missing/reused leader with live members is deliberately ambiguous: do not signal. */
async function groupState(receipt: FencedCommandReceipt): Promise<'settled' | 'running' | 'uncertain'> {
  try {
    const self = await fencedProcessIdentity(process.pid);
    if (self.bootID !== receipt.bootID) return 'settled';
    if (self.uid !== receipt.uid || self.userNS !== receipt.userNS || self.netNS !== receipt.netNS) return 'uncertain';
    let leader: Awaited<ReturnType<typeof fencedProcessIdentity>> | undefined;
    try { leader = await fencedProcessIdentity(receipt.pid); }
    catch (cause) { if ((cause as NodeJS.ErrnoException)?.code !== 'ENOENT' && (cause as NodeJS.ErrnoException)?.code !== 'ESRCH') return 'uncertain'; }
    let live = false;
    for (const entry of await readdir('/proc')) {
      if (!/^\d+$/.test(entry)) continue;
      // Read stat first: unrelated inaccessible processes need no namespace access.
      let stat: string;
      try { stat = await readFile(`/proc/${entry}/stat`, 'utf8'); }
      catch (cause) { if (['ENOENT', 'ESRCH'].includes((cause as NodeJS.ErrnoException)?.code ?? '')) continue; return 'uncertain'; }
      const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
      if (Number(fields[2]) !== receipt.pid || fields[0] === 'Z' || fields[0] === 'X') continue;
      let member: Awaited<ReturnType<typeof fencedProcessIdentity>>;
      try { member = await fencedProcessIdentity(Number(entry)); }
      catch (cause) { if (['ENOENT', 'ESRCH'].includes((cause as NodeJS.ErrnoException)?.code ?? '')) continue; return 'uncertain'; }
      if (member.uid !== receipt.uid || member.userNS !== receipt.userNS || member.netNS !== receipt.netNS || member.sid !== receipt.sid ||
        member.pgid !== receipt.pgid || BigInt(member.startTime) < BigInt(receipt.startTime)) return 'uncertain';
      live = true;
    }
    if (!live) return 'settled';
    return leader && sameFencedIdentity(leader, receipt) && !['Z', 'X'].includes(leader.state) ? 'running' : 'uncertain';
  } catch { return 'uncertain'; }
}
export async function inspectFencedNetworkCommand(root: string, token: string, scope: FencedCommandScope = 'production'): Promise<FencedCommandInspection> {
  checkToken(token);
  await inspectFencedDirectory(root, scope);
  const receipt = await receiptAt(root, token, scope);
  if (!receipt) {
    if (await optionalJSON(root, fencedResultName(token), 6 * 1024 * 1024, scope) !== undefined) throw error('NETWORK_COMMAND_FENCE_CORRUPT', false);
    return { state: 'absent' };
  }
  const result = await resultAt(root, receipt, scope);
  return { state: await groupState(receipt), receipt, ...(result ? { result } : {}) };
}
export async function readFencedNetworkCommandResult(root: string, token: string, scope: FencedCommandScope = 'production'): Promise<FencedCommandResult | undefined> {
  const inspection = await inspectFencedNetworkCommand(root, token, scope);
  if (inspection.state === 'running' || inspection.state === 'uncertain') throw error('NETWORK_COMMAND_UNSETTLED', false);
  return inspection.result;
}
/** Caller serializes this with all other mutations and retains its transaction fence on uncertainty. */
export async function settleFencedNetworkCommand(root: string, token: string, scope: FencedCommandScope = 'production'): Promise<FencedCommandInspection> {
  let inspection = await inspectFencedNetworkCommand(root, token, scope);
  if (inspection.state !== 'running') return inspection;
  const receipt = inspection.receipt!;
  // A live, matching session leader anchors the group. Recheck directly before each signal.
  if (await groupState(receipt) !== 'running') return inspectFencedNetworkCommand(root, token, scope);
  try { process.kill(-receipt.pid, 'SIGTERM'); } catch {}
  await delay(300);
  inspection = await inspectFencedNetworkCommand(root, token, scope);
  if (inspection.state === 'running' && await groupState(receipt) === 'running') {
    try { process.kill(-receipt.pid, 'SIGKILL'); } catch {}
    await delay(150);
  }
  return inspectFencedNetworkCommand(root, token, scope);
}

/** Internal transport for trusted fixed network tools. root is private, caller-selected, and locked. */
export async function runFencedNetworkCommand(root: string, token: string, binary: string, args: readonly string[], options: NetworkCommandOptions = {}, scope: FencedCommandScope = 'production'): Promise<string> {
  checkToken(token); validateFencedCommand(binary, args, options);
  const previous = await inspectFencedNetworkCommand(root, token, scope);
  if (previous.state !== 'absent') throw error('NETWORK_COMMAND_TOKEN_USED', previous.state === 'settled');
  const commandSHA = fencedCommandSHA(binary, args, options);
  let child: ReturnType<typeof fork>;
  try {
    child = fork(new URL('./command-worker.ts', import.meta.url), [], { detached: true,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'], execArgv: ['--experimental-strip-types'],
      env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C', LC_ALL: 'C' } });
  } catch { throw error('NETWORK_COMMAND_UNAVAILABLE'); }
  let receipt: FencedCommandReceipt | undefined;
  let startupFailure = false;
  let writing: Promise<void> = Promise.resolve();
  const exited = new Promise<void>(resolve => { child.once('exit', () => resolve()); child.once('error', () => resolve()); });
  child.on('message', message => {
    if (receipt || startupFailure || !message || typeof message !== 'object' || (message as { type?: string }).type !== 'ready') return;
    writing = (async () => {
      if (!child.pid) throw error('NETWORK_COMMAND_UNAVAILABLE');
      const identity = await fencedProcessIdentity(child.pid);
      if (!validIdentity(identity) || identity.uid !== process.geteuid!()) throw error('NETWORK_COMMAND_UNSETTLED', false);
      const { state: _state, ...worker } = identity;
      receipt = { version: 1, token, commandSHA, ...worker };
      await fencedPrivateWrite(root, fencedReceiptName(token), JSON.stringify(receipt), scope);
      if (child.connected) child.send({ type: 'ack', token, commandSHA }, () => {});
    })().catch(() => { startupFailure = true; if (child.connected) child.disconnect(); });
  });
  child.send({ type: 'init', root, token, commandSHA, binary, args, options, scope }, () => {});
  let expired = false;
  const timer = setTimeout(() => { expired = true; if (child.connected) child.disconnect(); }, (options.timeoutMs ?? 15_000) + 5000);
  await exited; clearTimeout(timer); await writing;
  // The worker may have self-KILLed; only a kernel-backed settlement proof permits recovery.
  let inspection = await inspectFencedNetworkCommand(root, token, scope);
  if (inspection.state === 'running') inspection = await settleFencedNetworkCommand(root, token, scope);
  if (inspection.state === 'uncertain' || inspection.state === 'running') throw error('NETWORK_COMMAND_UNSETTLED', false);
  if (startupFailure) throw error('NETWORK_COMMAND_FENCE_WRITE');
  if (!inspection.result) throw error(expired ? 'NETWORK_COMMAND_TIMEOUT' : 'NETWORK_COMMAND_FAILED');
  if (!inspection.result.ok) throw error(inspection.result.code);
  return inspection.result.stdout;
}
