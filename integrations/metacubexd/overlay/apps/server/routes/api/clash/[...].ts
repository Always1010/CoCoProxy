import { defineEventHandler, fromWebHandler } from 'h3'
import { stripControllerMount } from '@cocoproxy/packages/management/service.ts'
import { ManagementError } from '@cocoproxy/packages/management/http.ts'
import { getCoCoProxy, unavailable } from '../../../lib/cocoproxy'

type RelayState = { closed: boolean; cleanup?: () => void }
const connections = new WeakMap<object, RelayState>()
let openConnections = 0
const requestOf = (input: { url: string; headers: Headers }) => new Request(input.url, { headers: input.headers })
function finish(peer: object) {
  const state = connections.get(peer)
  if (state) { state.closed = true; connections.delete(peer); openConnections--; state.cleanup?.() }
}

export default defineEventHandler({
  handler: fromWebHandler(async (request) => {
    try { return await (await getCoCoProxy()).fetch(request) }
    catch { return unavailable() }
  }),
  websocket: {
    async upgrade(input) {
      try { (await getCoCoProxy()).authorize(requestOf(input), true) }
      catch (error) {
        return new Response(null, { status: error instanceof ManagementError ? error.status : 503,
          headers: { 'cache-control': 'no-store' } })
      }
    },
    async open(peer) {
      if (openConnections >= 128) { peer.close(1013, 'STREAM_LIMIT'); return }
      const state: RelayState = { closed: false }
      connections.set(peer, state)
      openConnections++
      try {
        const gateway = await getCoCoProxy()
        const request = requestOf(peer.request)
        gateway.authorize(request, true)
        state.cleanup = await gateway.controller.relay(stripControllerMount(request), {
          send(text) {
            const socket = peer.websocket
            // This adapter targets Nitro's Node preset, whose peer exposes ws.
            if (state.closed || socket.readyState !== 1 || typeof socket.bufferedAmount !== 'number' ||
                socket.bufferedAmount + Buffer.byteLength(text) > 2 * 1024 * 1024) throw new Error('CLIENT_BACKPRESSURE')
            peer.send(text)
          },
          close(code, reason) { finish(peer); peer.close(code, reason) },
        }, () => {
          try { gateway.authorize(request, true); return !state.closed } catch { return false }
        })
        if (state.closed) state.cleanup()
      } catch { finish(peer); peer.close(1008, 'CONTROLLER_UNAVAILABLE') }
    },
    message(peer) { finish(peer); peer.close(1008, 'READ_ONLY_STREAM') },
    close(peer) { finish(peer) },
    error(peer) { finish(peer); peer.terminate() },
  },
})
