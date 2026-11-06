import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout } from 'node:timers/promises';
import { runUpdaterTool, createNativeUpdaterHost } from '../packages/updater/native.ts';

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
