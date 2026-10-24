import { fromWebHandler } from 'h3'
import { getCoproxy, unavailable } from '../../lib/coproxy'

export default fromWebHandler(async (request) => {
  try { return await (await getCoproxy()).fetch(request) }
  catch { return unavailable() }
})
