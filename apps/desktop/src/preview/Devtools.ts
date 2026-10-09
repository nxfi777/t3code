import * as NodeCrypto from "node:crypto";
import {
  PREVIEW_ARTIFACT_CHUNK_BYTES,
  PREVIEW_TRACE_MAX_BYTES,
  type PreviewDevtoolsInput,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

export class PreviewDevtoolsError extends Schema.TaggedError<PreviewDevtoolsError>()(
  "PreviewDevtoolsError",
  { detail: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {
  override get message() {
    return this.detail;
  }
}

type Send = (method: string, params?: Record<string, unknown>) => Effect.Effect<unknown, Error>;
const isPreviewDevtoolsError = Schema.is(PreviewDevtoolsError);
const encodeJsonResult = Schema.encodeUnknownEffect(Schema.Json);
// RPC's JSON codec rejects nested undefined, unlike JSON.stringify. CDP omits
// optional metadata on inline and user-agent styles; do not reintroduce it.
function omitUndefined(value: unknown): unknown {
  if (Array.isArray(value))
    return value.map((entry) => (entry === undefined ? null : omitUndefined(entry)));
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .map(([key, entry]) => [key, omitUndefined(entry)]),
  );
}
const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
const text = (value: unknown, max = 2048) => String(value ?? "").slice(0, max);
const number = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;
const items = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const sensitiveHeader =
  /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key|x-auth-token)$/i;
export function redactHeaders(value: unknown) {
  let remaining = 8192;
  return Object.fromEntries(
    Object.entries(record(value))
      .slice(0, 60)
      .flatMap(([key, value]) => {
        if (remaining <= 0) return [];
        const result = sensitiveHeader.test(key)
          ? "[redacted]"
          : text(value, Math.min(1024, remaining));
        remaining -= key.length + result.length;
        return [[text(key, 128), result]];
      }),
  );
}

type RequestEntry = {
  id: string;
  cdpId: string;
  url: string;
  method: string;
  type: string;
  status: number | null;
  failed: boolean;
  finished: boolean;
  error?: string;
  startedAt: number;
  durationMs?: number;
  encodedBytes?: number;
  mimeType?: string;
  requestHeaders: Record<string, string>;
  responseHeaders: Record<string, string>;
  timing?: Record<string, number>;
  fromCache?: boolean;
};
type ConsoleEntry = { id: number; level: string; text: string; stack?: string; timestamp: number };

/** Only bounded metadata is retained. Bodies remain in Chromium's bounded network buffer. */
export class Diagnostics {
  readonly stylesheets = new Map<string, string>();
  readonly requests = new Map<string, RequestEntry>();
  readonly current = new Map<string, string>();
  readonly console: ConsoleEntry[] = [];
  readonly prefix = NodeCrypto.randomUUID();
  sequence = 0;
  capture(method: string, params: Record<string, unknown>) {
    if (method === "CSS.styleSheetAdded") {
      const header = record(params.header);
      this.stylesheets.set(text(header.styleSheetId, 128), text(header.sourceURL));
      if (this.stylesheets.size > 100)
        this.stylesheets.delete(this.stylesheets.keys().next().value!);
      return;
    }
    if (method === "CSS.styleSheetRemoved") {
      this.stylesheets.delete(text(params.styleSheetId, 128));
      return;
    }
    if (
      method === "Runtime.consoleAPICalled" ||
      method === "Runtime.exceptionThrown" ||
      method === "Log.entryAdded"
    ) {
      const detail = record(params.exceptionDetails);
      const entry = record(params.entry);
      const exception = record(detail.exception);
      const value =
        method === "Runtime.consoleAPICalled"
          ? items(params.args)
              .map((arg) => {
                const a = record(arg);
                return text(a.value ?? a.description, 512);
              })
              .join(" ")
          : (exception.description ?? detail.text ?? entry.text);
      const frames = items(
        record(params.stackTrace ?? detail.stackTrace ?? entry.stackTrace).callFrames,
      );
      this.console.push({
        id: ++this.sequence,
        level:
          method === "Runtime.exceptionThrown"
            ? "error"
            : text(params.type ?? entry.level ?? "log", 24),
        text: text(value, 4096),
        ...(frames.length
          ? {
              stack: frames
                .slice(0, 8)
                .map((frame) => {
                  const f = record(frame);
                  return `${text(f.functionName, 80)} ${text(f.url, 200)}:${number(f.lineNumber) + 1}:${number(f.columnNumber) + 1}`;
                })
                .join("\n"),
            }
          : {}),
        timestamp: number(params.timestamp ?? entry.timestamp),
      });
      if (this.console.length > 200) this.console.shift();
      return;
    }
    const cdpId = text(params.requestId, 256);
    if (!cdpId) return;
    let entry = this.requests.get(this.current.get(cdpId) ?? "");
    if (method === "Network.requestWillBeSent") {
      if (entry && params.redirectResponse) {
        entry.status = number(record(params.redirectResponse).status);
        entry.responseHeaders = redactHeaders(record(params.redirectResponse).headers);
        entry.finished = true;
        entry.durationMs = Math.max(0, (number(params.timestamp) - entry.startedAt) * 1000);
      }
      const request = record(params.request);
      const id = `${this.prefix}:${++this.sequence}`;
      entry = {
        id,
        cdpId,
        url: text(request.url),
        method: text(request.method, 20),
        type: text(params.type, 32),
        status: null,
        failed: false,
        finished: false,
        startedAt: number(params.timestamp),
        requestHeaders: redactHeaders(request.headers),
        responseHeaders: {},
      };
      this.current.set(cdpId, id);
      this.requests.set(id, entry);
      if (this.requests.size > 100) {
        const oldest = this.requests.keys().next().value!;
        const removed = this.requests.get(oldest)!;
        this.requests.delete(oldest);
        if (this.current.get(removed.cdpId) === oldest) this.current.delete(removed.cdpId);
      }
    } else if (entry && method === "Network.responseReceived") {
      const response = record(params.response);
      entry.status = number(response.status);
      entry.failed = entry.status >= 400;
      entry.responseHeaders = redactHeaders(response.headers);
      entry.mimeType = text(response.mimeType, 128);
      entry.fromCache = response.fromDiskCache === true || response.fromServiceWorker === true;
      entry.timing = Object.fromEntries(
        Object.entries(record(response.timing)).filter(([, value]) => typeof value === "number"),
      ) as Record<string, number>;
    } else if (
      entry &&
      (method === "Network.loadingFinished" || method === "Network.loadingFailed")
    ) {
      entry.finished = true;
      entry.durationMs = Math.max(0, (number(params.timestamp) - entry.startedAt) * 1000);
      entry.encodedBytes = number(params.encodedDataLength);
      if (method === "Network.loadingFailed") {
        entry.failed = true;
        entry.error = text(params.errorText);
      }
    }
  }
}

type Trace = {
  startedAt: number;
  endedAt?: number;
  durationSeconds: number;
  ending: boolean;
  complete: Deferred.Deferred<{ stream: string; dataLossOccurred: boolean }>;
};
type Artifact = { owner: number; path: string; sizeBytes: number; createdAt: number };
const NETWORKS = {
  none: { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 },
  "fast-4g": {
    offline: false,
    latency: 40,
    downloadThroughput: 4_000_000 / 8,
    uploadThroughput: 3_000_000 / 8,
  },
  "slow-4g": {
    offline: false,
    latency: 150,
    downloadThroughput: 1_600_000 / 8,
    uploadThroughput: 750_000 / 8,
  },
  "3g": {
    offline: false,
    latency: 400,
    downloadThroughput: 400_000 / 8,
    uploadThroughput: 400_000 / 8,
  },
  offline: { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 },
} as const;
const DEFAULT_PROPERTIES = [
  "display",
  "position",
  "width",
  "height",
  "min-width",
  "max-width",
  "min-height",
  "max-height",
  "box-sizing",
  "margin-top",
  "margin-right",
  "margin-bottom",
  "margin-left",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "color",
  "background-color",
  "font-family",
  "font-size",
  "font-weight",
  "line-height",
  "text-transform",
  "opacity",
  "visibility",
  "overflow-x",
  "overflow-y",
  "z-index",
  "transform",
  "transition",
  "animation-name",
  "flex-direction",
  "align-items",
  "justify-content",
  "gap",
  "grid-template-columns",
];

export const make = Effect.fn("PreviewDevtools.make")(function* (directory: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const scope = yield* Scope.Scope;
  const diagnostics = new Map<number, Diagnostics>();
  const traces = new Map<number, Trace>();
  const artifacts = new Map<string, Artifact>();
  const emulation = new Map<number, { cpuRate: number; network: keyof typeof NETWORKS }>();
  const get = (owner: number) => {
    let value = diagnostics.get(owner);
    if (!value) {
      value = new Diagnostics();
      diagnostics.set(owner, value);
    }
    return value;
  };
  const capture = (owner: number, method: string, params: Record<string, unknown>) =>
    Effect.gen(function* () {
      const state = diagnostics.get(owner);
      if (!state) return;
      state.capture(method, params);
      const trace = traces.get(owner);
      if (trace && method === "Tracing.tracingComplete") {
        trace.endedAt = yield* Clock.currentTimeMillis;
        yield* Deferred.succeed(trace.complete, {
          stream: text(params.stream, 256),
          dataLossOccurred: params.dataLossOccurred === true,
        });
      }
    });
  const reset = (owner: number, send: Send) =>
    Effect.gen(function* () {
      const cpu = yield* Effect.exit(send("Emulation.setCPUThrottlingRate", { rate: 1 }));
      const network = yield* Effect.exit(send("Network.emulateNetworkConditions", NETWORKS.none));
      if (Exit.isFailure(cpu)) return yield* Effect.failCause(cpu.cause);
      if (Exit.isFailure(network)) return yield* Effect.failCause(network.cause);
      emulation.delete(owner);
    });
  const detach = (owner: number, send: Send) =>
    Effect.gen(function* () {
      const trace = traces.get(owner);
      if (trace) {
        if (!trace.ending) yield* send("Tracing.end").pipe(Effect.ignore);
        // Detaching destroys unfinished Chromium streams; fail any awaiting stop.
        yield* Deferred.interrupt(trace.complete);
        traces.delete(owner);
      }
      if (emulation.has(owner)) yield* reset(owner, send).pipe(Effect.ignore);
      emulation.delete(owner);
      diagnostics.delete(owner);
      for (const [id, artifact] of artifacts)
        if (artifact.owner === owner) {
          artifacts.delete(id);
          yield* fs.remove(artifact.path).pipe(Effect.ignore);
        }
    });
  const memory = (send: Send) =>
    Effect.gen(function* () {
      yield* send("Performance.enable");
      const heap = yield* send("Runtime.getHeapUsage");
      const dom = yield* send("Memory.getDOMCounters");
      const metrics = yield* send("Performance.getMetrics");
      return {
        heap,
        dom,
        metrics: items(record(metrics).metrics),
        note: "Point-in-time counters, not a heap snapshot. Repeat after the same interactions to compare retained growth.",
      };
    });

  const run = Effect.fn("PreviewDevtools.run")(
    function* (owner: number, input: PreviewDevtoolsInput, send: Send, cleanup: Send = send) {
      const state = get(owner);
      switch (input.action) {
        case "console": {
          const entries = state.console.filter(
            (entry) =>
              entry.id > (input.afterId ?? 0) &&
              (!input.level ||
                input.level === "all" ||
                entry.level === input.level ||
                (input.level === "warn" && entry.level === "warning")),
          );
          return {
            entries: entries.slice(-(input.limit ?? 50)),
            retained: state.console.length,
            lastId: state.sequence,
            truncated: entries.length > (input.limit ?? 50),
          };
        }
        case "network": {
          const entries = [...state.requests.values()].filter(
            (entry) =>
              (!input.urlIncludes || entry.url.includes(input.urlIncludes)) &&
              (!input.failedOnly || entry.failed),
          );
          return {
            entries: entries
              .slice(-(input.limit ?? 50))
              .map(
                ({
                  cdpId: _cdpId,
                  requestHeaders: _r,
                  responseHeaders: _s,
                  timing: _t,
                  ...entry
                }) => entry,
              ),
            retained: state.requests.size,
            truncated: entries.length > (input.limit ?? 50),
          };
        }
        case "request": {
          const entry = state.requests.get(input.requestId);
          if (!entry)
            return yield* new PreviewDevtoolsError({
              detail: "Request is unavailable or was evicted. List network requests again.",
            });
          const detail = Object.fromEntries(
            Object.entries(entry).filter(([key]) => key !== "cdpId"),
          );
          if (!input.includeBody) return detail;
          if (!entry.finished || state.current.get(entry.cdpId) !== entry.id)
            return {
              ...detail,
              bodyUnavailable: "Request is unfinished or is an earlier redirect.",
            };
          if (
            !/^(text\/|application\/(json|javascript|xml|x-www-form-urlencoded|.*\+json|.*\+xml))/i.test(
              entry.mimeType ?? "",
            )
          )
            return { ...detail, bodyUnavailable: "Only text response bodies are exposed." };
          const response = yield* send("Network.getResponseBody", { requestId: entry.cdpId }).pipe(
            Effect.option,
          );
          if (Option.isNone(response))
            return {
              ...detail,
              bodyUnavailable: "Body was evicted or is unavailable from Chromium.",
            };
          const body = record(response.value);
          const bytes = Buffer.from(
            text(body.body, 128 * 1024),
            body.base64Encoded === true ? "base64" : "utf8",
          );
          return {
            ...detail,
            body: bytes.subarray(0, 64 * 1024).toString("utf8"),
            bodyTruncated: bytes.length > 64 * 1024,
          };
        }
        case "styles": {
          const request = (method: string, params?: Record<string, unknown>) =>
            send(method, params).pipe(
              Effect.timeoutOption("4 seconds"),
              Effect.flatMap((result) =>
                Option.isSome(result)
                  ? Effect.succeed(result.value)
                  : Effect.fail(
                      new PreviewDevtoolsError({
                        detail: `${method} did not respond within 4 seconds. Reload the preview and try again.`,
                      }),
                    ),
              ),
            );
          yield* request("DOM.enable");
          yield* request("CSS.enable");
          const document = record(yield* request("DOM.getDocument", { depth: 0 }));
          const node = record(
            yield* request("DOM.querySelector", {
              nodeId: record(document.root).nodeId,
              selector: input.selector,
            }),
          );
          if (!number(node.nodeId))
            return yield* new PreviewDevtoolsError({
              detail: "CSS selector did not match an element in the main document.",
            });
          const computed = record(
            yield* request("CSS.getComputedStyleForNode", { nodeId: node.nodeId }),
          );
          const matched = record(
            yield* request("CSS.getMatchedStylesForNode", { nodeId: node.nodeId }),
          );
          let budget = 48 * 1024;
          let truncated = false;
          const clip = (value: unknown, max: number) => {
            const result = text(value, Math.min(max, Math.max(0, budget)));
            truncated ||= String(value ?? "").length > result.length;
            budget -= result.length;
            return result;
          };
          const style = (value: unknown) => {
            const s = record(value);
            truncated ||= items(s.cssProperties).length > 40;
            return {
              styleSheetId: s.styleSheetId,
              sourceUrl: state.stylesheets.get(text(s.styleSheetId, 128)),
              range: s.range,
              properties: items(s.cssProperties)
                .slice(0, 40)
                .map((property) => {
                  const p = record(property);
                  return {
                    name: clip(p.name, 128),
                    value: clip(p.value, 512),
                    important: p.important === true,
                    disabled: p.disabled === true,
                    implicit: p.implicit === true,
                    parsedOk: p.parsedOk !== false,
                  };
                }),
            };
          };
          const rules = (value: unknown, limit: number) => {
            truncated ||= items(value).length > limit;
            return items(value)
              .slice(-limit)
              .map((match) => {
                const r = record(record(match).rule);
                return {
                  selector: clip(record(r.selectorList).text, 512),
                  origin: r.origin,
                  style: style(r.style),
                  matchingSelectors: record(match).matchingSelectors,
                };
              });
          };
          const wanted = input.properties?.length ? input.properties : DEFAULT_PROPERTIES;
          const properties = items(computed.computedStyle).filter((property) =>
            wanted.includes(String(record(property).name)),
          );
          return {
            selector: input.selector,
            computed: properties.slice(0, 60).map((property) => ({
              name: clip(record(property).name, 128),
              value: clip(record(property).value, 512),
            })),
            inline: style(matched.inlineStyle),
            attributes: style(matched.attributesStyle),
            matched: rules(matched.matchedCSSRules, 15),
            inherited: items(matched.inherited)
              .slice(0, 3)
              .map((ancestor) => ({
                inline: style(record(ancestor).inlineStyle),
                matched: rules(record(ancestor).matchedCSSRules, 3),
              })),
            truncated:
              truncated ||
              budget <= 0 ||
              properties.length > 60 ||
              items(matched.inherited).length > 3,
            note: "CDP matched rules and declaration metadata; main-document CSS selectors only. This is not a computed cascade winner classification.",
          };
        }
        case "emulate": {
          const previous = emulation.get(owner) ?? { cpuRate: 1, network: "none" as const };
          const next = input.reset
            ? { cpuRate: 1, network: "none" as const }
            : {
                cpuRate: input.cpuRate ?? previous.cpuRate,
                network: input.network ?? previous.network,
              };
          yield* Effect.gen(function* () {
            emulation.set(owner, next);
            yield* send("Emulation.setCPUThrottlingRate", { rate: next.cpuRate });
            yield* send("Network.emulateNetworkConditions", NETWORKS[next.network]);
            emulation.set(owner, next);
          }).pipe(Effect.onError(() => reset(owner, cleanup).pipe(Effect.ignore)));
          return next;
        }
        case "memory":
          return yield* memory(send);
        case "traceStart": {
          if (artifacts.size >= 8)
            return yield* new PreviewDevtoolsError({
              detail:
                "Too many unclaimed trace artifacts. Complete their transfers or wait five minutes before recording again.",
            });
          if (traces.has(owner))
            return yield* new PreviewDevtoolsError({
              detail: "A trace is already active for this tab. Stop it first.",
            });
          const trace: Trace = {
            startedAt: yield* Clock.currentTimeMillis,
            durationSeconds: input.durationSeconds ?? 20,
            ending: false,
            complete: yield* Deferred.make<{ stream: string; dataLossOccurred: boolean }>(),
          };
          traces.set(owner, trace);
          yield* cleanup("Tracing.start", {
            transferMode: "ReturnAsStream",
            streamFormat: "json",
            traceConfig: {
              recordMode: "recordUntilFull",
              traceBufferSizeInKb: 4096,
              enableSampling: true,
              includedCategories: [
                "devtools.timeline",
                "v8.execute",
                "blink.user_timing",
                "loading",
                "disabled-by-default-devtools.timeline",
                "disabled-by-default-v8.cpu_profiler",
              ],
            },
          }).pipe(
            Effect.onError(() =>
              Effect.sync(() => {
                traces.delete(owner);
              }),
            ),
          );
          yield* Effect.sleep(`${trace.durationSeconds} seconds`).pipe(
            Effect.andThen(
              Effect.gen(function* () {
                if (traces.get(owner) !== trace || trace.ending) return;
                trace.ending = true;
                yield* cleanup("Tracing.end").pipe(Effect.ignore);
              }),
            ),
            Effect.forkIn(scope),
          );
          return {
            recording: true,
            durationSeconds: trace.durationSeconds,
            bufferBytes: 4 * 1024 * 1024,
            maxArtifactBytes: PREVIEW_TRACE_MAX_BYTES,
          };
        }
        case "traceStop": {
          const trace = traces.get(owner);
          if (!trace)
            return yield* new PreviewDevtoolsError({ detail: "No trace is active for this tab." });
          if (!trace.ending) {
            trace.ending = true;
            yield* cleanup("Tracing.end");
          }
          const completed = yield* Deferred.await(trace.complete).pipe(
            Effect.timeoutOption("10 seconds"),
          );
          if (Option.isNone(completed) || !completed.value.stream)
            return yield* new PreviewDevtoolsError({
              detail: "Chromium did not finish the trace. Close the preview tab to release it.",
            });
          const stream = completed.value.stream;
          const id = NodeCrypto.randomUUID();
          const filePath = path.join(directory, `trace-${id}.json`);
          let sizeBytes = 0;
          yield* Effect.scoped(
            Effect.gen(function* () {
              yield* fs.makeDirectory(directory, { recursive: true });
              const file = yield* fs.open(filePath, { flag: "wx" });
              for (;;) {
                const chunk = record(
                  yield* send("IO.read", { handle: stream, size: PREVIEW_ARTIFACT_CHUNK_BYTES }),
                );
                const bytes = Buffer.from(
                  String(chunk.data ?? ""),
                  chunk.base64Encoded === true ? "base64" : "utf8",
                );
                sizeBytes += bytes.length;
                if (sizeBytes > PREVIEW_TRACE_MAX_BYTES)
                  return yield* new PreviewDevtoolsError({
                    detail: "Trace exceeded the 16 MiB artifact limit. Record a shorter interval.",
                  });
                yield* file.writeAll(bytes);
                if (chunk.eof === true) break;
                if (!bytes.length)
                  return yield* new PreviewDevtoolsError({
                    detail: "Chromium returned an empty unfinished trace stream.",
                  });
              }
            }),
          ).pipe(
            Effect.ensuring(cleanup("IO.close", { handle: stream }).pipe(Effect.ignore)),
            Effect.ensuring(
              Effect.sync(() => {
                traces.delete(owner);
              }),
            ),
            Effect.onError(() => fs.remove(filePath).pipe(Effect.ignore)),
          );
          artifacts.set(id, {
            owner,
            path: filePath,
            sizeBytes,
            createdAt: yield* Clock.currentTimeMillis,
          });
          // An abandoned transfer must not accumulate files or retained capabilities.
          yield* Effect.sleep("5 minutes").pipe(
            Effect.andThen(
              Effect.gen(function* () {
                const artifact = artifacts.get(id);
                if (!artifact) return;
                artifacts.delete(id);
                yield* fs.remove(artifact.path).pipe(Effect.ignore);
              }),
            ),
            Effect.forkIn(scope),
          );
          return {
            artifactId: id,
            sizeBytes,
            mimeType: "application/json" as const,
            dataLossOccurred: completed.value.dataLossOccurred,
            durationMs: (trace.endedAt ?? (yield* Clock.currentTimeMillis)) - trace.startedAt,
          };
        }
        case "artifactRead": {
          const artifact = artifacts.get(input.artifactId);
          if (!artifact || artifact.owner !== owner || input.offset > artifact.sizeBytes)
            return yield* new PreviewDevtoolsError({
              detail: "Trace artifact is unavailable for this tab.",
            });
          return yield* Effect.scoped(
            Effect.gen(function* () {
              const file = yield* fs.open(artifact.path, { flag: "r" });
              yield* file.seek(BigInt(input.offset), "start");
              const bytes = yield* file.readAlloc(
                Math.min(PREVIEW_ARTIFACT_CHUNK_BYTES, artifact.sizeBytes - input.offset),
              );
              const data = Option.isSome(bytes) ? bytes.value : new Uint8Array();
              return {
                data: Buffer.from(data).toString("base64"),
                nextOffset: input.offset + data.length,
                eof: input.offset + data.length === artifact.sizeBytes,
              };
            }),
          );
        }
        case "artifactDelete": {
          const artifact = artifacts.get(input.artifactId);
          if (artifact?.owner === owner) {
            artifacts.delete(input.artifactId);
            yield* fs.remove(artifact.path).pipe(Effect.ignore);
          }
          return { deleted: true };
        }
      }
    },
    Effect.map(omitUndefined),
    Effect.flatMap(encodeJsonResult),
    Effect.mapError((cause) =>
      isPreviewDevtoolsError(cause)
        ? cause
        : new PreviewDevtoolsError({ detail: "Browser DevTools operation failed.", cause }),
    ),
  );
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      for (const artifact of artifacts.values())
        yield* fs.remove(artifact.path).pipe(Effect.ignore);
      artifacts.clear();
      diagnostics.clear();
    }),
  );
  return {
    attach: (owner: number) =>
      Effect.sync(() => {
        get(owner);
      }),
    capture,
    detach,
    run,
  };
});
