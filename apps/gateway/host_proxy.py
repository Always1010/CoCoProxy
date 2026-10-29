#!/usr/bin/python3
"""Persistent host-only guard, run with the core launcher's existing NET_ADMIN.

The core never owns this table. An exact private receipt fences table changes;
unknown/modified tables are rejected. The root early guard may restore the same
rules after boot using root-owned network settings and a bounded service receipt.
"""
import argparse
import importlib.util
import ipaddress
import json
import os
from pathlib import Path
import stat
import sys
import tempfile

sys.dont_write_bytecode = True

spec = importlib.util.spec_from_file_location('gateway_network', Path(__file__).with_name('network.py'))
network_helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(network_helper)

TABLE = 'cocoproxy_host_guard'
BYPASS4 = ['0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8',
           '169.254.0.0/16', '172.16.0.0/12', '192.168.0.0/16', '224.0.0.0/4', '240.0.0.0/4']
BYPASS6 = ['::1/128', 'fc00::/7', 'fe80::/10', 'ff00::/8']
require, run = network_helper.require, network_helper.run


def rules(n):
    gateway = str(ipaddress.IPv4Address(n['gatewayIPv4']))
    prefix, port, mark = (n[key] for key in ['prefixLength', 'dnsPort', 'egressMark'])
    require(type(prefix) is int and 1 <= prefix <= 29 and type(port) is int and 1024 <= port <= 65535 and
            type(mark) is int and 1 <= mark <= 0xffffffff)
    connected = str(ipaddress.ip_network(f'{gateway}/{prefix}', strict=False))
    return f'''table inet {TABLE} {{
 set private4 {{ type ipv4_addr; flags interval; elements = {{ {', '.join(BYPASS4)} }}; }}
 set private6 {{ type ipv6_addr; flags interval; elements = {{ {', '.join(BYPASS6)} }}; }}
 chain dns {{
  type nat hook output priority -180; policy accept;
  meta mark {mark} return
  ct direction reply return
  meta nfproto ipv4 udp dport 53 dnat ip to {gateway}:{port}
  meta nfproto ipv4 tcp dport 53 dnat ip to {gateway}:{port}
 }}
 chain output {{
  type filter hook output priority 10; policy accept;
  meta mark {mark} accept
  ct direction reply accept
  oifname "lo" accept
  oifname "cocoproxy-tun" accept
  fib daddr type local accept
  ip daddr {connected} accept
  ip daddr @private4 accept
  ip6 daddr @private6 accept
  meta l4proto tcp reject
  meta l4proto udp reject
 }}
}}
'''


def normalize(value):
    if isinstance(value, list):
        return [normalize(item) for item in value]
    if isinstance(value, dict):
        return {key: normalize(item) for key, item in value.items() if key != 'handle'}
    return value


def snapshot():
    tables = run([network_helper.NFT, '-j', 'list', 'tables'])['nftables']
    if not any(item.get('table', {}).get('family') == 'inet' and
               item.get('table', {}).get('name') == TABLE for item in tables):
        return None
    return normalize([item for item in run([network_helper.NFT, '-j', '-a', 'list', 'table', 'inet', TABLE])['nftables']
                      if 'metainfo' not in item])


def private_read(path, uid, optional=False):
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    except FileNotFoundError:
        require(optional)
        return None
    with os.fdopen(fd) as stream:
        info = os.fstat(stream.fileno())
        require(stat.S_ISREG(info.st_mode) and info.st_uid == uid and not info.st_mode & 0o077 and
                info.st_nlink == 1 and info.st_size <= 1024 * 1024)
        return json.load(stream)


def checked_state(value, uid):
    require(isinstance(value, str) and value.startswith('/') and len(value) <= 4096)
    path = Path(value)
    require(str(path) == value and '..' not in path.parts)
    for parent in path.parents:
        info = parent.lstat()
        require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022)
    info = path.lstat()
    require(stat.S_ISDIR(info.st_mode) and info.st_uid == uid and not info.st_mode & 0o077)
    return path


def store_receipt(path, value, uid):
    if os.geteuid() != 0 or uid == 0:
        network_helper.store(path, value)
        return
    # Explicit root retirement retains service ownership without following a
    # service-controlled path for chown. Only the newly opened fd is changed.
    fd, temporary = tempfile.mkstemp(prefix='.host-receipt-', dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as stream:
            os.fchown(stream.fileno(), uid, -1)
            stream.write(network_helper.canonical(value))
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def apply(n, state, enabled, uid, early=False, retire=False):
    require(type(enabled) is bool)
    state = checked_state(str(state), uid)
    receipt_path = state / 'host-proxy-receipt.json'
    receipt = private_read(receipt_path, uid, optional=True)
    desired = rules(n)
    current = snapshot()
    if receipt is not None:
        require(isinstance(receipt, dict) and set(receipt) == {'schemaVersion', 'enabled', 'rules', 'resources'} and
                receipt['schemaVersion'] == 1 and type(receipt['enabled']) is bool and
                isinstance(receipt['rules'], str))
    if current is not None:
        require(receipt is not None and current == receipt['resources'])
    if early or retire:
        require(receipt is None or receipt['rules'] == desired)
        enabled = not retire and receipt is not None and receipt['enabled']
    if enabled and current is not None and receipt['rules'] == desired:
        return
    if not enabled and current is None:
        if not early and receipt is not None:
            store_receipt(receipt_path, {'schemaVersion': 1, 'enabled': False,
                                        'rules': desired, 'resources': None}, uid)
        return
    script = ('delete table inet ' + TABLE + '\n' if current is not None else '') + (desired if enabled else '')
    run([network_helper.NFT, '-c', '-f', '-'], script)
    if not early:
        # Durable intent before mutation. Interrupted changes reject the next
        # launch if the known snapshot no longer agrees; they never remove an
        # unknown table. The installed guard keeps blocking public connections.
        store_receipt(receipt_path, {'schemaVersion': 1, 'enabled': enabled,
                                    'rules': desired, 'resources': current}, uid)
    run([network_helper.NFT, '-f', '-'], script)
    after = snapshot()
    require(bool(after) if enabled else after is None)
    if not early:
        store_receipt(receipt_path, {'schemaVersion': 1, 'enabled': enabled,
                                    'rules': desired, 'resources': after}, uid)
    elif receipt is not None:
        # Ignore kernel handles so a boot recreation must reproduce the exact
        # same owned expressions, without root writing into service-owned state.
        require(after == receipt['resources'])


def main():
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument('--settings')
    parser.add_argument('--enabled', choices=('true', 'false'))
    parser.add_argument('--early-network')
    parser.add_argument('--state')
    parser.add_argument('--uid', type=int)
    parser.add_argument('--retire', action='store_true')
    args = parser.parse_args()
    network_helper.checked_path(str(Path(__file__).absolute()))
    network_helper.checked_path(str(Path(network_helper.__file__).absolute()))
    network_helper.checked_executable(sys.executable)
    network_helper.checked_executable(network_helper.NFT)
    if args.early_network:
        require(os.geteuid() == 0 and not args.settings and args.enabled is None and
                args.uid is not None and 0 < args.uid <= 4294967294 and args.state is not None)
        value = network_helper.load_settings(args.early_network)
        try:
            apply(value['network'], args.state, False, args.uid, early=not args.retire, retire=args.retire)
        except BaseException:
            # A corrupt or unreadable persisted intent must not turn a previously
            # protected host into direct public egress during boot.
            if not args.retire and snapshot() is None:
                run([network_helper.NFT, '-f', '-'], rules(value['network']))
            raise
    else:
        require(args.settings and args.enabled is not None and args.state is None and args.uid is None and not args.retire)
        uid = os.geteuid()
        require(uid != 0)
        settings = private_read(args.settings, uid)
        require(settings['serviceUid'] == uid)
        apply(settings['automaticGateway'], settings['stateDirectory'], args.enabled == 'true', uid)
    print('{"ok":true}')


if __name__ == '__main__':
    try:
        main()
    except BaseException:
        print('{"ok":false,"code":"AUTOMATIC_GATEWAY_HOST_GUARD_REJECTED"}')
        sys.exit(1)
