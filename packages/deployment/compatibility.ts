import { DEPLOYMENT_STATE_COMPATIBILITY } from './state-compatibility.mjs';
import { parseTransactionState } from '../transaction/index.ts';
import { parseDraftDocument } from '../drafts/index.ts';
import { parseRuntimeLifecycle } from '../runtime/lifecycle.ts';
import { parseRuntimeSelection } from '../runtime/settings.ts';
import { parseTrustedDeviceDocument } from '../management/trusted-devices.ts';
import { parseWorkspaceDocument } from '../management/workspace.ts';
import { parseSiteProbeState } from '../management/site-probes.ts';
import { parseAutomaticBindings } from '../management/automatic-bindings.ts';
import { parseBandwidthLedger } from '../management/bandwidth-selector.ts';
import { parseBandwidthHistory, BANDWIDTH_HISTORY_FILE, BANDWIDTH_HISTORY_LIMIT } from '../management/bandwidth-history.ts';
import { parseAutomaticHistory, AUTOMATIC_HISTORY_FILE_LIMIT } from '../management/automatic-history.ts';
import { parseSourceRecord } from '../subscriptions/index.ts';
export { DEPLOYMENT_STATE_COMPATIBILITY } from './state-compatibility.mjs';
export type StateStore = keyof typeof DEPLOYMENT_STATE_COMPATIBILITY.stateSchemas;
export const DEPLOYMENT_STATE_FILES: readonly { store: StateStore; path: string; key: 'version' | 'schemaVersion'; limit: number }[] = [
  { store: 'transaction', path: 'state.json', key: 'version', limit: 65536 },
  { store: 'lifecycle', path: 'lifecycle.json', key: 'schemaVersion', limit: 4096 },
  { store: 'trustedDevices', path: 'auth/trusted-devices.json', key: 'schemaVersion', limit: 131072 },
  { store: 'draft', path: 'draft.json', key: 'version', limit: 4194304 },
  { store: 'workspace', path: 'workspace.json', key: 'version', limit: 1048576 },
  { store: 'siteProbes', path: 'site-probes.json', key: 'version', limit: 1048576 },
  { store: 'automaticSelections', path: 'automatic-selections.json', key: 'version', limit: 262144 },
  { store: 'automaticHistory', path: 'automatic-history.json', key: 'version', limit: AUTOMATIC_HISTORY_FILE_LIMIT },
  { store: 'automaticBandwidth', path: 'automatic-bandwidth.json', key: 'version', limit: 1048576 },
  { store: 'bandwidthHistory', path: BANDWIDTH_HISTORY_FILE, key: 'version', limit: BANDWIDTH_HISTORY_LIMIT },
  { store: 'selection', path: 'selection.json', key: 'schemaVersion', limit: 4096 },
];
export function assessStateSchema(store: StateStore, observedVersion: unknown, declaration: unknown) {
  const contract = declaration as typeof DEPLOYMENT_STATE_COMPATIBILITY | undefined;
  if (!Number.isSafeInteger(observedVersion) || (observedVersion as number) < 1) return 'invalid' as const;
  if (!contract || contract.schemaVersion !== 1 || !contract.stateSchemas || !Object.hasOwn(contract.stateSchemas, store)) return 'not-declared' as const;
  // v2 deliberately reads and migrates the legacy grant document without revoking tokens.
  if (store === 'trustedDevices' && observedVersion === 1 && contract.stateSchemas.trustedDevices === 2) return 'supported-version' as const;
  return contract.stateSchemas[store] === observedVersion ? 'supported-version' as const : 'unsupported-version' as const;
}
export type CompatibilityStatus = 'supported' | 'unsupported' | 'unknown';
export interface StateContentAssessment {
  status: CompatibilityStatus; code: string;
  content: 'valid' | 'invalid' | 'not-assessed';
  version: ReturnType<typeof assessStateSchema>;
  scope: 'current-reader-content-and-declared-format';
}
/** Validate the same complete representation accepted by runtime readers, without I/O or identity invalidation. */
export function assessStateContent(store: StateStore, input: unknown, declaration: unknown, sourceId?: string): StateContentAssessment {
  const file = DEPLOYMENT_STATE_FILES.find(file => file.store === store);
  const record = input as Record<string, unknown> | null;
  const version = assessStateSchema(store, record?.[store === 'usage' ? 'schemaVersion' : file?.key ?? 'version'], declaration);
  const result = (status: CompatibilityStatus, code: string, content: StateContentAssessment['content']): StateContentAssessment =>
    ({ status, code, content, version, scope: 'current-reader-content-and-declared-format' });
  if (version === 'invalid' || version === 'unsupported-version') return result('unsupported', 'DEPLOYMENT_STATE_VERSION_UNSUPPORTED', 'not-assessed');
  if (store === 'subscription' && !sourceId) return result('unknown', 'DEPLOYMENT_STATE_SOURCE_CONTEXT_REQUIRED', 'not-assessed');
  try {
    switch (store) {
      case 'transaction': parseTransactionState(input); break;
      case 'lifecycle': parseRuntimeLifecycle(input); break;
      case 'trustedDevices': parseTrustedDeviceDocument(input); break;
      case 'draft': parseDraftDocument(input); break;
      case 'workspace': parseWorkspaceDocument(input); break;
      case 'siteProbes': parseSiteProbeState(input); break;
      case 'automaticSelections': parseAutomaticBindings(input); break;
      case 'automaticHistory': parseAutomaticHistory(input); break;
      case 'automaticBandwidth': parseBandwidthLedger(input); break;
      case 'bandwidthHistory': parseBandwidthHistory(input); break;
      case 'selection': parseRuntimeSelection(input); break;
      case 'subscription': parseSourceRecord(input, sourceId!); break;
      // The database host supplies this evidence only after the actual SQLite reader/integrity check.
      case 'usage': if (record?.integrity !== 'ok') throw new Error(); break;
    }
  } catch { return result('unsupported', 'DEPLOYMENT_STATE_CONTENT_INVALID', 'invalid'); }
  const contract = declaration as { schemaVersion?: unknown; contentReaders?: Record<string, unknown> } | undefined;
  if (version === 'not-declared' || !contract?.contentReaders || !Object.hasOwn(contract.contentReaders, store)) {
    return result('unknown', 'DEPLOYMENT_STATE_CONTENT_READER_NOT_DECLARED', 'valid');
  }
  return contract.contentReaders[store] === DEPLOYMENT_STATE_COMPATIBILITY.contentReaders[store]
    ? result('supported', 'DEPLOYMENT_STATE_CONTENT_SUPPORTED', 'valid') : result('unknown', 'DEPLOYMENT_STATE_CONTENT_READER_UNKNOWN', 'valid');
}
