#!/usr/bin/env python3
"""Synthetic kernel fixture. No mounts, named netns, host network tools or installs.

Only the TypeScript test renders production rules/configuration. This fixture
applies those exact artifacts inside a verified new user/network namespace tree.
The existing cgroup membership is a fixture override, not production isolation.
"""
import json
import os
from pathlib import Path
import resource
import select
import signal
import socket
import struct
import subprocess
import sys
import threading
import time

LIMIT = 65536
SELF = str(Path(__file__).resolve())
HOST_USER, HOST_NET = sys.argv[-2:]


def check(condition, code):
    if not condition:
        raise RuntimeError(code)


def namespace(kind):
    return os.readlink('/proc/self/ns/' + kind)


def isolated():
    check(namespace('user') != HOST_USER and namespace('net') != HOST_NET, 'ISOLATION_NOT_VERIFIED')


def execute(args, data=None):
    isolated()
    result = subprocess.run(args, input=data, text=True, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, timeout=6)
    check(result.returncode == 0, 'NETWORK_COMMAND_FAILED_' + args[0].upper())
    check(len(result.stdout) + len(result.stderr) <= LIMIT, 'COMMAND_OUTPUT_LIMIT')
    return result.stdout


def private_json(path, value):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as out:
        json.dump(value, out)


def limited():
    resource.setrlimit(resource.RLIMIT_FSIZE, (LIMIT, LIMIT))


def native_limits():
    # Durable bounded receipts contain full nft AST/echo, including base64.
    # Keep IPC's small LIMIT while allowing the transport's 6 MiB disk result.
    resource.setrlimit(resource.RLIMIT_FSIZE, (8 * 1024 * 1024, 8 * 1024 * 1024))


class Worker:
    def __init__(self, name, root):
        self.name = name
        self.process = subprocess.Popen(['unshare', '--net', 'python3', SELF, '--role',
                                         name, str(root), HOST_USER, HOST_NET],
                                        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                        text=True, bufsize=1)
        ready = self.read()
        check(ready.get('ready') and ready['net'] != namespace('net'), 'ROLE_NAMESPACE_FAILED')
        self.net = ready['net']

    def read(self):
        check(bool(select.select([self.process.stdout], [], [], 12)[0]), 'ROLE_TIMEOUT')
        line = self.process.stdout.readline(LIMIT)
        check(bool(line), 'ROLE_EXIT')
        value = json.loads(line)
        check('error' not in value, value.get('error', 'ROLE_ERROR'))
        return value

    def call(self, op, **values):
        self.process.stdin.write(json.dumps(dict(op=op, **values)) + '\n')
        self.process.stdin.flush()
        return self.read()['value']

    def ip(self, *args):
        return self.call('exec', args=['ip', *args])

    def nft(self, text):
        return self.call('exec', args=['nft', '-f', '-'], data=text)

    def close(self):
        if self.process.poll() is None:
            try:
                self.call('quit')
            finally:
                try:
                    self.process.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    self.process.kill()
                    self.process.wait(timeout=3)


def origin_servers(state):
    def http_client(conn):
        with conn:
            conn.settimeout(15)
            pending = b''
            try:
                while True:
                    while b'\r\n\r\n' not in pending:
                        chunk = conn.recv(4096)
                        if not chunk:
                            return
                        pending += chunk
                        check(len(pending) < 8192, 'HTTP_INPUT_LIMIT')
                    header, pending = pending.split(b'\r\n\r\n', 1)
                    body = header.split(b' ')[1].lstrip(b'/')
                    state['http'] += 1
                    key = 'http_' + conn.getsockname()[0].split('.')[-1]
                    state[key] = state.get(key, 0) + 1
                    conn.sendall(b'HTTP/1.1 200 OK\r\nContent-Length: ' + str(len(body)).encode() +
                                 b'\r\nConnection: keep-alive\r\n\r\n' + body)
            except (OSError, RuntimeError):
                return

    def http(address):
        listener = socket.socket()
        listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        listener.bind((address, 8080))
        listener.listen(8)
        while True:
            conn, _ = listener.accept()
            threading.Thread(target=http_client, args=(conn,), daemon=True).start()

    def udp(address, port, key):
        listener = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        listener.bind((address, port))
        while True:
            data, peer = listener.recvfrom(4096)
            state[key] += 1
            if key == 'dns':
                offset, labels = 12, []
                while data[offset]:
                    length = data[offset]
                    labels.append(data[offset + 1:offset + 1 + length].decode('ascii'))
                    offset += length + 1
                name = '.'.join(labels)
                target = '198.51.100.78' if name.endswith('.blocked.invalid') else '198.51.100.77'
                data = data[:2] + b'\x81\x80\x00\x01\x00\x01\x00\x00\x00\x00' + data[12:] + \
                       b'\xc0\x0c\x00\x01\x00\x01\x00\x00\x00\x1e\x00\x04' + socket.inet_aton(target)
                peer_key = 'dns_node' if peer[0].startswith('198.51.100.') else 'dns_core'
                state[peer_key] = state.get(peer_key, 0) + 1
            else:
                address_key = 'udp_' + address.split('.')[-1]
                state[address_key] = state.get(address_key, 0) + 1
            listener.sendto(data, peer)

    services = [(udp, ('198.51.100.2', 53, 'dns'))]
    for address in ['198.51.100.2', '198.51.100.77', '198.51.100.78']:
        services.extend([(http, (address,)), (udp, (address, 8081, 'udp'))])
    for target, args in services:
        threading.Thread(target=target, args=args, daemon=True).start()
    time.sleep(.15)


def role(name, root):
    isolated()
    print(json.dumps({'ready': True, 'net': namespace('net')}), flush=True)
    children, sockets, resolved = {}, {}, {}
    state = {'http': 0, 'udp': 0, 'dns': 0}
    try:
        for line in sys.stdin:
            request = json.loads(line)
            op = request['op']
            value = None
            if op == 'exec':
                value = execute(request['args'], request.get('data'))
            elif op == 'origin':
                origin_servers(state)
            elif op == 'stats':
                value = dict(state)
            elif op == 'start':
                label = request['label']
                path = root / (label + '.json')
                private_json(path, request['config'])
                args = [request['binary'], *[str(path) if item == '@CONFIG' else str(root) if item == '@ROOT' else item
                                             for item in request['args']]]
                log = os.open(root / (label + '.log'), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
                try:
                    children[label] = subprocess.Popen(args, stdout=log, stderr=subprocess.STDOUT, preexec_fn=limited)
                finally:
                    os.close(log)
                value = children[label].pid
            elif op == 'stop':
                child = children.pop(request['label'])
                child.terminate()
                try:
                    child.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait(timeout=2)
            elif op == 'alive':
                value = children[request['label']].poll() is None
            elif op == 'native':
                if 'native' not in children:
                    data = json.loads((root / 'input.json').read_text())
                    log = os.open(root / 'native.log', os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
                    try:
                        children['native'] = subprocess.Popen([data['node'], '--experimental-strip-types',
                            str(Path(SELF).with_name('network-native.ts')), str(root), HOST_USER, HOST_NET],
                            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=log, text=True, bufsize=1, preexec_fn=native_limits)
                    finally:
                        os.close(log)
                    check(bool(select.select([children['native'].stdout], [], [], 10)[0]), 'NATIVE_START_TIMEOUT')
                    ready = json.loads(children['native'].stdout.readline(LIMIT))
                    check(ready.get('ready') and ready.get('readonlyPreflight') and ready.get('explicitSettlement'), 'NATIVE_START_FAILED')
                native = children['native']
                command = {'op': request['action']}
                if request['action'] in ('probe', 'socket-probe'):
                    command['corePid'] = children['core'].pid
                native.stdin.write(json.dumps(command) + '\n')
                native.stdin.flush()
                if request['action'] == 'recover-checkpoint':
                    check(native.wait(timeout=10) == -signal.SIGKILL, 'NATIVE_CHECKPOINT_NOT_KILLED')
                    children.pop('native')
                    print(json.dumps({'value': True}), flush=True)
                    continue
                check(bool(select.select([native.stdout], [], [], 10)[0]), 'NATIVE_OPERATION_TIMEOUT')
                answer = json.loads(native.stdout.readline(LIMIT))
                check('error' not in answer, 'NATIVE_' + request['action'].upper() + '_' + answer.get('error', 'OPERATION_FAILED'))
                value = answer['value']
            elif op in ('http', 'udp', 'dns', 'dns_tcp'):
                key = request.get('key', '')
                sock = sockets.get(key) if key else None
                address = resolved.get(request.get('resolved'), request.get('address', '198.51.100.2'))
                check(address in ['198.51.100.2', '198.51.100.77', '198.51.100.78'], 'UNEXPECTED_SYNTHETIC_TARGET')
                try:
                    if sock is None:
                        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM if op in ('http', 'dns_tcp') else socket.SOCK_DGRAM)
                        sock.settimeout(1.2)
                        if request.get('loopback'):
                            sock.bind(('127.0.0.1', 0))
                        if request.get('mark') is not None:
                            sock.setsockopt(socket.SOL_SOCKET, 36, request['mark'])
                        if op == 'http':
                            sock.connect((address, 8080))
                        elif op == 'dns_tcp':
                            sock.connect(('192.0.2.2', 15353))
                        if key:
                            sockets[key] = sock
                    nonce = request.get('nonce', os.urandom(12).hex()).encode()
                    if op == 'http':
                        sock.sendall(b'GET /' + nonce + b' HTTP/1.1\r\nHost: fixture.invalid\r\n\r\n')
                        answer = b''
                        while b'\r\n\r\n' not in answer:
                            chunk = sock.recv(4096)
                            if not chunk:
                                break
                            answer += chunk
                        check(b'\r\n\r\n' in answer, 'HTTP_NO_RESPONSE')
                        header, body = answer.split(b'\r\n\r\n', 1)
                        while len(body) < len(nonce):
                            chunk = sock.recv(4096)
                            if not chunk:
                                break
                            body += chunk
                        value = body == nonce
                    elif op == 'udp':
                        sock.sendto(nonce, (address, 8081))
                        value = sock.recvfrom(4096)[0] == nonce
                    else:
                        domain = request.get('domain', nonce.decode('ascii') + '.invalid')
                        labels = domain.encode('ascii').split(b'.')
                        check(all(0 < len(label) <= 63 for label in labels), 'DNS_LABEL_LIMIT')
                        packet = b'\x34\x56\x01\x00\x00\x01\x00\x00\x00\x00\x00\x00' + b''.join(bytes([len(label)]) + label for label in labels) + b'\x00\x00\x01\x00\x01'
                        if op == 'dns_tcp':
                            sock.sendall(struct.pack('!H', len(packet)) + packet)
                            response = b''
                            while len(response) < 2:
                                chunk = sock.recv(4096)
                                if not chunk:
                                    break
                                response += chunk
                            check(len(response) >= 2, 'DNS_TCP_NO_LENGTH')
                            length = struct.unpack('!H', response[:2])[0]
                            check(length <= 4096, 'DNS_RESPONSE_LIMIT')
                            while len(response) < length + 2:
                                chunk = sock.recv(4096)
                                if not chunk:
                                    break
                                response += chunk
                            response = response[2:]
                        else:
                            sock.sendto(packet, ('192.0.2.2', 15353))
                            response = sock.recvfrom(4096)[0]
                        expected = request.get('expected', '198.51.100.77')
                        value = response[:2] == packet[:2] and response[-4:] == socket.inet_aton(expected)
                        if value and request.get('resolveAs'):
                            resolved[request['resolveAs']] = socket.inet_ntoa(response[-4:])
                except (OSError, RuntimeError):
                    value = False
                finally:
                    if sock is not None and not key:
                        sock.close()
            elif op == 'quit':
                print(json.dumps({'value': True}), flush=True)
                return
            else:
                raise RuntimeError('UNKNOWN_ROLE_OPERATION')
            print(json.dumps({'value': value}), flush=True)
    finally:
        for child in children.values():
            if child.poll() is None:
                child.terminate()
                try:
                    child.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait(timeout=2)
        for sock in sockets.values():
            sock.close()


def driver(root):
    isolated()
    private_json(root / 'isolation.json', {'outerUser': HOST_USER, 'innerUser': namespace('user')})
    data = json.loads((root / 'input.json').read_text())
    check(data['blocked']['scope'] == data['active']['scope'] == 'fixture', 'FIXTURE_SCOPE_REQUIRED')
    roles = {}
    result = {'scope': 'fixture-no-production-cgroup-isolation-proof'}
    try:
        for name in ['client', 'router', 'gateway', 'origin']:
            roles[name] = Worker(name, root)
        check(len({role.net for role in roles.values()}) == 4, 'ROLE_NAMESPACES_NOT_DISTINCT')
        result['isolatedRoles'] = True
        client, router, gateway, origin = [roles[name] for name in ['client', 'router', 'gateway', 'origin']]
        execute(['ip', 'link', 'add', 'br-fixture', 'type', 'bridge'])
        execute(['ip', 'link', 'set', 'br-fixture', 'up'])
        for index, (role_, address, mac) in enumerate([(client, '192.0.2.3', '03'), (router, '192.0.2.1', '01'), (gateway, '192.0.2.2', '02')]):
            left, right = 'bridge' + str(index), 'peer' + str(index)
            execute(['ip', 'link', 'add', left, 'type', 'veth', 'peer', 'name', right])
            execute(['ip', 'link', 'set', left, 'master', 'br-fixture'])
            execute(['ip', 'link', 'set', left, 'up'])
            execute(['ip', 'link', 'set', right, 'netns', str(role_.process.pid)])
            role_.ip('link', 'set', right, 'name', 'lan-test')
            role_.ip('link', 'set', 'lan-test', 'address', '02:00:00:00:00:' + mac)
            role_.ip('addr', 'add', address + '/24', 'dev', 'lan-test')
            role_.ip('link', 'set', 'lan-test', 'up')
        # The isolated topology has a fixed router MAC. Make that test input
        # explicit rather than racing the kernel's DELAY -> REACHABLE timer.
        # Production observations still require a current REACHABLE/PERMANENT
        # neighbour and never refresh or modify the host neighbour cache.
        gateway.ip('neigh', 'replace', '192.0.2.1', 'lladdr', '02:00:00:00:00:01',
                   'nud', 'permanent', 'dev', 'lan-test')
        execute(['ip', 'link', 'add', 'wan-router', 'type', 'veth', 'peer', 'name', 'wan-origin'])
        execute(['ip', 'link', 'set', 'wan-router', 'netns', str(router.process.pid)])
        execute(['ip', 'link', 'set', 'wan-origin', 'netns', str(origin.process.pid)])
        router.ip('addr', 'add', '198.51.100.1/24', 'dev', 'wan-router')
        router.ip('link', 'set', 'wan-router', 'up')
        origin.ip('addr', 'add', '198.51.100.2/24', 'dev', 'wan-origin')
        origin.ip('addr', 'add', '198.51.100.77/32', 'dev', 'wan-origin')
        origin.ip('addr', 'add', '198.51.100.78/32', 'dev', 'wan-origin')
        origin.ip('link', 'set', 'wan-origin', 'up')
        # Enabling IPv4 forwarding can reset per-interface IPv4 defaults, so do
        # it before disabling reverse-path checks and redirects in each role.
        for role_ in [router, gateway]:
            role_.call('exec', args=['python3', '-c', "from pathlib import Path; Path('/proc/sys/net/ipv4/ip_forward').write_text('1')"])
        for role_ in roles.values():
            role_.ip('link', 'set', 'lo', 'up')
            role_.call('exec', args=['python3', '-c', "from pathlib import Path; "
                       "[p.write_text('0') for k in ['rp_filter','send_redirects','accept_redirects'] for p in Path('/proc/sys/net/ipv4/conf').glob('*/'+k)]"])
        client.ip('route', 'add', 'default', 'via', '192.0.2.1')
        client.ip('route', 'add', '192.0.2.2/32', 'via', '192.0.2.1')
        gateway.ip('route', 'add', 'default', 'via', '192.0.2.1')
        origin.ip('route', 'add', '192.0.2.0/24', 'via', '198.51.100.1')
        router.ip('rule', 'add', 'from', '192.0.2.3/32', 'to', '198.51.100.0/24', 'table', '200')
        router.ip('route', 'add', '198.51.100.0/24', 'via', '192.0.2.2', 'dev', 'lan-test', 'table', '200')
        router.nft('''add table inet fixture_observe
add counter inet fixture_observe client_source
add counter inet fixture_observe return_router
add counter inet fixture_observe core_egress
add counter inet fixture_observe dns_tcp_return
add chain inet fixture_observe forward { type filter hook forward priority 0; policy accept; }
add rule inet fixture_observe forward iifname "lan-test" oifname "lan-test" ip saddr 192.0.2.3 counter name client_source
add rule inet fixture_observe forward iifname "lan-test" oifname "lan-test" ether saddr 02:00:00:00:00:02 ip daddr 192.0.2.3 counter name return_router
add rule inet fixture_observe forward iifname "lan-test" oifname "wan-router" ip saddr 192.0.2.2 tcp dport 18080 counter name core_egress
add rule inet fixture_observe forward iifname "lan-test" oifname "lan-test" ip saddr 192.0.2.2 ip daddr 192.0.2.3 tcp sport 15353 counter name dns_tcp_return
''')
        origin.call('origin')
        origin.call('start', label='server', binary=data['server'], args=['run', '-c', '@CONFIG'], config=data['serverConfig'])
        blocked, active = data['blocked'], data['active']
        check(gateway.call('native', action='membership-check'), 'NATIVE_FOREIGN_MATCHING_ROUTE_ADOPTED')
        result['nativeOwnershipCollisionRejected'] = True
        check(gateway.call('native', action='install'), 'NATIVE_INSTALL_FAILED')
        check(gateway.call('native', action='pending-blackhole'), 'NATIVE_IP_PENDING_FAILED')
        gateway.call('stop', label='native')
        check(gateway.call('native', action='recover-checkpoint'), 'NATIVE_IP_RECOVERY_CHECKPOINT_FAILED')
        check(gateway.call('native', action='recover'), 'NATIVE_IP_RECOVERY_FAILED')
        result['nativePendingIpRecovered'] = True
        check(not any(link['ifname'] == 'cocoproxy-tun' for link in json.loads(gateway.ip('-j', 'link', 'show'))), 'TUN_EXISTS_BEFORE_CORE')
        check(gateway.call('native', action='prepare'), 'NATIVE_PREPARE_FAILED')
        check(gateway.call('native', action='pending-nft'), 'NATIVE_NFT_PENDING_FAILED')
        gateway.call('stop', label='native')
        check(gateway.call('native', action='recover-checkpoint'), 'NATIVE_NFT_RECOVERY_CHECKPOINT_FAILED')
        check(gateway.call('native', action='recover'), 'NATIVE_NFT_RECOVERY_FAILED')
        check(gateway.call('native', action='prepare'), 'NATIVE_PREPARED_RECHECK_FAILED')
        result['nativePendingNftRecovered'] = True
        check(gateway.call('native', action='rebind-roundtrip'), 'NATIVE_GENERATION_REBIND_FAILED')
        result['nativeGenerationRebound'] = True
        result['nativeExplicitSettlementVerified'] = True
        result['preCoreRulesInstalled'] = True
        before = origin.call('stats')
        check(not client.call('http') and not client.call('udp') and not client.call('dns'), 'BLOCKED_CLIENT_ESCAPED')
        check(before == origin.call('stats'), 'BLOCKED_ORIGIN_TOUCHED')
        result['blockedOriginsUntouched'] = True
        gateway.call('start', label='core', binary=data['core'], args=['-d', '@ROOT', '-f', '@CONFIG'], config=data['config'])
        for _ in range(40):
            check(gateway.call('alive', label='core'), 'CORE_EXITED_BEFORE_READY')
            links = json.loads(gateway.ip('-j', 'link', 'show'))
            if any(link['ifname'] == 'cocoproxy-tun' for link in links):
                break
            time.sleep(.1)
        else:
            raise RuntimeError('TUN_DID_NOT_APPEAR')
        core_only = data['coreOnly']
        check(gateway.call('native', action='authorize'), 'NATIVE_AUTHORIZE_FAILED')
        check(gateway.call('native', action='probe'), 'NATIVE_READINESS_PROBE_FAILED')
        result['nativeProbeVerified'] = True
        result['nativeReadOnlyPreflightVerified'] = True
        check(gateway.call('native', action='link-probe'), 'NATIVE_LINK_PROBE_FAILED')
        check(gateway.call('native', action='socket-probe'), 'NATIVE_SOCKET_FACTS_FAILED')
        result['actualLinkNeighbourVerified'] = True
        result['actualCoreSocketMarksVerified'] = True
        check(gateway.call('dns', loopback=True), 'CORE_ONLY_LOCAL_DNS_UDP_FAILED')
        check(gateway.call('dns_tcp', loopback=True), 'CORE_ONLY_LOCAL_DNS_TCP_FAILED')
        result['coreOnlyLocalDns'] = True
        before = origin.call('stats')
        check(not client.call('http') and not client.call('udp') and not client.call('dns') and not client.call('dns_tcp'), 'CORE_ONLY_CLIENT_ESCAPED')
        check(before == origin.call('stats'), 'CORE_ONLY_CLIENT_ORIGIN_TOUCHED')
        result['coreOnlyStillBlocked'] = True
        check(gateway.call('native', action='activate'), 'NATIVE_ACTIVATE_FAILED')
        inspected = gateway.call('native', action='inspect')
        check(inspected['scope'] == 'fixture' and inspected['mode'] == 'active' and len(inspected['routesPresent']) == 8, 'NATIVE_ACTIVE_READBACK_FAILED')
        result['nativeReadbackVerified'] = True
        gateway.call('stop', label='native')
        check(gateway.call('native', action='recover'), 'NATIVE_ACTIVE_RECOVERY_FAILED')
        before = origin.call('stats')
        check(not client.call('http') and not client.call('udp') and not client.call('dns'), 'NATIVE_RECOVERY_DID_NOT_BLOCK')
        check(before == origin.call('stats'), 'NATIVE_RECOVERY_ORIGIN_TOUCHED')
        check(gateway.call('native', action='authorize'), 'NATIVE_RECOVERED_AUTHORIZE_FAILED')
        check(gateway.call('native', action='probe'), 'NATIVE_RECOVERED_PROBE_FAILED')
        check(gateway.call('native', action='activate'), 'NATIVE_RECOVERED_ACTIVATE_FAILED')
        result['nativeActiveRestartBlocked'] = True
        time.sleep(.3)
        check(client.call('http', key='existing-http'), 'ACTIVE_HTTP_FAILED')
        result['transparentHttp'] = True
        check(client.call('udp', key='existing-udp'), 'ACTIVE_UDP_FAILED')
        result['transparentUdp'] = True
        dns_before = origin.call('stats')['dns']
        check(client.call('dns'), 'ACTIVE_DNS_UDP_FAILED')
        check(client.call('dns_tcp'), 'ACTIVE_DNS_TCP_FAILED')
        check(origin.call('stats')['dns'] >= dns_before + 2, 'FRESH_CLIENT_DNS_ORIGIN_NOT_CONTACTED')
        result['realDns'] = True
        # DNS-returned addresses drive the actual IP destinations. HTTP Host is
        # deliberately unrelated, and UDP has no Host metadata at all. The node
        # must independently resolve the recovered domain, proving cache linkage.
        domain = os.urandom(12).hex() + '.allowed.invalid'
        check(client.call('dns', domain=domain, resolveAs='allowed'), 'LINKED_DNS_FAILED')
        before = origin.call('stats')
        check(client.call('http', resolved='allowed') and client.call('udp', resolved='allowed'), 'LINKED_HTTP_UDP_FAILED')
        after = origin.call('stats')
        check(after.get('http_77', 0) > before.get('http_77', 0) and after.get('udp_77', 0) > before.get('udp_77', 0), 'LINKED_TARGET_NOT_CONTACTED')
        check(after.get('dns_node', 0) > before.get('dns_node', 0), 'NODE_DID_NOT_RESOLVE_RECOVERED_DOMAIN')
        result['dnsLinkedHttpUdp'] = True
        # Both the real origin service and the fixture node permit .78. Before
        # its DNS mapping exists, raw IP succeeds. Only the recovered domain's
        # explicit REJECT can explain failure after its real DNS answer.
        check(client.call('http', address='198.51.100.78') and client.call('udp', address='198.51.100.78'), 'REJECT_CONTROL_ORIGIN_UNAVAILABLE')
        domain = os.urandom(12).hex() + '.blocked.invalid'
        check(client.call('dns_tcp', domain=domain, expected='198.51.100.78', resolveAs='blocked'), 'REJECT_DOMAIN_DNS_FAILED')
        before = origin.call('stats')
        check(not client.call('http', resolved='blocked') and not client.call('udp', resolved='blocked'), 'DNS_LINKED_REJECT_BYPASSED')
        check(before == origin.call('stats'), 'REJECTED_DOMAIN_ORIGIN_TOUCHED')
        result['dnsLinkedReject'] = True
        counters = json.loads(router.call('exec', args=['nft', '-j', 'list', 'table', 'inet', 'fixture_observe']))['nftables']
        packets = {entry['counter']['name']: entry['counter'].get('packets', 0) for entry in counters if 'counter' in entry}
        check(packets.get('dns_tcp_return', 0) > 0, 'DNS_TCP_ROUTER_RETURN_MISSING')
        for counter, field in [('client_source', 'originalSourceObserved'), ('return_router', 'routerReturnObserved'), ('core_egress', 'markedCoreEgressObserved')]:
            check(packets.get(counter, 0) > 0, 'ROUTER_PATH_COUNTER_MISSING')
            result[field] = True
        neighbours = json.loads(gateway.ip('-j', 'neigh', 'show'))
        check(not any(peer['dst'] == '192.0.2.3' for peer in neighbours), 'GATEWAY_RESOLVED_CLIENT_DIRECTLY')
        # The socket uses the same UID and cgroup as the core but lacks SO_MARK.
        before = origin.call('stats')
        check(not gateway.call('http'), 'UNMARKED_SAME_UID_ESCAPED')
        check(before == origin.call('stats'), 'UNMARKED_ORIGIN_TOUCHED')
        result['unmarkedSameUidRejected'] = True
        # Client bypasses the router L2 hop but keeps the authorized source IP.
        client.ip('route', 'add', '198.51.100.2/32', 'via', '192.0.2.2')
        before = origin.call('stats')
        check(not client.call('http') and not client.call('udp'), 'WRONG_MAC_ESCAPED')
        client.ip('route', 'replace', '192.0.2.2/32', 'dev', 'lan-test')
        check(not client.call('dns') and not client.call('dns_tcp'), 'WRONG_MAC_DNS_ESCAPED')
        client.ip('route', 'replace', '192.0.2.2/32', 'via', '192.0.2.1')
        check(before == origin.call('stats'), 'WRONG_MAC_ORIGIN_TOUCHED')
        client.ip('route', 'del', '198.51.100.2/32')
        result['wrongMacRejected'] = True
        # The retained sessions are still alive immediately before core death;
        # the independent server and origin remain available throughout.
        check(client.call('http', key='existing-http') and client.call('udp', key='existing-udp'), 'EXISTING_SESSION_NOT_LIVE')
        gateway.call('stop', label='core')
        before = origin.call('stats')
        for op in ['http', 'udp']:
            check(not client.call(op, key='existing-' + op) and not client.call(op), 'CORE_DEATH_ESCAPED')
        check(before == origin.call('stats'), 'CORE_DEATH_ORIGIN_TOUCHED')
        result['coreDeathExistingAndNewBlocked'] = True
        # Kernel removes the nonpersistent TUN on core termination. Capture's
        # persistent blackhole and guard must continue to prevent direct routing.
        links = json.loads(gateway.ip('-j', 'link', 'show'))
        check(not any(link['ifname'] == 'cocoproxy-tun' for link in links), 'TUN_SURVIVED_CORE')
        check(not client.call('http') and not client.call('udp'), 'TUN_LOSS_ESCAPED')
        check(before == origin.call('stats'), 'TUN_LOSS_ORIGIN_TOUCHED')

        def restart_core():
            gateway.call('start', label='core', binary=data['core'], args=['-d', '@ROOT', '-f', '@CONFIG'], config=data['config'])
            for _ in range(40):
                check(gateway.call('alive', label='core'), 'RESTARTED_CORE_EXITED')
                if any(link['ifname'] == 'cocoproxy-tun' for link in json.loads(gateway.ip('-j', 'link', 'show'))):
                    break
                time.sleep(.1)
            else:
                raise RuntimeError('RESTARTED_TUN_MISSING')
            for step in active['ip']['activateCapture']:
                gateway.call('exec', args=['ip', *step['args']])
            time.sleep(.15)
            check(client.call('http') and client.call('udp'), 'RESTARTED_CORE_PATH_FAILED')

        restart_core()
        check(gateway.call('alive', label='core'), 'CORE_NOT_LIVE_BEFORE_TUN_DELETE')
        gateway.ip('link', 'delete', 'cocoproxy-tun')
        before = origin.call('stats')
        check(not client.call('http') and not client.call('udp'), 'LIVE_TUN_DELETE_ESCAPED')
        check(before == origin.call('stats'), 'LIVE_TUN_DELETE_ORIGIN_TOUCHED')
        result['tunLossBlocked'] = True
        gateway.call('stop', label='core')
        restart_core()
        # Removing the only configured node must never expose a DIRECT fallback.
        origin.call('stop', label='server')
        before = origin.call('stats')
        check(not client.call('http') and not client.call('udp'), 'NODE_DEATH_DIRECT_FALLBACK')
        check(before == origin.call('stats'), 'NODE_DEATH_ORIGIN_TOUCHED')
        result['nodeDeathNoDirectFallback'] = True
        gateway.call('stop', label='core')
        check(gateway.call('native', action='poisoned-reopen-blocked'), 'NATIVE_POISONED_SESSION_RECOVERY_FAILED')
        result['nativePoisonedSessionRecovered'] = True
        gateway.call('stop', label='native')
        check(gateway.call('native', action='recover'), 'NATIVE_TUN_LOSS_RECOVERY_FAILED')
        result['nativeTunLossRecovered'] = True
        check(gateway.call('native', action='retain'), 'NATIVE_RETAIN_FAILED')
        retained = gateway.call('native', action='inspect')
        check(retained['mode'] == 'blocked' and len(retained['routesPresent']) == 7, 'NATIVE_RETAIN_READBACK_FAILED')
        gateway.nft('add rule inet cocoproxy_guard forward_guard accept\n')
        check(gateway.call('native', action='tamper-check'), 'NATIVE_TAMPER_NOT_REJECTED')
        result['nativeTamperRejected'] = True
        return result
    finally:
        failures = 0
        for role_ in reversed(list(roles.values())):
            try:
                role_.close()
            except (OSError, RuntimeError, subprocess.TimeoutExpired):
                failures += 1
        check(failures == 0, 'ROLE_CLEANUP_FAILED')


if __name__ == '__main__':
    os.umask(0o077)
    try:
        if sys.argv[1] == '--role':
            role(sys.argv[2], Path(sys.argv[3]))
        else:
            print(json.dumps(driver(Path(sys.argv[1]))), flush=True)
    except Exception as error:
        # Only fixed error codes cross the diagnostic boundary, never core logs,
        # generated credentials, namespace identities or host-specific paths.
        code = str(error) if isinstance(error, RuntimeError) else 'FIXTURE_INTERNAL_' + type(error).__name__.upper()
        print(json.dumps({'error': code}), flush=True)
        sys.exit(1)
