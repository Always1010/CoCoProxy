import { defineEventHandler, sendWebResponse, toWebRequest } from 'h3'
import { recordRequestAddress } from '@cocoproxy/packages/management/request-address.ts'
import { getCoCoProxy, unavailable } from '../../lib/cocoproxy'

export default defineEventHandler(async (event) => {
  const request = toWebRequest(event)
  recordRequestAddress(request, event.node.req.socket.remoteAddress)
  try { return await sendWebResponse(event, await (await getCoCoProxy()).fetch(request)) }
  catch { return await sendWebResponse(event, unavailable()) }
})
