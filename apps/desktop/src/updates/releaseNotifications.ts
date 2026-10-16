import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Schedule from "effect/Schedule";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";

export const UPSTREAM_RELEASE_URL = "https://api.github.com/repos/pingdotgg/t3code/releases/latest";

const Release = Schema.Struct({
  tag_name: Schema.String,
  draft: Schema.Boolean,
  prerelease: Schema.Boolean,
});
const decodeRelease = Schema.decodeUnknownSync(Release);

// This mode follows stable releases only, using the source release rather than
// package.json (which may still contain the previous release's version).
export function stableVersion(value: string): string | null {
  const version = value.replace(/^v/, "");
  return /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version) &&
    version.split(".").every((part) => Number.isSafeInteger(Number(part)))
    ? version
    : null;
}

export function newerStableRelease(raw: unknown, baseVersion: string): string | null {
  const base = stableVersion(baseVersion);
  if (!base) throw new Error("Update notifications require a stable source version.");
  const release = decodeRelease(raw);
  if (release.draft || release.prerelease) throw new Error("Expected a published stable release.");
  const version = stableVersion(release.tag_name);
  if (!version) throw new Error("The latest release has an invalid stable version.");
  const current = base.split(".").map(Number);
  const candidate = version.split(".").map(Number);
  for (let index = 0; index < 3; index++) {
    if (candidate[index]! > current[index]!) return version;
    if (candidate[index]! < current[index]!) return null;
  }
  return null;
}

class ReleaseNotificationError extends Schema.TaggedError<ReleaseNotificationError>()(
  "ReleaseNotificationError",
  { detail: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Could not check for T3 Code releases: ${this.detail}`;
  }
}

export const checkReleaseNotification = (baseVersion: string) =>
  Effect.gen(function* () {
    const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);
    const raw = yield* client
      .get(UPSTREAM_RELEASE_URL, {
        headers: { Accept: "application/vnd.github+json" },
      })
      .pipe(
        Effect.flatMap((response) => response.json),
        Effect.timeout("15 seconds"),
        Effect.retry({
          times: 2,
          schedule: Schedule.exponential("1 second").pipe(Schedule.jittered),
          while: (error) =>
            error._tag === "TimeoutError" ||
            (error._tag === "HttpClientError" &&
              (error.reason._tag === "TransportError" ||
                (error.response !== undefined &&
                  (error.response.status === 429 || error.response.status >= 500)))),
        }),
        Effect.mapError(
          (cause) =>
            new ReleaseNotificationError({
              detail:
                cause._tag === "HttpClientError" &&
                cause.reason._tag === "StatusCodeError" &&
                cause.response
                  ? `GitHub release check failed (HTTP ${cause.response.status}).`
                  : cause.message,
              cause,
            }),
        ),
      );
    return yield* Effect.try({
      try: () => newerStableRelease(raw, baseVersion),
      catch: (cause) =>
        new ReleaseNotificationError({
          detail: "GitHub returned invalid release metadata.",
          cause,
        }),
    });
  }).pipe(Effect.provide(FetchHttpClient.layer));
