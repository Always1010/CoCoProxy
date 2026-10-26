import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, lstat, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pauseRuntimeForMaintenance, readRuntimeLifecycle, restoreRuntimeAfterMaintenance, setRuntimeLifecycle } from '../packages/runtime/lifecycle.ts';
import { runCli } from '../apps/cli/main.ts';

test('maintenance restores absent, disabled and enabled intent without starting services or inventing enable intent', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cocoproxy-maintenance-intent-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const flags of [null, { enabled: false, paused: false }, { enabled: false, paused: true },
    { enabled: true, paused: false }, { enabled: true, paused: true }]) {
    const directory = await mkdtemp(join(root, 'state-'));
    if (flags) await setRuntimeLifecycle(directory, flags);
    const before = await readRuntimeLifecycle(directory);
    const paused = await pauseRuntimeForMaintenance(directory);
    assert.equal(paused.lifecycle.paused, true);
    assert.equal(paused.maintenanceRestore.previous.present, flags !== null);
    assert.deepEqual(await restoreRuntimeAfterMaintenance(directory, paused.maintenanceRestore), before);
    assert.deepEqual(await readRuntimeLifecycle(directory), before);
    if (!flags) await assert.rejects(lstat(join(directory, 'lifecycle.json')), { code: 'ENOENT' });
    await assert.rejects(restoreRuntimeAfterMaintenance(directory, paused.maintenanceRestore));
  }
});
test('public maintenance CLI preserves absent intent without loading a core-version-dependent runtime file', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'cocoproxy-maintenance-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const result = await runCli(['runtime-maintenance-pause', '--state-dir', directory]) as any;
  assert.equal(result.servicesChanged, false);
  assert.equal(result.maintenanceRestore.previous.present, false);
  const input = join(directory, 'maintenance-restore.json');
  await writeFile(input, JSON.stringify(result.maintenanceRestore), { mode: 0o600 });
  const restored = await runCli(['runtime-maintenance-restore', '--state-dir', directory, '--input', input]) as any;
  assert.deepEqual(restored.lifecycle, { schemaVersion: 1, enabled: false, paused: false });
  await assert.rejects(lstat(join(directory, 'lifecycle.json')), { code: 'ENOENT' });
});
test('intervening pause or explicit disable invalidates the old maintenance restore receipt', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'cocoproxy-maintenance-conflict-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await setRuntimeLifecycle(directory, { enabled: true, paused: false });
  const first = await pauseRuntimeForMaintenance(directory);
  await setRuntimeLifecycle(directory, { enabled: true, paused: true });
  await assert.rejects(restoreRuntimeAfterMaintenance(directory, first.maintenanceRestore), { code: 'RUNTIME_MAINTENANCE_CONFLICT' });
  const second = await pauseRuntimeForMaintenance(directory);
  await setRuntimeLifecycle(directory, { enabled: false, paused: true });
  await assert.rejects(restoreRuntimeAfterMaintenance(directory, second.maintenanceRestore), { code: 'RUNTIME_MAINTENANCE_CONFLICT' });
  for (const input of [null, {}, { schemaVersion: 1, pausedSha256: 'a'.repeat(64), previous: { present: false, enabled: true, paused: false } }])
    await assert.rejects(restoreRuntimeAfterMaintenance(directory, input), { code: 'RUNTIME_MAINTENANCE_RESTORE_INVALID' });
});
