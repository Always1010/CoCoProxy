import test from 'node:test';
import assert from 'node:assert/strict';
import { renderNetworkPlan, type NetworkPlanInput } from '../packages/network/plan.ts';
import { NetworkRulesError, renderNetworkRules, type NetworkRulesOptions } from '../packages/network/rules.ts';

function input(): NetworkPlanInput {
  return { schemaVersion: 1, generation: 'a'.repeat(64),
    core: { serviceUid: 12345, binarySha256: 'b'.repeat(64), unitSha256: 'c'.repeat(64) },
    ingressInterface: 'lan-test', gatewayIPv4: '192.0.2.2', prefixLength: 24,
    routerIPv4: '192.0.2.1', routerMAC: '02:00:00:00:00:01', clientIPv4: '192.0.2.3', dnsPort: 15353,
    tun: { interface: 'cocoproxy-tun', mtu: 1500 }, marks: { mask: 0xff00, capture: 0x100, egress: 0x200, return: 0x300 },
    tables: { capture: 10003, egress: 10002, return: 10001 }, priorities: { capture: 10003, egress: 10002, return: 10001 } };
}

test('source renderer binds fresh normalized input and owns only fixed tables and chains', () => {
  const source = input(), result = renderNetworkRules(source, { mode: 'active' });
  assert.equal(result.planSha256, renderNetworkPlan(source).sha256);
  assert.equal(result.generation, source.generation);
  assert.deepEqual(renderNetworkRules(structuredClone(source), { mode: 'active' }), result);
  source.dnsPort++;
  assert.notEqual(renderNetworkRules(source, { mode: 'active' }).planSha256, result.planSha256);
  assert.throws(() => renderNetworkRules(renderNetworkPlan(input()), { mode: 'active' }), NetworkRulesError);
  for (const [name, batch] of Object.entries(result.nft)) {
    assert.ok(batch.create.startsWith(`add table inet cocoproxy_${name}\n`));
    assert.doesNotMatch(batch.replace, /add table|delete|destroy|flush table|flush ruleset/);
    const lines = batch.replace.trim().split('\n');
    assert.equal(lines.filter(line => line.startsWith('flush chain')).length, 3);
    assert.ok(lines.every(line => line.startsWith(`flush chain inet cocoproxy_${name} `) || line.startsWith(`add rule inet cocoproxy_${name} `)));
  }
  assert.doesNotMatch(JSON.stringify(result), /\bsnat\b|\bmasquerade\b|meta mark set ct mark|established|related|flow add/);
  for (const mode of ['blocked', 'core-only', 'active'] as const) {
    const rendered = renderNetworkRules(input(), { mode });
    for (const batch of Object.values(rendered.nft)) {
      assert.ok(batch.replace.split('\n').filter(line => line.startsWith('add rule')).every(line => !/[{}]/.test(line)),
        'all emitted rules must avoid anonymous sets');
    }
  }
});

test('blocked guard grants only the explicit loopback DNS probe exception', () => {
  const result = renderNetworkRules(input(), { mode: 'blocked' });
  const allows = result.nft.guard.replace.split('\n').filter(line => line.endsWith('accept'));
  assert.equal(allows.length, 2);
  for (const protocol of ['tcp', 'udp']) assert.ok(allows.some(line => line.includes(
    `input_guard iifname "lo" ip saddr 127.0.0.1 ip daddr 192.0.2.2 meta l4proto ${protocol} th dport 15353 accept`)));
  assert.match(result.nft.guard.replace, /meta skuid 12345 drop/);
  assert.match(result.nft.guard.replace, /ip saddr 192\.0\.2\.3\/32 drop/);
  assert.match(result.nft.guard.replace, /iifname "cocoproxy-tun" drop/);
  assert.match(result.nft.guard.replace, /oifname "cocoproxy-tun" drop/);
  for (const protocol of ['tcp', 'udp']) assert.ok(result.nft.guard.replace.includes(`meta l4proto ${protocol} th dport 15353 drop`));
  assert.doesNotMatch(result.nft.data.replace, /\| 0x00000100|\| 0x00000300/);
});

test('core-only permits identity-bound core probes while client capture, forwarding and LAN DNS stay blocked', () => {
  const stage = renderNetworkRules(input(), { mode: 'core-only' });
  const active = renderNetworkRules(input(), { mode: 'active' });
  const outputAllows = (script: string) => script.split('\n').filter(line => line.includes('output_guard') && line.endsWith('accept'));
  assert.deepEqual(outputAllows(stage.nft.guard.replace), outputAllows(active.nft.guard.replace).filter(line => line.includes('socket cgroupv2')));
  assert.equal(outputAllows(stage.nft.guard.replace).length, 4);
  assert.ok(outputAllows(stage.nft.guard.replace).every(line => line.includes('socket cgroupv2')));
  const forward = stage.nft.guard.replace.split('\n').filter(line => line.includes('forward_guard'));
  assert.ok(forward.every(line => !line.endsWith('accept')));
  assert.ok(forward.some(line => line.endsWith('ip saddr 192.0.2.3/32 drop')));
  const dnsAllows = stage.nft.guard.replace.split('\n').filter(line => line.includes('input_guard') && line.endsWith('accept'));
  assert.equal(dnsAllows.length, 2);
  assert.ok(dnsAllows.every(line => line.includes('iifname "lo" ip saddr 127.0.0.1')));
  assert.doesNotMatch(stage.nft.data.replace, /\| 0x00000100|\| 0x00000300/);
  assert.doesNotMatch(stage.nft.guard.replace, /ct mark|ct direction/);
});

test('active forward path requires exact per-packet identity, protocol, mark and interface', () => {
  const rules = renderNetworkRules(input(), { mode: 'active' });
  const forward = rules.nft.guard.replace.split('\n').filter(line => line.includes('forward_guard') && line.endsWith('accept'));
  assert.equal(forward.length, 4);
  for (const protocol of ['tcp', 'udp']) {
    assert.ok(forward.some(line => line.includes(`iifname "lan-test" ether saddr 02:00:00:00:00:01 ip saddr 192.0.2.3/32 ip daddr != 192.0.2.2 ip daddr != 192.0.2.1 meta l4proto ${protocol} meta mark & 0x0000ff00 == 0x00000100 oifname "cocoproxy-tun"`)));
    assert.ok(forward.some(line => line.includes(`iifname "cocoproxy-tun" ip daddr 192.0.2.3/32 meta l4proto ${protocol} meta mark & 0x0000ff00 == 0x00000300 oifname "lan-test"`)));
  }
  assert.match(rules.nft.guard.replace, /meta nfproto ipv6 iifname "lan-test" ether saddr 02:00:00:00:00:01 drop/);
  const data = rules.nft.data.replace;
  const clearMarks = data.split('\n').filter(line => line.includes('meta mark set meta mark &'));
  assert.equal(clearMarks.length, 2);
  assert.ok(clearMarks.some(line => line.includes('iifname "lan-test" ip saddr 192.0.2.3/32 meta mark set meta mark & 0xffff00ff')));
  assert.ok(clearMarks.some(line => line.includes('iifname "cocoproxy-tun" ip daddr 192.0.2.3/32 meta mark set meta mark & 0xffff00ff')));
  assert.match(data, /meta mark set \(meta mark & 0xffff00ff\) \| 0x00000100/);
  assert.match(data, /meta mark set \(meta mark & 0xffff00ff\) \| 0x00000300/);
  const capture = data.split('\n').filter(line => line.includes('| 0x00000100'));
  assert.equal(capture.length, 2);
  assert.ok(capture.every(line => line.includes('ip daddr != 192.0.2.2 ip daddr != 192.0.2.1')));
});

test('socket cgroup origin is mandatory, shared uid management has a separate unmarked exception', () => {
  const result = renderNetworkRules(input(), { mode: 'active' });
  assert.equal(result.scope, 'production');
  const allow = result.nft.guard.replace.split('\n').filter(line => line.includes('output_guard') && line.endsWith('accept'));
  assert.equal(allow.length, 6);
  for (const protocol of ['tcp', 'udp']) assert.ok(allow.some(line => line.includes(`meta skuid 12345 socket cgroupv2 level 2 "system.slice/cocoproxy-mihomo.service" meta mark & 0x0000ff00 == 0x00000200 oifname "lan-test" ip saddr 192.0.2.2 meta l4proto ${protocol} accept`)));
  const management = allow.find(line => line.includes('"system.slice/cocoproxy-management.service"'))!;
  assert.ok(management.includes('meta skuid 12345 socket cgroupv2 level 2 "system.slice/cocoproxy-management.service"'));
  assert.ok(management.includes('meta mark & 0x0000ff00 == 0'));
  for (const protocol of ['tcp', 'udp']) assert.ok(allow.some(line => line.includes('"system.slice/cocoproxy-management.service"') && line.includes(`meta l4proto ${protocol} th sport != 15353 accept`)));
  assert.ok(!result.nft.data.replace.split('\n').some(line => line.startsWith('add rule inet cocoproxy_data classify_output ')),
    'local output must retain the originating socket mark without modifying unrelated traffic');
  assert.doesNotMatch(result.nft.data.replace, /\| 0x00000200/);
  const fixture = renderNetworkRules(input(), { mode: 'active', fixtureCgroups: { core: '/fixture/core', management: '/fixture/management' } });
  assert.equal(fixture.scope, 'fixture');
  assert.match(fixture.nft.guard.replace, /socket cgroupv2 level 2 "fixture\/core"/);
  assert.equal(fixture.planSha256, result.planSha256);
  const coreOnly = renderNetworkRules(input(), { mode: 'active', fixtureCgroups: { core: '/fixture/core', management: null } });
  assert.equal(coreOnly.scope, 'fixture');
  assert.equal(coreOnly.cgroups.management, null);
  assert.equal(coreOnly.nft.guard.replace.split('\n').filter(line => line.includes('output_guard') && line.endsWith('accept')).length, 4);
  assert.match(coreOnly.nft.guard.replace, /meta skuid 12345 drop/);
  assert.equal(renderNetworkRules(input(), { mode: 'active', fixtureCgroups: {
    core: '/system.slice/cocoproxy-mihomo.service', management: '/system.slice/cocoproxy-management.service',
  } }).scope, 'fixture');
});

test('dedicated management UID is cgroup-bound and falls closed outside its unmarked management exception', () => {
  const source = { ...input(), management: { serviceUid: 12346 } };
  for (const mode of ['blocked', 'core-only', 'active'] as const) {
    for (const fixtureCgroups of [undefined, { core: '/fixture/core', management: '/fixture/management' },
      { core: '/fixture/core', management: null }]) {
      const options = { mode, ...(fixtureCgroups ? { fixtureCgroups } : {}) };
      const rendered = renderNetworkRules(source, options);
      const legacy = renderNetworkRules(input(), options);
      assert.equal(rendered.planSha256, renderNetworkPlan(source).sha256);
      assert.notEqual(rendered.planSha256, legacy.planSha256);
      assert.deepEqual(rendered.ip, legacy.ip, 'management must not change core routing');
      assert.deepEqual(rendered.nft.data, legacy.nft.data, 'management must not change classification or manufacture marks');
      const output = rendered.nft.guard.replace.split('\n').filter(line => line.startsWith('add rule inet cocoproxy_guard output_guard '));
      const managementRules = output.filter(line => line.includes('meta skuid 12346'));
      const allowed = managementRules.filter(line => line.endsWith('accept'));
      const managementPath = fixtureCgroups?.management === null ? null : fixtureCgroups?.management ?? '/system.slice/cocoproxy-management.service';
      assert.equal(allowed.length, mode !== 'blocked' && managementPath ? 2 : 0);
      for (const protocol of ['tcp', 'udp']) {
        if (allowed.length) assert.ok(allowed.some(line => line.endsWith(
          `meta skuid 12346 socket cgroupv2 level 2 "${managementPath!.slice(1)}" meta mark & 0x0000ff00 == 0 meta l4proto ${protocol} th sport != 15353 accept`)));
      }
      assert.equal(managementRules.at(-1), 'add rule inet cocoproxy_guard output_guard meta skuid 12346 drop',
        'wrong/unknown cgroups, reserved marks, DNS source port and other protocols cannot fall through policy accept');
      assert.equal(managementRules.length, allowed.length + 1, 'no other management UID exception');
      assert.equal(output.at(-1), managementRules.at(-1));
      assert.equal(output[0], 'add rule inet cocoproxy_guard output_guard oifname "lo" return');
      assert.deepEqual(output.filter(line => !line.includes('meta skuid 12346')),
        legacy.nft.guard.replace.split('\n').filter(line => line.startsWith('add rule inet cocoproxy_guard output_guard ') &&
          !line.includes('socket cgroupv2 level 2 "' + managementPath?.slice(1) + '"')),
        'all core exceptions and the core UID drop remain identical');
    }
  }
});

test('DNS allows only exact IPv4 listener delivered by router for the two permitted sources', () => {
  const script = renderNetworkRules(input(), { mode: 'active' }).nft.guard.replace;
  const lines = script.split('\n').filter(line => line.includes('input_guard') && line.endsWith('accept'));
  assert.equal(lines.length, 8);
  assert.ok(lines.some(line => line.includes('iifname "lo" ip saddr 127.0.0.1 ip daddr 192.0.2.2')));
  const lan = lines.filter(line => line.includes('iifname "lan-test"'));
  assert.equal(lan.length, 6);
  for (const address of ['192.0.2.3', '192.0.2.1']) {
    const source = lan.filter(line => line.includes(`ether saddr 02:00:00:00:00:01 ip saddr ${address}/32 ip daddr 192.0.2.2`));
    assert.equal(source.length, 3);
    assert.ok(source.find(line => line.includes('udp dport 15353'))!.endsWith('socket cgroupv2 level 2 "system.slice/cocoproxy-mihomo.service" accept'));
  }
  assert.ok(script.indexOf('th dport 15353 accept') < script.indexOf('th dport 15353 drop'));
});

test('DNS SYNACK alternative requires listener-authenticated conntrack proof and preserves unreserved CT bits', () => {
  const script = renderNetworkRules(input(), { mode: 'active' }).nft.guard.replace;
  const lines = script.split('\n');
  const writes = lines.filter(line => line.includes('ct mark set'));
  assert.equal(writes.length, 2);
  for (const address of ['192.0.2.3', '192.0.2.1']) {
    const syn = writes.find(line => line.includes(`ip saddr ${address}/32`))!;
    assert.ok(syn.includes(`input_guard iifname "lan-test" ether saddr 02:00:00:00:00:01 ip saddr ${address}/32 ip daddr 192.0.2.2 tcp dport 15353`));
    assert.ok(syn.includes('tcp flags & (fin | syn | rst | ack) == syn ct direction original socket cgroupv2 level 2 "system.slice/cocoproxy-mihomo.service"'));
    assert.ok(syn.endsWith('ct mark set (ct mark & 0xffff00ff) | 0x00000200 accept'));
    const newSynDrop = lines.find(line => line.includes(`ip saddr ${address}/32`) && line.includes('tcp flags & (fin | syn | rst | ack) == syn drop'))!;
    const continuation = lines.find(line => line.includes(`ip saddr ${address}/32`) && line.includes('tcp dport 15353 ct direction original ct mark & 0x0000ff00 == 0x00000200 accept'))!;
    assert.ok(newSynDrop && continuation);
    assert.ok(lines.indexOf(syn) < lines.indexOf(newSynDrop));
    assert.ok(lines.indexOf(newSynDrop) < lines.indexOf(continuation), 'tuple reuse cannot bypass listener proof on a new SYN');
  }
  const alternatives = lines.filter(line => line.includes('output_guard') && line.endsWith('accept') && !line.includes('socket cgroupv2'));
  assert.equal(alternatives.length, 2);
  for (const address of ['192.0.2.3', '192.0.2.1']) {
    const reply = alternatives.find(line => line.includes(`ip daddr ${address}/32`))!;
    for (const required of ['meta skuid 12345', 'meta mark & 0x0000ff00 == 0x00000200',
    'ct direction reply ct mark & 0x0000ff00 == 0x00000200', `ip saddr 192.0.2.2 ip daddr ${address}/32`,
      'tcp sport 15353', 'tcp flags & (fin | syn | rst | ack) == (syn | ack)', 'oifname "lan-test"']) assert.ok(reply.includes(required));
  }
  assert.doesNotMatch(script, /meta mark set ct mark/);
  for (const mode of ['blocked', 'core-only'] as const) {
    assert.doesNotMatch(renderNetworkRules(input(), { mode }).nft.guard.replace, /ct mark|ct direction/);
  }
});

test('argv routes retain three blackholes, forced router client return and TUN-only capture', () => {
  const steps = renderNetworkRules(input(), { mode: 'active' }).ip;
  assert.equal(steps.blackholes.length, 3);
  for (const item of steps.blackholes) {
    assert.deepEqual(item.args.slice(0, 5), ['-4', 'route', 'replace', 'blackhole', 'default']);
    assert.deepEqual(item.args.slice(-4), ['proto', '186', 'metric', '32760']);
  }
  assert.deepEqual(steps.rules[2].args, ['-4', 'rule', 'add', 'priority', '10001', 'fwmark', '0x00000300/0x0000ff00', 'iif', 'cocoproxy-tun', 'to', '192.0.2.3/32', 'lookup', '10001']);
  assert.ok(steps.prepareRoutes.some(item => item.args.join(' ').includes('192.0.2.3/32 via 192.0.2.1 dev lan-test')));
  assert.ok(steps.prepareRoutes.filter(item => item.args.includes('192.0.2.3/32')).every(item => item.args.includes('via')));
  assert.deepEqual(steps.activateCapture[0].args, ['-4', 'route', 'replace', '0.0.0.0/0', 'dev', 'cocoproxy-tun', 'table', '10003', 'proto', '186', 'metric', '10']);
  assert.equal(steps.withdrawCapture[0].args[2], 'del');
  assert.ok(Object.values(steps).flat().every(item => item.args.every(arg => typeof arg === 'string' && !/[;\r\n]/.test(arg))));
});

test('rejects injection and hostile option objects without invoking supplied code or leaking input', () => {
  let called = 0;
  const bad = [undefined, { mode: 'other' }, { mode: 'active', extra: 1 },
    { get mode() { called++; return 'active'; } },
    new Proxy({}, { ownKeys() { called++; throw new Error('secret'); } }),
    { mode: 'active', fixtureCgroups: undefined },
    ...['/fixture/core" accept', '/fixture/../core', '/fixture//core', '/fixture/core\n', 'fixture/core'].map(core =>
      ({ mode: 'active', fixtureCgroups: { core, management: '/fixture/management' } })),
    { mode: 'active', fixtureCgroups: { core: '/fixture/core', management: '/fixture/core/nested' } }];
  for (const options of bad) {
    assert.throws(() => renderNetworkRules(input(), options as NetworkRulesOptions), (error: unknown) => {
      assert.ok(error instanceof NetworkRulesError);
      assert.equal(error.message, 'NETWORK_RULES_INVALID');
      assert.equal(Object.hasOwn(error, 'cause'), false);
      return true;
    });
  }
  assert.equal(called, 0);
  assert.throws(() => renderNetworkRules({ ...input(), ingressInterface: 'lan; accept' }, { mode: 'active' }), NetworkRulesError);
});
