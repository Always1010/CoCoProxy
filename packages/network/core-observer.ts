import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, opendir, readlink, realpath, stat, statfs } from 'node:fs/promises';
import { request } from 'node:http';
import { posix } from 'node:path';
import { canonicalJson } from '../config/index.ts';
import { assertManagedUnit } from '../runtime/observer.ts';
import { verifyBinary } from '../runtime/settings.ts';
import { parseUnitState } from '../runtime/systemd.ts';
import type { RuntimeSettings, RuntimeUnitState } from '../runtime/types.ts';
import { loadGatewayCandidate } from './candidate.ts';
import { runNetworkCommand } from './command.ts';
import { CORE_CONTROL_GROUP } from './identity.ts';
import { renderNetworkPlan, type NetworkPlanInput } from './plan.ts';
import type { GatewayCoreSettings } from './runtime.ts';
import { GATEWAY_CREDENTIAL_PATH, renderGatewayRuntimePlan } from './runtime-plan.ts';

export interface GatewayCoreFacts {
  generation: string; planSha256: string; bootId: string; corePid: number; corePidStartTime: string;
  serviceUid: number; binarySha256: string; unitSha256: string; coreUnitControlGroup: typeof CORE_CONTROL_GROUP;
}
export interface GatewayCoreObservation {
  scope: 'production' | 'fixture'; verified: boolean; checkedAt: number;
  reason: null | 'NETWORK_CORE_UNVERIFIED'; facts: GatewayCoreFacts | null; terminalPath: 'unverified';
}
export interface GatewayCoreFileMetadata {
  dev: bigint; ino: bigint; uid: bigint; mode: bigint; size: bigint; nlink: bigint; mtimeNs: bigint; ctimeNs: bigint;
}
/** Internal synthetic seam only. No caller can substitute this reader into production. */
export interface GatewayCoreFixtureReader {
  platform: string; root: boolean;
  read(path: string, maximum: number): Promise<Buffer>;
  link(path: string): Promise<string>;
  realpath(path: string): Promise<string>;
  metadata(path: string, follow?: boolean): Promise<GatewayCoreFileMetadata>;
  entries(path: string): Promise<string[]>;
  fsType(path: string): Promise<bigint>;
  digest(path: string, maximum: number, follow?: boolean): Promise<string>;
  command(binary: string, args: readonly string[]): Promise<string>;
  candidate: typeof loadGatewayCandidate;
  version(port: number, secret: string): Promise<void>;
  now(): number;
}
const unitName = 'coproxy-mihomo.service';
const properties = 'LoadState,ActiveState,SubState,MainPID,Job,FragmentPath,DropInPaths,NeedDaemonReload,User,ControlGroup';
const positive = /^[1-9]\d{0,19}$/;
const fail: () => never = () => { throw new Error('NETWORK_CORE_UNVERIFIED'); };
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const stamp = (value: GatewayCoreFileMetadata) => [value.dev, value.ino, value.uid, value.mode, value.size,
  value.nlink, value.mtimeNs, value.ctimeNs].map(String).join(':');
function text(bytes: Buffer): string { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }

async function boundedRead(path: string, maximum: number): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const bytes = Buffer.alloc(maximum + 1); let length = 0;
    while (length < bytes.length) {
      const result = await file.read(bytes, length, bytes.length - length, null);
      if (!result.bytesRead) break; length += result.bytesRead;
    }
    if (length > maximum) fail(); return bytes.subarray(0, length);
  } finally { await file.close(); }
}
async function fileDigest(path: string, maximum: number, follow = false): Promise<string> {
  const before = await (follow ? stat : lstat)(path, { bigint: true });
  if (!before.isFile() || before.size > BigInt(maximum) || before.nlink !== 1n) fail();
  const file = await open(path, constants.O_RDONLY | (follow ? 0 : constants.O_NOFOLLOW));
  try {
    if (stamp(await file.stat({ bigint: true })) !== stamp(before)) fail();
    const digest = createHash('sha256'), bytes = Buffer.alloc(65_536); let length = 0;
    for (;;) {
      const result = await file.read(bytes, 0, bytes.length, null); if (!result.bytesRead) break;
      length += result.bytesRead; if (length > maximum) fail(); digest.update(bytes.subarray(0, result.bytesRead));
    }
    if (stamp(await file.stat({ bigint: true })) !== stamp(before) ||
      stamp(await (follow ? stat : lstat)(path, { bigint: true })) !== stamp(before)) fail();
    return digest.digest('hex');
  } finally { await file.close(); }
}
async function authenticatedVersion(port: number, secret: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let req: ReturnType<typeof request> | undefined;
    const finish = (ok: boolean) => {
      if (settled) return; settled = true; clearTimeout(timer);
      if (ok) resolve(); else reject(new Error('NETWORK_CORE_UNVERIFIED'));
    };
    const timer = setTimeout(() => { req?.destroy(); finish(false); }, 1000);
    try {
      req = request({ hostname: '127.0.0.1', family: 4, port, path: '/version', method: 'GET', agent: false,
        headers: { Authorization: `Bearer ${secret}`, Connection: 'close' } }, response => {
        if (response.statusCode !== 200) { response.destroy(); req?.destroy(); finish(false); return; }
        const chunks: Buffer[] = []; let length = 0;
        response.on('data', (chunk: Buffer) => {
          length += chunk.length;
          if (length > 4096) { response.destroy(); req?.destroy(); finish(false); } else chunks.push(chunk);
        });
        response.on('error', () => finish(false)); response.on('aborted', () => finish(false));
        response.on('end', () => {
          try {
            const value = JSON.parse(text(Buffer.concat(chunks)));
            finish(!!value && typeof value === 'object' && !Array.isArray(value) && typeof value.version === 'string' && value.version.trim().length > 0);
          } catch { finish(false); }
        });
      });
      req.on('error', () => finish(false)); req.end();
    } catch { req?.destroy(); finish(false); }
  });
}
const liveReader: GatewayCoreFixtureReader = {
  platform: process.platform, root: process.geteuid?.() === 0,
  read: boundedRead, link: readlink, realpath,
  async metadata(path, follow = false) { return (follow ? stat : lstat)(path, { bigint: true }); },
  async entries(path) {
    const values: string[] = [];
    for await (const entry of await opendir(path)) { if (values.length >= 8192) fail(); values.push(entry.name); }
    return values;
  },
  async fsType(path) { return (await statfs(path, { bigint: true })).type; },
  digest: fileDigest,
  command: (binary, args) => runNetworkCommand(binary, args, { timeoutMs: 1000, maxOutputBytes: 16_384 }),
  candidate: loadGatewayCandidate, version: authenticatedVersion, now: Date.now,
};
async function trustedPath(reader: GatewayCoreFixtureReader, path: string, executable: boolean): Promise<GatewayCoreFileMetadata> {
  if (await reader.realpath(path) !== path) fail();
  let leaf: GatewayCoreFileMetadata | undefined;
  for (let current = path;; current = posix.dirname(current)) {
    const value = await reader.metadata(current), file = current === path;
    if (value.uid !== 0n || (value.mode & 0o022n) !== 0n ||
      (value.mode & 0o170000n) !== (file ? 0o100000n : 0o040000n) ||
      (file && (value.nlink !== 1n || (executable && (value.mode & 0o111n) === 0n)))) fail();
    if (file) leaf = value;
    if (current === '/') break;
  }
  return leaf!;
}
async function observeUnit(reader: GatewayCoreFixtureReader, settings: RuntimeSettings, production: boolean) {
  await trustedPath(reader, '/usr/bin/systemctl', true);
  if (await reader.realpath(settings.systemctlPath) !== '/usr/bin/systemctl') fail();
  const raw = await reader.command('/usr/bin/systemctl', ['--no-ask-password', '--no-pager', 'show', '--property=' + properties, unitName]);
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > 16_384) fail();
  const lines = raw.replace(/\n$/, '').split('\n'), control = lines.filter(line => line.startsWith('ControlGroup='));
  if (control.length !== 1 || control[0] !== 'ControlGroup=' + CORE_CONTROL_GROUP) fail();
  const state: RuntimeUnitState = parseUnitState(lines.filter(line => !line.startsWith('ControlGroup=')).join('\n') + '\n');
  if (state.loadState !== 'loaded' || state.activeState !== 'active' || state.subState !== 'running' || state.mainPid <= 1 ||
    state.mainPid > 0x7fff_ffff || state.jobPending || state.fragmentPath !== settings.unitPath || state.hasDropIns ||
    state.needsReload || state.user !== String(settings.serviceUid)) fail();
  const metadata = await trustedPath(reader, settings.unitPath, false);
  if (await reader.digest(settings.unitPath, 1_048_576) !== settings.unitSha256) fail();
  if (production) await assertManagedUnit(settings, state);
  return { state, stamp: stamp(metadata) };
}
async function snapshot(reader: GatewayCoreFixtureReader, settings: RuntimeSettings, coreHome: string,
  controllerPort: number, generation: string, production: boolean) {
  if (reader.platform !== 'linux' || !reader.root || (production && process.geteuid?.() !== 0) || await reader.fsType('/proc') !== 0x9fa0n) fail();
  const unit = await observeUnit(reader, settings, production), pid = unit.state.mainPid;
  const mounts = text(await reader.read('/proc/self/mountinfo', 262_144));
  const records = mounts.trim().split('\n').map(line => {
    const parts = line.split(' - '); if (parts.length !== 2) fail();
    return { left: parts[0].split(' '), right: parts[1].split(' ') };
  });
  const proc = records.filter(record => record.left[4] === '/proc');
  const paths = ['/proc/sys/kernel/random/boot_id', '/proc/1/ns', '/proc/self', `/proc/${process.pid}`, `/proc/${pid}`];
  const overlaps = (a: string, b: string) => a === b || a.startsWith(b + '/') || b.startsWith(a + '/');
  if (proc.length !== 1 || proc[0].left[3] !== '/' || proc[0].right[0] !== 'proc' || records.some(record =>
    record.left[4]?.startsWith('/proc/') && paths.some(path => overlaps(record.left[4], path)))) fail();
  const namespaces: string[] = [];
  for (const name of ['user', 'net', 'pid', 'cgroup', 'mnt']) {
    const expected = await reader.link(`/proc/1/ns/${name}`);
    if (!new RegExp(`^${name}:\\[[1-9]\\d*\\]$`).test(expected) || await reader.link(`/proc/self/ns/${name}`) !== expected ||
      (name !== 'mnt' && await reader.link(`/proc/${pid}/ns/${name}`) !== expected)) fail();
    namespaces.push(expected);
  }
  const bootId = text(await reader.read('/proc/sys/kernel/random/boot_id', 128)).trim();
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(bootId)) fail();
  const rawStat = text(await reader.read(`/proc/${pid}/stat`, 65_536)), boundary = rawStat.lastIndexOf(')');
  const fields = rawStat.slice(boundary + 2).trim().split(/\s+/);
  if (!rawStat.startsWith(`${pid} (`) || boundary < 1 || !['R', 'S', 'D', 'I'].includes(fields[0]) || !positive.test(fields[19] ?? '')) fail();
  const status = text(await reader.read(`/proc/${pid}/status`, 65_536));
  const uids = /^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*$/m.exec(status);
  if (!uids || uids.slice(1).some(uid => Number(uid) !== settings.serviceUid) ||
    text(await reader.read(`/proc/${pid}/cgroup`, 4096)) !== `0::${CORE_CONTROL_GROUP}\n`) fail();
  const binary = await trustedPath(reader, settings.binaryPath, true);
  if (production && await verifyBinary(settings) !== settings.binaryPath) fail();
  if (await reader.digest(settings.binaryPath, 268_435_456) !== settings.binarySha256 ||
    await reader.realpath(`/proc/${pid}/exe`) !== settings.binaryPath) fail();
  const executable = await reader.metadata(`/proc/${pid}/exe`, true);
  if (stamp(executable) !== stamp(binary) || await reader.digest(`/proc/${pid}/exe`, 268_435_456, true) !== settings.binarySha256) fail();
  const command = await reader.read(`/proc/${pid}/cmdline`, 16_384);
  const expectedCommand = Buffer.from([settings.binaryPath, '-d', coreHome, '-f', GATEWAY_CREDENTIAL_PATH, ''].join('\0'));
  if (!command.equals(expectedCommand)) fail();
  const credentialPath = `/proc/${pid}/root${GATEWAY_CREDENTIAL_PATH}`;
  const credential = await reader.metadata(credentialPath);
  if ((credential.mode & 0o170000n) !== 0o100000n || (credential.mode & 0o222n) !== 0n || credential.nlink !== 1n ||
    ![0n, BigInt(settings.serviceUid)].includes(credential.uid) || credential.size > 1_000_000n) fail();
  const bytes = await reader.read(credentialPath, 1_000_000), raw = text(bytes);
  if (BigInt(bytes.length) !== credential.size || hash(bytes) !== generation || canonicalJson(JSON.parse(raw)) !== raw ||
    stamp(await reader.metadata(credentialPath)) !== stamp(credential)) fail();
  const table = text(await reader.read(`/proc/${pid}/net/tcp`, 1_048_576));
  const rows = table.trim().split('\n'); if (!rows.shift()?.includes('local_address')) fail();
  const port = controllerPort.toString(16).toUpperCase().padStart(4, '0');
  const listeners = rows.map(row => row.trim().split(/\s+/)).filter(row => row[1]?.split(':')[1] === port && row[3] === '0A');
  if (listeners.length !== 1 || listeners[0][1] !== '0100007F:' + port || listeners[0][2] !== '00000000:0000' ||
    listeners[0][7] !== String(settings.serviceUid) || !positive.test(listeners[0][9] ?? '')) fail();
  const ipv6 = text(await reader.read(`/proc/${pid}/net/tcp6`, 1_048_576)).trim().split('\n');
  if (!ipv6.shift()?.includes('local_address') || ipv6.some(row => { const values = row.trim().split(/\s+/); return values[1]?.split(':')[1] === port && values[3] === '0A'; })) fail();
  const fds = await reader.entries(`/proc/${pid}/fd`);
  if (fds.length > 8192 || fds.some(fd => !/^(0|[1-9]\d{0,9})$/.test(fd))) fail();
  let owned = false;
  for (const fd of fds) {
    try { if (await reader.link(`/proc/${pid}/fd/${fd}`) === `socket:[${listeners[0][9]}]`) owned = true; }
    catch (error) { if (!['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException)?.code ?? '')) throw error; }
  }
  if (!owned) fail();
  return { pid, startTime: fields[19], bootId, namespaces, mounts, unit, binary: stamp(binary), credential: stamp(credential), inode: listeners[0][9] };
}
async function observe(input: GatewayCoreSettings, deployment: NetworkPlanInput, reader: GatewayCoreFixtureReader,
  scope: GatewayCoreObservation['scope']): Promise<GatewayCoreObservation> {
  let checkedAt = Date.now();
  try {
    if (reader.platform !== 'linux' || !reader.root) fail();
    const started = reader.now(), settingsInput = input.runtime;
    const proposed = renderGatewayRuntimePlan({ schemaVersion: 1, stateDirectory: settingsInput.stateDirectory,
      binaryPath: settingsInput.binaryPath, binarySha256: settingsInput.binarySha256, systemctlPath: settingsInput.systemctlPath,
      unitPath: settingsInput.unitPath, serviceUid: settingsInput.serviceUid, coreHome: input.coreHome });
    // Only the generator's gateway profile can supply this observer's command line.
    if (canonicalJson(proposed.settings as unknown as Parameters<typeof canonicalJson>[0]) !== canonicalJson(input.runtime as unknown as Parameters<typeof canonicalJson>[0])) fail();
    const plan = renderNetworkPlan(deployment), settings = proposed.settings;
    if (plan.deployment.core.serviceUid !== settings.serviceUid || plan.deployment.core.binarySha256 !== settings.binarySha256 ||
      plan.deployment.core.unitSha256 !== settings.unitSha256) fail();
    const target = await reader.candidate(settings, plan.deployment.generation, plan.deployment);
    const before = await snapshot(reader, settings, proposed.coreHome, target.controller.port, plan.deployment.generation, scope === 'production');
    await reader.version(target.controller.port, target.controller.secret);
    const after = await snapshot(reader, settings, proposed.coreHome, target.controller.port, plan.deployment.generation, scope === 'production');
    checkedAt = reader.now();
    if (!Number.isSafeInteger(started) || !Number.isSafeInteger(checkedAt) || started <= 0 || checkedAt < started || checkedAt - started > 5000 ||
      JSON.stringify(before) !== JSON.stringify(after)) fail();
    return { scope, verified: true, checkedAt, reason: null, terminalPath: 'unverified', facts: {
      generation: plan.deployment.generation, planSha256: plan.sha256, bootId: after.bootId, corePid: after.pid,
      corePidStartTime: after.startTime, serviceUid: settings.serviceUid, binarySha256: settings.binarySha256,
      unitSha256: settings.unitSha256, coreUnitControlGroup: CORE_CONTROL_GROUP } };
  } catch { return { scope, verified: false, checkedAt, reason: 'NETWORK_CORE_UNVERIFIED', facts: null, terminalPath: 'unverified' }; }
}
/** Root-only read-only unit/process/credential observation plus one authenticated loopback request. */
export async function observeGatewayCore(input: GatewayCoreSettings, deployment: NetworkPlanInput): Promise<GatewayCoreObservation> {
  return observe(input, deployment, { ...liveReader, root: process.geteuid?.() === 0 }, 'production');
}
/** Synthetic reader observations always remain fixture, including malformed readers. */
export async function observeGatewayCoreFixture(input: GatewayCoreSettings, deployment: NetworkPlanInput,
  reader: GatewayCoreFixtureReader): Promise<GatewayCoreObservation> {
  return observe(input, deployment, reader, 'fixture');
}
