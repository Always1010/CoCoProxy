import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { NetworkPlanError, renderNetworkPlan } from '../packages/network/plan.ts';
import type { NetworkPlanInput } from '../packages/network/plan.ts';

function input(): NetworkPlanInput {
  return {
    schemaVersion: 1, generation: 'a'.repeat(64),
    core: { serviceUid: 12345, binarySha256: 'b'.repeat(64), unitSha256: 'c'.repeat(64) },
    ingressInterface: 'lan-test', gatewayIPv4: '192.0.2.2', prefixLength: 24,
    routerIPv4: '192.0.2.1', routerMAC: '02:00:00:00:00:01', clientIPv4: '192.0.2.3', dnsPort: 15353,
    tun: { interface: 'coproxy-tun', mtu: 1500 },
    marks: { mask: 0xff00, capture: 0x100, egress: 0x200, return: 0x300 },
    tables: { capture: 10003, egress: 10002, return: 10001 },
    priorities: { capture: 10003, egress: 10002, return: 10001 },
  };
}

function invalid(value: unknown): void {
  assert.throws(() => renderNetworkPlan(value), (error: unknown) => {
    assert.ok(error instanceof NetworkPlanError);
    assert.equal(error.name, 'NetworkPlanError');
    assert.equal(error.code, 'NETWORK_PLAN_INVALID');
    assert.equal(error.message, 'NETWORK_PLAN_INVALID');
    assert.equal(Object.hasOwn(error, 'cause'), false);
    return true;
  });
}

test('network proposal is deterministic, detached, generation-bound and still unverified', () => {
  const original = input();
  const plan = renderNetworkPlan(original);
  const reverse = (value: unknown): unknown => value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).reverse().map(([key, child]) => [key, reverse(child)])) : value;
  assert.deepEqual(renderNetworkPlan(reverse(original)), plan);
  const { sha256, ...body } = plan;
  assert.equal(sha256, createHash('sha256').update(JSON.stringify(body), 'utf8').digest('hex'));
  assert.match(sha256, /^[a-f0-9]{64}$/);
  assert.notEqual(renderNetworkPlan({ ...original, generation: 'd'.repeat(64) }).sha256, sha256);
  assert.notEqual(renderNetworkPlan({ ...original, dnsPort: 15354 }).sha256, sha256);
  original.core.serviceUid++;
  original.marks.capture = 0x400;
  assert.equal(plan.deployment.core.serviceUid, 12345);
  assert.equal(plan.deployment.marks.capture, 0x100);
  assert.equal(plan.status.applied, false);
  assert.equal(plan.status.executable, false);
  assert.equal(plan.status.terminalPath, 'unverified');
  assert.equal(plan.sensitive, true);
  assert.equal(plan.binding.evidenceMaxAgeMs, 30_000);
  assert.ok(plan.binding.bindEvidenceTo.includes('corePidStartTime'));
  assert.ok(plan.binding.bindEvidenceTo.includes('coreUnitControlGroup'));
  assert.ok(plan.binding.bindEvidenceTo.includes('coreCgroupKernelId'));
});

test('fail-closed route domains cannot fall through or directly resolve the client neighbour', () => {
  const plan = renderNetworkPlan(input());
  assert.equal(new Set(plan.rules.map(rule => rule.table)).size, 3);
  assert.equal(new Set(plan.rules.map(rule => rule.priority)).size, 3);
  for (const rule of plan.rules) {
    const fallback = plan.blackholes.find(route => route.table === rule.table)!;
    assert.equal(fallback.type, 'blackhole');
    assert.equal(fallback.destination, '0.0.0.0/0');
    assert.equal(fallback.persistentOnFailure, true);
    assert.equal(rule.fallthrough, 'forbidden-by-default-blackhole');
  }
  const returnRoute = plan.egressRoutes.find(route => route.role === 'return' && route.destination === '192.0.2.3/32')!;
  assert.equal(returnRoute.via, '192.0.2.1');
  assert.equal(returnRoute.interface, 'lan-test');
  const returnRule = plan.rules.find(rule => rule.role === 'return')!;
  assert.equal(returnRule.incomingInterface, 'coproxy-tun');
  assert.equal(returnRule.destination, '192.0.2.3/32');
  const egress = plan.egressRoutes.find(route => route.role === 'egress' && route.destination === '0.0.0.0/0')!;
  assert.equal(egress.via, '192.0.2.1');
  assert.equal(plan.captureRoute.interface, 'coproxy-tun');
  assert.equal(plan.captureRoute.table, plan.deployment.tables.capture);
  assert.equal(plan.egressRoutes.some(route => route.table === plan.captureRoute.table), false);
  assert.ok([...plan.blackholes, ...plan.egressRoutes, plan.captureRoute].every(route => route.protocol === 186));
  assert.equal(plan.scope.snat, false);
  assert.equal(plan.scope.directClientARP, false);
  assert.equal(plan.guard.rawIngressToPhysicalEgress, 'always-drop');
  assert.equal(plan.guard.coreOutput.newUpstreamSockets, 'drop-unless-egress-mark-and-owned-egress-path');
  // Core and management can share a UID: that UID cannot identify socket origin.
  const socketBinding = plan.guard.coreOutput.socketBinding;
  assert.equal(socketBinding.cgroupVersion, 2);
  assert.equal(socketBinding.unit, 'coproxy-mihomo.service');
  assert.equal(socketBinding.controlGroup, '/system.slice/coproxy-mihomo.service');
  assert.equal(socketBinding.kernelIdentity, 'resolve-and-bind-current-cgroup-v2-kernel-id');
  assert.equal(socketBinding.uidOnlyFallback, false);
  assert.equal(socketBinding.sameUidManagementUnit, 'coproxy-management.service');
  assert.equal(socketBinding.sameUidManagementUpstreamException, false);
  assert.equal(socketBinding.onUnsupportedOrUnprovable, 'remain-blocked');
  assert.deepEqual(plan.binding.coreSocketBinding, socketBinding);
  const activation = plan.phases[3].operations[2];
  assert.deepEqual(activation.classification.egress.socketBinding, socketBinding);
  assert.deepEqual(activation.classification.dnsReplies.socketBinding, socketBinding);
  assert.ok(plan.preflight.requirements.some(requirement => requirement.includes('no-uid-only-fallback')));
  assert.ok(plan.evidence.required.some(requirement => requirement.includes('same-uid-management-exclusion-proven')));
});

test('durable guard precedes preparation, fresh core evidence precedes capture, failures retain blocking', () => {
  const plan = renderNetworkPlan(input());
  assert.deepEqual(plan.phases.map(phase => phase.id), [
    'persist-guard', 'prepare-blocked', 'await-core-evidence', 'activate-capture', 'ready',
  ]);
  assert.equal(plan.phases[0].operations[0].kind, 'persist-and-install-guard');
  assert.equal(plan.phases[1].operations[0].kind, 'ensure-blackhole-defaults');
  assert.equal(plan.phases[1].operations[1].kind, 'ensure-policy-rules');
  assert.equal(plan.phases[3].operations[0].kind, 'recheck-evidence-under-exclusive-lock');
  assert.equal(plan.phases[3].operations[1].kind, 'install-capture-route');
  assert.equal(plan.phases[4].operations[0].terminalPath, 'unverified');
  assert.equal(plan.guard.dns.exposure, 'blocked-until-current-generation-activation');
  assert.equal(plan.evidence.requireAll, true);
  assert.equal(plan.evidence.onMissingStaleOrMismatch, 'remain-blocked');
  assert.ok(plan.evidence.required.some(requirement => requirement.includes('same-core-pid-owns-exact')));
  assert.ok(plan.evidence.required.some(requirement => requirement.includes('same-core-pid-owns-up-tun')));
  assert.equal(plan.faultPolicy.directFallback, false);
  assert.equal(plan.faultPolicy.guard, 'retain-and-reassert-first');
  assert.equal(plan.faultPolicy.blackholeDefaults, 'retain-all-three');
  assert.equal(plan.faultPolicy.enabledIntent, 'preserved');
  assert.equal(plan.preflight.mutationsAllowed, false);
  assert.equal(plan.preflight.onFailure, 'leave-previous-state-unchanged-no-first-activation');
  for (const forbidden of ['sysctl', 'host-addresses', 'host-main-routes', 'router-configuration']) {
    assert.ok((plan.forbiddenMutations as readonly string[]).includes(forbidden));
  }
});

test('DNS and IPv6 describe exact gateway scope without claiming router enforcement', () => {
  const plan = renderNetworkPlan(input());
  assert.deepEqual(plan.dns.allowedSources, ['192.0.2.3/32', '192.0.2.1/32']);
  assert.deepEqual(plan.dns.destination, { ipv4: '192.0.2.2', port: 15353 });
  assert.deepEqual(plan.dns.protocols, ['udp', 'tcp']);
  assert.equal(plan.dns.ethernetSource, '02:00:00:00:00:01');
  assert.equal(plan.dns.interface, 'lan-test');
  assert.equal(plan.dns.wildcardBind, 'forbidden');
  assert.equal(plan.dns.otherSourcesToThisListener, 'drop');
  assert.equal(plan.dns.bootstrap, 'independent-of-router-forwarded-dns');
  assert.equal(plan.guard.ipv6.scope, 'only-packets-delivered-to-gateway');
  assert.equal(plan.guard.ipv6.routerMustBlockClientPublicIPv6, 'external-precondition');
  assert.equal(plan.status.router, 'external-precondition');
});

test('mark replacement preserves every unreserved bit, including unsigned high bits', () => {
  for (const marks of [input().marks, { mask: 0xc0000000, capture: 0x40000000, egress: 0x80000000, return: 0xc0000000 }]) {
    const plan = renderNetworkPlan({ ...input(), marks });
    for (const action of plan.markActions) {
      for (const packetMark of [0, 1, 0xffff_ffff, 0xaaaaaaaa, 0x55555555]) {
        const updated = ((packetMark & action.preserveMask) | action.value) >>> 0;
        assert.equal((updated & action.preserveMask) >>> 0, (packetMark & action.preserveMask) >>> 0);
        assert.equal((updated & action.mask) >>> 0, action.value);
      }
    }
  }
});

test('deployment constraints reject ambiguous addresses, interfaces, marks and routing collisions', () => {
  for (const field of ['gatewayIPv4', 'routerIPv4', 'clientIPv4']) {
    for (const address of ['192.0.2.0', '192.0.2.255', '192.0.3.1', '192.000.2.4', '127.0.0.1',
      '0.0.0.1', '169.254.1.1', '224.0.0.1', '255.255.255.255', '192.0.2.256', '::1', '192.0.2.4/32', '192.0.2.4\n']) {
      invalid({ ...input(), [field]: address });
    }
  }
  invalid({ ...input(), clientIPv4: input().routerIPv4 });
  invalid({ ...input(), gatewayIPv4: input().routerIPv4 });
  invalid({ ...input(), clientIPv4: input().gatewayIPv4 });
  for (const name of ['lo', 'all', 'default', '123', 'eth0.1', 'a'.repeat(16), 'eth0;id', 'eth0\n', 'coproxy-tun']) {
    invalid({ ...input(), ingressInterface: name });
  }
  invalid({ ...input(), tun: { interface: 'foreign-tun', mtu: 1500 } });
  for (const mac of ['00:00:00:00:00:00', 'ff:ff:ff:ff:ff:ff', '01:00:00:00:00:01',
    '02:00:00:00:00:0A', '02-00-00-00-00-01', '02:00:00:00:00:01\n']) invalid({ ...input(), routerMAC: mac });
  for (const marks of [
    { ...input().marks, capture: 0 }, { ...input().marks, capture: 0x200 },
    { ...input().marks, capture: 1 }, { ...input().marks, mask: 0 },
    { ...input().marks, mask: 1 }, { ...input().marks, egress: 0x1_0000_0000 },
    { ...input().marks, return: -1 }, { ...input().marks, capture: 1.5 },
  ]) invalid({ ...input(), marks });
  for (const field of ['tables', 'priorities'] as const) {
    invalid({ ...input(), [field]: { ...input()[field], capture: input()[field].egress } });
    for (const value of [9999, 20000, 32766, 254, -1, 10000.1]) {
      invalid({ ...input(), [field]: { ...input()[field], return: value } });
    }
  }
  invalid({ ...input(), priorities: { capture: 10001, egress: 10002, return: 10003 } });
});

test('numeric and digest bounds are strict; valid edge deployments remain expressible', () => {
  for (const [field, values] of Object.entries({ prefixLength: [7, 30, 32, 24.5], dnsPort: [0, 1023, 65536, 15353.5] })) {
    for (const value of values) invalid({ ...input(), [field]: value });
  }
  for (const mtu of [1279, 9001, 1500.5]) invalid({ ...input(), tun: { ...input().tun, mtu } });
  for (const serviceUid of [0, -1, 1.5, 4_294_967_295]) invalid({ ...input(), core: { ...input().core, serviceUid } });
  for (const value of ['A'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), 'x'.repeat(64), 'a'.repeat(64) + '\n']) {
    invalid({ ...input(), generation: value });
    invalid({ ...input(), core: { ...input().core, binarySha256: value } });
    invalid({ ...input(), core: { ...input().core, unitSha256: value } });
  }
  for (const dnsPort of [1024, 65535]) {
    for (const mtu of [1280, 9000]) assert.doesNotThrow(() => renderNetworkPlan({ ...input(), dnsPort, tun: { ...input().tun, mtu } }));
  }
  assert.doesNotThrow(() => renderNetworkPlan({ ...input(), prefixLength: 29 }));
  assert.doesNotThrow(() => renderNetworkPlan({ ...input(), prefixLength: 8 }));
});

test('untrusted data cannot execute traps, getters or serialization hooks and errors disclose no data', () => {
  let executed = false;
  const getter = input();
  Object.defineProperty(getter, 'generation', { enumerable: true, get() { executed = true; throw new Error('SECRET'); } });
  const proxy = new Proxy(input(), { getPrototypeOf() { executed = true; throw new Error('SECRET'); }, ownKeys() { executed = true; return []; } });
  const nestedProxy = new Proxy(input().core, { getPrototypeOf() { executed = true; throw new Error('SECRET'); } });
  const cyclic: Record<string, unknown> = { ...input() };
  cyclic.core = cyclic;
  const hidden = input();
  Object.defineProperty(hidden, 'hidden', { value: 'SECRET', enumerable: false });
  const symbol = { ...input(), [Symbol('SECRET')]: 1 };
  const custom = Object.assign(Object.create({ inherited: 'SECRET' }), input());
  const serialization = { ...input(), toJSON() { executed = true; throw new Error('SECRET'); } };
  const revoked = Proxy.revocable(input(), {}); revoked.revoke();
  const deep: Record<string, unknown> = {}; let cursor = deep;
  for (let index = 0; index < 12; index++) { cursor.next = {}; cursor = cursor.next as Record<string, unknown>; }
  const bad: unknown[] = [null, [], true, 1, 'SECRET', {}, getter, proxy, revoked.proxy,
    { ...input(), core: nestedProxy }, cyclic, hidden, symbol, custom, serialization,
    { ...input(), extra: 'SECRET' }, { ...input(), generation: 'SECRET'.repeat(4000) },
    { ...input(), core: deep }, { ...input(), core: { ...input().core, extra: 1 } },
    { ...input(), schemaVersion: 2 }, { ...input(), dnsPort: NaN }, { ...input(), dnsPort: Infinity },
    { ...input(), dnsPort: -0 }, { ...input(), dnsPort: 1n }, { ...input(), generation: undefined }];
  for (const value of bad) invalid(value);
  assert.equal(executed, false);
  const nullPrototype = Object.assign(Object.create(null), input());
  assert.doesNotThrow(() => renderNetworkPlan(nullPrototype));
});
