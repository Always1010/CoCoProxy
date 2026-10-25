import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import test from 'node:test';
import WebSocket from 'ws';
import { createAdminCredential } from '../packages/management/auth.ts';
import { AUTOMATIC_GATEWAY_CORE_SHA256 } from '../packages/gateway/profile.ts';
import { SubscriptionStore } from '../packages/subscriptions/index.ts';
import { decodeSubscriptionProfile } from '../packages/subscriptions/yaml.ts';

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

for (const automatic of [false, true]) test(`built management server gates ${automatic ? 'automatic' : 'explicit'} HTTP/WS and preserves candidate receipts`,
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
      binaryPath: '/synthetic/not-installed', binarySha256: automatic ? AUTOMATIC_GATEWAY_CORE_SHA256 : 'a'.repeat(64), systemctlPath: '/synthetic/not-systemctl',
      unitPath: '/synthetic/coproxy-mihomo.service', unitSha256: 'b'.repeat(64), serviceUid: 12345,
      ...(automatic ? { automaticGateway: { schemaVersion: 1, ingressInterface: 'lan-test', gatewayIPv4: '192.0.2.2',
        routerIPv4: '192.0.2.1', routerMAC: '02:00:00:00:00:01', clientIPv4: '192.0.2.3', prefixLength: 24,
        dnsPort: 15353, egressMark: 65536, egressTable: 2024, egressPriority: 8000, tunMtu: 1500 } } : {}) }), { mode: 0o600 });
    await writeFile(settingsPath, JSON.stringify({ schemaVersion: 1, origin, credentialPath, runtimeSettingsPath,
      deployment: { mixedPort: 17890, controllerPort: 19090, dnsPort: 15353, controllerSecret: secret, bootstrapResolvers: ['192.0.2.53'] } }), { mode: 0o600 });
    if (playwrightModule && browserBinary) {
      // Seed a complete offline profile; no test action contacts an upstream.
      const profile = { proxies: [
        { name: 'browser-node-a', type: 'socks5', server: '192.0.2.10', port: 1080 },
        { name: 'browser-node-b', type: 'socks5', server: '192.0.2.11', port: 1080 },
      ], 'proxy-groups': [{ name: 'Browser Provider', type: 'select', proxies: ['browser-node-a', 'browser-node-b', 'DIRECT', 'REJECT'] }],
      rules: ['DOMAIN-SUFFIX,provider.example,Browser Provider', 'MATCH,Browser Provider'] };
      const sources = new SubscriptionStore(join(root, 'state'), {
        fetch: async () => ({ status: 'modified', text: JSON.stringify(profile) }),
      }, decodeSubscriptionProfile);
      const source = await sources.configure({ id: 'browser-provider', name: '浏览器测试订阅', url: 'https://subscription.example/profile?token=EXAMPLE_ONLY_TOKEN' }, 0);
      await sources.refresh(source.id, source.revision);
    }
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
    const captured = JSON.parse(await readFile(join(root, 'state/candidates', receipt.generation + '.json'), 'utf8'));
    assert.equal(captured.tun.enable, automatic);
    const status = await (await call('/api/coproxy/status', 'GET', undefined, cookie)).json();
    assert.equal(status.gateway.ready, false);
    if (automatic) assert.equal(status.gateway.profile, 'mihomo-automatic');
    assert.ok(!(await (await call('/api/coproxy/draft', 'GET', undefined, cookie)).text()).includes(secret));

    await t.test('browser subscription and local schemes, service groups, rule editing, responsive layout and logout',
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
          await page.waitForURL(/#\/overview$/);
          assert.equal(await page.locator('#coproxy-policy').count(), 0);
          const prefix = automatic ? 'automatic' : 'explicit';
          const screenshot = async (name: string) => {
            if (artifacts) await page.screenshot({ path: join(artifacts, `${prefix}-${name}.png`), fullPage: true });
          };
          const navigate = async (name: string) => {
            await page.locator(`a[href$="/${name}"]:visible`).first().click();
            await page.waitForURL(new RegExp(`#/${name}$`));
          };
          const savedChange = async (action: () => Promise<unknown>) => {
            const [response] = await Promise.all([
              page.waitForResponse((response: any) => new URL(response.url()).pathname === '/api/coproxy/workspace' && response.request().method() === 'PUT'),
              action(),
            ]);
            assert.equal(response.status(), 200, await response.text());
            await page.waitForFunction(() => {
              const select = document.querySelector('select[aria-label="配置方案"]') as HTMLSelectElement | null;
              return select && !select.disabled;
            });
          };
          const workspace = async () => {
            const response = await context.request.get(origin + '/api/coproxy/workspace');
            assert.equal(response.status(), 200);
            return response.json();
          };
          await navigate('subscriptions');
          const card = page.locator('article').filter({ has: page.getByRole('heading', { name: '浏览器测试订阅', exact: true }) });
          await card.getByText('2 个节点', { exact: true }).waitFor();
          assert.ok(!(await card.textContent()).includes('EXAMPLE_ONLY_TOKEN'));
          await screenshot('subscriptions-desktop');
          await savedChange(() => page.getByLabel('配置方案', { exact: true }).selectOption('subscription'));
          assert.equal(await page.getByLabel('基础订阅', { exact: true }).inputValue(), 'browser-provider');
          assert.equal(await card.getByRole('button', { name: '选择 浏览器测试订阅', exact: true }).getAttribute('aria-pressed'), 'true');
          await navigate('proxies');
          await page.getByLabel('Browser Provider 策略', { exact: true }).waitFor();
          assert.equal(await page.getByLabel('Browser Provider 策略', { exact: true }).inputValue(), 'browser-node-a');
          await screenshot('subscription-groups-desktop');
          await page.getByRole('tab', { name: '节点', exact: true }).click();
          await page.getByText('核心不可用', { exact: true }).waitFor();
          await page.getByRole('tab', { name: '策略组', exact: true }).click();
          await savedChange(() => page.getByLabel('配置方案', { exact: true }).selectOption('local'));
          await page.getByLabel('国内直连 策略', { exact: true }).waitFor();
          await page.getByLabel('OpenAI 策略', { exact: true }).waitFor();
          assert.equal(await page.getByLabel('国内直连 策略', { exact: true }).inputValue(), 'DIRECT');
          await savedChange(() => page.getByLabel('国内直连 策略', { exact: true }).selectOption('REJECT'));
          assert.equal((await workspace()).workspace.local.selections.Domestic, 'REJECT');
          await screenshot('local-groups-desktop');
          await navigate('rules');
          await page.getByRole('tab', { name: /自定义规则/ }).click();
          await page.getByLabel('规则类型', { exact: true }).selectOption('DOMAIN');
          await page.getByLabel('匹配内容', { exact: true }).fill('first.example');
          await page.getByLabel('目标策略', { exact: true }).selectOption('OpenAI');
          await page.getByRole('button', { name: '添加规则', exact: true }).click();
          await page.getByLabel('规则类型', { exact: true }).selectOption('IP-CIDR');
          await page.getByLabel('匹配内容', { exact: true }).fill('192.0.2.0/24');
          await page.getByLabel('目标策略', { exact: true }).selectOption('Domestic');
          await page.getByRole('button', { name: '添加规则', exact: true }).click();
          await page.getByLabel('规则 1', { exact: true }).fill('DOMAIN,edited.example,REJECT');
          await page.getByRole('button', { name: '上移规则 2', exact: true }).click();
          await savedChange(() => page.getByRole('button', { name: '保存规则', exact: true }).click());
          assert.equal(await page.getByLabel('规则 1', { exact: true }).inputValue(), 'IP-CIDR,192.0.2.0/24,Domestic');
          assert.equal(await page.getByLabel('规则 2', { exact: true }).inputValue(), 'DOMAIN,edited.example,REJECT');
          assert.deepEqual((await workspace()).workspace.local.rules, ['IP-CIDR,192.0.2.0/24,Domestic', 'DOMAIN,edited.example,REJECT']);
          assert.equal(await page.getByRole('button', { name: '保存规则', exact: true }).isDisabled(), true);
          await screenshot('rules-desktop');
          // Saving already attempts activation. The absent synthetic runtime
          // must report failure without an extra Apply click or false success.
          assert.equal(await page.getByRole('button', { name: '应用', exact: true }).count(), 0);
          await page.getByRole('alert').filter({ hasText: '配置校验失败' }).waitFor();
          assert.equal(await page.getByRole('status').filter({ hasText: /已生效|已切换/ }).count(), 0);
          const status = await (await call('/api/coproxy/status', 'GET', undefined, cookie)).json();
          assert.equal(status.active, null); assert.match(status.desired, /^[a-f0-9]{64}$/);
          assert.equal(status.gateway.ready, false);
          // A controlled core receipt exercises the successful browser path:
          // a single dropdown action must save, activate, verify, and refresh.
          let effectiveRevision = -1;
          let effectiveGroups: { name: string; selected: string; options: string[] }[] = [];
          let rejectNextActivation = false;
          let interruptNextActivation = false;
          let activations = 0;
          const observedActive = 'c'.repeat(64);
          await context.route('**/api/coproxy/workspace/apply', async (route: any) => {
            activations++;
            const current = await workspace();
            assert.equal(route.request().postDataJSON().expectedRevision, current.workspace.revision);
            assert.equal(route.request().postDataJSON().expectedActive, observedActive);
            if (rejectNextActivation) {
              rejectNextActivation = false;
              await route.fulfill({ status: 503, json: { error: { code: 'ACTIVATION_FAILED' } } });
              return;
            }
            effectiveRevision = current.workspace.revision;
            effectiveGroups = current.groups;
            if (interruptNextActivation) {
              interruptNextActivation = false;
              await route.abort('connectionreset');
              return;
            }
            await route.fulfill({ json: { active: observedActive, workspaceRevision: effectiveRevision } });
          });
          await context.route('**/api/coproxy/workspace', async (route: any) => {
            if (route.request().method() !== 'GET') { await route.continue(); return; }
            const response = await route.fetch();
            const body = await response.json();
            body.active = observedActive;
            body.pending = body.workspace.revision !== effectiveRevision;
            for (const group of body.groups) group.activeSelected = effectiveGroups.find(item => item.name === group.name)?.selected ?? null;
            await route.fulfill({ response, json: body });
          });
          await context.route('**/api/clash/proxies', (route: any) => route.fulfill({
            headers: { 'x-coproxy-generation': observedActive },
            json: { proxies: Object.fromEntries(effectiveGroups.map(group => [group.name, {
              name: group.name, type: 'Selector', now: group.selected, all: group.options,
            }])) },
          }));
          await navigate('proxies');
          await savedChange(() => page.getByLabel('国内直连 策略', { exact: true }).selectOption('DIRECT'));
          await page.getByRole('status').filter({ hasText: '已切换：Domestic → DIRECT' }).waitFor();
          assert.equal(activations, 1);
          await page.getByText('当前生效：DIRECT', { exact: true }).first().waitFor();
          rejectNextActivation = true;
          await savedChange(() => page.getByLabel('国内直连 策略', { exact: true }).selectOption('REJECT'));
          await page.getByRole('alert').filter({ hasText: '核心激活失败' }).waitFor();
          await page.getByText('当前生效：DIRECT', { exact: true }).first().waitFor();
          assert.equal(await page.getByRole('status').filter({ hasText: '已切换' }).count(), 0);
          assert.equal(activations, 2);
          interruptNextActivation = true;
          await savedChange(() => page.getByLabel('国内直连 策略', { exact: true }).selectOption('REJECT'));
          await page.getByRole('alert').filter({ hasText: '操作结果未知' }).waitFor();
          await page.getByText('当前生效：REJECT', { exact: true }).first().waitFor();
          assert.equal(await page.getByRole('status').filter({ hasText: /已切换|已生效/ }).count(), 0);
          assert.equal(activations, 3);
          for (const viewport of [
            { name: 'tablet-portrait', width: 768, height: 1024 },
            { name: 'tablet-landscape', width: 1024, height: 768 },
            { name: 'mobile', width: 390, height: 844 },
          ]) {
            await page.setViewportSize({ width: viewport.width, height: viewport.height });
            for (const route of ['subscriptions', 'proxies', 'rules']) {
              await page.goto(`${origin}/#/${route}`);
              await page.getByLabel('配置方案', { exact: true }).waitFor();
              await page.waitForFunction(() => !(document.querySelector('select[aria-label="配置方案"]') as HTMLSelectElement | null)?.disabled);
              // Common controls must have words rendered on touch devices;
              // an aria-label or hover tooltip alone does not meet this check.
              assert.match(await page.getByRole('button', { name: '刷新', exact: true }).innerText(), /刷新/);
              assert.match(await page.locator('a[href$="/coproxy"]:visible').first().innerText(), /设置/);
              if (route === 'subscriptions') {
                await page.getByRole('heading', { name: '浏览器测试订阅', exact: true }).waitFor();
                for (const action of ['更新', '编辑', '删除']) {
                  assert.match(await page.getByRole('button', { name: `${action} 浏览器测试订阅`, exact: true }).innerText(), new RegExp(action));
                }
              }
              if (route === 'proxies') {
                await page.getByLabel('国内直连 策略', { exact: true }).waitFor();
                assert.match(await page.locator('summary[aria-label="添加策略组"]').innerText(), /添加策略组/);
              }
              if (route === 'rules') {
                await page.getByRole('tab', { name: /自定义规则/ }).click();
                await page.getByLabel('规则 2', { exact: true }).waitFor();
                assert.match(await page.getByRole('button', { name: '保存规则', exact: true }).innerText(), /保存/);
                assert.match(await page.getByRole('button', { name: '添加规则', exact: true }).innerText(), /添加/);
                for (const action of ['上移', '下移', '删除']) {
                  assert.match(await page.getByRole('button', { name: `${action}规则 1`, exact: true }).innerText(), new RegExp(action));
                }
              }
              if (viewport.width >= 768) {
                // Tablet navigation may use the labeled drawer at portrait
                // width; desktop-width tablet navigation stays visible.
                let openedDrawer = false;
                if (!await page.locator('a[href$="/proxies"]:visible').count()) {
                  const menu = page.locator('label[for="main-drawer"]:visible').first();
                  assert.ok((await menu.innerText()).trim(), 'tablet menu needs a visible label');
                  await menu.click();
                  openedDrawer = true;
                }
                for (const destination of ['subscriptions', 'proxies', 'rules']) {
                  const link = page.locator(`a[href$="/${destination}"]:visible`).first();
                  await link.waitFor();
                  assert.ok((await link.innerText()).trim(), `${destination} tablet navigation needs visible text`);
                }
                if (openedDrawer) await page.locator('label[aria-label="close sidebar"]').click({ position: { x: viewport.width - 10, y: 10 } });
              }
              assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false, `${route} overflows ${viewport.name}`);
              await screenshot(`${route}-${viewport.name}`);
            }
          }
          await page.locator('a[href$="/coproxy"]:visible').first().click();
          await page.getByRole('heading', { name: '设置', exact: true }).waitFor();
          await page.getByRole('button', { name: '退出登录', exact: true }).click();
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
