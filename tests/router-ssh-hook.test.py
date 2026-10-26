"""Router RPC deadline checks using a synthetic clock and SSH replies only."""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import shlex
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('router_ssh_hook', Path(__file__).parents[1] / 'scripts/router-ssh-hook.py')
adapter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)


class RouterDeadlineTests(unittest.TestCase):
    def scenario(self, complete_after):
        temporary = tempfile.TemporaryDirectory(prefix='cocoproxy-router-hook-test-')
        root = Path(temporary.name)
        config = root / 'router.json'
        config.write_text(json.dumps({'host': '192.0.2.1', 'user': 'root', 'port': 22,
            'identityFile': str(root / 'synthetic-id'), 'knownHostsFile': str(root / 'synthetic-known-hosts')}))
        clock = {'now': 0, 'enabled': False, 'scheduled': False, 'polls': 0}
        calls = []
        def run(args, capture_output, timeout):
            calls.append((args, timeout))
            clock['now'] += min(19, timeout)
            method = shlex.split(args[-1])[3]
            reply = {'ok': True}
            if method == 'job_status':
                if clock['scheduled']:
                    clock['polls'] += 1
                    done = complete_after is not None and clock['polls'] >= complete_after
                    if done:
                        clock['enabled'] = True
                    reply.update(busy=not done, job={'id': 'synthetic-job', 'status': 'succeeded' if done else 'running'})
                else:
                    reply['busy'] = False
            elif method == 'external_status':
                reply['state'] = {'phase': 'active' if clock['enabled'] else 'disabled', 'desiredEnabled': clock['enabled'],
                    'localForwarding': {'running': False, 'guarded': False, 'residual': False}, 'dns': {'running': False}}
            elif method == 'external_get':
                reply['config'] = {'revision': 4}
            elif method == 'external_apply':
                clock['scheduled'] = True
                reply['job'] = {'id': 'synthetic-job'}
            else:
                raise AssertionError('Unexpected RPC')
            return SimpleNamespace(returncode=0, stdout=json.dumps(reply).encode())
        stack = contextlib.ExitStack()
        stack.enter_context(patch('sys.argv', ['router-ssh-hook.py', '--config', str(config), 'enable']))
        stack.enter_context(patch.object(adapter.os, 'geteuid', lambda: config.stat().st_uid, create=True))
        stack.enter_context(patch.object(adapter.stat, 'S_IMODE', lambda _: 0o600))
        stack.enter_context(patch.object(adapter.subprocess, 'run', run))
        stack.enter_context(patch.object(adapter.time, 'monotonic', lambda: clock['now']))
        stack.enter_context(patch.object(adapter.time, 'sleep', lambda seconds: clock.update(now=clock['now'] + seconds)))
        return temporary, stack, clock, calls

    def test_enable_waits_for_job_and_confirms_final_state(self):
        temporary, stack, clock, calls = self.scenario(2)
        with temporary, stack, contextlib.redirect_stdout(io.StringIO()) as output:
            adapter.main()
            self.assertEqual(json.loads(output.getvalue()), {'enabled': True})
            self.assertTrue(clock['enabled'])
            self.assertTrue(all(0 < timeout <= 30 for _, timeout in calls))
            self.assertTrue(all('StrictHostKeyChecking=yes' in args for args, _ in calls))

    def test_polling_deadline_counts_rpc_time_instead_of_only_sleep_iterations(self):
        temporary, stack, clock, calls = self.scenario(None)
        with temporary, stack:
            with self.assertRaisesRegex(RuntimeError, 'REMOTE_ROUTER_JOB_TIMEOUT'):
                adapter.main()
            self.assertLess(clock['polls'], 10)
            self.assertLessEqual(clock['now'], 300)
            self.assertLess(calls[-1][1], 30)


if __name__ == '__main__':
    unittest.main()
