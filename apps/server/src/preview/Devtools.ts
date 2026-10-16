import {
  PreviewArtifactChunk,
  PreviewTraceArtifact,
  PreviewDevtoolsTransferError,
  PreviewDevtoolsFailure,
  PreviewDevtoolsCommandError,
  type PreviewDevtoolsInput,
  type PreviewAutomationError,
  type PreviewTabId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ServerConfig from "../config.ts";
import * as Broker from "../mcp/PreviewAutomationBroker.ts";
import type { McpThreadInvocationScope } from "../mcp/McpInvocationContext.ts";

const decodeArtifact = Schema.decodeUnknownEffect(PreviewTraceArtifact);
const decodeChunk = Schema.decodeUnknownEffect(PreviewArtifactChunk);
const isDevtoolsFailure = Schema.is(PreviewDevtoolsFailure);

export class PreviewDevtools extends Context.Service<
  PreviewDevtools,
  {
    readonly invoke: (
      scope: McpThreadInvocationScope,
      input: PreviewDevtoolsInput,
    ) => Effect.Effect<
      unknown,
      PreviewAutomationError | PreviewDevtoolsTransferError | PreviewDevtoolsCommandError
    >;
  }
>()("t3/preview/Devtools/PreviewDevtools") {}

const make = Effect.gen(function* () {
  const broker = yield* Broker.PreviewAutomationBroker;
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const invoke = Effect.fn("PreviewDevtools.invoke")(function* (
    scope: McpThreadInvocationScope,
    input: PreviewDevtoolsInput,
  ) {
    let targetTab: PreviewTabId | undefined = input.tabId;
    const { tabId: _tab, ...operationInput } = input;
    const result = yield* broker.invoke({
      scope,
      operation: "devtools",
      input: operationInput,
      ...(input.tabId ? { tabId: input.tabId } : {}),
      timeoutMs: input.action === "traceStop" ? 30_000 : 15_000,
      onTargetTab: (tabId) => {
        targetTab = tabId;
      },
    });
    if (isDevtoolsFailure(result))
      return yield* new PreviewDevtoolsCommandError({ detail: result.detail });
    if (input.action !== "traceStop") return result;
    return yield* Effect.gen(function* () {
      const artifact = yield* decodeArtifact(result);
      if (!targetTab) return yield* new PreviewDevtoolsTransferError({});
      const tabId = targetTab;
      const destination = path.join(
        config.browserArtifactsDir,
        `trace-${yield* crypto.randomUUIDv4().pipe(Effect.orDie)}.json`,
      );
      const read = (offset: number) =>
        broker
          .invoke({
            scope,
            tabId,
            operation: "devtools",
            updateCurrentTab: false,
            timeoutMs: 10_000,
            input: { action: "artifactRead", artifactId: artifact.artifactId, offset },
          })
          .pipe(Effect.flatMap(decodeChunk));
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* fs.makeDirectory(config.browserArtifactsDir, { recursive: true });
          const file = yield* fs.open(destination, { flag: "wx" });
          let offset = 0;
          for (;;) {
            const chunk = yield* read(offset);
            const bytes = Buffer.from(chunk.data, "base64");
            if (
              chunk.nextOffset !== offset + bytes.length ||
              chunk.nextOffset > artifact.sizeBytes ||
              (!bytes.length && !chunk.eof)
            )
              return yield* new PreviewDevtoolsTransferError({});
            yield* file.writeAll(bytes);
            offset = chunk.nextOffset;
            if (chunk.eof) {
              if (offset !== artifact.sizeBytes) return yield* new PreviewDevtoolsTransferError({});
              break;
            }
          }
        }),
      ).pipe(
        Effect.timeout("60 seconds"),
        Effect.onError(() => fs.remove(destination).pipe(Effect.ignore)),
        Effect.ensuring(
          broker
            .invoke({
              scope,
              tabId,
              operation: "devtools",
              updateCurrentTab: false,
              timeoutMs: 5_000,
              input: { action: "artifactDelete", artifactId: artifact.artifactId },
            })
            .pipe(Effect.ignore),
        ),
      );
      return {
        path: destination,
        mimeType: artifact.mimeType,
        sizeBytes: artifact.sizeBytes,
        durationMs: artifact.durationMs,
        dataLossOccurred: artifact.dataLossOccurred,
        note: "Open this JSON in Chrome DevTools Performance or Perfetto. The path is local to this agent's environment.",
      };
    }).pipe(Effect.mapError((cause) => new PreviewDevtoolsTransferError({ cause })));
  });
  return PreviewDevtools.of({ invoke });
});

export const layer = Layer.effect(PreviewDevtools, make);
