import { isAlias, isMap, isScalar, isSeq, parseDocument } from 'yaml';
import type { JsonObject, JsonValue } from '../config/index.ts';

export type SnapshotDecodeCode = 'SNAPSHOT_DECODE_FAILED' | 'SNAPSHOT_UNSUPPORTED' | 'SNAPSHOT_INVALID' | 'SNAPSHOT_LIMIT';

/** No parser diagnostics, property paths or upstream values cross this boundary. */
export class SnapshotDecodeError extends Error {
  readonly code: SnapshotDecodeCode;
  constructor(code: SnapshotDecodeCode) { super(code); this.name = 'SnapshotDecodeError'; this.code = code; }
}

const MAX_INPUT_BYTES = 1024 * 1024;
const MAX_JSON_BYTES = 4 * 1024 * 1024;
const MAX_DEPTH = 48;
const MAX_VALUES = 100_000;
const MAX_ALIASES = 50;
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const CORE_TAGS = new Set(['map', 'seq', 'str', 'null', 'bool', 'int', 'float'].map(tag => `tag:yaml.org,2002:${tag}`));
const fail: (code: SnapshotDecodeCode) => never = code => { throw new SnapshotDecodeError(code); };

/** Bound the syntax tree before conversion, including content we do not import. */
function checkTree(root: unknown): void {
  const pending = [{ node: root, depth: 0 }];
  let values = 0;
  let aliases = 0;
  while (pending.length) {
    const { node, depth } = pending.pop()!;
    if (++values > MAX_VALUES || depth > MAX_DEPTH) fail('SNAPSHOT_LIMIT');
    if (node === null) continue;
    if (isAlias(node)) {
      if (++aliases > MAX_ALIASES) fail('SNAPSHOT_LIMIT');
      continue;
    }
    if (!isMap(node) && !isSeq(node) && !isScalar(node)) fail('SNAPSHOT_INVALID');
    if (node.tag && !CORE_TAGS.has(node.tag)) fail('SNAPSHOT_UNSUPPORTED');
    if (isMap(node)) {
      for (const pair of node.items) {
        if (!isScalar(pair.key) || typeof pair.key.value !== 'string' || UNSAFE_KEYS.has(pair.key.value)) fail('SNAPSHOT_INVALID');
        pending.push({ node: pair.key, depth: depth + 1 }, { node: pair.value, depth: depth + 1 });
      }
    } else if (isSeq(node)) {
      for (const item of node.items) pending.push({ node: item, depth: depth + 1 });
    }
  }
}

/** Expand aliases into independent ordinary JSON values without calling hooks. */
function plainJson(input: unknown): JsonValue {
  let values = 0;
  let bytes = 0;
  const ancestors = new Set<object>();
  const charge = (amount: number) => {
    bytes += amount;
    if (bytes > MAX_JSON_BYTES) fail('SNAPSHOT_LIMIT');
  };
  const copy = (value: unknown, depth: number): JsonValue => {
    if (++values > MAX_VALUES || depth > MAX_DEPTH) fail('SNAPSHOT_LIMIT');
    if (value === null || typeof value === 'boolean') { charge(5); return value; }
    if (typeof value === 'string') { charge(Buffer.byteLength(value, 'utf8')); return value; }
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) fail('SNAPSHOT_INVALID');
      charge(24); return value;
    }
    if (!value || typeof value !== 'object' || ancestors.has(value)) fail('SNAPSHOT_INVALID');
    const array = Array.isArray(value);
    if (!array && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) fail('SNAPSHOT_INVALID');
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(descriptors).some(key => typeof key !== 'string')) fail('SNAPSHOT_INVALID');
    ancestors.add(value);
    let result: JsonValue;
    if (array) {
      if (value.length > MAX_VALUES || Object.keys(descriptors).some(key => key !== 'length' &&
          (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length))) fail('SNAPSHOT_INVALID');
      const items: JsonValue[] = [];
      for (let index = 0; index < value.length; index++) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) fail('SNAPSHOT_INVALID');
        items.push(copy(descriptor.value, depth + 1));
      }
      result = items;
    } else {
      const object: JsonObject = {};
      for (const [key, descriptor] of Object.entries(descriptors)) {
        if (UNSAFE_KEYS.has(key) || !descriptor.enumerable || !('value' in descriptor)) fail('SNAPSHOT_INVALID');
        charge(Buffer.byteLength(key, 'utf8'));
        object[key] = copy(descriptor.value, depth + 1);
      }
      result = object;
    }
    ancestors.delete(value);
    return result;
  };
  return copy(input, 0);
}

/**
 * Import only inline nodes from JSON or a single Clash YAML 1.2 document.
 * Upstream policy, deployment, scripts and remote providers are never imported.
 * Node field safety and names are subsequently validated by SubscriptionStore.
 */
export function decodeNodeSnapshot(text: string): unknown {
  try {
    if (typeof text !== 'string') fail('SNAPSHOT_DECODE_FAILED');
    if (Buffer.byteLength(text, 'utf8') > MAX_INPUT_BYTES) fail('SNAPSHOT_LIMIT');
    const document = parseDocument(text, {
      version: '1.2', schema: 'core', strict: true, uniqueKeys: true, stringKeys: true,
      customTags: [], resolveKnownTags: false, merge: false, prettyErrors: false,
      // `silent` also disables parseDocument's multiple-document error.
      logLevel: 'error',
    });
    if (document.errors.length || document.warnings.length) fail('SNAPSHOT_DECODE_FAILED');
    if (document.directives.yaml.version !== '1.2' || Object.entries(document.directives.tags).some(
      ([handle, prefix]) => handle !== '!!' || prefix !== 'tag:yaml.org,2002:',
    )) fail('SNAPSHOT_UNSUPPORTED');
    checkTree(document.contents);
    const value = plainJson(document.toJS({ mapAsMap: false, maxAliasCount: MAX_ALIASES }));
    if (value === null || typeof value !== 'object' || Array.isArray(value) || !Object.hasOwn(value, 'proxies')) fail('SNAPSHOT_UNSUPPORTED');
    if (!Array.isArray(value.proxies) || value.proxies.some(node => node === null || typeof node !== 'object' || Array.isArray(node))) fail('SNAPSHOT_INVALID');
    return { proxies: value.proxies };
  } catch (error) {
    if (error instanceof SnapshotDecodeError) throw error;
    throw new SnapshotDecodeError('SNAPSHOT_DECODE_FAILED');
  }
}
