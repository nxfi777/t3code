import { describe, expect, it, afterEach, vi } from "vite-plus/test";
import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import {
  checkReleaseNotification,
  newerStableRelease,
  stableVersion,
  UPSTREAM_RELEASE_URL,
} from "./releaseNotifications.ts";

const release = (version: string) => ({ tag_name: `v${version}`, draft: false, prerelease: false });
afterEach(() => vi.unstubAllGlobals());

describe("stable release notifications", () => {
  it("compares numeric release components against the source version", () => {
    expect(newerStableRelease(release("0.0.45"), "v0.0.45")).toBeNull();
    expect(newerStableRelease(release("0.0.44"), "0.0.45")).toBeNull();
    expect(newerStableRelease(release("0.0.46"), "0.0.45")).toBe("0.0.46");
    expect(newerStableRelease(release("0.1.0"), "0.0.45")).toBe("0.1.0");
    expect(newerStableRelease(release("0.0.100"), "0.0.99")).toBe("0.0.100");
  });

  it("rejects invalid, draft and prerelease responses rather than claiming up-to-date", () => {
    expect(stableVersion("garbage")).toBeNull();
    expect(stableVersion("0.01.2")).toBeNull();
    expect(() => newerStableRelease({}, "0.0.45")).toThrow();
    expect(() => newerStableRelease({ ...release("0.0.46"), draft: true }, "0.0.45")).toThrow();
    expect(() =>
      newerStableRelease({ ...release("0.0.46"), prerelease: true }, "0.0.45"),
    ).toThrow();
    expect(() => newerStableRelease(release("0.0.46-nightly"), "0.0.45")).toThrow();
    expect(() => newerStableRelease(release("0.0.46"), "invalid")).toThrow();
  });

  effectIt.effect("only fetches public release metadata, without credentials or assets", () => {
    const fetch = vi.fn().mockResolvedValue(Response.json(release("0.0.46")));
    vi.stubGlobal("fetch", fetch);
    return Effect.gen(function* () {
      expect(yield* checkReleaseNotification("0.0.45")).toBe("0.0.46");
      expect(fetch).toHaveBeenCalledTimes(1);
      const [url, init] = fetch.mock.calls[0]!;
      expect(String(url)).toBe(UPSTREAM_RELEASE_URL);
      const headers = new Headers(init.headers);
      expect(headers.get("accept")).toBe("application/vnd.github+json");
      expect(headers.has("authorization")).toBe(false);
      expect(headers.has("cookie")).toBe(false);
      expect(init.signal).toBeInstanceOf(AbortSignal);
      expect(init.method).toBe("GET");
    }).pipe(Effect.provideService(FetchHttpClient.Fetch, fetch));
  });

  effectIt.effect("surfaces non-transient HTTP errors without retrying", () => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 403 }));
    vi.stubGlobal("fetch", fetch);
    return Effect.gen(function* () {
      const result = yield* checkReleaseNotification("0.0.45").pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") expect(result.failure.message).toContain("HTTP 403");
      expect(fetch).toHaveBeenCalledTimes(1);
    }).pipe(Effect.provideService(FetchHttpClient.Fetch, fetch));
  });
});
