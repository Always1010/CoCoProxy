import { defineEventHandler, setHeader } from 'h3'

export default defineEventHandler((event) => {
  setHeader(event, 'content-type', 'text/javascript; charset=utf-8')
  setHeader(event, 'cache-control', 'no-store')
  return 'window.__METACUBEXD_CONFIG__ = Object.freeze({})\n'
})
