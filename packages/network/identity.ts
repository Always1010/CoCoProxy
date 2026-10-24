import { constants } from 'node:fs';
import { lstat, open, opendir, readlink, statfs } from 'node:fs/promises';
import { release } from 'node:os';

export const CORE_CONTROL_GROUP = '/system.slice/coproxy-mihomo.service';
export const MANAGEMENT_CONTROL_GROUP = '/system.slice/coproxy-management.service';
const ROOT = '/sys/fs/cgroup';
const positive = /^[1-9][0-9]*$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const fail = (): never => { throw new Error('NETWORK_CGROUP_UNVERIFIED'); };

/** Expected process identity must come from the caller's independently verified unit/core evidence. */
export interface CoreCgroupRequest {
  corePid: number;
  managementPid: number;
  serviceUid: number;
  bootId: string;
  corePidStartTime: string;
}
export interface CoreCgroupIdentity {
  bootId: string;
  corePid: number;
  corePidStartTime: string;
  coreUnitControlGroup: typeof CORE_CONTROL_GROUP;
  coreCgroupKernelId: string;
  managementPid: number;
  managementPidStartTime: string;
  managementUnitControlGroup: typeof MANAGEMENT_CONTROL_GROUP;
  managementCgroupKernelId: string;
}
export interface CoreCgroupObservation {
  scope: 'production' | 'fixture';
  verified: boolean;
  checkedAt: number;
  reason: null | 'NETWORK_CGROUP_UNVERIFIED';
  identity: CoreCgroupIdentity | null;
}

/** Trusted code seam only. It cannot produce an observation with production scope. */
export interface CgroupFixtureReader {
  platform: string;
  arch: string;
  kernelRelease: string;
  read(path: string): Promise<string>;
  metadata(path: string): Promise<{ uid: bigint; mode: bigint; dev: bigint; ino: bigint; ctimeNs: bigint }>;
  entries(path: string): Promise<{ name: string; directory: boolean; symlink: boolean }[]>;
  fsType(path: string): Promise<bigint>;
  link(path: string): Promise<string>;
}

const liveReader: CgroupFixtureReader = {
  platform: process.platform, arch: process.arch, kernelRelease: release(),
  async read(path) {
    const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const buffer = Buffer.alloc(262145);
      let used = 0;
      for (;;) {
        const { bytesRead } = await fd.read(buffer, used, buffer.length - used, null);
        used += bytesRead;
        if (used > 262144) fail();
        if (!bytesRead) return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, used));
      }
    } finally { await fd.close(); }
  },
  async metadata(path) { return lstat(path, { bigint: true }); },
  async entries(path) {
    const result = [];
    const directory = await opendir(path);
    for await (const entry of directory) {
      if (result.length >= 8192) fail();
      result.push({ name: entry.name, directory: entry.isDirectory(), symlink: entry.isSymbolicLink() });
    }
    return result;
  },
  async fsType(path) { return (await statfs(path, { bigint: true })).type; },
  async link(path) { return readlink(path); },
};

function validate(input: CoreCgroupRequest): CoreCgroupRequest {
  // This is an internal typed API, never a JSON configuration or alternate filesystem root.
  const result = { corePid: input.corePid, managementPid: input.managementPid, serviceUid: input.serviceUid,
    bootId: input.bootId, corePidStartTime: input.corePidStartTime };
  if (![result.corePid, result.managementPid].every(pid => Number.isSafeInteger(pid) && pid > 1 && pid <= 0x7fffffff) ||
    result.corePid === result.managementPid || !Number.isSafeInteger(result.serviceUid) || result.serviceUid < 1 ||
    result.serviceUid > 0xfffffffe || typeof result.bootId !== 'string' || !uuid.test(result.bootId) ||
    typeof result.corePidStartTime !== 'string' || !positive.test(result.corePidStartTime)) fail();
  return result;
}

async function processIdentity(reader: CgroupFixtureReader, pid: number, uid: number, group: string): Promise<string> {
  const stat = await reader.read(`/proc/${pid}/stat`);
  const boundary = stat.lastIndexOf(')');
  const fields = stat.slice(boundary + 2).trim().split(/\s+/);
  if (!stat.startsWith(`${pid} (`) || boundary < 1 || !positive.test(fields[19] ?? '') ||
    !['R', 'S', 'D', 'I'].includes(fields[0])) fail();
  const status = await reader.read(`/proc/${pid}/status`);
  const ids = /^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*$/m.exec(status);
  if (!ids || ids.slice(1).some(id => Number(id) !== uid)) fail();
  // DAC bypass and later privilege acquisition invalidate the migration-permission proof.
  const allowedCapabilities = group === CORE_CONTROL_GROUP ? 0x3000n : 0n; // NET_ADMIN | NET_RAW only
  for (const name of ['CapInh', 'CapPrm', 'CapEff', 'CapAmb']) {
    const value = new RegExp(`^${name}:\\s+([0-9a-f]{16})\\s*$`, 'm').exec(status);
    if (!value || (BigInt(`0x${value[1]}`) & ~allowedCapabilities) !== 0n) fail();
  }
  if (!/^NoNewPrivs:\s+1\s*$/m.test(status) ||
    (await reader.read(`/proc/${pid}/cgroup`)) !== `0::${group}\n`) fail();
  return fields[19];
}

async function snapshot(reader: CgroupFixtureReader, request: CoreCgroupRequest) {
  if (reader.platform !== 'linux' || !['x64', 'arm64'].includes(reader.arch) ||
    !/^6\.([1-9][0-9]*)\./.test(reader.kernelRelease)) fail();
  if (await reader.fsType('/proc') !== 0x9fa0n || await reader.fsType(ROOT) !== 0x63677270n) fail();
  const mountinfo = await reader.read('/proc/self/mountinfo');
  const mounts = mountinfo.trim().split('\n').map(line => {
    const [left, right, extra] = line.split(' - ');
    if (!left || !right || extra !== undefined) fail();
    return { left: left.split(' '), right: right.split(' ') };
  });
  const procPaths = ['/proc/sys/kernel/random/boot_id', '/proc/1/ns', '/proc/self',
    `/proc/${process.pid}`, `/proc/${request.corePid}`, `/proc/${request.managementPid}`];
  const overlaps = (mount: string, path: string) => mount === path || mount.startsWith(`${path}/`) || path.startsWith(`${mount}/`);
  for (const [target, filesystem] of [['/proc', 'proc'], [ROOT, 'cgroup2']]) {
    const at = mounts.filter(mount => mount.left[4] === target);
    if (at.length !== 1 || at[0].left[3] !== '/' || at[0].right[0] !== filesystem ||
      mounts.some(mount => mount.left[4].startsWith(`${target}/`) &&
        (target === ROOT || procPaths.some(path => overlaps(mount.left[4], path))))) fail();
  }
  const namespaces: string[] = [];
  for (const name of ['mnt', 'cgroup', 'pid', 'user', 'net']) {
    const expected = await reader.link(`/proc/1/ns/${name}`);
    if (!new RegExp(`^${name}:\\[[1-9][0-9]*\\]$`).test(expected)) fail();
    // PrivateTmp/ProtectSystem legitimately give services separate mount namespaces.
    const pids = name === 'mnt' ? ['self'] : ['self', String(request.corePid), String(request.managementPid)];
    for (const pid of pids) {
      if (await reader.link(`/proc/${pid}/ns/${name}`) !== expected) fail();
    }
    namespaces.push(expected);
  }
  const bootId = (await reader.read('/proc/sys/kernel/random/boot_id')).trim();
  if (bootId !== request.bootId) fail();
  const proofs: string[] = [];
  // Root-controlled ancestry prevents rename/replacement as well as process migration.
  for (const path of ['/', '/sys', '/sys/fs', ROOT, `${ROOT}/system.slice`,
    `${ROOT}${CORE_CONTROL_GROUP}`, `${ROOT}${MANAGEMENT_CONTROL_GROUP}`]) {
    const stat = await reader.metadata(path);
    if ((stat.mode & 0o170000n) !== 0o040000n || stat.uid !== 0n || (stat.mode & 0o022n) !== 0n) fail();
    proofs.push(`${path}:${stat.dev}:${stat.ino}:${stat.mode}:${stat.ctimeNs}`);
  }
  const groups = [CORE_CONTROL_GROUP, MANAGEMENT_CONTROL_GROUP];
  const kernelIds: string[] = [];
  for (const group of ['', '/system.slice', ...groups]) {
    for (const name of ['cgroup.procs', 'cgroup.threads', 'cgroup.subtree_control']) {
      const path = `${ROOT}${group}/${name}`;
      const stat = await reader.metadata(path);
      if ((stat.mode & 0o170000n) !== 0o100000n || stat.uid !== 0n || (stat.mode & 0o022n) !== 0n) fail();
      proofs.push(`${path}:${stat.dev}:${stat.ino}:${stat.mode}:${stat.ctimeNs}`);
    }
  }
  for (const [index, group] of groups.entries()) {
    const path = ROOT + group;
    if (await reader.fsType(path) !== 0x63677270n ||
      (await reader.entries(path)).some(entry => entry.directory || entry.symlink) ||
      await reader.read(`${path}/cgroup.type`) !== 'domain\n' ||
      (await reader.read(`${path}/cgroup.subtree_control`)).trim() !== '' ||
      (await reader.read(`${path}/cgroup.procs`)).trim() !== String(index === 0 ? request.corePid : request.managementPid)) fail();
    const stat = await reader.metadata(path);
    if (stat.ino <= 0n || stat.ino > 0xffffffffffffffffn) fail();
    kernelIds.push(String(stat.ino));
  }
  if (kernelIds[0] === kernelIds[1]) fail();
  const corePidStartTime = await processIdentity(reader, request.corePid, request.serviceUid, CORE_CONTROL_GROUP);
  const managementPidStartTime = await processIdentity(reader, request.managementPid, request.serviceUid, MANAGEMENT_CONTROL_GROUP);
  if (corePidStartTime !== request.corePidStartTime) fail();
  const identity: CoreCgroupIdentity = { bootId, corePid: request.corePid, corePidStartTime,
    coreUnitControlGroup: CORE_CONTROL_GROUP, coreCgroupKernelId: kernelIds[0], managementPid: request.managementPid,
    managementPidStartTime, managementUnitControlGroup: MANAGEMENT_CONTROL_GROUP, managementCgroupKernelId: kernelIds[1] };
  return { identity, proofs, mountinfo, namespaces };
}

async function observe(input: CoreCgroupRequest, reader: CgroupFixtureReader, scope: CoreCgroupObservation['scope']): Promise<CoreCgroupObservation> {
  const started = Date.now();
  try {
    const request = validate(input);
    const before = await snapshot(reader, request);
    const after = await snapshot(reader, request);
    const checkedAt = Date.now();
    if (JSON.stringify(before) !== JSON.stringify(after) || checkedAt < started || checkedAt - started > 5000) fail();
    return { scope, verified: true, checkedAt, reason: null, identity: after.identity };
  } catch {
    return { scope, verified: false, checkedAt: Date.now(), reason: 'NETWORK_CGROUP_UNVERIFIED', identity: null };
  }
}

/** Reads only fixed host procfs/cgroup2fs paths. No command execution and no mutation. */
export async function observeCoreCgroup(input: CoreCgroupRequest): Promise<CoreCgroupObservation> {
  return observe(input, liveReader, 'production');
}

/** Synthetic observation; never usable as production evidence, even on Linux. */
export async function observeCoreCgroupFixture(input: CoreCgroupRequest, reader: CgroupFixtureReader): Promise<CoreCgroupObservation> {
  return observe(input, reader, 'fixture');
}
