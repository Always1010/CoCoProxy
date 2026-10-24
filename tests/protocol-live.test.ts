import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createSocket } from 'node:dgram';
import { chmod, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { compileConfig, type JsonObject } from '../packages/config/index.ts';
import { freePort, httpNonce, managedProcess, ownNetworkBindings, privateJson, reviewedBinary, udpNonce, waitBindings } from './protocol-live-helpers.ts';

const coreInput = process.env.COPROXY_TEST_MIHOMO;
const fixtureInput = process.env.COPROXY_TEST_SING_BOX;
const enabled = Boolean(coreInput && fixtureInput) && process.platform === 'linux' && process.geteuid?.() !== 0;
const protocols = ['vmess', 'vless', 'trojan', 'ss', 'hysteria2', 'tuic'] as const;
type Protocol = typeof protocols[number];

test('reviewed official cores interoperate across six loopback node protocols without credential fallback',
  { skip: !enabled, timeout: 150_000 }, async t => {
    const review = JSON.parse(await readFile(new URL('../integrations/protocol-fixture/review.json', import.meta.url), 'utf8'));
    const coreReview = JSON.parse(await readFile(new URL('../integrations/metacubexd/review.json', import.meta.url), 'utf8'));
    const core = await reviewedBinary(coreInput!, coreReview.coreCandidate.binarySha256);
    const fixtureBinary = await reviewedBinary(fixtureInput!, review.server.binarySha256);
    const previousUmask = process.umask(0o077);
    const root = await mkdtemp(join(tmpdir(), 'coproxy-protocol-live-'));
    await chmod(root, 0o700);
    // A single finally owns processes before removing their private state.
    const processes = new Set<ReturnType<typeof managedProcess>>();
    const launch = (binary: string, args: string[]) => { const child = managedProcess(binary, args, root); processes.add(child); return child; };
    const stop = async (child: ReturnType<typeof managedProcess>) => { await child.stop(); processes.delete(child); };
    const originSockets = new Set<Socket>();
    let httpHits = 0, udpHits = 0;
    const http = createHttpServer((req, res) => { httpHits++; res.writeHead(200); res.end(req.url?.slice(1)); });
    http.on('connection', socket => { originSockets.add(socket); socket.once('close', () => originSockets.delete(socket)); });
    const udp = createSocket('udp4');
    udp.on('message', (payload, peer) => { udpHits++; udp.send(payload, peer.port, peer.address); });
    let httpBound = false, udpBound = false;
    try {
      await new Promise<void>((resolve, reject) => { http.once('error', reject); http.listen(0, '127.0.0.1', resolve); }); httpBound = true;
      await new Promise<void>((resolve, reject) => { udp.once('error', reject); udp.bind(0, '127.0.0.1', resolve); }); udpBound = true;
      const httpPort = (http.address() as { port: number }).port, udpPort = udp.address().port;
      const certPath = join(root, 'certificate.pem'), keyPath = join(root, 'key.pem');
      const cert = launch('/usr/bin/openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-nodes', '-days', '1',
        '-subj', '/CN=protocol-fixture.invalid', '-addext', 'subjectAltName=DNS:protocol-fixture.invalid', '-keyout', keyPath, '-out', certPath]);
      await cert.success(); await stop(cert);
      await Promise.all([chmod(certPath, 0o600), chmod(keyPath, 0o600)]);
      const used = new Set<number>([httpPort, udpPort]);
      const ports = new Map<Protocol, number>();
      for (const protocol of protocols) ports.set(protocol, await freePort(used));
      const uuid = randomUUID(), password = randomBytes(24).toString('hex');
      const tls = { enabled: true, certificate_path: certPath, key_path: keyPath };
      const inbounds = protocols.map(protocol => {
        const common = { type: protocol === 'ss' ? 'shadowsocks' : protocol, tag: protocol, listen: '127.0.0.1', listen_port: ports.get(protocol)! };
        if (protocol === 'vmess' || protocol === 'vless') return { ...common, users: [{ uuid }] };
        if (protocol === 'ss') return { ...common, method: 'aes-128-gcm', password };
        if (protocol === 'trojan') return { ...common, users: [{ password }], tls };
        if (protocol === 'hysteria2') return { ...common, users: [{ password }], tls };
        return { ...common, users: [{ uuid, password }], congestion_control: 'cubic', auth_timeout: '1s', tls: { ...tls, alpn: ['h3'] } };
      });
      assert.ok(inbounds.every(inbound => inbound.listen === '127.0.0.1' && inbound.listen_port >= 1024));
      const serverConfig = join(root, 'server.json');
      // The official fixture can forward only to the two synthetic local origins.
      await privateJson(serverConfig, { log: { level: 'error' }, inbounds, outbounds: [{ type: 'direct', tag: 'synthetic-origin', inet4_bind_address: '127.0.0.1' }],
        route: { rules: [{ ip_cidr: ['127.0.0.1/32'], port: [httpPort, udpPort], action: 'route', outbound: 'synthetic-origin' }, { action: 'reject' }] } });
      const syntax = launch(fixtureBinary, ['check', '-c', serverConfig]); await syntax.success(); await stop(syntax);
      const server = launch(fixtureBinary, ['run', '-c', serverConfig]);
      await waitBindings(server, [...protocols.map(protocol => ({ port: ports.get(protocol)!, udp: protocol === 'hysteria2' || protocol === 'tuic' })), { port: ports.get('ss')!, udp: true }]);
      for (const protocol of protocols) {
        await t.test(protocol, { timeout: 22_000 }, async () => {
          for (const wrongCredential of [false, true]) {
            const mixedPort = await freePort(used), controllerPort = await freePort(used), dnsPort = await freePort(used);
            const node: JsonObject = { name: 'synthetic-node', type: protocol, server: '127.0.0.1', port: ports.get(protocol)!, udp: true };
            if (protocol === 'vmess' || protocol === 'vless' || protocol === 'tuic') node.uuid = wrongCredential ? randomUUID() : uuid;
            if (protocol === 'vmess') { node.alterId = 0; node.cipher = 'auto'; }
            if (protocol === 'ss') node.cipher = 'aes-128-gcm';
            if (protocol !== 'vmess' && protocol !== 'vless') node.password = wrongCredential ? randomBytes(24).toString('hex') : password;
            if (protocol === 'trojan' || protocol === 'hysteria2' || protocol === 'tuic') { node.sni = 'protocol-fixture.invalid'; node['skip-cert-verify'] = true; }
            if (protocol === 'hysteria2') { node.up = '100 Mbps'; node.down = '100 Mbps'; }
            if (protocol === 'tuic') { node.alpn = ['h3']; node['congestion-controller'] = 'cubic'; node['udp-relay-mode'] = 'native'; node['reduce-rtt'] = false; }
            const candidate = compileConfig({ schemaVersion: 1, deployment: { mixedPort, controllerPort, dnsPort,
              controllerSecret: randomBytes(32).toString('hex'), bootstrapResolvers: ['127.0.0.1'] },
            policy: { 'log-level': 'error', proxies: [node], rules: ['MATCH,synthetic-node'] } });
            assert.deepEqual(candidate.config.rules, ['MATCH,synthetic-node']);
            assert.equal(candidate.config['bind-address'], '127.0.0.1');
            const home = join(root, `${protocol}-${wrongCredential ? 'negative' : 'positive'}`);
            await mkdir(home, { mode: 0o700 });
            const config = join(home, 'config.json'); await privateJson(config, candidate.config);
            const validate = launch(core, ['-t', '-d', home, '-f', config]); await validate.success(); await stop(validate);
            const client = launch(core, ['-d', home, '-f', config]);
            try {
              await waitBindings(client, [{ port: mixedPort }, { port: controllerPort }, { port: dnsPort, udp: true }]);
              const beforeHttp = httpHits, beforeUdp = udpHits, nonce = randomBytes(16).toString('hex');
              if (!wrongCredential) {
                await httpNonce(mixedPort, httpPort, nonce); assert.equal(httpHits, beforeHttp + 1);
                await udpNonce(mixedPort, udpPort, Buffer.from(nonce)); assert.equal(udpHits, beforeUdp + 1);
              } else {
                await assert.rejects(httpNonce(mixedPort, httpPort, nonce));
                await assert.rejects(udpNonce(mixedPort, udpPort, Buffer.from(nonce), 1500), /UDP_TIMEOUT/);
                assert.equal(httpHits, beforeHttp, 'wrong credentials reached HTTP origin, indicating bypass');
                assert.equal(udpHits, beforeUdp, 'wrong credentials reached UDP origin, indicating bypass');
              }
              await ownNetworkBindings(client.pid!, [mixedPort, controllerPort, dnsPort]); await ownNetworkBindings(server.pid!, [...ports.values()]);
              assert.ok(client.healthy() && server.healthy(), 'live child unexpectedly exited');
            } finally { await stop(client); }
          }
        });
      }
    } finally {
      const cleanup = await Promise.allSettled([...processes].map(child => child.stop()));
      for (const socket of originSockets) socket.destroy();
      if (httpBound) await new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve()));
      if (udpBound) await new Promise<void>(resolve => udp.close(resolve));
      await rm(root, { recursive: true, force: true });
      process.umask(previousUmask);
      for (const result of cleanup) if (result.status === 'rejected') throw result.reason;
    }
  });
