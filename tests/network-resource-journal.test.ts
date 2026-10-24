import assert from 'node:assert/strict';
import { chmod, link, lstat, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { renderNetworkPlan, type NetworkPlanInput } from '../packages/network/plan.ts';
import { ResourceJournal, ResourceJournalError, type NativeResourceReceipt } from '../packages/network/resource-journal.ts';

function receipt(): NativeResourceReceipt {
  const deployment: NetworkPlanInput = { schemaVersion: 1, generation: 'a'.repeat(64),
    core: { serviceUid: 12345, binarySha256: 'b'.repeat(64), unitSha256: 'c'.repeat(64) },
    ingressInterface: 'lan-test', gatewayIPv4: '192.0.2.2', prefixLength: 24,
    routerIPv4: '192.0.2.1', routerMAC: '02:00:00:00:00:01', clientIPv4: '192.0.2.3', dnsPort: 15353,
    tun: { interface: 'coproxy-tun', mtu: 1500 },
    marks: { mask: 0xff00, capture: 0x100, egress: 0x200, return: 0x300 },
    tables: { capture: 10003, egress: 10002, return: 10001 },
    priorities: { capture: 10003, egress: 10002, return: 10001 } };
  return { schemaVersion: 1, revision: 0, scope: 'fixture',
    context: { bootID: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', userNS: 'user:[1234]', netNS: 'net:[1235]',
      ip: { path: '/usr/sbin/ip', sha256: 'd'.repeat(64) }, nft: { path: '/usr/sbin/nft', sha256: 'e'.repeat(64) },
      rendererSHA: 'f'.repeat(64), planSHA: renderNetworkPlan(deployment).sha256 },
    state: { expectedNft: '{"nftables":[]}', ruleIds: [], routeIds: [], mode: null, prepared: false, capture: false },
    pending: null, deployment };
}
function code(expected: string) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof ResourceJournalError);
    assert.equal(error.code, expected);
    assert.equal(error.message, expected);
    assert.equal(Object.hasOwn(error, 'cause'), false);
    assert.equal(String(error).includes('synthetic-private-value'), false);
    return true;
  };
}
async function fixture(t: test.TestContext) {
  const parent = await mkdtemp(join(tmpdir(), 'coproxy-network-resource-'));
  await chmod(parent, 0o700);
  const root = join(parent, 'resource'), file = join(root, 'native-resource-receipt.json');
  const journal = new ResourceJournal(root, 'fixture');
  t.after(async () => {
    await chmod(parent, 0o700);
    await chmod(root, 0o700).catch(() => {});
    await rm(parent, { recursive: true, force: true });
  });
  return { parent, root, file, journal, save: (value = receipt()) => journal.exclusive(() => journal.write(value)) };
}

test('resource receipt reads never initialize storage; writes require the authority lock', async t => {
  const f = await fixture(t);
  assert.equal(await f.journal.read(), null);
  await assert.rejects(lstat(f.root), { code: 'ENOENT' });
  await assert.rejects(f.journal.write(receipt()), code('NETWORK_RESOURCE_STORE_IO'));
  await assert.rejects(lstat(f.root), { code: 'ENOENT' });
  assert.equal(await f.journal.exclusive(() => f.journal.read()), null);
  await assert.rejects(lstat(f.file), { code: 'ENOENT' });
  if (process.platform !== 'win32') {
    assert.equal((await lstat(f.root)).mode & 0o777, 0o700);
    assert.equal((await lstat(join(f.root, 'candidates'))).mode & 0o777, 0o700);
  }
});

test('resource receipt revisions return detached frozen snapshots and persist the old state with pending', async t => {
  const f = await fixture(t), original = receipt();
  original.state.ruleIds = [10003];
  original.state.routeIds = ['blackhole:capture'];
  original.state.mode = 'blocked';
  original.pending = { token: '12345678-abcd-abcd-abcd-123456789abc', commandSHA: '1'.repeat(64),
    operation: { kind: 'ip', category: 'egress', index: 3 } };
  const one = await f.save(original);
  assert.equal(original.revision, 0);
  assert.equal(one.revision, 1);
  original.state.ruleIds.push(10002);
  original.context.ip.sha256 = '2'.repeat(64);
  assert.deepEqual(one.state.ruleIds, [10003]);
  assert.equal(one.context.ip.sha256, 'd'.repeat(64));
  const loaded = await f.journal.read();
  assert.deepEqual(loaded, one);
  for (const value of [loaded, loaded!.state, loaded!.state.ruleIds, loaded!.pending, loaded!.pending!.operation,
    loaded!.context.ip, loaded!.deployment.core]) assert.ok(Object.isFrozen(value));
  assert.throws(() => loaded!.state.routeIds.push('capture'), TypeError);
  const two = await f.save({ ...one, pending: null });
  assert.equal(two.revision, 2);
  assert.equal(one.revision, 1);
  assert.equal((await f.journal.read())!.pending, null);
  if (process.platform !== 'win32') assert.equal((await lstat(f.file)).mode & 0o777, 0o600);
});

test('invalid receipt writes and hostile objects cannot overwrite the durable ownership record', async t => {
  const f = await fixture(t), saved = await f.save(), before = await readFile(f.file, 'utf8');
  const invalid: ((value: NativeResourceReceipt) => unknown)[] = [
    value => ({ ...value, extra: 'synthetic-private-value' }),
    value => ({ ...value, scope: 'production' }),
    value => ({ ...value, context: { ...value.context, planSHA: '0'.repeat(64) } }),
    value => ({ ...value, context: { ...value.context, ip: { path: '/tmp/ip', sha256: 'd'.repeat(64) } } }),
    value => ({ ...value, state: { ...value.state, ruleIds: [10003, 10003] } }),
    value => ({ ...value, state: { ...value.state, routeIds: ['egress:4'] } }),
    value => ({ ...value, state: { ...value.state, routeIds: ['capture'], capture: false } }),
    value => ({ ...value, state: { ...value.state, mode: 'active' } }),
    value => ({ ...value, state: { ...value.state, prepared: true } }),
    value => ({ ...value, state: { ...value.state, expectedNft: '{"nftables":[],"nftables":[]}' } }),
    value => ({ ...value, pending: { token: '12345678-abcd-abcd-abcd-123456789abc', commandSHA: '1'.repeat(64),
      operation: { kind: 'ip', category: 'capture-add', index: 1 } } }),
    value => ({ ...value, pending: { token: '12345678-abcd-abcd-abcd-123456789abc', commandSHA: '1'.repeat(64),
      operation: { kind: 'nft', mode: 'active', operation: 'replace', reset: true } } }),
  ];
  for (const change of invalid) {
    await assert.rejects(f.save(change(saved) as NativeResourceReceipt), code('NETWORK_RESOURCE_STORE_IO'));
    assert.equal(await readFile(f.file, 'utf8'), before);
  }
  let invoked = false;
  const accessor = { ...saved };
  Object.defineProperty(accessor, 'state', { enumerable: true, get() { invoked = true; throw new Error('synthetic-private-value'); } });
  const proxy = new Proxy(saved, { ownKeys() { invoked = true; throw new Error('synthetic-private-value'); } });
  for (const value of [accessor, proxy]) await assert.rejects(f.save(value), code('NETWORK_RESOURCE_STORE_IO'));
  assert.equal(invoked, false);
  assert.equal(await readFile(f.file, 'utf8'), before);
});

test('durable receipt parsing rejects duplicate keys, wrong scope, malformed and excessive JSON', async t => {
  const f = await fixture(t), saved = await f.save(), raw = JSON.stringify(saved);
  const corrupt = [
    raw.replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1'),
    raw.replace('"context":{', '"context":{"bootID":"synthetic-private-value",'),
    JSON.stringify({ ...saved, scope: 'production' }),
    JSON.stringify({ ...saved, revision: 0 }),
    JSON.stringify({ ...saved, context: { ...saved.context, netNS: 'net:[0]' } }),
    JSON.stringify({ ...saved, state: { ...saved.state, expectedNft: '{"nftables":[' + '['.repeat(34) + '0' + ']'.repeat(34) + ']}' } }),
    '{"synthetic-private-value":',
    ' '.repeat(2_097_153),
  ];
  for (const text of corrupt) {
    await writeFile(f.file, text, { mode: 0o600 });
    await assert.rejects(f.journal.read(), code('NETWORK_RESOURCE_STORE_CORRUPT'));
    await assert.rejects(f.save(saved), code('NETWORK_RESOURCE_STORE_IO'));
    assert.equal(await readFile(f.file, 'utf8'), text, 'a corrupt receipt is never silently replaced');
  }
});

test('hard-linked resource receipts cannot be read or replaced through the journal', async t => {
  const f = await fixture(t), saved = await f.save(), alias = join(f.parent, 'alias');
  const before = await readFile(f.file, 'utf8');
  await link(f.file, alias);
  assert.equal((await lstat(f.file)).nlink, 2);
  await assert.rejects(f.journal.read(), code('NETWORK_RESOURCE_STORE_UNSAFE'));
  await assert.rejects(f.save(saved), code('NETWORK_RESOURCE_STORE_IO'));
  assert.equal(await readFile(alias, 'utf8'), before);
  await unlink(alias);
  assert.deepEqual(await f.journal.read(), saved);
});

test('resource root and ancestor directory links are rejected without following their targets', async t => {
  const f = await fixture(t), saved = await f.save(), before = await readFile(f.file, 'utf8');
  const alias = join(f.parent, 'linked-root');
  await symlink(f.root, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const linked = new ResourceJournal(alias, 'fixture');
  await assert.rejects(linked.read(), code('NETWORK_RESOURCE_STORE_UNSAFE'));
  await assert.rejects(linked.exclusive(async () => {}), code('NETWORK_RESOURCE_STORE_UNSAFE'));
  const descendant = new ResourceJournal(join(alias, 'uncreated'), 'fixture');
  await assert.rejects(descendant.read(), code('NETWORK_RESOURCE_STORE_UNSAFE'));
  await assert.rejects(descendant.exclusive(async () => {}), code('NETWORK_RESOURCE_STORE_UNSAFE'));
  await assert.rejects(lstat(join(f.root, 'uncreated')), { code: 'ENOENT' });
  assert.equal(await readFile(f.file, 'utf8'), before);
  assert.deepEqual(await f.journal.read(), saved);
});

test('POSIX resource receipt symlinks preserve the external target', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t), saved = await f.save(), target = join(f.parent, 'target');
  const before = await readFile(f.file, 'utf8');
  await writeFile(target, before, { mode: 0o600 });
  await unlink(f.file);
  await symlink(target, f.file);
  await assert.rejects(f.journal.read(), code('NETWORK_RESOURCE_STORE_UNSAFE'));
  await assert.rejects(f.save(saved), code('NETWORK_RESOURCE_STORE_IO'));
  assert.equal(await readFile(target, 'utf8'), before);
});

test('POSIX broad resource directories and files are refused without permission repair', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t), saved = await f.save();
  await chmod(f.root, 0o755);
  await assert.rejects(f.journal.read(), code('NETWORK_RESOURCE_STORE_UNSAFE'));
  await assert.rejects(f.journal.exclusive(async () => {}), code('NETWORK_RESOURCE_STORE_UNSAFE'));
  assert.equal((await lstat(f.root)).mode & 0o777, 0o755);
  await chmod(f.root, 0o700);
  await chmod(f.parent, 0o777);
  await assert.rejects(f.journal.read(), code('NETWORK_RESOURCE_STORE_UNSAFE'));
  await assert.rejects(f.journal.exclusive(async () => {}), code('NETWORK_RESOURCE_STORE_UNSAFE'));
  assert.equal((await lstat(f.parent)).mode & 0o777, 0o777);
  await chmod(f.parent, 0o700);
  await chmod(f.file, 0o644);
  await assert.rejects(f.journal.read(), code('NETWORK_RESOURCE_STORE_CORRUPT'));
  await assert.rejects(f.save(saved), code('NETWORK_RESOURCE_STORE_IO'));
  assert.equal((await lstat(f.file)).mode & 0o777, 0o644);
  await chmod(f.file, 0o600);
  assert.deepEqual(await f.journal.read(), saved);
});

test('resource journal lock preserves domain errors, rejects nesting and serializes separate instances', async t => {
  const f = await fixture(t), domain = new Error('synthetic-private-value');
  await assert.rejects(f.journal.exclusive(async () => { throw domain; }), error => error === domain);
  await f.journal.exclusive(async () => {
    await assert.rejects(f.journal.exclusive(async () => {}), code('NETWORK_RESOURCE_BUSY'));
  });
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const holder = f.journal.exclusive(async () => { entered(); await held; });
  await started;
  let invoked = false;
  try {
    await assert.rejects(new ResourceJournal(f.root, 'fixture').exclusive(async () => { invoked = true; }), code('NETWORK_RESOURCE_BUSY'));
    assert.equal(invoked, false);
  } finally { release(); await holder; }
  assert.equal(await f.journal.exclusive(async () => 'released'), 'released');
  await assert.rejects(lstat(join(f.root, '.lock')), { code: 'ENOENT' });
});
