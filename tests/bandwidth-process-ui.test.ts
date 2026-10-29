import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { Script } from 'node:vm';
import ts from '../tooling/node_modules/typescript/lib/typescript.js';
import { uiTestContext } from './ui-i18n-helpers.ts';

class CoCoProxyError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.code = code; }
}

test('process viewer reads without triggering checks, keeps failed refreshes and rejects late or mismatched scope responses', async () => {
  const source = await readFile(new URL('../integrations/metacubexd/overlay/packages/ui/components/BandwidthDecisionProcess.vue', import.meta.url), 'utf8');
  const helpers: Record<string, any> = {};
  const helperSource = await readFile(new URL('../integrations/metacubexd/overlay/packages/ui/utils/bandwidth-process.ts', import.meta.url), 'utf8');
  new Script(ts.transpileModule(helperSource.replace(/^import .*$/gm, ''), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText).runInNewContext({ exports: helpers });
  const script = source.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)![1].replace(/^import .*$/gm, '') +
    '\nexport { open, close, refresh, choose, check, data, detail, error, delayed, selectedId, canCheck, loading, scroller };';
  const scope = JSON.stringify(['local', ['synthetic']]);
  const status = { scope, workspaceRevision: 7, groups: [{ name: 'Stream', current: 'node-a', bandwidth: { reason: 'waiting-traffic' } }] };
  let result: any = { since: 1000, error: false, evicted: false, rounds: [{ id: 'one' }], detail: null, status };
  let reply: (() => Promise<any>) | undefined, fail = false;
  let failure: Error = new Error('synthetic failure'), now = 1000;
  class Clock extends Date { static now() { return now; } }
  const calls: { path: string; options: any }[] = [];
  const view = { value: { workspace: { mode: 'local', sourceIds: ['synthetic'], revision: 7 }, active: 'generation', pending: false } };
  const overrides = { value: { automatic: { Stream: { enabled: true, bandwidth: { enabled: true } } } } };
  let scheduled!: () => void;
  const exports: Record<string, any> = {};
  new Script(ts.transpileModule(script, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText).runInNewContext({
    ...uiTestContext, exports, URLSearchParams, AbortController, processReason: helpers.processReason, processSampleLoss: helpers.processSampleLoss,
    ref: (value: unknown) => ({ value }), defineProps: () => ({ groupName: 'Stream', selectable: true }), withDefaults: (p: unknown) => p,
    defineExpose() {}, watch() {}, onMounted() {}, onUnmounted() {}, setTimeout: (callback: () => void) => { scheduled = callback; return 1; }, clearTimeout() {},
    document: { hidden: false }, Date: Clock, CoCoProxyError, cocoproxyErrorMessage: () => '读取失败',
    useWorkspace: () => ({ view, overrides, api: { request: async (path: string, options: any) => {
      calls.push({ path, options });
      if (fail) throw failure;
      return reply ? reply() : structuredClone(result);
    } } }),
  });
  exports.open(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 1); assert.equal(calls[0].options.method, undefined);
  assert.equal(new URL('https://management.example' + calls[0].path).searchParams.get('scope'), scope);
  assert.equal(exports.data.value.rounds[0].id, 'one');
  let complete!: (value: any) => void;
  reply = () => new Promise(resolve => { complete = resolve; });
  const displayed = exports.data.value;
  exports.scroller.value = { scrollTop: 240, scrollTo() { assert.fail('refresh must keep the reading position'); } };
  scheduled();
  const finishPoll = complete;
  assert.equal(exports.loading.value, false);
  assert.equal(exports.canCheck.value, true);
  const callCount = calls.length;
  await exports.refresh();
  assert.equal(calls.length, callCount); // Do not overlap background reads.
  finishPoll(structuredClone(result)); await new Promise(resolve => setImmediate(resolve));
  assert.equal(exports.data.value, displayed); // Unchanged replies keep the displayed objects.
  assert.equal(exports.scroller.value.scrollTop, 240);

  const background = exports.refresh();
  const backgroundSignal = calls.at(-1)!.options.signal;
  const finishBackground = complete;
  const manual = exports.refresh(false);
  assert.equal(backgroundSignal.aborted, true);
  assert.equal(exports.loading.value, true);
  assert.equal(exports.canCheck.value, false);
  finishBackground({ ...result, rounds: [{ id: 'stale' }] }); await background;
  assert.equal(exports.loading.value, true); // The older read cannot finish the manual refresh.
  complete(structuredClone(result)); await manual;
  assert.equal(exports.loading.value, false);
  assert.equal(exports.data.value, displayed);
  reply = undefined;
  fail = true; failure = new CoCoProxyError('STORE_LOCKED');
  await exports.refresh();
  assert.equal(exports.error.value, ''); assert.equal(exports.delayed.value, true);
  assert.equal(exports.data.value, displayed); assert.equal(exports.loading.value, false);
  now += 15000; await exports.refresh();
  assert.equal(exports.error.value, '读取失败'); assert.equal(exports.data.value, displayed);
  fail = false; await exports.refresh();
  assert.equal(exports.error.value, ''); assert.equal(exports.delayed.value, false);
  fail = true; await exports.refresh(false); assert.equal(exports.error.value, '读取失败');
  fail = false; await exports.refresh();
  failure = new Error('synthetic failure');
  fail = true; await exports.refresh(); assert.equal(exports.error.value, '读取失败'); assert.equal(exports.data.value.rounds[0].id, 'one');
  fail = false;
  reply = () => new Promise(resolve => { complete = resolve; });
  const pending = exports.refresh(); exports.close(); complete({ ...result, rounds: [{ id: 'late' }] }); await pending;
  assert.equal(exports.data.value.rounds[0].id, 'one');
  reply = undefined; result = { ...result, status: { ...status, scope: 'other-scheme' } };
  exports.open(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(exports.data.value, undefined); assert.ok(exports.error.value);
  result = { ...result, status }; await exports.refresh();
  reply = () => new Promise(resolve => { complete = resolve; });
  const beforeCheck = exports.refresh();
  const beforeCheckSignal = calls.at(-1)!.options.signal;
  const finishBeforeCheck = complete;
  reply = undefined;
  result = { ...result, rounds: [{ id: 'after-check' }] };
  await exports.check();
  assert.equal(beforeCheckSignal.aborted, true);
  finishBeforeCheck({ ...result, rounds: [{ id: 'before-check' }] }); await beforeCheck;
  assert.equal(exports.data.value.rounds[0].id, 'after-check');
  const writes = calls.filter(c => c.options.method === 'POST');
  assert.equal(writes.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(writes[0].options.body)), { expectedRevision: 7, expectedActive: 'generation', scope, group: 'Stream' });
  overrides.value.automatic.Stream.enabled = false;
  assert.equal(exports.canCheck.value, false);
  exports.close();
  fail = true; failure = new CoCoProxyError('STORE_LOCKED'); exports.open();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(exports.data.value, undefined); assert.equal(exports.error.value, '读取失败');
  exports.close();
});
