import { join } from 'node:path';
import { types } from 'node:util';
import { canonicalJson, type JsonObject } from '../config/index.ts';
import { FileTransactionStore, TransactionError } from '../transaction/index.ts';
import { atomicWrite, inspectPrivateDirectory, privateRead, PrivateFileError } from '../storage/private-files.ts';
import { parseAutoGroupPolicy, parseAutoProbeSettings, type AutoGroupPolicy, type AutoProbeSettings } from './automatic-policy.ts';

export type RoutingOverrides = { selections: Record<string, string>; rules: string[]; automatic?: Record<string, AutoGroupPolicy> };
export type WorkspaceSettings = {
  mode: 'legacy' | 'local' | 'subscription';
  subscriptionId: string | null;
  sourceIds: string[];
  runMode: 'rule' | 'global' | 'direct';
  local: RoutingOverrides;
  subscriptionOverrides: Record<string, RoutingOverrides>;
  autoProbes?: AutoProbeSettings;
};
export type Workspace = WorkspaceSettings & { revision: number };
export class WorkspaceError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.name = 'WorkspaceError'; this.code = code; }
}
function fail(code = 'WORKSPACE_INVALID'): never { throw new WorkspaceError(code); }
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value);
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail();
  return value as Record<string, unknown>;
}
function exact(value: unknown, keys: string[]): Record<string, unknown> {
  const record = object(value);
  if (Object.keys(record).length !== keys.length || Object.keys(record).some(key => !keys.includes(key))) fail();
  return record;
}
function string(value: unknown, max = 1024): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
}
function overrides(value: unknown): RoutingOverrides {
  const record = object(value);
  if (!Object.hasOwn(record, 'selections') || !Object.hasOwn(record, 'rules') || Object.keys(record).some(key => !['selections', 'rules', 'automatic'].includes(key))) fail();
  const selections = object(record.selections);
  if (Object.keys(selections).length > 100 || Object.entries(selections).some(([key, target]) =>
    !string(key) || ['__proto__', 'prototype', 'constructor'].includes(key) || !string(target))) fail();
  if (!Array.isArray(record.rules) || record.rules.length > 512 || record.rules.some(rule => !string(rule, 8192))) fail();
  let automatic: Record<string, AutoGroupPolicy> | undefined;
  if (record.automatic !== undefined) {
    const policies = object(record.automatic);
    if (Object.keys(policies).length > 100) fail();
    automatic = Object.create(null) as Record<string, AutoGroupPolicy>;
    for (const [key, policy] of Object.entries(policies)) {
      if (!string(key) || ['__proto__', 'prototype', 'constructor'].includes(key)) fail();
      try { automatic[key] = parseAutoGroupPolicy(policy); } catch { fail('AUTO_SETTINGS_INVALID'); }
    }
  }
  return { selections: { ...selections } as Record<string, string>, rules: [...record.rules] as string[], ...(automatic ? { automatic } : {}) };
}
export function parseWorkspaceSettings(input: unknown): WorkspaceSettings {
  let budget = 100_000;
  const ancestors = new Set<object>();
  function inspect(value: unknown, depth: number): void {
    if (--budget < 0 || depth > 32) fail();
    if (value === null || ['string', 'boolean'].includes(typeof value) || (typeof value === 'number' && Number.isFinite(value))) return;
    if (!value || typeof value !== 'object' || types.isProxy(value) || ancestors.has(value)) fail();
    const array = Array.isArray(value);
    if (!array && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail();
    if (array && (value.length > budget || Reflect.ownKeys(value).length !== value.length + 1)) fail();
    ancestors.add(value);
    for (const key of Reflect.ownKeys(value)) {
      if (array && key === 'length') continue;
      if (typeof key !== 'string' || ['__proto__', 'constructor', 'prototype'].includes(key)) fail();
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (!descriptor.enumerable || !('value' in descriptor)) fail();
      inspect(descriptor.value, depth + 1);
    }
    ancestors.delete(value);
  }
  inspect(input, 0);
  const record = object(input);
  const required = ['mode', 'subscriptionId', 'sourceIds', 'runMode', 'local', 'subscriptionOverrides'];
  if (required.some(key => !Object.hasOwn(record, key)) || Object.keys(record).some(key => ![...required, 'autoProbes'].includes(key))) fail();
  if (!['legacy', 'local', 'subscription'].includes(record.mode as string) || !['rule', 'global', 'direct'].includes(record.runMode as string)) fail();
  if (!(record.subscriptionId === null || id(record.subscriptionId))) fail();
  if (record.mode === 'subscription' && record.subscriptionId === null) fail('PROFILE_REQUIRED');
  if (!Array.isArray(record.sourceIds) || record.sourceIds.length > 100 || record.sourceIds.some(item => !id(item)) || new Set(record.sourceIds).size !== record.sourceIds.length) fail();
  const profiles = object(record.subscriptionOverrides);
  if (Object.keys(profiles).length > 101 || Object.keys(profiles).some(key => !id(key))) fail();
  const subscriptionOverrides: Record<string, RoutingOverrides> = Object.create(null);
  for (const [key, value] of Object.entries(profiles)) subscriptionOverrides[key] = overrides(value);
  let autoProbes: AutoProbeSettings | undefined;
  if (record.autoProbes !== undefined) {
    try { autoProbes = parseAutoProbeSettings(record.autoProbes); } catch { fail('AUTO_SETTINGS_INVALID'); }
  }
  return { mode: record.mode as WorkspaceSettings['mode'], runMode: record.runMode as WorkspaceSettings['runMode'],
    subscriptionId: record.subscriptionId as string | null, sourceIds: [...record.sourceIds] as string[], local: overrides(record.local), subscriptionOverrides,
    ...(autoProbes ? { autoProbes } : {}) };
}

export function parseWorkspaceDocument(input: unknown): Workspace {
  const value = exact(input, ['version', 'revision', 'settings']);
  if (value.version !== 1 || !Number.isSafeInteger(value.revision) || (value.revision as number) < 1) fail('WORKSPACE_CORRUPT');
  return { ...parseWorkspaceSettings(value.settings), revision: value.revision as number };
}

/** Private plan preferences use the same lock and durability boundary as config writes. */
export class WorkspaceStore {
  readonly files: FileTransactionStore;
  readonly root: string;
  constructor(root: string) { this.files = new FileTransactionStore(root); this.root = this.files.root; }

  async read(): Promise<Workspace | null> {
    try {
      await inspectPrivateDirectory(this.root);
      return parseWorkspaceDocument(JSON.parse(await privateRead(join(this.root, 'workspace.json'), 1_048_576)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      if (error instanceof WorkspaceError || error instanceof PrivateFileError) throw new WorkspaceError('WORKSPACE_CORRUPT');
      throw new WorkspaceError('WORKSPACE_CORRUPT');
    }
  }

  async save(input: unknown, expectedRevision: number): Promise<Workspace> {
    const settings = parseWorkspaceSettings(input);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || expectedRevision >= Number.MAX_SAFE_INTEGER) fail();
    try {
      return await this.files.exclusive(async () => {
        const current = await this.read();
        if ((current?.revision ?? 0) !== expectedRevision) throw new TransactionError('WORKSPACE_CONFLICT');
        const revision = expectedRevision + 1;
        const contents = canonicalJson({ version: 1, revision, settings } as unknown as JsonObject);
        if (Buffer.byteLength(contents) > 1_048_576) throw new TransactionError('WORKSPACE_INVALID');
        await atomicWrite(this.root, 'workspace.json', contents);
        return { ...settings, revision };
      });
    } catch (error) { throw new WorkspaceError(error instanceof TransactionError ? error.code : 'WORKSPACE_UNAVAILABLE'); }
  }
}

/** Preserve an existing draft until the user explicitly chooses another scheme. */
export function initialWorkspace(policy: JsonObject | null, sourceIds: string[]): Workspace {
  return { revision: 0, mode: policy ? 'legacy' : 'local', subscriptionId: null, sourceIds: sourceIds.slice(0, 1), runMode: 'rule',
    local: { selections: {}, rules: [] }, subscriptionOverrides: { legacy: { selections: {}, rules: [] } } };
}
