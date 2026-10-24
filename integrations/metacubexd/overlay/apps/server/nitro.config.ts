import { fileURLToPath } from 'node:url'
import { isAbsolute, resolve } from 'node:path'
import { defineNitroConfig } from 'nitropack/config'

const source = process.env.COPROXY_SOURCE_DIR
if (!source || !isAbsolute(source) || resolve(source) !== source) throw new Error('COPROXY_SOURCE_DIR_REQUIRED')
const uiDist = process.env.UI_DIST || fileURLToPath(new URL('../../packages/ui/.output/public', import.meta.url))

export default defineNitroConfig({
  preset: 'node-server',
  compatibilityDate: '2025-01-01',
  experimental: { websocket: true },
  alias: { '@coproxy': source },
  nodeModulesDirs: [resolve(source, 'node_modules')],
  publicAssets: [{ baseURL: '/', dir: uiDist, maxAge: 0 }],
  ignore: ['**/__tests__/**', '**/*.spec.ts', '**/*.test.ts'],
  routeRules: { '/api/**': { headers: { 'cache-control': 'no-store' } }, '/config.js': { headers: { 'cache-control': 'no-store' } } },
})
