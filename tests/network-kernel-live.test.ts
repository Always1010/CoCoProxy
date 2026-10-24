import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdtemp, readFile, readdir, readlink, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { compileGatewayPreview, GATEWAY_CORE_SHA256 } from '../packages/network/config.ts';
import { renderNetworkRules } from '../packages/network/rules.ts';
import { reviewedBinary } from './protocol-live-helpers.ts';

const coreInput = process.env.COPROXY_TEST_MIHOMO;
const serverInput = process.env.COPROXY_TEST_SING_BOX;
const skip = process.platform !== 'linux' ? 'requires Linux user and network namespaces' :
  !coreInput || !serverInput ? 'set COPROXY_TEST_MIHOMO and COPROXY_TEST_SING_BOX to reviewed binaries' :
    process.getuid?.() === 0 ? 'requires an unprivileged invoking user' : false;

async function members(group: number): Promise<number[]> {
  const result: number[] = [];
  for (const pid of await readdir('/proc')) {
    if (!/^\d+$/.test(pid)) continue;
    try {
      const fields = (await readFile(`/proc/${pid}/stat`, 'utf8')).split(')').at(-1)!.trim().split(/\s+/);
      if (Number(fields[2]) === group && fields[0] !== 'Z') result.push(Number(pid));
    } catch (error) {
      if (!['ENOENT', 'ESRCH', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    }
  }
  return result;
}

async function namespaceMembers(namespace: string): Promise<number[]> {
  const result: number[] = [];
  for (const pid of await readdir('/proc')) {
    if (!/^\d+$/.test(pid)) continue;
    try { if (await readlink(`/proc/${pid}/ns/user`) === namespace) result.push(Number(pid)); }
    catch (error) { if (!['ENOENT', 'ESRCH', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
  }
  return result;
}

test('isolated four-role kernel forwards transparent TCP, UDP and DNS through a reviewed VLESS node and fails closed',
  { skip, timeout: 150_000 }, async () => {
    const coreReview = JSON.parse(await readFile(new URL('../integrations/metacubexd/review.json', import.meta.url), 'utf8'));
    const serverReview = JSON.parse(await readFile(new URL('../integrations/protocol-fixture/review.json', import.meta.url), 'utf8'));
    assert.equal(coreReview.coreCandidate.binarySha256, GATEWAY_CORE_SHA256);
    const core = await reviewedBinary(coreInput!, GATEWAY_CORE_SHA256);
    const server = await reviewedBinary(serverInput!, serverReview.server.binarySha256);
    const cgroup = (await readFile('/proc/self/cgroup', 'utf8')).split('\n').find(line => line.startsWith('0::'))?.slice(3);
    assert.ok(cgroup && cgroup !== '/', 'fixture requires a named existing cgroup v2 membership');
    const uuid = randomUUID();
    const preview = compileGatewayPreview({ schemaVersion: 1, base: { schemaVersion: 1,
      deployment: { mixedPort: 17890, controllerPort: 19090, controllerSecret: randomUUID(), dnsPort: 15353,
        bootstrapResolvers: ['198.51.100.2'] },
      policy: { 'log-level': 'error', proxies: [{ name: 'single-node', type: 'vless', server: '198.51.100.2', port: 18080, uuid, udp: true }],
        rules: ['DOMAIN-SUFFIX,blocked.invalid,REJECT', 'MATCH,single-node'] } },
    network: { schemaVersion: 1, core: { serviceUid: process.getuid!(), binarySha256: GATEWAY_CORE_SHA256, unitSha256: 'c'.repeat(64) },
      ingressInterface: 'lan-test', gatewayIPv4: '192.0.2.2', prefixLength: 24, routerIPv4: '192.0.2.1',
      routerMAC: '02:00:00:00:00:01', clientIPv4: '192.0.2.3', dnsPort: 15353, tun: { interface: 'coproxy-tun', mtu: 1500 },
      marks: { mask: 0xff00, capture: 0x100, egress: 0x200, return: 0x300 },
      tables: { capture: 10003, egress: 10002, return: 10001 }, priorities: { capture: 10003, egress: 10002, return: 10001 } } });
    assert.deepEqual(preview.candidate.config.rules, ['DOMAIN-SUFFIX,blocked.invalid,REJECT', 'MATCH,single-node']);
    const fixtureCgroups = { core: cgroup, management: null };
    const blocked = renderNetworkRules(preview.networkPlan.deployment, { mode: 'blocked', fixtureCgroups });
    const coreOnly = renderNetworkRules(preview.networkPlan.deployment, { mode: 'core-only', fixtureCgroups });
    const active = renderNetworkRules(preview.networkPlan.deployment, { mode: 'active', fixtureCgroups });
    assert.equal(active.scope, 'fixture');
    assert.equal(active.generation, preview.candidate.id);
    assert.equal(active.planSha256, preview.networkPlan.sha256);
    const root = await mkdtemp(join(tmpdir(), 'coproxy-network-kernel-'));
    await chmod(root, 0o700);
    let cleanup = false;
    let child: ReturnType<typeof spawn> | undefined;
    const hostUser = await readlink('/proc/self/ns/user'), hostNet = await readlink('/proc/self/ns/net');
    try {
      const input = { config: preview.candidate.config, networkDeployment: preview.networkPlan.deployment,
        node: process.execPath, blocked, coreOnly, active, core, server,
        // Typed UDP DNS and default_domain_resolver are supported by the pinned
        // official v1.14.4 option/dns.go and option/route.go schemas.
        serverConfig: { log: { level: 'error' }, dns: { servers: [{ type: 'udp', tag: 'fixture-dns', server: '198.51.100.2', server_port: 53 }] },
          inbounds: [{ type: 'vless', tag: 'synthetic-node', listen: '198.51.100.2',
          listen_port: 18080, users: [{ uuid }] }], outbounds: [{ type: 'direct', tag: 'synthetic-origin', inet4_bind_address: '198.51.100.2' }],
        route: { default_domain_resolver: { server: 'fixture-dns', strategy: 'ipv4_only' },
          rules: [{ action: 'resolve', server: 'fixture-dns', strategy: 'ipv4_only' },
            { ip_cidr: ['198.51.100.2/32', '198.51.100.77/32', '198.51.100.78/32'], port: [8080, 8081], action: 'route', outbound: 'synthetic-origin' }, { action: 'reject' }] } } };
      await writeFile(join(root, 'input.json'), JSON.stringify(input), { mode: 0o600 });
      child = spawn('unshare', ['--user', '--map-current-user', '--keep-caps', '--net', 'python3',
        fileURLToPath(new URL('./fixtures/network-kernel.py', import.meta.url)), root, hostUser, hostNet],
      { detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C', HOME: root } });
      let output = '', bytes = 0, overflow = false;
      const consume = (chunk: Buffer, stdout: boolean) => {
        bytes += chunk.length;
        if (bytes > 65_536) { overflow = true; try { process.kill(-child!.pid!, 'SIGKILL'); } catch {} }
        else if (stdout) output += chunk.toString('utf8');
      };
      child.stdout!.on('data', chunk => consume(chunk, true)); child.stderr!.on('data', chunk => consume(chunk, false));
      const exited = new Promise<number | null>((resolve, reject) => { child!.once('error', reject); child!.once('close', resolve); });
      const timer = setTimeout(() => { try { process.kill(-child!.pid!, 'SIGKILL'); } catch {} }, 115_000);
      let code: number | null;
      try { code = await exited; } finally { clearTimeout(timer); }
      assert.equal(overflow, false, 'fixture exceeded diagnostic budget');
      assert.equal(code, 0, `isolated kernel fixture failed: ${output.slice(0, 2048) || 'namespace launch or capability unavailable'}`);
      const result = JSON.parse(output);
      assert.equal(result.scope, 'fixture-no-production-cgroup-isolation-proof');
      for (const key of ['isolatedRoles', 'nativeReadbackVerified', 'nativeProbeVerified', 'nativeTamperRejected', 'nativeOwnershipCollisionRejected', 'preCoreRulesInstalled', 'blockedOriginsUntouched', 'coreOnlyStillBlocked', 'coreOnlyLocalDns', 'transparentHttp', 'transparentUdp', 'realDns', 'dnsLinkedHttpUdp', 'dnsLinkedReject',
        'routerReturnObserved', 'originalSourceObserved', 'markedCoreEgressObserved', 'wrongMacRejected',
        'unmarkedSameUidRejected', 'coreDeathExistingAndNewBlocked', 'tunLossBlocked', 'nodeDeathNoDirectFallback']) {
        assert.equal(result[key], true, key);
      }
      assert.equal(createHash('sha256').update(await readFile(core)).digest('hex'), GATEWAY_CORE_SHA256);
    } finally {
      if (child?.pid) {
        for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
          try { process.kill(-child.pid, signal); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
          await delay(200);
          if ((await members(child.pid)).length === 0) break;
        }
        cleanup = (await members(child.pid)).length === 0;
      } else cleanup = true;
      // Native tools have their own process groups. Also settle every child in
      // the fixture's verified private user namespace before removing inputs.
      let innerUser: string | undefined;
      try {
        const proof = JSON.parse(await readFile(join(root, 'isolation.json'), 'utf8'));
        assert.equal(proof.outerUser, hostUser);
        assert.match(proof.innerUser, /^user:\[\d+\]$/);
        assert.notEqual(proof.innerUser, hostUser);
        innerUser = proof.innerUser;
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { cleanup = false; } }
      if (innerUser) {
        for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
          const pending = await namespaceMembers(innerUser);
          if (!pending.length) break;
          for (const pid of pending) {
            try { if (await readlink(`/proc/${pid}/ns/user`) === innerUser) process.kill(pid, signal); }
            catch (error) { if (!['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
          }
          await delay(200);
        }
        cleanup = cleanup && (await namespaceMembers(innerUser)).length === 0;
      }
      // Never remove executable inputs while a namespace child can still use them.
      if (cleanup) await rm(root, { recursive: true, force: true });
      assert.equal(cleanup, true, 'fixture process group survived bounded cleanup; private inputs retained');
    }
  });
