/** Real operations only in the kernel test's verified new user/network tree. */
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { NativeNetworkSession } from '../../packages/network/native.ts';
import { runNetworkCommand } from '../../packages/network/command.ts';
import { fencedNetworkCommandDigest, runFencedNetworkCommand } from '../../packages/network/fenced-command.ts';
import { ResourceJournal } from '../../packages/network/resource-journal.ts';
import { renderNetworkPlan } from '../../packages/network/plan.ts';
import { observeNetworkReadinessFixture } from '../../packages/network/probe.ts';

const [root, outerUser, outerNet] = process.argv.slice(2);
const input = JSON.parse(await readFile(join(root, 'input.json'), 'utf8'));
const plan = renderNetworkPlan(input.networkDeployment);
const directory = join(root, 'native-resources');
const create = () => NativeNetworkSession.fixture(plan.deployment, { ipBinary: '/usr/sbin/ip', nftBinary: '/usr/sbin/nft' },
  { outerUser, outerNet, cgroups: { core: input.blocked.cgroups.core.path, management: null } }, directory);
const session = await create();
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
    else if (request.op === 'pending-blackhole' || request.op === 'pending-nft') {
      // Reproduce the durable boundary after tool completion and before the
      // resource receipt advances, using the real fenced transport and tools.
      const journal = new ResourceJournal(directory, 'fixture');
      await journal.exclusive(async () => {
        const receipt = (await journal.read())!;
        const nft = request.op === 'pending-nft';
        const scripts: string[] = [input.blocked.nft.guard.replace, input.blocked.nft.data.replace];
        const args = nft ? ['-j', '-n', '-e', scripts.map(script => script.trim().split('\n').join('; ')).join('; ') + ';'] : input.blocked.ip.blackholes[0].args;
        const binary = nft ? receipt.context.nft.path : receipt.context.ip.path;
        const token = randomUUID();
        await journal.write({ ...receipt, pending: { token, commandSHA: fencedNetworkCommandDigest(binary, args), operation: nft ?
          { kind: 'nft', mode: 'blocked', operation: 'replace', reset: false } : { kind: 'ip', category: 'blackhole', index: 0 } } });
        await runFencedNetworkCommand(join(directory, 'commands'), token, binary, args, {}, { scope: 'fixture', outerUser, outerNet });
      });
    }
    else if (request.op === 'recover-checkpoint') {
      // Test-only crash at the adopted-state commit, before blocked intent.
      const write = ResourceJournal.prototype.write;
      ResourceJournal.prototype.write = async function(receipt) {
        const saved = await write.call(this, receipt);
        if (receipt.pending === null) process.kill(process.pid, 'SIGKILL');
        return saved;
      };
      await session.recoverBlocked();
      throw new Error();
    }
    else if (request.op === 'recover') {
      const stale = await create();
      let required = false;
      try { await session.inspect(); }
      catch (error) { required = (error as { code?: string }).code === 'NETWORK_RECOVERY_REQUIRED'; }
      if (!required) throw new Error();
      await session.recoverBlocked();
      let refused = false;
      try { await stale.recoverBlocked(); }
      catch (error) { refused = (error as { code?: string }).code === 'NETWORK_RESOURCE_STALE'; }
      value = refused && (await session.inspect()).mode === 'blocked';
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
