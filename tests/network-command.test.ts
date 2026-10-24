import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { NetworkCommandError, runNetworkCommand } from '../packages/network/command.ts';

const linux = { skip: process.platform !== 'linux' };
test('fast tools that never read stdin succeed with absent or empty input', linux, async () => {
  for (let i = 0; i < 16; i++) assert.equal(await runNetworkCommand('/usr/bin/true', [], i % 2 ? { input: '' } : {}), '');
});

test('network command carries bounded atomic input without a shell and excludes inherited environment', linux, async () => {
  const source = `let s='';process.stdin.setEncoding('utf8');process.stdin.on('data',x=>s+=x);process.stdin.on('end',()=>process.stdout.write(JSON.stringify({s,arg:process.argv[1],env:process.env})));`;
  const script = 'add table inet synthetic\n';
  const arg = 'literal $(do-not-execute) `text` ; &';
  const response = JSON.parse(await runNetworkCommand(process.execPath, ['-e', source, arg], { input: script }));
  assert.equal(response.s, script);
  assert.equal(response.arg, arg);
  assert.deepEqual(Object.keys(response.env).sort(), ['LANG', 'LC_ALL', 'PATH']);
});

test('network command failures expose only fixed codes and stop excessive or invalid output', linux, async () => {
  for (const [source, expected] of [
    ['process.stderr.write("synthetic-private-diagnostic");process.exit(1)', 'NETWORK_COMMAND_FAILED'],
    ['process.stdout.write(Buffer.alloc(65536))', 'NETWORK_COMMAND_OUTPUT_LIMIT'],
    ['process.stdout.write(Buffer.from([255]))', 'NETWORK_COMMAND_INVALID_OUTPUT'],
  ]) {
    await assert.rejects(runNetworkCommand(process.execPath, ['-e', source], { maxOutputBytes: 1024 }), (error: unknown) => {
      assert.ok(error instanceof NetworkCommandError);
      assert.equal(error.code, expected); assert.equal(error.message, expected);
      assert.equal(error.childSettled, true);
      assert.doesNotMatch(String(error), /synthetic-private/);
      return true;
    });
  }
  await assert.rejects(runNetworkCommand('/synthetic/not-installed', []), (error: unknown) =>
    error instanceof NetworkCommandError && error.code === 'NETWORK_COMMAND_UNAVAILABLE' && error.childSettled);
  await assert.rejects(runNetworkCommand(process.execPath, ['bad\nargument']), (error: unknown) =>
    error instanceof NetworkCommandError && error.code === 'NETWORK_COMMAND_INVALID');
});

test('timeout terminates the process group before returning so a late child cannot mutate restored state', linux, async t => {
  const root = await mkdtemp(join(tmpdir(), 'coproxy-network-command-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const started = join(root, 'started'), forbidden = join(root, 'late-write');
  const descendant = `process.on('SIGTERM',()=>{});require('fs').writeFileSync(process.argv[1],'started');setTimeout(()=>require('fs').writeFileSync(process.argv[2],'late'),1400);setTimeout(()=>{},3000);`;
  const source = `process.on('SIGTERM',()=>{});require('child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)},process.argv[1],process.argv[2]],{stdio:'ignore'});setTimeout(()=>{},3000);`;
  await assert.rejects(runNetworkCommand(process.execPath, ['-e', source, started, forbidden], { timeoutMs: 500 }),
    (error: unknown) => error instanceof NetworkCommandError && error.code === 'NETWORK_COMMAND_TIMEOUT' && error.childSettled);
  assert.equal(await readFile(started, 'utf8'), 'started');
  await delay(1000);
  await assert.rejects(readFile(forbidden), { code: 'ENOENT' });
});
