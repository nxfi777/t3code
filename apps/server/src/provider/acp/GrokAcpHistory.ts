import { NonNegativeInt, ProviderDriverKind, TurnId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as EffectAcpSchema from "effect-acp/schema";

import { ProviderAdapterRequestError } from "../Errors.ts";
import type * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

const provider = ProviderDriverKind.make("grok");
const Index = NonNegativeInt.check(Schema.isLessThan(Number.MAX_SAFE_INTEGER));
const HistoryTurn = Schema.Struct({
  id: TurnId,
  first: Schema.optional(Index),
  last: Schema.optional(Index),
  confirmed: Schema.Boolean,
});
const History = Schema.Struct({
  baseline: Schema.optional(Index),
  inheritedTurnCount: Index,
  turns: Schema.Array(HistoryTurn),
});
const Resume = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  sessionId: Schema.String.check(Schema.isMinLength(1)),
  history: Schema.optional(History),
});
const decodeResume = Schema.decodeUnknownOption(Resume);
const decodePoints = Schema.decodeUnknownEffect(
  Schema.Struct({ rewind_points: Schema.Array(Schema.Struct({ prompt_index: Index })) }),
);
const decodeRewind = Schema.decodeUnknownOption(
  Schema.Struct({
    success: Schema.Boolean,
    target_prompt_index: Index,
    mode: Schema.Literal("conversation_only"),
  }),
);
const decodeFork = Schema.decodeUnknownOption(
  Schema.Struct({
    newSessionId: Schema.String.check(Schema.isMinLength(1)),
    parentSessionId: Schema.String,
  }),
);
type Runtime = Pick<AcpSessionRuntime.AcpSessionRuntime["Service"], "request">;
export type GrokHistory = typeof History.Type;
export type GrokHistoryTurn = typeof HistoryTurn.Type;
export interface GrokPendingBoundary {
  readonly turnId: TurnId;
  readonly before: number;
  first?: number;
  last?: number;
  unsafe: boolean;
}
const correlationKey = "t3.historyRequestId";
const error = (detail: string) =>
  new ProviderAdapterRequestError({ provider, method: "grok/history", detail });

export const readGrokResume = (value: unknown) => Option.getOrUndefined(decodeResume(value));

/** Invalid parameters probe decoders without opening or mutating native sessions. */
export const probeGrokHistoryExtensions = Effect.fnUntraced(function* (runtime: Runtime) {
  for (const method of ["_x.ai/rewind/points", "_x.ai/rewind/execute", "_x.ai/session/fork"]) {
    const supported = yield* runtime.request(method, {}).pipe(
      Effect.as(false),
      Effect.catchTags({ AcpRequestError: (cause) => Effect.succeed(cause.code === -32602) }),
      Effect.timeoutOption("2 seconds"),
      Effect.map((result) => Option.getOrElse(result, () => false)),
      Effect.orElseSucceed(() => false),
    );
    if (!supported) return false;
  }
  return true;
});

export const readGrokPromptCount = Effect.fnUntraced(function* (
  runtime: Runtime,
  sessionId: string,
) {
  const points = yield* decodePoints(
    yield* runtime.request("_x.ai/rewind/points", { session_id: sessionId }),
  ).pipe(Effect.mapError(() => error("Grok returned invalid native rewind points.")));
  if (points.rewind_points.some((point, index) => point.prompt_index !== index)) {
    return yield* error("Grok returned non-contiguous native rewind points.");
  }
  return points.rewind_points.length;
});

export function captureGrokPromptEcho(
  pending: GrokPendingBoundary | undefined,
  notification: EffectAcpSchema.SessionNotification,
): void {
  if (!pending || notification.update.sessionUpdate !== "user_message_chunk") return;
  const index = notification.update._meta?.promptIndex;
  if (typeof index !== "number" || !Number.isSafeInteger(index) || index < 0) return;
  const marker = notification.update.content._meta?.[correlationKey];
  if (marker !== pending.turnId) {
    if (typeof marker !== "string" && index >= pending.before) pending.unsafe = true;
    return;
  }
  pending.first = Math.min(pending.first ?? index, index);
  pending.last = Math.max(pending.last ?? index, index);
}

export const markGrokPrompt = (
  prompt: ReadonlyArray<EffectAcpSchema.ContentBlock>,
  turnId: TurnId,
) =>
  prompt.map((content) => ({ ...content, _meta: { ...content._meta, [correlationKey]: turnId } }));

export const sealGrokBoundary = Effect.fnUntraced(function* (
  runtime: Runtime,
  sessionId: string,
  pending: GrokPendingBoundary,
) {
  const unconfirmed: GrokHistoryTurn = { id: pending.turnId, confirmed: false };
  if (pending.unsafe) return unconfirmed;
  return yield* readGrokPromptCount(runtime, sessionId).pipe(
    Effect.map((count): GrokHistoryTurn => {
      const first = pending.first ?? pending.before;
      const last = pending.last ?? pending.before;
      // No-echo CLIs require exactly one native increment. Synthetic prompts and
      // uncaptured steering are ambiguous, never inferred from app turn counts.
      return first === pending.before && count === last + 1
        ? { id: pending.turnId, first, last, confirmed: true }
        : unconfirmed;
    }),
    Effect.timeout("2 seconds"),
    Effect.orElseSucceed(() => unconfirmed),
  );
});

export const grokRetainCount = (history: GrokHistory, turnId: TurnId) => {
  const turn = history.turns.find((turn) => turn.id === turnId);
  return turn?.confirmed &&
    turn.first !== undefined &&
    turn.last !== undefined &&
    turn.first <= turn.last
    ? Effect.succeed(turn.last + 1)
    : Effect.fail(
        error(
          "This Grok turn has no verified native prompt boundary. Older or interrupted history cannot be forked or rewound at this point.",
        ),
      );
};

export const rewindGrokHistory = Effect.fnUntraced(function* (
  runtime: Runtime,
  sessionId: string,
  history: GrokHistory,
  numTurns: number,
) {
  const keep = history.turns.length - numTurns;
  if (keep < history.inheritedTurnCount || keep < 0) {
    return yield* error("Cannot rewind unrecorded or inherited Grok history.");
  }
  const retainCount =
    keep === 0 ? history.baseline : yield* grokRetainCount(history, history.turns[keep - 1]!.id);
  if (retainCount === undefined)
    return yield* error("The original Grok history boundary is unavailable.");
  const count = yield* readGrokPromptCount(runtime, sessionId);
  if (retainCount > count)
    return yield* error("Grok no longer contains the requested rewind boundary.");
  if (retainCount < count) {
    const result = Option.getOrUndefined(
      decodeRewind(
        yield* runtime.request("_x.ai/rewind/execute", {
          session_id: sessionId,
          target_prompt_index: retainCount,
          mode: "conversation_only",
          force: true,
        }),
      ),
    );
    if (!result?.success || result.target_prompt_index !== retainCount)
      return yield* error("Grok did not confirm the requested conversation rewind.");
  }
  return { ...history, turns: history.turns.slice(0, keep) };
});

export const forkGrokHistory = Effect.fnUntraced(function* (
  runtime: Runtime,
  input: {
    sessionId: string;
    sourceCwd: string;
    cwd: string;
    history: GrokHistory;
    sourceTurnId: TurnId;
  },
) {
  const retainCount = yield* grokRetainCount(input.history, input.sourceTurnId);
  const result = Option.getOrUndefined(
    decodeFork(
      yield* runtime.request("_x.ai/session/fork", {
        sourceSessionId: input.sessionId,
        sourceCwd: input.sourceCwd,
        newCwd: input.cwd,
        targetPromptIndex: retainCount - 1,
      }),
    ),
  );
  if (
    !result ||
    result.parentSessionId !== input.sessionId ||
    result.newSessionId === input.sessionId
  )
    return yield* error("Grok did not return an independent native fork.");
  const index = input.history.turns.findIndex((turn) => turn.id === input.sourceTurnId);
  return {
    schemaVersion: 1 as const,
    sessionId: result.newSessionId,
    history: {
      ...input.history,
      inheritedTurnCount: index + 1,
      turns: input.history.turns.slice(0, index + 1),
    },
    retainCount,
  };
});
