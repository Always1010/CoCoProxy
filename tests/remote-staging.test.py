"""Synthetic staged-payload checks. No system paths or remote commands are used."""
import contextlib
import hashlib
import importlib.util
import json
from pathlib import Path
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
        source, incoming = root / 'source', root / 'incoming'
        source.mkdir()
        incoming.mkdir()
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
        stack.enter_context(patch.object(deploy, 'put', lambda path, data, mode=0o600: Path(path).write_bytes(data)))
        return temporary, stack, source, incoming, digest, raw

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


if __name__ == '__main__':
    unittest.main()
