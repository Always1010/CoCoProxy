import { fileURLToPath } from 'node:url'
import { isAbsolute, resolve } from 'node:path'
import { defineNitroConfig } from 'nitropack/config'

const source = process.env.COCOPROXY_SOURCE_DIR
if (!source || !isAbsolute(source) || resolve(source) !== source) throw new Error('COCOPROXY_SOURCE_DIR_REQUIRED')
const dependencies = process.env.COCOPROXY_RUNTIME_DEPENDENCIES || resolve(source, 'node_modules')
if (!isAbsolute(dependencies) || resolve(dependencies) !== dependencies) throw new Error('COCOPROXY_RUNTIME_DEPENDENCIES_INVALID')
const uiDist = process.env.UI_DIST || fileURLToPath(new URL('../../packages/ui/.output/public', import.meta.url))

export default defineNitroConfig({
  preset: 'node-server',
  compatibilityDate: '2025-01-01',
  experimental: { websocket: true },
  alias: { '@cocoproxy': source },
  nodeModulesDirs: [dependencies],
  // createRequire keeps the optional sender isolated; explicitly trace its
  // complete production closure so the packaged server can send notifications.
  externals: { traceInclude: [resolve(dependencies, 'web-push/src/index.js'), resolve(dependencies, 'web-push/src/cli.js')] },
  publicAssets: [{ baseURL: '/', dir: uiDist, maxAge: 0 }],
  ignore: ['**/__tests__/**', '**/*.spec.ts', '**/*.test.ts'],
  routeRules: { '/api/**': { headers: { 'cache-control': 'no-store' } }, '/config.js': { headers: { 'cache-control': 'no-store' } },
    '/cocoproxy-sw.js': { headers: { 'cache-control': 'no-cache', 'service-worker-allowed': '/' } },
    '/manifest.webmanifest': { headers: { 'cache-control': 'no-cache', 'content-type': 'application/manifest+json' } } },
})
