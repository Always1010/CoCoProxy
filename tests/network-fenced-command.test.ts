import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fork, spawn } from 'node:child_process';
import { chmod, link, mkdir, mkdtemp, readFile, readlink, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { atomicWrite } from '../packages/storage/private-files.ts';
import { NetworkCommandError } from '../packages/network/command.ts';
import { fencedNetworkCommandDigest, fencedProcessIdentity, fencedReceiptName, fencedResultName,
  inspectFencedNetworkCommand, readFencedNetworkCommandResult, runFencedNetworkCommand,
  settleFencedNetworkCommand } from '../packages/network/fenced-command.ts';

const linux = { skip: process.platform !== 'linux' };
async function temporary(t: { after: (callback: () => Promise<unknown>) => void }): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'coproxy-fenced-'));
  t.after(() => rm(root, { recursive: true, force: true })); return root;
}
async function until(check: () => Promise<boolean>): Promise<void> {
  for (let index = 0; index < 100; index++) { if (await check()) return; await delay(25); }
  throw new Error('synthetic readiness timeout');
}
async function exists(path: string): Promise<boolean> { try { await readFile(path); return true; } catch { return false; } }

test('fenced result is durable and bound to token, command digest and session leader', linux, async t => {
  const root = await temporary(t), token = randomUUID();
  const args = ['-e', 'process.stdout.write("synthetic echo\\n")'];
  assert.equal(await runFencedNetworkCommand(root, token, process.execPath, args), 'synthetic echo\n');
  const inspection = await inspectFencedNetworkCommand(root, token);
  assert.equal(inspection.state, 'settled');
  assert.equal(inspection.receipt!.commandSHA, fencedNetworkCommandDigest(process.execPath, args));
  assert.equal(inspection.receipt!.pid, inspection.receipt!.sid);
  assert.equal(inspection.receipt!.pid, inspection.receipt!.pgid);
  assert.equal((await readFencedNetworkCommandResult(root, token))!.stdout, 'synthetic echo\n');
  const moduleURL = new URL('../packages/network/fenced-command.ts', import.meta.url).href;
  const reader = spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e',
    `import {readFencedNetworkCommandResult as read} from ${JSON.stringify(moduleURL)};process.stdout.write((await read(process.argv[1],process.argv[2])).stdout);`, root, token]);
  const chunks: Buffer[] = []; reader.stdout.on('data', chunk => chunks.push(chunk));
  await new Promise<void>(resolve => reader.once('close', () => resolve()));
  assert.equal(reader.exitCode, 0); assert.equal(Buffer.concat(chunks).toString(), 'synthetic echo\n');
  await assert.rejects(runFencedNetworkCommand(root, token, process.execPath, args), (e: unknown) =>
    e instanceof NetworkCommandError && e.code === 'NETWORK_COMMAND_TOKEN_USED');
});

test('an ACK without a durable start receipt never starts the tool', linux, async t => {
  const root = await temporary(t), token = randomUUID(), marker = join(root, 'forbidden');
  const args = ['-e', 'require("fs").writeFileSync(process.argv[1],"late")', marker];
  const commandSHA = fencedNetworkCommandDigest(process.execPath, args);
  const worker = fork(new URL('../packages/network/command-worker.ts', import.meta.url), [], {
    detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], execArgv: ['--experimental-strip-types'],
  });
  worker.send({ type: 'init', root, token, commandSHA, binary: process.execPath, args, options: {} });
  worker.once('message', () => worker.send({ type: 'ack', token, commandSHA }));
  await new Promise<void>(resolve => worker.once('exit', () => resolve()));
  await delay(400); assert.equal(await exists(marker), false);
  assert.equal((await inspectFencedNetworkCommand(root, token)).state, 'absent');
});

test('parent SIGKILL before ACK cannot leave a mutating worker', linux, async t => {
  const root = await temporary(t), marker = join(root, 'forbidden'), token = randomUUID();
  const workerURL = new URL('../packages/network/command-worker.ts', import.meta.url).href;
  const commandURL = new URL('../packages/network/fenced-command.ts', import.meta.url).href;
  const source = `import {fork} from 'node:child_process';import {fencedNetworkCommandDigest as digest} from ${JSON.stringify(commandURL)};const args=['-e','require("fs").writeFileSync(process.argv[1],"late")',process.argv[2]];const worker=fork(new URL(${JSON.stringify(workerURL)}),[],{detached:true,stdio:['ignore','ignore','ignore','ipc'],execArgv:['--experimental-strip-types']});worker.on('message',()=>process.stdout.write('ready'));worker.send({type:'init',root:process.argv[1],token:process.argv[3],commandSHA:digest(process.execPath,args),binary:process.execPath,args,options:{}});`;
  const parent = spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', source, root, marker, token]);
  await new Promise<void>(resolve => parent.stdout.once('data', () => resolve()));
  parent.kill('SIGKILL'); await new Promise<void>(resolve => parent.once('exit', () => resolve()));
  await delay(700); assert.equal(await exists(marker), false);
});

test('parent SIGKILL after ACK kills TERM-resistant descendants before a late write', linux, async t => {
  const root = await temporary(t), started = join(root, 'started'), marker = join(root, 'forbidden'), token = randomUUID();
  const descendant = 'process.on("SIGTERM",()=>{});require("fs").writeFileSync(process.argv[1],"started");setTimeout(()=>require("fs").writeFileSync(process.argv[2],"late"),1200);setTimeout(()=>{},3000);';
  const tool = `process.on('SIGTERM',()=>{});require('child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)},process.argv[1],process.argv[2]],{stdio:'ignore'});setTimeout(()=>{},3000);`;
  const commandURL = new URL('../packages/network/fenced-command.ts', import.meta.url).href;
  const source = `import {runFencedNetworkCommand as run} from ${JSON.stringify(commandURL)};await run(process.argv[1],process.argv[2],process.execPath,['-e',${JSON.stringify(tool)},process.argv[3],process.argv[4]]);`;
  const parent = spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', source, root, token, started, marker]);
  await until(() => exists(started)); parent.kill('SIGKILL');
  await new Promise<void>(resolve => parent.once('exit', () => resolve()));
  await delay(1400); assert.equal(await exists(marker), false);
  assert.equal((await settleFencedNetworkCommand(root, token)).state, 'settled');
});

test('fenced command bounds output, timeout, diagnostics and descendant lifetime', linux, async t => {
  const root = await temporary(t);
  for (const [source, expected, options] of [
    ['process.stdout.write(Buffer.alloc(65536))', 'NETWORK_COMMAND_OUTPUT_LIMIT', { maxOutputBytes: 1024 }],
    ['process.stderr.write("synthetic-private");process.exit(1)', 'NETWORK_COMMAND_FAILED', {}],
    ['process.stdout.write(Buffer.from([255]))', 'NETWORK_COMMAND_INVALID_OUTPUT', {}],
    ['process.on("SIGTERM",()=>{});setTimeout(()=>{},3000)', 'NETWORK_COMMAND_TIMEOUT', { timeoutMs: 100 }],
  ] as const) {
    await assert.rejects(runFencedNetworkCommand(root, randomUUID(), process.execPath, ['-e', source], options), (e: unknown) => {
      assert.ok(e instanceof NetworkCommandError); assert.equal(e.code, expected); assert.equal(e.childSettled, true);
      assert.doesNotMatch(String(e), /synthetic-private/); return true;
    });
  }
});

test('empty input uses ignored stdin for fast exits while nonempty input remains fail closed', linux, async t => {
  const root = await temporary(t);
  const descriptor = ['-e', 'process.stdout.write(String(require("fs").fstatSync(0).isCharacterDevice()))'];
  assert.equal(await runFencedNetworkCommand(root, randomUUID(), process.execPath, descriptor), 'true');
  assert.equal(await runFencedNetworkCommand(root, randomUUID(), process.execPath, descriptor, { input: '' }), 'true');
  for (let index = 0; index < 6; index++) {
    assert.equal(await runFencedNetworkCommand(root, randomUUID(), '/bin/true', [], index % 2 ? { input: '' } : {}), '');
  }
  const echo = ['-e', 'process.stdin.pipe(process.stdout)'];
  assert.equal(await runFencedNetworkCommand(root, randomUUID(), process.execPath, echo, { input: 'synthetic input' }), 'synthetic input');
  await assert.rejects(runFencedNetworkCommand(root, randomUUID(), process.execPath, ['-e', 'process.stdin.destroy();process.exit(0)'],
    { input: 'x'.repeat(262_144) }), (e: unknown) => e instanceof NetworkCommandError && e.code === 'NETWORK_COMMAND_FAILED' && e.childSettled);
});

test('a reused or mismatched identity never authorizes signalling another group', linux, async t => {
  const root = await temporary(t), token = randomUUID();
  const other = spawn(process.execPath, ['-e', 'setTimeout(()=>{},10000)'], { detached: true, stdio: 'ignore' });
  t.after(async () => { try { process.kill(-other.pid!, 'SIGKILL'); } catch {} });
  const { state: _state, ...identity } = await fencedProcessIdentity(other.pid!);
  await atomicWrite(root, fencedReceiptName(token), JSON.stringify({ version: 1, token, commandSHA: 'a'.repeat(64),
    ...identity, startTime: String(BigInt(identity.startTime) + 1n) }));
  assert.equal((await settleFencedNetworkCommand(root, token)).state, 'uncertain');
  assert.equal(other.exitCode, null); assert.equal(other.signalCode, null); process.kill(other.pid!, 0);
});

test('private fence rejects linked files, writable or linked ancestors, and corrupt result bindings', linux, async t => {
  const root = await temporary(t), token = randomUUID();
  await runFencedNetworkCommand(root, token, process.execPath, ['-e', 'process.stdout.write("echo")']);
  const receiptPath = join(root, fencedReceiptName(token)), resultPath = join(root, fencedResultName(token));
  const fixedFailure = (e: unknown) => e instanceof NetworkCommandError && !e.childSettled &&
    ['NETWORK_COMMAND_FENCE_UNSAFE', 'NETWORK_COMMAND_FENCE_CORRUPT'].includes(e.code);
  const linked = join(root, 'receipt-alias'); await link(receiptPath, linked);
  await assert.rejects(inspectFencedNetworkCommand(root, token), fixedFailure); await unlink(linked);
  await link(resultPath, linked);
  await assert.rejects(readFencedNetworkCommandResult(root, token), fixedFailure); await unlink(linked);
  const receipt = await readFile(receiptPath), result = JSON.parse(await readFile(resultPath, 'utf8'));
  for (const corrupt of [
    { ...result, token: randomUUID() }, { ...result, commandSHA: '0'.repeat(64) },
    { ...result, worker: { ...result.worker, startTime: '1' } }, { ...result, stdoutBase64: '%%%invalid' },
    { ...result, unexpected: true }, { ...result, ok: false, code: 'NETWORK_COMMAND_FAILED' },
  ]) {
    await writeFile(resultPath, JSON.stringify(corrupt));
    await assert.rejects(readFencedNetworkCommandResult(root, token), fixedFailure);
  }
  await writeFile(resultPath, JSON.stringify(result));
  await unlink(receiptPath);
  await assert.rejects(inspectFencedNetworkCommand(root, token), fixedFailure);
  await writeFile(receiptPath, receipt, { mode: 0o600 });
  const nested = join(root, 'nested'); await mkdir(nested, { mode: 0o700 });
  const alias = join(root, 'linked'); await symlink(root, alias, 'dir');
  await assert.rejects(inspectFencedNetworkCommand(join(alias, 'nested'), randomUUID()), fixedFailure);
  await chmod(root, 0o722);
  await assert.rejects(inspectFencedNetworkCommand(nested, randomUUID()), fixedFailure);
  await chmod(root, 0o700);
});

test('explicit namespace fixture proof allows unmapped root ancestors without weakening production', linux, async t => {
  const outerUser = await readlink('/proc/self/ns/user'), outerNet = await readlink('/proc/self/ns/net');
  const moduleURL = new URL('../packages/network/fenced-command.ts', import.meta.url).href;
  const source = `import assert from 'node:assert/strict';
    import {mkdtemp,readlink,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
    import {runFencedNetworkCommand as run,inspectFencedNetworkCommand as inspect,readFencedNetworkCommandResult as read,settleFencedNetworkCommand as settle} from ${JSON.stringify(moduleURL)};
    const root=await mkdtemp(join(tmpdir(),'coproxy-fenced-fixture-'));
    const proof={scope:'fixture',outerUser:process.argv[1],outerNet:process.argv[2]};
    try {
      const same={...proof,outerUser:await readlink('/proc/self/ns/user')};
      await assert.rejects(inspect(root,'synthetic-token-000',same),e=>e.code==='NETWORK_COMMAND_FENCE_UNSAFE');
      await assert.rejects(inspect(root,'synthetic-token-000',{...proof,outerNet:await readlink('/proc/self/ns/net')}),e=>e.code==='NETWORK_COMMAND_FENCE_UNSAFE');
      await assert.rejects(inspect(root,'synthetic-token-000'),e=>e.code==='NETWORK_COMMAND_FENCE_UNSAFE');
      assert.equal(await run(root,'synthetic-token-001',process.execPath,['-e','process.stdout.write("fixture")'],{},proof),'fixture');
      assert.equal((await inspect(root,'synthetic-token-001',proof)).state,'settled');
      assert.equal((await settle(root,'synthetic-token-001',proof)).state,'settled');
      assert.equal((await read(root,'synthetic-token-001',proof)).stdout,'fixture');
    } finally {await rm(root,{recursive:true,force:true});}`;
  const child = spawn('unshare', ['--user', '--map-root-user', '--net', process.execPath,
    '--experimental-strip-types', '--input-type=module', '-e', source, outerUser, outerNet],
    { env: { ...process.env, LANG: 'C', LC_ALL: 'C' } });
  const errors: Buffer[] = []; child.stderr.on('data', chunk => errors.push(chunk));
  let unavailable = false;
  child.once('error', () => { unavailable = true; });
  await new Promise<void>(resolve => child.once('close', () => resolve()));
  const diagnostic = Buffer.concat(errors).toString();
  if (unavailable || /unshare failed: (Operation not permitted|Invalid argument)/.test(diagnostic)) {
    t.skip('isolated user and network namespaces unavailable'); return;
  }
  assert.equal(child.exitCode, 0, diagnostic);
});
