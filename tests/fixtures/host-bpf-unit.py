"""Synthetic syscall fixtures; never load or attach a kernel program."""
import ctypes
import errno
import importlib.util
import json
from pathlib import Path
import struct
import unittest

source = Path(__file__).resolve().parents[2] / 'packages/network/host-bpf.py'
spec = importlib.util.spec_from_file_location('host_bpf', source)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def fixture(ids=(10, 20), kind=15, changed=None, denied=None, wrong_id=False):
    kernel = module.Kernel()
    calls, closed = [], []
    scan = 0

    def call(command, attribute):
        nonlocal scan
        calls.append(command)
        if command == denied:
            raise PermissionError(errno.EPERM, 'synthetic-private')
        if command == 11:
            assert len(attribute) == 12
            start = struct.unpack_from('=I', attribute)[0]
            if start == 0:
                scan += 1
            values = ids if scan == 1 or changed is None else changed
            next_id = next((value for value in values if value > start), None)
            if next_id is None:
                raise FileNotFoundError(errno.ENOENT, 'end')
            struct.pack_into('=I', attribute, 4, next_id)
            return 0
        if command == 13:
            assert len(attribute) == 12
            return struct.unpack_from('=I', attribute)[0] + 100
        if command == 15:
            assert len(attribute) == 16
            descriptor, size, pointer = struct.unpack_from('=IIQ', attribute)
            assert size == 8
            ctypes.memmove(pointer, struct.pack('=II', kind, descriptor - 100 + int(wrong_id)), 8)
            return 0
        raise AssertionError('forbidden syscall command')

    kernel.call = call
    kernel.close = closed.append
    return kernel, calls, closed


class Boundaries(unittest.TestCase):
    def test_empty_and_device_only_have_bounded_inventory_without_mutating_commands(self):
        for ids in [(), (10, 20)]:
            kernel, calls, closed = fixture(ids)
            result = module.inventory(kernel)
            self.assertEqual(result['devicePrograms'], len(ids))
            self.assertEqual(len(result['inventorySha256']), 64)
            self.assertTrue(set(calls).issubset({11, 13, 15}))
            self.assertEqual(closed, [identifier + 100 for identifier in reversed(ids)])

    def test_permission_errors_never_mean_empty_inventory(self):
        module.check_execution_status('Name:\thelper\nSeccomp:\t0\n')
        for status in ['', 'Seccomp:\t1\n', 'Seccomp:\t2\n',
                       'Seccomp:\t0\nSeccomp:\t0\n', 'Seccomp:\t0\n' + 'x' * 65536]:
            with self.assertRaises(ValueError):
                module.check_execution_status(status)
        for command in [11, 13, 15]:
            kernel, _, closed = fixture(denied=command)
            with self.assertRaises(PermissionError):
                module.inventory(kernel)
            self.assertEqual(closed, [110] if command == 15 else [])

    def test_foreign_types_changed_inventory_and_wrong_id_fail_with_fd_cleanup(self):
        for changes in [{'kind': 6}, {'kind': 3}, {'kind': 28}, {'changed': (10, 20, 30)}, {'wrong_id': True}]:
            kernel, _, closed = fixture(**changes)
            with self.assertRaises(ValueError):
                module.inventory(kernel)
            self.assertTrue(closed)

    def test_cardinality_limit_cannot_become_truncated_success(self):
        kernel, _, closed = fixture(tuple(range(1, module.MAXIMUM + 2)))
        with self.assertRaises(ValueError):
            module.inventory(kernel)
        self.assertEqual(closed, [])

    def test_kernel_adapter_forbids_write_commands_and_real_read_handles_permission(self):
        kernel = module.Kernel()
        with self.assertRaises(ValueError):
            kernel.call(5, ctypes.create_string_buffer(144))  # BPF_PROG_LOAD
        try:
            identifier = kernel.next(0)  # One real read-only syscall, no program load.
            self.assertTrue(identifier is None or identifier > 0)
        except OSError as error:
            self.assertIn(error.errno, (errno.EPERM, errno.EACCES))


result = unittest.TextTestRunner().run(unittest.defaultTestLoader.loadTestsFromTestCase(Boundaries))
if not result.wasSuccessful():
    raise SystemExit(1)
print(json.dumps({'checks': result.testsRun}))
