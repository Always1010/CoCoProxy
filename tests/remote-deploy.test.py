"""Synthetic lifecycle orchestration checks. Never calls SSH, systemd or installer."""
import contextlib
import importlib.util
import io
import hashlib
import json
import os
import signal
import sys
import time
from pathlib import Path
import tempfile
import subprocess
import unittest
from types import SimpleNamespace
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('remote_deploy', Path(__file__).parents[1] / 'scripts/remote-deploy.py')
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)


class RemoteDeploymentTests(unittest.TestCase):
    def test_deployment_deadline_enters_recovery_and_recovery_has_a_separate_bound(self):
        temporary, stack, private, before, events, router, args = self.scenario()
        with temporary, stack:
            original = deploy.run
            def run(command, **kwargs):
                if 'upgrade' in command and '--apply' in command:
                    signal.setitimer(signal.ITIMER_REAL, 0.01)
                    time.sleep(0.1)
                return original(command, **kwargs)
            with patch.object(deploy, 'run', run), deploy.deployment_deadline(1, 'REMOTE_DEPLOYMENT_TIMEOUT'):
                with self.assertRaisesRegex(RuntimeError, '^REMOTE_DEPLOYMENT_TIMEOUT$'):
                    deploy.main_locked(args)
            journal = json.loads((private / 'remote-last.json').read_text())
            self.assertEqual(journal['status'], 'recovered')
            self.assertTrue(router['enabled'])
        temporary, stack, private, before, events, router, args = self.scenario(fail_apply=True)
        with temporary, stack, patch.object(deploy, 'RECOVERY_TIMEOUT', 0.01), patch.object(deploy, 'rollback_update', side_effect=lambda _: time.sleep(0.1)):
            with self.assertRaisesRegex(RuntimeError, '^INSTALL_SYNTHETIC_FAILURE$'):
                deploy.main_locked(args)
            journal = json.loads((private / 'remote-last.json').read_text())
            self.assertEqual(journal['status'], 'failed')
            self.assertEqual(journal['recovery']['code'], 'REMOTE_ROLLBACK_TIMEOUT')

    def test_command_timeout_kills_descendants_before_returning_to_recovery(self):
        with tempfile.TemporaryDirectory() as temporary:
            late = Path(temporary) / 'late'
            child = 'import pathlib,time; time.sleep(0.4); pathlib.Path(' + repr(str(late)) + ').write_text("unsafe write")'
            parent = 'import subprocess,sys,time; subprocess.Popen([sys.executable,"-c",sys.argv[1]]); time.sleep(30)'
            with self.assertRaises(subprocess.TimeoutExpired):
                deploy.run([sys.executable, '-c', parent, child], timeout=0.2)
            time.sleep(0.45)
            self.assertFalse(late.exists())

    def test_lost_maintenance_result_requires_this_operation_and_unchanged_marker_identity(self):
        for mismatch in [None, 'operation', 'marker']:
            with self.subTest(mismatch=mismatch), tempfile.TemporaryDirectory() as temporary:
                state = Path(temporary)
                marker = state / 'lifecycle.json'
                marker.write_text(json.dumps({'schemaVersion': 1, 'enabled': True, 'paused': True}))
                runtime = {'stateDirectory': str(state), 'serviceUid': os.geteuid()}
                def run(args):
                    identity = deploy.lifecycle_marker_identity(marker)
                    result = {'lifecycle': json.loads(marker.read_text()), 'maintenanceRestore': {'schemaVersion': 1,
                        'previous': {'present': True, 'enabled': True, 'paused': False}, 'pausedSha256': identity}}
                    receipt = state / 'maintenance-result.json'
                    receipt.write_text(json.dumps({'schemaVersion': 1, 'id': 'stale' if mismatch == 'operation' else args[args.index('--operation-id') + 1],
                        'action': 'pause', 'result': result, 'markerSha256': identity}))
                    receipt.chmod(0o600)
                    if mismatch == 'marker':
                        replacement = state / 'replacement'
                        replacement.write_bytes(marker.read_bytes())
                        replacement.replace(marker)
                    raise subprocess.TimeoutExpired(['synthetic'], 120)
                with patch.object(deploy, 'run', run):
                    if mismatch is None:
                        self.assertTrue(deploy.run_maintenance(state, 'node', 'synthetic', runtime, 'runtime-maintenance-pause')['lifecycle']['paused'])
                    else:
                        with self.assertRaises(subprocess.TimeoutExpired):
                            deploy.run_maintenance(state, 'node', 'synthetic', runtime, 'runtime-maintenance-pause')

    def test_unit_properties_uses_one_fresh_query_and_rejects_incomplete_or_ambiguous_replies(self):
        command = ['/usr/bin/systemctl', 'show', 'cocoproxy-management.service',
                   '--property=ActiveState,UnitFileState', '--all']
        with patch.object(deploy, 'run', side_effect=[b'UnitFileState=enabled\nActiveState=active\n',
                                                     b'ActiveState=inactive\nUnitFileState=disabled\n']) as run:
            self.assertEqual(deploy.unit_properties(command[0], command[2]), {'ActiveState': 'active', 'UnitFileState': 'enabled'})
            self.assertEqual(deploy.unit_properties(command[0], command[2]), {'ActiveState': 'inactive', 'UnitFileState': 'disabled'})
            self.assertEqual(run.call_args_list, [unittest.mock.call(command), unittest.mock.call(command)])
        for reply in [b'', b'ActiveState=inactive', b'ActiveState=inactive\nUnitFileState=disabled\nUnitFileState=enabled',
                      b'ActiveState=inactive\nUnitFileState=disabled\nUnexpected=value', b'invalid']:
            with self.subTest(reply=reply), patch.object(deploy, 'run', return_value=reply):
                with self.assertRaisesRegex(RuntimeError, '^REMOTE_SERVICE_PROPERTIES_INVALID$'):
                    deploy.unit_properties(command[0], command[2])

    def test_operation_timings_preserve_results_and_failures_without_exposing_arguments(self):
        result = object()
        failure = RuntimeError('synthetic private command detail')
        with patch.object(deploy.time, 'monotonic', side_effect=[10, 11, 12.25, 13, 14.5, 15]):
            clock = deploy.DeploymentClock()
            self.assertIs(clock.measure('apply', lambda value: value, result), result)
            with self.assertRaises(RuntimeError) as raised:
                clock.measure('inspect', lambda: (_ for _ in ()).throw(failure))
            self.assertIs(raised.exception, failure)
            report = clock.report()
        self.assertEqual(report['elapsedMs'], 5000)
        self.assertEqual(report['operations'], [
            {'phase': 'apply', 'durationMs': 1250, 'status': 'complete'},
            {'phase': 'inspect', 'durationMs': 1500, 'status': 'failed'}])
        self.assertNotIn('synthetic private', json.dumps(report))

    def test_upgrade_and_rollback_wait_for_slow_core_before_starting_manager(self):
        for fail_apply in [False, True]:
            with self.subTest(rollback=fail_apply):
                temporary, stack, private, before, events, router, args = self.scenario(fail_apply=fail_apply)
                with temporary, stack:
                    original_run = deploy.run
                    observed = {'ready': False, 'polls': 0}
                    def run(command, **kwargs):
                        command = [str(item) for item in command]
                        if command == ['/usr/bin/systemctl', 'start', 'cocoproxy-management.service']:
                            self.assertTrue(observed['ready'], 'manager could interrupt the unfinished core launcher')
                        result = original_run(command, **kwargs)
                        if command == ['/usr/bin/systemctl', 'start', 'cocoproxy-mihomo.service']:
                            observed.update(ready=False, polls=0)
                        if 'runtime-status' in command:
                            observed['polls'] += 1
                            observed['ready'] = observed['polls'] >= 2
                            return json.dumps({'core': {'ready': observed['ready']}}).encode()
                        return result
                    with patch.object(deploy, 'run', run), patch.object(deploy.time, 'sleep'):
                        if fail_apply:
                            with self.assertRaisesRegex(RuntimeError, '^INSTALL_SYNTHETIC_FAILURE$'):
                                deploy.main_locked(args)
                        else:
                            deploy.main_locked(args)
                    self.assertTrue(router['enabled'])
                    self.assertGreaterEqual(observed['polls'], 2)

    def test_unready_new_core_keeps_manager_stopped_until_previous_core_recovers(self):
        temporary, stack, private, before, events, router, args = self.scenario()
        with temporary, stack:
            original_run = deploy.run
            def run(command, **kwargs):
                result = original_run(command, **kwargs)
                if 'runtime-status' in command:
                    return json.dumps({'core': {'ready': not any('b' * 64 in str(item) for item in command)}}).encode()
                return result
            with patch.object(deploy, 'run', run), patch.object(deploy.time, 'sleep'):
                with self.assertRaisesRegex(RuntimeError, '^REMOTE_CORE_NOT_READY$'):
                    deploy.main_locked(args)
            manager_starts = [index for index, event in enumerate(events)
                              if event == ['/usr/bin/systemctl', 'start', 'cocoproxy-management.service']]
            self.assertEqual(len(manager_starts), 1)
            old_ready = next(index for index, event in enumerate(events) if 'runtime-status' in event
                             and any('a' * 64 in str(item) for item in event))
            self.assertLess(old_ready, manager_starts[0])
            self.assertEqual(json.loads((private / 'remote-last.json').read_text())['status'], 'recovered')
            self.assertTrue(router['enabled'])

    def test_worker_activation_closes_before_maintenance_and_restores_socket_intent(self):
        for preserve_runtime in [False, True]:
            with self.subTest(preserve_runtime=preserve_runtime):
                temporary, stack, private, before, events, router, args = self.scenario(
                    bandwidth_worker=True, component='backend' if preserve_runtime else None, preserve_runtime=preserve_runtime)
                with temporary, stack, contextlib.redirect_stdout(io.StringIO()):
                    deploy.main_locked(args)
                stop_socket = events.index(['/usr/bin/systemctl', 'stop', 'cocoproxy-bandwidth.socket'])
                stop_worker = events.index(['/usr/bin/systemctl', 'stop', 'cocoproxy-bandwidth.service'])
                stop_manager = events.index(['/usr/bin/systemctl', 'stop', 'cocoproxy-management.service'])
                self.assertLess(stop_socket, stop_worker)
                self.assertLess(stop_worker, stop_manager)
                self.assertIn(['/usr/bin/systemctl', 'start', 'cocoproxy-bandwidth.socket'], events)
                self.assertNotIn(['/usr/bin/systemctl', 'start', 'cocoproxy-bandwidth.service'], events)
                self.assertIn(['/usr/bin/systemctl', 'enable', 'cocoproxy-updater.service'], events)
                for action in ['stop', 'disable', 'restart', 'start']:
                    self.assertNotIn(['/usr/bin/systemctl', action, 'cocoproxy-updater.service'], events)

    def test_expected_manifest_option_rejects_noncanonical_hash_before_lock_or_staging(self):
        for value in ['a' * 63, 'A' * 64, '../' + 'a' * 64]:
            with patch.object(deploy.os, 'geteuid', return_value=0), patch.object(deploy, 'directory') as directory, patch.object(deploy, 'stage_payload') as stage:
                with self.assertRaisesRegex(RuntimeError, '^REMOTE_EXPECTED_MANIFEST_SHA_INVALID$'):
                    deploy.main(['--payload', '/synthetic/payload', '--manifest-sha256', 'b' * 64,
                                 '--expected-manifest-sha256', value])
                directory.assert_not_called()
                stage.assert_not_called()

    def test_locked_expected_installation_check_precedes_staging_and_rejects_changed_or_pending_receipt(self):
        for manifest, status in [('c' * 64, 'complete'), ('a' * 64, 'pending'), ('a' * 64, 'complete')]:
            temporary, stack, private, before, events, router, args = self.scenario()
            with temporary, stack:
                args.expected_manifest_sha256 = 'a' * 64
                args.preview = True
                receipt = json.loads(deploy.RECEIPT.read_bytes())
                receipt.update(manifestSha256=manifest, status=status)
                deploy.RECEIPT.write_text(json.dumps(receipt))
                with patch.object(deploy, 'stage_payload', wraps=deploy.stage_payload) as stage:
                    if manifest == 'a' * 64 and status == 'complete':
                        deploy.main_locked(args)
                        stage.assert_called_once()
                    else:
                        with self.assertRaisesRegex(RuntimeError, '^REMOTE_EXPECTED_INSTALLATION_CHANGED$'):
                            deploy.main_locked(args)
                        stage.assert_not_called()
                    self.assertFalse(any(command[0] == '/usr/bin/systemctl' and command[1] in
                                         ['start', 'stop', 'enable', 'disable'] for command in events))

    def test_updater_activation_enables_and_starts_only_inactive_coordinator(self):
        for state in ['active', 'activating', 'inactive']:
            events = []
            def run(args):
                events.append(args)
                return state.encode() if args[1] == 'show' else b''
            with patch.object(deploy, 'run', run):
                deploy.ensure_updater_started('/usr/bin/systemctl')
            self.assertEqual(events[0], ['/usr/bin/systemctl', 'enable', 'cocoproxy-updater.service'])
            self.assertEqual(any(args[1] == 'start' for args in events), state == 'inactive')
            self.assertFalse(any(args[1] in ['stop', 'restart', 'disable'] for args in events))

    def test_candidate_evidence_is_private_scratch_and_is_removed_from_installer_results(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / 'verified.json'
            evidence = {'schemaVersion': 1, 'binding': 'a' * 64, 'verified': ['b' * 64]}
            args = ['node', 'synthetic-installer', '--candidate-evidence', path]
            with patch.object(deploy, 'run', return_value=json.dumps({'prepared': True, 'candidateEvidence': evidence}).encode()):
                self.assertEqual(deploy.installer_result(args), {'prepared': True})
            self.assertEqual(json.loads(path.read_text()), evidence)
            with patch.object(deploy, 'run', return_value=json.dumps({'candidateEvidence': {**evidence, 'private': 'synthetic'}}).encode()):
                with self.assertRaisesRegex(RuntimeError, 'REMOTE_CANDIDATE_EVIDENCE_INVALID'):
                    deploy.installer_result(args)
            self.assertEqual(json.loads(path.read_text()), evidence)

    def test_command_failures_disclose_only_fixed_codes_and_known_service_actions(self):
        cases = [
            (['/usr/bin/systemctl', 'start', 'cocoproxy-gateway-guard.service'], b'', b'private systemd log',
             'REMOTE_SERVICE_COMMAND_FAILED', {'action': 'start', 'service': 'cocoproxy-gateway-guard.service'}),
            (['python3', '/private/helper.py'], b'{"ok":false,"code":"AUTOMATIC_GATEWAY_HOST_GUARD_REJECTED"}', b'private detail',
             'AUTOMATIC_GATEWAY_HOST_GUARD_REJECTED', {}),
            (['python3', '/private/helper.py'], b'{"ok":false,"code":"private detail"}', b'private detail', 'REMOTE_STEP_FAILED', {}),
            (['node', '/private/installer.ts'], b'', b'(node:123) ExperimentalWarning: synthetic warning\nINSTALL_SERVICES_MUST_BE_STOPPED\n',
             'INSTALL_SERVICES_MUST_BE_STOPPED', {}),
        ]
        for args, stdout, stderr, code, fields in cases:
            with self.subTest(code=code), patch.object(deploy.subprocess, 'Popen', return_value=SimpleNamespace(
                    returncode=1, communicate=lambda **_: (stdout, stderr))), contextlib.redirect_stderr(io.StringIO()) as output:
                with self.assertRaisesRegex(RuntimeError, '^' + code + '$'):
                    deploy.run(args)
                self.assertEqual(json.loads(output.getvalue()), {'phase': 'deployment-command', 'code': code, 'exitCode': 1, **fields})

    def scenario(self, fail_apply=False, lifecycle=..., core_active=True, router_enabled=True, edit_during_stop=False, network_receipt='complete', change_during_install=False, adapter_report=..., preparation_report=None, frontend=False, frontend_base='a', component=None, component_base='a', preserve_runtime=False, health_failure=False, runtime_changed=False, stage_failure=False, failure_at=None, rollback_failure=False, network_active=None, reordered_properties=False, bandwidth_worker=False):
        factory = tempfile.TemporaryDirectory
        temporary = factory(prefix='cocoproxy-coordinator-test-')
        root = Path(temporary.name)
        private = root / 'private'
        private.mkdir(mode=0o700)
        state = root / 'state'
        state.mkdir()
        (state / 'workspace.json').write_text('{"revision":7}')
        if lifecycle is ...:
            lifecycle = {'schemaVersion': 1, 'enabled': True, 'paused': False}
        if lifecycle is not None:
            (state / 'lifecycle.json').write_text(json.dumps(lifecycle))
        network = root / 'network-receipt.json'
        if network_receipt is not None:
            network.write_text(json.dumps({'schemaVersion': 1, 'status': network_receipt}))
        credential = root / 'credential'
        credential.write_text('synthetic unchanged credential')
        hook = root / 'router-hook'
        hook.write_text('#!/bin/sh\nexit 1\n')
        hook.chmod(0o755)
        before = {'schemaVersion': 1, 'runtime': {'nodePath': '/usr/bin/node', 'systemctlPath': '/usr/bin/systemctl',
            'sourceDirectory': '/opt/sample/releases/' + 'a' * 64 + '/source', 'binaryPath': '/old/core', 'binarySha256': 'c' * 64,
            'stateDirectory': str(state), 'settingsPath': '/etc/sample/runtime.json', 'serviceUid': os.geteuid(), 'automaticGateway': {'schemaVersion': 1}},
            'management': {'serviceUser': 'synthetic', 'credentialPath': str(credential), 'settingsPath': '/etc/sample/management.json',
                'serverEntry': '/old/server', 'deployment': {'controllerSecret': 'synthetic secret'}}}
        (private / 'deployment.json').write_text(json.dumps(before))
        receipt = root / 'receipt.json'
        receipt.write_text(json.dumps({'status': 'complete', 'release': '/old/release', 'manifestSha256': 'a' * 64, 'files': ([{'path': '/etc/systemd/system/cocoproxy-bandwidth.' + suffix} for suffix in ['socket', 'service']] if bandwidth_worker else [])}))
        manifest = {'commit': 'e' * 40, 'files': [{'path': 'bin/mihomo', 'sha256': 'c' * 64}]}
        if frontend:
            manifest['frontendUpdate'] = {'schemaVersion': 2, 'baseManifestSha256': frontend_base * 64, 'backendInputSha256': 'f' * 64}
        if component:
            manifest['componentUpdate'] = {'schemaVersion': 1, 'components': component, 'baseManifestSha256': component_base * 64, 'reusedInputSha256': 'f' * 64}
        events = []
        active = {'cocoproxy-management.service': True, 'cocoproxy-mihomo.service': core_active,
            'cocoproxy-gateway-network.service': core_active if network_active is None else network_active, 'cocoproxy-gateway-guard.service': True}
        active['cocoproxy-updater.service'] = True
        enabled = {key: 'enabled' if 'management' in key or 'guard' in key else 'static' for key in active}
        if bandwidth_worker:
            active.update({'cocoproxy-bandwidth.socket': True, 'cocoproxy-bandwidth.service': False})
            enabled.update({'cocoproxy-bandwidth.socket': 'enabled', 'cocoproxy-bandwidth.service': 'static'})
        router = {'enabled': router_enabled}

        injected = set()
        def inject(phase):
            if failure_at == phase and phase not in injected:
                injected.add(phase)
                raise RuntimeError('REMOTE_SYNTHETIC_PHASE_FAILURE')
        def run(args, timeout=120, input=None):
            args = [str(item) for item in args]
            events.append(args)
            def maintenance_reply(action, result):
                if '--operation-id' in args:
                    path = state / 'maintenance-result.json'
                    path.write_text(json.dumps({'schemaVersion': 1, 'id': args[args.index('--operation-id') + 1], 'action': action,
                        'result': result, 'markerSha256': 'd' * 64 if (state / 'lifecycle.json').exists() else None}))
                    path.chmod(0o600)
                inject(action + '-result')
                return json.dumps(result).encode()
            if any(item.replace('\\', '/').endswith('/apps/deployment/rollback.ts') for item in args):
                if rollback_failure:
                    raise RuntimeError('INSTALL_ROLLBACK_SYNTHETIC_FAILURE')
                context = json.loads(input)
                self.assertEqual(context['previousInput'], before)
                return json.dumps({'restored': True, 'manifestSha256': context['previousReceipt']['manifestSha256'], 'usageCompatibility': 'supported'}).encode()
            if any(item.replace('\\', '/').endswith('/apps/deployment/preservation.ts') for item in args):
                hashed = lambda path: hashlib.sha256(path.read_bytes()).hexdigest() if path.exists() else None
                return json.dumps({'schemaVersion': 1, 'observedAt': 1000, 'identity': {'credential': hashed(credential), 'epoch': 'synthetic-epoch'},
                    'files': {'workspace': hashed(state / 'workspace.json'), 'lifecycle': hashed(state / 'lifecycle.json'), 'automaticSelections': None},
                    'directories': {'state': sorted(item.name for item in state.iterdir())},
                    'contentChecks': [{'id': 'workspace', 'status': 'pass'}],
                    'stable': {'workspace': hashed(state / 'workspace.json'), 'siteProbes': None, 'draft': None, 'subscriptions': 'synthetic-empty'},
                    'trusted': {'binding': 'absent', 'devices': []},
                    'runtime': {'coherent': True, 'active': 'a' * 64 if core_active else None, 'selection': 'a' * 64 if core_active else None,
                        'automaticBindingsReadable': True}, 'ready': True}).encode()
            if args[0] == str(hook):
                if args[1] == 'check-adapter':
                    if adapter_report is None:
                        raise RuntimeError('SYNTHETIC_MISSING_ADAPTER_ACTION')
                    if adapter_report == 'timeout':
                        raise subprocess.TimeoutExpired(args, 120)
                    if adapter_report == 'invalid-json':
                        return b'not JSON'
                    return json.dumps({'schemaVersion': 1, 'compatible': True} if adapter_report is ... else adapter_report).encode()
                if args[1] != 'status':
                    router['enabled'] = args[1] == 'enable'
                    inject('router-' + args[1])
                return json.dumps(router).encode()
            if 'runtime-maintenance-pause' in args:
                marker = state / 'lifecycle.json'
                present = marker.exists()
                previous = json.loads(marker.read_text()) if present else {'schemaVersion': 1, 'enabled': False, 'paused': False}
                paused = {**previous, 'paused': True}
                marker.write_text(json.dumps(paused))
                return maintenance_reply('pause', {'lifecycle': paused, 'maintenanceRestore': {'schemaVersion': 1,
                    'previous': {'present': present, 'enabled': previous['enabled'], 'paused': previous['paused']},
                    'pausedSha256': 'd' * 64}})
            if 'runtime-maintenance-restore' in args:
                previous = json.loads(Path(args[args.index('--input') + 1]).read_text())['previous']
                restored = {'schemaVersion': 1, 'enabled': previous['enabled'], 'paused': previous['paused']}
                if previous['present']:
                    (state / 'lifecycle.json').write_text(json.dumps(restored))
                else:
                    (state / 'lifecycle.json').unlink()
                return maintenance_reply('restore', {'lifecycle': restored})
            if '--operation' in args:
                operation = args[args.index('--operation') + 1]
                if operation == 'prepare':
                    return json.dumps(preparation_report or {'readiness': 'prepared-not-applied', 'review': {'configurationChanged': False},
                        'runtimePreservation': {'eligible': preserve_runtime}}).encode()
                if operation == 'inspect':
                    return json.dumps({'installed': True, 'release': 'matches-receipt', 'receipt': {'status': 'complete', 'manifestSha256': 'b' * 64},
                        'files': [{'status': 'matches-receipt'}], 'lock': {'present': False}}).encode()
                if operation == 'stage':
                    if stage_failure:
                        raise RuntimeError('INSTALL_SYNTHETIC_STAGE_FAILURE')
                    return b'{"staged":true,"liveSettingsChanged":false}'
                if '--apply' in args and fail_apply:
                    raise RuntimeError('INSTALL_SYNTHETIC_FAILURE')
                if '--apply' in args and change_during_install:
                    (state / 'workspace.json').write_text('{"revision":99}')
            if args[0] == '/usr/bin/systemctl':
                action = args[1]
                if action == 'show':
                    if args[3].startswith('--property='):
                        pid = '99' if runtime_changed and any('upgrade' in event and '--apply' in event for event in events) else '42'
                        properties = {'ActiveState': 'active' if active[args[2]] else 'inactive', 'MainPID': pid,
                            'ExecMainStartTimestampMonotonic': '1234', 'UnitFileState': enabled[args[2]]}
                        rows = [name + '=' + properties[name] for name in args[3].split('=', 1)[1].split(',')]
                        if reordered_properties and any('upgrade' in event and '--apply' in event for event in events):
                            rows.reverse()
                        return '\n'.join(rows).encode()
                    return (('active' if active[args[2]] else 'inactive') if args[4] == 'ActiveState' else enabled[args[2]]).encode()
                for unit in args[2:]:
                    if action in ['start', 'stop']:
                        if edit_during_stop and action == 'stop' and unit == 'cocoproxy-management.service':
                            (state / 'workspace.json').write_text('{"revision":8}')
                        if action == 'start' and unit == 'cocoproxy-mihomo.service':
                            marker = state / 'lifecycle.json'
                            if marker.exists() and json.loads(marker.read_text())['paused']:
                                raise RuntimeError('RUNTIME_LIFECYCLE_PAUSED')
                            active['cocoproxy-gateway-network.service'] = True
                        active[unit] = action == 'start'
                        if unit == 'cocoproxy-management.service':
                            inject('management-' + action)
                        if unit == 'cocoproxy-mihomo.service':
                            inject('core-' + action)
                    elif action in ['enable', 'disable']:
                        enabled[unit] = 'enabled' if action == 'enable' else 'disabled'
            return b'{"core":{"ready":true}}'

        stack = contextlib.ExitStack()
        stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
        stack.enter_context(patch.object(deploy, 'PRIVATE', private))
        stack.enter_context(patch.object(deploy, 'RECEIPT', receipt))
        stack.enter_context(patch.object(deploy, 'NETWORK_RECEIPT', network))
        stack.enter_context(patch.object(deploy, 'trusted', lambda path: Path(path)))
        stack.enter_context(patch.object(deploy, 'directory', lambda path, mode=0o755: Path(path)))
        stack.enter_context(patch.object(deploy, 'regular', lambda path, private=False, maximum=None: Path(path).read_bytes()))
        stack.enter_context(patch.object(deploy, 'put', lambda path, data, mode=0o600: Path(path).write_bytes(data)))
        stack.enter_context(patch.object(deploy, 'stage_payload', lambda *_: (root / 'payload', manifest)))
        stack.enter_context(patch.object(deploy, 'run', run))
        stack.enter_context(patch.object(deploy, 'lifecycle_marker_identity', lambda _: 'd' * 64))
        def health(_):
            events.append(['management-health', _['serverEntry']])
            if health_failure and _['serverEntry'] != before['management']['serverEntry']:
                raise RuntimeError('REMOTE_MANAGEMENT_NOT_READY')
        stack.enter_context(patch.object(deploy, 'management_ready', health))
        stack.enter_context(patch.object(deploy.os, 'chown', lambda *_: None, create=True))
        stack.enter_context(patch.object(deploy.tempfile, 'TemporaryDirectory', lambda **kwargs: factory(prefix='scratch-', dir=root)))
        args = SimpleNamespace(payload=str(root), manifest_sha256='b' * 64, router_hook=str(hook), router_config=None,
            input=None, environment=None, admin_input=None, web_unit=None, preview=False)
        return temporary, stack, private, before, events, router, args

    def test_compatible_default_and_management_updates_keep_the_pinned_runtime(self):
        for component in [None, 'backend', 'management']:
            with self.subTest(component=component):
                temporary, stack, private, before, events, router, args = self.scenario(component=component, preserve_runtime=True, reordered_properties=True)
                with temporary, stack:
                    deploy.main_locked(args)
                    installed = json.loads((private / 'deployment.json').read_text())
                    self.assertEqual(installed['runtime'], before['runtime'])
                    self.assertTrue(any('--preserve-runtime' in event and '--apply' in event for event in events))
                    self.assertFalse(any('runtime-maintenance-pause' in event or event[0].endswith('router-hook') for event in events))
                    mutations = [event for event in events if event[0] == '/usr/bin/systemctl' and event[1] in ['start', 'stop', 'enable', 'disable']]
                    self.assertTrue(all(event[2:] == ['cocoproxy-management.service'] or event[1:] == ['enable', 'cocoproxy-updater.service'] for event in mutations))
                    self.assertTrue(router['enabled'])

    def test_preserving_runtime_rejects_state_mutation_core_restart_and_unready_manager(self):
        for options, error in [({'change_during_install': True}, 'REMOTE_PRESERVATION_INSTALL_WINDOW_CHANGED'),
                               ({'runtime_changed': True}, 'REMOTE_FRONTEND_RUNTIME_CHANGED'),
                               ({'health_failure': True}, 'REMOTE_MANAGEMENT_NOT_READY')]:
            with self.subTest(error=error):
                temporary, stack, private, before, events, router, args = self.scenario(preserve_runtime=True, **options)
                with temporary, stack:
                    with self.assertRaisesRegex(RuntimeError, error):
                        deploy.main_locked(args)
                    self.assertTrue(router['enabled'])
                    journal = json.loads((private / 'remote-last.json').read_text())
                    self.assertEqual(journal['status'], 'recovered' if options.get('health_failure') else 'failed')

    def test_preinstallation_failure_never_pauses_runtime_or_mutates_services_and_router(self):
        for preserve in [False, True]:
            with self.subTest(preserve_runtime=preserve):
                temporary, stack, private, before, events, router, args = self.scenario(preserve_runtime=preserve, stage_failure=True)
                with temporary, stack:
                    with self.assertRaisesRegex(RuntimeError, 'INSTALL_SYNTHETIC_STAGE_FAILURE'):
                        deploy.main_locked(args)
                    self.assertEqual(json.loads((private / 'deployment.json').read_text()), before)
                    self.assertTrue(router['enabled'])
                    self.assertFalse(any('runtime-maintenance-pause' in event or event[0] == '/usr/bin/systemctl' and event[1] in ['start', 'stop', 'disable', 'enable'] for event in events))

    def test_frontend_update_pins_runtime_and_never_enters_router_or_runtime_maintenance(self):
        temporary, stack, private, before, events, router, args = self.scenario(frontend=True)
        with temporary, stack:
            deploy.main_locked(args)
            installed = json.loads((private / 'deployment.json').read_text())
            self.assertEqual(installed['runtime'], before['runtime'])
            self.assertNotEqual(installed['management']['serverEntry'], before['management']['serverEntry'])
            self.assertTrue(router['enabled'])
            self.assertFalse(any('runtime-maintenance-pause' in event or 'runtime-maintenance-restore' in event for event in events))
            self.assertFalse(any('router-hook' in event[0] for event in events))
            mutations = [event for event in events if event[0] == '/usr/bin/systemctl' and event[1] in ['start', 'stop', 'enable', 'disable']]
            self.assertTrue(mutations)
            self.assertTrue(all(event[2:] == ['cocoproxy-management.service'] or event[1:] == ['enable', 'cocoproxy-updater.service'] for event in mutations))
            self.assertEqual(json.loads((private / 'remote-last.json').read_text())['status'], 'complete')

    def test_frontend_preview_does_not_stop_services_or_write_install_input(self):
        temporary, stack, private, before, events, router, args = self.scenario(frontend=True)
        with temporary, stack:
            args.preview = True
            deploy.main_locked(args)
            self.assertEqual(json.loads((private / 'deployment.json').read_text()), before)
            self.assertFalse(any(event[0] == '/usr/bin/systemctl' and event[1] in ['start', 'stop', 'enable', 'disable'] for event in events))

    def test_frontend_stale_base_is_rejected_before_service_mutation(self):
        temporary, stack, private, before, events, router, args = self.scenario(frontend=True, frontend_base='c')
        with temporary, stack:
            with self.assertRaisesRegex(RuntimeError, 'REMOTE_FRONTEND_BASE_CHANGED'):
                deploy.main_locked(args)
            self.assertEqual(json.loads((private / 'deployment.json').read_text()), before)
            self.assertFalse(any(event[0] == '/usr/bin/systemctl' and event[1] in ['start', 'stop', 'enable', 'disable'] for event in events))

    def test_component_updates_use_full_maintenance_and_reject_a_stale_base(self):
        for component, base in [('backend', 'a'), ('backend', 'c'), ('management', 'a'), ('management', 'c'), ('core', 'a'), ('core', 'c')]:
            with self.subTest(component=component, base=base):
                temporary, stack, private, before, events, router, args = self.scenario(component=component, component_base=base)
                with temporary, stack:
                    if base == 'c':
                        with self.assertRaisesRegex(RuntimeError, 'REMOTE_COMPONENT_BASE_CHANGED'):
                            deploy.main_locked(args)
                        self.assertFalse(any('runtime-maintenance-pause' in event for event in events))
                    else:
                        deploy.main_locked(args)
                        self.assertTrue(any('runtime-maintenance-pause' in event for event in events))
                        self.assertTrue(router['enabled'])
                        self.assertEqual(json.loads((private / 'remote-last.json').read_text())['components'], component)

    def test_update_preserves_identity_and_restores_only_after_core_ready(self):
        temporary, stack, private, before, events, router, args = self.scenario()
        with temporary, stack:
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                deploy.main_locked(args)
            report = json.loads(output.getvalue())
            self.assertNotIn('privateStatePreserved', report)
            self.assertEqual(report['preservation']['status'], 'pass')
            self.assertEqual(report['preservation']['windows'][0]['scope'], 'stopped-install-window')
            self.assertEqual(report['preservation']['windows'][1]['authentication']['status'], 'not-run')
            self.assertIn('real-restored-authentication', report['preservation']['notAssessed'])
            self.assertNotIn('synthetic secret', output.getvalue())
            after = json.loads((private / 'deployment.json').read_text())
            self.assertEqual(after['management']['deployment'], before['management']['deployment'])
            self.assertEqual(after['runtime']['automaticGateway'], before['runtime']['automaticGateway'])
            self.assertEqual(after['runtime']['stateDirectory'], before['runtime']['stateDirectory'])
            self.assertIn('b' * 64, after['runtime']['sourceDirectory'])
            find = lambda word: next(index for index, command in enumerate(events) if word in command)
            self.assertLess(find('check-adapter'), find('status'))
            self.assertLess(find('check-adapter'), find('runtime-maintenance-pause'))
            self.assertLess(find('prepare'), find('runtime-maintenance-pause'))
            self.assertLess(find('disable'), find('remove'))
            stage_index = find('stage')
            apply_index = next(index for index, command in enumerate(events) if 'upgrade' in command and '--apply' in command)
            self.assertLess(stage_index, find('runtime-maintenance-pause'))
            self.assertLess(find('remove'), apply_index)
            enable_router = next(index for index, command in enumerate(events) if command[0].endswith('router-hook') and command[1] == 'enable')
            self.assertLess(find('runtime-status'), enable_router)
            snapshots = [index for index, command in enumerate(events) if any(item.replace('\\', '/').endswith('/apps/deployment/preservation.ts') for item in command)]
            self.assertEqual(len(snapshots), 3)
            self.assertLess(find('stop'), snapshots[0])
            self.assertLess(snapshots[0], apply_index)
            self.assertLess(apply_index, snapshots[1])
            self.assertLess(snapshots[1], find('runtime-maintenance-restore'))
            self.assertLess(find('runtime-status'), snapshots[2])
            self.assertLess(snapshots[2], enable_router)
            self.assertLess(find('runtime-maintenance-restore'), next(index for index, command in enumerate(events)
                if command[:2] == ['/usr/bin/systemctl', 'start']))
            pause_command = next(command for command in events if 'runtime-maintenance-pause' in command)
            self.assertIn('payload', pause_command[6])
            self.assertTrue(router['enabled'])
            self.assertEqual(json.loads((private / 'remote-last.json').read_text())['status'], 'complete')
            self.assertEqual(json.loads((private / 'remote-last.json').read_text())['preservation'], report['preservation'])
            phases = [entry['phase'] for entry in report['timings']['phases']]
            self.assertLess(phases.index('release-preinstalled'), phases.index('maintenance-started'))
            self.assertIn('services-and-delivery-restored', phases)
            self.assertEqual(report['timings']['scope'], 'coordinator-not-client-outage')
            operations = {item['phase']: item for item in report['timings']['operations']}
            for phase in ['prepare', 'stage', 'apply', 'inspect', 'preservation-before', 'preservation-after',
                          'core-ready', 'management-ready', 'preservation-restored', 'router-disable', 'router-enable']:
                self.assertEqual(operations[phase]['status'], 'complete')
                self.assertGreaterEqual(operations[phase]['durationMs'], 0)

    def test_rejected_preparation_retains_reason_codes_without_private_values_or_maintenance(self):
        report = {'readiness': 'compatibility-evidence-incomplete', 'review': {'configurationChanged': False, 'changedFiles': ['/private/synthetic-path']},
            'compatibilityAssessment': {'assessments': {'historyCandidates': {'status': 'unknown', 'code': 'UPGRADE_HISTORY_FORMAT_ASSESSED',
                'reason': 'synthetic-private-value', 'checks': [{'status': 'unknown', 'code': 'UPGRADE_CANDIDATE_READER_NOT_DECLARED'}]}}}}
        temporary, stack, private, _, events, router, args = self.scenario(preparation_report=report)
        with temporary, stack, contextlib.redirect_stderr(io.StringIO()) as errors:
            with self.assertRaisesRegex(RuntimeError, 'REMOTE_UPGRADE_NOT_READY_OR_CONFIGURATION_CHANGED'):
                deploy.main_locked(args)
            diagnostic = json.loads(errors.getvalue())
            self.assertIn('UPGRADE_CANDIDATE_READER_NOT_DECLARED', diagnostic['codes'])
            self.assertFalse(diagnostic['configurationChanged'])
            self.assertNotIn('synthetic-private-value', errors.getvalue())
            self.assertNotIn('/private/synthetic-path', errors.getvalue())
            self.assertFalse(any(any(action in command for action in ['runtime-maintenance-pause', 'disable', 'stop', '--apply']) for command in events))
            self.assertFalse((private / 'remote-last.json').exists())
            self.assertTrue(router['enabled'])

    def test_adapter_unknown_incompatible_or_missing_action_fails_before_any_maintenance_in_preview_and_apply(self):
        for preview in [False, True]:
            for report in [None, 'timeout', 'invalid-json', {}, {'schemaVersion': 1, 'compatible': False}, {'schemaVersion': 1, 'compatible': 'unknown'}]:
                with self.subTest(preview=preview, report=report):
                    temporary, stack, private, _, events, router, args = self.scenario(adapter_report=report)
                    args.preview = preview
                    with temporary, stack:
                        with self.assertRaisesRegex(RuntimeError, 'REMOTE_ROUTER_ADAPTER_PREFLIGHT_FAILED'):
                            deploy.main_locked(args)
                        self.assertTrue(any('check-adapter' in command for command in events))
                        self.assertFalse(any(any(action in command for action in ['runtime-maintenance-pause', 'disable', 'stop', '--apply'])
                                             for command in events))
                        self.assertFalse((private / 'remote-last.json').exists())
                        self.assertTrue(router['enabled'])

    def test_adapter_preflight_accepts_disabled_installation_and_preview_still_does_not_pause_or_stop(self):
        temporary, stack, private, _, events, router, args = self.scenario(router_enabled=False, core_active=False,
            lifecycle={'schemaVersion': 1, 'enabled': False, 'paused': False})
        args.preview = True
        with temporary, stack:
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                deploy.main_locked(args)
            self.assertTrue(json.loads(output.getvalue())['prepared'])
            self.assertTrue(any('check-adapter' in command for command in events))
            self.assertFalse(any('runtime-maintenance-pause' in command or 'stop' in command for command in events))
            self.assertFalse(router['enabled'])
            self.assertFalse((private / 'remote-last.json').exists())

    def test_changed_install_window_blocks_service_and_router_restoration(self):
        temporary, stack, private, before, events, router, args = self.scenario(change_during_install=True)
        with temporary, stack:
            with self.assertRaisesRegex(RuntimeError, 'REMOTE_PRESERVATION_INSTALL_WINDOW_CHANGED'):
                deploy.main_locked(args)
            self.assertFalse(router['enabled'])
            self.assertFalse(any('runtime-maintenance-restore' in command for command in events))
            journal = json.loads((private / 'remote-last.json').read_text())
            self.assertEqual(journal['preservation']['status'], 'fail')
            self.assertEqual(journal['status'], 'failed')

    def test_full_upgrade_manager_health_failure_restores_previous_program_before_router_delivery(self):
        temporary, stack, private, before, events, router, args = self.scenario(health_failure=True)
        with temporary, stack:
            with self.assertRaisesRegex(RuntimeError, '^REMOTE_MANAGEMENT_NOT_READY$'):
                deploy.main_locked(args)
            journal = json.loads((private / 'remote-last.json').read_text())
            self.assertEqual(journal['status'], 'recovered')
            self.assertEqual(journal['recovery']['status'], 'restored')
            self.assertEqual(json.loads((private / 'deployment.json').read_text()), before)
            self.assertTrue(router['enabled'])
            health = [(index, event[1]) for index, event in enumerate(events) if event[0] == 'management-health']
            self.assertEqual(len(health), 2)
            self.assertNotEqual(health[0][1], before['management']['serverEntry'])
            self.assertEqual(health[1][1], before['management']['serverEntry'])
            router_enable = [index for index, event in enumerate(events) if event[-1] == 'enable' and 'router-hook' in event[0]]
            self.assertEqual(len(router_enable), 1)
            self.assertLess(health[1][0], router_enable[0])

    def test_failed_install_restores_previous_version_services_and_allows_reviewed_new_attempt(self):
        temporary, stack, private, before, events, router, args = self.scenario(True)
        with temporary, stack:
            with self.assertRaisesRegex(RuntimeError, 'INSTALL_SYNTHETIC_FAILURE'):
                deploy.main_locked(args)
            self.assertTrue(router['enabled'])
            self.assertTrue(any('runtime-maintenance-restore' in command for command in events))
            failed = json.loads((private / 'remote-last.json').read_text())
            self.assertEqual(failed['status'], 'recovered')
            self.assertEqual(failed['failure']['code'], 'INSTALL_SYNTHETIC_FAILURE')
            self.assertEqual(failed['recovery']['status'], 'restored')
            self.assertEqual(json.loads((private / 'deployment.json').read_text()), before)
            self.assertEqual(failed['maintenanceRestore']['previous'], {'present': True, 'enabled': True, 'paused': False})
            with self.assertRaisesRegex(RuntimeError, 'INSTALL_SYNTHETIC_FAILURE'):
                deploy.main_locked(args)

    def test_failures_during_maintenance_startup_and_router_restore_recover_original_intent(self):
        for phase in ['pause-result', 'restore-result', 'router-disable', 'management-stop', 'core-start', 'router-enable']:
            with self.subTest(phase=phase):
                temporary, stack, private, before, events, router, args = self.scenario(failure_at=phase)
                with temporary, stack:
                    with self.assertRaisesRegex(RuntimeError, 'REMOTE_SYNTHETIC_PHASE_FAILURE'):
                        deploy.main_locked(args)
                    result = json.loads((private / 'remote-last.json').read_text())
                    self.assertEqual(result['status'], 'recovered', result.get('recovery'))
                    self.assertTrue(router['enabled'])
                    self.assertEqual(json.loads((Path(before['runtime']['stateDirectory']) / 'lifecycle.json').read_text()),
                        {'schemaVersion': 1, 'enabled': True, 'paused': False})

    def test_rollback_failure_preserves_original_error_and_blocks_retry(self):
        temporary, stack, private, _, events, router, args = self.scenario(fail_apply=True, rollback_failure=True)
        with temporary, stack:
            with self.assertRaisesRegex(RuntimeError, '^INSTALL_SYNTHETIC_FAILURE$'):
                deploy.main_locked(args)
            result = json.loads((private / 'remote-last.json').read_text())
            self.assertEqual(result['status'], 'failed')
            self.assertEqual(result['recovery']['code'], 'INSTALL_ROLLBACK_SYNTHETIC_FAILURE')
            self.assertFalse(router['enabled'])
            with self.assertRaisesRegex(RuntimeError, 'REMOTE_PREVIOUS_DEPLOYMENT_REQUIRES_REVIEW'):
                deploy.main_locked(args)

    def test_upgrade_and_rollback_preserve_disabled_router_and_inactive_core_with_active_network(self):
        for fail_apply in [False, True]:
            with self.subTest(rollback=fail_apply):
                temporary, stack, private, _, events, router, args = self.scenario(fail_apply=fail_apply, core_active=False,
                    router_enabled=False, network_active=True, lifecycle={'schemaVersion': 1, 'enabled': False, 'paused': False})
                with temporary, stack:
                    if fail_apply:
                        with self.assertRaisesRegex(RuntimeError, 'INSTALL_SYNTHETIC_FAILURE'):
                            deploy.main_locked(args)
                    else:
                        deploy.main_locked(args)
                    result = json.loads((private / 'remote-last.json').read_text())
                    self.assertEqual(result['status'], 'recovered' if fail_apply else 'complete', result.get('recovery'))
                    self.assertFalse(router['enabled'])
                    self.assertIn(['/usr/bin/systemctl', 'start', 'cocoproxy-gateway-network.service'], events)
                    self.assertNotIn(['/usr/bin/systemctl', 'start', 'cocoproxy-mihomo.service'], events)

    def test_upgrade_restores_missing_and_disabled_lifecycle_intent_exactly(self):
        for lifecycle, active in [(None, True), ({'schemaVersion': 1, 'enabled': False, 'paused': False}, True),
                ({'schemaVersion': 1, 'enabled': False, 'paused': True}, False)]:
            with self.subTest(lifecycle=lifecycle):
                temporary, stack, private, before, events, router, args = self.scenario(lifecycle=lifecycle, core_active=active, router_enabled=active)
                with temporary, stack:
                    deploy.main_locked(args)
                    marker = Path(before['runtime']['stateDirectory']) / 'lifecycle.json'
                    self.assertEqual(marker.exists(), lifecycle is not None)
                    if lifecycle is not None:
                        self.assertEqual(json.loads(marker.read_text()), lifecycle)
                    self.assertFalse(any('runtime-resume' in command for command in events))

    def test_edit_completed_before_manager_stops_is_preserved_as_install_baseline(self):
        temporary, stack, private, before, events, router, args = self.scenario(edit_during_stop=True)
        with temporary, stack:
            deploy.main_locked(args)
            self.assertEqual(json.loads((Path(before['runtime']['stateDirectory']) / 'workspace.json').read_text()), {'revision': 8})
            self.assertEqual(json.loads((private / 'remote-last.json').read_text())['status'], 'complete')

    def test_absent_and_removed_networks_do_not_run_non_idempotent_remove(self):
        for status in [None, 'removed']:
            with self.subTest(status=status):
                temporary, stack, private, before, events, router, args = self.scenario(
                    lifecycle=None, core_active=False, router_enabled=False, network_receipt=status)
                with temporary, stack:
                    deploy.main_locked(args)
                    self.assertFalse(any('remove' in command for command in events))
                    self.assertTrue(any('--apply' in command for command in events))

    def test_incomplete_network_receipt_stops_before_runtime_or_router_mutation(self):
        temporary, stack, private, before, events, router, args = self.scenario(network_receipt='incomplete')
        with temporary, stack:
            with self.assertRaisesRegex(RuntimeError, 'REMOTE_NETWORK_RECEIPT_REQUIRES_REVIEW'):
                deploy.main_locked(args)
            self.assertFalse(any('runtime-maintenance-pause' in command or 'disable' in command for command in events))
            self.assertTrue(router['enabled'])



if __name__ == '__main__':
    unittest.main()
