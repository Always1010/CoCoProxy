"""Synthetic staged-payload checks. No system paths or remote commands are used."""
import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import stat
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('remote_deploy_staging', Path(__file__).parents[1] / 'scripts/remote-deploy.py')
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)

class RemoteStagingTests(unittest.TestCase):
    def fixture(self):
        temporary = tempfile.TemporaryDirectory(prefix='cocoproxy-remote-stage-')
        root = Path(temporary.name)
        root.chmod(0o755)
        source, incoming = root / 'source', root / 'incoming'
        source.mkdir()
        incoming.mkdir()
        incoming.chmod(0o755)
        (source / 'bin').mkdir()
        core = b'synthetic reviewed bytes'
        (source / 'bin/core').write_bytes(core)
        manifest = {'schemaVersion': 1, 'files': [{'path': 'bin/core', 'size': len(core),
            'sha256': hashlib.sha256(core).hexdigest(), 'mode': '0755'}]}
        raw = json.dumps(manifest).encode()
        (source / 'manifest.json').write_bytes(raw)
        digest = hashlib.sha256(raw).hexdigest()
        stack = contextlib.ExitStack()
        stack.enter_context(patch.object(deploy, 'INCOMING', incoming))
        stack.enter_context(patch.object(deploy, 'trusted', lambda path: Path(path)))
        def directory(path, mode=0o755):
            path = Path(path)
            path.mkdir(parents=True, exist_ok=True)
            return path
        stack.enter_context(patch.object(deploy, 'directory', directory))
        stack.enter_context(patch.object(deploy.os, 'O_NOFOLLOW', getattr(deploy.os, 'O_NOFOLLOW', 0), create=True))
        def put(path, data, mode=0o600):
            Path(path).write_bytes(data)
            Path(path).chmod(mode)
        stack.enter_context(patch.object(deploy, 'put', put))
        # Windows has no POSIX execute/ownership bits; byte/file-set cases remain
        # portable, while the permission integration below runs on POSIX.
        if os.name != 'posix':
            stack.enter_context(patch.object(deploy, 'service_traversable_directory', lambda path: None))
            stack.enter_context(patch.object(deploy, 'staged_mode', lambda path, expected: None))
        return temporary, stack, source, incoming, digest, raw

    def test_directory_explicit_modes_apply_only_to_new_directories(self):
        with tempfile.TemporaryDirectory(prefix='cocoproxy-stage-mode-') as temporary:
            existing = Path(temporary) / 'private'
            existing.mkdir(mode=0o700)
            before = stat.S_IMODE(existing.stat().st_mode)
            nested = existing / 'new' / 'nested'
            chmod = Path.chmod
            changed = []

            def record(path, mode):
                changed.append((path, mode))
                chmod(path, mode)

            previous_umask = os.umask(0o077)
            try:
                with patch.object(deploy, 'trusted', lambda path: Path(path)), patch.object(Path, 'chmod', record):
                    deploy.directory(nested)
                    deploy.directory(existing)
            finally:
                os.umask(previous_umask)
            self.assertEqual(changed, [(existing / 'new', 0o755), (nested, 0o755)])
            self.assertEqual(stat.S_IMODE(existing.stat().st_mode), before)

    @unittest.skipUnless(os.name == 'posix', 'requires POSIX permission bits')
    def test_private_umask_stages_readable_nested_payload_and_rejects_private_existing_ancestors(self):
        original_directory, original_put = deploy.directory, deploy.put
        temporary, stack, source, incoming, digest, raw = self.fixture()
        with temporary, stack:
            incoming.parent.chmod(0o755)
            incoming.chmod(0o755)
            nested = source / 'source/apps/cli/main.ts'
            nested.parent.mkdir(parents=True)
            nested.write_bytes(b'synthetic cli entry')
            manifest = json.loads(raw)
            manifest['files'].append({'path': 'source/apps/cli/main.ts', 'size': nested.stat().st_size,
                'sha256': hashlib.sha256(nested.read_bytes()).hexdigest(), 'mode': '0644'})
            raw = json.dumps(manifest).encode()
            digest = hashlib.sha256(raw).hexdigest()
            (source / 'manifest.json').write_bytes(raw)
            previous_umask = os.umask(0o077)
            try:
                with patch.object(deploy, 'directory', original_directory), patch.object(deploy, 'put', original_put):
                    stage, _ = deploy.stage_payload(source, digest)
                    for name in ['', 'source', 'source/apps', 'source/apps/cli', 'bin']:
                        self.assertEqual(stat.S_IMODE((stage / name).stat().st_mode), 0o755)
                    self.assertEqual(stat.S_IMODE((stage / 'source/apps/cli/main.ts').stat().st_mode), 0o644)
                    self.assertEqual(stat.S_IMODE((stage / 'bin/core').stat().st_mode), 0o755)
                    self.assertEqual(deploy.stage_payload(source, digest)[0], stage)
                    for target, mode in [(stage / 'source/apps', 0o700), (stage / 'source/apps/cli/main.ts', 0o600), (stage / 'bin/core', 0o644)]:
                        original_mode = stat.S_IMODE(target.stat().st_mode)
                        target.chmod(mode)
                        with self.assertRaisesRegex(RuntimeError, 'REMOTE_CACHED_PAYLOAD_INVALID'):
                            deploy.stage_payload(source, digest)
                        self.assertEqual(stat.S_IMODE(target.stat().st_mode), mode)
                        target.chmod(original_mode)
                    for target in [incoming, incoming.parent]:
                        target.chmod(0o700)
                        with self.assertRaisesRegex(RuntimeError, 'REMOTE_STAGE_DIRECTORY_NOT_TRAVERSABLE'):
                            deploy.stage_payload(source, digest)
                        self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o700)
                        target.chmod(0o755)
            finally:
                os.umask(previous_umask)

    def test_partial_copy_never_publishes_final_stage_and_can_retry(self):
        temporary, stack, source, incoming, digest, raw = self.fixture()
        with temporary, stack:
            with patch.object(deploy, 'put', side_effect=OSError('SYNTHETIC_WRITE_FAILURE')):
                with self.assertRaises(OSError):
                    deploy.stage_payload(source, digest)
            self.assertEqual(list(incoming.iterdir()), [])
            stage, manifest = deploy.stage_payload(source, digest)
            self.assertEqual(stage, incoming / digest)
            self.assertEqual((stage / 'manifest.json').read_bytes(), raw)
            self.assertEqual(deploy.stage_payload(source, digest)[0], stage)

    def test_cached_payload_requires_exact_file_set_and_original_bytes(self):
        for changed in ['bytes', 'extra', 'missing', 'manifest']:
            with self.subTest(changed=changed):
                temporary, stack, source, incoming, digest, raw = self.fixture()
                with temporary, stack:
                    stage, _ = deploy.stage_payload(source, digest)
                    if changed == 'bytes':
                        (stage / 'bin/core').write_bytes(b'changed')
                    elif changed == 'extra':
                        (stage / 'unexpected').write_text('extra')
                    elif changed == 'missing':
                        (stage / 'bin/core').unlink()
                    else:
                        (stage / 'manifest.json').write_text('{}')
                    with self.assertRaisesRegex(RuntimeError, 'REMOTE_CACHED_PAYLOAD_INVALID'):
                        deploy.stage_payload(source, digest)

    def test_manifest_rejects_noncanonical_private_and_case_colliding_paths(self):
        for name in ['bin//core', 'bin/./core', '../outside', '.LOCAL/private', 'bin\\core', '/absolute', 'manifest.json']:
            with self.subTest(name=name):
                value = {'schemaVersion': 1, 'files': [{'path': name, 'size': 0, 'sha256': 'a' * 64, 'mode': '0644'}]}
                raw = json.dumps(value).encode()
                with self.assertRaisesRegex(RuntimeError, 'REMOTE_PAYLOAD_PATH_INVALID'):
                    deploy.payload_manifest(raw, hashlib.sha256(raw).hexdigest())

    def test_cleanup_removes_only_the_verified_successful_transport_copy(self):
        for changed in [None, 'failed', 'preview', 'extra-stage', 'changed-release', 'missing-release', 'delete-failed']:
            with self.subTest(changed=changed):
                temporary, stack, source, incoming, digest, raw = self.fixture()
                with temporary, stack:
                    stage, _ = deploy.stage_payload(source, digest)
                    releases = incoming.parent / 'releases'
                    releases.mkdir()
                    installed = releases / digest
                    shutil.copytree(stage, installed)
                    old = releases / ('a' * 64)
                    old.mkdir()
                    (old / 'preserve').write_text('previous release')
                    private = incoming.parent / 'private'
                    private.mkdir()
                    receipt = private / 'receipt.json'
                    receipt.write_text(json.dumps({'status': 'complete', 'manifestSha256': digest, 'release': str(installed)}))
                    journal = private / 'remote-last.json'
                    journal.write_text(json.dumps({'status': 'running' if changed == 'preview' else 'failed' if changed == 'failed' else 'complete',
                        'manifestSha256': digest}))
                    if changed == 'extra-stage':
                        (stage / 'unknown').write_text('keep unknown file')
                    elif changed == 'changed-release':
                        (installed / 'bin/core').write_bytes(b'changed')
                    elif changed == 'missing-release':
                        shutil.rmtree(installed)
                    original_read = deploy.regular
                    # Synthetic files belong to the test process, never root system state.
                    with patch.object(deploy, 'PRIVATE', private), patch.object(deploy, 'RECEIPT', receipt), \
                         patch.object(deploy, 'regular', lambda path, private=False, maximum=256 * 1024 * 1024:
                             original_read(path, maximum=maximum)):
                        if changed == 'delete-failed':
                            with patch.object(deploy.shutil, 'rmtree', side_effect=OSError('SYNTHETIC_DELETE_FAILURE')):
                                with self.assertRaises(OSError):
                                    deploy.cleanup_successful_payload(digest)
                            self.assertFalse(stage.exists())
                            self.assertEqual(len(list(incoming.glob('.cleanup-*'))), 1)
                            self.assertEqual((installed / 'manifest.json').read_bytes(), raw)
                        elif changed is None:
                            deploy.cleanup_successful_payload(digest)
                            self.assertFalse(stage.exists())
                            self.assertEqual((installed / 'manifest.json').read_bytes(), raw)
                        else:
                            with self.assertRaises((RuntimeError, FileNotFoundError)):
                                deploy.cleanup_successful_payload(digest)
                            self.assertTrue(stage.exists())
                    self.assertEqual((old / 'preserve').read_text(), 'previous release')

    @unittest.skipUnless(deploy.fcntl is not None and os.uname().sysname == 'Linux', 'requires Linux coordinator lock')
    def test_coordinator_cleans_only_after_success_and_cleanup_failure_never_reverts_success(self):
        for outcome in ['success', 'preview', 'failed', 'cleanup-failed']:
            with self.subTest(outcome=outcome):
                temporary, stack, source, incoming, digest, _ = self.fixture()
                with temporary, stack:
                    private = incoming.parent / 'private'
                    private.mkdir(mode=0o700)
                    private.chmod(0o700)
                    args = ['--payload', str(source), '--manifest-sha256', digest]
                    if outcome == 'preview':
                        args.append('--preview')
                    with patch.object(deploy, 'PRIVATE', private), patch.object(deploy.os, 'geteuid', return_value=0), patch.object(deploy.os, 'umask'), \
                         patch.object(deploy.signal, 'signal'), contextlib.redirect_stderr(io.StringIO()), \
                         patch.object(deploy, 'main_locked', side_effect=RuntimeError('SYNTHETIC_FAILURE') if outcome == 'failed' else None,
                             return_value='complete'), \
                         patch.object(deploy, 'cleanup_successful_payload', side_effect=OSError('SYNTHETIC_FAILURE') if outcome == 'cleanup-failed' else None) as cleanup:
                        if outcome == 'failed':
                            with self.assertRaisesRegex(RuntimeError, 'SYNTHETIC_FAILURE'):
                                deploy.main(args)
                        else:
                            self.assertEqual(deploy.main(args), 'complete')
                        self.assertEqual(cleanup.call_count, int(outcome in ['success', 'cleanup-failed']))


if __name__ == '__main__':
    unittest.main()
