import { fromWebHandler } from 'h3'
import { getCoCoProxy, unavailable } from '../../lib/cocoproxy'

export default fromWebHandler(async (request) => {
  try { return await (await getCoCoProxy()).fetch(request) }
  catch { return unavailable() }
})
