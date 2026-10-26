import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Script } from 'node:vm';
import test from 'node:test';
import ts from '../tooling/node_modules/typescript/lib/typescript.js';
import * as rules from '../integrations/metacubexd/overlay/packages/ui/utils/group-rules.ts';

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
  return { ...exports, settings, workspace, saves: () => saves, fail: () => { failApply = true; } };
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
