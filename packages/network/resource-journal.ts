import { lstat } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { types } from 'node:util';
import { atomicWrite, privateRead } from '../storage/private-files.ts';
import { FileTransactionStore, TransactionError } from '../transaction/index.ts';
import { renderNetworkPlan, type NetworkPlanInput } from './plan.ts';

export type NativeResourceScope = 'production' | 'fixture';
export type NativeResourceMode = 'blocked' | 'core-only' | 'active';
export interface NativeResourceContext {
  bootID: string;
  userNS: string;
  netNS: string;
  ip: { path: string; sha256: string };
  nft: { path: string; sha256: string };
  rendererSHA: string;
  planSHA: string;
}
export interface NativeResourceState {
  expectedNft: string;
  ruleIds: number[];
  routeIds: string[];
  mode: NativeResourceMode | null;
  prepared: boolean;
  capture: boolean;
}
export type NativeResourceOperation = {
  kind: 'nft'; mode: NativeResourceMode; operation: 'create' | 'replace'; reset: boolean;
} | {
  kind: 'ip'; category: 'blackhole' | 'rule' | 'egress' | 'capture-add' | 'capture-remove'; index: number;
};
export interface NativeResourcePending {
  token: string;
  commandSHA: string;
  operation: NativeResourceOperation;
}
export interface NativeResourceReceipt {
  schemaVersion: 1;
  revision: number;
  scope: NativeResourceScope;
  context: NativeResourceContext;
  state: NativeResourceState;
  pending: NativeResourcePending | null;
  deployment: NetworkPlanInput;
}
export class ResourceJournalError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.name = 'ResourceJournalError'; this.code = code; }
}
const filename = 'native-resource-receipt.json';
const maximum = 2_097_152;
const fail: (code?: string) => never = (code = 'NETWORK_RESOURCE_STORE_CORRUPT') => { throw new ResourceJournalError(code); };
const errno = (error: unknown) => (error as NodeJS.ErrnoException)?.code;
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Obj = { [key: string]: Json };

/** Bounded parser preserves the distinction between absent and duplicate fields. */
function parse(raw: string): Json {
  if (Buffer.byteLength(raw) > maximum) fail();
  let at = 0, nodes = 0;
  const whitespace = () => { while (at < raw.length && ' \r\n\t'.includes(raw[at])) at++; };
  const string = (): string => {
    const start = at++;
    while (at < raw.length) {
      const c = raw[at++];
      if (c === '"') return JSON.parse(raw.slice(start, at));
      if (c === '\\') at++;
      else if (c.charCodeAt(0) < 32) fail();
    }
    return fail();
  };
  const value = (depth: number): Json => {
    if (++nodes > 100_000 || depth > 32) fail();
    whitespace();
    if (raw[at] === '"') return string();
    if (raw[at] === '{') {
      at++; whitespace(); const out: Obj = Object.create(null);
      if (raw[at] === '}') { at++; return out; }
      for (;;) {
        whitespace(); if (raw[at] !== '"') fail();
        const key = string();
        if (Object.hasOwn(out, key) || ['__proto__', 'constructor', 'prototype'].includes(key)) fail();
        whitespace(); if (raw[at++] !== ':') fail();
        out[key] = value(depth + 1); whitespace();
        const delimiter = raw[at++]; if (delimiter === '}') return out; if (delimiter !== ',') fail();
      }
    }
    if (raw[at] === '[') {
      at++; whitespace(); const out: Json[] = [];
      if (raw[at] === ']') { at++; return out; }
      for (;;) {
        out.push(value(depth + 1)); whitespace();
        const delimiter = raw[at++]; if (delimiter === ']') return out; if (delimiter !== ',') fail();
      }
    }
    const token = /^(?:null|true|false|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(raw.slice(at))?.[0];
    if (!token) fail();
    at += token.length;
    const out: Json = JSON.parse(token);
    if (typeof out === 'number' && (!Number.isSafeInteger(out) || Object.is(out, -0))) fail();
    return out;
  };
  const result = value(0); whitespace(); if (at !== raw.length) fail(); return result;
}
function object(value: unknown, keys: readonly string[]): Obj {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail();
  const descriptors = Object.getOwnPropertyDescriptors(value), found = Reflect.ownKeys(descriptors);
  if (found.length !== keys.length || found.some(key => typeof key !== 'string' || !keys.includes(key))) fail();
  const result: Obj = Object.create(null);
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor.enumerable || !('value' in descriptor)) fail();
    result[key] = descriptor.value;
  }
  return result;
}
function list(value: unknown, max: number): Json[] {
  if (!Array.isArray(value) || types.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype) fail();
  const descriptors = Object.getOwnPropertyDescriptors(value) as unknown as Record<string, PropertyDescriptor>;
  const length = descriptors.length.value as number;
  if (!Number.isSafeInteger(length) || length < 0 || length > max || Reflect.ownKeys(descriptors).length !== length + 1) fail();
  return Array.from({ length }, (_, i) => {
    const descriptor = descriptors[String(i)];
    if (!descriptor?.enumerable || !('value' in descriptor)) fail();
    return descriptor.value as Json;
  });
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const item of Object.values(value)) freeze(item); Object.freeze(value); }
  return value;
}
function validate(input: unknown, scope: NativeResourceScope): NativeResourceReceipt {
  const root = object(input, ['schemaVersion', 'revision', 'scope', 'context', 'state', 'pending', 'deployment']);
  const plan = renderNetworkPlan(root.deployment);
  if (root.schemaVersion !== 1 || root.scope !== scope || !Number.isSafeInteger(root.revision) ||
    (root.revision as number) < 0 || (root.revision as number) >= Number.MAX_SAFE_INTEGER) fail();
  const context = object(root.context, ['bootID', 'userNS', 'netNS', 'ip', 'nft', 'rendererSHA', 'planSHA']);
  if (!uuid(context.bootID) || typeof context.userNS !== 'string' || !/^user:\[[1-9]\d{0,19}\]$/.test(context.userNS) ||
    typeof context.netNS !== 'string' || !/^net:\[[1-9]\d{0,19}\]$/.test(context.netNS) ||
    !hash(context.rendererSHA) || context.planSHA !== plan.sha256) fail();
  const tools: Record<string, { path: string; sha256: string }> = {};
  for (const name of ['ip', 'nft'] as const) {
    const tool = object(context[name], ['path', 'sha256']);
    if (![`/usr/bin/${name}`, `/usr/sbin/${name}`].includes(tool.path as string) || !hash(tool.sha256)) fail();
    tools[name] = { path: tool.path as string, sha256: tool.sha256 };
  }
  const state = object(root.state, ['expectedNft', 'ruleIds', 'routeIds', 'mode', 'prepared', 'capture']);
  if (typeof state.expectedNft !== 'string' || Buffer.byteLength(state.expectedNft) > 1_048_576) fail();
  const nft = object(parse(state.expectedNft), ['nftables']);
  list(nft.nftables, 20_000); // Full AST semantics and ownership remain the native verifier's responsibility.
  const ruleIds = list(state.ruleIds, 3), routeIds = list(state.routeIds, 8);
  const allowedRules = plan.rules.map(rule => rule.priority);
  const allowedRoutes = [...plan.blackholes.map(route => 'blackhole:' + route.role),
    ...plan.egressRoutes.map((_, index) => 'egress:' + index), 'capture'];
  if (ruleIds.some(id => typeof id !== 'number' || !allowedRules.includes(id)) || new Set(ruleIds).size !== ruleIds.length ||
    routeIds.some(id => typeof id !== 'string' || !allowedRoutes.includes(id)) || new Set(routeIds).size !== routeIds.length ||
    ![null, 'blocked', 'core-only', 'active'].includes(state.mode as string | null) || typeof state.prepared !== 'boolean' ||
    typeof state.capture !== 'boolean' || state.capture !== routeIds.includes('capture') ||
    (state.mode === 'active' && !state.capture)) fail();
  if (state.prepared && (ruleIds.length !== 3 || allowedRoutes.some(id => id !== 'capture' && !routeIds.includes(id)))) fail();
  let pending: NativeResourcePending | null = null;
  if (root.pending !== null) {
    const p = object(root.pending, ['token', 'commandSHA', 'operation']);
    if (!uuid(p.token) || !hash(p.commandSHA)) fail();
    // Inspect the discriminant without invoking supplied accessors.
    const descriptor = p.operation && typeof p.operation === 'object' && !types.isProxy(p.operation) ?
      Object.getOwnPropertyDescriptor(p.operation, 'kind') : undefined;
    if (!descriptor || !('value' in descriptor)) fail();
    let operation: NativeResourceOperation;
    if (descriptor.value === 'nft') {
      const op = object(p.operation, ['kind', 'mode', 'operation', 'reset']);
      if (!['blocked', 'core-only', 'active'].includes(op.mode as string) || !['create', 'replace'].includes(op.operation as string) ||
        typeof op.reset !== 'boolean' || (op.reset && (op.mode !== 'blocked' || op.operation !== 'replace'))) fail();
      operation = { kind: 'nft', mode: op.mode as NativeResourceMode, operation: op.operation as 'create' | 'replace', reset: op.reset };
    } else {
      const op = object(p.operation, ['kind', 'category', 'index']);
      const count = op.category === 'blackhole' ? plan.blackholes.length : op.category === 'rule' ? plan.rules.length :
        op.category === 'egress' ? plan.egressRoutes.length : ['capture-add', 'capture-remove'].includes(op.category as string) ? 1 : 0;
      if (op.kind !== 'ip' || !Number.isSafeInteger(op.index) || (op.index as number) < 0 || (op.index as number) >= count) fail();
      operation = { kind: 'ip', category: op.category as Extract<NativeResourceOperation, { kind: 'ip' }>['category'], index: op.index as number };
    }
    pending = { token: p.token, commandSHA: p.commandSHA, operation };
  }
  return freeze({ schemaVersion: 1, revision: root.revision as number, scope,
    context: { bootID: context.bootID, userNS: context.userNS, netNS: context.netNS,
      ip: tools.ip, nft: tools.nft, rendererSHA: context.rendererSHA, planSHA: plan.sha256 },
    state: { expectedNft: state.expectedNft, ruleIds: ruleIds as number[], routeIds: routeIds as string[],
      mode: state.mode as NativeResourceMode | null, prepared: state.prepared, capture: state.capture },
    pending, deployment: plan.deployment });
}

/** Private receipt storage only: native owns revision CAS, mutation and recovery. */
export class ResourceJournal {
  readonly root: string;
  readonly scope: NativeResourceScope;
  private readonly store: FileTransactionStore;
  private locked = false;
  constructor(root: string, scope: NativeResourceScope) {
    if (typeof root !== 'string' || !isAbsolute(root) || !['production', 'fixture'].includes(scope)) fail('NETWORK_RESOURCE_STORE_UNSAFE');
    this.root = resolve(root); this.scope = scope; this.store = new FileTransactionStore(this.root);
  }
  private async directory(allowMissing: boolean): Promise<boolean> {
    const paths: string[] = [];
    for (let path = this.root;; path = dirname(path)) { paths.unshift(path); if (dirname(path) === path) break; }
    let belowTemporary = false;
    for (const path of paths) {
      let stat;
      try { stat = await lstat(path); }
      catch (error) { if (allowMissing && errno(error) === 'ENOENT') return false; throw error; }
      if (!stat.isDirectory() || stat.isSymbolicLink()) fail('NETWORK_RESOURCE_STORE_UNSAFE');
      if (process.platform === 'win32') continue; // Deployment must provide a private parent ACL.
      const leaf = path === this.root, currentUid = process.geteuid!();
      if (leaf && (stat.mode & 0o777) !== 0o700) fail('NETWORK_RESOURCE_STORE_UNSAFE');
      if (this.scope === 'production') {
        if (currentUid !== 0 || stat.uid !== 0 || (stat.mode & (leaf ? 0o077 : 0o022)) !== 0) fail('NETWORK_RESOURCE_STORE_UNSAFE');
      } else if (path === '/tmp') {
        if (leaf || ![0, 65534].includes(stat.uid) || (stat.mode & 0o1000) === 0) fail('NETWORK_RESOURCE_STORE_UNSAFE');
        belowTemporary = true;
      } else if (belowTemporary || leaf || ![0, 65534].includes(stat.uid)) {
        if (stat.uid !== currentUid || (stat.mode & 0o077) !== 0) fail('NETWORK_RESOURCE_STORE_UNSAFE');
      } else if ((stat.mode & 0o022) !== 0) fail('NETWORK_RESOURCE_STORE_UNSAFE');
    }
    return true;
  }
  async read(): Promise<NativeResourceReceipt | null> {
    try {
      if (!await this.directory(true)) return null;
      const path = join(this.root, filename);
      let before;
      try { before = await lstat(path); } catch (error) { if (errno(error) === 'ENOENT') return null; throw error; }
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) fail('NETWORK_RESOURCE_STORE_UNSAFE');
      const raw = await privateRead(path, maximum);
      const after = await lstat(path);
      if (after.nlink !== 1 || after.ino !== before.ino || after.dev !== before.dev) fail('NETWORK_RESOURCE_STORE_UNSAFE');
      const receipt = validate(parse(raw), this.scope);
      if (receipt.revision === 0) fail();
      return receipt;
    } catch (error) { if (error instanceof ResourceJournalError) throw error; return fail(); }
  }
  async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (this.locked) fail('NETWORK_RESOURCE_BUSY');
    let outcome: { value: T } | { error: unknown } | undefined;
    try {
      await this.directory(true);
      await this.store.exclusive(async () => {
        await this.directory(false);
        this.locked = true;
        try { outcome = { value: await operation() }; } catch (error) { outcome = { error }; }
        finally { this.locked = false; }
      });
    } catch (error) {
      if (error instanceof ResourceJournalError) throw error;
      fail(error instanceof TransactionError && error.code === 'STORE_LOCKED' ? 'NETWORK_RESOURCE_BUSY' : 'NETWORK_RESOURCE_STORE_IO');
    }
    if (!outcome) fail('NETWORK_RESOURCE_STORE_IO');
    if ('error' in outcome) throw outcome.error;
    return outcome.value;
  }
  async write(receipt: NativeResourceReceipt): Promise<NativeResourceReceipt> {
    try {
      if (!this.locked) fail('NETWORK_RESOURCE_STORE_IO');
      await this.directory(false);
      const checked = validate(receipt, this.scope);
      if (checked.revision >= Number.MAX_SAFE_INTEGER - 1) fail();
      const next = validate({ ...checked, revision: checked.revision + 1 }, this.scope);
      // Refuse replacing an existing unsafe/hard-linked receipt as well as reading one.
      await this.read();
      const raw = JSON.stringify(next);
      if (Buffer.byteLength(raw) > maximum) fail();
      await atomicWrite(this.root, filename, raw);
      return next;
    } catch { return fail('NETWORK_RESOURCE_STORE_IO'); }
  }
}
