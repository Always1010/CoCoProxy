import { loadManagementGateway } from '@cocoproxy/packages/management/service.ts'

let gateway: ReturnType<typeof loadManagementGateway> | undefined

/** Deployment config is private; no core or scheduler is started on import. */
export function getCoCoProxy() {
  if (!gateway) {
    const path = process.env.COCOPROXY_MANAGEMENT_CONFIG
    if (!path) return Promise.reject(new Error('MANAGEMENT_UNAVAILABLE'))
    gateway = loadManagementGateway(path).catch(() => {
      gateway = undefined
      throw new Error('MANAGEMENT_UNAVAILABLE')
    })
  }
  return gateway
}

export function unavailable() {
  return new Response(JSON.stringify({ error: { code: 'MANAGEMENT_UNAVAILABLE' } }), {
    status: 503, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
}
