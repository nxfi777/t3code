import { assert, describe, it } from "@effect/vitest";
import { afterEach, vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { FetchHttpClient } from "effect/unstable/http";
import * as Option from "effect/Option";
import * as DesktopUpdates from "./DesktopUpdates.ts";
import { makeHarness } from "./updatesTestHarness.ts";

afterEach(() => vi.unstubAllGlobals());
const notificationHarness = (extraEnv = {}) =>
  makeHarness({
    isPackaged: false,
    env: {
      T3CODE_DESKTOP_MOCK_UPDATES: "false",
      T3CODE_UPDATE_NOTIFY_ONLY_VERSION: "0.0.45",
      ...extraEnv,
    },
  });
const stubRelease = (version: string) => {
  const fetch = vi
    .fn()
    .mockImplementation(async () =>
      Response.json({ tag_name: `v${version}`, draft: false, prerelease: false }),
    );
  vi.stubGlobal("fetch", fetch);
  return fetch;
};

describe("DesktopUpdates notification-only source builds", () => {
  it.effect("checks on startup and after six hours without using the native updater", () => {
    const fetch = stubRelease("0.0.46");
    const harness = notificationHarness();
    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        const { changes } = yield* updates.subscribe;
        const notices = yield* Queue.unbounded<string | null>();
        yield* changes.pipe(
          Stream.filter((state) => state.status === "available"),
          Stream.runForEach((state) => Queue.offer(notices, state.availableVersion)),
          Effect.forkChild,
        );
        assert.equal(fetch.mock.calls.length, 0);
        yield* TestClock.adjust("15 seconds");
        assert.equal(yield* Queue.take(notices), "0.0.46");
        assert.equal(fetch.mock.calls.length, 1);
        yield* TestClock.adjust("6 hours");
        assert.equal(yield* Queue.take(notices), "0.0.46");
        assert.equal(fetch.mock.calls.length, 2);
        assert.equal(harness.checkCount(), 0);
        assert.equal(harness.downloadCount(), 0);
        assert.equal(harness.quitAndInstalls(), 0);
      }),
    ).pipe(
      Effect.provide(Layer.merge(TestClock.layer(), harness.layer)),
      Effect.provideService(FetchHttpClient.Fetch, fetch),
    );
  });

  it.effect("disables malformed source versions without fetching release metadata", () => {
    const fetch = stubRelease("0.0.46");
    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        assert.isTrue(Option.isSome(yield* updates.disabledReason));
        const result = yield* updates.check("menu");
        assert.isFalse(result.checked);
        assert.equal(result.state.status, "disabled");
        assert.equal(fetch.mock.calls.length, 0);
      }),
    ).pipe(
      Effect.provide(
        notificationHarness({ T3CODE_UPDATE_NOTIFY_ONLY_VERSION: "not-a-version" }).layer,
      ),
      Effect.provideService(FetchHttpClient.Fetch, fetch),
    );
  });

  it.effect(
    "checks in unpackaged builds, reports the source version, and refuses every installation path",
    () => {
      const fetch = stubRelease("0.0.46");
      const harness = notificationHarness();
      return Effect.scoped(
        Effect.gen(function* () {
          const updates = yield* DesktopUpdates.DesktopUpdates;
          yield* updates.configure;
          assert.isTrue(Option.isNone(yield* updates.disabledReason));
          const result = yield* updates.check("menu");
          assert.isTrue(result.checked);
          assert.equal(result.state.currentVersion, "0.0.45");
          assert.equal(result.state.availableVersion, "0.0.46");
          assert.equal(result.state.status, "available");
          assert.isTrue(result.state.notifyOnly);
          assert.equal((yield* updates.setChannel("nightly")).channel, "latest");
          assert.isFalse((yield* updates.download).accepted);
          assert.isFalse((yield* updates.install).accepted);
          assert.isFalse((yield* updates.installPrepared("0.0.46")).accepted);
          assert.isFalse(harness.autoDownload());
          assert.isFalse(harness.autoInstallOnAppQuit());
          assert.equal(harness.listenerCount(), 0);
          assert.equal(harness.checkCount(), 0);
          assert.equal(harness.downloadCount(), 0);
          assert.equal(harness.quitAndInstalls(), 0);
          assert.deepEqual(harness.installSteps, []);
          assert.equal(fetch.mock.calls.length, 1);
        }),
      ).pipe(Effect.provide(harness.layer), Effect.provideService(FetchHttpClient.Fetch, fetch));
    },
  );

  it.effect("does not show the source tag itself as an update", () => {
    const fetch = stubRelease("0.0.45");
    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        assert.equal((yield* updates.check("menu")).state.status, "up-to-date");
      }),
    ).pipe(
      Effect.provide(notificationHarness().layer),
      Effect.provideService(FetchHttpClient.Fetch, fetch),
    );
  });

  it.effect("keeps failures visible and allows a later successful check", () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 403 }))
      .mockResolvedValueOnce(
        Response.json({ tag_name: "v0.0.46", draft: false, prerelease: false }),
      );
    vi.stubGlobal("fetch", fetch);
    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        const failed = yield* updates.check("menu");
        assert.equal(failed.state.status, "error");
        assert.include(failed.state.message, "HTTP 403");
        assert.equal((yield* updates.check("menu")).state.status, "available");
      }),
    ).pipe(
      Effect.provide(notificationHarness().layer),
      Effect.provideService(FetchHttpClient.Fetch, fetch),
    );
  });

  it.effect("honors the disable switch without enabling native auto-install", () => {
    const fetch = stubRelease("0.0.46");
    const harness = notificationHarness({ T3CODE_DISABLE_AUTO_UPDATE: "true" });
    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        assert.equal((yield* updates.check("menu")).state.status, "disabled");
        assert.equal(fetch.mock.calls.length, 0);
        assert.isFalse(harness.autoDownload());
        assert.isFalse(harness.autoInstallOnAppQuit());
      }),
    ).pipe(Effect.provide(harness.layer), Effect.provideService(FetchHttpClient.Fetch, fetch));
  });
});
