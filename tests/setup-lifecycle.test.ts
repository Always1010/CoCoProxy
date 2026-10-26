import test from 'node:test';
import assert from 'node:assert/strict';
import { assertSetupLifecycleUnit, executeSetupLifecycleSteps, planSetupLifecycle, runSetupLifecycle, type LifecycleContext } from '../packages/setup/lifecycle.ts';

const context: LifecycleContext = {
  runtime: { nodePath: '/usr/bin/node', systemctlPath: '/usr/bin/systemctl', sourceDirectory: '/opt/cocoproxy/releases/' + 'a'.repeat(64) + '/source',
    stateDirectory: '/var/lib/cocoproxy', settingsPath: '/etc/cocoproxy/runtime.json' },
  serviceUser: 'cocoproxy', gateway: true, managedWeb: true, credentialExists: true, networkReceipt: 'complete',
  lifecycle: { enabled: true, paused: true },
};
const code = (expected: string) => (error: any) => error.code === expected;

test('persistence actions require explicit terminal evidence and never enable the core directly', () => {
  for (const action of ['enable-persistence', 'resume-persistence'] as const) {
    assert.throws(() => planSetupLifecycle({ action }, context), code('SETUP_TERMINAL_PATH_CONFIRMATION_REQUIRED'));
    const plan = planSetupLifecycle({ action, terminalPathVerified: true }, context);
    assert.deepEqual(plan.map(step => step.id), ['start-early-guard', 'enable-management', 'start-management',
      action === 'enable-persistence' ? 'runtime-enable' : 'runtime-resume']);
    assert.equal(plan[0].args?.join(' '), 'start cocoproxy-gateway-guard.service');
    assert.equal(plan[1].args?.includes('cocoproxy-mihomo.service'), false);
    const cli = plan.at(-1)!;
    assert.equal(cli.binary, '/usr/sbin/runuser');
    assert.ok(cli.args?.includes(context.runtime.sourceDirectory + '/apps/cli/main.ts'));
    assert.deepEqual(cli.args?.slice(0, 4), ['-u', 'cocoproxy', '--', '/usr/bin/node']);
  }
  assert.throws(() => planSetupLifecycle({ action: 'resume-persistence', terminalPathVerified: true },
    { ...context, lifecycle: { enabled: false, paused: true } }), code('SETUP_LIFECYCLE_NOT_ENABLED'));
});

test('maintenance stop confirms router state before planning changes, pauses before stop and proves stop before old helper remove', () => {
  assert.throws(() => planSetupLifecycle({ action: 'stop-maintenance' }, context), code('SETUP_ROUTER_DISABLED_CONFIRMATION_REQUIRED'));
  const plan = planSetupLifecycle({ action: 'stop-maintenance', routerDisabled: true }, context);
  assert.deepEqual(plan.map(step => step.id), ['runtime-pause', 'stop-services', 'disable-services', 'verify-stopped', 'remove-owned-network']);
  const remove = plan.at(-1)!;
  assert.equal(remove.binary, '/usr/bin/python3');
  assert.deepEqual(remove.args, ['-I', context.runtime.sourceDirectory + '/apps/gateway/network.py', 'remove', '--settings', '/etc/cocoproxy/gateway-network.json']);
  for (const networkReceipt of ['absent', 'removed'] as const) {
    assert.equal(planSetupLifecycle({ action: 'stop-maintenance', routerDisabled: true }, { ...context, networkReceipt })
      .some(step => step.id === 'remove-owned-network'), false);
  }
});

test('initialization never overwrites an existing credential; manager-only start refuses an active unpaused reconciler', () => {
  assert.deepEqual(planSetupLifecycle({ action: 'initialize' }, context), []);
  assert.deepEqual(planSetupLifecycle({ action: 'initialize' }, { ...context, credentialExists: false }).map(step => step.kind), ['credential']);
  assert.throws(() => planSetupLifecycle({ action: 'start-management' },
    { ...context, lifecycle: { enabled: true, paused: false } }), code('SETUP_LIFECYCLE_PAUSE_REQUIRED'));
  assert.throws(() => planSetupLifecycle({ action: 'start-management' }, { ...context, credentialExists: false }), code('SETUP_ADMIN_INITIALIZATION_REQUIRED'));
});

test('interrupted steps keep durable intent and never run network removal after stopped-proof failure', async () => {
  const plan = planSetupLifecycle({ action: 'stop-maintenance', routerDisabled: true }, context);
  const events: string[] = [];
  const journal: { pending: string | null; completed: string[] } = { pending: null, completed: [] };
  await assert.rejects(executeSetupLifecycleSteps(plan, {
    before: async step => { journal.pending = step.id; events.push('intent:' + step.id); },
    execute: async step => { events.push('execute:' + step.id); if (step.kind === 'verify-stopped') throw new Error('synthetic busy PID'); },
    after: async step => { journal.completed.push(step.id); journal.pending = null; events.push('complete:' + step.id); },
  }), /synthetic busy PID/);
  assert.equal(journal.pending, 'verify-stopped');
  assert.deepEqual(journal.completed, ['runtime-pause', 'stop-services', 'disable-services']);
  assert.equal(events.some(event => event.endsWith('remove-owned-network')), false);
  for (const id of journal.completed) assert.ok(events.indexOf('intent:' + id) < events.indexOf('execute:' + id));
});

test('unsupported hosts cannot create lifecycle journals or credentials', { skip: process.platform === 'linux' }, async () => {
  await assert.rejects(runSetupLifecycle({ action: 'initialize', input: '/synthetic-missing-input', apply: true }), code('INSTALL_LINUX_ROOT_REQUIRED'));
});

test('unit preflight permits the two empty Job representations and rejects foreign fragments, pending jobs and overrides', () => {
  const unit = 'cocoproxy-management.service';
  const snapshot = 'LoadState=loaded\nFragmentPath=/etc/systemd/system/' + unit + '\nDropInPaths=\nNeedDaemonReload=no\nJob=\nActiveState=inactive\n';
  assertSetupLifecycleUnit(snapshot, unit);
  assertSetupLifecycleUnit(snapshot.replace('Job=\n', 'Job=0\n'), unit);
  for (const changed of [snapshot.replace('Job=\n', 'Job=123\n'), snapshot.replace('/etc/systemd/system/', '/usr/lib/systemd/system/'),
    snapshot.replace('DropInPaths=\n', 'DropInPaths=/etc/systemd/system/foreign.conf\n'), snapshot.replace('NeedDaemonReload=no', 'NeedDaemonReload=yes'),
    snapshot + 'Job=0\n']) assert.throws(() => assertSetupLifecycleUnit(changed, unit), code('SETUP_LIFECYCLE_UNIT_CONFLICT'));
});
