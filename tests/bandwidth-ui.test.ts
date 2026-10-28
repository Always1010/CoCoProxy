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
  let failure = false;
  const exports: Record<string, any> = {};
  new Script(code).runInNewContext({
    exports, ref: (value: unknown) => ({ value }), computed: (get: () => unknown) => ({ get value() { return get(); } }),
    onMounted() {}, onUnmounted() {}, document: { hidden: false },
    setTimeout: () => 1, clearTimeout() {}, AbortSignal,
    sessionStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) },
    crypto: { randomUUID: () => 'f63cb401-2645-42b9-b051-8235617d88bd' },
    CoCoProxyError: Error, cocoproxyErrorMessage: () => '读取失败',
    useWorkspace: () => ({ view: { value: { active: 'generation-one', pending: false } }, api: { request: async (path: string, options: any) => {
      calls.push({ path, options });
      if (failure) throw new Error('synthetic connection loss');
      return structuredClone(result);
    } } }),
  });
  return { ui: exports.useBandwidthTest(), calls, storage, setResult(value: unknown) { result = value; }, fail(value: boolean) { failure = value; } };
}

test('bandwidth unknown writes stay locked until status is confirmed without replaying the write', async () => {
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
  assert.deepEqual(JSON.parse(JSON.stringify(calls.find(call => call.options.method === 'POST')!.options.body)), { node: 'node-b', expectedActive: 'generation-one' });
  fail(false);
  await ui.refresh(true);
  assert.equal(ui.locked.value, false);
  assert.equal(ui.uncertain.value, false);
  assert.equal(storage.has('cocoproxy-bandwidth-pending'), false);
  assert.equal(calls.filter(call => call.options.method === 'POST').length, 1);
  assert.ok(calls.every(call => call.options.headers['X-CoCoProxy-Bandwidth-Client'] === storage.get('cocoproxy-bandwidth-client')));
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
