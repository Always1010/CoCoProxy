import { WebSocketServer } from 'ws';
import { createServer } from 'node:http';
import { createFixtures } from './fixtures.mjs';

/** Install only on the isolated Nuxt development server, never the product server. */
export function createPreviewServer() {
  const fixtures = createFixtures();
  const sockets = new Set();
  const wss = new WebSocketServer({ noServer: true });
  let ownServer, allowedOrigin;
  async function handle(req, res) {
    if (!req.url?.startsWith('/api/')) return;
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('X-CoCoProxy-UI-Preview', 'synthetic');
    try {
      // The launcher binds loopback. Reject cross-origin writes and DNS rebinding.
      const host = req.headers.host ?? '';
      if (!/^127\.0\.0\.1:\d+$/.test(host) || (req.headers.origin && req.headers.origin !== (allowedOrigin ?? `http://${host}`))) {
        res.writeHead(403); res.end(JSON.stringify({ error: { code: 'ORIGIN_DENIED' } })); return;
      }
      res.setHeader('Access-Control-Allow-Origin', allowedOrigin ?? `http://${host}`);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Expose-Headers', 'X-CoCoProxy-Generation, X-CoCoProxy-UI-Preview');
      if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'content-type, if-match, x-cocoproxy-bandwidth-client');
        res.writeHead(204); res.end(); return;
      }
      const chunks = []; let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 1024 * 1024) { res.writeHead(413); res.end(JSON.stringify({ error: { code: 'BODY_LIMIT' } })); return; }
        chunks.push(chunk);
      }
      const body = size ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('INVALID_JSON');
      await new Promise(accept => {
        const cancelled = () => { clearTimeout(timer); accept(); };
        const timer = setTimeout(() => { res.off('close', cancelled); accept(); }, fixtures.delay(req.url));
        res.once('close', cancelled);
      });
      if (res.destroyed) return;
      const result = fixtures.respond(req.method, req.url, body);
      res.setHeader('X-CoCoProxy-Generation', fixtures.generation);
      res.writeHead(result.status); res.end(JSON.stringify(result.data));
    } catch {
      if (res.destroyed || res.writableEnded) return;
      if (!res.headersSent) res.writeHead(400);
      res.end(JSON.stringify({ error: { code: 'INVALID_JSON' } }));
    }
  }
  function upgrade(req, socket, head) {
    const path = new URL(req.url, 'http://127.0.0.1').pathname;
    if (!path.startsWith('/api/')) return;
    if (!/^127\.0\.0\.1:\d+$/.test(req.headers.host ?? '') || req.headers.origin !== (allowedOrigin ?? `http://${req.headers.host}`) || !fixtures.stream(path, 0)) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, ws => {
      sockets.add(ws); let tick = 0;
      const send = () => { if (ws.readyState === 1) ws.send(JSON.stringify(fixtures.stream(path, tick++)), error => { if (error) ws.terminate(); }); };
      send(); const timer = setInterval(send, 1000);
      ws.on('close', () => { clearInterval(timer); sockets.delete(ws); });
      ws.on('error', () => ws.terminate());
    });
  }
  return { handle,
    async listen(origin) {
      allowedOrigin = origin;
      // Own native HTTP/WS sockets so cancellation cannot interfere with
      // Nitro/Vite's development request adapter or HMR upgrade listeners.
      ownServer = createServer((req, res) => {
        if (req.url?.startsWith('/api/')) void handle(req, res);
        else { res.writeHead(404); res.end(); }
      });
      ownServer.on('upgrade', upgrade);
      await new Promise((accept, reject) => { ownServer.once('error', reject); ownServer.listen(0, '127.0.0.1', accept); });
      return `http://127.0.0.1:${ownServer.address().port}`;
    },
    async close() {
      for (const ws of sockets) ws.terminate();
      wss.close();
      if (ownServer) await new Promise(accept => ownServer.close(accept));
    },
  };
}
