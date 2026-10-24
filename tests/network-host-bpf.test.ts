import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('native BPF inventory validates read-only syscall layouts, permission failure, type restrictions and stable complete enumeration',
  { skip: process.platform !== 'linux' ? 'requires Linux 64-bit Python standard library' : false }, () => {
    const result = spawnSync('/usr/bin/python3', ['-I', '-S', '-B', fileURLToPath(new URL('./fixtures/host-bpf-unit.py', import.meta.url))],
      { encoding: 'utf8', timeout: 5000, maxBuffer: 8192, windowsHide: true });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { checks: 5 });
  });
