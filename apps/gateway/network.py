#!/usr/bin/python3
"""Small root oneshot for native Mihomo auto-route prerequisites.

Trust contract: one trusted installer/operator, root-owned immutable installation,
and one flock authority. This is deliberately not the legacy strong process-fence
executor. A crash or command failure leaves an incomplete receipt for operator
inspection; it never infers ownership from partial effects or removes the guard.
"""
import argparse
import fcntl
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tempfile

TABLE = 'coproxy_auto_guard'
IP, NFT = '/usr/sbin/ip', '/usr/sbin/nft'


def require(condition):
    if not condition:
        raise RuntimeError('AUTOMATIC_GATEWAY_NETWORK_REJECTED')


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True)


def checked_path(value, private=False, directory=False):
    require(isinstance(value, str) and len(value) <= 4096 and value.startswith('/'))
    path = Path(value)
    require(str(path) == value and '..' not in path.parts and not any(ord(c) < 32 for c in value))
    require(not any(value == root or value.startswith(root + '/') for root in
                    ('/home', '/root', '/tmp', '/var/tmp', '/run/user')))
    for part in reversed([path, *path.parents]):
        info = part.lstat()
        require(info.st_uid == 0 and not stat.S_ISLNK(info.st_mode) and not info.st_mode & 0o022)
    info = path.stat()
    require(stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode))
    if private:
        require(not info.st_mode & 0o077)
    return path


def checked_executable(value):
    # Distro executable paths may include usr-merge links such as /usr/sbin.
    # Verify each link and its containing directory before following it; the
    # resolved executable and all ordinary ancestors remain root-controlled.
    require(isinstance(value, str) and value.startswith('/'))
    pending, current, links = list(Path(value).parts[1:]), Path('/'), 0
    checked_path('/', directory=True)
    while pending:
        path = current / pending.pop(0)
        info = path.lstat()
        require(info.st_uid == 0 and (stat.S_ISLNK(info.st_mode) or not info.st_mode & 0o022))
        if stat.S_ISLNK(info.st_mode):
            links += 1
            require(links <= 16)
            target = os.readlink(path)
            resolved = os.path.normpath(target if target.startswith('/') else str(current / target))
            pending, current = list(Path(resolved).parts[1:]) + pending, Path('/')
        else:
            if pending:
                require(stat.S_ISDIR(info.st_mode))
            current = path
    checked_path(str(current))
    require(current.stat().st_mode & 0o111)


def run(argv, data=None, absent=False):
    result = subprocess.run(argv, input=data, text=True, capture_output=True, timeout=8,
                            env={'PATH': '/usr/sbin:/usr/bin', 'LC_ALL': 'C'}, check=False)
    if absent and result.returncode == 2 and not result.stdout.strip():
        return []
    require(result.returncode == 0 and len(result.stdout) < 4 * 1024 * 1024)
    return json.loads(result.stdout) if data is None and '-j' in argv else result.stdout


def guard(n):
    lan = str(ipaddress.ip_network(f"{n['gatewayIPv4']}/{n['prefixLength']}", strict=False))
    i, g, r, m, c, p = (n[k] for k in ('ingressInterface', 'gatewayIPv4', 'routerIPv4',
                                      'routerMAC', 'clientIPv4', 'dnsPort'))
    return f'''table inet coproxy_auto_guard {{
 chain ingress {{
  type filter hook prerouting priority -310; policy accept;
  iifname "{i}" meta nfproto ipv4 ip daddr != {lan} ip saddr != {c} drop
  iifname "{i}" meta nfproto ipv4 ip daddr != {lan} ether saddr != {m} drop
 }}
 chain dns {{
  type filter hook input priority -310; policy accept;
  iifname "lo" ip daddr {g} meta l4proto {{ tcp, udp }} th dport {p} accept
  iifname "{i}" ip saddr {r} ether saddr {m} ip daddr {g} meta l4proto {{ tcp, udp }} th dport {p} accept
  ip daddr {g} meta l4proto {{ tcp, udp }} th dport {p} drop
 }}
 chain forwarding {{
  type filter hook forward priority -310; policy accept;
  iifname "{i}" meta nfproto ipv6 drop
  iifname "{i}" ip saddr {c} ip daddr != {lan} oifname != "coproxy-tun" drop
 }}
}}
'''


def load_settings(path):
    value = json.loads(checked_path(path).read_text())
    require(set(value) == {'schemaVersion', 'network', 'stateDirectory', 'ipPath', 'nftPath', 'guardRules'})
    require(type(value['schemaVersion']) is int and value['schemaVersion'] == 1 and
            value['ipPath'] == IP and value['nftPath'] == NFT)
    n = value['network']
    require(isinstance(n, dict) and set(n) == {'schemaVersion', 'ingressInterface', 'gatewayIPv4',
            'routerIPv4', 'routerMAC', 'clientIPv4', 'prefixLength', 'dnsPort', 'egressMark',
            'egressTable', 'egressPriority', 'tunMtu'} and type(n['schemaVersion']) is int and n['schemaVersion'] == 1)
    for key, low, high in [('prefixLength', 1, 29), ('dnsPort', 1024, 65535),
                           ('egressMark', 1, 0xffffffff), ('egressTable', 2000, 19999),
                           ('egressPriority', 1000, 8997), ('tunMtu', 1280, 9000)]:
        require(type(n[key]) is int and low <= n[key] <= high)
    require(n['egressMark'] not in (2023, 2024) and n['egressTable'] != 2022)
    require(isinstance(n['ingressInterface'], str) and
            re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_.-]{0,14}', n['ingressInterface']) and
            n['ingressInterface'] != 'lo' and 'tun' not in n['ingressInterface'].lower())
    require(isinstance(n['routerMAC'], str) and re.fullmatch(r'(?:[0-9a-f]{2}:){5}[0-9a-f]{2}', n['routerMAC']) and
            int(n['routerMAC'][:2], 16) & 1 == 0 and n['routerMAC'] != '00:00:00:00:00:00')
    addresses = [ipaddress.IPv4Address(n[k]) for k in ('gatewayIPv4', 'routerIPv4', 'clientIPv4')]
    lan = ipaddress.ip_network(f"{addresses[0]}/{n['prefixLength']}", strict=False)
    require(len(set(addresses)) == 3 and not lan.overlaps(ipaddress.ip_network('198.18.0.0/30')))
    require(all(a in lan and a not in (lan.network_address, lan.broadcast_address) and
                int(str(a).split('.')[0]) not in (0, 127) and int(str(a).split('.')[0]) < 224 and
                not a.is_link_local for a in addresses))
    require(value['guardRules'] == guard(n))
    checked_path(value['stateDirectory'], private=True, directory=True)
    checked_executable(IP)
    checked_executable(NFT)
    return value


def nft_snapshot():
    tables = run([NFT, '-j', 'list', 'tables'])['nftables']
    if not any(item.get('table', {}).get('family') == 'inet' and
               item.get('table', {}).get('name') == TABLE for item in tables):
        return None
    # Preserve every expression, chain property and handle; only tool metadata varies.
    return [item for item in run([NFT, '-j', '-a', 'list', 'table', 'inet', TABLE])['nftables']
            if 'metainfo' not in item]


def snapshot(n):
    return {'guard': nft_snapshot(),
            'egress': [r for r in run([IP, '-N', '-j', '-4', 'route', 'show', 'table', 'all'])
                       if str(r.get('table')) == str(n['egressTable'])],
            'return': run([IP, '-j', '-4', 'route', 'show', 'table', 'main', 'exact', n['clientIPv4'] + '/32']),
            'rule': [r for r in run([IP, '-j', '-4', 'rule', 'show']) if r.get('priority') == n['egressPriority']],
            'capture': [r for r in run([IP, '-j', '-4', 'rule', 'show'])
                        if r.get('priority') in (n['egressPriority']+1, n['egressPriority']+2)]}


def store(path, value):
    fd, temporary = tempfile.mkstemp(prefix='.receipt-', dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as stream:
            stream.write(canonical(value))
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def route_args(n, operation, egress):
    destination = 'default' if egress else n['clientIPv4'] + '/32'
    return [IP, '-4', 'route', operation, 'table', str(n['egressTable']) if egress else 'main',
            destination, 'via', n['routerIPv4'], 'dev', n['ingressInterface'], 'onlink', 'proto', '186']


def rule_args(n, operation):
    return [IP, '-4', 'rule', operation, 'priority', str(n['egressPriority']),
            'fwmark', hex(n['egressMark']) + '/0xffffffff', 'table', str(n['egressTable'])]


def capture_args(n, operation, local):
    args = [IP, '-4', 'rule', operation, 'priority', str(n['egressPriority']+(1 if local else 2)),
            'from', n['clientIPv4']+'/32', 'iif', n['ingressInterface']]
    if local:
        args += ['to', str(ipaddress.ip_network(f"{n['gatewayIPv4']}/{n['prefixLength']}", strict=False)), 'table', 'main']
    else:
        args += ['table', '2022']
    return args


def require_upstream_stopped():
    require(not any(link.get('ifname') == 'coproxy-tun' for link in run([IP, '-j', 'link', 'show'])))
    require(not any(9000 <= rule.get('priority', -1) <= 9010 for rule in run([IP, '-j', '-4', 'rule', 'show'])))
    require(not any(str(r.get('table')) == '2022' for r in run([IP, '-N', '-j', '-4', 'route', 'show', 'table', 'all'])))
    require(not any(item.get('table', {}).get('name') == 'mihomo' for item in run([NFT, '-j', 'list', 'tables'])['nftables']))


def prepare(value, receipt, existing, boot, digest):
    n = value['network']
    require(Path('/proc/sys/net/ipv4/ip_forward').read_text().strip() == '1')
    if existing:
        require(existing.get('status') in ('complete', 'removed'))
        if existing['status'] == 'complete' and existing.get('bootID') == boot:
            require(existing.get('inputHash') == digest and existing.get('resources') == snapshot(n))
            return
    links = run([IP, '-j', '-4', 'address', 'show', 'dev', n['ingressInterface']])
    require(len(links) == 1 and 'UP' in links[0]['flags'] and any(
        a.get('local') == n['gatewayIPv4'] and a.get('prefixlen') == n['prefixLength']
        for a in links[0].get('addr_info', [])))
    current = snapshot(n)
    require(current == {'guard': None, 'egress': [], 'return': [], 'rule': [], 'capture': []})
    require_upstream_stopped()
    record = {'schemaVersion': 1, 'status': 'incomplete', 'bootID': boot, 'inputHash': digest}
    run([NFT, '-c', '-f', '-'], value['guardRules'])
    store(receipt, record)  # Durable intent before the first mutation; never auto-resume.
    run([NFT, '-f', '-'], value['guardRules'])  # Guard is installed before either route.
    run(route_args(n, 'add', True))
    run(rule_args(n, 'add'))
    run(route_args(n, 'add', False))
    # Local UID exclusion must not bypass forwarded UDP. Keep this source's
    # LAN destinations in main, then hand only its ingress traffic to TUN.
    run(capture_args(n, 'add', True))
    run(capture_args(n, 'add', False))
    resources = snapshot(n)
    require(resources['guard'] and len(resources['egress']) == 1 and len(resources['return']) == 1 and
            len(resources['rule']) == 1 and len(resources['capture']) == 2)
    record.update(status='complete', resources=resources)
    store(receipt, record)


def remove(value, receipt, existing, boot, digest):
    n = value['network']
    require_upstream_stopped()
    require(existing and existing.get('status') == 'complete' and existing.get('bootID') == boot and
            existing.get('inputHash') == digest and existing.get('resources') == snapshot(n))
    existing['status'] = 'incomplete'
    store(receipt, existing)
    run(capture_args(n, 'del', False))
    run(capture_args(n, 'del', True))
    run(rule_args(n, 'del'))
    run(route_args(n, 'del', True))
    run(route_args(n, 'del', False))
    require(snapshot(n) == {'guard': existing['resources']['guard'], 'egress': [], 'return': [], 'rule': [], 'capture': []})
    run([NFT, 'delete', 'table', 'inet', TABLE])  # Guard is always the last removed resource.
    require(snapshot(n) == {'guard': None, 'egress': [], 'return': [], 'rule': [], 'capture': []})
    existing['status'] = 'removed'
    store(receipt, existing)


def main():
    class FixedParser(argparse.ArgumentParser):
        def error(self, message):
            require(False)
    parser = FixedParser(add_help=False)
    parser.add_argument('operation', choices=('prepare', 'remove'))
    parser.add_argument('--settings', required=True)
    args = parser.parse_args()
    require(os.geteuid() == 0)
    checked_path(str(Path(__file__).absolute()))
    checked_executable(sys.executable)
    value = load_settings(args.settings)
    state = Path(value['stateDirectory'])
    lockfd = os.open(state / 'network.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(lockfd, 'r+') as lock:
        info = os.fstat(lock.fileno())
        require(info.st_uid == 0 and stat.S_ISREG(info.st_mode) and not info.st_mode & 0o077 and info.st_nlink == 1)
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        receipt = state / 'network-receipt.json'
        existing = json.loads(checked_path(str(receipt), private=True).read_text()) if receipt.exists() else None
        boot = Path('/proc/sys/kernel/random/boot_id').read_text().strip()
        digest = hashlib.sha256(canonical(value).encode()).hexdigest()
        if args.operation == 'prepare':
            prepare(value, receipt, existing, boot, digest)
        else:
            remove(value, receipt, existing, boot, digest)
    print('{"ok":true}')


if __name__ == '__main__':
    try:
        main()
    except BaseException:
        print('{"ok":false,"code":"AUTOMATIC_GATEWAY_NETWORK_REJECTED"}')
        sys.exit(1)
