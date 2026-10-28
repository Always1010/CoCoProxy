import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Script } from 'node:vm';
import test from 'node:test';
import ts from '../tooling/node_modules/typescript/lib/typescript.js';
import { localGroupNameError } from '../integrations/metacubexd/overlay/packages/ui/utils/group-rules.ts';

const apiExports: Record<string, any> = {};
new Script(ts.transpileModule(await readFile(new URL('../integrations/metacubexd/overlay/packages/ui/composables/useCoCoProxy.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText).runInNewContext({ exports: apiExports, Error });
const { CoCoProxyError, cocoproxyErrorMessage } = apiExports;

const source = await readFile(new URL('../integrations/metacubexd/overlay/packages/ui/composables/useWorkspace.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;

test('automatic history keeps reading position, preserves failed refreshes and clears only the displayed group', async () => {
  const component = await readFile(new URL('../integrations/metacubexd/overlay/packages/ui/components/AutomaticSelectionHistory.vue', import.meta.url), 'utf8');
  const script = component.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)![1].replace(/^import .*$/gm, '') +
    '\nexport { open, close, readStatus, clearHistory, onScroll, showLatest, scroller, displayed, newCount, error, confirmClear, available };';
  const code = ts.transpileModule(script, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const scope = JSON.stringify(['local', ['sample']]);
  const event = (id: string, group = 'Stream') => ({ id, group, at: 1000, from: 'node-a', to: 'node-b', reason: 'failure-recovery' });
  let result = { scope, workspaceRevision: 7, groups: [], events: [event('one'), event('other', 'Work')] };
  const view = { value: { workspace: { mode: 'local', sourceIds: ['sample'], revision: 7 }, automatic: result } };
  const overrides = { value: { automatic: { Stream: { enabled: true }, Work: { enabled: true } } } };
  const props = { groupName: 'Stream', selectable: true };
  const document = { hidden: false, addEventListener() {}, removeEventListener() {} };
  const calls: { path: string; options?: any }[] = [];
  let fail = false, deferred: Promise<typeof result> | undefined;
  const exports: Record<string, any> = {};
  new Script(code, { filename: 'AutomaticSelectionHistory.js' }).runInNewContext({
    exports, defineProps: () => props, ref: (value: unknown) => ({ value }),
    computed: (get: () => unknown) => ({ get value() { return get(); } }), watch() {}, onMounted() {}, onUnmounted() {},
    document, setTimeout: () => 0, clearTimeout() {}, cocoproxyErrorMessage: () => '读取失败',
    useWorkspace: () => ({ view, overrides, api: { request: async (path: string, options?: any) => {
      calls.push({ path, options });
      if (fail) throw new Error('synthetic failure');
      if (deferred) return deferred;
      if (options) {
        assert.equal(options.body.group, 'Stream');
        assert.equal(options.body.scope, scope);
        assert.equal(options.body.expectedRevision, 7);
        result = { ...result, events: result.events.filter(e => e.group !== 'Stream') };
      }
      return structuredClone(result);
    } } }),
  });
  exports.open();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(Array.from(exports.displayed.value, (e: any) => e.id), ['one']);
  overrides.value.automatic.Stream.enabled = false;
  assert.equal(exports.available.value, true); // Historical entry remains available after manual takeover.
  let jumps = 0;
  exports.scroller.value = { scrollTop: 120, scrollTo: () => jumps++ };
  exports.onScroll();
  result = { ...result, events: [...result.events, event('two')] };
  await exports.readStatus();
  assert.equal(exports.displayed.value.length, 1);
  assert.equal(exports.newCount.value, 1);
  assert.equal(jumps, 0);
  exports.showLatest();
  assert.equal(exports.displayed.value.length, 2);
  assert.equal(jumps, 1);
  fail = true;
  await exports.readStatus();
  assert.equal(exports.error.value, '读取失败');
  assert.equal(exports.displayed.value.length, 2);
  fail = false;
  exports.confirmClear.value = true;
  await exports.clearHistory();
  assert.equal(exports.displayed.value.length, 0);
  assert.deepEqual(view.value.automatic.events.map(e => e.group), ['Work']);
  exports.close();
  assert.equal(exports.available.value, false);
  const count = calls.length;
  document.hidden = true;
  exports.open();
  await exports.readStatus();
  assert.equal(calls.length, count);
  exports.close();
  document.hidden = false;
  let resolveOld!: (value: typeof result) => void;
  deferred = new Promise(resolve => { resolveOld = resolve; });
  exports.open();
  exports.close();
  props.groupName = 'Work';
  deferred = undefined;
  exports.open();
  await new Promise(resolve => setImmediate(resolve));
  resolveOld({ ...result, events: [event('stale', 'Work')] });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(Array.from(exports.displayed.value, (e: any) => e.id), ['other']);
});

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
    exports, useHead: () => {}, ref: (value: unknown) => ({ value }), onMounted: () => {}, watch() {},
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
  test(`manual selection accepts the server-confirmed takeover in one request (${mode})`, async () => {
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
      async request(path: string, options?: { method?: string; body?: { expectedRevision?: number; expectedActive?: string; group?: string; name?: string } }) {
        calls.push(path);
        if (path === '/api/cocoproxy/workspace/select') {
          assert.equal(options?.method, 'POST');
          assert.equal(options?.body?.group, 'Stream');
          assert.equal(options?.body?.name, 'node-a');
          assert.equal(options.body.expectedRevision, 7);
          assert.equal(options.body.expectedActive, 'before');
          settings = { ...structuredClone(settings), revision: 8 };
          const target = mode === 'local' ? settings.local : settings.subscriptionOverrides[mode === 'legacy' ? 'legacy' : 'sample'];
          Object.assign(target.automatic.Stream, { enabled: false });
          active = 'after';
          return { active, view: { workspace: settings, active, pending: false, groups: [{ name: 'Stream', activeSelected: 'node-a' }] } };
        }
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
    assert.deepEqual(calls, ['/api/cocoproxy/workspace/select']);
    assert.equal((states.get('cocoproxy-workspace')?.value as any).active, 'after');
    assert.equal(api.generation.value, 'after');
    assert.equal(states.get('cocoproxy-workspace-busy')?.value, false);
    assert.match(String(states.get('cocoproxy-workspace-feedback')?.value), /已切换/);
  });
}

test('selection never replays an ambiguous write or reports an unconfirmed response as success', async () => {
  for (const failure of ['NETWORK_UNKNOWN', 'SELECTION_UNCONFIRMED']) {
    const current = { workspace: { revision: 7 }, active: 'before', pending: false, groups: [{ name: 'Stream', activeSelected: 'node-a' }] };
    const states = new Map<string, { value: any }>([['cocoproxy-workspace', { value: current }]]);
    const calls: string[] = [];
    const exports: Record<string, any> = {};
    const api = { generation: { value: 'before' }, request: async (path: string) => {
      calls.push(path);
      if (path === '/api/cocoproxy/workspace') return current;
      if (failure === 'NETWORK_UNKNOWN') throw new CoCoProxyError(failure);
      return { active: 'after', view: { ...current, active: 'after', workspace: { revision: 8 } } };
    } };
    new Script(compiled).runInNewContext({ exports,
      require: () => ({ CoCoProxyError, cocoproxyErrorMessage, useCoCoProxy: () => api }),
      useState: (key: string, initial: () => unknown) => {
        if (!states.has(key)) states.set(key, { value: initial() });
        return states.get(key);
      },
      computed: (get: () => unknown) => ({ get value() { return get(); } }),
    });
    await assert.rejects(exports.useWorkspace().select('Stream', 'node-b'), { code: failure });
    assert.deepEqual(calls, ['/api/cocoproxy/workspace/select', '/api/cocoproxy/workspace']);
    assert.equal(states.get('cocoproxy-workspace-feedback')!.value, '');
    assert.equal(states.get('cocoproxy-workspace-busy')!.value, false);
    assert.equal(api.generation.value, 'before');
  }
});

test('automatic settings retain ordered pools, stage edits and disable the other pool at the end', async () => {
  const component = await readFile(new URL('../integrations/metacubexd/overlay/packages/ui/components/AutomaticSelectionSettings.vue', import.meta.url), 'utf8');
  const script = component.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)![1]
    .replace(/^import .*$/gm, '') + '\nexport { open, persist, enabled, preferred, fallback, returnToPreferred, bandwidth, editPool, editorKind, onlySelected, search, visibleNodes, nodeDisabled, toggleNode, saved, changed, saveError, refreshWarning, needsRead, reread, beforeClose, confirmClose, continueEditing, discardAndClose, requestNavigation, selectTab, tab, rulesEditor, sitesEditor, dialog, saving };';
  const code = ts.transpileModule(script, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const original = { preferred: ['second', 'first'], fallback: ['backup'], returnToPreferred: false };
  const settings = { local: { selections: {}, automatic: { Stream: structuredClone(original) } } };
  const view = { value: { nodes: ['first', 'second', 'backup', 'unused'], groups: [{ name: 'Stream', options: ['first', 'backup', 'second', 'unused'], activeSelected: 'backup' }] } };
  const exports: Record<string, any> = {};
  let saves = 0, refreshFails = false, applyBeforeFailure = false;
  let failure: Error | undefined, deferred: Promise<void> | undefined;
  const proxyError = { value: '' };
  const navigations: unknown[] = [], closes: boolean[] = [];
  new Script(code, { filename: 'AutomaticSelectionSettings.js' }).runInNewContext({
    exports, CoCoProxyError, cocoproxyErrorMessage, defineProps: () => ({ groupName: 'Stream', selectable: true }), defineExpose: () => {},
    ref: (value: unknown) => ({ value }), computed: (get: () => unknown) => ({ get value() { return get(); } }),
    watch: () => {}, onUnmounted: () => {}, document: { hidden: true }, setTimeout: () => 0, clearTimeout: () => {},
    navigateTo: (target: unknown) => navigations.push(target),
    useProxyRefresh: () => ({ error: proxyError, refresh: async () => { proxyError.value = refreshFails ? '合成刷新失败' : ''; } }),
    useWorkspace: () => ({ view, overrides: { value: settings.local }, busy: { value: false }, error: { value: '' },
      run: async (fn: () => Promise<void>) => fn(), load: async () => {},
      save: async (edit: (value: unknown) => void) => {
        saves++;
        if (deferred) await deferred;
        if (applyBeforeFailure) edit(settings);
        if (failure) throw failure;
        edit(settings);
      },
      editOverrides: () => settings.local }),
  });
  exports.open();
  assert.equal(exports.beforeClose(), true);
  assert.equal(exports.saved.value, false);
  await exports.persist();
  assert.equal(saves, 0); // Opening alone never writes or claims success.
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

  exports.editPool('preferred');
  assert.deepEqual(Array.from(exports.visibleNodes.value), ['first', 'second', 'unused', 'backup']);
  assert.equal(exports.nodeDisabled('backup'), true);
  exports.toggleNode('backup');
  assert.deepEqual(Array.from(exports.preferred.value), original.preferred);
  assert.deepEqual(Array.from(exports.fallback.value), original.fallback);

  exports.onlySelected.value = true;
  exports.toggleNode('second');
  assert.deepEqual(Array.from(exports.preferred.value), ['first']);
  assert.deepEqual(Array.from(exports.visibleNodes.value), ['first', 'second']);
  exports.onlySelected.value = false;
  exports.search.value = 'UNUSED';
  assert.deepEqual(Array.from(exports.visibleNodes.value), ['unused']);
  exports.toggleNode('unused');
  await exports.persist(); // Editing never submits the draft, including implicit form submission.
  assert.deepEqual(JSON.parse(JSON.stringify(settings.local.automatic.Stream)), { ...original, enabled: true });

  exports.editPool('fallback');
  assert.equal(exports.search.value, '');
  assert.deepEqual(Array.from(exports.visibleNodes.value), ['backup', 'second', 'first', 'unused']);
  assert.equal(exports.nodeDisabled('first'), true);
  exports.toggleNode('first');
  assert.deepEqual(Array.from(exports.fallback.value), original.fallback);
  exports.toggleNode('second'); // A node can join this pool only after removal from the other pool.
  exports.editorKind.value = null;
  await exports.persist();
  assert.deepEqual(JSON.parse(JSON.stringify(settings.local.automatic.Stream)), {
    preferred: ['first', 'unused'], fallback: ['backup', 'second'], returnToPreferred: false, enabled: true,
  });

  exports.editPool('preferred');
  exports.toggleNode('first');
  exports.open(); // Discarding and reopening reloads the saved configuration.
  assert.equal(exports.editorKind.value, null);
  assert.deepEqual(Array.from(exports.preferred.value), ['first', 'unused']);

  const fullPool = Array.from({ length: 31 }, (_, index) => `candidate-${index}`);
  view.value.nodes.push(...fullPool);
  view.value.groups[0].options.push(...fullPool);
  exports.preferred.value = fullPool;
  exports.fallback.value = ['backup'];
  exports.editPool('preferred');
  assert.equal(exports.nodeDisabled('unused'), true);
  exports.toggleNode('unused');
  assert.equal(exports.preferred.value.length, 31);
  assert.equal(exports.nodeDisabled(fullPool[0]), false);
  exports.toggleNode(fullPool[0]);
  assert.equal(exports.nodeDisabled('unused'), false);

  exports.open();
  exports.returnToPreferred.value = !exports.returnToPreferred.value;
  let finish!: () => void;
  deferred = new Promise(resolve => { finish = resolve; });
  const pending = exports.persist();
  const before = saves;
  assert.equal(exports.saving.value, true);
  assert.equal(exports.beforeClose(), false);
  exports.selectTab('sites');
  assert.equal(exports.tab.value, 'selection');
  await exports.persist();
  assert.equal(saves, before); // A second click cannot submit while saving.
  finish(); await pending; deferred = undefined;
  assert.equal(exports.saved.value, true);
  assert.equal(exports.changed.value, false);
  assert.equal(exports.beforeClose(), true);

  exports.returnToPreferred.value = !exports.returnToPreferred.value;
  failure = new CoCoProxyError('AUTO_SETTINGS_INVALID');
  await exports.persist();
  assert.equal(exports.changed.value, true);
  assert.match(exports.saveError.value, /设置无效/);
  assert.equal(exports.needsRead.value, false);
  failure = new CoCoProxyError('NETWORK_UNKNOWN');
  applyBeforeFailure = true;
  await exports.persist();
  assert.equal(exports.needsRead.value, true);
  const interrupted = saves;
  await exports.persist();
  assert.equal(saves, interrupted);
  await exports.reread(); // The lost response is reconciled without another write.
  assert.equal(exports.changed.value, false);
  assert.equal(exports.needsRead.value, false);
  assert.equal(exports.saveError.value, '');

  failure = undefined; applyBeforeFailure = false; refreshFails = true;
  exports.returnToPreferred.value = !exports.returnToPreferred.value;
  await exports.persist();
  assert.equal(exports.changed.value, false);
  assert.equal(exports.saveError.value, '');
  assert.match(exports.refreshWarning.value, /已生效，列表刷新失败/);

  exports.bandwidth.value = { enabled: true, observeOnly: true, targetMbps: 8 };
  await exports.persist();
  exports.open();
  assert.equal(exports.bandwidth.value.enabled, true);
  exports.bandwidth.value.targetMbps = 10;
  assert.equal((settings.local.automatic.Stream as any).bandwidth.targetMbps, 8); // Draft edits do not mutate the saved policy.
  exports.bandwidth.value.enabled = false;
  await exports.persist(); exports.open();
  assert.equal(exports.bandwidth.value.enabled, false);
  assert.equal(exports.bandwidth.value.targetMbps, 10);

  exports.dialog.value = { close: (force: boolean) => closes.push(force) };
  exports.rulesEditor.value = { saving: false };
  exports.sitesEditor.value = { dirty: true, saving: false };
  assert.equal(exports.beforeClose(), false);
  assert.equal(exports.confirmClose.value, true);
  exports.continueEditing();
  assert.equal(exports.sitesEditor.value.dirty, true);
  const target = { path: '/rules', query: { group: 'Stream' } };
  exports.requestNavigation(target);
  assert.equal(navigations.length, 0);
  exports.discardAndClose();
  assert.deepEqual(navigations, [target]);
  assert.deepEqual(closes, [true]);

  exports.sitesEditor.value = { dirty: false, saving: false };
  exports.rulesEditor.value = { saving: true };
  assert.equal(exports.beforeClose(), true); // Confirmed rule operations continue after the settings modal closes.
});

test('site settings retain failed drafts and reconcile an interrupted save before allowing another write', async () => {
  const component = await readFile(new URL('../integrations/metacubexd/overlay/packages/ui/components/SiteTargetSettings.vue', import.meta.url), 'utf8');
  const script = component.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)![1].replace(/^import .*$/gm, '') +
    '\nexport { refresh, persist, selected, dirty, selectionChanged, formPending, name, url, feedback, needsRead, error };';
  const code = ts.transpileModule(script, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports: Record<string, any> = {};
  let current = ['google'], writes = 0, failure: Error | undefined, applyBeforeFailure = false;
  const sites = {
    data: { value: { targets: [] } }, pending: { value: false },
    load: async () => {}, selectedIds: () => [...current],
    save: async (change: { selected: string[] }) => {
      writes++;
      if (applyBeforeFailure) current = [...change.selected];
      if (failure) throw failure;
      current = [...change.selected];
    },
  };
  new Script(code).runInNewContext({
    exports, CoCoProxyError, cocoproxyErrorMessage,
    defineProps: () => ({ groupName: 'Work', scrollList: false }), withDefaults: (value: unknown) => value,
    defineExpose() {}, watch() {}, onMounted() {}, onUnmounted() {},
    ref: (value: unknown) => ({ value }), computed: (get: () => unknown) => ({ get value() { return get(); } }),
    useSiteSettings: () => sites, useWorkspace: () => ({ busy: { value: false } }),
  });
  await exports.refresh(false);
  assert.equal(exports.dirty.value, false);
  assert.equal(exports.feedback.value, '');
  await exports.persist();
  assert.equal(writes, 0);
  exports.selected.value = ['example'];
  exports.name.value = 'Unstaged Site';
  assert.equal(exports.formPending.value, true);
  await exports.persist();
  assert.equal(writes, 0);
  exports.name.value = '';
  failure = new CoCoProxyError('SITE_SETTINGS_INVALID');
  await exports.persist();
  assert.equal(exports.dirty.value, true);
  assert.match(exports.error.value, /设置无效/);
  failure = new CoCoProxyError('NETWORK_UNKNOWN'); applyBeforeFailure = true;
  await exports.persist();
  assert.equal(exports.needsRead.value, true);
  const interrupted = writes;
  await exports.persist();
  assert.equal(writes, interrupted);
  await exports.refresh();
  assert.equal(writes, interrupted);
  assert.equal(exports.needsRead.value, false);
  assert.equal(exports.dirty.value, false);
  assert.equal(exports.feedback.value, '检测目标已保存');
  exports.selected.value = ['google'];
  await exports.refresh();
  assert.deepEqual(Array.from(exports.selected.value), ['google']); // Rereading never discards a different local draft.
  assert.equal(exports.dirty.value, true);
});

test('group manager creates a shared exit from Proxy and blocks deletion while services use it', async () => {
  const component = await readFile(new URL('../integrations/metacubexd/overlay/packages/ui/components/WorkspaceGroupsMenu.vue', import.meta.url), 'utf8');
  const script = component.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)![1]
    .replace(/^import .*$/gm, '') + '\nexport { props, addShared, remove, sharedName, referenced, referenceMessage };';
  const code = ts.transpileModule(script, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const settings: any = { local: { sharedGroups: ['AI Exit'], selections: { Proxy: 'node-a', 'AI Exit': 'node-a', OpenAI: 'AI Exit' }, rules: [] } };
  const view = { value: { nodes: ['node-a'], catalog: [{ id: 'Proxy', default: true }], groups: [
    { name: 'Proxy', role: 'shared', selected: 'node-a' }, { name: 'AI Exit', role: 'shared', selected: 'node-a' },
    { name: 'OpenAI', role: 'service', selected: 'AI Exit' },
  ] } };
  let saves = 0;
  const exports: Record<string, any> = {};
  new Script(code, { filename: 'WorkspaceGroupsMenu.js' }).runInNewContext({
    exports, localGroupNameError, defineProps: () => ({ activeGroup: 'AI Exit' }),
    ref: (value: unknown) => ({ value }), computed: (get: () => unknown) => ({ get value() { return get(); } }),
    useProxyRefresh: () => ({ refresh: async () => {} }),
    useWorkspace: () => ({ view, workspace: { value: { mode: 'local' } }, overrides: { value: settings.local }, busy: { value: false },
      run: async (fn: () => Promise<void>) => fn(), save: async (edit: (value: unknown) => void) => { saves++; edit(settings); } }),
  });
  exports.sharedName.value = 'Work Exit';
  await exports.addShared();
  assert.deepEqual(Array.from(settings.local.sharedGroups), ['AI Exit', 'Work Exit']);
  assert.equal(settings.local.selections['Work Exit'], 'node-a');
  assert.equal(exports.referenced.value, true);
  assert.match(exports.referenceMessage.value, /OpenAI/);
  await exports.remove();
  assert.equal(saves, 1);
  delete settings.local.selections.OpenAI;
  await exports.remove();
  assert.equal(saves, 2);
  assert.equal(settings.local.selections['AI Exit'], undefined);
  assert.deepEqual(Array.from(settings.local.sharedGroups), ['Work Exit']);
});
