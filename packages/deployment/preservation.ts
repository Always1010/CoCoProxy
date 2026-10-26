import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { canonicalJson, type JsonObject } from '../config/index.ts';
import { privateRead, inspectPrivateDirectory } from '../storage/private-files.ts';
import { parseAdminCredential, type AdminCredential } from '../management/auth.ts';
import { parseTrustedDeviceDocument } from '../management/trusted-devices.ts';
import { parseNotificationEnvelope } from '../management/notifications.ts';
import { parseAutomaticBindings } from '../management/automatic-bindings.ts';
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
  notifications: ['notifications/state.json', 2097152], workspace: ['workspace.json', 1048576],
  siteProbes: ['site-probes.json', 1048576], draft: ['draft.json', 4194304], automaticSelections: ['automatic-selections.json', 262144],
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
  const notification = validate('notifications', documents.notifications, parseNotificationEnvelope);
  const workspace = validate('workspace', documents.workspace, parseWorkspaceDocument);
  const siteProbes = validate('siteProbes', documents.siteProbes, parseSiteProbeState);
  const draft = validate('draft', documents.draft, parseDraftDocument);
  validate('automaticSelections', documents.automaticSelections, parseAutomaticBindings);
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
  const currentDevices = devices?.credentialFingerprint === epoch ? devices.devices : [];
  const notificationCurrent = notification?.epoch === epoch;
  const identity = { origin: digest(context.origin), credential: hash(parseAdminCredential(context.credential)), epoch };
  const trusted = currentDevices.map(device => ({ id: digest(device.id), stable: hash({ id: device.id, tokenDigest: device.tokenDigest,
    label: device.label, trust: device.trust, createdAt: device.createdAt }), renewedAt: device.renewedAt, expiresAt: device.expiresAt }));
  const subscriptions = notificationCurrent ? notification!.state.subscriptions.filter(item => currentDevices.some(device => device.id === item.deviceId &&
    (device.expiresAt === null || device.expiresAt > context.now))).map(item => ({ device: digest(item.deviceId),
    stable: hash({ subscription: item.subscription, preferences: item.preferences }) })) : [];
  const files = Object.fromEntries(Object.entries(documents).map(([id, bytes]) => [id, bytes === null ? null : digest(bytes)]));
  files.subscriptions = Object.keys(sources).length ? hash(Object.entries(sources).sort(([a], [b]) => a.localeCompare(b)).map(([id, bytes]) => [id, digest(bytes)])) : null;
  files.activeCandidate = candidate === null ? null : digest(candidate);
  const coherent = transaction ? transaction.pending === null && transaction.fault === null &&
    (transaction.active === null ? selection === null : selection?.generation === transaction.active && checks.some(check => check.id === 'activeCandidate' && check.status === 'pass')) : selection === null;
  return { schemaVersion: 1, observedAt: context.now, identity, files, contentChecks: checks,
    stable: { workspace: workspace === null ? null : hash({ ...workspace, revision: 0 }), siteProbes: siteProbes === null ? null : hash({ ...siteProbes, revision: 0 }),
      draft: draft === null ? null : hash({ input: draft.input, generation: draft.generation }), subscriptions: hash(sourceSettings) },
    trusted: { binding: devices === null ? 'absent' : devices.credentialFingerprint === epoch ? 'current' : 'invalidated', devices: trusted },
    notifications: { binding: notification === null ? 'absent' : notificationCurrent ? 'current' : 'invalidated',
      keys: notificationCurrent && notification!.state.keys ? hash(notification!.state.keys) : null, subscriptions },
    // Matching committed active/selection is the same necessary binding checked by SystemdMihomoRuntime.observe.
    // It does not claim a process or controller is healthy; the coordinator performs runtime-status separately.
    runtime: { coherent, code: coherent ? 'REMOTE_PRESERVATION_RUNTIME_BINDING_VALID' : 'REMOTE_PRESERVATION_RUNTIME_RECOVERY_REQUIRED',
      active: transaction?.active ?? null, selection: selection?.generation ?? null,
      automaticBindingsReadable: checks.some(check => check.id === 'automaticSelections' && check.status !== 'fail') },
    ready: checks.every(check => check.status !== 'fail') && coherent };
}

/** Service-UID-only file reads; no store initialization, locks, service objects or network. */
export async function capturePreservation(managementSettingsPath: string) {
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
  const directoryRoles = { state: '', auth: 'auth', notifications: 'notifications', subscriptions: 'subscriptions', candidates: 'candidates' };
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
  return { ...snapshot, directories };
}
