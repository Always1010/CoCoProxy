"""Synthetic lifecycle orchestration checks. Never calls SSH, systemd or installer."""
import contextlib
import importlib.util
import io
import hashlib
import json
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
            with self.subTest(code=code), patch.object(deploy.subprocess, 'run', return_value=SimpleNamespace(
                    returncode=1, stdout=stdout, stderr=stderr)), contextlib.redirect_stderr(io.StringIO()) as output:
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
            'stateDirectory': str(state), 'settingsPath': '/etc/sample/runtime.json', 'serviceUid': 12345, 'automaticGateway': {'schemaVersion': 1}},
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
                return json.dumps({'lifecycle': paused, 'maintenanceRestore': {'schemaVersion': 1,
                    'previous': {'present': present, 'enabled': previous['enabled'], 'paused': previous['paused']},
                    'pausedSha256': 'd' * 64}}).encode()
            if 'runtime-maintenance-restore' in args:
                previous = json.loads(Path(args[args.index('--input') + 1]).read_text())['previous']
                restored = {'schemaVersion': 1, 'enabled': previous['enabled'], 'paused': previous['paused']}
                if previous['present']:
                    (state / 'lifecycle.json').write_text(json.dumps(restored))
                else:
                    (state / 'lifecycle.json').unlink()
                return json.dumps({'lifecycle': restored}).encode()
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
                        rows = ['ActiveState=' + ('active' if active[args[2]] else 'inactive'), 'MainPID=' + pid,
                            'ExecMainStartTimestampMonotonic=1234', 'UnitFileState=' + enabled[args[2]]]
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
                    self.assertTrue(all(event[2:] == ['cocoproxy-management.service'] for event in mutations))
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
            self.assertTrue(all(event[2:] == ['cocoproxy-management.service'] for event in mutations))
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
        for phase in ['router-disable', 'management-stop', 'core-start', 'router-enable']:
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

    def test_rollback_preserves_disabled_router_and_inactive_core_with_active_network(self):
        temporary, stack, private, _, events, router, args = self.scenario(fail_apply=True, core_active=False,
            router_enabled=False, network_active=True, lifecycle={'schemaVersion': 1, 'enabled': False, 'paused': False})
        with temporary, stack:
            with self.assertRaisesRegex(RuntimeError, 'INSTALL_SYNTHETIC_FAILURE'):
                deploy.main_locked(args)
            result = json.loads((private / 'remote-last.json').read_text())
            self.assertEqual(result['status'], 'recovered', result.get('recovery'))
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
