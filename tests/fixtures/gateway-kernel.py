#!/usr/bin/env python3
"""Isolated namespace workers and synthetic services for the native gateway test."""
import json
import os
from pathlib import Path
import resource
import select
import socket
import struct
import subprocess
import sys
import threading
import time

sys.dont_write_bytecode = True
os.environ['PYTHONDONTWRITEBYTECODE'] = '1'

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
                            sock.connect((request.get('dnsAddress', '192.0.2.2'), request.get('dnsPort', 15353)))
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
                            sock.sendto(packet, (request.get('dnsAddress', '192.0.2.2'), request.get('dnsPort', 15353)))
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


if __name__ == '__main__':
    os.umask(0o077)
    try:
        check(sys.argv[1] == '--role', 'ROLE_REQUIRED')
        role(sys.argv[2], Path(sys.argv[3]))
    except Exception as error:
        # Report fixed codes only, without core logs or host-specific paths.
        code = str(error) if isinstance(error, RuntimeError) else 'FIXTURE_INTERNAL_' + type(error).__name__.upper()
        print(json.dumps({'error': code}), flush=True)
        sys.exit(1)
