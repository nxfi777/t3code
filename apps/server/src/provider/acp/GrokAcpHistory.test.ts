import { describe, expect, it } from "@effect/vitest";
import { TurnId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as EffectAcpErrors from "effect-acp/errors";
import {
  captureGrokPromptEcho,
  forkGrokHistory,
  grokRetainCount,
  probeGrokHistoryExtensions,
  readGrokResume,
  rewindGrokHistory,
  sealGrokBoundary,
  type GrokHistory,
  type GrokPendingBoundary,
} from "./GrokAcpHistory.ts";

const turnId = TurnId.make("turn-1");
const secondTurnId = TurnId.make("turn-2");
function runtime(count: number) {
  const calls: Array<{ method: string; payload: unknown }> = [];
  return {
    calls,
    request: (method: string, payload: unknown): Effect.Effect<unknown, EffectAcpErrors.AcpError> =>
      Effect.sync(() => {
        calls.push({ method, payload });
        if (method === "_x.ai/rewind/points")
          return {
            rewind_points: Array.from({ length: count }, (_, prompt_index) => ({ prompt_index })),
          };
        if (method === "_x.ai/session/fork")
          return { newSessionId: "child", parentSessionId: "source" };
        return {
          success: true,
          mode: "conversation_only",
          target_prompt_index: (payload as { target_prompt_index: number }).target_prompt_index,
        };
      }),
  };
}
const history: GrokHistory = {
  baseline: 3,
  inheritedTurnCount: 0,
  turns: [
    { id: turnId, first: 3, last: 3, confirmed: true },
    { id: secondTurnId, first: 4, last: 4, confirmed: true },
  ],
};

describe("legacy Grok native history", () => {
  it.effect("seals a serialized prompt without user echoes", () =>
    Effect.gen(function* () {
      expect(
        yield* sealGrokBoundary(runtime(4), "source", { turnId, before: 3, unsafe: false }),
      ).toEqual(history.turns[0]);
    }),
  );
  it.effect.each([3, 5])("rejects ambiguous no-echo advancement to %i", (count) =>
    Effect.gen(function* () {
      expect(
        yield* sealGrokBoundary(runtime(count), "source", { turnId, before: 3, unsafe: false }),
      ).toEqual({ id: turnId, confirmed: false });
    }),
  );
  it.effect("correlates steering echoes to the same T3 turn", () =>
    Effect.gen(function* () {
      const pending: GrokPendingBoundary = { turnId, before: 3, unsafe: false };
      for (const [promptIndex, marker] of [
        [3, turnId],
        [4, secondTurnId],
        [4, turnId],
      ] as const)
        captureGrokPromptEcho(pending, {
          sessionId: "source",
          update: {
            sessionUpdate: "user_message_chunk",
            content: { type: "text", text: "repeated", _meta: { "t3.historyRequestId": marker } },
            _meta: { promptIndex },
          },
        });
      expect(yield* sealGrokBoundary(runtime(5), "source", pending)).toEqual({
        id: turnId,
        first: 3,
        last: 4,
        confirmed: true,
      });
    }),
  );
  it.effect("rejects synthetic uncorrelated echoes", () =>
    Effect.gen(function* () {
      const pending: GrokPendingBoundary = { turnId, before: 3, unsafe: false };
      captureGrokPromptEcho(pending, {
        sessionId: "source",
        update: {
          sessionUpdate: "user_message_chunk",
          content: { type: "text", text: "synthetic" },
          _meta: { promptIndex: 3 },
        },
      });
      expect((yield* sealGrokBoundary(runtime(4), "source", pending)).confirmed).toBe(false);
    }),
  );
  it.effect("commits conversation-only rewind and preserves the old imported prefix", () =>
    Effect.gen(function* () {
      const native = runtime(5);
      expect((yield* rewindGrokHistory(native, "source", history, 2)).turns).toEqual([]);
      expect(native.calls[1]).toEqual({
        method: "_x.ai/rewind/execute",
        payload: {
          session_id: "source",
          target_prompt_index: 3,
          mode: "conversation_only",
          force: true,
        },
      });
    }),
  );
  it.effect("forks from native index rather than app count and protects inherited turns", () =>
    Effect.gen(function* () {
      const native = runtime(5);
      const child = yield* forkGrokHistory(native, {
        sessionId: "source",
        sourceCwd: "/source",
        cwd: "/target",
        history,
        sourceTurnId: turnId,
      });
      expect(native.calls).toEqual([
        {
          method: "_x.ai/session/fork",
          payload: {
            sourceSessionId: "source",
            sourceCwd: "/source",
            newCwd: "/target",
            targetPromptIndex: 3,
          },
        },
      ]);
      expect(child.history.inheritedTurnCount).toBe(1);
      const error = yield* rewindGrokHistory(native, "child", child.history, 1).pipe(Effect.flip);
      expect(error.message).toContain("inherited");
      const withOwnTurn: GrokHistory = {
        ...child.history,
        turns: [...child.history.turns, history.turns[1]!],
      };
      expect((yield* rewindGrokHistory(native, "child", withOwnTurn, 1)).turns).toEqual(
        child.history.turns,
      );
    }),
  );
  it.effect("refuses interrupted and unrecorded native boundaries", () =>
    Effect.gen(function* () {
      const unsealed: GrokHistory = { ...history, turns: [{ id: turnId, confirmed: false }] };
      expect((yield* grokRetainCount(unsealed, turnId).pipe(Effect.flip)).message).toContain(
        "verified",
      );
      expect(
        (yield* grokRetainCount(history, TurnId.make("old")).pipe(Effect.flip)).message,
      ).toContain("verified");
      expect(
        readGrokResume({ schemaVersion: 1, sessionId: "source", history: unsealed })?.history
          ?.turns[0]?.confirmed,
      ).toBe(false);
    }),
  );
  it.effect("fails closed when rewind only returns a preview", () =>
    Effect.gen(function* () {
      const native = runtime(5);
      const request: typeof native.request = (method, payload) =>
        method === "_x.ai/rewind/execute"
          ? Effect.succeed({ success: false, mode: "conversation_only", target_prompt_index: 4 })
          : native.request(method, payload);
      expect(
        (yield* rewindGrokHistory({ request }, "source", history, 1).pipe(Effect.flip)).message,
      ).toContain("confirm");
    }),
  );
  it.effect("does not advertise unsupported extensions", () =>
    Effect.gen(function* () {
      expect(yield* probeGrokHistoryExtensions(runtime(0))).toBe(false);
    }),
  );
  it.effect("probes all native extensions without sending session identifiers", () =>
    Effect.gen(function* () {
      const calls: Array<unknown> = [];
      const supported = yield* probeGrokHistoryExtensions({
        request: (method, payload) => {
          calls.push([method, payload]);
          return Effect.fail(
            new EffectAcpErrors.AcpRequestError({
              code: -32602,
              errorMessage: "Invalid parameters",
            }),
          );
        },
      });
      expect(supported).toBe(true);
      expect(calls).toEqual(
        ["_x.ai/rewind/points", "_x.ai/rewind/execute", "_x.ai/session/fork"].map((method) => [
          method,
          {},
        ]),
      );
      expect(
        yield* probeGrokHistoryExtensions({
          request: () =>
            Effect.fail(
              new EffectAcpErrors.AcpRequestError({ code: -32601, errorMessage: "Unknown method" }),
            ),
        }),
      ).toBe(false);
    }),
  );
});
