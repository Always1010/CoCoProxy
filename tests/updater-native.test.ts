import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { runUpdaterTool, createNativeUpdaterHost, trustedRead } from '../packages/updater/native.ts';

test('first-start owner reads preserve missing-leaf errors without trusting missing ancestors', { skip: process.platform !== 'linux' }, async () => {
  // No files are created in this root-controlled directory.
  const missing = join('/usr/bin', 'cocoproxy-updater-missing-' + randomUUID());
  await assert.rejects(trustedRead(missing, 1024), { code: 'ENOENT' });
  await assert.rejects(trustedRead(join(missing, 'owner.json'), 1024), { code: 'INSTALL_ROOT_OWNERSHIP_REQUIRED' });
});

test('supported installations need no publisher keys, tokens or device trust files', async () => {
  const host = createNativeUpdaterHost({ schemaVersion: 1, serviceUid: 12345, nodePath: '/usr/bin/node',
    sourceDirectory: '/synthetic/release/source', releaseDirectory: '/synthetic/release' });
  assert.equal(await host.configured(), ['arm64', 'x64'].includes(process.arch));
});

test('native tool passes arguments literally and does not expose private stderr', async () => {
  const literal = '$(printf secret); `exit 1`';
  const result = await runUpdaterTool('/usr/bin/python3', ['-I', '-B', '-c',
    'import sys; print(sys.argv[1]); print("private diagnostic", file=sys.stderr)', literal]);
  assert.equal(result.code, 0);
  assert.equal(result.stdout.toString().trim(), literal);
  assert.equal(JSON.stringify(result).includes('private diagnostic'), false);
});

test('native cancellation waits until child cleanup finishes before download scratch can be removed', { timeout: 10_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cocoproxy-updater-child-'));
  const entered = join(directory, 'entered'), ended = join(directory, 'ended');
  const controller = new AbortController();
  const work = runUpdaterTool('/usr/bin/python3', ['-I', '-B', '-c',
    'import pathlib,signal,sys,time\ndef stop(*args):\n time.sleep(0.05)\n pathlib.Path(sys.argv[2]).write_text("closed")\n sys.exit(0)\nsignal.signal(signal.SIGTERM,stop)\npathlib.Path(sys.argv[1]).write_text("ready")\ntime.sleep(30)', entered, ended],
  { signal: controller.signal });
  const rejected = assert.rejects(work, (error: any) => error.name === 'AbortError');
  try {
    for (let attempt = 0; ; attempt++) {
      if (await stat(entered).then(() => true, () => false)) break;
      assert.ok(attempt < 200, 'child did not reach ready state'); await setTimeout(10);
    }
    controller.abort(); await rejected;
    assert.equal(await readFile(ended, 'utf8'), 'closed');
  } finally { controller.abort(); await work.catch(() => {}); await rm(directory, { recursive: true, force: true }); }
});

test('timeout and cancellation escalate ignored TERM and close descendant output pipes', { timeout: 10_000 }, async () => {
  for (const cancel of [false, true]) {
    const directory = await mkdtemp(join(tmpdir(), 'cocoproxy-updater-stubborn-'));
    const marker = join(directory, 'pids');
    const controller = new AbortController();
    const work = runUpdaterTool('/usr/bin/python3', ['-I', '-B', '-c',
      'import json,os,pathlib,signal,subprocess,sys,time\nsignal.signal(signal.SIGTERM,signal.SIG_IGN)\np=subprocess.Popen([sys.executable,"-c","import time;time.sleep(30)"])\npathlib.Path(sys.argv[1]).write_text(json.dumps([os.getpid(),p.pid]))\ntime.sleep(30)', marker],
    { signal: controller.signal, timeout: cancel ? 5000 : 300, killAfterMs: 100 });
    const observed = work.then(() => null, error => error);
    let pids: number[] = [];
    try {
      for (let attempt = 0; ; attempt++) {
        const value = await readFile(marker, 'utf8').catch(() => null);
        if (value) { pids = JSON.parse(value); break; }
        assert.ok(attempt < 200, 'child did not reach ready state'); await setTimeout(10);
      }
      if (cancel) controller.abort();
      const error = await observed;
      assert.equal(error?.code, cancel ? 'ABORT_ERR' : 'UPDATER_TOOL_LIMIT');
      for (const pid of pids) {
        const status = await readFile(`/proc/${pid}/stat`, 'utf8').catch(() => null);
        assert.ok(status === null || status.slice(status.lastIndexOf(')') + 2).startsWith('Z'), 'helper can still mutate installation files');
      }
    } finally {
      if (pids[0]) { try { process.kill(-pids[0], 'SIGKILL'); } catch { /* already reaped */ } }
      controller.abort(); await observed; await rm(directory, { recursive: true, force: true });
    }
  }
});
