import { createHash } from 'node:crypto';
import { types } from 'node:util';

export const NETWORK_TUN_ADDRESS = '198.18.0.1/30';

/** Deliberately contains no supplied value, property path, or nested cause. */
export class NetworkPlanError extends Error {
  readonly code = 'NETWORK_PLAN_INVALID';
  constructor() { super('NETWORK_PLAN_INVALID'); this.name = 'NetworkPlanError'; }
}

export interface NetworkPlanInput {
  schemaVersion: 1;
  generation: string;
  core: { serviceUid: number; binarySha256: string; unitSha256: string };
  ingressInterface: string;
  gatewayIPv4: string;
  prefixLength: number;
  routerIPv4: string;
  routerMAC: string;
  clientIPv4: string;
  dnsPort: number;
  tun: { interface: 'coproxy-tun'; mtu: number };
  marks: { mask: number; capture: number; egress: number; return: number };
  tables: { capture: number; egress: number; return: number };
  priorities: { capture: number; egress: number; return: number };
}

type Data = null | boolean | number | string | DataObject;
type DataObject = { [key: string]: Data };
const fail: () => never = () => { throw new NetworkPlanError(); };
const roles = ['capture', 'egress', 'return'] as const;

/** Inspect descriptors only, rejecting proxies before any reflective operation. */
function snapshot(input: unknown): Data {
  let remaining = 128;
  let bytes = 0;
  const ancestors = new Set<object>();
  function charge(text: string): void {
    bytes += Buffer.byteLength(text, 'utf8');
    if (bytes > 16_384) fail();
  }
  function copy(value: unknown, depth: number): Data {
    if (--remaining < 0 || depth > 8) fail();
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number') {
      if (!Number.isFinite(value) || Object.is(value, -0)) fail();
      return value;
    }
    if (typeof value === 'string') { charge(value); return value; }
    if (!value || typeof value !== 'object' || types.isProxy(value) ||
      Array.isArray(value) || ancestors.has(value)) fail();
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) fail();
    const keys = Reflect.ownKeys(value);
    if (keys.length > 32) fail();
    ancestors.add(value);
    const result: DataObject = Object.create(null);
    for (const key of keys) {
      if (typeof key !== 'string' || ['__proto__', 'constructor', 'prototype'].includes(key)) fail();
      charge(key);
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (!descriptor.enumerable || !('value' in descriptor)) fail();
      result[key] = copy(descriptor.value, depth + 1);
    }
    ancestors.delete(value);
    return result;
  }
  return copy(input, 0);
}

function record(value: Data | undefined, keys: readonly string[]): DataObject {
  if (!value || typeof value !== 'object' || Object.keys(value).length !== keys.length ||
    keys.some(key => !Object.hasOwn(value, key))) fail();
  return value;
}
function integer(value: Data | undefined, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) fail();
  return value;
}
function digest(value: Data | undefined): string {
  if (typeof value !== 'string' || value.length !== 64 || !/^[a-f0-9]{64}$/.test(value)) fail();
  return value;
}
function interfaceName(value: Data | undefined): string {
  if (typeof value !== 'string' || /[\r\n]/.test(value) || !/^[a-zA-Z][a-zA-Z0-9_-]{0,14}$/.test(value) ||
    ['lo', 'all', 'default'].includes(value)) fail();
  return value;
}
function ipv4(value: Data | undefined): { text: string; number: number } {
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,2})(\.(0|[1-9]\d{0,2})){3}$/.test(value)) fail();
  const octets = value.split('.').map(Number);
  if (octets.join('.') !== value || octets.some(octet => octet > 255) || octets[0] === 0 || octets[0] === 127 ||
    octets[0] >= 224 || (octets[0] === 169 && octets[1] === 254)) fail();
  return { text: value, number: octets.reduce((number, octet) => number * 256 + octet, 0) };
}

function validate(input: unknown): NetworkPlanInput {
  const root = record(snapshot(input), ['schemaVersion', 'generation', 'core', 'ingressInterface',
    'gatewayIPv4', 'prefixLength', 'routerIPv4', 'routerMAC', 'clientIPv4', 'dnsPort', 'tun', 'marks', 'tables', 'priorities']);
  if (root.schemaVersion !== 1) fail();
  const core = record(root.core, ['serviceUid', 'binarySha256', 'unitSha256']);
  const tun = record(root.tun, ['interface', 'mtu']);
  const marks = record(root.marks, ['mask', ...roles]);
  const tables = record(root.tables, roles);
  const priorities = record(root.priorities, roles);
  const ingressInterface = interfaceName(root.ingressInterface);
  if (interfaceName(tun.interface) !== 'coproxy-tun' || ingressInterface === tun.interface) fail();
  const gateway = ipv4(root.gatewayIPv4);
  const router = ipv4(root.routerIPv4);
  const client = ipv4(root.clientIPv4);
  const prefixLength = integer(root.prefixLength, 8, 29);
  const subnetSize = 2 ** (32 - prefixLength);
  const subnet = Math.floor(gateway.number / subnetSize);
  // v1 is deliberately restricted to one shared IPv4 subnet, including its
  // same-interface return path. /30 and longer cannot fit three distinct hosts.
  if (new Set([gateway.number, router.number, client.number]).size !== 3 ||
    [gateway, router, client].some(address => Math.floor(address.number / subnetSize) !== subnet ||
      address.number % subnetSize === 0 || address.number % subnetSize === subnetSize - 1)) fail();
  if (typeof root.routerMAC !== 'string' || root.routerMAC.length !== 17 || !/^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/.test(root.routerMAC) ||
    (parseInt(root.routerMAC.slice(0, 2), 16) & 1) !== 0 || root.routerMAC === '00:00:00:00:00:00') fail();
  const mask = integer(marks.mask, 1, 0xffff_ffff);
  const markValues = roles.map(role => integer(marks[role], 1, 0xffff_ffff));
  if (new Set(markValues).size !== 3 || markValues.some(value => ((value & mask) >>> 0) !== value)) fail();
  const tableValues = roles.map(role => integer(tables[role], 10_000, 19_999));
  const priorityValues = roles.map(role => integer(priorities[role], 10_000, 19_999));
  if (new Set(tableValues).size !== 3 || new Set(priorityValues).size !== 3 ||
    !(priorityValues[2] < priorityValues[1] && priorityValues[1] < priorityValues[0])) fail();
  return {
    schemaVersion: 1, generation: digest(root.generation),
    core: { serviceUid: integer(core.serviceUid, 1, 4_294_967_294),
      binarySha256: digest(core.binarySha256), unitSha256: digest(core.unitSha256) },
    ingressInterface, gatewayIPv4: gateway.text, prefixLength, routerIPv4: router.text,
    routerMAC: root.routerMAC, clientIPv4: client.text, dnsPort: integer(root.dnsPort, 1024, 65535),
    tun: { interface: 'coproxy-tun', mtu: integer(tun.mtu, 1280, 9000) },
    marks: { mask, capture: markValues[0], egress: markValues[1], return: markValues[2] },
    tables: { capture: tableValues[0], egress: tableValues[1], return: tableValues[2] },
    priorities: { capture: priorityValues[0], egress: priorityValues[1], return: priorityValues[2] },
  };
}

function buildPlan(input: unknown) {
  const deployment = validate(input);
  const { generation, core, ingressInterface, gatewayIPv4, routerIPv4, routerMAC, clientIPv4,
    dnsPort, tun, marks, tables, priorities } = deployment;
  const clientCIDR = clientIPv4 + '/32';
  const routerCIDR = routerIPv4 + '/32';
  const gatewayCIDR = gatewayIPv4 + '/32';
  const ownership = {
    owner: 'coproxy-network-v1',
    nftables: { family: 'inet', guardTable: 'coproxy_guard', dataTable: 'coproxy_data',
      guardChains: ['input_guard', 'forward_guard', 'output_guard'], dataChains: ['classify_ingress', 'classify_output', 'classify_return'] },
    tunInterface: tun.interface,
    tunIPv4Address: NETWORK_TUN_ADDRESS,
    routeProtocol: 186,
    tables,
    priorities,
    reservation: 'exclusive-preflight-required',
  } as const;
  const markActions = roles.map(role => ({ role, value: marks[role], mask: marks.mask,
    preserveMask: (~marks.mask) >>> 0, operation: 'replace-reserved-bits' as const,
    conntrack: 'same-mask-only' as const }));
  const coreSocketBinding = {
    mechanism: 'nft-socket-cgroup-v2-or-proven-equivalent-per-socket',
    cgroupVersion: 2, unit: 'coproxy-mihomo.service',
    controlGroup: '/system.slice/coproxy-mihomo.service',
    kernelIdentity: 'resolve-and-bind-current-cgroup-v2-kernel-id',
    membership: 'bound-core-process-only-no-foreign-processes-or-delegation',
    permission: 'root-controlled-no-shared-uid-cgroup-migration',
    verifyAt: 'socket-origin-before-first-packet-and-every-generation',
    uidOnlyFallback: false,
    sameUidManagementUnit: 'coproxy-management.service',
    sameUidManagementUpstreamException: false,
    equivalentMechanismRequires: 'prove-every-exempt-socket-originates-from-this-exact-bound-cgroup',
    onUnsupportedOrUnprovable: 'remain-blocked',
  } as const;
  const binding = { generation, core, coreSocketBinding, planDigestRequired: true, exclusiveWriterRequired: true,
    evidenceMaxAgeMs: 30_000, bindEvidenceTo: ['generation', 'planSha256', 'bootId', 'corePid', 'corePidStartTime',
      'coreUnitControlGroup', 'coreCgroupKernelId'] } as const;
  const dns = {
    destination: { ipv4: gatewayIPv4, port: dnsPort }, protocols: ['udp', 'tcp'],
    interface: ingressInterface, ethernetSource: routerMAC,
    allowedSources: [clientCIDR, routerCIDR],
    otherSourcesToThisListener: 'drop', otherDestinations: 'not-a-dns-exception',
    requireSameCorePid: true, wildcardBind: 'forbidden',
    replies: { sourceIPv4: gatewayIPv4, sourcePort: dnsPort, destinations: [clientCIDR, routerCIDR],
      markRole: 'egress', nextHop: routerIPv4, clientNeighbourResolution: 'forbidden' },
    bootstrap: 'independent-of-router-forwarded-dns', resolverMode: 'real-ip',
  } as const;
  const guard = {
    resource: 'coproxy_guard', persistentAcrossCoreFailure: true,
    managedIPv4: { interface: ingressInterface, source: clientCIDR, ethernetSource: routerMAC },
    sourceMismatch: 'drop-client-source-on-wrong-interface-or-mac',
    forwardedClient: 'drop-unless-current-generation-capture-to-tun',
    forwardedReturn: 'drop-unless-current-generation-tun-to-client-via-router',
    rawIngressToPhysicalEgress: 'always-drop',
    dns: { ...dns, exposure: 'blocked-until-current-generation-activation' },
    coreOutput: { identity: 'bound-core-pid-start-time-uid-binary-generation-and-exact-cgroup-v2-socket-origin',
      socketBinding: coreSocketBinding,
      newUpstreamSockets: 'drop-unless-egress-mark-and-owned-egress-path',
      loopbackControl: 'outside-upstream-scope', unboundCoreIdentity: 'remain-blocked' },
    gatewayLocalManagement: 'outside-forward-capture-scope',
    ipv6: { scope: 'only-packets-delivered-to-gateway', interface: ingressInterface,
      ethernetSource: routerMAC, routedTraffic: 'drop', linkLocalControl: 'outside-forward-capture-scope',
      routerMustBlockClientPublicIPv6: 'external-precondition' },
  } as const;
  const blackholes = roles.map(role => ({ role, table: tables[role], destination: '0.0.0.0/0',
    type: 'blackhole' as const, metric: 32_760, protocol: ownership.routeProtocol, persistentOnFailure: true }));
  const rules = roles.map(role => ({ role, family: 'ipv4' as const, priority: priorities[role],
    mark: marks[role], mask: marks.mask, table: tables[role],
    ...(role === 'return' ? { incomingInterface: tun.interface, destination: clientCIDR } : {}),
    fallthrough: 'forbidden-by-default-blackhole' as const }));
  const egressRoutes = [
    { role: 'egress', table: tables.egress, destination: routerCIDR, type: 'unicast', scope: 'link',
      interface: ingressInterface, preferredSource: gatewayIPv4, protocol: ownership.routeProtocol, metric: 10 },
    { role: 'egress', table: tables.egress, destination: '0.0.0.0/0', type: 'unicast',
      via: routerIPv4, interface: ingressInterface, preferredSource: gatewayIPv4, protocol: ownership.routeProtocol, metric: 10 },
    { role: 'return', table: tables.return, destination: routerCIDR, type: 'unicast', scope: 'link',
      interface: ingressInterface, preferredSource: gatewayIPv4, protocol: ownership.routeProtocol, metric: 10 },
    { role: 'return', table: tables.return, destination: clientCIDR, type: 'unicast',
      via: routerIPv4, interface: ingressInterface, protocol: ownership.routeProtocol, metric: 10 },
  ];
  const captureRoute = { role: 'capture', table: tables.capture, destination: '0.0.0.0/0', type: 'unicast',
    interface: tun.interface, protocol: ownership.routeProtocol, metric: 10 };
  const preflight = {
    mutationsAllowed: false,
    requirements: [
      'linux-ipv4-policy-routing-nftables-tun-capabilities',
      'operator-reviewed-deployment-and-separate-target-authorization',
      'exclusive-network-lock-and-current-generation-cas',
      'owned-resources-absent-or-exactly-matching-owned-plan-no-foreign-collisions',
      'all-rule-priorities-tables-protocol-and-mark-bits-exclusively-reserved',
      'existing-rpdb-nft-hooks-conntrack-and-marks-cannot-bypass-owned-guard',
      'ingress-link-address-prefix-and-router-neighbour-mac-match',
      'router-delivers-original-client-source-and-excludes-gateway-origin',
      'router-selected-client-dns-and-ipv6-blocking-externally-confirmed',
      'ipv4-forwarding-rp-filter-redirects-and-same-interface-forwarding-compatible',
      'dns-port-no-conflicting-listener-and-independent-bootstrap',
      'core-config-matches-this-plan-real-ip-dns-tun-auto-route-auto-redirect-disabled',
      'core-outbound-sockets-use-egress-mark-before-first-packet-and-only-bound-core-identity',
      'fixed-core-systemd-controlgroup-v2-path-kernel-id-and-process-membership-match-boot-pid-start-time',
      'nft-socket-cgroup-v2-or-equivalent-per-socket-origin-enforcement-proven-no-uid-only-fallback',
      'core-cgroup-root-controlled-not-delegated-no-shared-uid-migration-or-foreign-members',
      'same-uid-management-unit-and-sockets-excluded-from-core-upstream-exception',
      'core-generation-candidate-binary-unit-uid-match-with-no-extra-watchdog',
      'tun-name-available-or-exclusively-owned-and-persistent-guard-restored-before-core-restart',
      'fixed-tun-ipv4-prefix-does-not-overlap-any-existing-link-route-or-policy-path',
    ],
    onFailure: 'leave-previous-state-unchanged-no-first-activation',
  } as const;
  const evidence = {
    binding,
    required: [
      'core-process-live-and-pid-start-time-uid-binary-unit-generation-confirmed',
      'exact-core-unit-controlgroup-v2-path-and-kernel-id-match-bound-boot-pid-start-time',
      'per-socket-core-cgroup-origin-enforcement-read-back-and-same-uid-management-exclusion-proven',
      'same-core-pid-owns-exact-gateway-ipv4-dns-tcp-and-udp-listener',
      'same-core-pid-owns-up-tun-interface-with-exact-name-ipv4-address-and-mtu',
      'core-egress-mark-applied-before-first-packet-and-guard-mark-classification-confirmed',
      'owned-guard-blackholes-rules-egress-and-return-routes-read-back-match',
      'router-neighbour-link-and-generation-still-current',
    ],
    requireAll: true,
    onMissingStaleOrMismatch: 'remain-blocked',
  } as const;
  const classification = {
    ingress: { interface: ingressInterface, ethernetSource: routerMAC, source: clientCIDR,
      family: 'ipv4', traffic: ['tcp', 'udp'], excludeDestinations: [gatewayCIDR, routerCIDR],
      markRole: 'capture', incomingReservedMark: 'clear-and-reclassify' },
    egress: { identity: 'bound-core-pid-start-time-uid-binary-generation-and-exact-cgroup-v2-socket-origin',
      socketBinding: coreSocketBinding, markRole: 'egress',
      arbitraryUidTraffic: 'not-authorized', captureExemption: 'only-verified-core-egress' },
    dnsReplies: { sourceIPv4: gatewayIPv4, sourcePort: dnsPort, destinations: [clientCIDR, routerCIDR],
      protocols: ['tcp', 'udp'], identity: 'bound-core-pid-start-time-uid-binary-generation-and-exact-cgroup-v2-socket-origin',
      socketBinding: coreSocketBinding, markRole: 'egress' },
    return: { interface: tun.interface, destination: clientCIDR, markRole: 'return', nextHop: routerIPv4,
      clientNeighbourResolution: 'forbidden' },
    preserveUnreservedMarkBits: true, snat: false,
  } as const;
  const phases = [
    { id: 'persist-guard', after: ['preflight'], operations: [{ kind: 'persist-and-install-guard', guard }],
      completion: 'durable-intent-and-kernel-guard-read-back-match-before-any-other-mutation' },
    { id: 'prepare-blocked', after: ['persist-guard'], operations: [
      { kind: 'ensure-blackhole-defaults', routes: blackholes },
      { kind: 'ensure-policy-rules', rules },
      { kind: 'prepare-egress-and-return-routes', routes: egressRoutes },
      { kind: 'stage-inactive-classification', classification, markActions },
    ], completion: 'capture-table-still-blackhole-and-forward-guard-still-blocked' },
    { id: 'await-core-evidence', after: ['prepare-blocked'], operations: [{ kind: 'require-fresh-bound-evidence', evidence }],
      completion: 'every-required-evidence-item-matches-current-generation-and-plan' },
    { id: 'activate-capture', after: ['await-core-evidence'], operations: [
      { kind: 'recheck-evidence-under-exclusive-lock', evidence },
      { kind: 'install-capture-route', route: captureRoute },
      { kind: 'activate-owned-classification-and-guard-exceptions', classification, dns },
      { kind: 'read-back-owned-resources-and-recheck-evidence', evidence },
    ], completion: 'all-owned-resources-confirmed-or-enter-fault-blocked' },
    { id: 'ready', after: ['activate-capture'], operations: [{ kind: 'report-local-readiness', terminalPath: 'unverified' }],
      completion: 'local-evidence-only-router-and-terminal-acceptance-still-required' },
  ] as const;
  const faultPolicy = {
    triggers: ['core-exit', 'dns-failure', 'tun-loss', 'link-or-neighbour-loss', 'stale-evidence',
      'generation-change', 'partial-apply', 'process-restart', 'resource-mismatch'],
    state: 'fault-blocked', enabledIntent: 'preserved', guard: 'retain-and-reassert-first',
    blackholeDefaults: 'retain-all-three', captureRoute: 'withdraw-or-remain-guarded',
    classificationExceptions: 'disable', directFallback: false, flushForeignResources: false,
    recovery: 'fresh-preflight-and-bound-evidence-before-explicit-reactivation',
    manualDisable: 'separate-authorized-lifecycle-not-generated-by-this-plan',
  } as const;
  const body = {
    schemaVersion: 1, kind: 'coproxy-network-plan', sensitive: true,
    deployment, binding, ownership, markActions, dns, guard, blackholes, rules,
    egressRoutes, captureRoute, preflight, evidence, phases, faultPolicy,
    status: { executable: false, applied: false, core: 'unverified', dns: 'unverified',
      capture: 'unverified', terminalPath: 'unverified', router: 'external-precondition' },
    scope: { clients: 1, ipv4: ['tcp', 'udp'], dns: 'real-ip-tcp-udp',
      ipv6: 'gateway-delivery-block-only', snat: false, directClientARP: false },
    forbiddenMutations: ['sysctl', 'host-addresses', 'host-main-routes', 'host-default-routes',
      'router-configuration', 'foreign-firewall-resources', 'foreign-routing-resources', 'software-installation'],
  } as const;
  return { ...body, sha256: createHash('sha256').update(JSON.stringify(body), 'utf8').digest('hex') };
}

export type NetworkPlan = ReturnType<typeof buildPlan>;

/** Pure review proposal. Does not read host state, execute commands, or grant authority. */
export function renderNetworkPlan(input: unknown): NetworkPlan {
  try { return buildPlan(input); }
  catch { return fail(); }
}
