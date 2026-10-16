#!/usr/bin/env python3
"""Launch the built v0.1.0 Personal staging app without using the live profile."""
import argparse
import fcntl
import json
import os
from pathlib import Path
import socket
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
REVIEW = ROOT / '.t3' / 'review'
DATA = REVIEW / 'test-home'
PROFILE = REVIEW / 'electron-profile'
ELECTRON = ROOT / 'apps/desktop/.electron-runtime/T3 Code (Beta).app/Contents/MacOS/Electron'
MAIN = ROOT / 'apps/desktop/dist-electron/main.cjs'
NODE_BIN = Path.home() / '.local/share/t3-personal-tooling/node-v24.13.1-darwin-arm64/bin'


def environment():
    env = os.environ.copy()
    env.update({
        'PATH': f'{NODE_BIN}:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin',
        'T3CODE_HOME': str(DATA),
        'T3CODE_DESKTOP_USER_DATA_DIR': str(PROFILE),
        # The copied credentials used this pre-ready Keychain identity.
        'T3CODE_DESKTOP_APP_NAME': 'T3 Code (Alpha)',
        'T3CODE_PORT': '3774',
        'T3CODE_UPDATE_NOTIFY_ONLY_VERSION': '0.1.0',
    })
    for key in ('T3CODE_DISABLE_AUTO_UPDATE', 'VITE_DEV_SERVER_URL', 'ELECTRON_RUN_AS_NODE',
                'VITE_HTTP_URL', 'VITE_WS_URL'):
        env.pop(key, None)
    return env


def launch():
    if sys.platform != 'darwin':
        raise RuntimeError('This staging launcher targets the prepared macOS Electron runtime.')
    for required in (ELECTRON, MAIN, ROOT / 'apps/server/dist/bin.mjs',
                     ROOT / 'apps/server/dist/client/index.html', DATA / 'userdata', PROFILE):
        if not required.exists():
            raise RuntimeError(f'Prepare the staging build and snapshot first; missing {required}')
    REVIEW.mkdir(parents=True, exist_ok=True)
    with (REVIEW / 'personal-v010-launch.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        # Refuse an occupied staging port; never stop its owner.
        with socket.socket() as probe:
            probe.bind(('127.0.0.1', 3774))
        with (REVIEW / 'personal-v010-launch.log').open('a') as log:
            child = subprocess.Popen([str(ELECTRON), str(MAIN)],
                                     cwd=ROOT / 'apps/desktop', env=environment(),
                                     stdin=subprocess.DEVNULL, stdout=log,
                                     stderr=subprocess.STDOUT, start_new_session=True,
                                     close_fds=True)
        try:
            code = child.wait(timeout=2)
        except subprocess.TimeoutExpired:
            print(f'Staging app started independently (PID {child.pid}). Log: {REVIEW / "personal-v010-launch.log"}')
            return
        raise RuntimeError(f'Staging app exited during startup (code {code}); inspect its log.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--print-config', action='store_true', help='Show paths and overrides without launching.')
    args = parser.parse_args()
    if args.print_config:
        print(json.dumps({key: value for key, value in environment().items()
                          if key in ('T3CODE_HOME', 'T3CODE_DESKTOP_USER_DATA_DIR',
                                     'T3CODE_DESKTOP_APP_NAME', 'T3CODE_PORT',
                                     'T3CODE_UPDATE_NOTIFY_ONLY_VERSION')}, indent=2))
    else:
        try:
            launch()
        except (OSError, RuntimeError, subprocess.SubprocessError) as error:
            print(str(error), file=sys.stderr)
            sys.exit(1)
