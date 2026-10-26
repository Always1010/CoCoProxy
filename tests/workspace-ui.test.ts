import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Script } from 'node:vm';
import test from 'node:test';
import ts from '../tooling/node_modules/typescript/lib/typescript.js';

const source = await readFile(new URL('../integrations/metacubexd/overlay/packages/ui/composables/useWorkspace.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;

test('subscription editor loads existing fields and current revision, preserves URLs on save and clears on close', async () => {
  const component = await readFile(new URL('../integrations/metacubexd/overlay/packages/ui/pages/subscriptions.vue', import.meta.url), 'utf8');
  const script = component.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)![1]
    .replace(/^import .*$/gm, '') + '\nexport { openEditor, closeEditor, submit, editorOpen, editing, name, url };';
  const code = ts.transpileModule(script, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const source = { id: 'sample', name: '原订阅', host: 'subscription.example', revision: 7, url: 'https://subscription.example/feed?token=synthetic-token' };
  let failRead = false;
  let onRead: (() => void) | undefined;
  let onLeave: (() => void) | undefined;
  let saved: any;
  const error = { value: '' };
  const exports: Record<string, any> = {};
  new Script(code, { filename: 'subscriptions.js' }).runInNewContext({
    exports, useHead: () => {}, ref: (value: unknown) => ({ value }), onMounted: () => {},
    onUnmounted: (fn: () => void) => { onLeave = fn; },
    useWorkspace: () => ({
      api: { request: async (_path: string, options?: { body?: unknown }) => {
        if (options) { saved = options.body; return; }
        if (failRead) throw new Error('读取失败');
        onRead?.();
        return { source: { ...source } };
      } }, view: { value: { sources: [] } }, workspace: { value: { mode: 'local', sourceIds: [] } }, error,
      run: async (fn: () => Promise<void>) => { error.value = ''; try { await fn(); } catch (cause) { error.value = String(cause); } },
      load: async () => {},
    }),
  });
  await exports.openEditor({ id: 'sample', revision: 1 });
  assert.equal(exports.editorOpen.value, true);
  assert.equal(exports.name.value, source.name);
  assert.equal(exports.url.value, source.url);
  assert.equal(exports.editing.value.revision, 7);
  assert.equal(exports.editing.value.url, undefined);
  exports.name.value = '重命名';
  await exports.submit();
  assert.equal(saved.expectedRevision, 7);
  assert.equal(saved.name, '重命名');
  assert.equal(saved.url, source.url);
  assert.equal(exports.editorOpen.value, false);
  assert.equal(exports.url.value, '');
  source.name = '';
  await exports.openEditor(source);
  assert.equal(exports.name.value, source.host);
  exports.url.value = 'https://replacement.example/feed';
  await exports.submit();
  assert.equal(saved.url, 'https://replacement.example/feed');
  await exports.openEditor(source);
  exports.closeEditor();
  assert.equal(exports.url.value, '');
  assert.equal(exports.editing.value, null);
  await exports.openEditor();
  assert.equal(exports.name.value, '');
  assert.equal(exports.url.value, '');
  failRead = true;
  await exports.openEditor(source);
  assert.equal(exports.editorOpen.value, false);
  assert.match(error.value, /读取失败/);
  failRead = false;
  onRead = () => onLeave!();
  await exports.openEditor(source);
  assert.equal(exports.editorOpen.value, false);
  assert.equal(exports.url.value, '');
});

for (const mode of ['local', 'subscription', 'legacy'] as const) {
  test(`manual takeover of the current node disables only the selected group's automatic policy (${mode})`, async () => {
    const automatic = {
      Stream: { preferred: ['node-a'], fallback: ['node-b'], returnToPreferred: true },
      Work: { preferred: ['node-c'], fallback: ['node-d'], returnToPreferred: false },
    };
    const scoped = { selections: { Stream: 'node-a', Work: 'node-c' }, rules: [], automatic };
    let settings = {
      mode, subscriptionId: mode === 'subscription' ? 'sample' : null, sourceIds: [], runMode: 'rule', revision: 7,
      local: structuredClone(scoped), subscriptionOverrides: { sample: structuredClone(scoped), legacy: structuredClone(scoped) },
    };
    let active = 'before';
    const states = new Map<string, { value: unknown }>([['cocoproxy-workspace', { value: { workspace: settings, active, pending: false } }]]);
    const calls: string[] = [];
    const api = {
      generation: { value: null },
      async request(path: string, options?: { body?: { expectedRevision?: number; expectedActive?: string; settings?: typeof settings } }) {
        calls.push(path);
        if (path === '/api/cocoproxy/workspace' && options?.body?.settings) {
          assert.equal(options.body.expectedRevision, 7);
          settings = { ...structuredClone(options.body.settings), revision: 8 };
          return { workspace: structuredClone(settings) };
        }
        if (path === '/api/cocoproxy/workspace/apply') {
          assert.equal(options?.body?.expectedRevision, 8);
          assert.equal(options?.body?.expectedActive, 'before');
          active = 'after';
          return { active };
        }
        if (path === '/api/cocoproxy/workspace') return { workspace: settings, active, pending: false };
        if (path === '/api/clash/proxies') return { proxies: { Stream: { now: 'node-a' } } };
        throw new Error(`Unexpected request: ${path}`);
      },
    };
    class CoCoProxyError extends Error {}
    const exports: { useWorkspace?: () => { select: (group: string, node: string) => Promise<void> } } = {};
    new Script(compiled, { filename: 'useWorkspace.js' }).runInNewContext({
      exports,
      require: (name: string) => {
        assert.equal(name, './useCoCoProxy');
        return { CoCoProxyError, cocoproxyErrorMessage: (error: Error) => error.message, useCoCoProxy: () => api };
      },
      useState: (key: string, initial: () => unknown) => {
        if (!states.has(key)) states.set(key, { value: initial() });
        return states.get(key);
      },
      computed: (get: () => unknown) => ({ get value() { return get(); } }),
    });

    await exports.useWorkspace!().select('Stream', 'node-a');

    const target = mode === 'local' ? settings.local : settings.subscriptionOverrides[mode === 'legacy' ? 'legacy' : 'sample'];
    assert.equal(target.selections.Stream, 'node-a');
    assert.deepEqual(target.automatic.Stream, { ...automatic.Stream, enabled: false });
    assert.deepEqual(target.automatic.Work, automatic.Work);
    const untouched = mode === 'local' ? settings.subscriptionOverrides.sample : settings.local;
    assert.deepEqual(untouched.automatic, automatic);
    assert.deepEqual(calls, ['/api/cocoproxy/workspace', '/api/cocoproxy/workspace/apply', '/api/cocoproxy/workspace', '/api/clash/proxies']);
    assert.match(String(states.get('cocoproxy-workspace-feedback')?.value), /已切换/);
  });
}

test('automatic settings off/save/reopen/on retains ordered pools and return preference', async () => {
  const component = await readFile(new URL('../integrations/metacubexd/overlay/packages/ui/components/AutomaticSelectionSettings.vue', import.meta.url), 'utf8');
  const script = component.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)![1]
    .replace(/^import .*$/gm, '') + '\nexport { open, persist, enabled, preferred, fallback, returnToPreferred };';
  const code = ts.transpileModule(script, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const original = { preferred: ['second', 'first'], fallback: ['backup'], returnToPreferred: false };
  const settings = { local: { selections: {}, automatic: { Stream: structuredClone(original) } } };
  const view = { value: { nodes: ['first', 'second', 'backup'], groups: [{ name: 'Stream', options: ['first', 'second', 'backup'], activeSelected: 'backup' }] } };
  const exports: Record<string, any> = {};
  new Script(code, { filename: 'AutomaticSelectionSettings.js' }).runInNewContext({
    exports, defineProps: () => ({ groupName: 'Stream', selectable: true }),
    ref: (value: unknown) => ({ value }), computed: (get: () => unknown) => ({ get value() { return get(); } }),
    watch: () => {}, onUnmounted: () => {}, document: { hidden: true }, setTimeout: () => 0, clearTimeout: () => {},
    useProxyRefresh: () => ({ refresh: async () => {} }),
    useWorkspace: () => ({ view, overrides: { value: settings.local }, busy: { value: false }, error: { value: '' },
      run: async (fn: () => Promise<void>) => fn(), save: async (edit: (value: unknown) => void) => edit(settings),
      editOverrides: () => settings.local }),
  });
  exports.open();
  assert.equal(exports.enabled.value, true); // Existing policy without enabled stays active.
  exports.enabled.value = false;
  await exports.persist();
  assert.deepEqual(JSON.parse(JSON.stringify(settings.local.automatic.Stream)), { ...original, enabled: false });
  exports.open();
  assert.equal(exports.enabled.value, false);
  assert.deepEqual(Array.from(exports.preferred.value), original.preferred);
  assert.deepEqual(Array.from(exports.fallback.value), original.fallback);
  assert.equal(exports.returnToPreferred.value, false);
  exports.enabled.value = true;
  await exports.persist();
  assert.deepEqual(JSON.parse(JSON.stringify(settings.local.automatic.Stream)), { ...original, enabled: true });
});
