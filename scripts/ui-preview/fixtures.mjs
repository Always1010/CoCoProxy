import { createHash } from 'node:crypto';

export const scenarios = {
  normal: '正常数据', empty: '空节点', many: '大量与长名称', error: '读取失败', slow: '慢速加载', timeout: '检测超时',
};
const clone = value => structuredClone(value);
const stamp = () => new Date().toISOString();
const error = (code, status = 400) => ({ status, data: { error: { code } } });

/** Synthetic state only. No device address, subscription download, or core process. */
export function createFixtures(initial = 'normal') {
  let scenario, settings, nodes, sites, revision, siteRevision, loggedIn;
  function reset(next) {
    if (!Object.hasOwn(scenarios, next)) throw new Error('PREVIEW_SCENARIO_INVALID');
    scenario = next; revision = 1; siteRevision = 1; loggedIn = true;
    nodes = Array.from({ length: next === 'empty' ? 0 : next === 'many' ? 180 : 12 }, (_, i) =>
      `${['香港 HK', '日本 JP', '新加坡 SG', '美国 US'][i % 4]} · 示例 ${String(i + 1).padStart(3, '0')}${next === 'many' ? ' · 用于检查窄屏换行与截断的超长节点名称' : ''}`);
    settings = { mode: 'local', subscriptionId: null, sourceIds: ['sample'], runMode: 'rule',
      local: { selections: { Proxy: nodes[0] ?? 'DIRECT', Google: 'Proxy', Streaming: 'Proxy' }, rules: [], sharedGroups: [] },
      subscriptionOverrides: { sample: { selections: { Proxy: nodes[0] ?? 'DIRECT', Google: 'Proxy', Streaming: 'Proxy' }, rules: [] } },
      autoProbes: { primary: { url: 'https://probe.example/primary', expectedStatus: 204 }, secondary: { url: 'https://probe.example/secondary', expectedStatus: 204 }, timeoutMs: 5000, slowMs: 500 } };
    sites = { targets: [
      { id: 'google', name: '示例搜索', url: 'https://search.example/check', category: '预览', builtin: true, permitted: true },
      { id: 'streaming', name: '示例视频', url: 'https://video.example/check', category: '预览', builtin: true, permitted: true },
    ], selections: {} };
  }
  reset(initial);
  const active = () => createHash('sha256').update(`ui-preview:${scenario}:${revision}`).digest('hex');
  const overrides = () => settings.mode === 'local' ? settings.local : settings.subscriptionOverrides[settings.subscriptionId] ?? settings.local;
  function groups() {
    if (!nodes.length) return [];
    return Object.entries(overrides().selections).map(([name, selected]) => ({ name, selected, activeSelected: selected,
      type: 'Selector', role: name === 'Proxy' || settings.local.sharedGroups.includes(name) ? 'shared' : 'service',
      options: name === 'Proxy' || settings.local.sharedGroups.includes(name) ? [...nodes, 'DIRECT', 'REJECT'] : ['Proxy', ...settings.local.sharedGroups, ...nodes, 'DIRECT', 'REJECT'] }));
  }
  const automatic = () => ({ scope: 'preview', workspaceRevision: revision, paused: false, groups: groups().filter(g => overrides().automatic?.[g.name]?.enabled).map(g => ({
    name: g.name, phase: 'healthy', current: g.selected, nextAt: Date.now() + 30000, reason: null,
  })), events: [] });
  function view() {
    return { workspace: { ...clone(settings), revision }, sources: [{ id: 'sample', name: '合成订阅', host: 'subscription.example', kind: 'profile', nodeCount: nodes.length,
      revision: 1, snapshotRevision: 1, snapshotDigest: 'a'.repeat(64), snapshotCurrent: true, lastAttempt: stamp(), lastError: null }],
    groups: groups(), nodes, tcpNodes: nodes.map((name, i) => ({ name, fingerprint: `sample-${i}`, applicable: true })),
    catalog: [{ id: 'Proxy', name: '默认出口', default: true }, { id: 'Google', name: '示例搜索', default: false }, { id: 'Streaming', name: '示例视频', default: false }],
    rules: [...['DOMAIN-SUFFIX,search.example,Google', 'DOMAIN-SUFFIX,video.example,Streaming', 'MATCH,Proxy'].map(value => ({ value, source: 'template', editable: false })),
      ...overrides().rules.map(value => ({ value, source: 'user', editable: true }))],
    pending: false, active: active(), automatic: automatic(), allowedProbeOrigins: ['https://probe.example', 'https://search.example', 'https://video.example'] };
  }
  function proxy(name, i = 0) {
    const group = groups().find(g => g.name === name);
    return { name, type: group ? 'Selector' : name === 'DIRECT' ? 'Direct' : name === 'REJECT' ? 'Reject' : ['Shadowsocks', 'VLESS', 'Trojan'][i % 3],
      all: group?.options, now: group?.selected ?? '', hidden: false, alive: i % 5 !== 4, udp: true, xudp: i % 3 === 1, tfo: false, extra: {},
      history: Array.from({ length: 8 }, (_, n) => ({ time: new Date(Date.now() - (8 - n) * 60000).toISOString(), delay: i % 5 === 4 ? 0 : 30 + i * 11 + n * 3 })) };
  }
  const proxies = () => Object.fromEntries([...groups().map(g => proxy(g.name)), ...nodes.map(proxy), proxy('DIRECT'), proxy('REJECT')].map(p => [p.name, p]));
  const siteView = () => ({ ...clone(sites), revision: siteRevision, workspaceRevision: revision, scope: 'preview', groups: groups().map(g => g.name) });
  function respond(method, rawPath, body = {}) {
    const path = new URL(rawPath, 'http://localhost').pathname;
    const ok = data => ({ status: 200, data: clone(data) });
    if (path === '/api/__preview/scenario') {
      if (method === 'GET') return ok({ scenario, scenarios });
      if (method !== 'POST' || !Object.hasOwn(scenarios, body.scenario)) return error('PREVIEW_SCENARIO_INVALID');
      reset(body.scenario); return ok({ scenario });
    }
    if (path === '/api/session/login' && method === 'POST') { loggedIn = true; return ok({ authenticated: true, username: 'UI 预览', expiresAt: Date.now() + 86400000 }); }
    if (path === '/api/session/logout' && method === 'POST') { loggedIn = false; return ok({}); }
    if (!loggedIn) return error('UNAUTHORIZED', 401);
    if (path === '/api/session' && method === 'GET') return ok({ authenticated: true, username: 'UI 预览', expiresAt: Date.now() + 86400000 });
    if (scenario === 'error' && ['/api/cocoproxy/workspace', '/api/clash/proxies', '/api/clash/version'].includes(path)) return error('MANAGEMENT_UNAVAILABLE', 503);
    if (path === '/api/cocoproxy/workspace') {
      if (method === 'GET') return ok(view());
      if (method === 'PUT' && body.expectedRevision === revision && body.settings) {
        settings = clone(body.settings); settings.local.sharedGroups ??= []; revision++;
        return ok({ workspace: { ...settings, revision } });
      }
      return error('WORKSPACE_CONFLICT', 409);
    }
    if (path === '/api/cocoproxy/workspace/apply' && method === 'POST') return ok({ active: active() });
    if (path === '/api/cocoproxy/workspace/select' && method === 'POST') {
      const group = groups().find(g => g.name === body.group);
      if (body.expectedRevision !== revision || body.expectedActive !== active() || !group?.options.includes(body.name)) return error('WORKSPACE_CONFLICT', 409);
      overrides().selections[body.group] = body.name; revision++;
      return ok({ active: active(), view: view() });
    }
    if (path === '/api/cocoproxy/workspace/sites') {
      if (method === 'GET') return ok(siteView());
      if (method !== 'PUT' || body.expectedRevision !== siteRevision || body.expectedWorkspaceRevision !== revision) return error('SITE_SETTINGS_CONFLICT', 409);
      if (body.group) sites.selections[body.group] = body.selected;
      if (body.add) sites.targets.push({ id: `custom-${siteRevision}`, ...body.add, builtin: false, permitted: true, category: '预览' });
      if (body.remove) sites.targets = sites.targets.filter(t => t.id !== body.remove);
      siteRevision++; return ok(siteView());
    }
    if (path === '/api/cocoproxy/workspace/tcp-delay' && method === 'POST') return ok({ name: body.name, fingerprint: body.fingerprint,
      status: scenario === 'timeout' ? 'timeout' : 'success', delay: scenario === 'timeout' ? null : 36, checkedAt: stamp() });
    if (path === '/api/cocoproxy/automatic/status' && method === 'GET') return ok(automatic());
    if (path === '/api/cocoproxy/automatic/history' && method === 'DELETE') return ok(automatic());
    if (path === '/api/cocoproxy/status' && method === 'GET') return ok({ active: active(), desired: active(), transaction: null, fault: null, checkedAt: stamp(), draft: null,
      core: { ready: true, generation: active(), checkedAt: stamp() }, gateway: { ready: false, reason: 'UI_PREVIEW' } });
    if (path === '/api/cocoproxy/bandwidth' && method === 'GET') return ok({ available: false, automaticRunning: false,
      limits: { durationMs: 10000, maxBytes: 10000000, timeoutMs: 15000 }, server: { name: 'UI 预览（不发送测速流量）', url: 'https://bandwidth.example' }, task: null });
    if (path === '/api/control/info' && method === 'GET') return ok({ hasAgent: false, features: [] });
    if (path === '/api/clash/version' && method === 'GET') return ok({ version: 'UI-preview', meta: true });
    if (path === '/api/clash/configs' && method === 'GET') return ok({ mode: settings.runMode, 'log-level': 'info', ipv6: false, 'allow-lan': false, 'mixed-port': 7890 });
    if (path === '/api/clash/proxies' && method === 'GET') return ok({ proxies: proxies() });
    if (path === '/api/clash/providers/proxies' && method === 'GET') return ok({ providers: nodes.length ? { sample: { name: 'sample', vehicleType: 'HTTP', updatedAt: stamp(),
      testUrl: 'https://probe.example/primary', proxies: nodes.map(proxy), subscriptionInfo: { Download: 8e9, Upload: 2e9, Total: 1e11, Expire: 1893456000 } } } : {} });
    if (path === '/api/clash/rules' && method === 'GET') return ok({ rules: view().rules.map((r, index) => { const parts = r.value.split(','); return { index, type: parts[0], payload: parts.length === 3 ? parts[1] : '', proxy: parts.at(-1) }; }) });
    if (path === '/api/clash/providers/rules' && method === 'GET') return ok({ providers: {} });
    if (path === '/api/clash/group' && method === 'GET') return ok({ groups: {} });
    if (/^\/api\/clash\/(proxies|group|providers\/proxies)\/.+\/(delay|healthcheck)$/.test(path) && method === 'GET') {
      if (scenario === 'timeout') return error('CONTROLLER_PROBE_TIMEOUT', 504);
      return ok({ delay: 68 });
    }
    if (path.startsWith('/api/clash/connections') && method === 'DELETE') return ok({});
    if (/^\/api\/clash\/providers\/proxies\/[^/]+$/.test(path) && method === 'PUT') return ok({});
    // Unknown endpoints fail explicitly. Never proxy to a real backend.
    return error('UI_PREVIEW_UNSUPPORTED', 501);
  }
  return { respond, get scenario() { return scenario; }, get generation() { return active(); },
    delay(path) { return /\/(delay|healthcheck|tcp-delay)(\?|$)/.test(path) ? 1200 : scenario === 'slow' ? 1800 : 80; },
    stream(path, tick) {
      if (path === '/api/clash/traffic') return { up: 20000 + tick % 7 * 1000, down: 250000 + tick % 9 * 30000 };
      if (path === '/api/clash/memory') return { inuse: 64e6 + tick % 10 * 1e6, oslimit: 512e6 };
      if (path === '/api/clash/connections') return { downloadTotal: 8e9, uploadTotal: 2e9, connections: [] };
      if (path === '/api/clash/logs') return { type: 'info', payload: `UI 预览：合成状态 ${tick}` };
      return null;
    } };
}
