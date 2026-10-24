import { extname } from 'node:path'
import { createError, defineEventHandler, setHeader } from 'h3'
import { useNitroApp } from 'nitropack/runtime'

export default defineEventHandler(async (event) => {
  const path = event.path.split('?')[0] ?? '/'
  if (path.startsWith('/api/') || extname(path)) throw createError({ statusCode: 404, statusMessage: 'Not Found' })
  if (!['GET', 'HEAD'].includes(event.method)) throw createError({ statusCode: 405, statusMessage: 'Method Not Allowed' })
  // Let Nitro locate its bundled public asset; import.meta.url is rewritten to
  // the server entry during bundling and is unsuitable for chunk-relative paths.
  const shell = await useNitroApp().localFetch('/index.html')
  if (!shell.ok) throw createError({ statusCode: 503, statusMessage: 'Unavailable' })
  setHeader(event, 'content-type', 'text/html; charset=utf-8')
  setHeader(event, 'cache-control', 'no-store')
  return await shell.text()
})
