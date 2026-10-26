"""Synthetic lifecycle orchestration checks. Never calls SSH, systemd or installer."""
import contextlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('remote_deploy', Path(__file__).parents[1] / 'scripts/remote-deploy.py')
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)


class RemoteDeploymentTests(unittest.TestCase):
    def scenario(self, fail_apply=False):
        factory = tempfile.TemporaryDirectory
        temporary = factory(prefix='cocoproxy-coordinator-test-')
        root = Path(temporary.name)
        private = root / 'private'
        private.mkdir(mode=0o700)
        state = root / 'state'
        state.mkdir()
        (state / 'workspace.json').write_text('{"revision":7}')
        (state / 'lifecycle.json').write_text('{"schemaVersion":1,"enabled":true,"paused":false}')
        credential = root / 'credential'
        credential.write_text('synthetic unchanged credential')
        hook = root / 'router-hook'
        hook.write_text('#!/bin/sh\nexit 1\n')
        hook.chmod(0o755)
        before = {'schemaVersion': 1, 'runtime': {'nodePath': '/usr/bin/node', 'systemctlPath': '/usr/bin/systemctl',
            'sourceDirectory': '/opt/sample/releases/' + 'a' * 64 + '/source', 'binaryPath': '/old/core', 'binarySha256': 'c' * 64,
            'stateDirectory': str(state), 'settingsPath': '/etc/sample/runtime.json', 'serviceUid': 12345, 'automaticGateway': {'schemaVersion': 1}},
            'management': {'serviceUser': 'synthetic', 'credentialPath': str(credential), 'serverEntry': '/old/server', 'deployment': {'controllerSecret': 'synthetic secret'}}}
        (private / 'deployment.json').write_text(json.dumps(before))
        receipt = root / 'receipt.json'
        receipt.write_text(json.dumps({'status': 'complete', 'release': '/old/release', 'manifestSha256': 'a' * 64}))
        manifest = {'commit': 'e' * 40, 'files': [{'path': 'bin/mihomo', 'sha256': 'c' * 64}]}
        events = []
        active = {'cocoproxy-management.service': True, 'cocoproxy-mihomo.service': True,
            'cocoproxy-gateway-network.service': True, 'cocoproxy-gateway-guard.service': True}
        enabled = {key: 'enabled' if 'management' in key or 'guard' in key else 'static' for key in active}
        router = {'enabled': True}

        def run(args, timeout=120):
            args = [str(item) for item in args]
            events.append(args)
            if args[0] == str(hook):
                if args[1] != 'status':
                    router['enabled'] = args[1] == 'enable'
                return json.dumps(router).encode()
            if '--operation' in args:
                operation = args[args.index('--operation') + 1]
                if operation == 'prepare':
                    return b'{"readiness":"prepared-not-applied","review":{"configurationChanged":false}}'
                if operation == 'inspect':
                    return json.dumps({'installed': True, 'release': 'matches-receipt', 'receipt': {'status': 'complete', 'manifestSha256': 'b' * 64},
                        'files': [{'status': 'matches-receipt'}], 'lock': {'present': False}}).encode()
                if '--apply' in args and fail_apply:
                    raise RuntimeError('INSTALL_SYNTHETIC_FAILURE')
            if args[0] == '/usr/bin/systemctl':
                action = args[1]
                if action == 'show':
                    return (('active' if active[args[2]] else 'inactive') if args[4] == 'ActiveState' else enabled[args[2]]).encode()
                for unit in args[2:]:
                    if action in ['start', 'stop']:
                        active[unit] = action == 'start'
                    elif action in ['enable', 'disable']:
                        enabled[unit] = 'enabled' if action == 'enable' else 'disabled'
            if 'runtime-resume' in args:
                active['cocoproxy-mihomo.service'] = active['cocoproxy-gateway-network.service'] = True
            return b'{"core":{"ready":true}}'

        stack = contextlib.ExitStack()
        stack.enter_context(patch.object(deploy, 'PRIVATE', private))
        stack.enter_context(patch.object(deploy, 'RECEIPT', receipt))
        stack.enter_context(patch.object(deploy, 'trusted', lambda path: Path(path)))
        stack.enter_context(patch.object(deploy, 'directory', lambda path, mode=0o755: Path(path)))
        stack.enter_context(patch.object(deploy, 'regular', lambda path, private=False: Path(path).read_bytes()))
        stack.enter_context(patch.object(deploy, 'stage_payload', lambda *_: (root / 'payload', manifest)))
        stack.enter_context(patch.object(deploy, 'run', run))
        stack.enter_context(patch.object(deploy.os, 'geteuid', lambda: 0))
        stack.enter_context(patch.object(deploy.tempfile, 'TemporaryDirectory', lambda **kwargs: factory(prefix='scratch-', dir=root)))
        args = ['--payload', str(root), '--manifest-sha256', 'b' * 64, '--router-hook', str(hook)]
        return temporary, stack, private, before, events, router, args

    def test_update_preserves_identity_and_restores_only_after_core_ready(self):
        temporary, stack, private, before, events, router, args = self.scenario()
        with temporary, stack:
            deploy.main(args)
            after = json.loads((private / 'deployment.json').read_text())
            self.assertEqual(after['management']['deployment'], before['management']['deployment'])
            self.assertEqual(after['runtime']['automaticGateway'], before['runtime']['automaticGateway'])
            self.assertEqual(after['runtime']['stateDirectory'], before['runtime']['stateDirectory'])
            self.assertIn('b' * 64, after['runtime']['sourceDirectory'])
            find = lambda word: next(index for index, command in enumerate(events) if word in command)
            self.assertLess(find('prepare'), find('runtime-pause'))
            self.assertLess(find('disable'), find('remove'))
            self.assertLess(find('remove'), find('--apply'))
            enable_router = next(index for index, command in enumerate(events) if command[0].endswith('router-hook') and command[1] == 'enable')
            self.assertLess(find('runtime-status'), enable_router)
            self.assertTrue(router['enabled'])
            self.assertEqual(json.loads((private / 'remote-last.json').read_text())['status'], 'complete')

    def test_failed_install_keeps_router_disabled_and_blocks_blind_retry(self):
        temporary, stack, private, before, events, router, args = self.scenario(True)
        with temporary, stack:
            with self.assertRaisesRegex(RuntimeError, 'INSTALL_SYNTHETIC_FAILURE'):
                deploy.main(args)
            self.assertFalse(router['enabled'])
            self.assertFalse(any('runtime-resume' in command for command in events))
            self.assertEqual(json.loads((private / 'remote-last.json').read_text())['status'], 'failed')
            with self.assertRaisesRegex(RuntimeError, 'REMOTE_PREVIOUS_DEPLOYMENT_REQUIRES_REVIEW'):
                deploy.main(args)


if __name__ == '__main__':
    unittest.main()
