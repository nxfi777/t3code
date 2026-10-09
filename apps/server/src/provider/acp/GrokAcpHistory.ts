import {
  NonNegativeInt,
  ProviderDriverKind,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as EffectAcpSchema from "effect-acp/compat";

import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import type * as AcpSessionRuntime from "./AcpSessionRuntime.ts";
import type { AcpAdapterV2NativeHistory } from "../../orchestration-v2/Adapters/AcpAdapterV2.ts";

const driver = ProviderDriverKind.make("grok");
const PromptIndex = NonNegativeInt.check(Schema.isLessThan(Number.MAX_SAFE_INTEGER));
const Boundary = Schema.Struct({ sessionId: Schema.String, first: PromptIndex, last: PromptIndex });
const decodeBoundary = Schema.decodeUnknownOption(Schema.fromJsonString(Boundary));
const referencePrefix = "grok-prompt-v1:";
const unmappedReference = "grok-history-unmapped";
const correlationKey = "t3.historyRequestId";
const RewindPoints = Schema.Struct({
  rewind_points: Schema.Array(Schema.Struct({ prompt_index: PromptIndex })),
});
const RewindResult = Schema.Struct({
  success: Schema.Boolean,
  target_prompt_index: PromptIndex,
  mode: Schema.Literal("conversation_only"),
});
const ForkResult = Schema.Struct({
  newSessionId: Schema.String.check(Schema.isMinLength(1)),
  parentSessionId: Schema.String,
});
const PromptEcho = Schema.Struct({ promptIndex: PromptIndex });
const decodeRewindPoints = Schema.decodeUnknownEffect(RewindPoints);
const decodePromptEcho = Schema.decodeUnknownOption(PromptEcho);
const decodeRewindResult = Schema.decodeUnknownOption(RewindResult);
const decodeForkResult = Schema.decodeUnknownOption(ForkResult);

type Runtime = Pick<AcpSessionRuntime.AcpSessionRuntime["Service"], "request">;

/** Invalid parameters reach the extension's decoder without creating or changing a session. */
export const probeGrokHistoryExtensions = Effect.fnUntraced(function* (runtime: Runtime) {
  for (const method of ["_x.ai/rewind/points", "_x.ai/rewind/execute", "_x.ai/session/fork"]) {
    const supported = yield* runtime.request(method, {}).pipe(
      Effect.as(false),
      Effect.catchTags({
        AcpRequestError: (error) => Effect.succeed(error.code === -32602),
      }),
      Effect.timeoutOption("2 seconds"),
      Effect.map((result) => Option.getOrElse(result, () => false)),
      Effect.orElseSucceed(() => false),
    );
    if (!supported) return false;
  }
  return true;
});

function readBoundary(turn: OrchestrationV2ProviderTurn, sessionId: string) {
  const ref = turn.nativeTurnRef;
  if (
    ref?.driver !== driver ||
    ref.strength !== "strong" ||
    !ref.nativeId?.startsWith(referencePrefix)
  )
    return undefined;
  const boundary = Option.getOrUndefined(
    decodeBoundary(ref.nativeId.slice(referencePrefix.length)),
  );
  return boundary?.sessionId === sessionId && boundary.first <= boundary.last
    ? boundary
    : undefined;
}

function sessionIdOf(thread: OrchestrationV2ProviderThread) {
  const sessionId = thread.nativeThreadRef?.nativeId;
  return sessionId == null ||
    sessionId.length === 0 ||
    thread.nativeThreadRef?.strength !== "strong"
    ? Effect.fail(
        new ProviderAdapter.ProviderAdapterProtocolError({
          driver,
          detail: "Grok history is missing its native session id.",
        }),
      )
    : Effect.succeed(sessionId);
}

const readPoints = Effect.fnUntraced(function* (runtime: Runtime, sessionId: string) {
  const payload = yield* runtime.request("_x.ai/rewind/points", { sessionId });
  const points = yield* decodeRewindPoints(payload).pipe(
    Effect.mapError(
      (cause) =>
        new ProviderAdapter.ProviderAdapterProtocolError({
          driver,
          detail: "Grok returned invalid native rewind points.",
          cause,
        }),
    ),
  );
  // Grok's native indices include synthetic prompts. Never equate them with T3 run ordinals.
  if (points.rewind_points.some((point, index) => point.prompt_index !== index)) {
    return yield* new ProviderAdapter.ProviderAdapterProtocolError({
      driver,
      detail: "Grok returned non-contiguous native rewind points.",
    });
  }
  return points.rewind_points.length;
});

const retainThrough = Effect.fnUntraced(function* (
  thread: OrchestrationV2ProviderThread,
  turn: OrchestrationV2ProviderTurn,
  sessionId: string,
) {
  const boundary = readBoundary(turn, sessionId);
  if (turn.providerThreadId !== thread.id || boundary === undefined) {
    return yield* new ProviderAdapter.ProviderAdapterProtocolError({
      driver,
      detail:
        "This Grok turn has no verified native prompt boundary. History from older versions cannot be rewound or forked at this point.",
    });
  }
  return boundary.last + 1;
});

const validateForkSource = Effect.fnUntraced(function* (
  thread: OrchestrationV2ProviderThread,
  _cwd: string,
) {
  yield* sessionIdOf(thread);
  if (thread.nativeMetadata?.grokHistoryCwd === undefined) {
    return yield* new ProviderAdapter.ProviderAdapterProtocolError({
      driver,
      detail:
        "The original Grok working directory is unavailable; refusing to guess its session storage location.",
    });
  }
});

/** The echo carries the provider's actual prompt index, including across compaction and resume. */
function captureTurnReference(input: {
  readonly current: OrchestrationV2ProviderTurn["nativeTurnRef"];
  readonly notification: EffectAcpSchema.SessionNotification;
  readonly requestId?: string;
}): OrchestrationV2ProviderTurn["nativeTurnRef"] {
  const { notification, requestId } = input;
  if (notification.update.sessionUpdate !== "user_message_chunk") return input.current;
  if (input.current?.nativeId === unmappedReference) return input.current;
  const echo = Option.getOrUndefined(decodePromptEcho(notification.update._meta));
  if (echo === undefined) return input.current;
  const previous = input.current?.nativeId?.startsWith(referencePrefix)
    ? Option.getOrUndefined(decodeBoundary(input.current.nativeId.slice(referencePrefix.length)))
    : undefined;
  const content = notification.update.content;
  const echoedRequestId =
    content.type === "_t3_unknown" ? undefined : content._meta?.[correlationKey];
  // Grok clones the submitted content block into this echo, but its outer
  // notification has no promptId. Content metadata survives the completion
  // wrapper's separate promptId and never becomes model-visible prompt text.
  if (requestId === undefined || echoedRequestId !== requestId) {
    // Late echoes of another T3 request (e.g. interrupted steering) are unrelated.
    if (typeof echoedRequestId === "string") return input.current;
    // Synthetic provider prompts cannot be tied to a T3 turn with certainty.
    // Refuse this boundary instead of silently dropping their context.
    return requestId === undefined || (previous !== undefined && echo.promptIndex > previous.last)
      ? { driver, nativeId: unmappedReference, strength: "weak" }
      : input.current;
  }
  const boundary = {
    sessionId: notification.sessionId,
    first: Math.min(previous?.first ?? echo.promptIndex, echo.promptIndex),
    last: Math.max(previous?.last ?? echo.promptIndex, echo.promptIndex),
  };
  return { driver, nativeId: referencePrefix + JSON.stringify(boundary), strength: "weak" };
}

export const grokNativeHistory: AcpAdapterV2NativeHistory = {
  isSupported: probeGrokHistoryExtensions,
  validateForkSource,
  captureTurnReference,
  preparePrompt: (prompt, requestId) =>
    prompt.map((content) =>
      content.type === "_t3_unknown"
        ? content
        : {
            ...content,
            _meta: { ...content._meta, [correlationKey]: requestId },
          },
    ),
  initialThreadMetadata: (cwd, isNew) => ({
    grokHistoryCwd: cwd,
    ...(isNew ? { grokHistoryStartPromptIndex: 0 } : {}),
  }),
  finalizeTurnReference: (runtime, current) =>
    Effect.gen(function* () {
      const boundary = current?.nativeId?.startsWith(referencePrefix)
        ? Option.getOrUndefined(decodeBoundary(current.nativeId.slice(referencePrefix.length)))
        : undefined;
      if (boundary === undefined) return current;
      // Some synthetic prompts are persisted without a live echo. Only seal the
      // boundary when the completed native head is exactly the correlated prompt.
      const count = yield* readPoints(runtime, boundary.sessionId);
      return count === boundary.last + 1
        ? { ...current!, strength: "strong" as const }
        : { driver, nativeId: unmappedReference, strength: "weak" as const };
    }).pipe(
      Effect.timeout("2 seconds"),
      Effect.orElseSucceed(() => ({
        driver,
        nativeId: unmappedReference,
        strength: "weak" as const,
      })),
    ),
  rollback: Effect.fn("GrokAcpHistory.rollback")(function* ({ runtime, input }) {
    const sessionId = yield* sessionIdOf(input.providerThread);
    const retainCount =
      input.target.type === "provider_turn"
        ? yield* retainThrough(input.providerThread, input.target.providerTurn, sessionId)
        : input.providerThread.nativeMetadata?.grokHistoryStartPromptIndex;
    if (retainCount === undefined) {
      return yield* new ProviderAdapter.ProviderAdapterProtocolError({
        driver,
        detail: "The inherited Grok history boundary is unavailable; refusing to discard it.",
      });
    }
    const promptCount = yield* readPoints(runtime, sessionId);
    if (retainCount > promptCount) {
      return yield* new ProviderAdapter.ProviderAdapterProtocolError({
        driver,
        detail: "Grok history no longer contains the selected rewind point.",
      });
    }
    if (retainCount < promptCount) {
      const payload = yield* runtime.request("_x.ai/rewind/execute", {
        sessionId,
        targetPromptIndex: retainCount,
        mode: "conversation_only",
        force: false,
      });
      const result = Option.getOrUndefined(decodeRewindResult(payload));
      if (result?.success !== true || result.target_prompt_index !== retainCount) {
        return yield* new ProviderAdapter.ProviderAdapterProtocolError({
          driver,
          detail: "Grok did not confirm the requested conversation rewind.",
        });
      }
    }
    return input.providerThreadTurns.filter((turn) => {
      const boundary = readBoundary(turn, sessionId);
      return boundary !== undefined && boundary.last < retainCount;
    });
  }),
  fork: Effect.fn("GrokAcpHistory.fork")(function* ({ runtime, input, cwd }) {
    yield* validateForkSource(input.sourceProviderThread, cwd);
    const sessionId = yield* sessionIdOf(input.sourceProviderThread);
    const sourceCwd = input.sourceProviderThread.nativeMetadata!.grokHistoryCwd!;
    let retainCount: number | undefined;
    if (input.providerTurnId !== undefined) {
      const turn = input.sourceProviderTurns?.find((turn) => turn.id === input.providerTurnId);
      if (turn === undefined) {
        return yield* new ProviderAdapter.ProviderAdapterProtocolError({
          driver,
          detail: "The selected Grok fork turn is unavailable.",
        });
      }
      retainCount = yield* retainThrough(input.sourceProviderThread, turn, sessionId);
    }
    // Native fork reads persisted source storage directly. Never load the source
    // in the target runtime: doing so could revive its detached background work.
    const payload = yield* runtime.request("_x.ai/session/fork", {
      sourceSessionId: sessionId,
      sourceCwd,
      newCwd: cwd,
      ...(retainCount === undefined ? {} : { targetPromptIndex: retainCount - 1 }),
    });
    const result = Option.getOrUndefined(decodeForkResult(payload));
    if (
      result === undefined ||
      result.parentSessionId !== sessionId ||
      result.newSessionId === sessionId
    ) {
      return yield* new ProviderAdapter.ProviderAdapterProtocolError({
        driver,
        detail: "Grok did not return an independent fork of the requested session.",
      });
    }
    return {
      sessionId: result.newSessionId,
      nativeMetadata: {
        ...(retainCount === undefined ? {} : { grokHistoryStartPromptIndex: retainCount }),
        grokHistoryCwd: cwd,
      },
    };
  }),
  finalizeForkMetadata: Effect.fn("GrokAcpHistory.finalizeForkMetadata")(
    function* (runtime, sessionId, metadata) {
      const count = yield* readPoints(runtime, sessionId);
      if (
        metadata.grokHistoryStartPromptIndex !== undefined &&
        metadata.grokHistoryStartPromptIndex !== count
      ) {
        return yield* new ProviderAdapter.ProviderAdapterProtocolError({
          driver,
          detail: "The Grok fork does not contain the selected native prompt boundary.",
        });
      }
      return { ...metadata, grokHistoryStartPromptIndex: count };
    },
  ),
};
