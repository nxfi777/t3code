import { assert, describe, it } from "@effect/vitest";
import {
  CheckpointId,
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/compat";

import type * as AcpSessionRuntime from "./AcpSessionRuntime.ts";
import { grokNativeHistory, probeGrokHistoryExtensions } from "./GrokAcpHistory.ts";

const driver = ProviderDriverKind.make("grok");
const now = DateTime.makeUnsafe(0);
const checkpointId = CheckpointId.make("checkpoint");
const source: OrchestrationV2ProviderThread = {
  id: ProviderThreadId.make("source-provider-thread"),
  driver,
  providerInstanceId: ProviderInstanceId.make("grok"),
  providerSessionId: ProviderSessionId.make("runtime"),
  appThreadId: ThreadId.make("source"),
  ownerNodeId: null,
  nativeThreadRef: { driver, nativeId: "native-source", strength: "strong" },
  nativeConversationHeadRef: null,
  status: "idle",
  firstRunOrdinal: 1,
  lastRunOrdinal: 2,
  handoffIds: [],
  forkedFrom: null,
  contextUsage: null,
  nativeMetadata: { grokHistoryStartPromptIndex: 0, grokHistoryCwd: "/workspace" },
  createdAt: now,
  updatedAt: now,
};

function echo(index: number, promptId = "prompt-1"): EffectAcpSchema.SessionNotification {
  return {
    sessionId: "native-source",
    update: {
      sessionUpdate: "user_message_chunk",
      content: {
        type: "text",
        text: "same repeated prompt",
        _meta: { "t3.historyRequestId": promptId },
      },
      _meta: { promptIndex: index },
    },
  };
}

function turn(ordinal: number, nativeIndex: number): OrchestrationV2ProviderTurn {
  return {
    id: ProviderTurnId.make(`turn-${ordinal}`),
    providerThreadId: source.id,
    nodeId: NodeId.make(`node-${ordinal}`),
    runAttemptId: null,
    nativeTurnRef: {
      ...grokNativeHistory.captureTurnReference({
        current: null,
        notification: echo(nativeIndex),
        requestId: "prompt-1",
      })!,
      strength: "strong",
    },
    ordinal,
    status: "completed",
    startedAt: now,
    completedAt: now,
  };
}

function runtime(
  input: {
    readonly promptCount?: number;
    readonly forkResult?: unknown;
    readonly rewindResult?: unknown;
  } = {},
) {
  const requests: Array<{ method: string; payload: unknown }> = [];
  const request: AcpSessionRuntime.AcpSessionRuntime["Service"]["request"] = (method, payload) =>
    Effect.sync(() => {
      requests.push({ method, payload });
      if (method === "_x.ai/rewind/points") {
        return {
          rewind_points: Array.from({ length: input.promptCount ?? 9 }, (_, prompt_index) => ({
            prompt_index,
          })),
        };
      }
      if (method === "_x.ai/session/fork") {
        return (
          input.forkResult ?? { newSessionId: "native-child", parentSessionId: "native-source" }
        );
      }
      return (
        input.rewindResult ?? {
          success: (payload as { force?: boolean }).force === true,
          target_prompt_index: (payload as { target_prompt_index: number }).target_prompt_index,
          mode: "conversation_only",
        }
      );
    });
  return { runtime: { request } as AcpSessionRuntime.AcpSessionRuntime["Service"], requests };
}

describe("Grok native history capability", () => {
  it.effect("requires each extension to reject missing parameters before advertising support", () =>
    Effect.gen(function* () {
      const called: string[] = [];
      const supported = yield* probeGrokHistoryExtensions({
        request: (method) => {
          called.push(method);
          return Effect.fail(
            new EffectAcpErrors.AcpRequestError({ code: -32602, errorMessage: "Invalid params" }),
          );
        },
      });
      assert.isTrue(supported);
      assert.deepEqual(called, [
        "_x.ai/rewind/points",
        "_x.ai/rewind/execute",
        "_x.ai/session/fork",
      ]);
      assert.isFalse(
        yield* probeGrokHistoryExtensions({
          request: () =>
            Effect.fail(
              new EffectAcpErrors.AcpRequestError({
                code: -32601,
                errorMessage: "Method not found",
              }),
            ),
        }),
      );
      assert.isFalse(yield* probeGrokHistoryExtensions({ request: () => Effect.succeed({}) }));
    }),
  );
});

describe("Grok prompt boundaries", () => {
  it.effect(
    "seals a serialized prompt without echoes only for one verified native advancement",
    () =>
      Effect.gen(function* () {
        const pending = yield* grokNativeHistory.beginTurnReference(
          runtime({ promptCount: 5 }).runtime,
          "native-source",
        );
        assert.equal(pending?.strength, "weak");
        const completed = yield* grokNativeHistory.finalizeTurnReference(
          runtime({ promptCount: 6 }).runtime,
          pending,
        );
        assert.equal(completed?.strength, "strong");
        assert.include(completed!.nativeId!, '"first":5,"last":5');
        // No advancement (e.g. a rejected prompt), a rewind, and additional
        // provider-authored turns cannot identify this request unambiguously.
        for (const promptCount of [4, 5, 7]) {
          const ambiguous = yield* grokNativeHistory.finalizeTurnReference(
            runtime({ promptCount }).runtime,
            pending,
          );
          assert.equal(ambiguous?.strength, "weak");
          assert.equal(ambiguous?.nativeId, "grok-history-unmapped");
        }
      }),
  );
  it.effect("persists an unsealed echo and only seals a matching native head", () =>
    Effect.gen(function* () {
      const captured = grokNativeHistory.captureTurnReference({
        current: null,
        notification: echo(5),
        requestId: "prompt-1",
      });
      assert.equal(captured?.strength, "weak");
      const sealed = yield* grokNativeHistory.finalizeTurnReference(
        runtime({ promptCount: 6 }).runtime,
        captured,
      );
      assert.equal(sealed?.strength, "strong");
      const syntheticContinuation = yield* grokNativeHistory.finalizeTurnReference(
        runtime({ promptCount: 7 }).runtime,
        captured,
      );
      assert.equal(syntheticContinuation?.strength, "weak");
      assert.notEqual(syntheticContinuation?.nativeId, captured?.nativeId);
      const mock = runtime();
      const interrupted = yield* grokNativeHistory
        .fork({
          runtime: mock.runtime,
          cwd: "/workspace",
          input: {
            sourceProviderThread: source,
            sourceProviderTurns: [{ ...turn(1, 5), nativeTurnRef: captured }],
            providerTurnId: ProviderTurnId.make("turn-1"),
            targetThreadId: ThreadId.make("child"),
          },
        })
        .pipe(Effect.result);
      assert.equal(interrupted._tag, "Failure");
      assert.isFalse(mock.requests.some((request) => request.method === "_x.ai/session/fork"));
    }),
  );

  it("ignores echoes of cancelled prompts when a replacement is running", () => {
    assert.isNull(
      grokNativeHistory.captureTurnReference({
        current: null,
        notification: echo(5, "old-prompt"),
        requestId: "new-prompt",
      }),
    );
    assert.isNotNull(
      grokNativeHistory.captureTurnReference({
        current: null,
        notification: echo(8, "new-prompt"),
        requestId: "new-prompt",
      }),
    );
  });

  it("does not assign provider-authored continuation echoes to an app request", () => {
    const notification = echo(9);
    if (notification.update.sessionUpdate !== "user_message_chunk") return;
    const nativeEcho: EffectAcpSchema.SessionNotification = {
      ...notification,
      update: {
        ...notification.update,
        content: { type: "text", text: "background task completed" },
      },
    };
    const ref = grokNativeHistory.captureTurnReference({ current: null, notification: nativeEcho });
    assert.equal(ref?.strength, "weak");
    assert.equal(ref?.nativeId, "grok-history-unmapped");
  });

  it.effect(
    "rejects unknown storage directories and weak session identities before a mutation",
    () =>
      Effect.gen(function* () {
        for (const sourceProviderThread of [
          { ...source, nativeMetadata: {} },
          { ...source, nativeThreadRef: { ...source.nativeThreadRef!, strength: "weak" as const } },
        ]) {
          const mock = runtime();
          const result = yield* grokNativeHistory
            .fork({
              runtime: mock.runtime,
              cwd: "/workspace",
              input: { sourceProviderThread, targetThreadId: ThreadId.make("child") },
            })
            .pipe(Effect.result);
          assert.equal(result._tag, "Failure");
          assert.equal(mock.requests.length, 0);
        }
      }),
  );

  it.effect("rewinds a persisted native boundary instead of counting app turns", () =>
    Effect.gen(function* () {
      const mock = runtime();
      const retained = turn(1, 4);
      const removed = turn(2, 8);
      const result = yield* grokNativeHistory.rollback({
        runtime: mock.runtime,
        input: {
          providerThread: source,
          providerThreadTurns: [retained, removed],
          target: { type: "provider_turn", checkpointId, appRunOrdinal: 1, providerTurn: retained },
        },
      });
      assert.deepEqual(result, [retained]);
      assert.deepEqual(mock.requests[1], {
        method: "_x.ai/rewind/execute",
        payload: {
          session_id: "native-source",
          target_prompt_index: 5,
          mode: "conversation_only",
          force: true,
        },
      });
    }),
  );

  it.effect("keeps inherited native history when editing the fork's first prompt", () =>
    Effect.gen(function* () {
      const mock = runtime();
      yield* grokNativeHistory.rollback({
        runtime: mock.runtime,
        input: {
          providerThread: { ...source, nativeMetadata: { grokHistoryStartPromptIndex: 7 } },
          providerThreadTurns: [],
          target: { type: "thread_start", checkpointId, appRunOrdinal: 0 },
        },
      });
      assert.deepEqual(mock.requests[1]?.payload, {
        session_id: "native-source",
        target_prompt_index: 7,
        mode: "conversation_only",
        force: true,
      });
    }),
  );

  it.effect("refuses missing boundaries and stale indices without a rewind request", () =>
    Effect.gen(function* () {
      for (const retained of [
        { ...turn(1, 4), nativeTurnRef: null },
        turn(1, 10),
        { ...turn(1, 4), providerThreadId: ProviderThreadId.make("other-thread") },
      ]) {
        const mock = runtime();
        const result = yield* grokNativeHistory
          .rollback({
            runtime: mock.runtime,
            input: {
              providerThread: source,
              providerThreadTurns: [retained],
              target: {
                type: "provider_turn",
                checkpointId,
                appRunOrdinal: 1,
                providerTurn: retained,
              },
            },
          })
          .pipe(Effect.result);
        assert.equal(result._tag, "Failure");
        assert.isFalse(mock.requests.some((request) => request.method === "_x.ai/rewind/execute"));
      }
    }),
  );

  it.effect("refuses an unknown inherited prefix and a provider refusal", () =>
    Effect.gen(function* () {
      const mock = runtime({
        rewindResult: { success: false, target_prompt_index: 0, mode: "conversation_only" },
      });
      for (const nativeMetadata of [null, { grokHistoryStartPromptIndex: 0 }]) {
        const result = yield* grokNativeHistory
          .rollback({
            runtime: mock.runtime,
            input: {
              providerThread: { ...source, nativeMetadata },
              providerThreadTurns: [],
              target: { type: "thread_start", checkpointId, appRunOrdinal: 0 },
            },
          })
          .pipe(Effect.result);
        assert.equal(result._tag, "Failure");
      }
    }),
  );

  it.effect("forks at an inclusive native prompt and records the child's inherited prefix", () =>
    Effect.gen(function* () {
      const mock = runtime();
      const selected = turn(1, 4);
      const result = yield* grokNativeHistory.fork({
        runtime: mock.runtime,
        cwd: "/workspace",
        input: {
          sourceProviderThread: source,
          sourceProviderTurns: [selected, turn(2, 8)],
          providerTurnId: selected.id,
          targetThreadId: ThreadId.make("child"),
        },
      });
      assert.deepEqual(result, {
        sessionId: "native-child",
        nativeMetadata: { grokHistoryStartPromptIndex: 5, grokHistoryCwd: "/workspace" },
      });
      assert.deepEqual(mock.requests[0], {
        method: "_x.ai/session/fork",
        payload: {
          sourceSessionId: "native-source",
          sourceCwd: "/workspace",
          newCwd: "/workspace",
          targetPromptIndex: 4,
        },
      });
      assert.isFalse(mock.requests.some((request) => request.method === "_x.ai/rewind/execute"));
      assert.isFalse(mock.requests.some((request) => request.method === "_x.ai/rewind/points"));
    }),
  );

  it.effect("uses distinct source and target directories and validates the loaded child", () =>
    Effect.gen(function* () {
      const mock = runtime({ promptCount: 5 });
      const selected = turn(1, 4);
      const forked = yield* grokNativeHistory.fork({
        runtime: mock.runtime,
        cwd: "/new-worktree",
        input: {
          sourceProviderThread: source,
          sourceProviderTurns: [selected],
          providerTurnId: selected.id,
          targetThreadId: ThreadId.make("child"),
        },
      });
      assert.deepEqual(mock.requests[0]?.payload, {
        sourceSessionId: "native-source",
        sourceCwd: "/workspace",
        newCwd: "/new-worktree",
        targetPromptIndex: 4,
      });
      const metadata = yield* grokNativeHistory.finalizeForkMetadata(
        mock.runtime,
        forked.sessionId,
        forked.nativeMetadata,
      );
      assert.equal(metadata.grokHistoryStartPromptIndex, 5);
      const stale = yield* grokNativeHistory
        .finalizeForkMetadata(
          runtime({ promptCount: 3 }).runtime,
          forked.sessionId,
          forked.nativeMetadata,
        )
        .pipe(Effect.result);
      assert.equal(stale._tag, "Failure");
    }),
  );

  it.effect("rejects a fork response which aliases the source session", () =>
    Effect.gen(function* () {
      const mock = runtime({
        forkResult: { newSessionId: "native-source", parentSessionId: "native-source" },
      });
      const result = yield* grokNativeHistory
        .fork({
          runtime: mock.runtime,
          cwd: "/workspace",
          input: { sourceProviderThread: source, targetThreadId: ThreadId.make("child") },
        })
        .pipe(Effect.result);
      assert.equal(result._tag, "Failure");
    }),
  );
});
