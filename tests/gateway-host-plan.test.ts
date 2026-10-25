import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readlink, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AUTOMATIC_GATEWAY_CORE_SHA256, compileAutomaticGatewayConfig } from '../packages/gateway/profile.ts';
import { renderAutomaticGatewayHostPlan } from '../packages/gateway/host-plan.ts';

const network = { schemaVersion: 1, ingressInterface: 'lan0', gatewayIPv4: '192.0.2.2',
  routerIPv4: '192.0.2.1', routerMAC: '02:00:00:00:00:01', clientIPv4: '192.0.2.10',
  prefixLength: 24, dnsPort: 1053, egressMark: 3030, egressTable: 3030,
  egressPriority: 8000, tunMtu: 1500 };
const input = { network, sourceDirectory: '/opt/cocoproxy', pythonPath: '/usr/bin/python3',
  settingsPath: '/etc/cocoproxy/gateway-network.json', stateDirectory: '/var/lib/cocoproxy-gateway-network' };

test('native root oneshot retains an independent guard when the core or service stops', () => {
  const plan = renderAutomaticGatewayHostPlan(input);
  assert.match(plan.unit, /Type=oneshot\nRemainAfterExit=true\nUser=root/);
  assert.match(plan.unit, /ExecStart="\/usr\/bin\/python3" "-I" "\/opt\/cocoproxy\/apps\/gateway\/network.py" "prepare" "--settings"/);
  assert.match(plan.unit, /ExecReload="\/usr\/bin\/python3" "-I" "\/opt\/cocoproxy\/apps\/gateway\/network.py" "reconcile" "--settings"/);
  assert.doesNotMatch(plan.unit, /ExecStop|WantedBy|Restart=|CAP_SYS_ADMIN/);
  assert.equal(plan.settings.ipPath, '/usr/sbin/ip');
  assert.equal(plan.settings.nftPath, '/usr/sbin/nft');
  assert.deepEqual(plan.settings.network, network);
  assert.equal(plan.settings.guardRules, plan.guardRules);
  assert.match(plan.guardRules, /table inet cocoproxy_auto_guard/);
  assert.match(plan.guardRules, /hook prerouting priority -310/);
  assert.match(plan.guardRules, /ip daddr != 192\.0\.2\.0\/24 ip saddr != 192\.0\.2\.10 drop/);
  assert.match(plan.guardRules, /ether saddr != 02:00:00:00:00:01 drop/);
  assert.match(plan.guardRules, /iifname "lan0" ip saddr 192\.0\.2\.1 ether saddr 02:00:00:00:00:01 ip daddr 192\.0\.2\.2 meta l4proto \{ tcp, udp \} th dport 1053 accept/);
  assert.match(plan.guardRules, /iifname "lo" ip daddr 192\.0\.2\.2/);
  assert.match(plan.guardRules, /ip daddr 192\.0\.2\.2 meta l4proto \{ tcp, udp \} th dport 1053 drop/);
  assert.match(plan.guardRules, /meta nfproto ipv6 drop/);
  assert.match(plan.guardRules, /ip saddr 192\.0\.2\.10 ip daddr != 192\.0\.2\.0\/24 oifname != "cocoproxy-tun" drop/);
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


test('LAN guard covers the connected subnet and rejects router, gateway and LAN control source addresses', () => {
  const { clientIPv4: _, ...common } = network;
  const plan = renderAutomaticGatewayHostPlan({ ...input, network: { ...common, clientCIDR: '192.0.2.0/24' } });
  assert.match(plan.guardRules, /ip saddr != 192\.0\.2\.0\/24 drop/);
  assert.match(plan.guardRules, /ip saddr \{ 192\.0\.2\.2, 192\.0\.2\.1, 192\.0\.2\.0, 192\.0\.2\.255 \} drop/);
  assert.match(plan.guardRules, /ip saddr 192\.0\.2\.0\/24 ip daddr != 192\.0\.2\.0\/24 oifname != "cocoproxy-tun" drop/);
});


test('native LAN gateway sends multiple clients through reviewed TUN and retains failure protection',
  { skip: process.platform !== 'linux' || !process.env.COCOPROXY_TEST_MIHOMO || process.env.COCOPROXY_TEST_GATEWAY_KERNEL !== '1', timeout: 70_000 }, async t => {
    const core = process.env.COCOPROXY_TEST_MIHOMO!;
    assert.equal(createHash('sha256').update(await readFile(core)).digest('hex'), AUTOMATIC_GATEWAY_CORE_SHA256);
    const { clientIPv4: _, ...common } = network;
    const lan = { ...common, ingressInterface: 'lan-test', dnsPort: 15353, clientCIDR: '192.0.2.0/24' };
    const plan = renderAutomaticGatewayHostPlan({ ...input, network: lan });
    const config = compileAutomaticGatewayConfig({ schemaVersion: 1, deployment: {
      mixedPort: 17890, controllerPort: 19090, controllerSecret: 'synthetic-test-secret', dnsPort: 15353,
      bootstrapResolvers: ['198.51.100.2'], sniffing: true }, policy: { 'log-level': 'error',
      // Clients connect to an IP without querying core DNS. HTTP must recover
      // fixture.invalid from Host; an unrecovered TCP connection is rejected.
      rules: ['DOMAIN,fixture.invalid,DIRECT', 'NETWORK,udp,DIRECT', 'MATCH,REJECT'] } }, lan).config;
    const root = await mkdtemp(join(tmpdir(), 'cocoproxy-auto-lan-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    await writeFile(join(root, 'input.json'), JSON.stringify({ core, config, network: lan, guardRules: plan.guardRules }));
    const hostUser = await readlink('/proc/self/ns/user'), hostNet = await readlink('/proc/self/ns/net');
    const child = spawn('sudo', ['-n', 'python3',
      fileURLToPath(new URL('./fixtures/gateway-auto-kernel.py', import.meta.url)), '--launch', root, hostUser, hostNet],
      { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', diagnostics = '';
    child.stdout!.on('data', chunk => { output += chunk; });
    child.stderr!.on('data', chunk => { diagnostics += chunk; });
    const timer = setTimeout(() => { try { process.kill(-child.pid!, 'SIGKILL'); } catch {} }, 65_000);
    try {
      const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
      assert.equal(code, 0, `isolated native gateway fixture failed: ${output.slice(0, 2048)} ${diagnostics.slice(0, 1024)}`);
      const result = JSON.parse(output);
      for (const key of ['multiClientTcpUdp', 'newClientAddress', 'routerOnlyDns', 'tunReturnViaRouter', 'hostRoutesPreserved', 'wrongMacRejected', 'coreStopBlocked', 'addressAndResourceRecovery', 'unknownResourceRejected']) assert.equal(result[key], true, key);
    } finally {
      clearTimeout(timer);
      try { process.kill(-child.pid!, 'SIGKILL'); } catch {}
    }
  });
