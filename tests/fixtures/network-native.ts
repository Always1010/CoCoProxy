/** Real operations only in the kernel test's verified new user/network tree. */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { NativeNetworkSession } from '../../packages/network/native.ts';
import { runNetworkCommand } from '../../packages/network/command.ts';
import { renderNetworkPlan } from '../../packages/network/plan.ts';
import { observeNetworkReadinessFixture } from '../../packages/network/probe.ts';

const [root, outerUser, outerNet] = process.argv.slice(2);
const input = JSON.parse(await readFile(join(root, 'input.json'), 'utf8'));
const plan = renderNetworkPlan(input.networkDeployment);
const session = await NativeNetworkSession.fixture(plan.deployment, { ipBinary: '/usr/sbin/ip', nftBinary: '/usr/sbin/nft' },
  { outerUser, outerNet, cgroups: { core: input.blocked.cgroups.core.path, management: null } });
console.log(JSON.stringify({ ready: true }));
for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  try {
    if (line.length > 1024) throw new Error();
    const request = JSON.parse(line);
    let value: unknown = true;
    if (request.op === 'membership-check') {
      const witness = await NativeNetworkSession.fixture(plan.deployment, { ipBinary: '/usr/sbin/ip', nftBinary: '/usr/sbin/nft' },
        { outerUser, outerNet, cgroups: { core: input.blocked.cgroups.core.path, management: null } });
      const args = ['-4', 'route', 'add', 'blackhole', 'default', 'table', String(plan.deployment.tables.capture), 'proto', '186', 'metric', '32760'];
      await runNetworkCommand('/usr/sbin/ip', args);
      value = false;
      try { await witness.installBlocked(); }
      catch (error) { value = (error as { code?: string }).code === 'NETWORK_RESOURCE_MEMBERSHIP_CHANGED'; }
      finally { args[2] = 'del'; await runNetworkCommand('/usr/sbin/ip', args); }
    }
    else if (request.op === 'install') await session.installBlocked();
    else if (request.op === 'prepare') await session.prepare();
    else if (request.op === 'authorize') await session.authorizeCore();
    else if (request.op === 'activate') await session.activate();
    else if (request.op === 'retain') await session.retainBlocked();
    else if (request.op === 'inspect') value = await session.inspect();
    else if (request.op === 'tamper-check') {
      value = false;
      try { await session.inspect(); }
      catch (error) { value = (error as { code?: string }).code === 'NETWORK_READBACK_INVALID'; }
      if (value) {
        try { await session.installBlocked(); value = false; }
        catch (error) { value = (error as { code?: string }).code === 'NETWORK_SESSION_UNAVAILABLE'; }
      }
    }
    else if (request.op === 'probe') {
      const stat = await readFile(`/proc/${request.corePid}/stat`, 'utf8');
      const corePidStartTime = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19];
      const result = await observeNetworkReadinessFixture(plan, { corePid: request.corePid, corePidStartTime,
        bootId: (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim(), serviceUid: plan.deployment.core.serviceUid },
      { ipBinary: '/usr/sbin/ip', queryDomain: 'invalid', expectedIPv4: '198.51.100.77', timeoutMs: 1000 });
      value = result.verified && result.scope === 'fixture' && Object.values(result.checks).every(check => check === true);
    } else throw new Error();
    console.log(JSON.stringify({ value }));
  } catch (error) {
    const code = (error as { code?: string }).code;
    console.log(JSON.stringify({ error: typeof code === 'string' && /^[A-Z_]+$/.test(code) ? code : 'NATIVE_FIXTURE_FAILED' }));
  }
}
