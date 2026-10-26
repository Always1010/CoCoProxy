import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, isAbsolute, join, resolve, sep } from 'node:path';
import test from 'node:test';
import { createAdminCredential } from '../packages/management/auth.ts';
import { createManagementGateway } from '../packages/management/http.ts';
import { TrustedDeviceStore } from '../packages/management/trusted-devices.ts';
import { createNotifications } from '../packages/management/notifications.ts';
import { generatePushKeys } from '../packages/management/web-push.ts';

const ui = process.env.COCOPROXY_TEST_UI;
const driver = process.env.COCOPROXY_TEST_PLAYWRIGHT;
const binary = process.env.COCOPROXY_TEST_BROWSER;

// Real generated UI + browser + Service Worker. Only provider subscription and
// remote delivery are synthetic; this does not claim lock-screen delivery.
test('generated notification settings and real Service Worker preserve opt-in, history, privacy and logout behavior',
  { skip: !ui || !driver || !binary, timeout: 120_000 }, async t => {
    for (const path of [ui, driver, binary]) assert.ok(isAbsolute(path));
    const root = await mkdtemp(join(tmpdir(), 'cocoproxy-notification-browser-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const username = 'synthetic-admin', password = 'synthetic-browser-notification-password';
    const credential = await createAdminCredential({ username, password });
    let gateway;
    const server = createServer(async (incoming, outgoing) => {
      try {
        const path = new URL(incoming.url, origin).pathname;
        if (path.startsWith('/api/')) {
          const chunks = []; let size = 0;
          for await (const chunk of incoming) { size += chunk.length; if (size > 64 * 1024) throw Error('BODY_LIMIT'); chunks.push(chunk); }
          const method = incoming.method;
          const response = await gateway.fetch(new Request(origin + incoming.url, { method, headers: incoming.headers,
            ...(['GET', 'HEAD'].includes(method) ? {} : { body: Buffer.concat(chunks) }) }));
          outgoing.statusCode = response.status;
          for (const [name, value] of response.headers) if (name !== 'set-cookie') outgoing.setHeader(name, value);
          const cookies = response.headers.getSetCookie(); if (cookies.length) outgoing.setHeader('set-cookie', cookies);
          outgoing.end(Buffer.from(await response.arrayBuffer())); return;
        }
        const filename = resolve(ui, '.' + decodeURIComponent(path === '/' ? '/index.html' : path));
        if (!filename.startsWith(resolve(ui) + sep)) throw Error('PATH_DENIED');
        const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };
        outgoing.setHeader('content-type', types[extname(filename)] ?? 'application/octet-stream');
        outgoing.setHeader('cache-control', 'no-store'); outgoing.end(await readFile(filename));
      } catch { outgoing.statusCode = 404; outgoing.end(); }
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const origin = `http://127.0.0.1:${server.address().port}`;
    t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
    const devices = await TrustedDeviceStore.load(root, credential, origin);
    const sent = [];
    const source = { scope: 'synthetic-browser', events: [], groups: [{ name: 'Proxy', current: 'A', phase: 'monitoring', reason: null }] };
    const notifications = await createNotifications({ stateDirectory: root, origin, devices, source: async () => source,
      send: async (_subscription, payload) => { sent.push(JSON.parse(payload)); return { status: 201 }; } });
    t.after(() => notifications.close());
    gateway = createManagementGateway({ origin, credential, trustedDevices: devices }, async (request, principal) => {
      const path = new URL(request.url).pathname;
      if (path.startsWith('/api/cocoproxy/notifications/')) return notifications.route(request, principal);
      if (path === '/api/cocoproxy/status') return { active: null, desired: null, transaction: null, fault: null, checkedAt: null, draft: null, core: null, gateway: { ready: false, reason: 'synthetic' } };
      if (path === '/api/clash/configs') return { mode: 'rule', port: 0 };
      if (path === '/api/clash/version') return { version: 'synthetic' };
      return {};
    });
    await notifications.tick();
    const playwright = createRequire(import.meta.url)(driver);
    const browser = await playwright.chromium.launch({ executablePath: binary, headless: true });
    t.after(() => browser.close());
    const context = await browser.newContext({ permissions: ['notifications'] });
    const synthetic = { endpoint: 'https://fcm.googleapis.com/wp/synthetic-browser', keys: { p256dh: generatePushKeys().publicKey, auth: Buffer.alloc(16, 2).toString('base64url') } };
    await context.addInitScript(subscription => {
      let current = null;
      const wrap = json => ({ options: { applicationServerKey: Uint8Array.from(JSON.parse(sessionStorage.getItem('test-push-key')), n => n).buffer },
        toJSON: () => json, unsubscribe: async () => { current = null; return true; } });
      PushManager.prototype.getSubscription = async function () { return current; };
      PushManager.prototype.subscribe = async function (options) {
        sessionStorage.setItem('test-push-key', JSON.stringify(Array.from(new Uint8Array(options.applicationServerKey))));
        current = wrap(subscription); return current;
      };
    }, synthetic);
    const page = await context.newPage();
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin + '/#/login');
    await page.getByLabel('用户名', { exact: true }).fill(username);
    await page.getByLabel('密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await page.waitForURL('**/#/overview');
    await page.goto(origin + '/#/cocoproxy');
    const section = page.getByRole('region', { name: '此设备的通知' });
    await section.getByRole('button', { name: '开启此设备通知', exact: true }).click();
    await section.getByRole('button', { name: '发送测试通知', exact: true }).waitFor();
    await page.waitForFunction(() => {
      const section = document.querySelector('[aria-labelledby="notifications-title"]');
      return section && [...section.querySelectorAll('button')].some(button => button.textContent.includes('修复订阅') && !button.disabled);
    });
    assert.deepEqual(await section.getByRole('alert').allTextContents(), []);
    await section.getByLabel('在锁屏通知中显示节点名称', { exact: true }).check();
    await section.getByRole('button', { name: '保存通知偏好', exact: true }).click();
    await section.getByRole('button', { name: '发送测试通知', exact: true }).click();
    await section.getByRole('status').waitFor();
    assert.deepEqual(await section.getByRole('alert').allTextContents(), []);
    assert.equal(await section.getByLabel('在锁屏通知中显示节点名称', { exact: true }).isChecked(), true);
    for (let attempt = 0; !sent.length; attempt++) { assert.ok(attempt < 50); await new Promise(resolve => setTimeout(resolve, 100)); }
    assert.equal(sent.length, 1);
    const worker = context.serviceWorkers().find(worker => worker.url() === origin + '/cocoproxy-sw.js');
    assert.ok(worker);
    const deliver = payload => worker.evaluate(async payload => {
      const promises = [], event = new PushEvent('push', { data: JSON.stringify(payload) });
      Object.defineProperty(event, 'waitUntil', { value: promise => promises.push(promise) });
      self.dispatchEvent(event); await Promise.all(promises);
      return (await self.registration.getNotifications()).map(item => ({ title: item.title, body: item.body, url: item.data.url }));
    }, payload);
    const message = { ...sent[0], at: Date.now(), expiresAt: Date.now() + 300_000, title: '最新合成通知', url: 'https://evil.example/' };
    let shown = await deliver(message);
    assert.equal(shown.length, 1); assert.equal(shown[0].title, message.title); assert.equal(shown[0].url, '/#/cocoproxy');
    shown = await deliver({ ...message, title: '过时合成通知', at: message.at - 10_000 });
    assert.equal(shown[0].title, message.title);
    shown = await deliver({ ...message, tag: 'cocoproxy-expired', expiresAt: Date.now() - 1 });
    assert.equal(shown.length, 1);
    assert.deepEqual(await worker.evaluate(() => caches.keys()), []);
    await section.getByRole('button', { name: '关闭此设备通知', exact: true }).click();
    await section.getByRole('button', { name: '开启此设备通知', exact: true }).waitFor();
    for (let attempt = 0; ; attempt++) {
      const count = await worker.evaluate(async () => (await self.registration.getNotifications()).length);
      if (!count) break; assert.ok(attempt < 50); await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal((await deliver({ ...message, at: message.at + 1 })).length, 0);
    assert.equal((await page.request.get(origin + '/api/session')).status(), 200);
    await section.getByRole('button', { name: '开启此设备通知', exact: true }).click();
    await section.getByRole('button', { name: '发送测试通知', exact: true }).waitFor();
    await page.getByRole('button', { name: '退出登录', exact: true }).click();
    await page.waitForURL('**/#/login');
    assert.equal((await page.request.get(origin + '/api/session')).status(), 401);
    await notifications.tick();
    const state = JSON.parse(await readFile(join(root, 'notifications/state.json'), 'utf8')).state;
    assert.equal(state.subscriptions.length, 0); assert.equal(state.jobs.length, 0);
    assert.deepEqual(errors, []);
  });
