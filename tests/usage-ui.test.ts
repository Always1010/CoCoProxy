import { uiTestContext, useI18n } from './ui-i18n-helpers.ts';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Script } from 'node:vm';
import test from 'node:test';
import ts from '../tooling/node_modules/typescript/lib/typescript.js';
import * as usageRules from '../integrations/metacubexd/overlay/packages/ui/utils/usage-rules.ts';
import { customRuleTargets } from '../integrations/metacubexd/overlay/packages/ui/utils/group-rules.ts';

const source = await readFile(new URL('../integrations/metacubexd/overlay/packages/ui/pages/traffic.vue', import.meta.url), 'utf8');
const script = source.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)![1];
const code = ts.transpileModule(script.replace(/^import .*$/gm, '') + `
globalThis.ui = { refresh, select, toggle, loadExpanded, changeSort, view, selected, range, overview, details, expanded,
  busy, refreshing, detailBusy, expandedBusy, error, detailError, managing, checkedRows, toggleManagement, checkPage,
  deleteRows, deleteDialog, afterDelete, detailPage };
`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;

function harness() {
  const data = (body: any) => ({
    rows: body.overview
      ? [{ label: '192.0.2.20', upload: 10, download: 20, total: 30, count: 1 }]
      : [{ label: body.filters?.host ? 'DIRECT' : 'example.test', upload: 10, download: 20, total: 30, count: 1 }],
    totalRows: 1, aliases: {}, resolution: 'minute', trend: [],
    summary: { upload: 10, download: 20, sources: 1, unattributed: 0 },
    status: { startedAt: 1, lastSampleAt: 2, lastCommittedAt: 2, detailAvailableFrom: 1 }, collecting: true,
  });
  let reply: (body: any) => Promise<any> = async body => data(body);
  const date = (value: any = Date.now()): any => ({
    valueOf: () => new Date(value).valueOf(), format: () => '2026-10-28T12:00',
    subtract: (days: number) => date(new Date(value).valueOf() - days * 86400000),
  });
  const context: any = { ...uiTestContext,
    ref: (value: unknown) => ({ value }), computed: (get: () => unknown) => ({ get value() { return get(); } }),
    useHead() {}, watch() {}, onMounted() {}, onBeforeUnmount() {}, useDebounceFn: (fn: unknown) => fn,
    onClickOutside() {}, onKeyStroke() {},
    dayjs: date, AbortController, document: { hidden: false },
    IconDevices: {}, IconWorld: {}, IconArrowsExchange: {}, IconCpu: {}, IconUser: {},
    useCoCoProxy: () => ({ request: async (_path: string, options: any) => reply(options.body) }),
    cocoproxyErrorMessage: () => '读取失败',
  };
  new Script(code).runInNewContext(context);
  return { ui: context.ui, data, setReply(value: typeof reply) { reply = value; } };
}

test('usage background refresh retains displayed data and keeps refresh and detail feedback quiet', async () => {
  const { ui, data, setReply } = harness();
  await ui.refresh();
  await ui.toggle(ui.details.value.rows[0]);
  const overview = ui.overview.value, details = ui.details.value, children = ui.expanded.value['example.test'].rows, range = ui.range.value;
  let complete!: () => void;
  const pending = new Promise<void>(resolve => { complete = resolve; });
  const observed: { kind: string; busy: boolean; retained: boolean }[] = [];
  setReply(async body => {
    if (body.overview) await pending;
    else if (body.filters.host) {
      observed.push({ kind: 'expanded', busy: ui.expandedBusy.value, retained: ui.expanded.value['example.test'].rows === children });
    } else {
      observed.push({ kind: 'detail', busy: ui.detailBusy.value, retained: ui.details.value === details });
    }
    return data(body);
  });
  const updating = ui.refresh(true);
  assert.equal(ui.busy.value, true);
  assert.equal(ui.refreshing.value, false);
  assert.equal(ui.overview.value, overview);
  assert.equal(ui.range.value, range);
  complete();
  await updating;
  assert.deepEqual(observed, [{ kind: 'detail', busy: false, retained: true }, { kind: 'expanded', busy: false, retained: true }]);
  assert.equal(ui.busy.value, false);
  assert.equal(ui.overview.value, overview);
  assert.equal(ui.details.value, details);
  assert.equal(ui.expanded.value['example.test'].rows, children);
  assert.notEqual(ui.range.value, range);
});

test('usage expansions are independent and late responses cannot reopen a closed or replaced row', async () => {
  const { ui, data, setReply } = harness();
  await ui.refresh();
  await ui.toggle({ label: 'first.example' });
  await ui.toggle({ label: 'second.example' });
  assert.deepEqual(Object.keys(ui.expanded.value), ['first.example', 'second.example']);
  const second = ui.expanded.value['second.example'];
  second.page = 1;
  setReply(async body => {
    if (body.filters?.host === 'first.example') throw new Error('synthetic row failure');
    return data(body);
  });
  await ui.loadExpanded('first.example', true);
  assert.match(ui.expanded.value['first.example'].error(), /显示上次数据/);
  assert.equal(second.error, null);
  assert.equal(second.page, 1);

  let complete!: () => void;
  setReply(async body => { await new Promise<void>(resolve => { complete = resolve; }); return data(body); });
  const pending = ui.loadExpanded('first.example');
  await ui.toggle({ label: 'first.example' });
  complete(); await pending;
  assert.equal(ui.expanded.value['first.example'], undefined);
  assert.equal(ui.expanded.value['second.example'], second);
  setReply(async body => data(body));
  await ui.select('192.0.2.30');
  assert.deepEqual(Object.keys(ui.expanded.value), []);
});

test('usage management scopes selection to displayed rows and deletion discards late reads while retaining unrelated expansions', async () => {
  const { ui, data, setReply } = harness();
  const response = (body: any, removed = false) => ({ ...data(body), ...(!body.overview && !body.filters?.host ? {
    rows: [!removed && { label: 'example.test', upload: 10, download: 20, total: 30 }, { label: 'keep.example', upload: 10, download: 20, total: 30 }].filter(Boolean), totalRows: removed ? 1 : 2,
  } : {}) });
  setReply(async body => response(body));
  await ui.refresh(); await ui.toggle({ label: 'keep.example' });
  const kept = ui.expanded.value['keep.example'];
  let complete!: () => void;
  setReply(async body => { await new Promise<void>(resolve => { complete = resolve; }); return response(body); });
  const late = ui.refresh(true);
  ui.toggleManagement(); ui.checkPage();
  assert.equal(ui.checkedRows.value.length, 2);
  let scope: any;
  ui.deleteDialog.value = { open: (value: any) => { scope = value; } };
  ui.deleteRows(['example.test', 'not-on-this-page.example']);
  assert.equal(scope.filters.sourceIP, '192.0.2.20');
  assert.equal(scope.selection.dimension, 'host');
  assert.deepEqual(Array.from(scope.selection.values), ['example.test']);
  assert.equal(scope.startTime, ui.range.value.startTime);
  setReply(async body => response(body, true));
  await ui.afterDelete({ upload: 10, download: 20 });
  complete(); await late;
  assert.equal(ui.details.value.rows.length, 1); assert.equal(ui.details.value.rows[0].label, 'keep.example');
  assert.equal(ui.expanded.value['keep.example'], kept); assert.equal(ui.checkedRows.value.length, 0);
  assert.equal(ui.refreshing.value, false); assert.equal(ui.detailBusy.value, false);
  ui.detailPage.value = 2;
  setReply(async body => ({ ...response(body, true), ...(!body.overview && body.page > 0 ? { rows: [], totalRows: 1 } : {}) }));
  await ui.afterDelete({ upload: 0, download: 0 });
  assert.equal(ui.detailPage.value, 0); assert.equal(ui.details.value.rows[0].label, 'keep.example');
});

test('usage deletion dialog requires explicit clear confirmation and never uses a superseded preview', async () => {
  const source = await readFile(new URL('../integrations/metacubexd/overlay/packages/ui/components/UsageDeleteDialog.vue', import.meta.url), 'utf8');
  const code = ts.transpileModule(source.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)![1].replace(/^import .*$/gm, '') + `
    globalThis.ui = { open, close, readPreview, remove, preview, confirmation, canDelete, invalidate, panel, error, deleting };
  `, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const result = { token: 'frozen-snapshot', scope: { mode: 'all' }, detailRows: 1, dailyRows: 1, upload: 1, download: 10 };
  let reply: (path: string, body: any) => Promise<any> = async () => result;
  const requests: any[] = [], emitted: any[] = [];
  const context: any = { ...uiTestContext,
    ref: (value: unknown) => ({ value }), computed: (get: () => unknown) => ({ get value() { return get(); } }),
    watch() {}, nextTick: async () => {}, onBeforeUnmount() {}, defineExpose() {},
    defineEmits: () => (...args: any[]) => { emitted.push(args); }, AbortController,
    useCoCoProxy: () => ({ request: (path: string, options: any) => { requests.push({ path, body: options.body }); return reply(path, options.body); } }),
    cocoproxyErrorMessage: () => '请求失败',
  };
  new Script(code).runInNewContext(context);
  const ui = context.ui;
  ui.panel.value = { open() {}, close() { ui.close(); } };
  await ui.open({ mode: 'all' }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(ui.canDelete.value, false);
  ui.confirmation.value = useI18n().t('coco.usageClearWord');
  assert.equal(ui.canDelete.value, true);
  // A failed response keeps the same token available for an idempotent retry.
  reply = async () => { throw new Error('synthetic lost response'); };
  await ui.remove(); assert.equal(ui.preview.value.token, result.token); assert.ok(ui.error.value);
  reply = async () => result;
  await ui.remove();
  const confirms = requests.filter(row => row.path.endsWith('/confirm'));
  assert.deepEqual(confirms.map(row => row.body.token), [result.token, result.token]);
  assert.equal(emitted.filter(row => row[0] === 'deleted').length, 1);
  let finish!: (value: unknown) => void;
  reply = () => new Promise(resolve => { finish = resolve; });
  const pending = ui.readPreview();
  ui.invalidate(); finish(result); await pending;
  assert.equal(ui.preview.value, null); assert.equal(ui.canDelete.value, false);
});

test('usage refresh failures retain matching results but never expose results from another query', async () => {
  const { ui, data, setReply } = harness();
  await ui.refresh();
  const overview = ui.overview.value, details = ui.details.value;
  setReply(async () => { throw new Error('synthetic network failure'); });
  await ui.refresh(true);
  assert.equal(ui.overview.value, overview);
  assert.equal(ui.details.value, details);
  assert.match(ui.error.value, /显示上次数据/);

  setReply(async body => {
    if (!body.overview) throw new Error('synthetic detail failure');
    return data(body);
  });
  await ui.refresh(true);
  assert.equal(ui.details.value, details);
  assert.match(ui.detailError.value, /显示上次数据/);
  await ui.select('192.0.2.30');
  assert.equal(ui.details.value, null);
  assert.equal(ui.detailError.value, '读取失败');
  let retryLoading: boolean | undefined;
  setReply(async body => {
    if (!body.overview) {
      retryLoading = ui.detailBusy.value;
      throw new Error('synthetic retry failure');
    }
    return data(body);
  });
  await ui.refresh(true);
  assert.equal(retryLoading, false);

  setReply(async () => { throw new Error('synthetic query failure'); });
  ui.view.value = 'host';
  await ui.refresh();
  assert.equal(ui.overview.value, null);
  assert.equal(ui.details.value, null);
  assert.equal(ui.error.value, '读取失败');
});

test('quick routing validates domains and exact IPs, normalizes networks and preserves unrelated rules', () => {
  const { usageTarget, usageRuleDefault, usageRulePlan, usageRulePayload } = usageRules;
  assert.deepEqual(usageRuleDefault(usageTarget('Video.Example.')!), { type: 'DOMAIN', payload: 'video.example' });
  assert.deepEqual(usageRuleDefault(usageTarget('192.0.2.8')!), { type: 'IP-CIDR', payload: '192.0.2.8/32' });
  assert.deepEqual(usageRuleDefault(usageTarget('[2001:db8::8]')!), { type: 'IP-CIDR6', payload: '2001:db8::8/128' });
  assert.equal(usageRulePayload('IP-CIDR', '192.0.2.8/24'), '192.0.2.0/24');
  assert.equal(usageRulePayload('IP-CIDR6', '2001:db8::8/64'), '2001:db8::/64');
  for (const bad of ['Unknown', 'Unattributed', 'Inner', 'https://video.example', 'video.example:443', '127.1', '999.1.1.1', '0127.0.0.1', '0x7f000001', '::invalid', 'video.example,Proxy']) assert.equal(usageTarget(bad), null, bad);
  for (const [type, payload] of [['IP-CIDR', '2001:db8::1/32'], ['IP-CIDR6', '192.0.2.1/32'], ['IP-CIDR', '192.0.2.1/33'], ['DOMAIN', '192.0.2.1']] as const) assert.equal(usageRulePayload(type, payload), null);
  const rules = ['DOMAIN,unrelated.example,Other', 'DOMAIN,video.example,Domestic', 'DOMAIN,VIDEO.EXAMPLE,Stream'];
  const result = usageRulePlan(rules, 'DOMAIN', 'Video.Example', 'Work')!;
  assert.equal(result.conflicts.length, 2);
  assert.deepEqual(result.rules, ['DOMAIN,video.example,Work', rules[0]]);
  assert.equal(usageRulePlan(result.rules, 'DOMAIN', 'video.example', 'Work')!.duplicate, true);
  assert.equal(usageRulePlan(['IP-CIDR,192.0.2.8/24,DIRECT,no-resolve'], 'IP-CIDR', '192.0.2.0/24', 'Work')!.conflicts.length, 1);
});

async function quickRuleDialog(initial: string[] = [], mode = 'local') {
  const source = await readFile(new URL('../integrations/metacubexd/overlay/packages/ui/components/UsageRuleDialog.vue', import.meta.url), 'utf8');
  const script = source.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)![1].replace(/^import .*$/gm, '') +
    '\nglobalThis.ui = { panel, open, reread, submit, close, type, payload, target, replace, canSave, plan, needsRead, savedAttempt, error };';
  const settings = { mode, subscriptionId: mode === 'subscription' ? 'profile-a' : null, sourceIds: ['source-a'], runMode: 'rule',
    local: { selections: {}, rules: [...initial] }, subscriptionOverrides: { 'profile-a': { selections: {}, rules: [...initial] } } };
  const view = { value: { workspace: { ...settings, revision: 1 }, pending: false,
    groups: [{ name: 'Work', role: 'service' }, { name: 'Stream', role: 'service' }, { name: 'Shared', role: 'shared' }] } };
  const overrides = () => mode === 'local' ? settings.local : settings.subscriptionOverrides['profile-a'];
  let saves = 0, failApply = false, failRead = false;
  const notices: { message: string; options: { duration: number; description?: string } }[] = [];
  const closed: boolean[] = [], opened: boolean[] = [];
  const context: any = { ...uiTestContext, ...usageRules, customRuleTargets,
    ref: (value: unknown) => ({ value }), computed: (get: () => unknown) => ({ get value() { return get(); } }),
    defineEmits: () => (_event: string, value: boolean) => opened.push(value), defineExpose() {}, watch() {},
    toast: { success: (message: string, options: typeof notices[number]['options']) => notices.push({ message, options }) },
    cocoproxyErrorMessage: () => '合成请求失败',
    useWorkspace: () => ({ view, workspace: { get value() { return view.value.workspace; } }, overrides: { get value() { return overrides(); } }, busy: { value: false },
      load: async () => { if (failRead) throw Error('read failed'); },
      run: async (action: () => Promise<void>) => action(),
      editOverrides: (draft: typeof settings) => mode === 'local' ? draft.local : draft.subscriptionOverrides['profile-a'],
      save: async (edit: (draft: typeof settings) => void) => {
        saves++; edit(settings); view.value.workspace.revision++;
        if (failApply) { view.value.pending = true; throw Error('apply failed'); }
        view.value.pending = false;
      } }),
  };
  new Script(ts.transpileModule(script, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText).runInNewContext(context);
  context.ui.panel.value = { open() {}, close(force: boolean) { closed.push(force); context.ui.close(); } };
  return { ui: context.ui, settings, view, notices, closed, opened, saves: () => saves, failApply(value: boolean) { failApply = value; }, failRead(value: boolean) { failRead = value; } };
}

test('quick routing requires explicit conflict replacement, scopes subscription overrides and blocks stale or unapplied settings', async () => {
  const h = await quickRuleDialog(['DOMAIN,video.example,DIRECT'], 'subscription');
  await h.ui.open('video.example'); h.ui.target.value = 'Work';
  assert.equal(h.ui.canSave.value, false);
  await h.ui.submit(); assert.equal(h.saves(), 0);
  h.ui.replace.value = true; assert.equal(h.ui.canSave.value, true);
  await h.ui.submit(); assert.equal(h.saves(), 1);
  assert.deepEqual(Array.from(h.settings.subscriptionOverrides['profile-a'].rules), ['DOMAIN,video.example,Work']);
  assert.deepEqual(h.settings.local.rules, ['DOMAIN,video.example,DIRECT']);
  assert.deepEqual(h.closed, [true]);
  assert.deepEqual(h.opened, [true, false]);
  assert.equal(h.notices.length, 1);
  assert.equal(h.notices[0].message, '规则已保存');
  assert.equal(h.notices[0].options.duration, 2500);
  assert.equal(h.notices[0].options.description, undefined);
  assert.equal(h.ui.canSave.value, false);
  const pending = await quickRuleDialog(); pending.view.value.pending = true;
  await pending.ui.open('192.0.2.8'); pending.ui.target.value = 'Work';
  assert.equal(pending.ui.canSave.value, false); await pending.ui.submit(); assert.equal(pending.saves(), 0);
  assert.equal(pending.closed.length, 0); assert.equal(pending.notices.length, 0);
  const stale = await quickRuleDialog(); await stale.ui.open('video.example'); stale.ui.target.value = 'Work';
  stale.view.value.workspace.revision++; await stale.ui.submit(); assert.equal(stale.saves(), 0);
  assert.equal(stale.closed.length, 0); assert.equal(stale.notices.length, 0);
  const direct = await quickRuleDialog(); direct.view.value.workspace.runMode = 'direct';
  await direct.ui.open('video.example'); direct.ui.target.value = 'Work'; await direct.ui.submit();
  assert.deepEqual(direct.closed, [true]);
  assert.match(direct.notices[0].options.description!, /切回规则模式/);
});

test('quick routing distinguishes saved rules from activation and retries only its own verified revision', async () => {
  const h = await quickRuleDialog(); await h.ui.open('2001:db8::8'); h.ui.target.value = 'Work'; h.failApply(true);
  await h.ui.submit(); assert.equal(h.saves(), 1); assert.equal(h.ui.needsRead.value, true);
  assert.match(h.ui.error.value, /已保存/);
  assert.equal(h.closed.length, 0); assert.equal(h.notices.length, 0);
  await h.ui.submit(true); assert.equal(h.saves(), 1);
  h.failRead(true); await h.ui.reread(); assert.equal(h.ui.needsRead.value, true);
  h.failRead(false); await h.ui.reread(); assert.equal(h.ui.needsRead.value, false);
  h.failApply(false); await h.ui.submit(true); assert.equal(h.saves(), 2);
  assert.deepEqual(h.closed, [true]); assert.equal(h.notices.length, 1);
  assert.deepEqual(Array.from(h.settings.local.rules), ['IP-CIDR6,2001:db8::8/128,Work']);
  const changed = await quickRuleDialog(); await changed.ui.open('video.example'); changed.ui.target.value = 'Work'; changed.failApply(true);
  await changed.ui.submit(); await changed.ui.reread();
  changed.view.value.workspace.revision++;
  await changed.ui.submit(true); assert.equal(changed.saves(), 1); assert.equal(changed.ui.needsRead.value, true);
});
