import { defineNitroPlugin } from 'nitropack/runtime'
import { ManagementError } from '@cocoproxy/packages/management/http.ts'
import { getCoCoProxy } from '../lib/cocoproxy'

// systemd and the explicit CoCoProxy transaction own the core lifecycle.
export default defineNitroPlugin(async (app) => {
  // h3 caches this adapter options object. Nitro passes it to crossws/node.
  Object.assign(app.h3App.websocket, {
    serverOptions: { maxPayload: 4096, perMessageDeflate: false },
    hooks: {
      async upgrade(input: { url: string; headers: Headers }) {
        try {
          // crossws upgrades even when a resolved route has no WebSocket hooks.
          // Guard every upgrade before the route-specific lifecycle can run.
          const request = new Request(input.url, { headers: input.headers })
          if (!new URL(request.url).pathname.startsWith('/api/clash/')) {
            return new Response(null, { status: 404, headers: { 'cache-control': 'no-store' } })
          }
          const gateway = await getCoCoProxy()
          gateway.authorize(request, true)
        } catch (error) {
          return new Response(null, {
            status: error instanceof ManagementError ? error.status : 503,
            headers: { 'cache-control': 'no-store' },
          })
        }
      },
    },
  })
  try {
    const gateway = await getCoCoProxy()
    app.hooks.hook('close', () => gateway.closeLifecycle())
    const recovered = await gateway.startLifecycle()
    if (!recovered.recovered) console.error('COCOPROXY_STARTUP_RECOVERY_INCOMPLETE')
  } catch {
    // Keep management reachable with fixed errors when private state is invalid.
    console.error('COCOPROXY_STARTUP_RECOVERY_UNAVAILABLE')
  }
})
