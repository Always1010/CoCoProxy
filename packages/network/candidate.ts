import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { types } from 'node:util';
import { canonicalJson, deploymentDnsOptions, type Candidate, type JsonObject, type JsonValue } from '../config/index.ts';
import { parseRuntimeSettings } from '../runtime/settings.ts';
import type { RuntimeSettings } from '../runtime/types.ts';
import { inspectPrivateDirectory, privateRead } from '../storage/private-files.ts';
import { FileTransactionStore } from '../transaction/index.ts';
import { compileGatewayPreview, GATEWAY_CORE_SHA256 } from './config.ts';
import { renderNetworkPlan, type NetworkPlanInput } from './plan.ts';

/** Never expose candidate contents, deployment values, paths, or nested causes. */
export class GatewayCandidateError extends Error {
  readonly code = 'GATEWAY_CANDIDATE_UNTRUSTED';
  constructor() { super('GATEWAY_CANDIDATE_UNTRUSTED'); this.name = 'GatewayCandidateError'; }
}
const fail: () => never = () => { throw new GatewayCandidateError(); };
const digest = /^[a-f0-9]{64}$/;

/** Snapshot data before reading fields; do not execute supplied accessors or proxies. */
function snapshot(input: unknown): JsonValue {
  let remaining = 100_010, bytes = 0;
  const ancestors = new Set<object>();
  function copy(value: unknown, depth: number): JsonValue {
    if (--remaining < 0 || depth > 50) fail();
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'string') { bytes += Buffer.byteLength(value); if (bytes > 4 * 1024 * 1024) fail(); return value; }
    if (typeof value === 'number') { if (!Number.isFinite(value)) fail(); return value; }
    if (!value || typeof value !== 'object' || types.isProxy(value) || ancestors.has(value)) fail();
    const array = Array.isArray(value), prototype = Object.getPrototypeOf(value);
    if (!array && prototype !== Object.prototype && prototype !== null) fail();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(descriptors).some(key => typeof key !== 'string')) fail();
    ancestors.add(value);
    let result: JsonValue;
    if (array) {
      if (value.length > remaining || Object.keys(descriptors).some(key => key !== 'length' &&
        (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length))) fail();
      const entries: JsonValue[] = [];
      for (let index = 0; index < value.length; index++) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) fail();
        entries.push(copy(descriptor.value, depth + 1));
      }
      result = entries;
    } else {
      const record: JsonObject = Object.create(null);
      for (const [key, descriptor] of Object.entries(descriptors)) {
        bytes += Buffer.byteLength(key);
        if (bytes > 4 * 1024 * 1024 || ['__proto__', 'constructor', 'prototype'].includes(key) ||
          !descriptor.enumerable || !('value' in descriptor)) fail();
        record[key] = copy(descriptor.value, depth + 1);
      }
      result = record;
    }
    ancestors.delete(value);
    return result;
  }
  return copy(input, 0);
}
function object(input: JsonValue | undefined): JsonObject {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail();
  return input;
}

/**
 * expected is deployment-owned input, never a preview/plan supplied by HTTP or
 * an executor. Rebuild the complete config and network plan from private bytes.
 */
export function validateGatewayCandidate(input: unknown, expected: NetworkPlanInput) {
  try {
    const expectedPlan = renderNetworkPlan(expected);
    if (expectedPlan.deployment.core.binarySha256 !== GATEWAY_CORE_SHA256) fail();
    const envelope = object(snapshot(input));
    if (Object.keys(envelope).sort().join(',') !== 'config,id,sha256' ||
      typeof envelope.id !== 'string' || !digest.test(envelope.id) || envelope.sha256 !== envelope.id ||
      expectedPlan.deployment.generation !== envelope.id) fail();
    const config = object(envelope.config), bytes = canonicalJson(config);
    if (createHash('sha256').update(bytes).digest('hex') !== envelope.id) fail();
    const metadata = object(config['x-coproxy-network']);
    const controller = config['external-controller'];
    const dns = object(config.dns);
    if (typeof controller !== 'string' || !/^127\.0\.0\.1:([1-9]\d{0,4})$/.test(controller) ||
      typeof config.secret !== 'string') fail();
    const policy = { ...config };
    for (const key of ['allow-lan', 'bind-address', 'mixed-port', 'external-controller', 'secret',
      'tun', 'ipv6', 'dns', 'interface-name', 'routing-mark', 'x-coproxy-network']) delete policy[key];
    const preview = compileGatewayPreview({ schemaVersion: 1, network: metadata,
      base: { schemaVersion: 1, deployment: { mixedPort: config['mixed-port'],
        controllerPort: Number(controller.slice(10)), controllerSecret: config.secret,
        dnsPort: metadata.dnsPort, bootstrapResolvers: dns['default-nameserver'], ...deploymentDnsOptions(config) }, policy } });
    // A self-consistent content hash is insufficient: all compiler-owned bytes
    // and every deployment/derived plan field must match the trusted expectation.
    if (preview.candidate.id !== envelope.id || preview.candidate.sha256 !== envelope.sha256 ||
      canonicalJson(preview.candidate.config) !== bytes ||
      canonicalJson(preview.networkPlan as unknown as JsonObject) !== canonicalJson(expectedPlan as unknown as JsonObject)) fail();
    return { candidate: preview.candidate, networkPlan: preview.networkPlan,
      controller: { port: Number(controller.slice(10)), secret: config.secret } };
  } catch { return fail(); }
}

/** Private, read-only gateway entry point. This does not activate a core or network. */
export async function loadGatewayCandidate(input: RuntimeSettings, generation: string, expected: NetworkPlanInput) {
  try {
    const settings = parseRuntimeSettings(input);
    // Runtime settings and expected topology are separately deployment-owned.
    const expectedPlan = renderNetworkPlan(expected);
    if (typeof generation !== 'string' || !digest.test(generation) || expectedPlan.deployment.generation !== generation ||
      settings.binarySha256 !== GATEWAY_CORE_SHA256 || expectedPlan.deployment.core.binarySha256 !== settings.binarySha256 ||
      expectedPlan.deployment.core.serviceUid !== settings.serviceUid || expectedPlan.deployment.core.unitSha256 !== settings.unitSha256) fail();
    await inspectPrivateDirectory(settings.stateDirectory);
    await inspectPrivateDirectory(posix.join(settings.stateDirectory, 'candidates'));
    const path = await new FileTransactionStore(settings.stateDirectory).readCandidate(generation);
    const bytes = await privateRead(path);
    // Authenticate this read independently of the store's earlier read.
    if (createHash('sha256').update(bytes).digest('hex') !== generation) fail();
    const config = JSON.parse(bytes) as JsonObject;
    if (canonicalJson(config) !== bytes) fail();
    const validated = validateGatewayCandidate({ id: generation, sha256: generation, config }, expectedPlan.deployment);
    return { ...validated, path };
  } catch { return fail(); }
}
