#!/usr/bin/env python3
"""Open Personal; copy the previous stopped installation on the first v0.1.0 launch."""
import argparse
from contextlib import closing, ExitStack
import ctypes
from datetime import datetime, timezone
import fcntl
import json
import os
from pathlib import Path
import plistlib
import shutil
import shlex
import socket
import sqlite3
import stat
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
MARKER = '.personal-v010-cutover.json'
TABLES = ('projection_projects', 'projection_threads', 'projection_thread_messages')
NODE_BIN = Path.home() / '.local/share/t3-personal-tooling/node-v24.13.1-darwin-arm64/bin'
PERSONAL_BUNDLE_ID = 'local.nafironato.t3code.personal-runtime'


def prepare_runtime_identity(root):
    """Keep Launch Services from resolving the Personal runtime to stock Alpha."""
    if main_pids(root, 'Beta', processes()):
        raise RuntimeError('Quit Personal before updating its macOS identity.')
    bundle = electron(root, 'Beta').parents[2]
    main_plist = bundle / 'Contents/Info.plist'
    if not main_plist.exists():
        raise RuntimeError(f'The Personal runtime is missing {main_plist}.')
    files = [main_plist]
    files.extend(sorted((bundle / 'Contents/Frameworks').glob('Electron Helper*.app/Contents/Info.plist')))
    changed = False
    for file in files:
        original = file.read_bytes()
        info = plistlib.loads(original)
        if file == main_plist:
            info['CFBundleIdentifier'] = PERSONAL_BUNDLE_ID
            info['CFBundleName'] = 'T3 Code Personal'
            info['CFBundleDisplayName'] = 'T3 Code Personal'
            for handler in info.get('CFBundleURLTypes', []):
                handler['CFBundleURLName'] = PERSONAL_BUNDLE_ID
        else:
            identifier = info.get('CFBundleIdentifier', '')
            if identifier.startswith('com.t3tools.t3code.helper'):
                info['CFBundleIdentifier'] = PERSONAL_BUNDLE_ID + identifier.removeprefix('com.t3tools.t3code')
        if plistlib.loads(original) != info:
            backup = root / '.t3/runtime-identity-backup' / file.relative_to(bundle)
            backup.parent.mkdir(parents=True, exist_ok=True)
            if not backup.exists():
                backup.write_bytes(original)
            file.write_bytes(plistlib.dumps(info))
            changed = True
    if changed:
        subprocess.run(['/usr/bin/codesign', '--force', '--deep', '--sign', '-', '--timestamp=none',
                        str(bundle)], check=True, capture_output=True, text=True)
    subprocess.run(['/usr/bin/codesign', '--verify', '--deep', '--strict', str(bundle)],
                   check=True, capture_output=True, text=True)


def processes():
    output = subprocess.check_output(['/bin/ps', '-ww', '-axo', 'pid=,command='], text=True)
    return [(int(parts[0]), parts[1]) for line in output.splitlines()
            if len(parts := line.strip().split(None, 1)) == 2]


def electron(root, channel):
    return root / f'apps/desktop/.electron-runtime/T3 Code ({channel}).app/Contents/MacOS/Electron'


def main_pids(root, channel, running):
    executable = electron(root, channel)
    commands = {f'{executable} dist-electron/main.cjs',
                f'{executable} {root / "apps/desktop/dist-electron/main.cjs"}'}
    return [pid for pid, command in running if command in commands]


def activate(pid):
    script = '''ObjC.import('AppKit');
function run(args) {
  const app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(Number(args[0]));
  if (app.isNil()) throw new Error('The app has closed. Please open it again.');
  app.activateWithOptions($.NSApplicationActivateIgnoringOtherApps);
}'''
    subprocess.run(['/usr/bin/osascript', '-l', 'JavaScript', '-e', script, str(pid)],
                   check=True, capture_output=True, text=True, timeout=15)


def require_stopped(previous_root, root, port):
    for _, command in processes():
        if command == '/Applications/T3 Code (Alpha).app/Contents/MacOS/T3 Code (Alpha)':
            raise RuntimeError('The original T3 Code (Alpha) is open and owns the connection port. '
                               'Quit Alpha after its agents finish, then open T3 Code Personal from Applications.')
        for candidate, channel in ((previous_root, 'Alpha'), (root, 'Beta')):
            if (command.startswith(f'{electron(candidate, channel)} ')
                    or command == f'{NODE_BIN / "node"} {candidate / "apps/desktop/scripts/start-electron.mjs"}'
                    or command.startswith(f'{NODE_BIN / "node"} {candidate / "apps/server/dist/bin.mjs"}')):
                raise RuntimeError('Personal is still running or shutting down. Wait, then open it again.')
    for pid, command in processes():
        if 'cloudflared' not in command:
            continue
        try:
            args = shlex.split(command)
        except ValueError:
            continue
        if not args or Path(args[0]).name != 'cloudflared' or args[1:] != [
                'tunnel', '--no-autoupdate', '--loglevel', 'info', '--output', 'default', 'run']:
            continue
        cwd = subprocess.run(['/usr/sbin/lsof', '-a', '-p', str(pid), '-d', 'cwd', '-Fn'],
                             capture_output=True, text=True, timeout=5)
        paths = [Path(line[1:]).resolve() for line in cwd.stdout.splitlines() if line.startswith('n')]
        if not paths and any(candidate_pid == pid for candidate_pid, _ in processes()):
            raise RuntimeError('Could not verify the running relay connector; wait and retry.')
        if any(path.is_relative_to(candidate.resolve()) for path in paths for candidate in (previous_root, root)):
            raise RuntimeError('The previous relay connector is still shutting down. Wait and reopen Personal.')
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', port))


def clone_or_copy(source, target):
    # APFS clones keep copying browser caches cheap; SQLite uses its backup API below.
    if sys.platform == 'darwin':
        clone = ctypes.CDLL('/usr/lib/libSystem.B.dylib', use_errno=True).clonefile
        clone.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_int]
        clone.restype = ctypes.c_int
        if clone(os.fsencode(source), os.fsencode(target), 0) == 0:
            return str(target)
    return shutil.copy2(source, target)


def database_stamp(source):
    return [(name, (p.stat().st_size, p.stat().st_mtime_ns) if p.exists() else None)
            for name in ('state.sqlite', 'state.sqlite-wal')
            for p in [source / 'userdata' / name]]


def require_data_directories(home):
    for name in ('userdata', 'electron-profile'):
        path = home / name
        if path.is_symlink() or not path.is_dir():
            raise RuntimeError(f'{path} must be a real directory, not a link.')


def snapshot_home(source, destination, check_stopped):
    """Publish one complete stopped-home copy. Never merge into an existing home."""
    check_stopped()
    if destination.exists():
        raise RuntimeError('The destination already exists; refusing to replace Personal data.')
    require_data_directories(source)
    for required in ('userdata/state.sqlite', 'userdata/environment-id', 'electron-profile'):
        if not (source / required).exists():
            raise RuntimeError(f'The previous Personal installation is missing {required}.')
    if (source / 'userdata/statev2.sqlite').exists():
        raise RuntimeError('The previous home already contains a V2 database; review it before migration.')
    stamp = database_stamp(source)
    destination.parent.mkdir(parents=True, exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix='personal-copy-', dir=destination.parent))
    started = time.monotonic()

    def ignore(folder, names):
        ignored = []
        for name in names:
            entry = Path(folder) / name
            relative = entry.relative_to(source)
            mode = entry.lstat().st_mode
            if (relative.parts[0] == 'runtime'
                    or relative.as_posix() in ('userdata/state.sqlite', 'userdata/state.sqlite-wal',
                                               'userdata/state.sqlite-shm', 'userdata/server-runtime.json')
                    or name in ('SingletonLock', 'SingletonSocket', 'SingletonCookie')
                    or not (stat.S_ISREG(mode) or stat.S_ISDIR(mode) or stat.S_ISLNK(mode))):
                ignored.append(name)
            elif entry.is_symlink():
                relocated = (stage / relative).parent / os.readlink(entry)
                if relocated.resolve(strict=False).is_relative_to(source.resolve()):
                    raise RuntimeError(f'A link points into the previous home: {relative}')
        return ignored

    try:
        shutil.copytree(source, stage, symlinks=True, dirs_exist_ok=True,
                        ignore=ignore, copy_function=clone_or_copy)
        original = source / 'userdata/state.sqlite'
        with closing(sqlite3.connect(original.as_uri() + '?mode=ro', uri=True, timeout=5)) as src:
            src.execute('PRAGMA query_only=ON')
            src.execute('BEGIN')
            counts = {table: src.execute(f'SELECT count(*) FROM {table}').fetchone()[0]
                      for table in TABLES}
            with closing(sqlite3.connect(stage / 'userdata/state.sqlite')) as dst:
                def progress(status, remaining, total):
                    if time.monotonic() - started > 600:
                        raise TimeoutError('Copying Personal data took over ten minutes; no cutover occurred.')
                src.backup(dst, pages=2048, progress=progress, sleep=.02)
                if dst.execute('PRAGMA quick_check').fetchall() != [('ok',)]:
                    raise RuntimeError('The copied database failed its integrity check.')
                if any(dst.execute(f'SELECT count(*) FROM {t}').fetchone()[0] != n
                       for t, n in counts.items()):
                    raise RuntimeError('The copied chat counts do not match.')
                dst.execute('PRAGMA journal_mode=DELETE')
        check_stopped()
        if database_stamp(source) != stamp:
            raise RuntimeError('The previous database changed during the copy; no cutover occurred.')
        environment_id = (source / 'userdata/environment-id').read_text().strip()
        if not environment_id or (stage / 'userdata/environment-id').read_text().strip() != environment_id:
            raise RuntimeError('The copied environment identity does not match.')
        manifest = {'sourceHome': str(source), 'capturedAt': datetime.now(timezone.utc).isoformat(),
                    'environmentId': environment_id, 'counts': counts, 'sourceDatabaseStamp': stamp,
                    'quickCheck': 'ok', 'targetVersion': '0.1.0-personal.1'}
        (stage / MARKER).write_text(json.dumps(manifest, indent=2) + '\n')
        stage.chmod(0o700)
        (stage / MARKER).chmod(0o600)
        if destination.exists():
            raise RuntimeError('The destination appeared during copying; refusing to replace it.')
        stage.rename(destination)
        return manifest
    except BaseException:
        shutil.rmtree(stage)
        raise


def prepared_home(source, destination, check_stopped):
    if not destination.exists():
        print('Copying the latest Personal chats, settings and desktop profile…', flush=True)
        return snapshot_home(source, destination, check_stopped)
    try:
        manifest = json.loads((destination / MARKER).read_text())
    except (OSError, ValueError) as error:
        raise RuntimeError('Existing Personal data has no valid cutover record; it was left untouched.') from error
    require_data_directories(destination)
    if (manifest.get('sourceHome') != str(source)
            or manifest.get('environmentId') != (destination / 'userdata/environment-id').read_text().strip()
            or not (destination / 'userdata/state.sqlite').is_file()):
        raise RuntimeError('Existing Personal data does not match this upgrade; it was left untouched.')
    # Rollback use can leave two divergent histories. Never refresh or hide that difference.
    if json.loads(json.dumps(database_stamp(source))) != manifest.get('sourceDatabaseStamp'):
        raise RuntimeError('The old app has newer data than the prepared copy. Reconcile both homes before switching.')
    return manifest


def environment(data, port):
    env = os.environ.copy()
    env.update({'PATH': f'{NODE_BIN}:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin',
                'T3CODE_HOME': str(data), 'T3CODE_DESKTOP_USER_DATA_DIR': str(data / 'electron-profile'),
                'T3CODE_DESKTOP_APP_NAME': 'T3 Code (Alpha)', 'T3CODE_PORT': str(port),
                'T3CODE_UPDATE_NOTIFY_ONLY_VERSION': '0.1.0'})
    for key in ('T3CODE_DISABLE_AUTO_UPDATE', 'VITE_DEV_SERVER_URL', 'ELECTRON_RUN_AS_NODE',
                'VITE_HTTP_URL', 'VITE_WS_URL'):
        env.pop(key, None)
    return env


def descriptor(port):
    try:
        with urllib.request.urlopen(f'http://127.0.0.1:{port}/.well-known/t3/environment', timeout=2) as reply:
            return json.load(reply)
    except (OSError, ValueError, urllib.error.URLError):
        return None


def launch(previous_root, root=ROOT, port=3773):
    if previous_root == root:
        raise RuntimeError('The old and new checkouts must be different.')
    data = root / '.t3/personal'
    source = previous_root / '.t3/personal'
    (root / '.t3').mkdir(exist_ok=True)
    with ExitStack() as locks:
        for path in (root / '.t3/personal-launch.lock', previous_root / '.t3/personal-launch.lock'):
            handle = locks.enter_context(path.open('a'))
            try:
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                print('Personal is already opening. Please wait.')
                return
        running = processes()
        old = main_pids(previous_root, 'Alpha', running)
        if old:
            activate(old[0])
            print('Upgrade installed for the next full quit and reopen; the running app was left in place.')
            return
        new = main_pids(root, 'Beta', running)
        if new:
            current = descriptor(port)
            expected = (data / 'userdata/environment-id').read_text().strip() if data.exists() else None
            if current and current.get('orchestrationProtocolVersion') == 2 and current.get('environmentId') == expected:
                activate(new[0])
                print('Opened existing Personal v0.1.0.')
                return
            raise RuntimeError('A v0.1.0 app is already starting or using another profile. Wait and retry.')
        check_stopped = lambda: require_stopped(previous_root, root, port)
        check_stopped()
        main = root / 'apps/desktop/dist-electron/main.cjs'
        executable = electron(root, 'Beta')
        for required in (main, executable, root / 'apps/server/dist/bin.mjs',
                         root / 'apps/server/dist/client/index.html'):
            if not required.is_file():
                raise RuntimeError(f'The prepared build is missing {required}.')
        prepare_runtime_identity(root)
        manifest = prepared_home(source, data, check_stopped)
        check_stopped()
        log_path = root / '.t3/personal-launch.log'
        with log_path.open('a') as log:
            child = subprocess.Popen([str(executable), str(main)], cwd=root / 'apps/desktop',
                                     env=environment(data, port), stdin=subprocess.DEVNULL,
                                     stdout=log, stderr=subprocess.STDOUT,
                                     start_new_session=True, close_fds=True)
        deadline = time.monotonic() + 90
        while time.monotonic() < deadline:
            if child.poll() is not None:
                raise RuntimeError(f'Personal exited during startup. Your previous data is intact. See {log_path}')
            current = descriptor(port)
            if current:
                if current.get('orchestrationProtocolVersion') != 2 or current.get('environmentId') != manifest['environmentId']:
                    raise RuntimeError(f'The server identity or version is unexpected. See {log_path}')
                (data / '.personal-launch-verified.json').write_text(json.dumps({
                    'verifiedAt': datetime.now(timezone.utc).isoformat(), 'pid': child.pid,
                    'serverVersion': current.get('serverVersion'), 'orchestrationProtocolVersion': 2,
                    'environmentId': current['environmentId']}, indent=2) + '\n')
                print('Personal v0.1.0 is ready with your existing environment identity (protocol 2).')
                return
            time.sleep(.5)
        print(f'Personal is still starting (PID {child.pid}). See {log_path}; do not launch the old app.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--previous-root', required=True, type=Path)
    parser.add_argument('--print-config', action='store_true')
    args = parser.parse_args()
    try:
        previous_root = args.previous_root.resolve()
        if args.print_config:
            print(json.dumps({'build': str(ROOT), 'previousHome': str(previous_root / '.t3/personal'),
                              'home': str(ROOT / '.t3/personal'), 'port': 3773,
                              'version': '0.1.0-personal.1', 'switch': 'after previous app exits'}, indent=2))
        else:
            launch(previous_root)
    except (OSError, RuntimeError, ValueError, sqlite3.Error, subprocess.SubprocessError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
