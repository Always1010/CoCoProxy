import { createHash } from 'node:crypto';
import { open, readdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { canonicalJson, type JsonObject } from '../config/index.ts';
import { privateRead, inspectPrivateDirectory } from '../storage/private-files.ts';
import { parseAdminCredential, type AdminCredential } from '../management/auth.ts';
import { migrateTrustedDeviceDocument, parseTrustedDeviceDocument } from '../management/trusted-devices.ts';
import { inspectUsageDatabase, inspectUsageFiles, USAGE_DATABASE } from '../management/usage.ts';
import { parseAutomaticBindings } from '../management/automatic-bindings.ts';
import { parseAutomaticHistory, AUTOMATIC_HISTORY_FILE_LIMIT } from '../management/automatic-history.ts';
import { parseWorkspaceDocument } from '../management/workspace.ts';
import { parseSiteProbeState } from '../management/site-probes.ts';
import { parseDraftDocument } from '../drafts/index.ts';
import { isSubscriptionTemporaryName, parseSourceRecord } from '../subscriptions/index.ts';
import { parseStoredCandidate, parseTransactionState } from '../transaction/index.ts';
import { parseRuntimeLifecycle } from '../runtime/lifecycle.ts';
import { loadRuntimeSettings, parseRuntimeSelection, recompileRuntimeCandidate } from '../runtime/settings.ts';
import type { RuntimeSettings } from '../runtime/types.ts';

const digest = (bytes: string) => createHash('sha256').update(bytes).digest('hex');
const hash = (value: unknown) => digest(canonicalJson(value as JsonObject));
const stores = {
  transaction: ['state.json', 65536], lifecycle: ['lifecycle.json', 4096], trustedDevices: ['auth/trusted-devices.json', 131072],
  workspace: ['workspace.json', 1048576],
  siteProbes: ['site-probes.json', 1048576], draft: ['draft.json', 4194304], automaticSelections: ['automatic-selections.json', 262144],
  automaticHistory: ['automatic-history.json', AUTOMATIC_HISTORY_FILE_LIMIT],
  selection: ['selection.json', 4096],
} as const;
type Store = keyof typeof stores;
type Documents = Record<Store, string | null>;
type ContentCheck = { id: string; status: 'pass' | 'fail' | 'not-applicable'; code: string; evidenceScope: 'current-reader-content-validation' };
export class PreservationError extends Error {
  readonly code: string;
  constructor(code = 'REMOTE_PRESERVATION_SNAPSHOT_UNAVAILABLE') { super(code); this.code = code; }
}
function need(value: unknown): asserts value { if (!value) throw new PreservationError(); }

/** No state values leave this projection: only fixed roles, digests and expiry metadata. */
export function summarizePreservation(documents: Documents, sources: Record<string, string>, candidate: string | null,
  context: { origin: string; credential: AdminCredential; settings: RuntimeSettings; now: number }) {
  const checks: ContentCheck[] = [];
  function validate<T>(id: string, bytes: string | null, parser: (input: unknown) => T): T | null {
    if (bytes === null) { checks.push({ id, status: 'not-applicable', code: 'REMOTE_PRESERVATION_ABSENT', evidenceScope: 'current-reader-content-validation' }); return null; }
    try {
      const value = parser(JSON.parse(bytes));
      checks.push({ id, status: 'pass', code: 'REMOTE_PRESERVATION_CONTENT_READABLE', evidenceScope: 'current-reader-content-validation' }); return value;
    } catch {
      checks.push({ id, status: 'fail', code: 'REMOTE_PRESERVATION_CONTENT_INVALID', evidenceScope: 'current-reader-content-validation' }); return null;
    }
  }
  const transaction = validate('transaction', documents.transaction, parseTransactionState);
  validate('lifecycle', documents.lifecycle, parseRuntimeLifecycle);
  const devices = validate('trustedDevices', documents.trustedDevices, parseTrustedDeviceDocument);
  const workspace = validate('workspace', documents.workspace, parseWorkspaceDocument);
  const siteProbes = validate('siteProbes', documents.siteProbes, parseSiteProbeState);
  const draft = validate('draft', documents.draft, parseDraftDocument);
  validate('automaticSelections', documents.automaticSelections, parseAutomaticBindings);
  validate('automaticHistory', documents.automaticHistory, parseAutomaticHistory);
  const selection = validate('selection', documents.selection, parseRuntimeSelection);
  const sourceSettings: unknown[] = [];
  for (const [id, bytes] of Object.entries(sources).sort(([a], [b]) => a.localeCompare(b))) {
    const parsed = validate('subscriptions', bytes, value => parseSourceRecord(value, id));
    if (parsed) sourceSettings.push({ id: parsed.id, url: parsed.url, definitionRevision: parsed.definitionRevision, name: parsed.name ?? null });
  }
  if (!Object.keys(sources).length) checks.push({ id: 'subscriptions', status: 'not-applicable', code: 'REMOTE_PRESERVATION_ABSENT', evidenceScope: 'current-reader-content-validation' });
  if (transaction?.active) validate('activeCandidate', candidate, () => {
    need(candidate !== null);
    return recompileRuntimeCandidate(parseStoredCandidate(candidate, transaction.active!), context.settings, transaction.active!);
  });
  else if (candidate !== null) throw new PreservationError();
  const epoch = digest(JSON.stringify({ origin: context.origin, credential: parseAdminCredential(context.credential) }));
  const currentDevices = devices?.credentialFingerprint === epoch ? migrateTrustedDeviceDocument(devices, context.now).devices : [];
  const identity = { origin: digest(context.origin), credential: hash(parseAdminCredential(context.credential)), epoch };
  const trusted = currentDevices.map(device => ({ id: digest(device.id), stable: hash({ id: device.id, tokenDigest: device.tokenDigest,
    label: device.label, trust: device.trust, createdAt: device.createdAt }), renewedAt: device.renewedAt, expiresAt: device.expiresAt }));
  const files = Object.fromEntries(Object.entries(documents).map(([id, bytes]) => [id, bytes === null ? null : digest(bytes)]));
  files.subscriptions = Object.keys(sources).length ? hash(Object.entries(sources).sort(([a], [b]) => a.localeCompare(b)).map(([id, bytes]) => [id, digest(bytes)])) : null;
  files.activeCandidate = candidate === null ? null : digest(candidate);
  const coherent = transaction ? transaction.pending === null && transaction.fault === null &&
    (transaction.active === null ? selection === null : selection?.generation === transaction.active && checks.some(check => check.id === 'activeCandidate' && check.status === 'pass')) : selection === null;
  return { schemaVersion: 1, observedAt: context.now, identity, files, contentChecks: checks,
    stable: { workspace: workspace === null ? null : hash({ ...workspace, revision: 0 }), siteProbes: siteProbes === null ? null : hash({ ...siteProbes, revision: 0 }),
      draft: draft === null ? null : hash({ input: draft.input, generation: draft.generation }), subscriptions: hash(sourceSettings) },
    trusted: { binding: devices === null ? 'absent' : devices.credentialFingerprint === epoch ? 'current' : 'invalidated', devices: trusted },
    // Matching committed active/selection is the same necessary binding checked by SystemdMihomoRuntime.observe.
    // It does not claim a process or controller is healthy; the coordinator performs runtime-status separately.
    runtime: { coherent, code: coherent ? 'REMOTE_PRESERVATION_RUNTIME_BINDING_VALID' : 'REMOTE_PRESERVATION_RUNTIME_RECOVERY_REQUIRED',
      active: transaction?.active ?? null, selection: selection?.generation ?? null,
      automaticBindingsReadable: checks.some(check => check.id === 'automaticSelections' && check.status !== 'fail') },
    ready: checks.every(check => check.status !== 'fail') && coherent };
}

/** Hash database files in bounded chunks; never copy private usage or include raw rows in receipts. */
export async function captureUsagePreservation(directory: string, frozen = true) {
  const usage = await inspectUsageDatabase(directory);
  if (usage === null) return { usage: null, files: null };
  const projection = { identity: usage.identity, aliasDigest: usage.aliasDigest, schemaVersion: usage.schemaVersion };
  if (!frozen) return { usage: projection, files: hash(projection) };
  const checksums: Record<string, string | null> = {};
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    const path = join(directory, USAGE_DATABASE + suffix);
    let file;
    try { file = await open(path, constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { checksums[suffix || 'main'] = null; continue; } throw error; }
    try {
      const before = await file.stat();
      need(before.isFile() && before.nlink === 1 && (process.platform === 'win32' || before.uid === process.geteuid?.() && (before.mode & 0o077) === 0));
      const hash = createHash('sha256'), chunk = Buffer.alloc(1024 * 1024);
      for (;;) { const { bytesRead } = await file.read(chunk); if (!bytesRead) break; hash.update(chunk.subarray(0, bytesRead)); }
      const after = await file.stat();
      need(before.size === after.size && before.mtimeMs === after.mtimeMs);
      checksums[suffix || 'main'] = hash.digest('hex');
    } finally { await file.close(); }
  }
  await inspectUsageFiles(directory);
  return { usage: projection, files: hash(checksums) };
}

/** Service-UID-only file reads; no store initialization, locks, service objects or network. */
export async function capturePreservation(managementSettingsPath: string, frozen = false) {
  need(isAbsolute(managementSettingsPath));
  const managementBytes = await privateRead(managementSettingsPath, 65536);
  const management = JSON.parse(managementBytes);
  need(management?.schemaVersion === 1 && typeof management.origin === 'string' && new URL(management.origin).origin === management.origin &&
    typeof management.credentialPath === 'string' && isAbsolute(management.credentialPath) && typeof management.runtimeSettingsPath === 'string');
  const runtimeBytes = await privateRead(management.runtimeSettingsPath, 65536);
  const settings = await loadRuntimeSettings(management.runtimeSettingsPath);
  if (process.platform !== 'win32') need(process.geteuid?.() === settings.serviceUid);
  await inspectPrivateDirectory(settings.stateDirectory);
  const credentialBytes = await privateRead(management.credentialPath, 16384);
  const credential = parseAdminCredential(JSON.parse(credentialBytes));
  const directoryRoles = { state: '', auth: 'auth', subscriptions: 'subscriptions', candidates: 'candidates' };
  const directories: Record<string, { present: boolean; entries: string | null }> = {};
  const names: Record<string, string[]> = {};
  for (const [role, name] of Object.entries(directoryRoles)) {
    const path = join(settings.stateDirectory, name);
    try {
      await inspectPrivateDirectory(path); const entries = (await readdir(path)).sort(); need(entries.length <= 12000);
      directories[role] = { present: true, entries: hash(entries) }; names[role] = entries;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      directories[role] = { present: false, entries: null }; names[role] = [];
    }
  }
  const optional = async (path: string, maximum: number) => {
    try { return await privateRead(path, maximum); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  };
  const documents = {} as Documents;
  for (const [role, [path, maximum]] of Object.entries(stores)) documents[role as Store] = await optional(join(settings.stateDirectory, path), maximum);
  const sources: Record<string, string> = {};
  for (const name of names.subscriptions) {
    if (isSubscriptionTemporaryName(name)) continue;
    need(/^[A-Za-z][A-Za-z0-9_-]{0,63}\.json$/.test(name));
    sources[name.slice(0, -5)] = await privateRead(join(settings.stateDirectory, 'subscriptions', name), 4194304);
  }
  let active: string | null = null;
  try { active = documents.transaction === null ? null : parseTransactionState(JSON.parse(documents.transaction)).active; }
  catch { /* The shared parser below reports invalid content without exposing bytes. */ }
  let candidate: string | null = null;
  const candidates: [string, string][] = [];
  for (const name of names.candidates) {
    if (isSubscriptionTemporaryName(name)) continue;
    need(/^[a-f0-9]{64}\.json$/.test(name));
    const bytes = await privateRead(join(settings.stateDirectory, 'candidates', name));
    need(digest(bytes) === name.slice(0, -5)); candidates.push([name, digest(bytes)]);
    if (name === active + '.json') candidate = bytes;
  }
  if (active !== null && candidate === null) throw new PreservationError('REMOTE_PRESERVATION_CANDIDATE_MISSING');
  const snapshot = summarizePreservation(documents, sources, candidate, { origin: management.origin, credential, settings, now: Date.now() });
  const usage = await captureUsagePreservation(settings.stateDirectory, frozen);
  snapshot.files.usage = usage.files;
  snapshot.contentChecks.push({ id: 'usage', status: usage.usage === null ? 'not-applicable' : 'pass', code: usage.usage === null ? 'REMOTE_PRESERVATION_ABSENT' : 'REMOTE_PRESERVATION_CONTENT_READABLE', evidenceScope: 'current-reader-content-validation' });
  snapshot.files.candidates = hash(candidates);
  snapshot.files.administrator = digest(credentialBytes);
  // A snapshot spans several atomic readers. Reject concurrent changes instead of mixing generations.
  for (const [role, [path, maximum]] of Object.entries(stores)) need(await optional(join(settings.stateDirectory, path), maximum) === documents[role as Store]);
  for (const [id, bytes] of Object.entries(sources)) need(await privateRead(join(settings.stateDirectory, 'subscriptions', id + '.json'), 4194304) === bytes);
  for (const [name, checksum] of candidates) need(digest(await privateRead(join(settings.stateDirectory, 'candidates', name))) === checksum);
  for (const [role, name] of Object.entries(directoryRoles)) {
    const path = join(settings.stateDirectory, name);
    try { need(directories[role].present && hash((await readdir(path)).sort()) === directories[role].entries); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || directories[role].present) throw error; }
  }
  // Credential replacement during the reads revokes the captured binding.
  need(await privateRead(managementSettingsPath, 65536) === managementBytes && await privateRead(management.runtimeSettingsPath, 65536) === runtimeBytes &&
    await privateRead(management.credentialPath, 16384) === credentialBytes);
  return { ...snapshot, directories, usage: usage.usage };
}
