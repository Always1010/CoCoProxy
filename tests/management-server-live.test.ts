import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import test from 'node:test';
import WebSocket from 'ws';
import { createAdminCredential } from '../packages/management/auth.ts';

const entry = process.env.COPROXY_TEST_SERVER;
const playwrightModule = process.env.COPROXY_TEST_PLAYWRIGHT;
const browserBinary = process.env.COPROXY_TEST_BROWSER;
const artifacts = process.env.COPROXY_TEST_ARTIFACTS;
const username = 'synthetic-admin';
const password = 'synthetic-browser-test-password';
const secret = 'synthetic-controller-secret-not-for-browser';
const policy = { proxies: [], 'proxy-groups': [], rules: ['MATCH,REJECT'] };

async function freePort(): Promise<number> {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  await new Promise<void>(resolve => server.close(() => resolve())); return port;
}

function rejectedSocket(url: string, expectedStatus: number, headers: Record<string, string> = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers, handshakeTimeout: 3000 });
    const timer = setTimeout(() => { socket.terminate(); reject(new Error('WS_REJECTION_TIMEOUT')); }, 4000);
    socket.on('error', () => {});
    socket.on('unexpected-response', (_request, response) => {
      response.resume(); clearTimeout(timer); socket.terminate();
      try { assert.equal(response.statusCode, expectedStatus); resolve(); } catch (error) { reject(error); }
    });
    socket.on('open', () => { clearTimeout(timer); socket.terminate(); reject(new Error('UNEXPECTED_UPGRADE')); });
  });
}

test('built management server gates HTTP and all WS upgrades, and browser preserves explicit candidate receipts',
  { skip: !entry || process.platform !== 'linux', timeout: 120_000 }, async t => {
    assert.ok(isAbsolute(entry!));
    const root = await mkdtemp(join(tmpdir(), 'coproxy-server-live-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const origin = `http://127.0.0.1:${await freePort()}`;
    const credentialPath = join(root, 'admin.json');
    const runtimeSettingsPath = join(root, 'runtime.json');
    const settingsPath = join(root, 'management.json');
    await writeFile(credentialPath, JSON.stringify(await createAdminCredential({ username, password })), { mode: 0o600 });
    await writeFile(runtimeSettingsPath, JSON.stringify({ schemaVersion: 1, stateDirectory: join(root, 'state'),
      binaryPath: '/synthetic/not-installed', binarySha256: 'a'.repeat(64), systemctlPath: '/synthetic/not-systemctl',
      unitPath: '/synthetic/coproxy-mihomo.service', unitSha256: 'b'.repeat(64), serviceUid: 12345 }), { mode: 0o600 });
    await writeFile(settingsPath, JSON.stringify({ schemaVersion: 1, origin, credentialPath, runtimeSettingsPath,
      deployment: { mixedPort: 17890, controllerPort: 19090, dnsPort: 15353, controllerSecret: secret, bootstrapResolvers: ['192.0.2.53'] } }), { mode: 0o600 });
    const child = spawn(process.execPath, [entry!], { env: { ...process.env, NITRO_HOST: '127.0.0.1', NITRO_PORT: new URL(origin).port,
      COPROXY_MANAGEMENT_CONFIG: settingsPath, CONTROL_TOKEN: secret, GITHUB_TOKEN: secret }, cwd: '/', stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let outputBytes = 0;
    for (const stream of [child.stdout!, child.stderr!]) stream.on('data', chunk => {
      outputBytes += chunk.length; if (outputBytes > 256 * 1024) child.kill('SIGTERM');
    });
    const exit = once(child, 'exit');
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      const timer = setTimeout(() => { try { process.kill(-child.pid!, 'SIGKILL'); } catch {} }, 5000);
      try { await exit; } finally { clearTimeout(timer); }
    });
    for (let i = 0; ; i++) {
      try { if ((await fetch(origin + '/api/coproxy/health')).ok) break; } catch {}
      if (i >= 100 || child.exitCode !== null) throw new Error('SERVER_START_FAILED');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const call = (path: string, method = 'GET', body?: unknown, cookie?: string, extra: Record<string, string> = {}) =>
      fetch(origin + path, { method, headers: { ...(method === 'GET' ? {} : { origin, 'content-type': 'application/json' }),
        ...(cookie ? { cookie } : {}), ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const ws = origin.replace('http:', 'ws:');
    const shell = await call('/coproxy');
    assert.equal(shell.status, 200); assert.match(shell.headers.get('content-type')!, /text\/html/);
    assert.equal((await call('/api/session')).status, 401);
    assert.equal((await call('/api/control/kernel/start', 'POST', {})).status, 404);
    const script = await (await call('/config.js')).text();
    // Nitro can serve the UI's static empty config before its dynamic route.
    assert.ok(!script.includes(secret));
    await rejectedSocket(ws + '/api/control/kernel/start', 404, { origin });
    await rejectedSocket(ws + '/api/session', 404, { origin });
    await rejectedSocket(ws + '/api/clash/traffic', 401, { origin });
    const login = await call('/api/session/login', 'POST', { username, password });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie')!.split(';')[0];
    await rejectedSocket(ws + '/api/clash/traffic', 403, { cookie, origin: 'https://other.example' });
    await rejectedSocket(ws + '/api/clash/traffic', 403, { cookie });
    assert.equal((await call('/api/clash/version', 'GET', undefined, cookie)).status, 503);
    assert.equal((await call('/api/clash/version?token=x', 'GET', undefined, cookie)).status, 400);
    assert.equal((await call('/api/coproxy/draft', 'PUT', { expectedRevision: 0, policy }, cookie, { origin: 'https://other.example' })).status, 403);
    assert.equal((await call('/api/coproxy/draft', 'PUT', { expectedRevision: 0, policy }, cookie)).status, 200);
    const receipt = await (await call('/api/coproxy/stage', 'POST', { expectedRevision: 1 }, cookie)).json();
    assert.match(receipt.generation, /^[a-f0-9]{64}$/);
    assert.ok(!(await (await call('/api/coproxy/draft', 'GET', undefined, cookie)).text()).includes(secret));

    await t.test('browser login, save, stage, stale capture, conflict retention and logout',
      { skip: !playwrightModule || !browserBinary, timeout: 90_000 }, async () => {
        assert.ok(isAbsolute(playwrightModule!) && isAbsolute(browserBinary!));
        if (artifacts) { assert.ok(isAbsolute(artifacts)); await mkdir(artifacts, { recursive: true, mode: 0o700 }); }
        const { chromium } = createRequire(import.meta.url)(playwrightModule!);
        const browser = await chromium.launch({ executablePath: browserBinary, headless: true });
        let page: any;
        const errors: string[] = [];
        try {
          const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
          page = await context.newPage();
          page.setDefaultTimeout(10_000);
          page.on('pageerror', (error: Error) => errors.push(error.message));
          await page.goto(origin + '/#/coproxy');
          await page.locator('#coproxy-username').fill(username);
          await page.locator('#coproxy-password').fill(password);
          await page.getByRole('button', { name: '登录', exact: true }).click();
          await page.locator('#coproxy-policy').waitFor();
          await page.getByRole('button', { name: '保存草稿', exact: true }).waitFor({ state: 'visible' });
          await page.waitForFunction(() => !(document.querySelector('#coproxy-policy') as HTMLTextAreaElement)?.disabled);
          await page.locator('#coproxy-policy').fill(JSON.stringify({ ...policy, 'log-level': 'info' }, null, 2));
          await page.getByRole('button', { name: '保存草稿', exact: true }).click();
          await page.getByText('已保存草稿版本 2。尚未捕获或应用。', { exact: true }).waitFor();
          await page.getByRole('button', { name: '捕获候选', exact: true }).click();
          await page.getByText('候选已捕获；核心尚未切换。请核对下方回执再应用。', { exact: true }).waitFor();
          const candidateText = await page.locator('dd').allTextContents();
          const captured = candidateText.find((text: string) => /^[a-f0-9]{64}$/.test(text));
          assert.ok(captured);
          await page.locator('#coproxy-policy').fill(JSON.stringify({ ...policy, 'log-level': 'error' }, null, 2));
          await page.getByRole('button', { name: '保存草稿', exact: true }).click();
          await page.getByText('已保存草稿版本 3。尚未捕获或应用。', { exact: true }).waitFor();
          await page.getByText(/此回执与当前编辑或来源选择不同/).waitFor();
          assert.ok((await page.locator('dd').allTextContents()).includes(captured));
          // An independent update must not silently replace the editor's CAS.
          assert.equal((await call('/api/coproxy/draft', 'PUT', { expectedRevision: 3, policy }, cookie)).status, 200);
          const unsaved = JSON.stringify({ ...policy, 'log-level': 'debug' }, null, 2);
          await page.locator('#coproxy-policy').fill(unsaved);
          await page.getByRole('button', { name: '保存草稿', exact: true }).click();
          await page.getByText(/草稿已被其他操作修改/).waitFor();
          assert.equal(await page.locator('#coproxy-policy').inputValue(), unsaved);
          const status = await (await call('/api/coproxy/status', 'GET', undefined, cookie)).json();
          assert.equal(status.active, null); assert.equal(status.desired, null);
          assert.equal(status.gateway.ready, false);
          await page.locator('main').evaluate((element: HTMLElement) => element.scrollTo(0, 0));
          if (artifacts) await page.screenshot({ path: join(artifacts, 'coproxy-desktop.png'), fullPage: true });
          await page.setViewportSize({ width: 390, height: 844 });
          await page.locator('main').evaluate((element: HTMLElement) => element.scrollTo(0, 0));
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
          if (artifacts) await page.screenshot({ path: join(artifacts, 'coproxy-mobile.png'), fullPage: true });
          await page.getByRole('button', { name: '注销', exact: true }).click();
          await page.locator('#coproxy-username').waitFor();
          assert.equal((await context.request.get(origin + '/api/session')).status(), 401);
          assert.deepEqual(errors, []);
        } catch (error) {
          if (artifacts && page) {
            await page.screenshot({ path: join(artifacts, 'failure.png'), fullPage: true });
            await writeFile(join(artifacts, 'failure.txt'), JSON.stringify({ errors, url: page.url(), html: await page.content() }), { mode: 0o600 });
          }
          throw error;
        } finally { await browser.close(); }
      });
    await call('/api/session/logout', 'POST', {}, cookie);
    await rejectedSocket(ws + '/api/clash/traffic', 401, { cookie, origin });
  });
