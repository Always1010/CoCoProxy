import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Script } from 'node:vm';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import ts from '../tooling/node_modules/typescript/lib/typescript.js';
import * as rules from '../integrations/metacubexd/overlay/packages/ui/utils/group-rules.ts';

test('group rule utility passes strict indexed-access type checks', () => {
  const program = ts.createProgram({
    rootNames: [fileURLToPath(new URL('../integrations/metacubexd/overlay/packages/ui/utils/group-rules.ts', import.meta.url))],
    options: { noEmit: true, strict: true, noUncheckedIndexedAccess: true, skipLibCheck: true,
      target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, types: [] },
  });
  assert.deepEqual(ts.getPreEmitDiagnostics(program).map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')), []);
});

async function editor(initial: string[]) {
  const source = await readFile(new URL('../integrations/metacubexd/overlay/packages/ui/components/GroupMatchingRules.vue', import.meta.url), 'utf8');
  const script = source.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)![1].replace(/^import .*$/gm, '') +
    '\nexport { entries, original, type, payload, editing, error, dirty, ownRules, add, edit, remove, persist };';
  const code = ts.transpileModule(script, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const settings = { local: { rules: [...initial], selections: { Work: 'Proxy', Stream: 'node-a' } } };
  const view = { value: { groups: [{ name: 'Work', role: 'service' }], rules: [] } };
  const workspace = { value: { mode: 'local', runMode: 'rule' } };
  const exports: Record<string, any> = {};
  let saves = 0, failApply = false;
  new Script(code, { filename: 'GroupMatchingRules.js' }).runInNewContext({
    ...rules, exports, Error, defineProps: () => ({ groupName: 'Work' }), defineEmits: () => () => {},
    ref: (value: unknown) => ({ value }), computed: (get: () => unknown) => ({ get value() { return get(); } }),
    useWorkspace: () => ({ view, workspace, overrides: { value: settings.local }, busy: { value: false },
      save: async (edit: (value: typeof settings) => void) => {
        saves++;
        const draft = structuredClone(settings);
        edit(draft);
        if (failApply) throw new Error('合成应用失败');
        settings.local = draft.local;
      } }),
  });
  return Object.assign(exports, { settings, workspace, saves: () => saves, fail: () => { failApply = true; } });
}

test('group rule edits preserve global positions and unrelated groups, then append new rules', async () => {
  const initial = ['DOMAIN,first.example,Stream', 'DOMAIN,old.example,Work', 'IP-CIDR,192.0.2.0/24,Stream', 'DOMAIN,last.example,Work'];
  const ui = await editor(initial);
  ui.edit(1);
  ui.payload.value = 'edited.example';
  ui.add();
  ui.type.value = 'DOMAIN-SUFFIX';
  ui.payload.value = 'new.example';
  ui.add();
  ui.remove(3);
  assert.deepEqual(ui.settings.local.rules, initial); // Draft changes never save implicitly.
  assert.equal(ui.saves(), 0);
  await ui.persist();
  assert.deepEqual(ui.settings.local.rules, [initial[0], 'DOMAIN,edited.example,Work', initial[2], 'DOMAIN-SUFFIX,new.example,Work']);
  assert.deepEqual(ui.settings.local.selections, { Work: 'Proxy', Stream: 'node-a' });
  assert.equal(ui.dirty.value, false);
  const reopened = await editor(ui.settings.local.rules);
  assert.deepEqual(Array.from(reopened.ownRules.value, (entry: any) => entry.value), ['DOMAIN,edited.example,Work', 'DOMAIN-SUFFIX,new.example,Work']);
  ui.payload.value = 'discarded.example';
  ui.add();
  assert.equal((await editor(ui.settings.local.rules)).entries.value.includes('DOMAIN-SUFFIX,discarded.example,Work'), false);
});

test('group rules block stale drafts, keep failed drafts and require staging the current form', async () => {
  const ui = await editor(['DOMAIN,old.example,Work']);
  ui.payload.value = 'new.example';
  ui.add();
  ui.settings.local.rules.push('DOMAIN,external.example,Stream');
  await ui.persist();
  assert.match(ui.error.value, /规则已发生变化/);
  assert.deepEqual(ui.settings.local.rules, ['DOMAIN,old.example,Work', 'DOMAIN,external.example,Stream']);
  assert.equal(ui.dirty.value, true);

  const failed = await editor([]);
  failed.payload.value = 'new.example';
  failed.add();
  failed.payload.value = 'unstaged.example';
  await failed.persist();
  assert.match(failed.error.value, /添加到列表/);
  assert.equal(failed.saves(), 0);
  failed.payload.value = '';
  failed.fail();
  await failed.persist();
  assert.match(failed.error.value, /合成应用失败/);
  assert.equal(failed.dirty.value, true);
  assert.deepEqual(Array.from(failed.entries.value), ['DOMAIN-SUFFIX,new.example,Work']);
  assert.deepEqual(failed.settings.local.rules, []);
});

test('group domain form rejects URLs, malformed expressions and duplicate rules', async () => {
  const ui = await editor(['DOMAIN-SUFFIX,example.com,Work']);
  ui.payload.value = 'https://example.com/path';
  ui.add();
  assert.match(ui.error.value, /协议、路径或端口/);
  ui.type.value = 'DOMAIN-REGEX';
  ui.payload.value = '[';
  ui.add();
  assert.match(ui.error.value, /正则表达式无效/);
  ui.type.value = 'DOMAIN-SUFFIX';
  ui.payload.value = 'example.com';
  ui.add();
  assert.match(ui.error.value, /相同规则/);
  assert.deepEqual(Array.from(ui.entries.value), ['DOMAIN-SUFFIX,example.com,Work']);
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
