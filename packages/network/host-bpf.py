#!/usr/bin/env python3
"""Bounded, read-only BPF program inventory. Never load, attach or modify BPF."""
import ctypes
import errno
import hashlib
import json
import os
import platform
import struct
import sys
import time

MAXIMUM = 4096


def check(value):
    if not value:
        raise ValueError()


def check_execution_status(status):
    # Seccomp can replace GET_NEXT_ID with ENOENT without executing it.
    # /proc is independently authenticated by the production caller.
    check(len(status) <= 65536)
    values = [line.split(':', 1)[1].strip() for line in status.splitlines()
              if line.startswith('Seccomp:')]
    check(values == ['0'])


class Kernel:
    def __init__(self):
        check(sys.platform == 'linux' and ctypes.sizeof(ctypes.c_void_p) == 8)
        self.number = {'x86_64': 321, 'aarch64': 280}[platform.machine()]
        self.libc = ctypes.CDLL(None, use_errno=True)
        self.libc.syscall.restype = ctypes.c_long

    def call(self, command, attribute):
        check(command in (11, 13, 15))
        ctypes.set_errno(0)
        result = self.libc.syscall(ctypes.c_long(self.number), ctypes.c_int(command),
                                   ctypes.byref(attribute), ctypes.c_uint(len(attribute)))
        if result < 0:
            raise OSError(ctypes.get_errno(), 'BPF_READ_FAILED')
        return result

    def next(self, start):
        attribute = ctypes.create_string_buffer(12)
        struct.pack_into('=I', attribute, 0, start)
        try:
            check(self.call(11, attribute) == 0)
        except OSError as error:
            if error.errno == errno.ENOENT:
                return None
            raise
        following = struct.unpack_from('=I', attribute, 4)[0]
        check(following > start)
        return following

    def open(self, identifier):
        attribute = ctypes.create_string_buffer(12)
        struct.pack_into('=I', attribute, 0, identifier)
        return self.call(13, attribute)

    def info(self, descriptor):
        # Only the first two stable UAPI fields are requested: type and ID.
        info = ctypes.create_string_buffer(8)
        attribute = ctypes.create_string_buffer(16)
        struct.pack_into('=IIQ', attribute, 0, descriptor, 8, ctypes.addressof(info))
        check(self.call(15, attribute) == 0)
        check(struct.unpack_from('=I', attribute, 4)[0] == 8)
        kind, identifier = struct.unpack_from('=II', info)
        return kind, identifier

    def close(self, descriptor):
        os.close(descriptor)


def inventory(kernel):
    deadline = time.monotonic() + 2
    descriptors, first = [], []

    def identifiers():
        start, values = 0, []
        while True:
            check(time.monotonic() <= deadline)
            following = kernel.next(start)
            if following is None:
                return values
            check(type(following) is int and start < following <= 0xffffffff and len(values) < MAXIMUM)
            values.append(following)
            start = following

    try:
        for identifier in identifiers():
            descriptor = kernel.open(identifier)
            check(type(descriptor) is int and descriptor >= 0)
            descriptors.append(descriptor)
            kind, actual = kernel.info(descriptor)
            # CGROUP_DEVICE controls device-file access, not packet/socket hooks.
            # Even unattached programs of any other type are conservatively refused.
            check(kind == 15 and actual == identifier)
            first.append([identifier, kind])
        check(identifiers() == [item[0] for item in first])
        for descriptor, expected in zip(descriptors, first):
            check(list(reversed(kernel.info(descriptor))) == expected)
        check(time.monotonic() <= deadline)
        digest = hashlib.sha256(json.dumps(first, separators=(',', ':')).encode('ascii')).hexdigest()
        return {'schemaVersion': 1, 'devicePrograms': len(first), 'inventorySha256': digest}
    finally:
        for descriptor in reversed(descriptors):
            kernel.close(descriptor)


def main():
    check(len(sys.argv) == 1 and os.geteuid() == 0)
    with open('/proc/self/status', encoding='ascii') as status:
        check_execution_status(status.read(65537))
    for namespace in ['user', 'net', 'pid', 'cgroup', 'mnt']:
        check(os.readlink('/proc/self/ns/' + namespace) == os.readlink('/proc/1/ns/' + namespace))
    print(json.dumps(inventory(Kernel()), separators=(',', ':')))


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('{"error":"NETWORK_HOST_BPF_UNVERIFIED"}')
        sys.exit(1)
