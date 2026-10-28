import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { Script } from 'node:vm';
import test from 'node:test';
import ts from '../tooling/node_modules/typescript/lib/typescript.js';
import { createUiI18n, uiMessages, useLocalizedMessage } from './ui-i18n-helpers.ts';
import { domainRuleError, templateRuleLabel } from '../integrations/metacubexd/overlay/packages/ui/utils/group-rules.ts';
import { BANDWIDTH_FIELDS } from '../packages/management/bandwidth-policy.ts';

const ui = new URL('../integrations/metacubexd/overlay/packages/ui/', import.meta.url);
function leaves(value: Record<string, any>, prefix = ''): Record<string, string> {
  return Object.assign({}, ...Object.entries(value).map(([key, item]) => typeof item === 'string'
    ? { [prefix + key]: item } : leaves(item, `${prefix}${key}.`)));
}

test('the UI supports only English and Chinese and all referenced custom messages exist in both', () => {
  const config = readFileSync(new URL('nuxt.config.ts', ui), 'utf8');
  const localeCodes = [...config.matchAll(/\{ code: '([^']+)', name:/g)].map(match => match[1]);
  assert.deepEqual(localeCodes, ['en', 'zh']);
  const en = leaves(uiMessages.en), zh = leaves(uiMessages.zh);
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort());
  for (const [key, value] of Object.entries(en)) assert.doesNotMatch(value, /\p{Script=Han}/u, key);
  for (const file of readdirSync(ui, { recursive: true }).map(String).filter(file => /\.(vue|ts)$/.test(file) && !file.includes('__tests__'))) {
    const source = readFileSync(new URL(file.replaceAll('\\', '/'), ui), 'utf8');
    for (const match of source.matchAll(/['"](coco\.[\w.]+)['"]/g)) {
      const key = match[1];
      if (!key.endsWith('.')) assert.ok(key in en, `${file}: missing ${key}`);
    }
  }
  assert.deepEqual(Object.keys(uiMessages.en.coco.bandwidthField).sort(), Object.keys(BANDWIDTH_FIELDS).sort());
});

test('existing errors, feedback, and rule descriptions change language while preserving user input', () => {
  const i18n = createUiI18n('zh');
  const exports: Record<string, any> = {};
  new Script(ts.transpileModule(readFileSync(new URL('composables/useCoCoProxy.ts', ui), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText).runInNewContext({ exports, Error });
  const failure = new exports.CoCoProxyError('INVALID_CREDENTIALS');
  const error = useLocalizedMessage();
  error.value = () => exports.cocoproxyErrorMessage(failure, i18n.t);
  assert.equal(error.value, '用户名或密码不正确。');
  i18n.locale.value = 'en';
  assert.equal(error.value, 'Incorrect username or password.');
  assert.match(domainRuleError('DOMAIN', 'https://example.test', i18n.t), /only a domain/);
  assert.match(templateRuleLabel('RULE-SET,cocoproxy-domestic-domain-v2,Domestic', i18n.t), /domestic domain set/);
  const group = '我的自定义组';
  const feedback = useLocalizedMessage();
  feedback.value = () => i18n.t('coco.switched', { group, name: '日本节点' });
  assert.equal(feedback.value, 'Switched: 我的自定义组 → 日本节点');
  i18n.locale.value = 'zh';
  assert.equal(feedback.value, '已切换：我的自定义组 → 日本节点');
  assert.equal(exports.cocoproxyErrorMessage(new exports.CoCoProxyError('UNKNOWN_CODE'), i18n.t), i18n.t('coco.operationFailed'));
});
