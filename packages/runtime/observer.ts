import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, readlink, realpath } from 'node:fs/promises';
import { request } from 'node:http';
import { loadRuntimeCandidate, parseRuntimeSettings, verifyBinary } from './settings.ts';
import { RuntimeError } from './types.ts';
import type { CoreObservation, RuntimeSettings, RuntimeUnitState } from './types.ts';

const fail = (code: string): never => { throw new RuntimeError(code); };

async function boundedRead(path: string, maximum: number): Promise<Buffer> {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(maximum + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > maximum) fail('PROCESS_UNVERIFIED');
    return buffer.subarray(0, length);
  } finally { await handle.close(); }
}

/** Production verification always requires the deployed unit to be root-owned. */
export async function assertManagedUnit(input: RuntimeSettings, unit: RuntimeUnitState): Promise<void> {
  const settings = parseRuntimeSettings(input);
  try {
    if (process.platform !== 'linux' || unit.loadState !== 'loaded' || unit.fragmentPath !== settings.unitPath ||
        unit.hasDropIns !== false || unit.needsReload !== false || unit.user !== String(settings.serviceUid)) fail('UNIT_UNTRUSTED');
    const before = await lstat(settings.unitPath, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.uid !== 0n || (before.mode & 0o022n) !== 0n ||
        before.size > 1024n * 1024n || await realpath(settings.unitPath) !== settings.unitPath) fail('UNIT_UNTRUSTED');
    const handle = await open(settings.unitPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const same = (stat: typeof before) => stat.isFile() && stat.dev === before.dev && stat.ino === before.ino &&
        stat.size === before.size && stat.mtimeNs === before.mtimeNs && stat.ctimeNs === before.ctimeNs && stat.mode === before.mode && stat.uid === before.uid;
      if (!same(await handle.stat({ bigint: true }))) fail('UNIT_UNTRUSTED');
      const hash = createHash('sha256');
      const buffer = Buffer.alloc(16 * 1024);
      let total = 0;
      for (;;) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
        if (bytesRead === 0) break;
        total += bytesRead;
        if (total > 1024 * 1024) fail('UNIT_UNTRUSTED');
        hash.update(buffer.subarray(0, bytesRead));
      }
      if (hash.digest('hex') !== settings.unitSha256 || !same(await handle.stat({ bigint: true })) ||
          !same(await lstat(settings.unitPath, { bigint: true }))) fail('UNIT_UNTRUSTED');
    } finally { await handle.close(); }
  } catch { fail('UNIT_UNTRUSTED'); }
}

type Identity = { startTime: string; executable: string };

async function identity(pid: number, binary: string, uid: number, suffix: string[]): Promise<Identity> {
  const root = `/proc/${pid}`;
  const stat = (await boundedRead(`${root}/stat`, 64 * 1024)).toString('utf8');
  // comm is allowed to contain ')' and spaces. Field 22 is offset 19 after it.
  const boundary = stat.lastIndexOf(')');
  const startTime = stat.slice(boundary + 2).trim().split(/\s+/)[19];
  if (boundary < 1 || !/^\d+$/.test(startTime ?? '')) fail('PROCESS_UNVERIFIED');
  const status = (await boundedRead(`${root}/status`, 64 * 1024)).toString('utf8');
  const uids = /^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*$/m.exec(status);
  if (!uids || Number(uids[2]) !== uid) fail('PROCESS_UNVERIFIED');
  const executable = await realpath(`${root}/exe`);
  if (executable !== binary) fail('PROCESS_UNVERIFIED');
  const command = await boundedRead(`${root}/cmdline`, 1024 * 1024);
  if (command.length === 0 || command[command.length - 1] !== 0) fail('PROCESS_UNVERIFIED');
  const args = command.subarray(0, -1).toString('utf8').split('\0');
  if (args.length < suffix.length || !suffix.every((value, offset) => args[args.length - suffix.length + offset] === value)) fail('PROCESS_UNVERIFIED');
  return { startTime, executable };
}

async function ownsController(pid: number, port: number): Promise<boolean> {
  const table = (await boundedRead(`/proc/${pid}/net/tcp`, 4 * 1024 * 1024)).toString('ascii');
  const local = `0100007F:${port.toString(16).toUpperCase().padStart(4, '0')}`;
  const inodes = new Set<string>();
  for (const line of table.split('\n').slice(1)) {
    const fields = line.trim().split(/\s+/);
    if (fields[1] === local && fields[3] === '0A' && /^[1-9]\d*$/.test(fields[9] ?? '')) inodes.add(fields[9]);
  }
  if (inodes.size === 0) return false;
  const descriptors = await readdir(`/proc/${pid}/fd`);
  if (descriptors.length > 65_536) return false;
  for (const descriptor of descriptors) {
    if (!/^\d+$/.test(descriptor)) continue;
    let target: string;
    try { target = await readlink(`/proc/${pid}/fd/${descriptor}`); }
    catch { continue; } // A descriptor can close while the process remains alive.
    const socket = /^socket:\[(\d+)\]$/.exec(target);
    if (socket) inodes.delete(socket[1]);
    if (inodes.size === 0) return true;
  }
  return false;
}

/** Deadline includes connection, headers and body; no proxy or redirect handling. */
async function probeVersion(port: number, secret: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (success: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (success) resolve(); else reject(new RuntimeError('CONTROLLER_UNREADY'));
    };
    const req = request({ hostname: '127.0.0.1', family: 4, port, method: 'GET', path: '/version',
      headers: { Authorization: `Bearer ${secret}`, Connection: 'close' }, agent: false }, response => {
      if (response.statusCode !== 200) { response.destroy(); req.destroy(); finish(false); return; }
      let bytes = 0;
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 4096) { response.destroy(); req.destroy(); finish(false); }
        else chunks.push(chunk);
      });
      response.on('error', () => finish(false));
      response.on('aborted', () => finish(false));
      response.on('end', () => {
        try {
          const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
          finish(value !== null && typeof value === 'object' && !Array.isArray(value) &&
            typeof value.version === 'string' && value.version.trim().length > 0);
        } catch { finish(false); }
      });
    });
    const timer = setTimeout(() => { req.destroy(); finish(false); }, 1000);
    req.on('error', () => finish(false));
    req.end();
  });
}

/** Live evidence of this explicit-proxy core only; no DNS/TUN/egress claim. */
export async function observeCore(input: RuntimeSettings, generation: string, unit: RuntimeUnitState): Promise<CoreObservation> {
  const settings = parseRuntimeSettings(input);
  if (typeof generation !== 'string' || !/^[a-f0-9]{64}$/.test(generation)) fail('INVALID_RUNTIME_GENERATION');
  const result = (reason: string | null): CoreObservation => ({ ready: reason === null, generation,
    checkedAt: new Date().toISOString(), reason });
  if (process.platform !== 'linux') return result('UNSUPPORTED_PLATFORM');
  if (!unit || unit.activeState !== 'active' || unit.subState !== 'running' ||
      !Number.isSafeInteger(unit.mainPid) || unit.mainPid <= 1 || unit.jobPending !== false) return result('CORE_INACTIVE');
  let target: Awaited<ReturnType<typeof loadRuntimeCandidate>>;
  try { target = await loadRuntimeCandidate(settings, generation); }
  catch { return result('CANDIDATE_UNTRUSTED'); }
  let binary: string;
  try { binary = await verifyBinary(settings); }
  catch { return result('BINARY_UNTRUSTED'); }
  const suffix = ['-d', target.home, '-f', target.path];
  let before: Identity;
  try { before = await identity(unit.mainPid, binary, settings.serviceUid, suffix); }
  catch { return result('PROCESS_UNVERIFIED'); }
  try { if (!await ownsController(unit.mainPid, target.controller.port)) return result('CONTROLLER_NOT_OWNED'); }
  catch { return result('CONTROLLER_NOT_OWNED'); }
  try { await probeVersion(target.controller.port, target.controller.secret); }
  catch { return result('CONTROLLER_UNREADY'); }
  try {
    const after = await identity(unit.mainPid, binary, settings.serviceUid, suffix);
    if (after.startTime !== before.startTime || after.executable !== before.executable ||
        await realpath(settings.binaryPath) !== binary || !await ownsController(unit.mainPid, target.controller.port)) return result('PROCESS_CHANGED');
  } catch { return result('PROCESS_CHANGED'); }
  return result(null);
}
