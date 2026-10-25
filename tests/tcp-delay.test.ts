import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:net';
import test from 'node:test';
import { describeTcpNode, probeTcpEndpoint, tcpEndpoint } from '../packages/management/tcp-delay.ts';

test('TCP measurement only establishes a connection, sends no proxy data, and excludes DNS time', async t => {
  let bytes = 0;
  const server = createServer(socket => { socket.on('data', data => { bytes += data.length; }); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const port = (server.address() as { port: number }).port;
  const result = await probeTcpEndpoint({ host: 'synthetic.example', port }, undefined, 2000, async () => {
    await new Promise(resolve => setTimeout(resolve, 150));
    return ['127.0.0.1'];
  });
  assert.equal(result.status, 'success');
  assert.ok(result.delay !== null && result.delay >= 0 && result.delay < 150);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(bytes, 0);
});

test('TCP failures distinguish DNS, refused ports, cancellation and deadline', async () => {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  assert.deepEqual(await probeTcpEndpoint({ host: '127.0.0.1', port }), { status: 'refused', delay: null });
  assert.deepEqual(await probeTcpEndpoint({ host: 'synthetic.example', port }, undefined, 1000, async () => []), { status: 'dns-failed', delay: null });
  const controller = new AbortController();
  controller.abort();
  assert.deepEqual(await probeTcpEndpoint({ host: '127.0.0.1', port }, controller.signal), { status: 'cancelled', delay: null });
  const heldResolution = async (_host: string, signal: AbortSignal): Promise<string[]> => new Promise(resolve => {
    const keepAlive = setTimeout(() => resolve([]), 1000);
    signal.addEventListener('abort', () => { clearTimeout(keepAlive); resolve([]); }, { once: true });
  });
  assert.deepEqual(await probeTcpEndpoint({ host: 'synthetic.example', port }, undefined, 10, heldResolution), { status: 'timeout', delay: null });
});

test('TCP metadata never exposes endpoints or credentials, invalidates edits, and skips UDP or chained nodes', () => {
  const node = { name: 'synthetic', type: 'vmess', server: '192.0.2.10', port: 443, uuid: 'EXAMPLE_ONLY_UUID' };
  const metadata = describeTcpNode(node);
  assert.deepEqual(Object.keys(metadata).sort(), ['applicable', 'fingerprint', 'name']);
  assert.equal(metadata.applicable, true);
  assert.notEqual(metadata.fingerprint, describeTcpNode({ ...node, port: 8443 }).fingerprint);
  assert.notEqual(metadata.fingerprint, describeTcpNode({ ...node, uuid: 'EXAMPLE_ONLY_CHANGED_UUID' }).fingerprint);
  for (const type of ['hysteria', 'hysteria2', 'tuic', 'wireguard', 'direct', 'reject', 'select'])
    assert.equal(tcpEndpoint({ ...node, type }), null);
  assert.equal(tcpEndpoint({ ...node, network: 'quic' }), null);
  assert.equal(tcpEndpoint({ ...node, 'dialer-proxy': 'synthetic-chain' }), null);
  assert.equal(tcpEndpoint({ ...node, port: 0 }), null);
});
