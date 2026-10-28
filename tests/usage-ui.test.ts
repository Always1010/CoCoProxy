import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Script } from 'node:vm';
import test from 'node:test';
import ts from '../tooling/node_modules/typescript/lib/typescript.js';

const source = await readFile(new URL('../integrations/metacubexd/overlay/packages/ui/pages/traffic.vue', import.meta.url), 'utf8');
const script = source.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)![1];
const code = ts.transpileModule(script.replace(/^import .*$/gm, '') + `
globalThis.ui = { refresh, select, toggle, view, selected, range, overview, details, expandedRows,
  busy, refreshing, detailBusy, expandedBusy, error, detailError };
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
  const context: any = {
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
  const overview = ui.overview.value, details = ui.details.value, children = ui.expandedRows.value, range = ui.range.value;
  let complete!: () => void;
  const pending = new Promise<void>(resolve => { complete = resolve; });
  const observed: { kind: string; busy: boolean; retained: boolean }[] = [];
  setReply(async body => {
    if (body.overview) await pending;
    else if (body.filters.host) {
      observed.push({ kind: 'expanded', busy: ui.expandedBusy.value, retained: ui.expandedRows.value === children });
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
  assert.notEqual(ui.overview.value, overview);
  assert.notEqual(ui.range.value, range);
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
