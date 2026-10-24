#!/usr/bin/env python3
"""Private, bounded, read-only Linux socket facts. No shells or socket mutation."""
import json
import os
from pathlib import Path
import socket
import struct
import sys
import time

MAXIMUM = 1048576
MAX_SOCKETS = 4096


def check(value):
    if not value:
        raise ValueError()


def read(path, limit=MAXIMUM):
    with open(path, 'rb') as file:
        value = file.read(limit + 1)
    check(len(value) <= limit)
    return value.decode('utf-8', 'strict')


def process(pid):
    root = '/proc/' + str(pid)
    first = read(root + '/stat', 65536)
    fields = first[first.rindex(')') + 2:].split()
    check(first.startswith(str(pid) + ' (') and fields[0] not in ('Z', 'X') and fields[19].isdecimal())
    uids = None
    for line in read(root + '/status', 65536).splitlines():
        if line.startswith('Uid:'):
            check(uids is None)
            uids = [int(value) for value in line.split()[1:]]
    check(uids is not None and len(uids) == 4)
    check(os.readlink(root + '/ns/net') == os.readlink('/proc/self/ns/net'))
    check(os.readlink(root + '/ns/user') == os.readlink('/proc/self/ns/user'))
    entries = list(Path(root + '/fd').iterdir())
    check(len(entries) <= 65536)
    inodes = set()
    for entry in entries:
        value = os.readlink(entry)
        if value.startswith('socket:[') and value.endswith(']'):
            inode = value[8:-1]
            check(inode.isdecimal() and 0 < int(inode) <= 0xffffffff)
            inodes.add(inode)
    check(len(inodes) <= MAX_SOCKETS)
    again = read(root + '/stat', 65536)
    check(again[again.rindex(')') + 2:].split()[19] == fields[19])
    return {'pid': pid, 'startTime': fields[19], 'uids': uids, 'inodes': sorted(inodes, key=int)}


def non_inet(wanted):
    result = {}
    for line in read('/proc/self/net/unix').splitlines()[1:]:
        fields = line.split(maxsplit=7)
        check(len(fields) >= 7)
        if fields[6] in wanted:
            check(fields[6] not in result)
            result[fields[6]] = 'unix'
    for line in read('/proc/self/net/netlink').splitlines()[1:]:
        fields = line.split()
        check(len(fields) == 10)
        if fields[9] in wanted:
            check(fields[9] not in result)
            result[fields[9]] = 'netlink'
    return result


def peers(uids):
    found = {uid: [] for uid in uids}
    entries = list(Path('/proc').iterdir())
    check(len(entries) <= 65536)
    total = 0
    for entry in entries:
        if not entry.name.isdecimal():
            continue
        try:
            status = read(entry / 'status', 65536)
        except (FileNotFoundError, ProcessLookupError):
            continue
        total += len(status)
        check(total <= 16 * MAXIMUM)
        lines = [line.split()[1:] for line in status.splitlines() if line.startswith('Uid:')]
        check(len(lines) == 1 and len(lines[0]) == 4)
        values = {int(value) for value in lines[0]}
        for uid in uids:
            if uid in values:
                found[uid].append(int(entry.name))
    return [{'uid': uid, 'pids': sorted(found[uid])} for uid in sorted(uids)]


def dump(family, protocol, sequence, wanted, deadline):
    result = []
    with socket.socket(socket.AF_NETLINK, socket.SOCK_RAW, 4) as client:
        client.bind((0, 0))
        port = client.getsockname()[0]
        request = struct.pack('=BBBBI', family, protocol, 0, 0, 0xffffffff) + bytes(40) + struct.pack('=II', 0xffffffff, 0xffffffff)
        check(len(request) == 56)
        header = struct.pack('=IHHII', 16 + len(request), 20, 0x301, sequence, port)
        client.sendto(header + request, (0, 0))
        consumed = 0
        while True:
            remaining = deadline - time.monotonic()
            check(remaining > 0)
            client.settimeout(min(1.0, remaining))
            packet, ancillary, flags, sender = client.recvmsg(MAXIMUM)
            check(not ancillary and not flags & socket.MSG_TRUNC and sender[0] == 0 and len(packet) >= 16)
            consumed += len(packet)
            check(consumed <= 16 * MAXIMUM)
            at = 0
            while at < len(packet):
                check(at + 16 <= len(packet))
                length, kind, msg_flags, seq, pid = struct.unpack_from('=IHHII', packet, at)
                check(16 <= length <= len(packet) - at and seq == sequence and pid in (0, port) and not msg_flags & 0x10)
                body = packet[at + 16:at + length]
                at += (length + 3) & ~3
                check(at <= len(packet))
                if kind == 3:
                    check(len(body) >= 4 and struct.unpack_from('=i', body)[0] == 0 and at == len(packet))
                    return result
                check(kind == 20 and len(body) >= 72)
                check(body[0] == family)
                inode = str(struct.unpack_from('=I', body, 68)[0])
                if inode not in wanted:
                    continue
                attrs = {}
                offset = 72
                while offset < len(body):
                    check(offset + 4 <= len(body))
                    size, attribute = struct.unpack_from('=HH', body, offset)
                    check(size >= 4 and offset + size <= len(body))
                    check(attribute not in attrs and not attribute & 0xc000)
                    attrs[attribute] = body[offset + 4:offset + size]
                    offset += (size + 3) & ~3
                    check(offset <= len(body))
                # MARK is present only with CAP_NET_ADMIN. Absence is unknown,
                # never an inferred zero. CGROUP_ID likewise must be observed.
                mark, cgroup = attrs.get(15), attrs.get(21)
                check(mark is None or len(mark) == 4)
                check(cgroup is None or len(cgroup) == 8)
                width = 4 if family == socket.AF_INET else 16
                low, high = struct.unpack_from('=II', body, 44)
                result.append({'inode': inode, 'cookie': str(low | high << 32),
                    'family': 4 if family == socket.AF_INET else 6, 'protocol': 'tcp' if protocol == 6 else 'udp',
                    'uid': struct.unpack_from('=I', body, 64)[0], 'state': body[1],
                    'localAddress': socket.inet_ntop(family, body[8:8 + width]),
                    'remoteAddress': socket.inet_ntop(family, body[24:24 + width]),
                    'localPort': struct.unpack_from('!H', body, 4)[0], 'remotePort': struct.unpack_from('!H', body, 6)[0],
                    'ifindex': struct.unpack_from('=I', body, 40)[0],
                    'mark': None if mark is None else struct.unpack('=I', mark)[0],
                    'cgroupID': None if cgroup is None else str(struct.unpack('=Q', cgroup)[0])})
                check(len(result) <= MAX_SOCKETS)


def main():
    check(len(sys.argv) == 1)
    data = sys.stdin.buffer.read(4097)
    check(len(data) <= 4096)
    request = json.loads(data)
    check(isinstance(request, dict) and set(request) == {'schemaVersion', 'pids'} and request['schemaVersion'] == 1)
    pids = request['pids']
    check(isinstance(pids, list) and 1 <= len(pids) <= 2)
    check(all(type(pid) is int and 1 < pid <= 0x7fffffff for pid in pids) and len(set(pids)) == len(pids))
    before = [process(pid) for pid in pids]
    uid_peers = peers({uid for item in before for uid in item['uids']})
    wanted = {inode for item in before for inode in item['inodes']}
    sockets = []
    deadline = time.monotonic() + 3
    for index, (family, protocol) in enumerate([(socket.AF_INET, 6), (socket.AF_INET, 17), (socket.AF_INET6, 6), (socket.AF_INET6, 17)]):
        sockets.extend(dump(family, protocol, index + 1, wanted, deadline))
    seen = {item['inode'] for item in sockets}
    check(len(seen) == len(sockets))
    other = non_inet(wanted - seen)
    after = [process(pid) for pid in pids]
    check(before == after)
    check(uid_peers == peers({uid for item in after for uid in item['uids']}))
    output = {'schemaVersion': 1, 'bootId': read('/proc/sys/kernel/random/boot_id', 128).strip(),
        'userNS': os.readlink('/proc/self/ns/user'), 'netNS': os.readlink('/proc/self/ns/net'),
        'processes': after, 'uidPeers': uid_peers, 'sockets': sorted(sockets, key=lambda item: int(item['inode'])),
        'nonInet': [{'inode': inode, 'family': family} for inode, family in sorted(other.items(), key=lambda item: int(item[0]))],
        'unknown': sorted(wanted - seen - set(other), key=int)}
    raw = json.dumps(output, separators=(',', ':'))
    check(len(raw.encode('utf-8')) <= MAXIMUM)
    print(raw)


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('{"error":"NETWORK_SOCKET_UNVERIFIED"}')
        sys.exit(1)
