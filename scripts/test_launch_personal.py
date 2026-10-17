import importlib.util
from contextlib import closing
import json
import os
from pathlib import Path
import socket
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('launch_personal', Path(__file__).with_name('launch-personal.py'))
launcher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(launcher)


class CutoverTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.source = self.base / 'old/.t3/personal'
        self.destination = self.base / 'new/.t3/personal'
        (self.source / 'userdata/attachments').mkdir(parents=True)
        (self.source / 'userdata/secrets').mkdir()
        (self.source / 'electron-profile/Local Storage').mkdir(parents=True)
        (self.source / 'userdata/environment-id').write_text('existing-environment\n')
        (self.source / 'userdata/secrets/example').write_bytes(b'synthetic-encrypted-value')
        (self.source / 'userdata/attachments/example.png').write_bytes(b'synthetic-attachment')
        (self.source / 'electron-profile/Local Storage/settings').write_text('math-enabled')
        (self.source / 'userdata/server-runtime.json').write_text('stale-port')
        (self.source / 'runtime').mkdir()
        (self.source / 'runtime/update-marker').write_text('stale')
        self.db = sqlite3.connect(self.source / 'userdata/state.sqlite')
        self.addCleanup(self.db.close)
        self.db.execute('PRAGMA journal_mode=WAL')
        for table in launcher.TABLES:
            self.db.execute(f'CREATE TABLE {table}(id TEXT, text TEXT)')
            self.db.execute(f'INSERT INTO {table} VALUES (?, ?)', ('message', 'latest WAL content'))
        self.db.commit()

    def snapshot(self):
        return launcher.snapshot_home(self.source, self.destination, lambda: None)

    def test_consistent_wal_backup_and_complete_profile_copy(self):
        manifest = self.snapshot()
        with closing(sqlite3.connect(self.destination / 'userdata/state.sqlite')) as copied:
            self.assertEqual(copied.execute('PRAGMA quick_check').fetchone(), ('ok',))
            self.assertEqual(copied.execute('SELECT text FROM projection_thread_messages').fetchone(),
                             ('latest WAL content',))
        for relative in ('userdata/environment-id', 'userdata/secrets/example',
                         'userdata/attachments/example.png', 'electron-profile/Local Storage/settings'):
            self.assertEqual((self.destination / relative).read_bytes(), (self.source / relative).read_bytes())
        self.assertFalse((self.destination / 'userdata/statev2.sqlite').exists())
        self.assertFalse((self.destination / 'userdata/server-runtime.json').exists())
        self.assertFalse((self.destination / 'runtime').exists())
        self.assertEqual(manifest['counts']['projection_thread_messages'], 1)
        (self.destination / 'userdata/secrets/example').write_text('new')
        self.assertEqual((self.source / 'userdata/secrets/example').read_bytes(), b'synthetic-encrypted-value')

    def test_runtime_socket_and_singleton_links_are_not_copied(self):
        sock = socket.socket(socket.AF_UNIX)
        self.addCleanup(sock.close)
        # macOS UNIX socket names have a short limit; put this one near the temp root.
        sock.bind(str(self.base / 's'))
        os.rename(self.base / 's', self.source / 'ipc.sock')
        (self.source / 'electron-profile/SingletonSocket').symlink_to('/tmp/stale-socket')
        (self.source / 'userdata/attachment-alias').symlink_to('attachments/example.png')
        self.snapshot()
        self.assertFalse((self.destination / 'ipc.sock').exists())
        self.assertFalse((self.destination / 'electron-profile/SingletonSocket').is_symlink())
        self.assertEqual((self.destination / 'userdata/attachment-alias').read_bytes(), b'synthetic-attachment')

    def test_absolute_links_back_into_old_home_fail_closed(self):
        (self.source / 'userdata/unsafe-link').symlink_to(self.source / 'userdata/secrets/example')
        with self.assertRaisesRegex(RuntimeError, 'link points into'):
            self.snapshot()
        self.assertFalse(self.destination.exists())

    def test_existing_v2_source_is_not_imported_as_v1(self):
        (self.source / 'userdata/statev2.sqlite').touch()
        with self.assertRaisesRegex(RuntimeError, 'already contains a V2'):
            self.snapshot()
        self.assertFalse(self.destination.exists())

    def test_unknown_destination_is_never_replaced(self):
        self.destination.mkdir(parents=True)
        sentinel = self.destination / 'keep'
        sentinel.write_text('keep')
        with self.assertRaisesRegex(RuntimeError, 'no valid cutover record'):
            launcher.prepared_home(self.source, self.destination, lambda: None)
        self.assertEqual(sentinel.read_text(), 'keep')

    def test_partial_copy_failure_cannot_publish_a_home(self):
        with patch.object(launcher, 'clone_or_copy', side_effect=OSError('copy failure')):
            with self.assertRaises(OSError):
                self.snapshot()
        self.assertFalse(self.destination.exists())
        self.assertFalse(list(self.destination.parent.glob('personal-copy-*')))

    def test_source_change_during_copy_is_rejected(self):
        checks = 0

        def check():
            nonlocal checks
            checks += 1
            if checks == 2:
                self.db.execute("INSERT INTO projection_thread_messages VALUES ('later', 'new')")
                self.db.commit()

        with self.assertRaisesRegex(RuntimeError, 'changed during the copy'):
            launcher.snapshot_home(self.source, self.destination, check)
        self.assertFalse(self.destination.exists())

    def test_retry_keeps_new_data_and_never_recopies(self):
        manifest = self.snapshot()
        (self.destination / 'userdata/statev2.sqlite').write_bytes(b'already-started-v2')
        (self.source / 'userdata/attachments/example.png').write_bytes(b'old-app-changed')
        with patch.object(launcher, 'snapshot_home', side_effect=AssertionError('must not recopy')):
            self.assertEqual(launcher.prepared_home(self.source, self.destination, lambda: None),
                             json.loads(json.dumps(manifest)))
        self.assertEqual((self.destination / 'userdata/statev2.sqlite').read_bytes(), b'already-started-v2')
        self.assertEqual((self.destination / 'userdata/attachments/example.png').read_bytes(), b'synthetic-attachment')

    def test_stale_unstarted_snapshot_requires_review(self):
        self.snapshot()
        self.db.execute("INSERT INTO projection_thread_messages VALUES ('later', 'new')")
        self.db.commit()
        with self.assertRaisesRegex(RuntimeError, 'newer data'):
            launcher.prepared_home(self.source, self.destination, lambda: None)

    def test_rollback_changes_require_reconciliation_even_after_v2_start(self):
        self.snapshot()
        (self.destination / 'userdata/statev2.sqlite').write_bytes(b'new-v2-history')
        self.db.execute("INSERT INTO projection_thread_messages VALUES ('rollback', 'later message')")
        self.db.commit()
        with self.assertRaisesRegex(RuntimeError, 'Reconcile both homes'):
            launcher.prepared_home(self.source, self.destination, lambda: None)
        self.assertEqual((self.destination / 'userdata/statev2.sqlite').read_bytes(), b'new-v2-history')

    def test_symlinked_container_cannot_write_outside_snapshot(self):
        real = self.source / 'userdata'
        external = self.base / 'external-userdata'
        real.rename(external)
        real.symlink_to(external, target_is_directory=True)
        with self.assertRaisesRegex(RuntimeError, 'must be a real directory'):
            self.snapshot()
        self.assertFalse(self.destination.exists())

    def test_live_old_app_is_only_activated(self):
        old_root = self.base / 'old'
        new_root = self.base / 'new'
        new_root.mkdir()
        running = [(12345, f'{launcher.electron(old_root, "Alpha")} dist-electron/main.cjs')]
        with patch.object(launcher, 'processes', return_value=running), \
                patch.object(launcher, 'activate') as activate, \
                patch.object(launcher, 'prepared_home', side_effect=AssertionError('must not copy')), \
                patch.object(launcher.subprocess, 'Popen', side_effect=AssertionError('must not launch')):
            launcher.launch(old_root, new_root)
        activate.assert_called_once_with(12345)
        self.assertFalse(self.destination.exists())

    def test_remaining_backend_blocks_cutover(self):
        root = self.base / 'old'
        running = [(12345, f'{launcher.electron(root, "Alpha")} {root}/apps/server/dist/bin.mjs --bootstrap-fd 3')]
        with patch.object(launcher, 'processes', return_value=running):
            with self.assertRaisesRegex(RuntimeError, 'still running or shutting down'):
                launcher.require_stopped(root, self.base / 'new', 0)

    def test_occupied_port_blocks_cutover(self):
        with socket.socket() as occupied:
            occupied.bind(('127.0.0.1', 0))
            occupied.listen()
            with patch.object(launcher, 'processes', return_value=[]):
                with self.assertRaises(OSError):
                    launcher.require_stopped(self.base / 'old', self.base / 'new', occupied.getsockname()[1])

    def test_orphaned_owned_relay_blocks_cutover(self):
        running = [(12345, '/opt/homebrew/bin/cloudflared tunnel --no-autoupdate --loglevel info --output default run')]
        result = subprocess.CompletedProcess([], 0, f'p12345\nn{self.base / "old"}\n', '')
        with patch.object(launcher, 'processes', return_value=running), \
                patch.object(launcher.subprocess, 'run', return_value=result):
            with self.assertRaisesRegex(RuntimeError, 'relay connector'):
                launcher.require_stopped(self.base / 'old', self.base / 'new', 0)

    def test_detached_launch_waits_for_matching_protocol_and_identity(self):
        root = self.base / 'new'
        executable = launcher.electron(root, 'Beta')
        executable.parent.mkdir(parents=True)
        executable.write_text(f'#!{sys.executable}\n' + '''
import http.server, json, os
from pathlib import Path
data = Path(os.environ['T3CODE_HOME'])
class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args): pass
    def do_GET(self):
        self.send_response(200)
        self.end_headers()
        self.wfile.write(json.dumps({'environmentId': (data/'userdata/environment-id').read_text().strip(),
            'orchestrationProtocolVersion': 2, 'serverVersion': '0.1.0-test'}).encode())
http.server.HTTPServer(('127.0.0.1', int(os.environ['T3CODE_PORT'])), Handler).serve_forever()
''')
        executable.chmod(0o700)
        for relative in ('apps/desktop/dist-electron/main.cjs', 'apps/server/dist/bin.mjs',
                         'apps/server/dist/client/index.html'):
            file = root / relative
            file.parent.mkdir(parents=True, exist_ok=True)
            file.touch()
        with socket.socket() as available:
            available.bind(('127.0.0.1', 0))
            port = available.getsockname()[1]
        children = []
        spawn = subprocess.Popen

        def tracked_spawn(*args, **kwargs):
            child = spawn(*args, **kwargs)
            children.append(child)
            return child

        try:
            with patch.object(launcher, 'processes', return_value=[]), \
                    patch.object(launcher.subprocess, 'Popen', side_effect=tracked_spawn):
                launcher.launch(self.base / 'old', root, port)
            self.assertEqual(len(children), 1)
            self.assertIsNone(children[0].poll())
            self.assertEqual(os.getsid(children[0].pid), children[0].pid)
            verified = json.loads((self.destination / '.personal-launch-verified.json').read_text())
            self.assertEqual(verified['orchestrationProtocolVersion'], 2)
            self.assertEqual(verified['environmentId'], 'existing-environment')
        finally:
            for child in children:
                child.terminate()
                child.wait(timeout=5)


if __name__ == '__main__':
    unittest.main()
