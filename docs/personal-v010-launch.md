# Personal v0.1.0 launch

## Installed Personal launcher

`scripts/launch-personal.py --previous-root /path/to/previous/checkout` launches the prepared production build on port 3773. While the previous Personal app is open, it brings that window forward without interrupting agents. After a full quit, the next launch copies the latest stopped Personal home and Electron profile into this checkout's `.t3/personal`, verifies the database, and opens v0.1.0. No Terminal window needs to remain open.

The old home stays intact. Existing v0.1.0 data is never overwritten or refreshed automatically. The copy preserves the environment ID and relay credentials so the mobile app can reconnect to the same environment. First launch can take longer while copying data and importing chats; copied credentials may prompt for Keychain access. Local readiness requires protocol 2 and the original environment ID; it does not verify the managed relay or the physical iPhone.

Personal's native runtime uses its own macOS bundle identifier, separate from the stock Alpha app. The launcher restores this identity after a runtime rebuild and verifies the signature before starting. It keeps the legacy pre-ready Keychain name. If Alpha is still open, the launcher explains that Alpha must quit before Personal can use port 3773.

For rollback, fully quit v0.1.0, then run the saved previous launcher. Never run the two copies of this environment together. New messages written in v0.1.0 do not appear in the old database; keep both homes, and reconcile any later rollback deliberately.

## Isolated staging launcher

The staging launcher uses `.t3/review/test-home` for server data, `.t3/review/electron-profile` for Electron data, and port 3774. It does not point at the running Personal build's data or change its launcher.

Prepare the staging data snapshot and build the server, web assets, desktop bundle, and local `T3 Code (Beta).app` runtime before launching. The launcher checks these files and refuses an occupied port. It does not build, install, migrate, or stop another app.

Review the paths without starting Electron:

```sh
python3 scripts/launch-personal-v010.py --print-config
```

Start the prepared app independently of Terminal:

```sh
python3 scripts/launch-personal-v010.py
```

Startup output goes to `.t3/review/personal-v010-launch.log`. The app reports `0.1.0-personal.1`. Update notices compare against upstream `0.1.0`; downloads and installs stay disabled.

## Copied credentials and native identity

The old Personal launcher used `T3 Code (Alpha)` as its Electron app name. On macOS, [Electron 44.4.5 captures that name for the Keychain service and account before readiness](https://github.com/electron/electron/blob/v44.4.5/shell/browser/electron_browser_main_parts.cc#L591-L633). Changing the name at that phase can make copied encrypted credentials unreadable.

The staging launcher supplies the same explicit name. `configureBeforeReady` preserves it while Electron initializes SafeStorage. After readiness, `configure` sets `T3 Code Beta`, retaining the valid native User-Agent product name required by the upstream Turnstile fix. Ordinary launches without an override use the safe name in both phases.

Unit tests verify phase selection. A native Electron 44.4.5 probe also passed: one isolated process encrypted a synthetic sentinel under the legacy identity; a second started under that identity, switched to the safe runtime name after readiness, and decrypted the sentinel successfully. This validates the name transition without reading saved credentials. The staging app still needs a separate check of any copied connection catalog. A Keychain permission prompt can occur when the executable or its signature changes. Keep validation on the staging profile.

## What the upgrade migrates

[v0.1.0](https://github.com/pingdotgg/t3code/releases/tag/v0.1.0) introduces Orchestrator V2. At first start it copies `userdata/state.sqlite` to `userdata/statev2.sqlite`, then imports the old projects, chats, user/assistant messages, and attachment references. The old database remains available. Older reasoning/tool timelines, restore points and native provider sessions are not resumed; continuing an imported chat starts a fresh provider session using a bounded transcript. See the upstream [migration notes](https://github.com/pingdotgg/t3code/issues/14871).

The two databases diverge after that copy. For the real cutover, let working agents finish, stop the old app, and take a fresh consistent copy of the entire Personal home, attachments and Electron profile. Do not replace the live home with this test snapshot. Keep the old home and launcher for rollback, and do not run both versions against one home. Copy server/provider settings and keybindings as well as the database; browser appearance preferences live in the Electron profile.

The iOS client must use the v2 protocol (official app 2.0 or later). The Personal backend keeps the upstream protocol. The native client exposes response forks, but the desktop math renderer and Edit controls do not add native iOS controls. App Store binary compatibility needs confirmation on that installed version.

Math rendering is controlled by **Settings → Appearance → Render math**. It is off in a fresh profile. Copying the old Electron profile at cutover preserves that device's preference.

## Updates

The launcher compares upstream releases with 0.1.0 and shows release notices. It disables automatic downloads and installs, including remote install requests. A newer upstream release should be merged into the Personal source, checked in an isolated home, rebuilt, and then deliberately selected for launch. Replacing this build with the stock app would remove Personal changes.

## Validation recorded during preparation

The isolated full database migration imported 356 chats and all 22,204 user/assistant messages. SQLite integrity checks passed before and after migration. The copied legacy database also retains 19,466 reasoning rows that V2 does not display. No provider runtime was started during that migration test.

A message-by-message comparison confirmed that all imported user/assistant text and attachment lists match the original. Every attachment referenced by a non-deleted chat was present.

| Check | Result |
| --- | --- |
| Web, server, desktop build | Passed; staging desktop starts independently on port 3774. |
| Types and scoped lint | Passed across changed packages and files. |
| Math, search, message actions, updater, identity, DevTools and history regression tests | Passed. |
| Codex live browser flow | Fork recalled retained context; edit restored the prompt and the replacement prompt completed. |
| Grok CLI 1.0.60 live flow | Selected-turn fork retained the first prompt and excluded the second; original stayed intact. Rewind and re-prompt preserved the native session and correct context. |
| Grok invalid history | Invalid checkpoint and missing-baseline rollback were rejected without changing recorded source state. |
| File suggestions in browser | Bare `@` populated suggestions; a root PDF name prefix found both matching PDF files. |
| Math in browser | Inline and display equations rendered in user and assistant messages after enabling the preference. |
| Native credential identity | Synthetic encrypted sentinel survived the pre-ready legacy name and post-ready runtime name transition. |
| Delegation policy | 12 Python tests passed. |
| Claude live flow | Passed with Claude Haiku 5.5 after the reported quota reset: selected-turn native fork, source-context preservation, rewind/re-prompt, and invalid-checkpoint rejection. |
| Final web UI | Browser connection recovered. Visible Edit/Fork, edit confirmation/cancel, inline/display math, and layouts at 375, 768 and 1440 px passed. No document overflow at those widths. Claude controls also rendered. |
| Real browser DevTools | The upgraded ServerBrowser, broker and DevTools service passed against real pinned Chromium: console, network/body, computed/matched styles, memory, 4× CPU/Fast 4G, reset and trace export (340 events, no reported data loss). The original desktop host failed trace export; the v0.1.0 native desktop CDP relay still needs a direct check. |
| iOS native client | Built and installed on the iOS 27 simulator after fixing an upstream SDK guard. Pairing, chat loading, a response fork and a new Codex reply passed. Forking after an edit exposed an inherited-history display bug; the fix passed 48 regression tests and native retests of both existing and new forks. HTTP and WebSocket snapshots agree. This tests the development client, not the App Store binary. |

The iOS retest initially reused a persisted snapshot from before the server fix. Removing and re-pairing the test environment did not clear that stale thread snapshot. Terminating the disposable app and clearing only that cached thread row produced the correct history. That test used a separate environment; the production cutover preserves the existing environment ID. Do not treat a warm client cache as proof of the server's current projection.

Grok's native rewind is not transactional with the subsequent session reload. If reload fails after a confirmed rewind, the operation reports failure but the native conversation may already be truncated. Session identity guards prevent accepting a different loaded session.

Detailed machine-local logs, snapshot manifests, test reports and native credential probe evidence are in `.t3/review/`. They are excluded from git because the snapshots contain private chat history. The staging app uses a small stopped-chat sample and fresh test threads, not the full snapshot.
