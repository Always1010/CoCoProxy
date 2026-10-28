import { uiTestContext, useI18n } from './ui-i18n-helpers.ts';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Script } from 'node:vm';
import test from 'node:test';
import ts from '../tooling/node_modules/typescript/lib/typescript.js';

const source = await readFile(new URL('../integrations/metacubexd/overlay/packages/ui/composables/useBandwidthTest.ts', import.meta.url), 'utf8');
const code = ts.transpileModule(source.replace(/^import .*$/gm, ''), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const empty = { limits: { durationMs: 6000, maxBytes: 200000000, timeoutMs: 30000 }, server: { name: 'Cloudflare', url: 'https://speed.cloudflare.com' }, task: null };

function harness(storage = new Map<string, string>()) {
  const calls: { path: string; options: any }[] = [];
  let result: any = empty;
  let runtime: any = { active: 'generation-two', core: { ready: true }, transaction: null, fault: null };
  let statusFailure = false;
  let failure = false;
  let readReply: (() => Promise<any>) | undefined;
  const exports: Record<string, any> = {};
  new Script(code).runInNewContext({ ...uiTestContext,
    exports, ref: (value: unknown) => ({ value }), computed: (get: () => unknown) => ({ get value() { return get(); } }),
    onMounted() {}, onUnmounted() {}, document: { hidden: false },
    setTimeout: () => 1, clearTimeout() {}, AbortSignal, AbortController,
    sessionStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) },
    crypto: { randomUUID: () => 'f63cb401-2645-42b9-b051-8235617d88bd' },
    CoCoProxyError: Error, cocoproxyErrorMessage: () => '读取失败',
    useWorkspace: () => ({ view: { value: { active: 'generation-one', pending: false } }, api: { request: async (path: string, options: any) => {
      calls.push({ path, options });
      if (path === '/api/cocoproxy/status') {
        if (statusFailure) throw new Error('synthetic runtime read failure');
        return structuredClone(runtime);
      }
      if (failure) throw new Error('synthetic connection loss');
      if (path === '/api/cocoproxy/bandwidth' && !options.method && readReply) return readReply();
      return structuredClone(result);
    } } }),
  });
  return { ui: exports.useBandwidthTest(), calls, storage, setResult(value: unknown) { result = value; }, fail(value: boolean) { failure = value; },
    setReadReply(value?: () => Promise<any>) { readReply = value; },
    setRuntime(value: unknown) { runtime = value; }, failStatus(value: boolean) { statusFailure = value; } };
}

test('bandwidth background reads leave cancellation available and late replies cannot release uncertain writes', async () => {
  const { ui, calls, storage, setResult, setReadReply, fail } = harness();
  const running = { ...empty, task: { id: 'test-one', node: 'node-b', running: true, owned: true, phase: 'download' } };
  setResult(running);
  await ui.restore(); ui.shown(); await new Promise(resolve => setImmediate(resolve));
  let complete!: (value: unknown) => void;
  setReadReply(() => new Promise(resolve => { complete = resolve; }));
  const background = ui.refresh();
  const signal = calls.at(-1)!.options.signal;
  assert.equal(ui.loading.value, false);
  assert.equal(ui.sending.value, false);
  setResult({ ...running, task: { ...running.task, phase: 'cancelling' } });
  await ui.cancel();
  assert.equal(signal.aborted, true);
  assert.equal(ui.task.value.phase, 'cancelling');
  complete(running); await background;
  assert.equal(ui.task.value.phase, 'cancelling');
  assert.equal(ui.error.value, '');

  setReadReply(); setResult(running); await ui.refresh(true);
  setReadReply(() => new Promise(resolve => { complete = resolve; }));
  const beforeLostWrite = ui.refresh();
  fail(true); await ui.cancel();
  assert.equal(ui.uncertain.value, true);
  complete(running); await beforeLostWrite;
  assert.equal(ui.uncertain.value, true); // An old successful GET cannot confirm a later lost POST.
  assert.equal(ui.locked.value, true);
  assert.equal(storage.get('cocoproxy-bandwidth-pending'), '1');
  assert.equal(calls.filter(call => call.options.method === 'POST').length, 2);
  fail(false); setReadReply(); setResult({ ...running, task: { ...running.task, running: false, phase: 'cancelled' } });
  await ui.refresh(true);
  assert.equal(ui.uncertain.value, false);
  assert.equal(ui.locked.value, false);
  assert.equal(storage.has('cocoproxy-bandwidth-pending'), false);
  assert.equal(calls.filter(call => call.options.method === 'POST').length, 2);
});

test('bandwidth starts against fresh runtime generation and unknown writes stay locked without replaying', async () => {
  const { ui, calls, fail, storage } = harness();
  assert.equal(await ui.restore(), false);
  ui.shown();
  await new Promise(resolve => setImmediate(resolve));
  fail(true);
  await ui.start('node-b');
  assert.equal(ui.locked.value, true);
  assert.equal(ui.uncertain.value, true);
  assert.equal(ui.canStart.value, false);
  assert.equal(storage.get('cocoproxy-bandwidth-pending'), '1');
  assert.equal(calls.filter(call => call.options.method === 'POST').length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(calls.find(call => call.options.method === 'POST')!.options.body)), { node: 'node-b', expectedActive: 'generation-two' });
  const observed = calls.findIndex(call => call.path === '/api/cocoproxy/status');
  assert.ok(observed >= 0 && observed < calls.findIndex(call => call.options.method === 'POST'));
  fail(false);
  await ui.refresh(true);
  assert.equal(ui.locked.value, false);
  assert.equal(ui.uncertain.value, false);
  assert.equal(storage.has('cocoproxy-bandwidth-pending'), false);
  assert.equal(calls.filter(call => call.options.method === 'POST').length, 1);
  assert.ok(calls.every(call => call.options.headers['X-CoCoProxy-Bandwidth-Client'] === storage.get('cocoproxy-bandwidth-client')));
});

test('bandwidth never starts a transfer when fresh runtime status fails, is unready, or is changing', async () => {
  const { ui, calls, failStatus, setRuntime, storage } = harness();
  await ui.restore(); ui.shown(); await new Promise(resolve => setImmediate(resolve));
  failStatus(true); await ui.start('node-b');
  assert.equal(ui.locked.value, false); assert.equal(ui.uncertain.value, false);
  failStatus(false);
  for (const runtime of [
    { active: 'generation-two', core: { ready: false } },
    { active: 'generation-two', core: { ready: true }, transaction: { phase: 'activating' } },
    { active: 'generation-two', core: { ready: true }, fault: 'recovery-required' },
  ]) { setRuntime(runtime); await ui.start('node-b'); }
  assert.equal(calls.filter(call => call.options.method === 'POST').length, 0);
  assert.equal(storage.has('cocoproxy-bandwidth-pending'), false);
  assert.equal(ui.locked.value, false);
});

test('bandwidth ownership restores the initiating browser and leaves observers read only', async () => {
  const storage = new Map([['cocoproxy-bandwidth-client', 'f63cb401-2645-42b9-b051-8235617d88bd']]);
  const owner = harness(storage);
  owner.setResult({ ...empty, task: { id: 'test-one', node: 'node-b', running: true, owned: true, phase: 'download' } });
  assert.equal(await owner.ui.restore(), true);
  assert.equal(owner.ui.locked.value, true);
  assert.equal(storage.get('cocoproxy-bandwidth-pending'), '1');
  const reloaded = harness(storage);
  reloaded.fail(true);
  assert.equal(await reloaded.ui.restore(), true);
  assert.equal(reloaded.ui.uncertain.value, true);
  assert.equal(reloaded.ui.locked.value, true);
  const observer = harness();
  observer.setResult({ ...empty, task: { id: 'test-one', node: 'node-b', running: true, owned: false, phase: 'download' } });
  assert.equal(await observer.ui.restore(), false);
  assert.equal(observer.ui.locked.value, false);
  assert.equal(observer.ui.canStart.value, false);
  await observer.ui.cancel();
  await observer.ui.start('node-c');
  assert.equal(observer.calls.filter(call => call.options.method === 'POST').length, 0);
});
