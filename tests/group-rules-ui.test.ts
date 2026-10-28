import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Script } from 'node:vm';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import ts from '../tooling/node_modules/typescript/lib/typescript.js';
import * as rules from '../integrations/metacubexd/overlay/packages/ui/utils/group-rules.ts';

const apiExports: Record<string, any> = {};
new Script(ts.transpileModule(await readFile(new URL('../integrations/metacubexd/overlay/packages/ui/composables/useCoCoProxy.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText).runInNewContext({ exports: apiExports, Error });
const { CoCoProxyError } = apiExports;

test('group rule utility passes strict indexed-access type checks', () => {
  const program = ts.createProgram({
    rootNames: [fileURLToPath(new URL('../integrations/metacubexd/overlay/packages/ui/utils/group-rules.ts', import.meta.url))],
    options: { noEmit: true, strict: true, noUncheckedIndexedAccess: true, skipLibCheck: true,
      target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, types: [] },
  });
  assert.deepEqual(ts.getPreEmitDiagnostics(program).map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')), []);
});

async function editor(initial: string[], groupName = 'Work') {
  const source = await readFile(new URL('../integrations/metacubexd/overlay/packages/ui/components/GroupMatchingRules.vue', import.meta.url), 'utf8');
  const script = source.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)![1].replace(/^import .*$/gm, '') +
    '\nexport { entries, original, drafts, editing, deleting, error, formError, listChanged, saved, saving, needsRead, pendingApply, ownRules, templateRules, dependents, effectiveRulesLink, customRulesLink, editorDialog, deleteDialog, openAdd, edit, addDraftGroup, collectDraftRules, submitEditor, requestRemove, confirmRemove, retry, reread };';
  const code = ts.transpileModule(script, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const settings = { local: { rules: [...initial], selections: { Work: 'Proxy', Stream: 'node-a' } as Record<string, string> } };
  const view = { value: { groups: [{ name: 'Work', role: 'service', selected: 'Proxy' }], rules: [] as { value: string; source: string }[], pending: false } };
  const workspace = { value: { mode: 'local', runMode: 'rule' } };
  const exports: Record<string, any> = {};
  let saves = 0, failure: Error | undefined, persistBeforeFailure = false;
  new Script(code, { filename: 'GroupMatchingRules.js' }).runInNewContext({
    ...rules, exports, Error, CoCoProxyError, defineProps: () => ({ groupName }), defineEmits: () => () => {}, defineExpose() {},
    ref: (value: unknown) => ({ value }), computed: (get: () => unknown) => ({ get value() { return get(); } }),
    useWorkspace: () => ({ view, workspace, overrides: { get value() { return settings.local; } }, busy: { value: false }, load: async () => {},
      run: async (action: () => Promise<void>) => { try { await action(); } catch { /* Shared workspace alert owns the propagated failure. */ } },
      save: async (edit: (value: typeof settings) => void) => {
        saves++;
        const draft = structuredClone(settings);
        edit(draft);
        if (persistBeforeFailure) settings.local = draft.local;
        if (failure) throw failure;
        settings.local = draft.local;
      } }),
  });
  exports.editorDialog.value = { open() {}, close() {} };
  exports.deleteDialog.value = { open() {}, close() {} };
  return Object.assign(exports, { settings, workspace, view, saves: () => saves,
    fail: (cause = new Error('合成应用失败'), persisted = false, pending = false) => {
      failure = cause; persistBeforeFailure = persisted; view.value.pending = pending;
    }, recover: () => { failure = undefined; view.value.pending = false; } });
}

test('group rule viewing opens effective rules while editing keeps the custom destination', async () => {
  const ui = await editor([], 'Microsoft');
  ui.view.value.rules = [{ value: 'DOMAIN-SUFFIX,microsoft.com,Microsoft', source: 'template' }];
  assert.equal(ui.ownRules.value.length, 0);
  assert.equal(ui.templateRules.value.length, 1);
  assert.equal(ui.effectiveRulesLink.value.query.tab, 'effective');
  assert.equal(ui.effectiveRulesLink.value.query.group, 'Microsoft');
  assert.equal(ui.customRulesLink.value.query.tab, 'custom');
  assert.equal(ui.customRulesLink.value.query.group, 'Microsoft');

  const component = await readFile(new URL('../integrations/metacubexd/overlay/packages/ui/components/GroupMatchingRules.vue', import.meta.url), 'utf8');
  assert.match(component, /:to="effectiveRulesLink"[^>]*>[\s\S]*?查看本组生效规则/);
  assert.match(component, /:to="customRulesLink"[^>]*>[\s\S]*?前往规则页编辑/);
  const page = await readFile(new URL('../integrations/metacubexd/overlay/packages/ui/pages/rules.vue', import.meta.url), 'utf8');
  assert.match(page, /<NativeRules[^>]*:group="groupFilter"/);
});

test('effective group rules ignore saved filters, track the group and keep navigation filters temporary', async () => {
  const source = await readFile(new URL('../integrations/metacubexd/overlay/packages/ui/components/NativeRules.vue', import.meta.url), 'utf8');
  const script = source.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)![1]
    .replace(/^import[\s\S]*?from '[^']+'\r?$/gm, '') +
    '\nexport { filteredRules, filters, tabs, toggleRuleTypeFilter, toggleRulePolicyFilter, clearRuleFilters };';
  const code = ts.transpileModule(script, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const sampleRules = [
    { index: 0, type: 'DomainSuffix', payload: 'microsoft.com', proxy: 'Microsoft' },
    { index: 1, type: 'Domain', payload: 'custom.example', proxy: 'Microsoft' },
    { index: 2, type: 'DomainSuffix', payload: 'other.example', proxy: 'Other' },
    { index: 3, type: 'DomainSuffix', payload: 'similar.example', proxy: 'Microsoft Extra' },
  ];
  function mount(group?: string) {
    const props = { group };
    const saved = { rulesTypeFilter: ['IPCIDR'], rulesPolicyFilter: ['Other'], rulesStatusFilter: 'disabled', rulesOrderingType: 'order',
      resetRulesFilters() { this.rulesTypeFilter = []; this.rulesPolicyFilter = []; this.rulesStatusFilter = 'all'; } };
    const original = JSON.stringify(saved);
    const watchers: (() => void)[] = [];
    const exports = {} as {
      filteredRules: { readonly value: typeof sampleRules };
      tabs: { readonly value: { count: number }[] };
      toggleRuleTypeFilter: (value: string) => void;
      toggleRulePolicyFilter: (value: string) => void;
      clearRuleFilters: () => void;
    };
    new Script(code, { filename: 'NativeRules.js' }).runInNewContext({
      exports, defineProps: () => props,
      ref: (value: unknown) => ({ value }), computed: (get: () => unknown) => ({ get value() { return get(); } }),
      watch: (_get: unknown, callback: () => void) => watchers.push(callback),
      useI18n: () => ({ t: (key: string) => key, locale: { value: 'zh' } }), useHead() {},
      useConfigStore: () => saved, RULES_ORDERING_TYPE_ORDER: [],
      useRulesQuery: () => ({ data: { value: sampleRules }, isLoading: { value: false } }),
      useRuleProvidersQuery: () => ({ data: { value: [] }, isLoading: { value: false } }),
      useUpdateRuleProviderMutation: () => ({}), useToggleRuleDisabledMutation: () => ({}),
      useStringBooleanMap: () => ({ map: {}, setWithCallback() {} }), useVirtualizer: () => ({}),
      filterRules: (values: typeof sampleRules, options: { types: string[]; policies: string[]; status: string }) => values.filter(rule =>
        (!options.types.length || options.types.includes(rule.type)) && (!options.policies.length || options.policies.includes(rule.proxy)) && options.status !== 'disabled'),
      sortRulesByOrderingType: (values: unknown) => values,
    });
    return { ...exports, props, saved, original, changeGroup: (value?: string) => { props.group = value; watchers[0](); } };
  }
  const ui = mount('Microsoft');
  assert.deepEqual(Array.from(ui.filteredRules.value), sampleRules.slice(0, 2));
  assert.equal(ui.tabs.value[0].count, 2);
  ui.toggleRuleTypeFilter('Domain');
  assert.deepEqual(Array.from(ui.filteredRules.value), [sampleRules[1]]);
  ui.clearRuleFilters();
  assert.deepEqual(Array.from(ui.filteredRules.value), sampleRules.slice(0, 2));
  ui.changeGroup('Other');
  assert.deepEqual(Array.from(ui.filteredRules.value), [sampleRules[2]]);
  ui.changeGroup('Microsoft');
  assert.deepEqual(Array.from(ui.filteredRules.value), sampleRules.slice(0, 2));
  ui.changeGroup(''); // View all targets without restoring unrelated saved filters.
  assert.deepEqual(Array.from(ui.filteredRules.value), sampleRules);
  ui.toggleRulePolicyFilter('Microsoft');
  assert.equal(JSON.stringify(ui.saved), ui.original);

  const ordinary = mount();
  assert.equal(ordinary.filteredRules.value.length, 0); // Ordinary visits retain saved filters.
  ordinary.clearRuleFilters();
  assert.deepEqual(Array.from(ordinary.filteredRules.value), sampleRules);
  ordinary.toggleRulePolicyFilter('Other');
  assert.deepEqual(Array.from(ordinary.filteredRules.value), [sampleRules[2]]);
  assert.deepEqual(Array.from(ordinary.saved.rulesPolicyFilter), ['Other']);
});

test('shared exit dependents include default selections and track only current direct service references', async () => {
  const ui = await editor([], 'Proxy');
  ui.view.value.groups = [
    { name: 'Proxy', role: 'shared', selected: 'node-a' },
    { name: 'OpenAI', role: 'service', selected: 'Proxy' }, // No explicit user selection.
    { name: 'Work', role: 'service', selected: 'Proxy' },
    { name: 'Domestic', role: 'service', selected: 'DIRECT' },
    { name: 'Stream', role: 'service', selected: 'Work' }, // Indirect references are excluded.
    { name: 'Old', role: 'service', selected: 'node-a' },
    { name: 'Other Exit', role: 'shared', selected: 'Proxy' },
  ];
  ui.settings.local.selections.Old = 'Proxy'; // Stale override must not win over the complete view.
  assert.deepEqual(Array.from(ui.dependents.value), ['OpenAI', 'Work']);
  ui.view.value.groups[1].selected = 'DIRECT';
  assert.deepEqual(Array.from(ui.dependents.value), ['Work']);
});

test('group rule add, edit and delete operations apply immediately while preserving unrelated positions', async () => {
  const initial = ['DOMAIN,first.example,Stream', 'DOMAIN,old.example,Work', 'IP-CIDR,192.0.2.0/24,Stream', 'DOMAIN,last.example,Work'];
  const ui = await editor(initial);
  ui.edit(1);
  ui.drafts.value[0].payload = 'edited.example';
  await ui.submitEditor();
  assert.deepEqual(ui.settings.local.rules, [initial[0], 'DOMAIN,edited.example,Work', initial[2], initial[3]]);
  assert.equal(ui.saves(), 1);

  ui.openAdd();
  ui.drafts.value[0].payload = 'new.example\nsecond.example';
  await ui.submitEditor();
  assert.equal(ui.saves(), 2); // The two additions share one settings write and activation.
  assert.deepEqual(ui.settings.local.rules, [initial[0], 'DOMAIN,edited.example,Work', initial[2], initial[3],
    'DOMAIN-SUFFIX,new.example,Work', 'DOMAIN-SUFFIX,second.example,Work']);

  ui.requestRemove(3);
  await ui.confirmRemove();
  assert.equal(ui.saves(), 3);
  assert.deepEqual(ui.settings.local.rules, [initial[0], 'DOMAIN,edited.example,Work', initial[2],
    'DOMAIN-SUFFIX,new.example,Work', 'DOMAIN-SUFFIX,second.example,Work']);
  assert.deepEqual(ui.settings.local.selections, { Work: 'Proxy', Stream: 'node-a' });
  assert.equal(ui.listChanged.value, false);
  assert.match(ui.saved.value, /已删除并生效/);
  const reopened = await editor(ui.settings.local.rules);
  assert.deepEqual(Array.from(reopened.ownRules.value, (entry: any) => entry.value),
    ['DOMAIN,edited.example,Work', 'DOMAIN-SUFFIX,new.example,Work', 'DOMAIN-SUFFIX,second.example,Work']);
});

test('group rules reject stale writes and keep a failed confirmed change available for retry', async () => {
  const ui = await editor(['DOMAIN,old.example,Work']);
  ui.openAdd();
  ui.drafts.value[0].payload = 'new.example';
  ui.settings.local.rules.push('DOMAIN,external.example,Stream');
  await ui.submitEditor();
  assert.match(ui.error.value, /规则已发生变化/);
  assert.deepEqual(ui.settings.local.rules, ['DOMAIN,old.example,Work', 'DOMAIN,external.example,Stream']);
  assert.equal(ui.listChanged.value, false);

  const failed = await editor([]);
  failed.openAdd();
  failed.drafts.value[0].payload = 'new.example';
  failed.fail();
  await failed.submitEditor();
  assert.match(failed.error.value, /合成应用失败/);
  assert.equal(failed.listChanged.value, true);
  assert.deepEqual(Array.from(failed.entries.value), ['DOMAIN-SUFFIX,new.example,Work']);
  assert.deepEqual(failed.settings.local.rules, []);
  failed.recover();
  await failed.retry();
  assert.equal(failed.listChanged.value, false);
  assert.deepEqual(failed.settings.local.rules, ['DOMAIN-SUFFIX,new.example,Work']);
});

test('group rule activation failure records persisted deletion and retries only the pending application', async () => {
  const ui = await editor(['DOMAIN-SUFFIX,new.example,Work']);
  ui.fail(new CoCoProxyError('ACTIVATION_FAILED'), true, true);
  ui.requestRemove(0);
  await ui.confirmRemove();
  assert.deepEqual(ui.settings.local.rules, []);
  assert.equal(ui.listChanged.value, false);
  assert.equal(ui.pendingApply.value, true);
  assert.equal(ui.needsRead.value, false);
  assert.match(ui.error.value, /尚未生效/);
  ui.recover();
  await ui.retry();
  assert.equal(ui.error.value, '');
  assert.equal(ui.pendingApply.value, false);
  assert.match(ui.saved.value, /已生效/);
});

test('group rule lost response accepts the server-confirmed result without another write', async () => {
  const ui = await editor(['DOMAIN,old.example,Work']);
  ui.fail(new CoCoProxyError('NETWORK_UNKNOWN'), true);
  ui.requestRemove(0);
  await ui.confirmRemove();
  const writes = ui.saves();
  assert.equal(ui.saves(), writes);
  assert.equal(ui.error.value, '');
  assert.equal(ui.listChanged.value, false);
  assert.equal(ui.needsRead.value, false);
  assert.match(ui.saved.value, /已删除并生效/);
});

test('group domain batch form rejects invalid and duplicate lines before writing', async () => {
  const ui = await editor(['DOMAIN-SUFFIX,example.com,Work']);
  ui.openAdd();
  ui.drafts.value[0].payload = 'https://example.com/path';
  await ui.submitEditor();
  assert.match(ui.formError.value, /协议、路径或端口/);
  ui.drafts.value[0].type = 'DOMAIN-REGEX';
  ui.drafts.value[0].payload = '[';
  await ui.submitEditor();
  assert.match(ui.formError.value, /正则表达式无效/);
  ui.drafts.value[0].type = 'DOMAIN-SUFFIX';
  ui.drafts.value[0].payload = 'example.com\nexample.com';
  await ui.submitEditor();
  assert.match(ui.formError.value, /相同规则/);
  assert.equal(ui.saves(), 0);
  assert.deepEqual(Array.from(ui.entries.value), ['DOMAIN-SUFFIX,example.com,Work']);
  const component = await readFile(new URL('../integrations/metacubexd/overlay/packages/ui/components/GroupMatchingRules.vue', import.meta.url), 'utf8');
  assert.match(component, /添加 \$\{draftCount\} 条并生效/);
  assert.doesNotMatch(component, />保存规则</);
  assert.throws(() => rules.saveGroupRules(['DOMAIN,other.example,Stream'], ['DOMAIN,other.example,Stream'], [], 'Work'), /其他策略组/);
  assert.equal(rules.ruleTarget('MATCH,Other'), 'Other');
  assert.match(rules.templateRuleLabel('RULE-SET,cocoproxy-domestic-domain-v2,Domestic'), /国内域名集合/);
});

test('group creation opens rule settings only after successful creation and preserves existing settings', async () => {
  const source = await readFile(new URL('../integrations/metacubexd/overlay/packages/ui/components/WorkspaceGroupsMenu.vue', import.meta.url), 'utf8');
  const script = source.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)![1].replace(/^import .*$/gm, '') + '\nexport { add, addShared, customName };';
  const code = ts.transpileModule(script, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const settings = { local: { rules: ['DOMAIN,existing.example,OpenAI'], selections: { Proxy: 'node-a', OpenAI: 'Proxy' } as Record<string, string> } };
  const view = { value: { nodes: ['node-a'], catalog: [{ id: 'Proxy', default: true }, { id: 'OpenAI', default: true }, { id: 'Steam', default: false }], groups: [
    { name: 'Proxy', role: 'shared', selected: 'node-a' }, { name: 'OpenAI', role: 'service', selected: 'Proxy' },
  ] } };
  const calls: string[] = [];
  let failed = false;
  const exports: Record<string, any> = {};
  new Script(code).runInNewContext({
    ...rules, exports,
    defineProps: () => ({ activeGroup: 'Proxy', configure: (name: string) => calls.push(`configure:${name}`) }),
    ref: (value: unknown) => ({ value }), computed: (get: () => unknown) => ({ get value() { return get(); } }),
    useProxyRefresh: () => ({ refresh: async () => { calls.push('refresh'); } }),
    useWorkspace: () => ({ view, workspace: { value: { mode: 'local' } }, overrides: { value: settings.local }, busy: { value: false },
      run: async (fn: () => Promise<void>) => { try { await fn(); } catch { calls.push('failed'); } },
      save: async (edit: (value: typeof settings) => void) => { if (failed) throw new Error('合成应用失败'); edit(settings); calls.push('save'); } }),
  });
  await exports.add(' Work ');
  assert.equal(settings.local.selections.Work, 'Proxy');
  assert.equal(settings.local.selections.OpenAI, 'Proxy');
  assert.deepEqual(settings.local.rules, ['DOMAIN,existing.example,OpenAI']);
  assert.deepEqual(calls, ['save', 'refresh', 'configure:Work']);
  calls.length = 0;
  await exports.add('Steam', true);
  assert.deepEqual(calls, ['save', 'refresh']); // Preset service already has built-in matching rules.
  calls.length = 0;
  failed = true;
  await exports.add('Failed');
  assert.deepEqual(calls, ['failed']);
  assert.equal(settings.local.selections.Failed, undefined);
  assert.match(rules.localGroupNameError('node-a', view.value), /节点名称/);
  assert.match(rules.localGroupNameError('DIRECT', view.value), /保留/);
  assert.match(rules.localGroupNameError('Steam', view.value), /预置服务/);
  assert.match(rules.localGroupNameError('AI,Exit', view.value), /逗号/);
});

test('local rule targets exclude user-shared exits while retaining Proxy and subscription targets', () => {
  const groups = [{ name: 'Proxy', role: 'shared' as const }, { name: 'AI Exit', role: 'shared' as const }, { name: 'Work', role: 'service' as const }];
  assert.deepEqual(rules.customRuleTargets('local', groups), ['DIRECT', 'REJECT', 'Proxy', 'Work']);
  assert.deepEqual(rules.customRuleTargets('subscription', groups), ['DIRECT', 'REJECT', 'Proxy', 'AI Exit', 'Work']);
  assert.deepEqual(rules.customRuleTargets('legacy', groups), ['DIRECT', 'REJECT', 'Proxy', 'AI Exit', 'Work']);
});
