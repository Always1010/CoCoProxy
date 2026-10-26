import { DEPLOYMENT_STATE_COMPATIBILITY } from './state-compatibility.mjs';
export { DEPLOYMENT_STATE_COMPATIBILITY } from './state-compatibility.mjs';
export type StateStore = keyof typeof DEPLOYMENT_STATE_COMPATIBILITY.stateSchemas;
export const DEPLOYMENT_STATE_FILES: readonly { store: StateStore; path: string; key: 'version' | 'schemaVersion'; nested?: 'state'; limit: number }[] = [
  { store: 'transaction', path: 'state.json', key: 'version', limit: 65536 },
  { store: 'lifecycle', path: 'lifecycle.json', key: 'schemaVersion', limit: 4096 },
  { store: 'trustedDevices', path: 'auth/trusted-devices.json', key: 'schemaVersion', limit: 131072 },
  { store: 'notifications', path: 'notifications/state.json', key: 'version', nested: 'state', limit: 2097152 },
  { store: 'draft', path: 'draft.json', key: 'version', limit: 4194304 },
  { store: 'workspace', path: 'workspace.json', key: 'version', limit: 1048576 },
  { store: 'siteProbes', path: 'site-probes.json', key: 'version', limit: 1048576 },
  { store: 'automaticSelections', path: 'automatic-selections.json', key: 'version', limit: 262144 },
  { store: 'selection', path: 'selection.json', key: 'schemaVersion', limit: 4096 },
];
export function assessStateSchema(store: StateStore, observedVersion: unknown, declaration: unknown) {
  const contract = declaration as typeof DEPLOYMENT_STATE_COMPATIBILITY | undefined;
  if (!Number.isSafeInteger(observedVersion) || (observedVersion as number) < 1) return 'invalid' as const;
  if (!contract || contract.schemaVersion !== 1 || !contract.stateSchemas || !Object.hasOwn(contract.stateSchemas, store)) return 'not-declared' as const;
  return contract.stateSchemas[store] === observedVersion ? 'supported-version' as const : 'unsupported-version' as const;
}
