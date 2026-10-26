#!/usr/bin/env python3
"""Release-bundled SSH deployment coordinator. No downloads or dependency installs."""
import argparse
import copy
try:
    import fcntl
except ImportError:
    fcntl = None
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import tempfile
import time

PRIVATE = Path('/etc/cocoproxy-install')
RECEIPT = Path('/var/lib/cocoproxy-deployment/receipt.json')
INCOMING = Path('/opt/cocoproxy/incoming')
NETWORK_RECEIPT = Path('/var/lib/cocoproxy-gateway-network/network-receipt.json')


def preservation_report(upgraded, compared_files=0):
    """Describe exactly the checks performed, never all private state."""
    status = 'pass' if upgraded else 'not-applicable'
    return {'schemaVersion': 1, 'scope': 'stopped-baseline-to-restored-file-comparison',
        'status': status, 'code': 'REMOTE_CHECKED_FILES_UNCHANGED' if upgraded else 'REMOTE_FIRST_INSTALL_NO_PRESERVATION_BASELINE',
        'checks': [
            {'id': 'administrator', 'status': status, 'evidenceScope': 'credential-file-bytes'},
            {'id': 'configured-business-files', 'status': status,
             'evidenceScope': 'workspace-site-probes-draft-subscription-file-set-and-bytes', 'comparedFileCount': compared_files}],
        'notAssessed': ['trusted-devices', 'notification-identity-preferences-and-outbox', 'automatic-runtime-bindings', 'runtime-selection-and-candidate',
            'restored-authentication-and-business-availability']}


def need(value, code):
    if not value:
        raise RuntimeError(code)


def regular(path, private=False, maximum=256 * 1024 * 1024):
    path = Path(path)
    info = path.lstat()
    need(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_size <= maximum, 'REMOTE_REGULAR_FILE_REQUIRED')
    if private:
        need(info.st_uid == 0 and stat.S_IMODE(info.st_mode) == 0o600, 'REMOTE_PRIVATE_FILE_REQUIRED')
    with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW), 'rb') as stream:
        opened = os.fstat(stream.fileno())
        need(stat.S_ISREG(opened.st_mode) and opened.st_nlink == 1 and opened.st_dev == info.st_dev and opened.st_ino == info.st_ino and
             opened.st_uid == info.st_uid and opened.st_mode == info.st_mode, 'REMOTE_REGULAR_FILE_CHANGED')
        data = stream.read(maximum + 1)
        need(len(data) <= maximum, 'REMOTE_REGULAR_FILE_REQUIRED')
        return data


def trusted(path):
    path = Path(path)
    need(path.is_absolute(), 'REMOTE_ABSOLUTE_PATH_REQUIRED')
    for item in [*reversed(path.parents), path]:
        info = item.lstat()
        need(not stat.S_ISLNK(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022, 'REMOTE_UNTRUSTED_PATH')
    return path


def directory(path, mode=0o755):
    path = Path(path)
    if not path.exists():
        directory(path.parent)
        path.mkdir(mode=mode)
        # Creation modes are filtered by the coordinator's private umask. Only
        # newly created directories may receive the requested explicit mode.
        path.chmod(mode)
    trusted(path)
    need(path.is_dir(), 'REMOTE_DIRECTORY_REQUIRED')
    return path


def service_traversable_directory(path):
    path = trusted(path)
    for item in [*reversed(path.parents), path]:
        info = item.lstat()
        need(stat.S_ISDIR(info.st_mode) and info.st_mode & 0o001, 'REMOTE_STAGE_DIRECTORY_NOT_TRAVERSABLE')


def staged_mode(path, expected):
    trusted(path)
    need(stat.S_IMODE(path.lstat().st_mode) == expected, 'REMOTE_CACHED_PAYLOAD_INVALID')


def put(path, data, mode=0o600):
    with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode), 'wb') as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())
        os.fchmod(stream.fileno(), mode)


def replace(path, value):
    path = Path(path)
    fd, temporary = tempfile.mkstemp(prefix='.remote-', dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as stream:
            json.dump(value, stream, indent=2)
            stream.write('\n')
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def run(args, timeout=120):
    result = subprocess.run([str(arg) for arg in args], capture_output=True, timeout=timeout)
    if result.returncode:
        error = result.stderr.decode(errors='replace').strip()
        raise RuntimeError(error if re.fullmatch(r'(INSTALL|SETUP|RUNTIME|REMOTE)_[A-Z0-9_]+', error) else 'REMOTE_STEP_FAILED')
    return result.stdout


def new_input(previous, manifest_sha, core_sha):
    """Change release references only; all network and private identity stays exact."""
    value = copy.deepcopy(previous)
    runtime = value['runtime']
    source = Path(runtime['sourceDirectory'])
    need(source.name == 'source' and re.fullmatch('[a-f0-9]{64}', source.parent.name), 'REMOTE_OLD_RELEASE_INVALID')
    release = source.parent.parent / manifest_sha
    runtime.update(sourceDirectory=str(release / 'source'), binaryPath=str(release / 'bin/mihomo'), binarySha256=core_sha)
    value['management']['serverEntry'] = str(release / 'server/.output/server/index.mjs')
    return value


def payload_manifest(raw, manifest_sha):
    need(hashlib.sha256(raw).hexdigest() == manifest_sha, 'REMOTE_MANIFEST_MISMATCH')
    manifest = json.loads(raw)
    need(isinstance(manifest, dict) and manifest.get('schemaVersion') == 1 and isinstance(manifest.get('files'), list) and
         0 < len(manifest['files']) <= 12000, 'REMOTE_MANIFEST_INVALID')
    names = {'manifest.json'}
    total = 0
    for entry in manifest['files']:
        need(isinstance(entry, dict), 'REMOTE_MANIFEST_INVALID')
        name = entry.get('path')
        need(isinstance(name, str) and len(name) <= 1024 and not name.startswith(('/', '-')) and not re.search(r'[\\:\x00-\x1f\x7f]', name) and
             not any(part.lower() in ['', '..', '.', '.local', '.git'] for part in name.split('/')) and name.lower() not in names,
             'REMOTE_PAYLOAD_PATH_INVALID')
        names.add(name.lower())
        need(type(entry.get('size')) is int and 0 <= entry['size'] <= 256 * 1024 * 1024 and
             isinstance(entry.get('sha256'), str) and re.fullmatch('[a-f0-9]{64}', entry['sha256']) and
             entry.get('mode') in ['0644', '0755'], 'REMOTE_MANIFEST_INVALID')
        total += entry['size']
        need(total <= 512 * 1024 * 1024, 'REMOTE_PAYLOAD_LIMIT')
    return manifest


def verify_staged_payload(stage, raw, manifest):
    service_traversable_directory(stage)
    staged_mode(stage, 0o755)
    need(stage.is_dir() and regular(stage / 'manifest.json', maximum=4 * 1024 * 1024) == raw, 'REMOTE_CACHED_PAYLOAD_INVALID')
    staged_mode(stage / 'manifest.json', 0o644)
    expected = {entry['path']: entry for entry in manifest['files']}
    parents = {str(parent.as_posix()) for name in expected for parent in Path(name).parents if str(parent) != '.'}
    found = set()
    for current, directories, files in os.walk(stage, followlinks=False):
        for name in directories:
            path = Path(current) / name
            need(not path.is_symlink() and path.relative_to(stage).as_posix() in parents, 'REMOTE_CACHED_PAYLOAD_INVALID')
            staged_mode(path, 0o755)
        for name in files:
            path = Path(current) / name
            relative = path.relative_to(stage).as_posix()
            need(relative == 'manifest.json' or relative in expected, 'REMOTE_CACHED_PAYLOAD_INVALID')
            staged_mode(path, 0o644 if relative == 'manifest.json' else int(expected[relative]['mode'], 8))
            if relative != 'manifest.json':
                data = regular(path)
                entry = expected[relative]
                need(len(data) == entry['size'] and hashlib.sha256(data).hexdigest() == entry['sha256'], 'REMOTE_CACHED_PAYLOAD_INVALID')
            found.add(relative)
    need(found == set(expected) | {'manifest.json'}, 'REMOTE_CACHED_PAYLOAD_INVALID')


def stage_payload(source, manifest_sha):
    source = Path(source)
    need(source.is_absolute() and not source.is_symlink() and source.is_dir(), 'REMOTE_PAYLOAD_PATH_INVALID')
    raw = regular(source / 'manifest.json', maximum=4 * 1024 * 1024)
    manifest = payload_manifest(raw, manifest_sha)
    parent = directory(INCOMING)
    # Existing private ancestors must be corrected explicitly by their owner;
    # never loosen them merely because a new payload needs service access.
    service_traversable_directory(parent)
    stage = parent / manifest_sha
    if stage.exists() or stage.is_symlink():
        verify_staged_payload(stage, raw, manifest)
        return stage, manifest
    temporary = Path(tempfile.mkdtemp(prefix='.staging-', dir=parent))
    try:
        temporary.chmod(0o755)
        for entry in manifest['files']:
            current = source
            for part in entry['path'].split('/'):
                current = current / part
                need(not current.is_symlink(), 'REMOTE_PAYLOAD_LINK')
            data = regular(current)
            need(len(data) == entry['size'] and hashlib.sha256(data).hexdigest() == entry['sha256'], 'REMOTE_PAYLOAD_CHANGED')
            target = temporary / entry['path']
            directory(target.parent)
            put(target, data, int(entry['mode'], 8))
        put(temporary / 'manifest.json', raw, 0o644)
        verify_staged_payload(temporary, raw, manifest)
        need(not stage.exists() and not stage.is_symlink(), 'REMOTE_STAGE_CONCURRENTLY_CREATED')
        temporary.rename(stage)
    finally:
        if temporary.exists():
            shutil.rmtree(temporary)
    return stage, manifest


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--payload', required=True)
    parser.add_argument('--manifest-sha256', required=True)
    for key in ['environment', 'input', 'admin-input', 'router-config', 'router-hook', 'web-unit']:
        parser.add_argument('--' + key)
    parser.add_argument('--preview', action='store_true')
    options = parser.parse_args(argv)
    need(fcntl is not None and os.name == 'posix' and os.uname().sysname == 'Linux' and os.geteuid() == 0, 'REMOTE_LINUX_ROOT_REQUIRED')
    need(re.fullmatch('[a-f0-9]{64}', options.manifest_sha256), 'REMOTE_MANIFEST_SHA_INVALID')
    os.umask(0o077)
    directory(PRIVATE, 0o700)
    need(stat.S_IMODE(PRIVATE.stat().st_mode) == 0o700, 'REMOTE_INSTALL_DIRECTORY_PRIVATE_REQUIRED')
    lock = os.open(PRIVATE / 'remote.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        os.close(lock)
        raise RuntimeError('REMOTE_DEPLOYMENT_BUSY')
    try:
        return main_locked(options)
    finally:
        os.close(lock)


def main_locked(options):
    journal = PRIVATE / 'remote-last.json'
    if journal.exists():
        need(json.loads(regular(journal, True))['status'] == 'complete', 'REMOTE_PREVIOUS_DEPLOYMENT_REQUIRES_REVIEW')
    payload, manifest = stage_payload(Path(options.payload), options.manifest_sha256)
    profile = json.loads(regular(PRIVATE / 'remote.json', True)) if (PRIVATE / 'remote.json').exists() else {}
    hook = options.router_hook or profile.get('routerHook')
    web_unit = options.web_unit or profile.get('webUnit')
    need(web_unit in [None, 'cocoproxy-web.service'], 'REMOTE_WEB_UNIT_INVALID')
    input_path = PRIVATE / 'deployment.json'
    installed = RECEIPT.exists()
    if installed:
        receipt = json.loads(regular(RECEIPT, True))
        need(receipt['status'] == 'complete', 'REMOTE_RECEIPT_NOT_COMPLETE')
        need(options.input or input_path.exists(), 'REMOTE_EXISTING_INPUT_REQUIRED')
        old = json.loads(regular(options.input) if options.input else regular(input_path, True))
        candidate = new_input(old, options.manifest_sha256, next(item['sha256'] for item in manifest['files'] if item['path'] == 'bin/mihomo'))
    else:
        need(options.environment and options.admin_input, 'REMOTE_FIRST_INSTALL_INPUT_REQUIRED')
        old = None
    if hook:
        trusted(hook)
        need(os.access(hook, os.X_OK), 'REMOTE_ROUTER_HOOK_NOT_EXECUTABLE')
    with tempfile.TemporaryDirectory(prefix='cocoproxy-remote-', dir='/run') as temporary:
        temporary = Path(temporary)
        router_config = PRIVATE / 'router-ssh.json'
        router_bytes = regular(options.router_config) if options.router_config else None
        if router_bytes:
            router_config = temporary / 'router-ssh.json'
            put(router_config, router_bytes)
        router_command = [hook] if hook else ['python3', payload / 'source/scripts/router-ssh-hook.py', '--config', router_config] if router_config.exists() else []
        next_path = temporary / 'deployment.json'
        setup = ['node', '--experimental-strip-types', payload / 'source/apps/setup/main.ts']
        if old:
            put(next_path, (json.dumps(candidate, indent=2) + '\n').encode())
        else:
            environment = temporary / 'environment.json'
            put(environment, regular(options.environment))
            run(setup + ['configure', '--environment', environment, '--payload', payload,
                '--manifest-sha256', options.manifest_sha256, '--output', next_path])
            candidate = json.loads(regular(next_path, True))
        runtime, management = candidate['runtime'], candidate['management']
        node = runtime['nodePath']
        setup[0] = node
        installer = [node, '--experimental-strip-types', payload / 'source/apps/deployment/main.ts']
        def inspect_complete(expected_sha):
            evidence = json.loads(run(installer + ['--operation', 'inspect']))
            need(evidence.get('installed') is True and evidence.get('release') == 'matches-receipt' and
                 evidence.get('receipt', {}).get('status') == 'complete' and
                 evidence.get('receipt', {}).get('manifestSha256') == expected_sha and
                 all(item.get('status') == 'matches-receipt' for item in evidence['files']) and
                 not evidence.get('lock', {}).get('present'), 'REMOTE_INSTALLATION_NOT_VERIFIED')
        systemctl = runtime['systemctlPath']
        service = management['serviceUser']
        common = ['--payload', payload, '--manifest-sha256', options.manifest_sha256, '--input', next_path]
        # Existing public installer verifies all payload, receipt, ownership,
        # state compatibility and unchanged configuration before maintenance.
        if installed and receipt['manifestSha256'] == options.manifest_sha256:
            inspect_complete(options.manifest_sha256)
            print(json.dumps({'installed': True, 'unchanged': True, 'commit': manifest['commit'],
                'preservation': {'status': 'not-run', 'code': 'REMOTE_UNCHANGED_NO_PRESERVATION_WINDOW'}}))
            return
        preparation = json.loads(run(installer + ['--operation', 'prepare' if installed else 'install', *common]))
        if installed:
            need(preparation.get('readiness') == 'prepared-not-applied' and preparation.get('review', {}).get('configurationChanged') is False,
                 'REMOTE_UPGRADE_NOT_READY_OR_CONFIGURATION_CHANGED')
        else:
            admin = temporary / 'administrator.json'
            initial_credential = temporary / 'credential.json'
            put(admin, regular(options.admin_input))
            run([node, '--experimental-strip-types', payload / 'source/apps/cli/main.ts', 'admin-init', '--input', admin, '--output', initial_credential])
        gateway = bool(runtime.get('automaticGateway'))
        need(not installed or not gateway or router_command, 'REMOTE_ROUTER_HOOK_REQUIRED')
        router_enabled = False
        if installed and gateway:
            router_state = json.loads(run([*router_command, 'status']))
            need(type(router_state.get('enabled')) is bool, 'REMOTE_ROUTER_STATUS_INVALID')
            router_enabled = router_state['enabled']
        def network_receipt():
            if not installed or not gateway or not (NETWORK_RECEIPT.exists() or NETWORK_RECEIPT.is_symlink()):
                return {'status': 'absent', 'sha256': None}
            trusted(NETWORK_RECEIPT)
            data = regular(NETWORK_RECEIPT, True, maximum=128 * 1024)
            value = json.loads(data)
            need(isinstance(value, dict) and type(value.get('schemaVersion')) is int and value['schemaVersion'] == 1 and
                 value.get('status') in ['complete', 'removed'], 'REMOTE_NETWORK_RECEIPT_REQUIRES_REVIEW')
            return {'status': value['status'], 'sha256': hashlib.sha256(data).hexdigest()}
        previous_network = network_receipt()
        if options.preview:
            print(json.dumps({'prepared': True, 'apply': False, 'operation': 'upgrade' if installed else 'install', 'commit': manifest['commit']}))
            return
        units = ['cocoproxy-management.service', 'cocoproxy-mihomo.service']
        if gateway:
            units += ['cocoproxy-gateway-network.service', 'cocoproxy-gateway-guard.service']
        if candidate.get('web') or web_unit:
            units += ['cocoproxy-web.service']
        def unit_value(unit, prop):
            return run([systemctl, 'show', unit, '-p', prop, '--value']).decode().strip()
        before_units = {}
        if installed:
            for unit in units:
                active, enable_state = unit_value(unit, 'ActiveState'), unit_value(unit, 'UnitFileState')
                need(active in ['active', 'inactive'] and enable_state in ['enabled', 'disabled', 'static', 'indirect'], 'REMOTE_SERVICE_STATE_UNSUPPORTED')
                before_units[unit] = {'active': active == 'active', 'enabled': enable_state == 'enabled', 'enableState': enable_state}
        def lifecycle(command, release, settings):
            return json.loads(run(['runuser', '-u', service, '--', node, '--experimental-strip-types', Path(release) / 'source/apps/cli/main.ts',
                command, '--state-dir', settings['stateDirectory'], '--runtime-settings', settings['settingsPath']]))
        def maintenance(command, token_path=None):
            args = ['runuser', '-u', service, '--', node, '--experimental-strip-types', payload / 'source/apps/cli/main.ts',
                    command, '--state-dir', runtime['stateDirectory']]
            return json.loads(run(args + (['--input', token_path] if token_path else [])))
        before_lifecycle = json.loads(regular(Path(runtime['stateDirectory']) / 'lifecycle.json')) if installed and (Path(runtime['stateDirectory']) / 'lifecycle.json').exists() else None
        if before_lifecycle:
            need(not (before_lifecycle['enabled'] and before_lifecycle['paused']), 'REMOTE_RUNTIME_ALREADY_PAUSED')
            need(not before_lifecycle['paused'] or not before_units['cocoproxy-mihomo.service']['active'], 'REMOTE_PAUSED_ACTIVE_CORE_REQUIRES_REVIEW')
        credential_sha = None
        def business():
            state = Path(runtime['stateDirectory'])
            files = [state / 'workspace.json', state / 'site-probes.json', state / 'draft.json', *sorted((state / 'subscriptions').glob('*.json'))]
            return {str(file.relative_to(state)): hashlib.sha256(regular(file)).hexdigest() for file in files if file.exists()}
        before_business = None
        progress = {'status': 'running', 'phase': 'maintenance', 'manifestSha256': options.manifest_sha256,
                    'previousServices': before_units, 'routerPreviouslyEnabled': router_enabled,
                    'previousNetworkReceipt': previous_network,
                    'previousLifecycle': {'present': before_lifecycle is not None,
                        'enabled': before_lifecycle['enabled'] if before_lifecycle else False,
                        'paused': before_lifecycle['paused'] if before_lifecycle else False}}
        def record_phase(phase, **facts):
            progress.update(phase=phase, **facts)
            replace(journal, progress)
        record_phase('maintenance')
        try:
            if installed:
                # The new public CLI can drain the shared transaction without parsing
                # old core settings, and returns an exact, fingerprint-bound intent token.
                paused = maintenance('runtime-maintenance-pause')
                restore_token = paused['maintenanceRestore']
                previous_intent = restore_token['previous']
                record_phase('runtime-paused', maintenanceRestore=restore_token)
                need(previous_intent == {'present': before_lifecycle is not None,
                     'enabled': before_lifecycle['enabled'] if before_lifecycle else False,
                     'paused': before_lifecycle['paused'] if before_lifecycle else False}, 'REMOTE_RUNTIME_INTENT_CHANGED')
                temporary.chmod(0o711)
                token_path = temporary / 'maintenance-restore.json'
                put(token_path, (json.dumps(restore_token) + '\n').encode())
                os.chown(token_path, runtime['serviceUid'], 0)
                os.chmod(token_path, 0o600)
                if gateway:
                    run([*router_command, 'disable'], timeout=300)
                    need(json.loads(run([*router_command, 'status']))['enabled'] is False, 'REMOTE_ROUTER_NOT_DISABLED')
                    record_phase('router-disabled')
                for unit in ['cocoproxy-web.service', 'cocoproxy-management.service', 'cocoproxy-mihomo.service', 'cocoproxy-gateway-network.service', 'cocoproxy-gateway-guard.service']:
                    if unit in units:
                        run([systemctl, 'stop', unit])
                enabled = [unit for unit, value in before_units.items() if value['enabled']]
                if enabled:
                    run([systemctl, 'disable', *enabled])
                if gateway:
                    need(network_receipt() == previous_network, 'REMOTE_NETWORK_RECEIPT_CHANGED')
                    if previous_network['status'] == 'complete':
                        run(['python3', '-I', Path(receipt['release']) / 'source/apps/gateway/network.py', 'remove',
                            '--settings', Path(old['runtime']['settingsPath']).parent / 'gateway-network.json'])
                # Snapshot after the manager has stopped: edits completed while
                # entering maintenance must remain valid, rather than look like
                # changes caused by the subsequent file installation.
                credential_sha = hashlib.sha256(regular(management['credentialPath'])).hexdigest()
                before_business = business()
                record_phase('services-stopped-network-retired')
            operation = 'upgrade' if installed else 'install'
            run(installer + ['--operation', operation, *common])
            run(installer + ['--operation', operation, *common, '--apply'])
            record_phase('files-installed')
            replace(input_path, candidate)
            replace(PRIVATE / 'remote.json', {**profile, **({'routerHook': hook} if hook else {}), **({'webUnit': web_unit} if web_unit else {})})
            if router_bytes:
                replace(PRIVATE / 'router-ssh.json', json.loads(router_bytes))
            if not installed:
                put(management['credentialPath'], regular(initial_credential, True))
                os.chown(management['credentialPath'], runtime['serviceUid'], 0)
                os.chmod(management['credentialPath'], 0o600)
            inspect_complete(options.manifest_sha256)
            if installed:
                restored = maintenance('runtime-maintenance-restore', token_path)
                need(restored.get('lifecycle') == {'schemaVersion': 1, 'enabled': previous_intent['enabled'], 'paused': previous_intent['paused']} and
                     (Path(runtime['stateDirectory']) / 'lifecycle.json').exists() == previous_intent['present'], 'REMOTE_RUNTIME_INTENT_NOT_RESTORED')
                record_phase('runtime-intent-restored')
            enabled = [unit for unit, value in before_units.items() if value['enabled']]
            if enabled:
                run([systemctl, 'enable', *enabled])
            if installed:
                for unit in ['cocoproxy-gateway-guard.service', 'cocoproxy-management.service', 'cocoproxy-web.service']:
                    if before_units.get(unit, {}).get('active'):
                        run([systemctl, 'start', unit])
                if before_units['cocoproxy-mihomo.service']['active']:
                    run([systemctl, 'start', 'cocoproxy-mihomo.service'])
                if before_units['cocoproxy-mihomo.service']['active'] or router_enabled:
                    for _ in range(30):
                        if (lifecycle('runtime-status', Path(runtime['sourceDirectory']).parent, runtime).get('core') or {}).get('ready'):
                            break
                        time.sleep(1)
                    else:
                        raise RuntimeError('REMOTE_CORE_NOT_READY')
                need(credential_sha == hashlib.sha256(regular(management['credentialPath'])).hexdigest() and before_business == business(), 'REMOTE_PRIVATE_STATE_CHANGED')
            else:
                run([systemctl, 'start', 'cocoproxy-management.service'])
                if candidate.get('web'):
                    run([systemctl, 'start', 'cocoproxy-web.service'])
            for unit, previous in before_units.items():
                need(not previous['active'] or unit_value(unit, 'ActiveState') == 'active', 'REMOTE_SERVICE_NOT_RESTORED')
                need(unit_value(unit, 'UnitFileState') == previous['enableState'], 'REMOTE_SERVICE_ENABLE_INTENT_CHANGED')
            if router_enabled:
                run([*router_command, 'enable'], timeout=300)
                need(json.loads(run([*router_command, 'status']))['enabled'] is True, 'REMOTE_ROUTER_NOT_RESTORED')
            preservation = preservation_report(installed, len(before_business) if before_business is not None else 0)
            replace(journal, {'status': 'complete', 'phase': 'verified', 'manifestSha256': options.manifest_sha256, 'commit': manifest['commit'],
                'preservation': preservation})
            print(json.dumps({'installed': True, 'updated': installed, 'commit': manifest['commit'], 'manifestSha256': options.manifest_sha256,
                'preservation': preservation, 'routerRestored': bool(router_enabled), 'initialConfigurationRequired': not installed}))
        except Exception:
            progress.update(status='failed', lastCompletedPhase=progress['phase'], phase='manual-review-required')
            replace(journal, progress)
            raise


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(str(error) if isinstance(error, RuntimeError) and re.fullmatch('[A-Z][A-Z0-9_]+', str(error)) else 'REMOTE_DEPLOYMENT_FAILED', file=__import__('sys').stderr)
        raise SystemExit(1)
