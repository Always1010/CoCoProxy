import { defineEventHandler, setHeader } from 'h3'

export default defineEventHandler((event) => {
  setHeader(event, 'cache-control', 'no-store')
  event.node.res.statusCode = 404
  return { error: { code: 'LEGACY_AGENT_DISABLED' } }
})
