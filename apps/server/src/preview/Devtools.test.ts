import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, PreviewTabId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Broker from "../mcp/PreviewAutomationBroker.ts";
import * as ServerConfig from "../config.ts";
import * as Devtools from "./Devtools.ts";

const scope = {
  environmentId: EnvironmentId.make("environment"),
  thread: {
    threadId: ThreadId.make("thread"),
    providerSessionId: "session",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  requestNamespace: "devtools-test",
  capabilities: new Set(["preview"] as const),
  issuedAt: 1,
};
it.effect("turns bounded desktop diagnostics into actionable MCP failures", () => {
  const detail = "Request is unavailable or was evicted. List network requests again.";
  const dependencies = Layer.mergeAll(
    ServerConfig.layerTest(process.cwd(), { prefix: "t3-devtools-errors-" }),
    Layer.mock(Broker.PreviewAutomationBroker)({
      invoke: <A>() => Effect.succeed({ _tag: "PreviewDevtoolsFailure", detail } as A),
    }),
  ).pipe(Layer.provideMerge(NodeServices.layer));
  return Effect.gen(function* () {
    const service = yield* Devtools.PreviewDevtools;
    const result = yield* service
      .invoke(scope, { action: "request", requestId: "missing" })
      .pipe(Effect.match({ onFailure: (error) => error, onSuccess: () => undefined }));
    expect(result?._tag).toBe("PreviewDevtoolsCommandError");
    expect(result?.message).toBe(detail);
  }).pipe(Effect.provide(Devtools.layer.pipe(Layer.provideMerge(dependencies))));
});
it.effect.each([false, true])(
  "transfers bounded chunks and rejects inconsistent offsets=%s",
  (badOffset) => {
    const calls: Broker.PreviewAutomationInvokeInput[] = [];
    const data = Buffer.from('{"traceEvents":[]}');
    const tabId = PreviewTabId.make("trace-tab");
    const dependencies = Layer.mergeAll(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-trace-transfer-" }),
      Layer.mock(Broker.PreviewAutomationBroker)({
        invoke: <A>(input: Broker.PreviewAutomationInvokeInput) =>
          Effect.sync(() => {
            calls.push(input);
            expect(input.scope).toEqual(scope);
            const operation = input.input as { action: string; offset?: number };
            if (operation.action === "traceStop") {
              input.onTargetTab?.(tabId);
              return {
                artifactId: "trace",
                sizeBytes: data.length,
                mimeType: "application/json",
                dataLossOccurred: false,
                durationMs: 10,
              } as A;
            }
            expect(input.tabId).toBe(tabId);
            expect(input.updateCurrentTab).toBe(false);
            if (operation.action === "artifactDelete") return { deleted: true } as A;
            const offset = operation.offset!;
            const bytes = data.subarray(offset, offset + 7);
            return {
              data: bytes.toString("base64"),
              nextOffset: offset + bytes.length + (badOffset ? 1 : 0),
              eof: offset + bytes.length === data.length,
            } as A;
          }),
      }),
    ).pipe(Layer.provideMerge(NodeServices.layer));
    return Effect.gen(function* () {
      const service = yield* Devtools.PreviewDevtools;
      const fs = yield* FileSystem.FileSystem;
      const config = yield* ServerConfig.ServerConfig;
      if (badOffset) {
        const result = yield* service
          .invoke(scope, { action: "traceStop" })
          .pipe(Effect.match({ onFailure: (error) => error, onSuccess: () => undefined }));
        expect(result?._tag).toBe("PreviewDevtoolsTransferError");
        expect(yield* fs.readDirectory(config.browserArtifactsDir)).toEqual([]);
      } else {
        const result = yield* service.invoke(scope, { action: "traceStop" });
        expect(yield* fs.readFileString((result as { path: string }).path)).toBe(data.toString());
        expect(
          calls.filter((call) => (call.input as { action: string }).action === "artifactRead"),
        ).toHaveLength(3);
      }
      expect((calls.at(-1)!.input as { action: string }).action).toBe("artifactDelete");
    }).pipe(Effect.provide(Devtools.layer.pipe(Layer.provideMerge(dependencies))));
  },
);
