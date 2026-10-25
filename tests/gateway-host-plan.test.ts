import assert from 'node:assert/strict';
import test from 'node:test';
import { renderAutomaticGatewayHostPlan } from '../packages/gateway/host-plan.ts';

const network = { schemaVersion: 1, ingressInterface: 'lan0', gatewayIPv4: '192.0.2.2',
  routerIPv4: '192.0.2.1', routerMAC: '02:00:00:00:00:01', clientIPv4: '192.0.2.10',
  prefixLength: 24, dnsPort: 1053, egressMark: 3030, egressTable: 3030,
  egressPriority: 8000, tunMtu: 1500 };
const input = { network, sourceDirectory: '/opt/coproxy', pythonPath: '/usr/bin/python3',
  settingsPath: '/etc/coproxy/gateway-network.json', stateDirectory: '/var/lib/coproxy-gateway-network' };

test('native root oneshot retains an independent guard when the core or service stops', () => {
  const plan = renderAutomaticGatewayHostPlan(input);
  assert.match(plan.unit, /Type=oneshot\nRemainAfterExit=true\nUser=root/);
  assert.match(plan.unit, /ExecStart="\/usr\/bin\/python3" "-I" "\/opt\/coproxy\/apps\/gateway\/network.py" "prepare" "--settings"/);
  assert.doesNotMatch(plan.unit, /ExecStop|WantedBy|Restart=|CAP_SYS_ADMIN/);
  assert.equal(plan.settings.ipPath, '/usr/sbin/ip');
  assert.equal(plan.settings.nftPath, '/usr/sbin/nft');
  assert.deepEqual(plan.settings.network, network);
  assert.equal(plan.settings.guardRules, plan.guardRules);
  assert.match(plan.guardRules, /table inet coproxy_auto_guard/);
  assert.match(plan.guardRules, /hook prerouting priority -310/);
  assert.match(plan.guardRules, /ip daddr != 192\.0\.2\.0\/24 ip saddr != 192\.0\.2\.10 drop/);
  assert.match(plan.guardRules, /ether saddr != 02:00:00:00:00:01 drop/);
  assert.match(plan.guardRules, /iifname "lan0" ip saddr 192\.0\.2\.1 ether saddr 02:00:00:00:00:01 ip daddr 192\.0\.2\.2 meta l4proto \{ tcp, udp \} th dport 1053 accept/);
  assert.match(plan.guardRules, /iifname "lo" ip daddr 192\.0\.2\.2/);
  assert.match(plan.guardRules, /ip daddr 192\.0\.2\.2 meta l4proto \{ tcp, udp \} th dport 1053 drop/);
  assert.match(plan.guardRules, /meta nfproto ipv6 drop/);
  assert.match(plan.guardRules, /ip saddr 192\.0\.2\.10 ip daddr != 192\.0\.2\.0\/24 oifname != "coproxy-tun" drop/);
});

test('host plan validates deployment boundaries without invoking user accessors', () => {
  for (const path of ['/home/operator/install', '/root/install', '/tmp/install', '/var/tmp/install',
    '/run/user/1000/install', 'relative', '/opt/../etc', '/opt/install\nUser=nobody']) {
    assert.throws(() => renderAutomaticGatewayHostPlan({ ...input, sourceDirectory: path }));
  }
  assert.throws(() => renderAutomaticGatewayHostPlan({ ...input, settingsPath: input.stateDirectory + '/settings.json' }));
  assert.throws(() => renderAutomaticGatewayHostPlan({ ...input, network: { ...network, ingressInterface: 'lan0"; flush ruleset' } }));
  let invoked = false;
  const accessor = Object.defineProperty({ ...input }, 'sourceDirectory', { enumerable: true,
    get() { invoked = true; throw new Error('untrusted getter'); } });
  assert.throws(() => renderAutomaticGatewayHostPlan(accessor));
  assert.equal(invoked, false);
  const escaped = renderAutomaticGatewayHostPlan({ ...input, sourceDirectory: '/opt/a% $"b' });
  assert.match(escaped.unit, /"\/opt\/a%% \$\$\\"b\/apps\/gateway\/network.py"/);
  assert.deepEqual(renderAutomaticGatewayHostPlan(input), renderAutomaticGatewayHostPlan(input));
});
