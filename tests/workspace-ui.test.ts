import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Script } from 'node:vm';
import test from 'node:test';
import ts from '../tooling/node_modules/typescript/lib/typescript.js';

const source = await readFile(new URL('../integrations/metacubexd/overlay/packages/ui/composables/useWorkspace.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;

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
    assert.equal('Stream' in target.automatic, false);
    assert.deepEqual(target.automatic.Work, automatic.Work);
    const untouched = mode === 'local' ? settings.subscriptionOverrides.sample : settings.local;
    assert.deepEqual(untouched.automatic, automatic);
    assert.deepEqual(calls, ['/api/cocoproxy/workspace', '/api/cocoproxy/workspace/apply', '/api/cocoproxy/workspace', '/api/clash/proxies']);
    assert.match(String(states.get('cocoproxy-workspace-feedback')?.value), /已切换/);
  });
}
