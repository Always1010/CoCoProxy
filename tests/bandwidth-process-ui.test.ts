import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { Script } from 'node:vm';
import ts from '../tooling/node_modules/typescript/lib/typescript.js';
import { uiTestContext } from './ui-i18n-helpers.ts';

test('process viewer reads without triggering checks, keeps failed refreshes and rejects late or mismatched scope responses', async () => {
  const source = await readFile(new URL('../integrations/metacubexd/overlay/packages/ui/components/BandwidthDecisionProcess.vue', import.meta.url), 'utf8');
  const helpers: Record<string, any> = {};
  const helperSource = await readFile(new URL('../integrations/metacubexd/overlay/packages/ui/utils/bandwidth-process.ts', import.meta.url), 'utf8');
  new Script(ts.transpileModule(helperSource.replace(/^import .*$/gm, ''), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText).runInNewContext({ exports: helpers });
  const script = source.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)![1].replace(/^import .*$/gm, '') +
    '\nexport { open, close, refresh, choose, check, data, detail, error, selectedId, canCheck };';
  const scope = JSON.stringify(['local', ['synthetic']]);
  const status = { scope, workspaceRevision: 7, groups: [{ name: 'Stream', current: 'node-a', bandwidth: { reason: 'waiting-traffic' } }] };
  let result: any = { since: 1000, error: false, evicted: false, rounds: [{ id: 'one' }], detail: null, status };
  let reply: (() => Promise<any>) | undefined, fail = false;
  const calls: { path: string; options: any }[] = [];
  const view = { value: { workspace: { mode: 'local', sourceIds: ['synthetic'], revision: 7 }, active: 'generation', pending: false } };
  const overrides = { value: { automatic: { Stream: { enabled: true, bandwidth: { enabled: true } } } } };
  const exports: Record<string, any> = {};
  new Script(ts.transpileModule(script, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText).runInNewContext({
    ...uiTestContext, exports, URLSearchParams, AbortController, processReason: helpers.processReason, processSampleLoss: helpers.processSampleLoss,
    ref: (value: unknown) => ({ value }), defineProps: () => ({ groupName: 'Stream', selectable: true }), withDefaults: (p: unknown) => p,
    defineExpose() {}, watch() {}, onMounted() {}, onUnmounted() {}, setTimeout: () => 0, clearTimeout() {},
    document: { hidden: false }, cocoproxyErrorMessage: () => '读取失败',
    useWorkspace: () => ({ view, overrides, api: { request: async (path: string, options: any) => {
      calls.push({ path, options });
      if (fail) throw new Error('synthetic failure');
      return reply ? reply() : structuredClone(result);
    } } }),
  });
  exports.open(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 1); assert.equal(calls[0].options.method, undefined);
  assert.equal(new URL('https://management.example' + calls[0].path).searchParams.get('scope'), scope);
  assert.equal(exports.data.value.rounds[0].id, 'one');
  fail = true; await exports.refresh(); assert.equal(exports.error.value, '读取失败'); assert.equal(exports.data.value.rounds[0].id, 'one');
  fail = false; let complete!: (value: any) => void;
  reply = () => new Promise(resolve => { complete = resolve; });
  const pending = exports.refresh(); exports.close(); complete({ ...result, rounds: [{ id: 'late' }] }); await pending;
  assert.equal(exports.data.value.rounds[0].id, 'one');
  reply = undefined; result = { ...result, status: { ...status, scope: 'other-scheme' } };
  exports.open(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(exports.data.value, undefined); assert.ok(exports.error.value);
  result = { ...result, status }; await exports.refresh();
  await exports.check();
  const writes = calls.filter(c => c.options.method === 'POST');
  assert.equal(writes.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(writes[0].options.body)), { expectedRevision: 7, expectedActive: 'generation', scope, group: 'Stream' });
  overrides.value.automatic.Stream.enabled = false;
  assert.equal(exports.canCheck.value, false);
  exports.close();
});
