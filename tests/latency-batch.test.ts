import assert from 'node:assert/strict';
import test from 'node:test';
import { latencyProbeKey, runLatencyBatch } from '../integrations/metacubexd/overlay/packages/ui/utils/latencyBatch.ts';

test('HTTPS batches reuse shared node identities only within the same generation and URL', async () => {
  const key = (generation = 'generation-one', identity = 'node-one', url = 'https://probe.example/one') =>
    latencyProbeKey(generation, identity, 'node', url, 3000);
  const keys = [key(), key(), key(), key('generation-one', 'node-one', 'https://probe.example/two'),
    key('generation-two'), key('generation-one', 'node-edited')];
  const calls: string[] = [];
  await runLatencyBatch(keys.map(key => ({ key })), new AbortController().signal, async job => { calls.push(job.key); });
  assert.deepEqual(calls, [...new Set(keys)]);
  assert.equal(calls.length, 4);
});

test('HTTPS workers replenish a freed slot while a slow node remains and cancel queued work', async () => {
  const controller = new AbortController();
  let live = 0;
  let maximum = 0;
  const pending: { key: string; finish: () => void }[] = [];
  const run = runLatencyBatch(Array.from({ length: 25 }, (_, i) => ({ key: `node-${i}` })), controller.signal,
    job => new Promise<void>(resolve => {
      live++;
      maximum = Math.max(maximum, live);
      const finish = () => { controller.signal.removeEventListener('abort', finish); live--; resolve(); };
      controller.signal.addEventListener('abort', finish, { once: true });
      pending.push({ key: job.key, finish });
    }));
  assert.equal(pending.length, 10);
  pending[1]!.finish();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(pending.length, 11);
  assert.equal(pending[0]!.key, 'node-0');
  assert.equal(live, 10);
  controller.abort();
  await run;
  assert.equal(pending.length, 11);
  assert.equal(live, 0);
  assert.equal(maximum, 10);
});

test('HTTPS generation invalidation prevents queued work from using a previous snapshot', async () => {
  let current = true;
  let calls = 0;
  await runLatencyBatch(Array.from({ length: 20 }, (_, i) => ({ key: String(i) })), new AbortController().signal,
    async () => { calls++; current = false; }, () => current);
  assert.equal(calls, 1);
});
