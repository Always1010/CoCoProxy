#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyGitTree } from './verify-git-tree.mjs';
import { applyMetacubexdOverlay } from './apply-metacubexd-overlay.mjs';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const local = join(project, '.local', 'ui-preview');
const uiOverlay = join(project, 'integrations', 'metacubexd', 'overlay', 'packages', 'ui');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const readJSON = async path => JSON.parse(await readFile(path, 'utf8'));
const exists = async path => { try { await lstat(path); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };

export function parseOptions(args) {
  const result = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (key === '--help' && args.length === 1) return { help: true };
    if (!['--archive', '--dependencies', '--port'].includes(key) || result[key.slice(2)] !== undefined || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('PREVIEW_ARGUMENT_INVALID');
    result[key.slice(2)] = args[++i];
  }
  if (result.port !== undefined && (!/^\d+$/.test(result.port) || +result.port < 1024 || +result.port > 65535)) throw new Error('PREVIEW_PORT_INVALID');
  for (const key of ['archive', 'dependencies']) if (result[key] && !isAbsolute(result[key])) throw new Error('PREVIEW_ABSOLUTE_INPUT_REQUIRED');
  return result;
}

async function files(root, prefix = '') {
  const result = new Map();
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    if (entry.isSymbolicLink() || ['.local', '.git', 'node_modules', '.nuxt', '.output'].includes(entry.name)) throw new Error('PREVIEW_SOURCE_INVALID');
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) for (const pair of await files(root, path)) result.set(...pair);
    else if (entry.isFile()) result.set(path, await readFile(join(root, path)));
    else throw new Error('PREVIEW_SOURCE_INVALID');
  }
  return result;
}

/** Owns only files in the UI overlay. Removing an override restores the pinned upstream file. */
export function createUiSync(overlay, destination, originals, initial) {
  let previous = initial;
  return async () => {
    const current = await files(overlay);
    const changed = new Set([...previous.keys(), ...current.keys()]);
    let count = 0;
    for (const path of changed) {
      if (previous.get(path)?.equals(current.get(path) ?? Buffer.alloc(0)) && current.has(path)) continue;
      // The preview's Nuxt wrapper stays in place; changes to base config still restart Nuxt.
      const target = join(destination, path === 'nuxt.config.ts' ? 'nuxt.product.config.ts' : path);
      const content = current.get(path) ?? originals.get(path);
      if (content) {
        await mkdir(dirname(target), { recursive: true });
        const temporary = target + '.preview-tmp';
        await writeFile(temporary, previewSource(path, content));
        await rename(temporary, target);
      } else await rm(target, { force: true });
      count++;
    }
    previous = current;
    return count;
  };
}
const configSource = bytes => `import { defineNuxtConfig } from 'nuxt/config'\n${bytes.toString('utf8')}`;
function previewSource(path, bytes) {
  if (path === 'nuxt.config.ts') return configSource(bytes);
  if (path === 'assets/css/main.css') {
    const sources = ['components', 'layouts', 'pages', 'composables', 'stores', 'constants', 'utils'].map(name => `@source '../../${name}';`).join('\n');
    return bytes.toString('utf8').replace("@import 'tailwindcss';", `@import 'tailwindcss' source(none);\n${sources}\n@source '../../app.vue';`);
  }
  if (path === 'layouts/default.vue') {
    const source = bytes.toString('utf8');
    const anchor = '    <!-- Sidebar + page content';
    if (!source.includes(anchor)) throw new Error('PREVIEW_LAYOUT_CHANGED');
    return source.replace(anchor, '    <UiPreviewPanel />\n\n' + anchor);
  }
  return bytes;
}

function command(bin, args, options = {}) {
  return new Promise((accept, reject) => {
    const child = spawn(bin, args, { stdio: 'inherit', windowsHide: true, ...options });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? accept() : reject(new Error('PREVIEW_COMMAND_FAILED')));
  });
}

async function inputs(options) {
  const saved = await exists(join(local, 'settings.json')) ? await readJSON(join(local, 'settings.json')) : {};
  const settings = { ...saved, ...options };
  if (!settings.archive || !settings.dependencies) throw new Error('PREVIEW_INPUT_REQUIRED');
  const catalog = (await readJSON(join(project, 'integrations/metacubexd/components.json'))).management;
  if (sha(await readFile(settings.archive)) !== catalog.sourceArchiveSha256) throw new Error('PREVIEW_ARCHIVE_MISMATCH');
  if (sha(await readFile(join(settings.dependencies, 'pnpm-lock.yaml'))) !== catalog.lockfileSha256) throw new Error('PREVIEW_LOCK_MISMATCH');
  const dep = createRequire(join(settings.dependencies, 'packages/ui/package.json'));
  for (const name of ['nuxt', 'vue', 'vue-tsc']) dep.resolve(`${name}/package.json`);
  if (dep('vue-tsc/package.json').version !== '3.3.10') throw new Error('PREVIEW_DEPENDENCIES_MISMATCH');
  // Use the already installed, locked pnpm/TypeScript; never install on startup.
  const pnpm = join(project, 'tooling/node_modules/pnpm/bin/pnpm.cjs');
  if (!await exists(pnpm) || !await exists(join(project, 'node_modules/ws/package.json'))) throw new Error('PREVIEW_DEPENDENCIES_MISSING');
  return { settings, dep };
}

export async function startPreview(options) {
  const { settings, dep } = await inputs(options);
  const port = +(settings.port ?? 3000);
  await new Promise((accept, reject) => {
    const probe = createServer();
    probe.once('error', () => reject(new Error('PREVIEW_PORT_IN_USE')));
    probe.listen(port, '127.0.0.1', () => probe.close(accept));
  });
  await mkdir(local, { recursive: true });
  // Refuse a redirected output directory before extracting or creating dependency links.
  if ((await realpath(local)).toLowerCase() !== resolve(local).toLowerCase()) throw new Error('PREVIEW_OUTPUT_LINK');
  const runtime = await mkdtemp(join(local, 'run-'));
  let child, timer, stopping = false, polling = Promise.resolve();
  async function stop() {
    if (stopping) return;
    stopping = true;
    clearTimeout(timer);
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(accept => child.once('exit', accept));
      child.kill('SIGTERM');
      await exited;
    }
    await polling;
    const rel = relative(local, runtime);
    if (!rel || rel.startsWith(`..${sep}`) || isAbsolute(rel) || (await realpath(runtime)).toLowerCase() !== runtime.toLowerCase()) throw new Error('PREVIEW_CLEANUP_SCOPE');
    // Node removes junctions themselves and does not traverse their dependency targets.
    await rm(runtime, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
  try {
    await command('tar', ['-xzf', settings.archive, '--strip-components=1', '-C', runtime]);
    const manifest = await readJSON(join(project, 'integrations/metacubexd/source-tree.json'));
    // NTFS extraction cannot represent Unix executable bits. Content/path/blob
    // checks remain mandatory; this preview tree is never a release input.
    const previewManifest = process.platform === 'win32'
      ? { ...manifest, files: manifest.files.map(entry => ({ ...entry, mode: entry.mode === '100755' ? '100644' : entry.mode })) }
      : manifest;
    await verifyGitTree(runtime, previewManifest);
    const ui = join(runtime, 'packages/ui');
    const originals = await files(ui);
    await applyMetacubexdOverlay(runtime);
    for (const path of ['node_modules', 'packages/ui/node_modules', 'packages/config-editor/node_modules']) {
      const source = join(settings.dependencies, path);
      if (!await exists(source)) throw new Error('PREVIEW_DEPENDENCIES_MISSING');
      await symlink(await realpath(source), join(runtime, path), process.platform === 'win32' ? 'junction' : 'dir');
    }
    await writeFile(join(ui, 'nuxt.product.config.ts'), configSource(await readFile(join(ui, 'nuxt.config.ts'))));
    const helper = join(project, 'scripts/ui-preview/server.mjs').replaceAll('\\', '/');
    const optimize = ['@tanstack/vue-query', 'vue-sonner', '@tabler/icons-vue', '@floating-ui/vue', '@tanstack/vue-virtual', 'byte-size', 'dayjs', 'dayjs/locale/ru', 'dayjs/locale/zh-cn', 'dayjs/plugin/duration', 'dayjs/plugin/relativeTime', 'ky', 'highcharts', 'match-sorter', 'sortablejs', 'uqr', 'd3', 'markdown-it'];
    await writeFile(join(ui, 'nuxt.config.ts'), `import base from './nuxt.product.config'\nimport { createPreviewServer } from ${JSON.stringify(helper)}\nconst preview = createPreviewServer()\nexport default defineNuxtConfig({\n  ...base,\n  vite: { ...base.vite, cacheDir: ${JSON.stringify(join(ui, '.nuxt/vite'))}, optimizeDeps: { include: ${JSON.stringify(optimize)} } },\n  modules: [...(base.modules || []), async (_options, nuxt) => {\n    nuxt.options.runtimeConfig.public.uiPreviewOrigin = await preview.listen(${JSON.stringify(`http://127.0.0.1:${port}`)})\n    nuxt.hook('close', () => preview.close())\n  }],\n})\n`);
    // Keep Tailwind discovery inside this UI tree, including when dependency
    // junctions point into a different checkout on Windows.
    const css = join(ui, 'assets/css/main.css');
    await writeFile(css, previewSource('assets/css/main.css', await readFile(css)));
    await writeFile(join(ui, 'components/UiPreviewPanel.vue'), await readFile(join(project, 'scripts/ui-preview/PreviewPanel.vue')));
    await writeFile(join(ui, 'public/config.js'), "window.__METACUBEXD_CONFIG__ = { defaultBackendURL: '', githubToken: '' };\n");
    const layout = join(ui, 'layouts/default.vue');
    await writeFile(layout, previewSource('layouts/default.vue', await readFile(layout)));
    // A preview browser starts in Chinese and lands on the node workbench.
    await writeFile(join(ui, 'plugins/ui-preview.client.ts'), `export default defineNuxtPlugin({ enforce: 'pre', setup() {\n  const mockOrigin = useRuntimeConfig().public.uiPreviewOrigin as string\n  const socketOrigin = mockOrigin.replace('http:', 'ws:')\n  const nativeFetch = window.fetch.bind(window)\n  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {\n    const request = input instanceof Request ? new Request(input, init) : new Request(new URL(input.toString(), window.location.href), init)\n    const target = new URL(request.url)\n    if (target.origin === window.location.origin && target.pathname.startsWith('/api/')) {\n      return nativeFetch(new Request(mockOrigin + target.pathname + target.search, { method: request.method, headers: request.headers, body: ['GET', 'HEAD'].includes(request.method) ? undefined : await request.arrayBuffer(), signal: request.signal, credentials: 'omit', cache: 'no-store' }))\n    }\n    return nativeFetch(request)\n  }\n  const NativeWebSocket = window.WebSocket\n  window.WebSocket = class extends NativeWebSocket {\n    constructor(url: string | URL, protocols?: string | string[]) {\n      const target = new URL(url, window.location.href)\n      const sameHost = target.host === window.location.host\n      super(sameHost && target.pathname.startsWith('/api/clash/') ? socketOrigin + target.pathname + target.search : url, protocols)\n    }\n  }\n  document.cookie = 'metacubexd_lang=zh; path=/; SameSite=Lax'\n  if (!window.location.hash || window.location.hash === '#/') window.location.hash = '#/proxies'\n} })\n`);
    await writeFile(join(local, 'settings.json'), JSON.stringify({ archive: settings.archive, dependencies: settings.dependencies, port: +(settings.port ?? 3000) }, null, 2) + '\n');
    const sync = createUiSync(uiOverlay, ui, originals, await files(uiOverlay));
    // Polling also catches atomic-save, rename, and delete on Windows. Never watch/copy .local.
    let syncFailed = false;
    const poll = async () => {
      if (stopping) return;
      try {
        const changed = await sync();
        // The preview panel is itself editable without restarting the launcher.
        const panel = await readFile(join(project, 'scripts/ui-preview/PreviewPanel.vue'));
        if (!panel.equals(await readFile(join(ui, 'components/UiPreviewPanel.vue')))) await writeFile(join(ui, 'components/UiPreviewPanel.vue'), panel);
        if (changed) console.log(`UI 预览：已同步 ${changed} 个文件。`);
        if (syncFailed) console.log('UI 预览：源码同步已恢复。');
        syncFailed = false;
      } catch {
        if (!syncFailed) console.error('UI 预览同步失败，请检查文件后重试；开发目录不作为正式源码。');
        syncFailed = true;
      }
      if (!stopping) timer = setTimeout(() => { polling = poll(); }, 500);
    };
    const nuxt = join(dirname(dep.resolve('nuxt/package.json')), 'bin/nuxt.mjs');
    child = spawn(process.execPath, [nuxt, 'dev', ui, '--host', '127.0.0.1', '--port', String(settings.port ?? 3000), '--no-fork'], {
      cwd: runtime, stdio: 'inherit', windowsHide: true,
      env: { ...process.env, CI: 'true', NUXT_TELEMETRY_DISABLED: '1', NUXT_APP_BASE_URL: '/', BROWSER: 'none' },
    });
    console.log(`UI 预览：http://127.0.0.1:${settings.port ?? 3000}/#/proxies（仅模拟数据，不连接设备）。Ctrl+C 停止。`);
    console.log('源码保存后自动同步并热更新；Nuxt 配置变化会触发开发服务重启。');
    polling = poll();
    await polling;
    const onSignal = () => { void stop(); };
    process.once('SIGINT', onSignal); process.once('SIGTERM', onSignal);
    const code = await new Promise((accept, reject) => { child.once('error', reject); child.once('exit', accept); });
    process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal);
    await stop();
    return code ?? 0;
  } catch (error) { await stop(); throw error; }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseOptions(process.argv.slice(2));
    if (options.help) console.log('npm run dev:ui -- [--archive <固定上游归档绝对路径>] [--dependencies <已准备的上游依赖根目录>] [--port 3000]\n首次指定输入后保存到 .local/ui-preview/settings.json；后续 npm run dev:ui。不会安装或下载依赖。');
    else process.exitCode = await startPreview(options);
  } catch (error) {
    console.error(`UI 预览启动失败：${/^PREVIEW_[A-Z_]+$/.test(error.message) ? error.message : 'PREVIEW_START_FAILED'}。`);
    console.error('准备方式与排查入口：docs/development.md 的“本地 UI 预览”一节；不会自动安装依赖。');
    process.exitCode = 1;
  }
}
