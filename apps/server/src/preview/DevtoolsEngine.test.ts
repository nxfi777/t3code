import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import { expect, it, vi } from "vite-plus/test";
import {
  PreviewTraceArtifact,
  PreviewArtifactChunk,
  PreviewAutomationResponse,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as Devtools from "./DevtoolsEngine.ts";

const artifact = Schema.decodeUnknownSync(PreviewTraceArtifact);
const chunk = Schema.decodeUnknownSync(PreviewArtifactChunk);
const encodeBrokerResponse = Schema.encodeUnknownSync(
  Schema.toCodecJson(PreviewAutomationResponse),
);

it("retains successful requests and redirects with stable IDs and bounded, redacted metadata", () => {
  const diagnostics = new Devtools.Diagnostics("test-diagnostics");
  const headers = {
    Authorization: "secret",
    Cookie: "session",
    "Set-Cookie": "token",
    "X-Api-Key": "private",
    Accept: "application/json",
  };
  diagnostics.capture("Network.requestWillBeSent", {
    requestId: "1",
    timestamp: 1,
    request: { url: "https://example.test/start", method: "GET", headers },
  });
  const first = [...diagnostics.requests.values()][0]!;
  diagnostics.capture("Network.requestWillBeSent", {
    requestId: "1",
    timestamp: 2,
    redirectResponse: { status: 302, headers },
    request: { url: "https://example.test/end", method: "GET" },
  });
  diagnostics.capture("Network.responseReceived", {
    requestId: "1",
    response: { status: 200, mimeType: "application/json", headers },
  });
  diagnostics.capture("Network.loadingFinished", {
    requestId: "1",
    timestamp: 3,
    encodedDataLength: 10,
  });
  const second = [...diagnostics.requests.values()][1]!;
  expect(first.status).toBe(302);
  expect(first.finished).toBe(true);
  expect(second.id).not.toBe(first.id);
  expect(second).toMatchObject({
    status: 200,
    failed: false,
    finished: true,
    durationMs: 1000,
    encodedBytes: 10,
  });
  expect(second.responseHeaders).toEqual({
    Authorization: "[redacted]",
    Cookie: "[redacted]",
    "Set-Cookie": "[redacted]",
    "X-Api-Key": "[redacted]",
    Accept: "application/json",
  });
  for (let i = 0; i < 300; i++) {
    diagnostics.capture("Runtime.consoleAPICalled", {
      type: "log",
      args: [{ value: "x".repeat(5000) }],
    });
    diagnostics.capture("Network.requestWillBeSent", {
      requestId: `r${i}`,
      request: { url: `https://example.test/${i}` },
    });
  }
  expect(diagnostics.console).toHaveLength(200);
  expect(diagnostics.console[0]!.text.length).toBeLessThanOrEqual(4096);
  expect(diagnostics.requests.size).toBe(100);
  expect(diagnostics.current.size).toBe(100);
});

effectIt.effect("exports trace chunks only to the owning tab and deletes them on release", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped();
      const service = yield* Devtools.make(directory);
      const trace = '{"traceEvents":[]}';
      const send = vi.fn((method: string) => {
        if (method === "Tracing.end")
          return service.capture(1, "Tracing.tracingComplete", {
            stream: "stream-1",
            dataLossOccurred: false,
          });
        if (method === "IO.read") return Effect.succeed({ data: trace, eof: true });
        return Effect.succeed({});
      });
      yield* service.run(1, { action: "traceStart", durationSeconds: 1 }, send);
      yield* TestClock.adjust("1 second");
      const saved = artifact(yield* service.run(1, { action: "traceStop" }, send));
      const foreign = yield* service
        .run(2, { action: "artifactRead", artifactId: saved.artifactId, offset: 0 }, send)
        .pipe(Effect.flip);
      expect(foreign.detail).toContain("unavailable for this tab");
      const read = chunk(
        yield* service.run(
          1,
          { action: "artifactRead", artifactId: saved.artifactId, offset: 0 },
          send,
        ),
      );
      expect(Buffer.from(read.data, "base64").toString()).toBe(trace);
      expect(read.eof).toBe(true);
      expect(send.mock.calls.filter(([method]) => method === "Tracing.end")).toHaveLength(1);
      yield* service.run(1, { action: "artifactDelete", artifactId: saved.artifactId }, send);
      expect(yield* fs.readDirectory(directory)).toEqual([]);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

effectIt.effect(
  "encodes CSS with missing inline and user-agent metadata in the real broker response",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const service = yield* Devtools.make(yield* fs.makeTempDirectoryScoped());
        const send = (method: string) =>
          Effect.succeed(
            method === "DOM.getDocument"
              ? { root: { nodeId: 1 } }
              : method === "DOM.querySelector"
                ? { nodeId: 2 }
                : method === "CSS.getComputedStyleForNode"
                  ? { computedStyle: [{ name: "color", value: "rgb(18, 52, 86)" }] }
                  : method === "CSS.getMatchedStylesForNode"
                    ? {
                        inlineStyle: { cssProperties: [{ name: "background", value: "white" }] },
                        matchedCSSRules: [
                          {
                            rule: {
                              origin: "user-agent",
                              selectorList: { text: "div" },
                              style: { cssProperties: [] },
                            },
                          },
                        ],
                        inherited: [{ inlineStyle: { cssProperties: [] } }],
                      }
                    : {},
          );
        const result = yield* service.run(
          1,
          { action: "styles", selector: "#probe", properties: ["color"] },
          send,
        );
        expect(() =>
          encodeBrokerResponse({
            clientId: "client",
            connectionId: "connection",
            requestId: "request",
            ok: true,
            result: { inline: { range: undefined } },
          }),
        ).toThrow();
        const encoded = encodeBrokerResponse({
          clientId: "client",
          connectionId: "connection",
          requestId: "request",
          ok: true,
          result,
        });
        expect(encoded).toMatchObject({
          result: {
            computed: [{ name: "color", value: "rgb(18, 52, 86)" }],
            matched: [{ origin: "user-agent", style: { properties: [] } }],
          },
        });
        expect(encoded).toEqual({
          clientId: "client",
          connectionId: "connection",
          requestId: "request",
          ok: true,
          result,
        });
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

effectIt.effect("reports the stalled CSS command before the broker deadline", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const service = yield* Devtools.make(yield* fs.makeTempDirectoryScoped());
      const pending = yield* service
        .run(1, { action: "styles", selector: "#probe" }, () => Effect.never)
        .pipe(Effect.result, Effect.forkChild);
      yield* TestClock.adjust("4 seconds");
      const outcome = yield* Fiber.join(pending);
      expect(outcome).toMatchObject({
        _tag: "Failure",
        failure: { detail: expect.stringContaining("DOM.enable") },
      });
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

effectIt.effect("restores CPU and network on failure and debugger detach", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const service = yield* Devtools.make(yield* fs.makeTempDirectoryScoped());
      const calls: Array<[string, Record<string, unknown> | undefined]> = [];
      const send = (method: string, params?: Record<string, unknown>) =>
        Effect.sync(() => {
          calls.push([method, params]);
        });
      yield* service.run(1, { action: "emulate", cpuRate: 4, network: "slow-4g" }, send);
      yield* service.detach(1, send);
      expect(calls.at(-2)).toEqual(["Emulation.setCPUThrottlingRate", { rate: 1 }]);
      expect(calls.at(-1)).toEqual([
        "Network.emulateNetworkConditions",
        { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 },
      ]);
      const failing = (method: string, params?: Record<string, unknown>) =>
        method === "Network.emulateNetworkConditions" && params?.offline === true
          ? Effect.fail(new Devtools.PreviewDevtoolsError({ detail: "offline setup failed" }))
          : send(method, params);
      yield* service
        .run(1, { action: "emulate", cpuRate: 6, network: "offline" }, failing)
        .pipe(Effect.flip);
      expect(calls.at(-2)).toEqual(["Emulation.setCPUThrottlingRate", { rate: 1 }]);
      expect(calls.at(-1)?.[1]?.offline).toBe(false);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

effectIt.effect("does not re-fetch missing bodies or expose an earlier redirect body", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const service = yield* Devtools.make(yield* fs.makeTempDirectoryScoped());
      const send = vi.fn((_method: string) =>
        Effect.fail(new Devtools.PreviewDevtoolsError({ detail: "not buffered" })),
      );
      yield* service.attach(1);
      yield* service.capture(1, "Network.requestWillBeSent", {
        requestId: "r",
        request: { url: "https://example.test", method: "GET" },
      });
      yield* service.capture(1, "Network.responseReceived", {
        requestId: "r",
        response: { status: 200, mimeType: "text/plain" },
      });
      yield* service.capture(1, "Network.loadingFinished", { requestId: "r" });
      const listed = yield* service.run(1, { action: "network" }, send);
      const requestId = (listed as { entries: Array<{ id: string }> }).entries[0]!.id;
      const details = yield* service.run(
        1,
        { action: "request", requestId, includeBody: true },
        send,
      );
      expect(details).toMatchObject({
        status: 200,
        bodyUnavailable: "Body was evicted or is unavailable from Chromium.",
      });
      expect(send.mock.calls).toEqual([["Network.getResponseBody", { requestId: "r" }]]);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);
