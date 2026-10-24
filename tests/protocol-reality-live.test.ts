import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, randomUUID, constants } from 'node:crypto';
import { createSocket } from 'node:dgram';
import { chmod, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createTlsServer } from 'node:tls';
import test from 'node:test';
import { compileConfig } from '../packages/config/index.ts';
import { freePort, httpNonce, managedProcess, ownNetworkBindings, privateJson, reviewedBinary, udpNonce, waitBindings } from './protocol-live-helpers.ts';

const coreInput = process.env.COPROXY_TEST_MIHOMO;
const fixtureInput = process.env.COPROXY_TEST_SING_BOX;
const enabled = Boolean(coreInput && fixtureInput) && process.platform === 'linux' && process.geteuid?.() !== 0;

// Node's standard X25519 key generation supplies ephemeral synthetic inputs;
// only the reviewed official cores implement REALITY or VLESS on the wire.
function realityKeys() {
  const keys = generateKeyPairSync('x25519');
  return { privateKey: keys.privateKey.export({ format: 'jwk' }).d!, publicKey: keys.publicKey.export({ format: 'jwk' }).x! };
}

test('reviewed official cores pass VLESS REALITY loopback TCP and UDP and reject independent credentials',
  { skip: !enabled, timeout: 90_000 }, async t => {
    const review = JSON.parse(await readFile(new URL('../integrations/protocol-fixture/review.json', import.meta.url), 'utf8'));
    const coreReview = JSON.parse(await readFile(new URL('../integrations/metacubexd/review.json', import.meta.url), 'utf8'));
    const core = await reviewedBinary(coreInput!, coreReview.coreCandidate.binarySha256);
    const fixtureBinary = await reviewedBinary(fixtureInput!, review.server.binarySha256);
    const root = await mkdtemp(join(tmpdir(), 'coproxy-reality-live-'));
    await chmod(root, 0o700);
    const previousUmask = process.umask(0o077);
    const processes = new Set<ReturnType<typeof managedProcess>>();
    const launch = (binary: string, args: string[]) => { const child = managedProcess(binary, args, root); processes.add(child); return child; };
    const stop = async (child: ReturnType<typeof managedProcess>) => { await child.stop(); processes.delete(child); };
    const sockets = new Set<Socket>();
    const track = (socket: Socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); };
    let httpHits = 0, udpHits = 0, targetConnections = 0;
    const http = createHttpServer((req, res) => { httpHits++; res.writeHead(200); res.end(req.url?.slice(1)); });
    http.on('connection', track);
    const udp = createSocket('udp4');
    udp.on('message', (payload, peer) => { udpHits++; udp.send(payload, peer.port, peer.address); });
    let httpBound = false, udpBound = false;
    let tlsTarget: ReturnType<typeof createTlsServer> | undefined;
    let tlsBound = false;
    try {
      await new Promise<void>((resolve, reject) => { http.once('error', reject); http.listen(0, '127.0.0.1', resolve); }); httpBound = true;
      await new Promise<void>((resolve, reject) => { udp.once('error', reject); udp.bind(0, '127.0.0.1', resolve); }); udpBound = true;
      const httpPort = (http.address() as { port: number }).port, udpPort = udp.address().port;
      const certPath = join(root, 'handshake-cert.pem'), keyPath = join(root, 'handshake-key.pem');
      const certificate = launch('/usr/bin/openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-nodes', '-days', '1',
        '-subj', '/CN=reality-fixture.invalid', '-addext', 'subjectAltName=DNS:reality-fixture.invalid', '-keyout', keyPath, '-out', certPath]);
      await certificate.success(); await stop(certificate);
      await Promise.all([chmod(certPath, 0o600), chmod(keyPath, 0o600)]);
      tlsTarget = createTlsServer({ key: await readFile(keyPath), cert: await readFile(certPath),
        minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3', ecdhCurve: 'X25519', ALPNProtocols: ['h2', 'http/1.1'],
        secureOptions: constants.SSL_OP_NO_TICKET, handshakeTimeout: 2500 }, socket => {
        assert.equal(socket.getProtocol(), 'TLSv1.3');
        // The target is a handshake fixture and never serves either origin.
        socket.on('data', () => {}); socket.setTimeout(2500, () => socket.destroy());
      });
      tlsTarget.on('connection', socket => { targetConnections++; track(socket); socket.on('error', () => {}); socket.setTimeout(2500, () => socket.destroy()); });
      tlsTarget.on('tlsClientError', () => {});
      await new Promise<void>((resolve, reject) => { tlsTarget!.once('error', reject); tlsTarget!.listen(0, '127.0.0.1', resolve); }); tlsBound = true;
      const targetPort = (tlsTarget.address() as { port: number }).port;
      const used = new Set([httpPort, udpPort, targetPort]);
      const serverPort = await freePort(used), keys = realityKeys(), uuid = randomUUID(), shortId = randomBytes(8).toString('hex');
      const configPath = join(root, 'server.json');
      await privateJson(configPath, { log: { level: 'error' },
        inbounds: [{ type: 'vless', tag: 'synthetic-reality', listen: '127.0.0.1', listen_port: serverPort, users: [{ uuid }],
          tls: { enabled: true, server_name: 'reality-fixture.invalid', handshake_timeout: '3s', reality: { enabled: true,
            handshake: { server: '127.0.0.1', server_port: targetPort, inet4_bind_address: '127.0.0.1' },
            private_key: keys.privateKey, short_id: [shortId] } } }],
        outbounds: [{ type: 'direct', tag: 'synthetic-origin', inet4_bind_address: '127.0.0.1' }],
        route: { rules: [{ ip_cidr: ['127.0.0.1/32'], port: [httpPort, udpPort], action: 'route', outbound: 'synthetic-origin' }, { action: 'reject' }] } });
      const serverSyntax = launch(fixtureBinary, ['check', '-c', configPath]); await serverSyntax.success(); await stop(serverSyntax);
      const server = launch(fixtureBinary, ['run', '-c', configPath]); await waitBindings(server, [{ port: serverPort }]);
      for (const scenario of ['correct', 'wrong-uuid', 'wrong-public-key', 'wrong-short-id'] as const) {
        await t.test(scenario, async () => {
          const mixedPort = await freePort(used), controllerPort = await freePort(used), dnsPort = await freePort(used);
          const candidate = compileConfig({ schemaVersion: 1, deployment: { mixedPort, controllerPort, dnsPort,
            controllerSecret: randomBytes(32).toString('hex'), bootstrapResolvers: ['127.0.0.1'] },
          policy: { 'log-level': 'error', proxies: [{ name: 'synthetic-reality', type: 'vless', server: '127.0.0.1', port: serverPort,
            uuid: scenario === 'wrong-uuid' ? randomUUID() : uuid, udp: true, tls: true, servername: 'reality-fixture.invalid',
            'client-fingerprint': 'chrome', 'reality-opts': { 'public-key': scenario === 'wrong-public-key' ? realityKeys().publicKey : keys.publicKey,
              'short-id': scenario === 'wrong-short-id' ? randomBytes(8).toString('hex') : shortId } }], rules: ['MATCH,synthetic-reality'] } });
          assert.deepEqual(candidate.config.rules, ['MATCH,synthetic-reality']);
          const home = join(root, scenario); await mkdir(home, { mode: 0o700 });
          const clientConfig = join(home, 'config.json'); await privateJson(clientConfig, candidate.config);
          const syntax = launch(core, ['-t', '-d', home, '-f', clientConfig]); await syntax.success(); await stop(syntax);
          const client = launch(core, ['-d', home, '-f', clientConfig]);
          try {
            await waitBindings(client, [{ port: mixedPort }, { port: controllerPort }, { port: dnsPort, udp: true }]);
            const beforeHttp = httpHits, beforeUdp = udpHits, beforeTarget = targetConnections, nonce = randomBytes(16).toString('hex');
            if (scenario === 'correct') {
              await httpNonce(mixedPort, httpPort, nonce); assert.equal(httpHits, beforeHttp + 1);
              await udpNonce(mixedPort, udpPort, Buffer.from(nonce)); assert.equal(udpHits, beforeUdp + 1);
            } else {
              await assert.rejects(httpNonce(mixedPort, httpPort, nonce));
              await assert.rejects(udpNonce(mixedPort, udpPort, Buffer.from(nonce), 1500), /UDP_TIMEOUT/);
              assert.equal(httpHits, beforeHttp, 'negative REALITY credentials reached HTTP origin');
              assert.equal(udpHits, beforeUdp, 'negative REALITY credentials reached UDP origin');
            }
            assert.ok(targetConnections > beforeTarget, 'REALITY did not contact the synthetic TLS handshake target');
            await ownNetworkBindings(client.pid!, [mixedPort, controllerPort, dnsPort]); await ownNetworkBindings(server.pid!, [serverPort]);
            assert.ok(client.healthy() && server.healthy());
          } finally { await stop(client); }
        });
      }
    } finally {
      const cleanup = await Promise.allSettled([...processes].map(child => child.stop()));
      for (const socket of sockets) socket.destroy();
      const servers = await Promise.allSettled([
        ...(httpBound ? [new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve()))] : []),
        ...(udpBound ? [new Promise<void>(resolve => udp.close(resolve))] : []),
        ...(tlsBound ? [new Promise<void>((resolve, reject) => tlsTarget!.close(error => error ? reject(error) : resolve()))] : []),
      ]);
      try { await rm(root, { recursive: true, force: true }); } finally { process.umask(previousUmask); }
      for (const result of [...cleanup, ...servers]) if (result.status === 'rejected') throw result.reason;
    }
  });
