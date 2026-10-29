"""Exercise generated capability sets against synthetic service-owned state only."""
import ctypes
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('host_proxy', sys.argv[1])
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)
units = json.load(sys.stdin)
assert os.geteuid() == 0


class Header(ctypes.Structure):
    _fields_ = [('version', ctypes.c_uint32), ('pid', ctypes.c_int)]


class Data(ctypes.Structure):
    _fields_ = [('effective', ctypes.c_uint32), ('permitted', ctypes.c_uint32), ('inheritable', ctypes.c_uint32)]


with tempfile.TemporaryDirectory(prefix='cocoproxy-host-permissions-', dir='/run') as temporary:
    state = Path(temporary) / 'state'
    state.mkdir(mode=0o700)
    receipt = state / 'host-proxy-receipt.json'
    receipt.write_text('{"enabled":false}')
    receipt.chmod(0o600)
    os.chown(receipt, 12345, 12345)
    os.chown(state, 12345, 12345)
    for unit in units:
        capabilities = next(line.split('=', 1)[1].split() for line in unit.splitlines() if line.startswith('CapabilityBoundingSet='))
        mask = sum(1 << {'CAP_NET_ADMIN': 12, 'CAP_DAC_READ_SEARCH': 2}[name] for name in capabilities)
        pid = os.fork()
        if pid == 0:
            try:
                header, data = Header(0x20080522, 0), (Data * 2)()
                data[0].effective = data[0].permitted = mask
                libc = ctypes.CDLL(None, use_errno=True)
                assert libc.capset(ctypes.byref(header), ctypes.byref(data)) == 0
                helper.checked_state(str(state), 12345)
                if 'CAP_DAC_READ_SEARCH' not in capabilities:
                    try:
                        helper.private_read(receipt, 12345)
                        raise AssertionError('old capability set unexpectedly read private state')
                    except PermissionError:
                        pass
                else:
                    assert helper.private_read(receipt, 12345) == {'enabled': False}
                    assert helper.private_read(state / 'missing.json', 12345, optional=True) is None
                    try:
                        helper.private_read(receipt, 12346)
                        raise AssertionError('foreign receipt accepted')
                    except RuntimeError:
                        pass
                    try:
                        receipt.write_text('changed')
                        raise AssertionError('read capability permitted private state writes')
                    except PermissionError:
                        pass
                os._exit(0)
            except BaseException:
                import traceback
                traceback.print_exc()
                os._exit(1)
        _, status = os.waitpid(pid, 0)
        assert status == 0, 'capability isolation check failed'
print(json.dumps({'checked': len(units)}))
