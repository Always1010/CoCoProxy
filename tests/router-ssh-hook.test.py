"""Router RPC deadline checks using a synthetic clock and SSH replies only."""
import contextlib
import copy
import importlib.util
import io
import json
from pathlib import Path
import shlex
import subprocess
import tarfile
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
                reply['config'] = {'schema': 1, 'revision': 4, 'enabled': True}
            elif method == 'capabilities':
                reply.update(schema=1, backend='external', externalProxy={'schema': 1, 'family': 'ipv4',
                    'clientModes': ['selected', 'lan'], 'faultPolicy': 'block', 'gatewayObservation': 'udp-dns'})
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


class RouterConfigurationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.project = Path(__file__).parents[1]
        code = """import {readFileSync} from 'node:fs';
import {parseSetupEnvironment, routerParameters} from './packages/setup/input.ts';
const input=JSON.parse(readFileSync('examples/setup-environment.json','utf8'));
input.router.enabled=true;
console.log(JSON.stringify(routerParameters(parseSetupEnvironment(input))));"""
        result = subprocess.run(['node', '--experimental-strip-types', '--input-type=module', '-e', code],
                                cwd=cls.project, capture_output=True, check=True)
        cls.parameters = json.loads(result.stdout)

    @contextlib.contextmanager
    def scenario(self, action, parameters=None, extra=None):
        with tempfile.TemporaryDirectory(prefix='cocoproxy-router-config-') as temporary:
            root = Path(temporary)
            config = root / 'ssh.json'
            config.write_text(json.dumps({'host': '192.0.2.1', 'user': 'root', 'port': 22,
                'identityFile': str(root / 'synthetic-id'), 'knownHostsFile': str(root / 'synthetic-known-hosts')}))
            params = root / 'parameters.json'
            params.write_text(json.dumps(self.parameters if parameters is None else parameters))
            current = copy.deepcopy(self.parameters['configTemplate'])
            current.update(revision=4, enabled=False, bypass4=['203.0.113.0/24'])
            current['dns']['localDomains'] = ['old.lan']
            state = {'phase': 'disabled', 'desiredEnabled': False, 'appliedRevision': None,
                     'localForwarding': {'running': False, 'guarded': False, 'residual': False, 'bootGuarded': False},
                     'dns': {'running': False}}
            replies = {'current': current, 'state': state, 'capabilities': {'ok': True, 'schema': 1, 'backend': 'external',
                'externalProxy': {'schema': 1, 'family': 'ipv4', 'clientModes': ['selected', 'lan'], 'faultPolicy': 'block',
                                  'gatewayObservation': 'udp-dns'}}, 'readbackMismatch': False, 'intentChanged': False,
                       'saveFailed': False, 'disableFailed': False, 'disableJobFailed': False, 'scheduled': False}
            calls = []
            def run(args, capture_output, timeout):
                command = shlex.split(args[-1])
                method, body = command[3], json.loads(command[4])
                calls.append((method, body))
                reply = {'ok': True}
                if method == 'capabilities':
                    reply = replies['capabilities']
                elif method == 'job_status':
                    reply['busy'] = False
                    if replies['scheduled']:
                        reply['job'] = {'id': 'synthetic-disable', 'status': 'failed'}
                elif method == 'external_get':
                    reply['config'] = copy.deepcopy(replies['current'])
                elif method == 'external_status':
                    reply['state'] = replies['state']
                elif method == 'external_save':
                    if replies['saveFailed']:
                        reply = {'ok': False, 'error': {'code': 'REVISION_CONFLICT'}}
                    else:
                        self.assertEqual(body['expectedRevision'], replies['current']['revision'])
                        self.assertEqual(body['config']['revision'], replies['current']['revision'])
                        replies['current'] = {**copy.deepcopy(body['config']), 'revision': body['expectedRevision'] + 1}
                        if replies['readbackMismatch']:
                            replies['current']['dns']['gatewayPort'] += 1
                        if replies['intentChanged']:
                            replies['state'] = {**state, 'phase': 'active', 'desiredEnabled': True}
                        reply['config'] = copy.deepcopy(replies['current'])
                elif method == 'external_disable':
                    replies['state'] = {**state, 'phase': 'disabled', 'desiredEnabled': False}
                    if replies['disableFailed']:
                        replies['state']['localForwarding']['residual'] = True
                    if replies['disableJobFailed']:
                        replies['scheduled'] = True
                        reply['job'] = {'id': 'synthetic-disable'}
                elif method == 'external_apply':
                    self.assertEqual(body['expectedRevision'], replies['current']['revision'])
                    replies['state'].update(phase='active', desiredEnabled=True, appliedRevision=replies['current']['revision'])
                else:
                    raise AssertionError('Unexpected mutation: ' + method)
                return SimpleNamespace(returncode=0, stdout=json.dumps(reply).encode())
            def invoke(requested_action=action, flags=None, include_parameters=True):
                argv = ['router-ssh-hook.py', '--config', str(config),
                        *(['--parameters', str(params)] if include_parameters else []), *(flags or []), requested_action]
                with patch('sys.argv', argv), contextlib.redirect_stdout(io.StringIO()) as output:
                    adapter.main()
                return json.loads(output.getvalue())
            with patch.object(adapter.os, 'geteuid', lambda: config.stat().st_uid, create=True), \
                 patch.object(adapter.stat, 'S_IMODE', lambda _: 0o600), patch.object(adapter.subprocess, 'run', run):
                yield invoke, replies, calls, config, params

    def test_adapter_check_only_observes_capabilities_and_schema_for_disabled_candidate_or_degraded_state(self):
        with self.scenario('check-adapter') as (invoke, replies, calls, _, params):
            replies['state'].update(phase='degraded', desiredEnabled=True)
            params.write_text('not used by adapter compatibility check')
            result = invoke(include_parameters=False)
            self.assertTrue(result['compatible'])
            self.assertEqual(result['scope'], 'capabilities-and-readable-configuration-schema')
            self.assertEqual(result['endToEnd'], 'unverified')
            self.assertFalse(replies['current']['enabled'])
            self.assertEqual([method for method, _ in calls], ['capabilities', 'external_get'])
            replies['capabilities']['externalProxy']['schema'] = 2
            with self.assertRaisesRegex(RuntimeError, 'REMOTE_ROUTER_CAPABILITIES_INCOMPATIBLE'):
                invoke(include_parameters=False)

    def test_preview_and_save_bind_target_revision_and_full_replacement_without_enabling(self):
        with self.scenario('preview-config') as (invoke, replies, calls, config, _):
            plan = invoke()
            fields = {change['field'] for change in plan['changes']}
            self.assertTrue({'enabled', 'bypass4', 'dns.localDomains'}.issubset(fields))
            self.assertEqual(plan['configuration']['revision'], 4)
            self.assertTrue(plan['candidateEnabled'])
            self.assertFalse(plan['persistentIntentEnabled'])
            self.assertNotIn('external_save', [method for method, _ in calls])
            self.assertEqual(invoke('save-config')['planSha256'], plan['planSha256'])
            with self.assertRaisesRegex(RuntimeError, 'REMOTE_ROUTER_PLAN_REVIEW_REQUIRED'):
                invoke('save-config', ['--apply'])
            target = json.loads(config.read_text())
            config.write_text(json.dumps({**target, 'port': 2222}))
            with self.assertRaisesRegex(RuntimeError, 'REMOTE_ROUTER_PLAN_REVIEW_REQUIRED'):
                invoke('save-config', ['--apply', '--reviewed-plan-sha256', plan['planSha256']])
            config.write_text(json.dumps(target))
            result = invoke('save-config', ['--apply', '--reviewed-plan-sha256', plan['planSha256']])
            self.assertEqual(result, {'schemaVersion': 1, 'saved': True, 'savedRevision': 5,
                'candidateEnabled': True, 'persistentIntentEnabled': False, 'networkApplied': False})
            self.assertFalse(replies['state']['desiredEnabled'])
            self.assertNotIn('external_apply', [method for method, _ in calls])
            self.assertEqual(invoke('enable'), {'enabled': True})
            self.assertTrue(replies['state']['desiredEnabled'])

    def test_save_rejects_changed_revision_configuration_intent_and_unconfirmed_readback(self):
        for change in ['revision', 'bypass4', 'active', 'readbackMismatch', 'intentChanged', 'saveFailed']:
            with self.subTest(change=change), self.scenario('preview-config') as (invoke, replies, calls, _, _):
                plan = invoke()
                if change == 'revision':
                    replies['current']['revision'] += 1
                elif change == 'bypass4':
                    replies['current']['bypass4'] = ['198.51.100.0/24']
                elif change == 'active':
                    replies['state'].update(phase='active', desiredEnabled=True)
                else:
                    replies[change] = True
                with self.assertRaises(RuntimeError):
                    invoke('save-config', ['--apply', '--reviewed-plan-sha256', plan['planSha256']])
                if change in ['revision', 'bypass4', 'active']:
                    self.assertNotIn('external_save', [method for method, _ in calls])
                self.assertNotIn('external_apply', [method for method, _ in calls])

    def test_missing_capability_or_inconsistent_parameters_block_configuration_and_enable(self):
        for change in ['capabilities', 'port', 'mac', 'domain', 'intent', 'schema']:
            with self.subTest(change=change), self.scenario('preview-config') as (invoke, replies, calls, _, params):
                value = copy.deepcopy(self.parameters)
                if change == 'capabilities':
                    replies['capabilities']['externalProxy']['clientModes'] = ['selected']
                elif change == 'port':
                    value['configTemplate']['dns']['gatewayPort'] += 1
                elif change == 'mac':
                    value['configTemplate']['link']['gatewayMac'] = value['deliveryMAC']
                elif change == 'domain':
                    value['configTemplate']['dns']['localDomains'] = ['bad..lan']
                elif change == 'intent':
                    value['prerequisites']['baseDNSIndependentConfirmed'] = False
                elif change == 'schema':
                    replies['current']['schema'] = 2
                params.write_text(json.dumps(value))
                for action in ['preview-config', 'enable']:
                    with self.assertRaises(RuntimeError):
                        invoke(action)
                self.assertFalse(any(method in ['external_save', 'external_apply'] for method, _ in calls))

    def test_check_compares_saved_draft_and_reports_applied_revision_separately(self):
        with self.scenario('check-config') as (invoke, replies, calls, _, _):
            with self.assertRaisesRegex(RuntimeError, 'REMOTE_ROUTER_CONFIGURATION_MISMATCH'):
                invoke()
            replies['current'] = {**copy.deepcopy(self.parameters['configTemplate']), 'revision': 4}
            self.assertFalse(invoke()['appliedConfigurationMatches'])
            replies['state'].update(phase='active', desiredEnabled=True, appliedRevision=3)
            self.assertFalse(invoke()['appliedConfigurationMatches'])
            with self.assertRaisesRegex(RuntimeError, 'REMOTE_ROUTER_CONFIGURATION_MISMATCH'):
                invoke('enable')
            replies['state']['appliedRevision'] = 4
            result = invoke()
            self.assertTrue(result['appliedConfigurationMatches'])
            self.assertEqual(result['endToEnd'], 'unverified')
            self.assertFalse(any(method in ['external_save', 'external_apply'] for method, _ in calls))

    def test_degraded_disable_ignores_capabilities_and_bad_parameters_but_confirms_no_residual(self):
        for failure in [None, 'residual', 'job']:
            with self.subTest(failure=failure), self.scenario('disable') as (invoke, replies, calls, _, params):
                replies['state'].update(phase='degraded', desiredEnabled=True)
                replies['capabilities'] = {'ok': False}
                params.write_text('invalid json deliberately ignored by independent close')
                replies['disableFailed'] = failure == 'residual'
                replies['disableJobFailed'] = failure == 'job'
                if failure == 'residual':
                    with self.assertRaisesRegex(RuntimeError, 'REMOTE_ROUTER_NOT_DISABLED'):
                        invoke()
                elif failure == 'job':
                    with self.assertRaisesRegex(RuntimeError, 'REMOTE_ROUTER_JOB_FAILED'):
                        invoke()
                else:
                    self.assertEqual(invoke(), {'enabled': False})
                self.assertEqual(calls[0][0], 'external_disable')
                self.assertNotIn('capabilities', [method for method, _ in calls])

    def test_release_selected_synthetic_archive_loads_same_declaration_in_typescript_and_python(self):
        names = ['package.json', 'packages/setup/router-adapter.ts', 'packages/setup/router-adapter.json',
                 'packages/config/index.ts', 'packages/config/compact-rules.ts', 'packages/routing/domestic-data.ts',
                 'packages/routing/legacy-domestic-data.ts', 'packages/routing/overseas-data.ts',
                 'scripts/router-ssh-hook.py']
        code = "import {selectedReleaseSource} from './scripts/release-layout.mjs'; console.log(JSON.stringify(process.argv.slice(1).map(selectedReleaseSource)))"
        result = subprocess.run(['node', '--input-type=module', '-e', code, *names], cwd=self.project, capture_output=True, check=True)
        self.assertTrue(all(json.loads(result.stdout)))
        with tempfile.TemporaryDirectory(prefix='cocoproxy-router-release-') as temporary:
            root = Path(temporary)
            archive_path = root / 'synthetic-release.tar.gz'
            with tarfile.open(archive_path, 'w:gz') as archive:
                for name in names:
                    archive.add(self.project / name, arcname='source/' + name)
            extracted = root / 'extracted'
            with tarfile.open(archive_path) as archive:
                archive.extractall(extracted, filter='data')
            script = """import {readFileSync} from 'node:fs';
import {createRouterParameters} from './packages/setup/router-adapter.ts';
const environment=JSON.parse(readFileSync(0,'utf8'));
environment.ports={dns:15353};
console.log(JSON.stringify(createRouterParameters(environment)));"""
            result = subprocess.run(['node', '--experimental-strip-types', '--input-type=module', '-e', script],
                                    cwd=extracted / 'source', input=(self.project / 'examples/setup-environment.json').read_text(),
                                    text=True, capture_output=True, check=True)
            packaged_spec = importlib.util.spec_from_file_location('packaged_router_hook', extracted / 'source/scripts/router-ssh-hook.py')
            packaged = importlib.util.module_from_spec(packaged_spec)
            packaged_spec.loader.exec_module(packaged)
            self.assertEqual(packaged.declaration(), adapter.declaration())
            self.assertEqual(packaged.validate_parameters(json.loads(result.stdout), packaged.declaration())['dns']['gatewayPort'], 15353)


if __name__ == '__main__':
    unittest.main()
