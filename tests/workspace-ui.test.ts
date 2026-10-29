import { uiTestContext, useI18n } from './ui-i18n-helpers.ts';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Script } from 'node:vm';
import test from 'node:test';
import ts from '../tooling/node_modules/typescript/lib/typescript.js';
import { localGroupNameError } from '../integrations/metacubexd/overlay/packages/ui/utils/group-rules.ts';
import { BANDWIDTH_FIELDS, DEFAULT_BANDWIDTH_SETTINGS, parseBandwidthSettings } from '../packages/management/bandwidth-policy.ts';
import { parseWorkspaceSettings } from '../packages/management/workspace.ts';
import type { AutoGroupPolicy } from '../packages/management/automatic-policy.ts';
import { bandwidthIssue, bandwidthPages } from '../integrations/metacubexd/overlay/packages/ui/utils/group-bandwidth.ts';

const apiExports: Record<string, any> = {};
new Script(ts.transpileModule(await readFile(new URL('../integrations/metacubexd/overlay/packages/ui/composables/useCoCoProxy.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText).runInNewContext({ ...uiTestContext, exports: apiExports, Error });
const { CoCoProxyError, cocoproxyErrorMessage } = apiExports;

const source = await readFile(new URL('../integrations/metacubexd/overlay/packages/ui/composables/useWorkspace.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;

test('bandwidth validation remains available across pages and checks shared budgets', () => {
  let current = { ...DEFAULT_BANDWIDTH_SETTINGS, enabled: true };
  const automatic: Record<string, AutoGroupPolicy> = {};
  const definitions = { defaults: DEFAULT_BANDWIDTH_SETTINGS, fields: BANDWIDTH_FIELDS };
  const invalid = () => bandwidthIssue(current, definitions, automatic, 'Stream', true, useI18n().t)?.message ?? '';
  assert.equal(invalid(), '');
  for (const bad of [{ searchMiB: 16 }, { reserveHourMiB: DEFAULT_BANDWIDTH_SETTINGS.hourMiB }, { freshSeconds: 60, roundIntervalSeconds: 60 },
    { hourMiB: 32 }, { hourMiB: 64, dayMiB: 64, reserveDayMiB: 40 }]) {
    current = { ...DEFAULT_BANDWIDTH_SETTINGS, enabled: true, ...bad };
    assert.notEqual(invalid(), '');
    assert.throws(() => parseBandwidthSettings(current));
  }
  for (const limits of [{ hourMiB: 48, dayMiB: 64 }, { hourMiB: 32, dayMiB: 32, reserveHourMiB: 0, reserveDayMiB: 0 }]) {
    current = { ...DEFAULT_BANDWIDTH_SETTINGS, enabled: true, ...limits };
    assert.equal(invalid(), '');
    assert.doesNotThrow(() => parseBandwidthSettings(current));
  }
  const policy = (limits = {}): AutoGroupPolicy => ({ preferred: ['a'], fallback: ['b'], returnToPreferred: true,
    bandwidth: { ...DEFAULT_BANDWIDTH_SETTINGS, enabled: true, ...limits } });
  automatic.Stream = policy({ reserveHourMiB: 32 });
  for (const [own, other] of [[{ hourMiB: 48 }, { reserveHourMiB: 32 }],
    [{ hourMiB: 64, dayMiB: 64 }, { reserveDayMiB: 64 }], [{ hourMiB: 48 }, { hourMiB: 80, confirmRounds: 3, searchMiB: 48 }]]) {
    current = { ...DEFAULT_BANDWIDTH_SETTINGS, enabled: true, ...own };
    automatic.Other = policy(other);
    assert.match(invalid(), /多个启用组/);
    assert.throws(() => parseWorkspaceSettings({ mode: 'local', subscriptionId: null, sourceIds: [], runMode: 'rule',
      local: { selections: {}, rules: [], automatic: { Stream: { ...policy(), bandwidth: current }, Other: policy(other) } },
      subscriptionOverrides: {},
    }), { code: 'AUTO_SETTINGS_INVALID' });
    automatic.Other.enabled = false;
    assert.equal(invalid(), '');
    automatic.Other.enabled = true;
    automatic.Other.bandwidth!.enabled = false;
    assert.equal(invalid(), '');
  }
  const keys = bandwidthPages.flatMap(page => [...page.keys]);
  assert.equal(new Set(keys).size, keys.length);
  assert.deepEqual([...keys].sort(), Object.keys(BANDWIDTH_FIELDS).sort());
  current = { ...DEFAULT_BANDWIDTH_SETTINGS, enabled: true, busyStopMbps: 0.5 };
  assert.equal(bandwidthIssue(current, definitions, {}, 'Stream')?.page, 'trigger');
  current = { ...DEFAULT_BANDWIDTH_SETTINGS, enabled: true, targetMbps: NaN };
  assert.equal(bandwidthIssue(current, definitions, {}, 'Stream')?.key, 'targetMbps');
  current.enabled = false;
  assert.equal(bandwidthIssue(current, definitions, {}, 'Stream')?.key, 'targetMbps'); // Disabled settings still have to be serializable and pass server validation.
  current = { ...DEFAULT_BANDWIDTH_SETTINGS, enabled: false, hourMiB: 32 };
  assert.equal(bandwidthIssue(current, definitions, {}, 'Stream'), undefined); // Disabled bandwidth exits the reserved-capacity check.
});

test('bandwidth switches retain subordinate settings and restore affects only the displayed page', async () => {
  const component = await readFile(new URL('../integrations/metacubexd/overlay/packages/ui/components/BandwidthSelectionSettings.vue', import.meta.url), 'utf8');
  const script = component.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)![1].replace(/^import .*$/gm, '')
    + '\nexport { toggle, restore };';
  const code = ts.transpileModule(script, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const props = { modelValue: { ...DEFAULT_BANDWIDTH_SETTINGS, enabled: true, targetMbps: 7, hourMiB: 80 },
    definitions: { defaults: DEFAULT_BANDWIDTH_SETTINGS, fields: BANDWIDTH_FIELDS }, page: 'budget', disabled: false };
  const exports: Record<string, any> = {};
  new Script(code).runInNewContext({ ...uiTestContext,
    exports, bandwidthPages, defineProps: () => props, defineEmits: () => (_event: string, value: typeof props.modelValue) => { props.modelValue = value; },
    ref: (value: unknown) => ({ value }), computed: (get: () => unknown) => ({ get value() { return get(); } }), watch() {},
  });
  exports.toggle('observeOnly', { target: { checked: true } });
  assert.equal(props.modelValue.enabled, true);
  assert.equal(props.modelValue.observeOnly, true);
  exports.restore();
  assert.equal(props.modelValue.hourMiB, DEFAULT_BANDWIDTH_SETTINGS.hourMiB);
  assert.equal(props.modelValue.targetMbps, 7);
  assert.equal(props.modelValue.enabled, true);
  assert.equal(props.modelValue.observeOnly, true);
  exports.toggle('enabled', { target: { checked: false } });
  assert.equal(props.modelValue.enabled, false);
  assert.equal(props.modelValue.targetMbps, 7);
  assert.equal(props.modelValue.observeOnly, true);
  exports.toggle('observeOnly', { target: { checked: false } });
  assert.equal(props.modelValue.observeOnly, true); // A hidden subordinate switch cannot be changed while its parent is off.
  props.disabled = true;
  exports.toggle('enabled', { target: { checked: true } });
  assert.equal(props.modelValue.enabled, false);
  props.disabled = false;
  exports.toggle('enabled', { target: { checked: true } });
  assert.equal(props.modelValue.observeOnly, true);
});
test('group status checks only saved active policies and binds requests to the displayed scope and revision', async () => {
  const component = await readFile(new URL('../integrations/metacubexd/overlay/packages/ui/components/GroupSelectionStatus.vue', import.meta.url), 'utf8');
  const script = component.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)![1].replace(/^import .*$/gm, '')
    + '\nexport { check, canCheck, engineSummary };';
  const code = ts.transpileModule(script, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const props: any = { groupName: 'Stream', policyEnabled: true, bandwidth: { ...DEFAULT_BANDWIDTH_SETTINGS, enabled: true },
    dirty: false, disabled: false, reading: false, error: '',
    status: { scope: 'synthetic-scope', groups: [{ name: 'Stream', current: 'node-a', phase: 'monitoring' }], events: [] } };
  const view = { value: { active: 'synthetic-generation', pending: false, workspace: { revision: 7 } } };
  const calls: any[] = [];
  const emitted: unknown[][] = [];
  const exports: Record<string, any> = {};
  new Script(code).runInNewContext({ ...uiTestContext,
    exports, defineProps: () => props, defineEmits: () => (...args: unknown[]) => emitted.push(args), onUnmounted() {},
    ref: (value: unknown) => ({ value }), computed: (get: () => unknown) => ({ get value() { return get(); } }),
    cocoproxyErrorMessage: () => '读取失败',
    useWorkspace: () => ({ view, api: { request: async (path: string, options: unknown) => { calls.push({ path, options }); } } }),
  });
  for (const blocked of [{ dirty: true }, { disabled: true }, { reading: true }, { policyEnabled: false }, { error: '读取失败' }]) {
    Object.assign(props, blocked);
    await exports.check();
    assert.equal(calls.length, 0);
    Object.assign(props, { dirty: false, disabled: false, reading: false, policyEnabled: true, error: '' });
  }
  for (const state of [{ paused: true }, { suspended: true }, { error: '不可用' }]) {
    Object.assign(props.status, state);
    await exports.check();
    assert.equal(calls.length, 0);
    Object.assign(props.status, { paused: false, suspended: false, error: '' });
  }
  for (const state of ['error', 'suspended']) {
    props.status.engine = { state, reason: state === 'error' ? null : 'pending' };
    await exports.check();
    assert.equal(calls.length, 0);
    assert.match(exports.engineSummary.value, state === 'error' ? /后台运行异常/ : /等待配置生效/);
  }
  props.status.groups = [];
  props.status.engine = { state: 'error', reason: null };
  assert.match(exports.engineSummary.value, /后台运行异常/);
  props.status.groups = [{ name: 'Stream', current: 'node-a', phase: 'monitoring' }];
  props.status.engine = { state: 'running', reason: 'quota' };
  assert.match(exports.engineSummary.value, /等待轻量探测额度/);
  view.value.pending = true;
  await exports.check();
  assert.equal(calls.length, 0);
  view.value.pending = false;
  await exports.check();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, '/api/cocoproxy/automatic/bandwidth/check');
  assert.deepEqual(emitted, [['checking', true], ['checking', false], ['refresh']]);
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0].options.body)), {
    expectedRevision: 7, expectedActive: 'synthetic-generation', scope: 'synthetic-scope', group: 'Stream',
  });
});
test('automatic history keeps reading position, preserves failed refreshes and clears only the displayed group', async () => {
  const component = await readFile(new URL('../integrations/metacubexd/overlay/packages/ui/components/AutomaticSelectionHistory.vue', import.meta.url), 'utf8');
  const script = component.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)![1].replace(/^import .*$/gm, '') +
    '\nexport { open, close, readStatus, clearHistory, onScroll, showLatest, scroller, displayed, newCount, error, confirmClear, available, loading, refreshing, status };';
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
  new Script(code, { filename: 'AutomaticSelectionHistory.js' }).runInNewContext({ ...uiTestContext,
    exports, defineProps: () => props, ref: (value: unknown) => ({ value }),
    computed: (get: () => unknown) => ({ get value() { return get(); } }), watch() {}, onMounted() {}, onUnmounted() {},
    document, setTimeout: () => 0, clearTimeout() {}, cocoproxyErrorMessage: () => '读取失败',
    useWorkspace: () => ({ view, overrides, api: { request: async (path: string, options?: any) => {
      calls.push({ path, options });
      if (fail) throw new Error('synthetic failure');
      if (deferred && !options) return deferred;
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
  let completeRead!: (value: typeof result) => void;
  deferred = new Promise(resolve => { completeRead = resolve; });
  const background = exports.readStatus();
  assert.equal(exports.loading.value, true);
  assert.equal(exports.refreshing.value, false);
  const manual = exports.readStatus(false);
  assert.equal(exports.refreshing.value, true);
  completeRead(structuredClone(result));
  await Promise.all([background, manual]);
  assert.equal(exports.refreshing.value, false);
  deferred = undefined;
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
  const stale = structuredClone(result);
  deferred = new Promise(resolve => { completeRead = resolve; });
  const beforeClear = exports.readStatus();
  exports.confirmClear.value = true;
  await exports.clearHistory();
  completeRead(stale);
  await beforeClear;
  deferred = undefined;
  assert.equal(exports.displayed.value.length, 0);
  assert.equal(exports.status.value.events.some((e: any) => e.group === 'Stream'), false);
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
  new Script(code, { filename: 'subscriptions.js' }).runInNewContext({ ...uiTestContext,
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
    new Script(compiled, { filename: 'useWorkspace.js' }).runInNewContext({ ...uiTestContext,
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
    assert.equal(states.get('cocoproxy-workspace-feedback')?.value, 'coco.switched');
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
    new Script(compiled).runInNewContext({ ...uiTestContext, exports,
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

test('host proxy settings guard writes and distinguish saved settings from the active state after an apply failure', async () => {
  let settings: any = { mode: 'local', subscriptionId: null, sourceIds: [], runMode: 'rule', revision: 7,
    local: { selections: {}, rules: [] }, subscriptionOverrides: {} };
  let active = 'before', activeEnabled = false, pending = false, failApply = true;
  const currentView = () => ({ workspace: structuredClone(settings), active, pending,
    hostProxy: { available: true, enabled: settings.hostProxy === true, active: activeEnabled } });
  const states = new Map<string, { value: any }>([['cocoproxy-workspace', { value: currentView() }]]);
  const calls: string[] = [];
  const api = { generation: { value: active }, readStatus: async () => { calls.push('status'); return {}; },
    request: async (path: string, options?: any) => {
      calls.push(`${options?.method ?? 'GET'} ${path}`);
      if (path === '/api/session/devices') return { devices: [] };
      if (!options) return currentView();
      assert.equal(options.body.expectedRevision, settings.revision);
      if (options.method === 'PUT') {
        settings = { ...structuredClone(options.body.settings), revision: settings.revision + 1 };
        pending = true;
        return { workspace: structuredClone(settings) };
      }
      assert.equal(options.body.expectedActive, active);
      if (failApply) throw new CoCoProxyError('RELOAD_FAILED');
      activeEnabled = settings.hostProxy === true; active = `generation-${settings.revision}`; pending = false;
      return { active };
    } };
  const workspaceExports: Record<string, any> = {};
  new Script(compiled).runInNewContext({ ...uiTestContext, exports: workspaceExports,
    require: () => ({ CoCoProxyError, cocoproxyErrorMessage, useCoCoProxy: () => api }),
    useState: (key: string, initial: () => unknown) => {
      if (!states.has(key)) states.set(key, { value: initial() });
      return states.get(key);
    },
  });
  const workspace = workspaceExports.useWorkspace();
  const page = await readFile(new URL('../integrations/metacubexd/overlay/packages/ui/pages/cocoproxy.vue', import.meta.url), 'utf8');
  const script = page.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)![1].replace(/^import .*$/gm, '')
    + '\nexport { changeHostProxy, retryHostProxy, refresh, busy, locked, hostProxyEnabled, hostProxyPending, visibleError };';
  const exports: Record<string, any> = {};
  new Script(ts.transpileModule(script, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText)
    .runInNewContext({ ...uiTestContext, exports, CoCoProxyError, cocoproxyErrorMessage,
      useCoCoProxy: () => api, useWorkspace: () => workspace, useHead() {}, onMounted() {}, ref: (value: unknown) => ({ value }),
    });
  const toggle = (checked: boolean) => exports.changeHostProxy({ target: { checked } });
  workspace.view.value.hostProxy.available = false;
  await toggle(true);
  workspace.view.value.hostProxy.available = true;
  workspace.busy.value = true;
  await toggle(true);
  workspace.busy.value = false;
  exports.busy.value = true;
  await toggle(true);
  exports.busy.value = false;
  assert.deepEqual(calls, []);
  assert.equal(exports.hostProxyEnabled.value, false); // Existing settings without a flag remain off.
  await toggle(true);
  assert.equal(settings.hostProxy, true);
  assert.equal(exports.hostProxyEnabled.value, true);
  assert.equal(workspace.view.value.hostProxy.active, false);
  assert.equal(exports.hostProxyPending.value, true);
  assert.notEqual(exports.visibleError.value, '');
  assert.equal(workspace.feedback.value, '');
  assert.equal(exports.locked.value, false);
  assert.deepEqual(calls.splice(0), ['PUT /api/cocoproxy/workspace', 'POST /api/cocoproxy/workspace/apply', 'GET /api/cocoproxy/workspace']);
  failApply = false;
  await exports.retryHostProxy();
  assert.equal(workspace.view.value.hostProxy.active, true);
  assert.equal(exports.hostProxyPending.value, false);
  assert.equal(exports.visibleError.value, '');
  await toggle(false);
  assert.equal(settings.hostProxy, false);
  assert.equal(workspace.view.value.hostProxy.active, false);
  calls.length = 0;
  await exports.refresh();
  assert.deepEqual(calls.sort(), ['GET /api/cocoproxy/workspace', 'GET /api/session/devices', 'status'].sort());
});

test('automatic settings retain ordered pools, stage edits and disable the other pool at the end', async () => {
  const component = await readFile(new URL('../integrations/metacubexd/overlay/packages/ui/components/AutomaticSelectionSettings.vue', import.meta.url), 'utf8');
  const script = component.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)![1]
    .replace(/^import .*$/gm, '') + '\nexport { open, persist, enabled, preferred, fallback, returnToPreferred, bandwidth, editPool, editorKind, onlySelected, search, visibleNodes, nodeDisabled, toggleNode, saved, changed, saveError, refreshWarning, needsRead, reread, beforeClose, confirmClose, continueEditing, discardAndClose, requestNavigation, selectTab, tab, rulesEditor, sitesEditor, dialog, saving, pageDirty, invalidPage, invalid, activeNavigation, readStatus, checkingStatus, statusReading, status };';
  const code = ts.transpileModule(script, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const original = { preferred: ['second', 'first'], fallback: ['backup'], returnToPreferred: false };
  const settings = { local: { selections: {}, automatic: { Stream: structuredClone(original) } } };
  const view = { value: { nodes: ['first', 'second', 'backup', 'unused'], groups: [{ name: 'Stream', options: ['first', 'backup', 'second', 'unused'], activeSelected: 'backup' }] } };
  const exports: Record<string, any> = {};
  let saves = 0, refreshFails = false, applyBeforeFailure = false;
  let failure: Error | undefined, deferred: Promise<void> | undefined;
  const proxyError = { value: '' };
  const navigations: unknown[] = [], closes: boolean[] = [];
  const document = { hidden: true };
  let statusReply: (() => Promise<unknown>) | undefined;
  new Script(code, { filename: 'AutomaticSelectionSettings.js' }).runInNewContext({ ...uiTestContext,
    exports, bandwidthIssue, bandwidthPages, CoCoProxyError, cocoproxyErrorMessage, defineProps: () => ({ groupName: 'Stream', selectable: true }), defineExpose: () => {},
    ref: (value: unknown) => ({ value }), computed: (get: () => unknown) => ({ get value() { return get(); } }),
    watch: () => {}, onUnmounted: () => {}, document, setTimeout: () => 0, clearTimeout: () => {},
    navigateTo: (target: unknown) => navigations.push(target),
    useProxyRefresh: () => ({ error: proxyError, refresh: async () => { proxyError.value = refreshFails ? '合成刷新失败' : ''; } }),
    useWorkspace: () => ({ view, workspace: { value: { mode: 'local' } }, overrides: { value: settings.local }, busy: { value: false }, error: { value: '' },
      api: { request: async (path: string) => path.endsWith('/status') && statusReply ? statusReply() : ({ bandwidth: { defaults: DEFAULT_BANDWIDTH_SETTINGS, fields: BANDWIDTH_FIELDS } }) },
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
  for (const page of ['pool', 'bandwidth', 'budget', 'sampling']) {
    exports.selectTab(page);
    assert.equal(exports.tab.value, 'selection'); // The master switch gates every subordinate configuration page.
  }
  exports.editPool('preferred');
  assert.equal(exports.editorKind.value, null);
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

  exports.bandwidth.value = { ...DEFAULT_BANDWIDTH_SETTINGS, enabled: true, observeOnly: true, targetMbps: 8 };
  await exports.persist();
  exports.open();
  assert.equal(exports.bandwidth.value.enabled, true);
  exports.bandwidth.value.targetMbps = 10;
  assert.equal((settings.local.automatic.Stream as any).bandwidth.targetMbps, 8); // Draft edits do not mutate the saved policy.
  exports.bandwidth.value.enabled = false;
  await exports.persist(); exports.open();
  assert.equal(exports.bandwidth.value.enabled, false);
  assert.equal(exports.bandwidth.value.targetMbps, 10);

  exports.selectTab('bandwidth');
  exports.selectTab('budget');
  assert.equal(exports.tab.value, 'bandwidth'); // Bandwidth descendants require their own parent switch as well.
  exports.selectTab('advanced');
  assert.equal(exports.tab.value, 'bandwidth');

  exports.bandwidth.value.enabled = true;
  exports.selectTab('budget');
  assert.equal(exports.tab.value, 'budget');
  assert.equal(exports.activeNavigation.value, 'bandwidth');
  exports.bandwidth.value.hourMiB = 80;
  assert.equal(exports.pageDirty('budget'), true);
  assert.equal(exports.pageDirty('bandwidth', true), true);
  exports.selectTab('advanced');
  assert.equal(exports.activeNavigation.value, 'bandwidth');
  exports.selectTab('sampling');
  assert.equal(exports.bandwidth.value.hourMiB, 80);
  exports.bandwidth.value.durationSeconds = 5;
  exports.bandwidth.value.warmupSeconds = 5;
  exports.selectTab('selection');
  assert.equal(exports.invalidPage.value, 'sampling'); // Unmounting the parameter page cannot hide validation errors.
  assert.match(exports.invalid.value, /预热/);
  const beforeInvalid = saves;
  await exports.persist();
  assert.equal(saves, beforeInvalid);
  exports.open();

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

  exports.rulesEditor.value = { saving: false };
  delete (settings.local.automatic as Record<string, unknown>).Stream;
  exports.dialog.value = undefined;
  exports.open();
  exports.bandwidth.value = { ...DEFAULT_BANDWIDTH_SETTINGS, hourMiB: 80 };
  await exports.persist(); // A new group can stage bandwidth settings before enabling automatic selection or selecting candidates.
  assert.equal((settings.local.automatic.Stream as any).bandwidth.hourMiB, 80);
  assert.equal((settings.local.automatic.Stream as any).enabled, false);

  document.hidden = false;
  exports.tab.value = 'status';
  const initial = { groups: [], events: [] };
  exports.status.value = initial;
  let finishStatus!: (value: unknown) => void;
  statusReply = () => new Promise(resolve => { finishStatus = resolve; });
  const poll = exports.readStatus(true);
  assert.equal(exports.statusReading.value, false);
  assert.equal(exports.status.value, initial);
  exports.checkingStatus(true);
  finishStatus({ groups: [{ name: 'stale' }], events: [] });
  await poll;
  assert.equal(exports.status.value, initial); // A pre-check read cannot overwrite the checked state.
  exports.checkingStatus(false);
  const manual = exports.readStatus();
  assert.equal(exports.statusReading.value, true);
  finishStatus({ groups: [{ name: 'fresh' }], events: [] });
  await manual;
  assert.equal(exports.statusReading.value, false);
  assert.equal(exports.status.value.groups[0].name, 'fresh');
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
  new Script(code).runInNewContext({ ...uiTestContext,
    exports, CoCoProxyError, cocoproxyErrorMessage,
    defineProps: () => ({ groupName: 'Work', scrollList: false }), withDefaults: (value: unknown) => value,
    defineEmits: () => () => {}, defineExpose() {}, watch() {}, onMounted() {}, onUnmounted() {},
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
    .replace(/^import .*$/gm, '') + '\nexport { props, addShared, remove, sharedName, deleting, removalReason, requestRemove };';
  const code = ts.transpileModule(script, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const settings: any = { local: { sharedGroups: ['AI Exit'], selections: { Proxy: 'node-a', 'AI Exit': 'node-a', OpenAI: 'AI Exit' }, rules: ['DOMAIN,own.example,AI Exit', 'DOMAIN,keep.example,Proxy'] } };
  const view = { value: { nodes: ['node-a'], catalog: [{ id: 'Proxy', default: true }], groups: [
    { name: 'Proxy', role: 'shared', selected: 'node-a' }, { name: 'AI Exit', role: 'shared', selected: 'node-a' },
    { name: 'OpenAI', role: 'service', selected: 'AI Exit' },
  ] } };
  let saves = 0;
  const exports: Record<string, any> = {};
  new Script(code, { filename: 'WorkspaceGroupsMenu.js' }).runInNewContext({ ...uiTestContext,
    exports, localGroupNameError, defineProps: () => ({ activeGroup: 'Proxy' }),
    ref: (value: unknown) => ({ value }), computed: (get: () => unknown) => ({ get value() { return get(); } }),
    useProxyRefresh: () => ({ refresh: async () => {} }),
    useWorkspace: () => ({ view, workspace: { value: { mode: 'local' } }, overrides: { value: settings.local }, busy: { value: false },
      run: async (fn: () => Promise<void>) => fn(), save: async (edit: (value: unknown) => void) => { saves++; edit(settings); } }),
  });
  exports.sharedName.value = 'Work Exit';
  await exports.addShared();
  assert.deepEqual(Array.from(settings.local.sharedGroups), ['AI Exit', 'Work Exit']);
  assert.equal(settings.local.selections['Work Exit'], 'node-a');
  assert.match(exports.removalReason('Proxy'), /固定/);
  exports.requestRemove('Proxy');
  assert.equal(exports.deleting.value, null);
  assert.match(exports.removalReason('AI Exit'), /OpenAI/);
  exports.requestRemove('AI Exit');
  assert.equal(exports.deleting.value, null);
  exports.deleting.value = 'AI Exit';
  await exports.remove();
  assert.equal(saves, 1);
  delete settings.local.selections.OpenAI;
  assert.equal(exports.removalReason('AI Exit'), '');
  await exports.remove();
  assert.equal(saves, 2);
  assert.equal(settings.local.selections['AI Exit'], undefined);
  assert.deepEqual(Array.from(settings.local.rules), ['DOMAIN,keep.example,Proxy']);
  assert.deepEqual(Array.from(settings.local.sharedGroups), ['Work Exit']);
});
