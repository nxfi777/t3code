import type { OrchestrationV2ProviderTurn } from "@t3tools/contracts";
import type {
  AcpNativeHistory,
  AcpNativeHistoryPrompt,
} from "@t3tools/provider-acp/server/adapter";
import type * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as AcpErrors from "effect-acp/errors";

type Runtime = Pick<AcpSessionRuntime.AcpSessionRuntime["Service"], "request">;
const Index = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThan(Number.MAX_SAFE_INTEGER),
);
const Boundary = Schema.Struct({
  version: Schema.Literal("grok-history-1"),
  sessionId: Schema.String.check(Schema.isMinLength(1)),
  first: Index,
  retain: Index,
});
const decodeBoundary = Schema.decodeUnknownOption(Schema.fromJsonString(Boundary));
const decodePoints = Schema.decodeUnknownEffect(
  Schema.Struct({
    rewind_points: Schema.Array(Schema.Struct({ prompt_index: Index })),
  }),
);
const decodeFork = Schema.decodeUnknownEffect(
  Schema.Struct({
    newSessionId: Schema.String.check(Schema.isMinLength(1)),
    parentSessionId: Schema.String,
  }),
);
const decodeRewind = Schema.decodeUnknownEffect(
  Schema.Struct({
    success: Schema.Boolean,
    target_prompt_index: Index,
    mode: Schema.Literal("conversation_only"),
  }),
);
const markerKey = "t3.historyRequestId";
const invalid = (message: string) => AcpErrors.AcpRequestError.internalError(message);

const promptCount = Effect.fnUntraced(function* (runtime: Runtime, sessionId: string) {
  const points = yield* decodePoints(
    yield* runtime.request("_x.ai/rewind/points", { session_id: sessionId }),
  ).pipe(Effect.mapError(() => invalid("Grok returned invalid native rewind points.")));
  if (points.rewind_points.some((point, index) => point.prompt_index !== index)) {
    return yield* invalid("Grok returned non-contiguous native rewind points.");
  }
  return points.rewind_points.length;
});

const retainCount = (turn: OrchestrationV2ProviderTurn | undefined, sessionId: string) => {
  const boundary =
    turn?.nativeTurnRef?.strength === "strong" &&
    turn.status === "completed" &&
    turn.nativeTurnRef.driver === "grok"
      ? Option.getOrUndefined(decodeBoundary(turn.nativeTurnRef.nativeId))
      : undefined;
  return boundary !== undefined &&
    boundary.sessionId === sessionId &&
    boundary.first < boundary.retain
    ? Effect.succeed(boundary.retain)
    : Effect.fail(invalid("This Grok turn has no verified native prompt boundary."));
};

const baseline = (runtime: Runtime, sessionId: string) =>
  promptCount(runtime, sessionId).pipe(
    Effect.timeout("2 seconds"),
    Effect.orElseSucceed(() => undefined),
  );

/** Native refs persist verified prompt counts, never app turn ordinals or transcript guesses. */
export const grokNativeHistory = {
  probe: (runtime: Runtime) =>
    Effect.gen(function* () {
      // Invalid parameters probe decoders without opening or mutating a native session.
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
    }),
  baseline,
  preparePrompt: ({ runtime, sessionId, turnId, prompt }) =>
    Effect.gen(function* () {
      const before = yield* baseline(runtime, sessionId);
      if (before === undefined) return undefined;
      let first: number | undefined;
      let last: number | undefined;
      const echoed = new Set<number>();
      let unsafe = false;
      return {
        prompt: prompt.map((content) => ({
          ...content,
          _meta: { ...("_meta" in content ? content._meta : undefined), [markerKey]: turnId },
        })),
        observe: (notification) => {
          if (
            notification.sessionId !== sessionId ||
            notification.update.sessionUpdate !== "user_message_chunk"
          )
            return;
          const index = notification.update._meta?.promptIndex;
          if (typeof index !== "number" || !Number.isSafeInteger(index) || index < before) return;
          // Every new prompt must belong to this turn. Synthetic or other-turn
          // prompts make the boundary ambiguous, even if the final count matches.
          const content = notification.update.content;
          if (!("_meta" in content) || content._meta?.[markerKey] !== turnId) {
            unsafe = true;
            return;
          }
          first = Math.min(first ?? index, index);
          last = Math.max(last ?? index, index);
          echoed.add(index);
        },
        complete: Effect.suspend(() =>
          unsafe
            ? Effect.succeed(undefined)
            : promptCount(runtime, sessionId).pipe(
                Effect.map((count) =>
                  !unsafe &&
                  (first ?? before) === before &&
                  count === (last ?? before) + 1 &&
                  (echoed.size === 0 || echoed.size === count - before)
                    ? JSON.stringify({
                        version: "grok-history-1",
                        sessionId,
                        first: before,
                        retain: count,
                      })
                    : undefined,
                ),
                Effect.timeout("2 seconds"),
                Effect.orElseSucceed(() => undefined),
              ),
        ),
      } satisfies AcpNativeHistoryPrompt;
    }),
  fork: ({ runtime, sourceSessionId, sourceCwd, cwd, request }) =>
    Effect.gen(function* () {
      if (sourceCwd.length === 0)
        return yield* invalid("The original Grok working directory is unavailable.");
      const selected = request.sourceProviderTurns?.find(
        (turn) =>
          turn.id === request.providerTurnId &&
          turn.providerThreadId === request.sourceProviderThread.id,
      );
      // Even head forks require a selected verified boundary; background wakes can
      // move the native head beyond the last visible completed app turn.
      const retain = yield* retainCount(selected, sourceSessionId);
      // Fork runs in the target runtime. Its rewind API can only inspect loaded
      // sessions, whereas session/fork resolves the source from sourceCwd. Let
      // that extension validate the boundary, then verify the loaded child.
      const result = yield* decodeFork(
        yield* runtime.request("_x.ai/session/fork", {
          sourceSessionId,
          sourceCwd,
          newCwd: cwd,
          targetPromptIndex: retain - 1,
        }),
      ).pipe(Effect.mapError(() => invalid("Grok returned an invalid native fork.")));
      if (result.parentSessionId !== sourceSessionId || result.newSessionId === sourceSessionId) {
        return yield* invalid("Grok did not return an independent native fork.");
      }
      return {
        sessionId: result.newSessionId,
        baseline: retain,
        verify: Effect.gen(function* () {
          if ((yield* promptCount(runtime, result.newSessionId)) !== retain) {
            return yield* invalid(
              "Grok fork did not preserve the requested native history boundary.",
            );
          }
        }),
      };
    }),
  rewind: ({ runtime, sessionId, request }) =>
    Effect.gen(function* () {
      const baseline = request.providerThread.nativeMetadata?.acpHistoryBaseline;
      const retain =
        request.target.type === "thread_start"
          ? baseline
          : yield* retainCount(
              request.target.providerTurn.providerThreadId === request.providerThread.id
                ? request.target.providerTurn
                : undefined,
              sessionId,
            );
      if (retain === undefined || (baseline !== undefined && retain < baseline)) {
        return yield* invalid("The original Grok history boundary is unavailable.");
      }
      const count = yield* promptCount(runtime, sessionId);
      if (retain > count)
        return yield* invalid("Grok no longer contains the requested rewind boundary.");
      if (retain < count) {
        const result = yield* decodeRewind(
          yield* runtime.request("_x.ai/rewind/execute", {
            session_id: sessionId,
            target_prompt_index: retain,
            mode: "conversation_only",
            force: true,
          }),
        ).pipe(Effect.mapError(() => invalid("Grok returned an invalid native rewind.")));
        if (!result.success || result.target_prompt_index !== retain) {
          return yield* invalid("Grok did not confirm the requested conversation rewind.");
        }
        if ((yield* promptCount(runtime, sessionId)) !== retain) {
          return yield* invalid("Grok did not retain the requested conversation boundary.");
        }
      }
    }),
} satisfies AcpNativeHistory;
