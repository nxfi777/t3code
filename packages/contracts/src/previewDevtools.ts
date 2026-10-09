import * as Schema from "effect/Schema";
import { PreviewTabId } from "./preview.ts";

const target = { tabId: Schema.optional(PreviewTabId) };
const boundedText = Schema.String.check(Schema.isMaxLength(2048));
const limit = Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })));
export const PreviewConsoleInput = Schema.Struct({
  ...target,
  level: Schema.optional(Schema.Literals(["all", "error", "warn", "info", "log", "debug"])),
  afterId: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  limit,
});
export const PreviewNetworkInput = Schema.Struct({
  ...target,
  urlIncludes: Schema.optional(boundedText),
  failedOnly: Schema.optional(Schema.Boolean),
  limit,
});
export const PreviewNetworkRequestInput = Schema.Struct({
  ...target,
  requestId: boundedText,
  includeBody: Schema.optional(Schema.Boolean),
});
export const PreviewStylesInput = Schema.Struct({
  ...target,
  selector: boundedText.check(Schema.isNonEmpty()),
  properties: Schema.optional(Schema.Array(boundedText).check(Schema.isMaxLength(60))),
});
export const PreviewEmulateInput = Schema.Struct({
  ...target,
  cpuRate: Schema.optional(Schema.Number.check(Schema.isBetween({ minimum: 1, maximum: 20 }))),
  network: Schema.optional(Schema.Literals(["none", "fast-4g", "slow-4g", "3g", "offline"])),
  reset: Schema.optional(Schema.Boolean),
});
export const PreviewPerformanceStartInput = Schema.Struct({
  ...target,
  durationSeconds: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 60 }))),
});
export const PreviewDevtoolsTargetInput = Schema.Struct(target);

/** Narrow actions, never arbitrary CDP commands. Artifact operations are bridge-internal. */
export const PreviewDevtoolsInput = Schema.Union([
  Schema.Struct({ action: Schema.Literal("console"), ...PreviewConsoleInput.fields }),
  Schema.Struct({ action: Schema.Literal("network"), ...PreviewNetworkInput.fields }),
  Schema.Struct({ action: Schema.Literal("request"), ...PreviewNetworkRequestInput.fields }),
  Schema.Struct({ action: Schema.Literal("styles"), ...PreviewStylesInput.fields }),
  Schema.Struct({ action: Schema.Literal("emulate"), ...PreviewEmulateInput.fields }),
  Schema.Struct({ action: Schema.Literal("traceStart"), ...PreviewPerformanceStartInput.fields }),
  Schema.Struct({ action: Schema.Literal("traceStop"), ...target }),
  Schema.Struct({ action: Schema.Literal("memory"), ...target }),
  Schema.Struct({
    action: Schema.Literal("artifactRead"),
    artifactId: boundedText,
    offset: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 16 * 1024 * 1024 })),
    ...target,
  }),
  Schema.Struct({ action: Schema.Literal("artifactDelete"), artifactId: boundedText, ...target }),
]);
export type PreviewDevtoolsInput = typeof PreviewDevtoolsInput.Type;

export const PREVIEW_TRACE_MAX_BYTES = 16 * 1024 * 1024;
export const PREVIEW_ARTIFACT_CHUNK_BYTES = 128 * 1024;
export const PreviewTraceArtifact = Schema.Struct({
  artifactId: Schema.String,
  sizeBytes: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: PREVIEW_TRACE_MAX_BYTES })),
  mimeType: Schema.Literal("application/json"),
  dataLossOccurred: Schema.Boolean,
  durationMs: Schema.Number,
});
export const PreviewArtifactChunk = Schema.Struct({
  data: Schema.String.check(Schema.isMaxLength(PREVIEW_ARTIFACT_CHUNK_BYTES * 2)),
  nextOffset: Schema.Int,
  eof: Schema.Boolean,
});

export class PreviewDevtoolsTransferError extends Schema.TaggedError<PreviewDevtoolsTransferError>()(
  "PreviewDevtoolsTransferError",
  { cause: Schema.optional(Schema.Defect()) },
) {
  override get message() {
    return "The browser trace could not be transferred to this environment. Record a shorter trace and try again.";
  }
}

/** A bounded, intentional diagnostic carried through Electron's invoke boundary. */
export const PreviewDevtoolsFailure = Schema.Struct({
  _tag: Schema.Literal("PreviewDevtoolsFailure"),
  detail: Schema.String.check(Schema.isMaxLength(1024)),
});

export class PreviewDevtoolsCommandError extends Schema.TaggedError<PreviewDevtoolsCommandError>()(
  "PreviewDevtoolsCommandError",
  { detail: Schema.String.check(Schema.isMaxLength(1024)) },
) {
  override get message() {
    return this.detail;
  }
}
