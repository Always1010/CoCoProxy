import { defineEventHandler, setHeader } from 'h3'

export default defineEventHandler((event) => {
  if (event.path.split('?')[0]?.startsWith('/api/control')) {
    setHeader(event, 'cache-control', 'no-store')
    event.node.res.statusCode = 404
    return { error: { code: 'LEGACY_AGENT_DISABLED' } }
  }
})
