import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, readlink, realpath } from 'node:fs/promises';
import { request } from 'node:http';
import { loadRuntimeCandidate, loadRuntimeCandidateReadonly, parseRuntimeSettings, readRuntimeSelection, verifyBinary } from './settings.ts';
import { manualSelections, selectionChanges, verifyControllerSelections } from './selections.ts';
import { RuntimeError } from './types.ts';
import type { CoreInspection, CoreObservation, RuntimeSettings, RuntimeUnitState } from './types.ts';

const fail: (code: string) => never = code => { throw new RuntimeError(code); };

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

type Identity = { startTime: string; executable: string | null; nativeCapabilities: boolean };
/** Code-only synthetic seam; production always uses the fixed reader below. */
export interface CoreObserverFixtureReader {
  read(path: string, maximum: number): Promise<Buffer>;
  realpath(path: string): Promise<string>;
  entries(path: string): Promise<string[]>;
  link(path: string): Promise<string>;
  unit: typeof assertManagedUnit;
  binary: typeof verifyBinary;
  candidate: typeof loadRuntimeCandidate;
  version: typeof probeVersion;
  selection?: typeof readRuntimeSelection;
  selections?: typeof verifyControllerSelections;
  platform?: NodeJS.Platform;
}
const permissionDenied = (error: unknown): boolean => ['EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException)?.code ?? '');
class RestrictedProcAccess extends Error {}

async function identity(pid: number, binary: string, uid: number, suffix: string[], native: boolean,
  reader: CoreObserverFixtureReader): Promise<Identity> {
  const root = `/proc/${pid}`;
  const stat = (await reader.read(`${root}/stat`, 64 * 1024)).toString('utf8');
  // comm is allowed to contain ')' and spaces. Field 22 is offset 19 after it.
  const boundary = stat.lastIndexOf(')');
  const startTime = stat.slice(boundary + 2).trim().split(/\s+/)[19];
  if (stat.slice(0, stat.indexOf(' (')) !== String(pid) || boundary < 1 || !/^[1-9]\d*$/.test(startTime ?? '')) fail('PROCESS_UNVERIFIED');
  const status = (await reader.read(`${root}/status`, 64 * 1024)).toString('utf8');
  const uids = /^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*$/m.exec(status);
  if (!uids || Number(uids[2]) !== uid || native && !uids.slice(1).every(value => Number(value) === uid)) fail('PROCESS_UNVERIFIED');
  const capabilities = /^CapPrm:\s+([a-fA-F0-9]{1,16})\s*$/m.exec(status);
  const nativeCapabilities = !!capabilities && BigInt('0x' + capabilities[1]) === 0x3000n; // NET_ADMIN and NET_RAW only.
  const command = await reader.read(`${root}/cmdline`, 1024 * 1024);
  if (command.length === 0 || command[command.length - 1] !== 0) fail('PROCESS_UNVERIFIED');
  const args = command.subarray(0, -1).toString('utf8').split('\0');
  if (args.length < suffix.length || !suffix.every((value, offset) => args[args.length - suffix.length + offset] === value)) fail('PROCESS_UNVERIFIED');
  if (native) {
    if (args.length !== suffix.length + 1 || args[0] !== binary ||
        (await reader.read(`${root}/cgroup`, 64 * 1024)).toString('utf8') !== '0::/system.slice/cocoproxy-mihomo.service\n') fail('PROCESS_UNVERIFIED');
  }
  let executable: string | null;
  try { executable = await reader.realpath(`${root}/exe`); }
  catch (error) { if (!native || !nativeCapabilities || !permissionDenied(error)) throw error; executable = null; }
  if (executable !== null && executable !== binary) fail('PROCESS_UNVERIFIED');
  return { startTime, executable, nativeCapabilities };
}

async function ownsController(pid: number, port: number, reader: CoreObserverFixtureReader): Promise<boolean> {
  const table = (await reader.read(`/proc/${pid}/net/tcp`, 4 * 1024 * 1024)).toString('ascii');
  const local = `0100007F:${port.toString(16).toUpperCase().padStart(4, '0')}`;
  const inodes = new Set<string>();
  for (const line of table.split('\n').slice(1)) {
    const fields = line.trim().split(/\s+/);
    if (fields[1] === local && fields[3] === '0A' && /^[1-9]\d*$/.test(fields[9] ?? '')) inodes.add(fields[9]);
  }
  if (inodes.size === 0) return false;
  let descriptors: string[];
  try { descriptors = await reader.entries(`/proc/${pid}/fd`); }
  catch (error) { if (permissionDenied(error)) throw new RestrictedProcAccess(); throw error; }
  if (descriptors.length > 65_536) return false;
  for (const descriptor of descriptors) {
    if (!/^\d+$/.test(descriptor)) continue;
    let target: string;
    try { target = await reader.link(`/proc/${pid}/fd/${descriptor}`); }
    catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') continue; // Concurrent close.
      if (permissionDenied(error)) throw new RestrictedProcAccess();
      throw error;
    }
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

const liveReader: CoreObserverFixtureReader = { read: boundedRead, realpath, entries: path => readdir(path), link: readlink,
  unit: assertManagedUnit, binary: verifyBinary, candidate: loadRuntimeCandidateReadonly, version: probeVersion,
  selection: readRuntimeSelection, selections: verifyControllerSelections };

async function observe(input: RuntimeSettings, generation: string, unit: RuntimeUnitState,
  reader: CoreObserverFixtureReader, inspect = false): Promise<CoreInspection> {
  const settings = parseRuntimeSettings(input);
  if (typeof generation !== 'string' || !/^[a-f0-9]{64}$/.test(generation)) fail('INVALID_RUNTIME_GENERATION');
  const result = (reason: string | null): CoreObservation => ({ ready: reason === null, generation,
    checkedAt: new Date().toISOString(), reason });
  if ((reader.platform ?? process.platform) !== 'linux') return result('UNSUPPORTED_PLATFORM');
  if (!unit || unit.activeState !== 'active' || unit.subState !== 'running' ||
      !Number.isSafeInteger(unit.mainPid) || unit.mainPid <= 1 || unit.jobPending !== false) return result('CORE_INACTIVE');
  const native = settings.automaticGateway !== undefined;
  if (native) {
    try { await reader.unit(settings, unit); }
    catch { return result('UNIT_UNTRUSTED'); }
  }
  let target: Awaited<ReturnType<typeof loadRuntimeCandidate>>;
  try { target = await reader.candidate(settings, generation); }
  catch { return result('CANDIDATE_UNTRUSTED'); }
  let binary: string;
  try { binary = await reader.binary(settings); }
  catch { return result('BINARY_UNTRUSTED'); }
  let receipt: Awaited<ReturnType<typeof readRuntimeSelection>>;
  try { receipt = reader.selection ? await reader.selection(settings) : null; }
  catch { return result('SELECTION_UNTRUSTED'); }
  const hot = receipt?.generation === generation ? receipt.hot : undefined;
  let bootId: string | undefined;
  if (hot || inspect) {
    try {
      bootId = (await reader.read('/proc/sys/kernel/random/boot_id', 128)).toString('utf8').trim();
      if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(bootId)) return result('PROCESS_UNVERIFIED');
    } catch { return result('PROCESS_UNVERIFIED'); }
  }
  let baseGeneration = generation;
  let suffix = ['-d', target.home, '-f', target.path];
  let before: Identity;
  try { before = await identity(unit.mainPid, binary, settings.serviceUid, suffix, native, reader); }
  catch {
    if (!hot || hot.pid !== unit.mainPid || hot.bootId !== bootId) return result('PROCESS_UNVERIFIED');
    try {
      const base = await reader.candidate(settings, hot.baseGeneration);
      if (selectionChanges(base.candidate.config, target.candidate.config) === null) return result('SELECTION_UNTRUSTED');
      suffix = ['-d', base.home, '-f', base.path];
      before = await identity(unit.mainPid, binary, settings.serviceUid, suffix, native, reader);
      if (before.startTime !== hot.startTime) return result('PROCESS_UNVERIFIED');
      baseGeneration = hot.baseGeneration;
    } catch { return result('PROCESS_UNVERIFIED'); }
  }
  let restricted = before.executable === null;
  const controllerAcceptable = async (process: Identity): Promise<boolean> => {
    try { return await ownsController(unit.mainPid, target.controller.port, reader); }
    catch (error) {
      if (!native || !process.nativeCapabilities || !(error instanceof RestrictedProcAccess)) throw error;
      restricted = true; return true;
    }
  };
  try { if (!await controllerAcceptable(before)) return result('CONTROLLER_NOT_OWNED'); }
  catch { return result('CONTROLLER_NOT_OWNED'); }
  try { await reader.version(target.controller.port, target.controller.secret); }
  catch { return result('CONTROLLER_UNREADY'); }
  if (hot) {
    try {
      const selections = manualSelections(target.candidate.config);
      if (selections === null || !reader.selections) return result('SELECTION_UNTRUSTED');
      await reader.selections(target.controller.port, target.controller.secret, selections);
    } catch { return result('CONTROLLER_SELECTION_MISMATCH'); }
  }
  try {
    const after = await identity(unit.mainPid, binary, settings.serviceUid, suffix, native, reader);
    if (after.startTime !== before.startTime || after.executable !== before.executable ||
        after.nativeCapabilities !== before.nativeCapabilities || await reader.realpath(settings.binaryPath) !== binary ||
        !await controllerAcceptable(after) || (bootId !== undefined &&
          (await reader.read('/proc/sys/kernel/random/boot_id', 128)).toString('utf8').trim() !== bootId)) return result('PROCESS_CHANGED');
    if (native) {
      await reader.unit(settings, unit);
      if (restricted && await reader.binary(settings) !== binary) return result('PROCESS_CHANGED');
    }
  } catch { return result('PROCESS_CHANGED'); }
  return { ...result(null), evidence: restricted ? 'native-unit-and-controller' : 'proc-exe-and-fd',
    ...(inspect ? { process: { pid: unit.mainPid, bootId: bootId!, startTime: before.startTime, baseGeneration } } : {}) };
}

/** Core readiness only. Native restricted evidence never proves /proc exe or FD ownership. */
export async function observeCore(input: RuntimeSettings, generation: string, unit: RuntimeUnitState): Promise<CoreObservation> {
  return observe(input, generation, unit, liveReader);
}

/** Private activation evidence: same checks as public readiness, plus a boot-bound identity. */
export async function inspectCore(input: RuntimeSettings, generation: string, unit: RuntimeUnitState): Promise<CoreInspection> {
  return observe(input, generation, unit, liveReader, true);
}

/** Synthetic readers are code-only and cannot be supplied through deployment JSON. */
export async function observeCoreFixture(input: RuntimeSettings, generation: string, unit: RuntimeUnitState,
  reader: CoreObserverFixtureReader): Promise<CoreObservation & { scope: 'fixture' }> {
  return { ...await observe(input, generation, unit, reader), scope: 'fixture' };
}

export async function inspectCoreFixture(input: RuntimeSettings, generation: string, unit: RuntimeUnitState,
  reader: CoreObserverFixtureReader): Promise<CoreInspection & { scope: 'fixture' }> {
  return { ...await observe(input, generation, unit, reader, true), scope: 'fixture' };
}
