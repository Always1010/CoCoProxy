import { readFileSync } from 'node:fs';
import { Script } from 'node:vm';
import ts from '../tooling/node_modules/typescript/lib/typescript.js';

export const uiMessages = Object.fromEntries(['en', 'zh'].map(locale => [locale,
  JSON.parse(readFileSync(new URL(`../integrations/metacubexd/overlay/packages/ui/i18n/locales/${locale}.json`, import.meta.url), 'utf8')),
])) as Record<string, Record<string, any>>;

export function createUiI18n(initialLocale = 'zh') {
  const locale = { value: initialLocale };
  const t = (key: string, named: Record<string, unknown> = {}): string => {
    const message = key.split('.').reduce<any>((value, part) => value?.[part], uiMessages[locale.value]);
    return typeof message === 'string' ? message.replace(/\{(\w+)\}/g, (match, name) => String(named[name] ?? match)) : key;
  };
  return { t, locale };
}

export const useI18n = () => createUiI18n();
export const useNuxtApp = () => ({ $i18n: useI18n() });
export const shallowRef = (value: unknown) => ({ value });
export const computed = (get: () => unknown) => ({ get value() { return get(); } });

const exports: Record<string, any> = {};
new Script(ts.transpileModule(readFileSync(new URL('../integrations/metacubexd/overlay/packages/ui/composables/useLocalizedMessage.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText).runInNewContext({
  exports,
  shallowRef: (value: unknown) => ({ value }),
  computed: (options: { get: () => unknown; set: (value: unknown) => void }) => ({
    get value() { return options.get(); }, set value(value: unknown) { options.set(value); },
  }),
});
export const useLocalizedMessage = exports.useLocalizedMessage as () => { get value(): string; set value(value: string | (() => string)) };
export const uiTestContext = { useI18n, useNuxtApp, useLocalizedMessage, shallowRef, computed };
