import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, lstat, open, realpath } from 'node:fs/promises';
import { posix } from 'node:path';
import { compileConfig, deploymentDnsOptions } from '../config/index.ts';
import { expandCompilerRuleSets } from '../config/compact-rules.ts';
import type { Candidate, JsonObject } from '../config/index.ts';
import { inspectPrivateDirectory, privateRead } from '../storage/private-files.ts';
import { FileTransactionStore } from '../transaction/index.ts';
import { RuntimeError } from './types.ts';
import { parseAutomaticGatewaySettings, recompileAutomaticGatewayConfig, AUTOMATIC_GATEWAY_CORE_SHA256_BY_PLATFORM } from '../gateway/profile.ts';
import type { RuntimeSettings, RuntimeSelection } from './types.ts';

const digest = /^[a-f0-9]{64}$/;
const settingKeys = ['schemaVersion', 'stateDirectory', 'binaryPath', 'binarySha256', 'systemctlPath', 'unitPath', 'unitSha256', 'serviceUid'];
const fail: (code: string) => never = code => { throw new RuntimeError(code); };
// Bounded, process-local proof caches. They cannot bypass current file checks
// and expose shared candidate snapshots only after recursive freezing.
let verifiedBinary: { key: string; identity: string } | undefined;
type RuntimeCandidate = {
  candidate: Candidate; path: string; controller: { port: number; secret: string }; home: string;
};
const compiledCandidates = new Map<string, RuntimeCandidate>();

function freezeSnapshot(value: object): void {
  for (const child of Object.values(value)) {
    if (child !== null && typeof child === 'object') freezeSnapshot(child);
  }
  Object.freeze(value);
}

function rememberCandidate(key: string, loaded: RuntimeCandidate): RuntimeCandidate {
  const snapshot = structuredClone(loaded);
  freezeSnapshot(snapshot);
  if (compiledCandidates.size >= 2) compiledCandidates.delete(compiledCandidates.keys().next().value!);
  compiledCandidates.set(key, snapshot);
  return snapshot;
}

function plainRecord(input: unknown, keys: string[], optional: string[] = []): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input) ||
      (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null)) fail('INVALID_RUNTIME_SETTINGS');
  const properties = Object.getOwnPropertyDescriptors(input);
  const names = Reflect.ownKeys(properties);
  if (keys.some(key => !names.includes(key)) || names.some(name => typeof name !== 'string' || ![...keys, ...optional].includes(name))) fail('INVALID_RUNTIME_SETTINGS');
  const result: Record<string, unknown> = {};
  for (const name of names as string[]) {
    const descriptor = properties[name];
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) fail('INVALID_RUNTIME_SETTINGS');
    result[name] = descriptor.value;
  }
  return result;
}

function absolutePath(input: unknown): string {
  if (typeof input !== 'string' || input.length > 4096 || /[\u0000-\u001f\u007f-\u009f]/.test(input) ||
      !posix.isAbsolute(input) || posix.normalize(input) !== input || input.endsWith('/')) fail('INVALID_RUNTIME_SETTINGS');
  return input;
}

/** Only deployment-owned JSON is accepted; no property getters are evaluated. */
export function parseRuntimeSettings(input: unknown): RuntimeSettings {
  try {
    const value = plainRecord(input, settingKeys, ['automaticGateway']);
    if (value.schemaVersion !== 1 || typeof value.binarySha256 !== 'string' || !digest.test(value.binarySha256) ||
        typeof value.unitSha256 !== 'string' || !digest.test(value.unitSha256) ||
        typeof value.serviceUid !== 'number' || !Number.isSafeInteger(value.serviceUid) || value.serviceUid <= 0 || value.serviceUid > 4_294_967_294) fail('INVALID_RUNTIME_SETTINGS');
    const stateDirectory = absolutePath(value.stateDirectory);
    const binaryPath = absolutePath(value.binaryPath);
    const systemctlPath = absolutePath(value.systemctlPath);
    const unitPath = absolutePath(value.unitPath);
    if (posix.basename(unitPath) !== 'cocoproxy-mihomo.service') fail('INVALID_RUNTIME_SETTINGS');
    const automaticGateway = value.automaticGateway === undefined ? undefined : parseAutomaticGatewaySettings(value.automaticGateway);
    if (automaticGateway && !Object.values(AUTOMATIC_GATEWAY_CORE_SHA256_BY_PLATFORM).includes(value.binarySha256)) fail('INVALID_RUNTIME_SETTINGS');
    return { schemaVersion: 1, stateDirectory, binaryPath, binarySha256: value.binarySha256,
      systemctlPath, unitPath, unitSha256: value.unitSha256, serviceUid: value.serviceUid,
      ...(automaticGateway ? { automaticGateway } : {}) };
  } catch { return fail('INVALID_RUNTIME_SETTINGS'); }
}

export async function loadRuntimeSettings(path: string): Promise<RuntimeSettings> {
  try { return parseRuntimeSettings(JSON.parse(await privateRead(absolutePath(path), 64 * 1024))); }
  catch { return fail('INVALID_RUNTIME_SETTINGS'); }
}

/** Pin the executable bytes and identity without loading a large binary into memory. */
export async function verifyBinary(input: RuntimeSettings): Promise<string> {
  const settings = parseRuntimeSettings(input);
  try {
    const path = await realpath(settings.binaryPath);
    const before = await lstat(path, { bigint: true });
    const maximum = 256n * 1024n * 1024n;
    if (!before.isFile() || before.isSymbolicLink() || before.size > maximum ||
        (before.uid !== 0n && before.uid !== BigInt(settings.serviceUid)) ||
        (before.mode & 0o022n) !== 0n || (before.mode & 0o111n) === 0n) fail('BINARY_UNTRUSTED');
    await access(path, constants.X_OK);
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const same = (stat: typeof before) => stat.isFile() && stat.dev === before.dev && stat.ino === before.ino &&
        stat.size === before.size && stat.mtimeNs === before.mtimeNs && stat.ctimeNs === before.ctimeNs &&
        stat.uid === before.uid && stat.gid === before.gid && stat.mode === before.mode;
      if (!same(await handle.stat({ bigint: true }))) fail('BINARY_UNTRUSTED');
      const key = JSON.stringify(settings);
      // ctimeNs changes for same-inode writes, ownership and mode changes even
      // when an operator restores size and mtime. Replacement changes dev/ino.
      const identity = [path, before.dev, before.ino, before.size, before.mtimeNs, before.ctimeNs,
        before.uid, before.gid, before.mode].join(':');
      const cached = verifiedBinary?.key === key && verifiedBinary.identity === identity;
      if (!cached) {
        const hash = createHash('sha256');
        const buffer = Buffer.alloc(64 * 1024);
        let total = 0n;
        for (;;) {
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
          if (bytesRead === 0) break;
          total += BigInt(bytesRead);
          if (total > maximum) fail('BINARY_UNTRUSTED');
          hash.update(buffer.subarray(0, bytesRead));
        }
        if (hash.digest('hex') !== settings.binarySha256) fail('BINARY_UNTRUSTED');
      }
      if (!same(await handle.stat({ bigint: true })) ||
          !same(await lstat(path, { bigint: true })) || await realpath(settings.binaryPath) !== path) fail('BINARY_UNTRUSTED');
      verifiedBinary = { key, identity };
      return path;
    } finally { await handle.close(); }
  } catch { verifiedBinary = undefined; return fail('BINARY_UNTRUSTED'); }
}

export function recompileRuntimeCandidate(config: JsonObject, input: RuntimeSettings, generation: string): Candidate {
  const settings = parseRuntimeSettings(input);
  try {
    const controller = config['external-controller'];
    const dns = config.dns;
    if (settings.automaticGateway) {
      const compiled = recompileAutomaticGatewayConfig(config, settings.automaticGateway);
      if (compiled.id !== generation || typeof controller !== 'string' || typeof config.secret !== 'string') fail('CANDIDATE_UNTRUSTED');
      return compiled;
    }
    if (typeof controller !== 'string' || !/^127\.0\.0\.1:([1-9]\d{0,4})$/.test(controller) ||
        !dns || typeof dns !== 'object' || Array.isArray(dns) ||
        typeof dns.listen !== 'string' || !/^127\.0\.0\.1:([1-9]\d{0,4})$/.test(dns.listen) ||
        typeof config.secret !== 'string') fail('CANDIDATE_UNTRUSTED');
    const policy = expandCompilerRuleSets(config);
    for (const key of ['allow-lan', 'bind-address', 'mixed-port', 'external-controller', 'secret', 'tun', 'ipv6', 'dns', 'sniffer']) delete policy[key];
    const compiled = compileConfig({ schemaVersion: 1, deployment: {
      mixedPort: config['mixed-port'], controllerPort: Number(controller.slice(10)), controllerSecret: config.secret,
      dnsPort: Number(dns.listen.slice(10)), bootstrapResolvers: dns['default-nameserver'], ...deploymentDnsOptions(config),
    }, policy });
    if (compiled.id !== generation) fail('CANDIDATE_UNTRUSTED');
    return compiled;
  } catch { return fail('CANDIDATE_UNTRUSTED'); }
}

export async function loadRuntimeCandidate(input: RuntimeSettings, generation: string): Promise<RuntimeCandidate> {
  return structuredClone(await loadRuntimeCandidateReadonly(input, generation));
}

/** Internal readers share immutable data, after the same current-file checks. */
export async function loadRuntimeCandidateReadonly(input: RuntimeSettings, generation: string): Promise<RuntimeCandidate> {
  const settings = parseRuntimeSettings(input);
  if (typeof generation !== 'string' || !digest.test(generation)) fail('INVALID_RUNTIME_GENERATION');
  try {
    await inspectPrivateDirectory(settings.stateDirectory);
    await inspectPrivateDirectory(posix.join(settings.stateDirectory, 'candidates'));
    const store = new FileTransactionStore(settings.stateDirectory);
    const path = await store.readCandidate(generation);
    // Recheck the second read as well: replacement between reads cannot smuggle
    // bytes which were never checked by the immutable candidate store.
    const bytes = await privateRead(path);
    if (createHash('sha256').update(bytes).digest('hex') !== generation) fail('CANDIDATE_UNTRUSTED');
    const key = JSON.stringify([settings, generation]);
    const cached = compiledCandidates.get(key);
    if (cached) return cached;
    const config = JSON.parse(bytes) as JsonObject;
    const compiled = recompileRuntimeCandidate(config, settings, generation);
    const controller = config['external-controller'] as string;
    return rememberCandidate(key, { candidate: compiled, path, controller: { port: Number(controller.slice(10)), secret: config.secret as string },
      home: posix.join(settings.stateDirectory, 'core-home') });
  } catch { return fail('CANDIDATE_UNTRUSTED'); }
}

export function parseRuntimeSelection(input: unknown): RuntimeSelection {
  try {
    const value = plainRecord(input, ['schemaVersion', 'generation'], ['hot']);
    if (value.schemaVersion !== 1 || typeof value.generation !== 'string' || !digest.test(value.generation)) fail('SELECTION_UNTRUSTED');
    if (value.hot !== undefined) {
      const hot = plainRecord(value.hot, ['pid', 'bootId', 'startTime', 'baseGeneration']);
      if (typeof hot.pid !== 'number' || !Number.isSafeInteger(hot.pid) || hot.pid <= 1 ||
          typeof hot.bootId !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(hot.bootId) ||
          typeof hot.startTime !== 'string' || !/^[1-9]\d{0,31}$/.test(hot.startTime) ||
          typeof hot.baseGeneration !== 'string' || !digest.test(hot.baseGeneration)) fail('SELECTION_UNTRUSTED');
    }
    return value as unknown as RuntimeSelection;
  } catch { return fail('SELECTION_UNTRUSTED'); }
}

/** Read-only selection lookup; it never creates a missing state directory. */
export async function readRuntimeSelection(input: RuntimeSettings): Promise<RuntimeSelection | null> {
  const settings = parseRuntimeSettings(input);
  let bytes: string;
  try {
    await inspectPrivateDirectory(settings.stateDirectory);
    bytes = await privateRead(posix.join(settings.stateDirectory, 'selection.json'), 4096);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    return fail('SELECTION_UNTRUSTED');
  }
  try {
    return parseRuntimeSelection(JSON.parse(bytes));
  } catch { return fail('SELECTION_UNTRUSTED'); }
}

export async function readSelection(input: RuntimeSettings): Promise<string | null> {
  return (await readRuntimeSelection(input))?.generation ?? null;
}
