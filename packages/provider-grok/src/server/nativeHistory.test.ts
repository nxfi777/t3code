import { describe, expect, it } from "@effect/vitest";
import {
  CheckpointId,
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  ThreadId,
  OrchestrationV2ProviderThreadNativeMetadata,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
} from "@t3tools/contracts";
import type * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as AcpErrors from "effect-acp/errors";
import { grokNativeHistory } from "./nativeHistory.ts";

const driver = ProviderDriverKind.make("grok");
const now = DateTime.makeUnsafe(0);
const thread: OrchestrationV2ProviderThread = {
  id: ProviderThreadId.make("source"),
  driver,
  providerInstanceId: ProviderInstanceId.make("grok"),
  providerSessionId: ProviderSessionId.make("runtime"),
  appThreadId: ThreadId.make("app"),
  ownerNodeId: null,
  nativeThreadRef: { driver, nativeId: "source", strength: "strong" },
  nativeConversationHeadRef: null,
  status: "idle",
  firstRunOrdinal: 1,
  lastRunOrdinal: 2,
  handoffIds: [],
  forkedFrom: null,
  contextUsage: null,
  nativeMetadata: { acpHistoryBaseline: 3, acpHistoryCwd: "/source" },
  createdAt: now,
  updatedAt: now,
};
const turn = (retain: number): OrchestrationV2ProviderTurn => ({
  id: ProviderTurnId.make(`turn-${retain}`),
  providerThreadId: thread.id,
  nodeId: NodeId.make(`node-${retain}`),
  runAttemptId: RunAttemptId.make(`attempt-${retain}`),
  nativeTurnRef: {
    driver,
    strength: "strong",
    nativeId: JSON.stringify({
      version: "grok-history-1",
      sessionId: "source",
      first: retain - 1,
      retain,
    }),
  },
  ordinal: retain - 3,
  status: "completed",
  startedAt: now,
  completedAt: now,
});

function nativeRuntime(
  options: {
    count?: number;
    forkId?: string;
    forkCount?: number;
    supported?: boolean;
    rewindSuccess?: boolean;
    sourceNotLoaded?: boolean;
  } = {},
) {
  const calls: Array<{ method: string; payload: unknown }> = [];
  let count = options.count ?? 5;
  const request = (method: string, payload: unknown): Effect.Effect<unknown, AcpErrors.AcpError> =>
    Effect.suspend((): Effect.Effect<unknown, AcpErrors.AcpError> => {
      calls.push({ method, payload });
      const params = payload as Record<string, unknown>;
      if (Object.keys(params).length === 0)
        return Effect.fail(
          new AcpErrors.AcpRequestError({
            code: options.supported === false ? -32601 : -32602,
            errorMessage: "probe",
          }),
        );
      if (
        method === "_x.ai/rewind/points" &&
        params.session_id === "source" &&
        options.sourceNotLoaded
      )
        return Effect.fail(AcpErrors.AcpRequestError.internalError("Resource not found"));
      if (method === "_x.ai/rewind/points")
        return Effect.succeed({
          rewind_points: Array.from(
            { length: params.session_id === "child" ? (options.forkCount ?? 4) : count },
            (_, prompt_index) => ({ prompt_index }),
          ),
        });
      if (method === "_x.ai/session/fork" && Number(params.targetPromptIndex) >= count)
        return Effect.fail(
          AcpErrors.AcpRequestError.internalError("Invalid source prompt boundary"),
        );
      if (method === "_x.ai/session/fork")
        return Effect.succeed({
          parentSessionId: "source",
          newSessionId: options.forkId ?? "child",
        });
      if (method === "_x.ai/rewind/execute") {
        if (options.rewindSuccess !== false) count = Number(params.target_prompt_index);
        return Effect.succeed({
          success: options.rewindSuccess ?? true,
          target_prompt_index: params.target_prompt_index,
          mode: "conversation_only",
        });
      }
      return Effect.fail(AcpErrors.AcpRequestError.internalError("Unexpected method"));
    });
  // These hooks only use the extension request transport.
  const runtime = { request } as AcpSessionRuntime.AcpSessionRuntime["Service"];
  return {
    runtime,
    calls,
    setCount: (next: number) => {
      count = next;
    },
  };
}

describe("Grok native history", () => {
  it("decodes old metadata and persists optional baseline/cwd", () => {
    const decode = Schema.decodeUnknownSync(OrchestrationV2ProviderThreadNativeMetadata);
    expect(decode({})).toEqual({});
    expect(decode(thread.nativeMetadata)).toEqual(thread.nativeMetadata);
    expect(() => decode({ acpHistoryBaseline: -1 })).toThrow();
  });

  it.effect("probes extension decoders without mutating sessions", () =>
    Effect.gen(function* () {
      const mock = nativeRuntime();
      expect(yield* grokNativeHistory.probe(mock.runtime)).toBe(true);
      expect(mock.calls.map((call) => call.payload)).toEqual([{}, {}, {}]);
      expect(yield* grokNativeHistory.probe(nativeRuntime({ supported: false }).runtime)).toBe(
        false,
      );
    }),
  );

  it.effect("seals exactly one native prompt without echoes and persists its count", () =>
    Effect.gen(function* () {
      const mock = nativeRuntime({ count: 3 });
      const pending = yield* grokNativeHistory.preparePrompt({
        runtime: mock.runtime,
        sessionId: "source",
        turnId: "turn",
        prompt: [{ type: "text", text: "hello" }],
      });
      expect(pending?.prompt[0]?._meta?.["t3.historyRequestId"]).toBe("turn");
      mock.setCount(4);
      expect(yield* pending!.complete).toBe(turn(4).nativeTurnRef!.nativeId);
    }),
  );

  it.effect.each([3, 5])("leaves an ambiguous no-echo count %i unverified", (count) =>
    Effect.gen(function* () {
      const mock = nativeRuntime({ count: 3 });
      const pending = yield* grokNativeHistory.preparePrompt({
        runtime: mock.runtime,
        sessionId: "source",
        turnId: "turn",
        prompt: [],
      });
      mock.setCount(count);
      expect(yield* pending!.complete).toBeUndefined();
    }),
  );

  it.effect.each([undefined, "another-turn"])(
    "rejects uncorrelated native prompt echo %s",
    (marker) =>
      Effect.gen(function* () {
        const mock = nativeRuntime({ count: 3 });
        const pending = yield* grokNativeHistory.preparePrompt({
          runtime: mock.runtime,
          sessionId: "source",
          turnId: "turn",
          prompt: [],
        });
        pending!.observe({
          sessionId: "source",
          update: {
            sessionUpdate: "user_message_chunk",
            _meta: { promptIndex: 3 },
            content: {
              type: "text",
              text: "synthetic",
              _meta: marker === undefined ? {} : { "t3.historyRequestId": marker },
            },
          },
        });
        mock.setCount(4);
        expect(yield* pending!.complete).toBeUndefined();
      }),
  );

  it.effect(
    "forks an unloaded source from its cwd and verifies the loaded child's retained history",
    () =>
      Effect.gen(function* () {
        const mock = nativeRuntime({ sourceNotLoaded: true });
        const forked = yield* grokNativeHistory.fork({
          runtime: mock.runtime,
          sourceSessionId: "source",
          sourceCwd: "/source",
          cwd: "/target",
          request: {
            sourceProviderThread: thread,
            sourceProviderTurns: [turn(4), turn(5)],
            providerTurnId: turn(4).id,
            targetThreadId: ThreadId.make("target"),
          },
        });
        yield* forked.verify;
        expect(forked.sessionId).toBe("child");
        expect(forked.baseline).toBe(4);
        expect(mock.calls.find((call) => call.method === "_x.ai/session/fork")?.payload).toEqual({
          sourceSessionId: "source",
          sourceCwd: "/source",
          newCwd: "/target",
          targetPromptIndex: 3,
        });
        expect(mock.calls.some((call) => call.method === "_x.ai/rewind/execute")).toBe(false);
        expect(
          mock.calls
            .filter((call) => call.method === "_x.ai/rewind/points")
            .map((call) => call.payload),
        ).toEqual([{ session_id: "child" }]);
      }),
  );

  it.effect.each([{ forkId: "source" }, { forkCount: 5 }])(
    "rejects shared or incorrectly retained forks %j",
    (options) =>
      Effect.gen(function* () {
        const mock = nativeRuntime(options);
        const result = yield* grokNativeHistory
          .fork({
            runtime: mock.runtime,
            sourceSessionId: "source",
            sourceCwd: "/source",
            cwd: "/target",
            request: {
              sourceProviderThread: thread,
              sourceProviderTurns: [turn(4)],
              providerTurnId: turn(4).id,
              targetThreadId: ThreadId.make("target"),
            },
          })
          .pipe(
            Effect.flatMap((forked) => forked.verify),
            Effect.result,
          );
        expect(result._tag).toBe("Failure");
      }),
  );

  it.effect.each(["failed", "interrupted", "cancelled"] as const)(
    "rejects %s selected turns before mutation",
    (status) =>
      Effect.gen(function* () {
        const mock = nativeRuntime();
        const result = yield* grokNativeHistory
          .fork({
            runtime: mock.runtime,
            sourceSessionId: "source",
            sourceCwd: "/source",
            cwd: "/target",
            request: {
              sourceProviderThread: thread,
              sourceProviderTurns: [{ ...turn(4), status }],
              providerTurnId: turn(4).id,
              targetThreadId: ThreadId.make("target"),
            },
          })
          .pipe(Effect.result);
        expect(result._tag).toBe("Failure");
        expect(mock.calls).toEqual([]);
      }),
  );

  it.effect.each(["weak", "malformed", "wrong-session", "future"] as const)(
    "rejects a %s native boundary without a fork mutation",
    (kind) =>
      Effect.gen(function* () {
        const mock = nativeRuntime();
        const selected = turn(kind === "future" ? 6 : 4);
        const invalidTurn: OrchestrationV2ProviderTurn = {
          ...selected,
          nativeTurnRef: {
            ...selected.nativeTurnRef!,
            strength: kind === "weak" ? "weak" : "strong",
            nativeId:
              kind === "malformed"
                ? "not-a-boundary"
                : kind === "wrong-session"
                  ? selected.nativeTurnRef!.nativeId!.replace("source", "another-session")
                  : selected.nativeTurnRef!.nativeId,
          },
        };
        const result = yield* grokNativeHistory
          .fork({
            runtime: mock.runtime,
            sourceSessionId: "source",
            sourceCwd: "/source",
            cwd: "/target",
            request: {
              sourceProviderThread: thread,
              sourceProviderTurns: [invalidTurn],
              providerTurnId: invalidTurn.id,
              targetThreadId: ThreadId.make("target"),
            },
          })
          .pipe(Effect.result);
        expect(result._tag).toBe("Failure");
        expect(mock.calls.map((call) => call.method)).toEqual(
          kind === "future" ? ["_x.ai/session/fork"] : [],
        );
      }),
  );

  it.effect.each([
    [3, 4, 5],
    [3, 5],
  ])("verifies every correlated native prompt in %j", (indices) =>
    Effect.gen(function* () {
      const mock = nativeRuntime({ count: 3 });
      const pending = yield* grokNativeHistory.preparePrompt({
        runtime: mock.runtime,
        sessionId: "source",
        turnId: "turn",
        prompt: [],
      });
      for (const promptIndex of indices)
        pending!.observe({
          sessionId: "source",
          update: {
            sessionUpdate: "user_message_chunk",
            _meta: { promptIndex },
            content: { type: "text", text: "prompt", _meta: { "t3.historyRequestId": "turn" } },
          },
        });
      mock.setCount(6);
      const boundary = yield* pending!.complete;
      expect(boundary !== undefined).toBe(indices.length === 3);
    }),
  );

  it.effect("rewinds through a verified turn and preserves the inherited baseline", () =>
    Effect.gen(function* () {
      const mock = nativeRuntime();
      yield* grokNativeHistory.rewind({
        runtime: mock.runtime,
        sessionId: "source",
        request: {
          providerThread: thread,
          providerThreadTurns: [turn(4), turn(5)],
          target: {
            type: "provider_turn",
            checkpointId: CheckpointId.make("checkpoint"),
            appRunOrdinal: 1,
            providerTurn: turn(4),
          },
        },
      });
      expect(mock.calls.find((call) => call.method === "_x.ai/rewind/execute")?.payload).toEqual({
        session_id: "source",
        target_prompt_index: 4,
        mode: "conversation_only",
        force: true,
      });
      yield* grokNativeHistory.rewind({
        runtime: mock.runtime,
        sessionId: "source",
        request: {
          providerThread: thread,
          providerThreadTurns: [],
          target: {
            type: "thread_start",
            checkpointId: CheckpointId.make("start"),
            appRunOrdinal: 0,
          },
        },
      });
      expect(
        mock.calls.filter((call) => call.method === "_x.ai/rewind/execute").at(-1)?.payload,
      ).toMatchObject({ target_prompt_index: 3 });
    }),
  );

  it.effect("fails closed on rejected rewind and missing baseline", () =>
    Effect.gen(function* () {
      const mock = nativeRuntime({ rewindSuccess: false });
      const request = {
        providerThread: thread,
        providerThreadTurns: [],
        target: {
          type: "thread_start" as const,
          checkpointId: CheckpointId.make("start"),
          appRunOrdinal: 0 as const,
        },
      };
      expect(
        (yield* grokNativeHistory
          .rewind({ runtime: mock.runtime, sessionId: "source", request })
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
      const fresh = nativeRuntime();
      expect(
        (yield* grokNativeHistory
          .rewind({
            runtime: fresh.runtime,
            sessionId: "source",
            request: { ...request, providerThread: { ...thread, nativeMetadata: null } },
          })
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
      expect(fresh.calls).toEqual([]);
    }),
  );
});
