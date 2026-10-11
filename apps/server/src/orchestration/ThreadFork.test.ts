import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  OrchestrationThread,
  ProjectId,
  ProviderDriverKind,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as ThreadFork from "./ThreadFork.ts";
import * as Engine from "./Services/OrchestrationEngine.ts";
import * as Snapshots from "./Services/ProjectionSnapshotQuery.ts";
import * as Providers from "../provider/Services/ProviderService.ts";
import { ProviderAdapterRequestError } from "../provider/Errors.ts";
import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";
import {
  ProjectionTurnRepository,
  type ProjectionTurn,
} from "../persistence/Services/ProjectionTurns.ts";

const sourceId = ThreadId.make("source");
const targetId = ThreadId.make("target");
const projectId = ProjectId.make("project");
const now = "2026-10-09T01:00:00.000Z";
const decodeThread = Schema.decodeUnknownSync(OrchestrationThread);
const source = (busy = false) =>
  decodeThread({
    id: sourceId,
    projectId,
    title: "Original",
    modelSelection: { instanceId: "codex", model: "default" },
    runtimeMode: "full-access",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    activities: [],
    session: {
      threadId: sourceId,
      status: busy ? "running" : "ready",
      providerName: "codex",
      runtimeMode: "full-access",
      activeTurnId: busy ? "turn2" : null,
      lastError: null,
      updatedAt: now,
    },
    messages: [
      {
        id: "user1",
        role: "user",
        text: "Remember ALPHA",
        turnId: "turn1",
        streaming: false,
        createdAt: now,
        updatedAt: now,
        attachments: [
          { type: "image", id: "image1", name: "example.png", mimeType: "image/png", sizeBytes: 4 },
        ],
      },
      {
        id: "assistant1",
        role: "assistant",
        text: "ALPHA saved",
        turnId: "turn1",
        streaming: false,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "user2",
        role: "user",
        text: "Later BETA",
        turnId: "turn2",
        streaming: false,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "assistant2",
        role: "assistant",
        text: "BETA saved",
        turnId: "turn2",
        streaming: false,
        createdAt: now,
        updatedAt: now,
      },
    ],
    checkpoints: [1, 2].map((n) => ({
      turnId: `turn${n}`,
      checkpointTurnCount: n,
      checkpointRef: `refs/t3/checkpoints/source/${n}`,
      status: "missing",
      files: [],
      assistantMessageId: `assistant${n}`,
      completedAt: now,
    })),
  });

const harness = (
  options: {
    busy?: boolean;
    failNative?: boolean;
    failImport?: boolean;
    historyIssue?: "unindexed" | "misordered";
    source?: OrchestrationThread;
    prepareTurns?: (turns: ProjectionTurn[]) => ProjectionTurn[];
    expectedTexts?: string[];
  } = {},
) => {
  const original = options.source ?? source(options.busy);
  let turns: ProjectionTurn[] = original.checkpoints.map((checkpoint, index) => ({
    threadId: sourceId,
    turnId: checkpoint.turnId,
    pendingMessageId: MessageId.make(`user${index + 1}`),
    sourceProposedPlanThreadId: null,
    sourceProposedPlanId: null,
    assistantMessageId: checkpoint.assistantMessageId,
    state: "completed",
    requestedAt: `2026-10-09T01:00:0${index + 1}.000Z`,
    startedAt: null,
    completedAt: now,
    checkpointTurnCount: options.historyIssue === "misordered" ? 2 - index : index + 1,
    checkpointRef: checkpoint.checkpointRef,
    checkpointStatus: checkpoint.status,
    checkpointFiles: [],
  }));
  if (options.prepareTurns) turns = options.prepareTurns(turns);
  if (options.historyIssue === "unindexed")
    turns.unshift({
      ...turns[0]!,
      turnId: TurnId.make("old-unindexed"),
      requestedAt: now,
      checkpointTurnCount: null,
      checkpointRef: null,
      checkpointStatus: null,
    });
  let model: ReturnType<typeof createEmptyReadModel> = {
    ...createEmptyReadModel(now),
    threads: [original],
    projects: [
      {
        id: projectId,
        title: "Project",
        workspaceRoot: "/tmp/non-git",
        deletedAt: null,
        defaultModelSelection: null,
        scripts: [],
        createdAt: now,
        updatedAt: now,
      },
    ],
  };
  let forkCalls = 0;
  let stopCalls = 0;
  const dispatch = (command: OrchestrationCommand) =>
    Effect.gen(function* () {
      if (options.failImport && command.type === "thread.history.import")
        return yield* Effect.die("simulated projection failure");
      const planned = yield* decideOrchestrationCommand({ command, readModel: model });
      for (const event of Array.isArray(planned) ? planned : [planned]) {
        model = yield* projectEvent(model, { ...event, sequence: model.snapshotSequence + 1 });
      }
      return { sequence: model.snapshotSequence };
    }).pipe(Effect.provide(NodeServices.layer), Effect.orDie);
  const dependencies = Layer.mergeAll(
    NodeServices.layer,
    Layer.mock(Snapshots.ProjectionSnapshotQuery)({
      getThreadDetailById: (id) =>
        Effect.sync(() =>
          Option.fromNullishOr(model.threads.find((t) => t.id === id && !t.deletedAt)),
        ),
    }),
    Layer.mock(Engine.OrchestrationEngineService)({ dispatch }),
    Layer.mock(ProjectionTurnRepository)({ listByThreadId: () => Effect.succeed(turns) }),
    Layer.mock(Providers.ProviderService)({
      forkThread: (input) =>
        Effect.gen(function* () {
          forkCalls++;
          const child = model.threads.find((thread) => thread.id === targetId);
          expect(child?.messages.map((message) => message.text)).toEqual(
            options.expectedTexts ?? ["Remember ALPHA", "ALPHA saved"],
          );
          expect(child?.session?.status).toBe("starting");
          expect(input.sourceTurnId).toBe("turn1");
          expect(input.retainedTurnCount).toBe(1);
          if (options.failNative)
            return yield* new ProviderAdapterRequestError({
              provider: "codex",
              method: "fork",
              detail: "Native fork failed",
            });
          return {
            threadId: targetId,
            provider: ProviderDriverKind.make("codex"),
            status: "ready" as const,
            runtimeMode: "full-access" as const,
            createdAt: now,
            updatedAt: now,
          };
        }),
      stopSession: () =>
        Effect.sync(() => {
          stopCalls++;
        }),
    }),
  );
  return {
    layer: Layer.effect(ThreadFork.ThreadFork, ThreadFork.make).pipe(Layer.provide(dependencies)),
    model: () => model,
    original,
    dispatch: (command: OrchestrationCommand) =>
      dispatch(command).pipe(Effect.provide(NodeServices.layer)),
    forkCalls: () => forkCalls,
    stopCalls: () => stopCalls,
  };
};
const fork = Effect.flatMap(ThreadFork.ThreadFork, (service) =>
  service.fork({
    threadId: sourceId,
    targetThreadId: targetId,
    messageId: MessageId.make("assistant1"),
  }),
);

const forkUser = Effect.flatMap(ThreadFork.ThreadFork, (service) =>
  service.fork({
    threadId: sourceId,
    targetThreadId: targetId,
    messageId: MessageId.make("user1"),
  }),
);

function interruptedSource(withReasoning = true) {
  const original = source();
  return decodeThread({
    ...original,
    session: { ...original.session, status: "stopped" },
    latestTurn: {
      turnId: "turn1",
      state: "interrupted",
      requestedAt: now,
      startedAt: now,
      completedAt: "2026-10-09T01:00:05.000Z",
      assistantMessageId: null,
    },
    messages: [
      original.messages[0],
      ...(withReasoning
        ? [
            {
              ...original.messages[1],
              id: "reasoning1",
              role: "reasoning",
              text: "Thinking before interruption",
            },
          ]
        : []),
    ],
    checkpoints: [{ ...original.checkpoints[0], assistantMessageId: "assistant:turn1" }],
  });
}

it.effect.each(["pending-message", "request-time", "no-output"] as const)(
  "forks an interrupted user-only turn with exact %s association without changing the source",
  (association) =>
    Effect.gen(function* () {
      const h = harness({
        source: interruptedSource(association !== "no-output"),
        expectedTexts: ["Remember ALPHA"],
        prepareTurns: (turns) =>
          turns.map((turn) => ({
            ...turn,
            state: "interrupted",
            requestedAt: now,
            pendingMessageId: association === "pending-message" ? MessageId.make("user1") : null,
          })),
      });
      yield* forkUser.pipe(Effect.provide(h.layer));
      const child = h.model().threads.find((thread) => thread.id === targetId)!;
      expect(child.messages.map((message) => [message.role, message.text])).toEqual([
        ["user", "Remember ALPHA"],
      ]);
      expect(child.messages[0]?.attachments).toEqual(h.original.messages[0]?.attachments);
      expect(h.forkCalls()).toBe(1);
      expect(h.model().threads.find((thread) => thread.id === sourceId)).toEqual(h.original);
    }),
);

it.effect.each(["ordinary", "queued-later-prompt"] as const)(
  "user-row fork includes its complete response and excludes later turns: %s",
  (scenario) =>
    Effect.gen(function* () {
      const original = source();
      const h = harness({
        source:
          scenario === "ordinary"
            ? original
            : {
                ...original,
                messages: [
                  original.messages[0]!,
                  original.messages[2]!,
                  original.messages[1]!,
                  original.messages[3]!,
                ],
              },
      });
      yield* forkUser.pipe(Effect.provide(h.layer));
      expect(
        h
          .model()
          .threads.find((thread) => thread.id === targetId)
          ?.messages.map((message) => message.text),
      ).toEqual(["Remember ALPHA", "ALPHA saved"]);
      expect(h.model().threads.find((thread) => thread.id === sourceId)).toEqual(h.original);
    }),
);

it.effect.each(["primary", "steering"] as const)(
  "forks the whole native turn from its verified %s message without changing the primary",
  (selected) =>
    Effect.gen(function* () {
      const original = source();
      const steering = {
        ...original.messages[0]!,
        id: MessageId.make("steering"),
        text: "Also remember GAMMA",
        createdAt: "2026-10-09T01:00:02.000Z",
      };
      const expectedTexts = ["Remember ALPHA", "ALPHA saved", steering.text];
      const h = harness({
        source: {
          ...original,
          messages: [...original.messages.slice(0, 2), steering, ...original.messages.slice(2)],
        },
        expectedTexts,
        prepareTurns: (turns) => {
          expect(turns[0]?.pendingMessageId).toBe("user1");
          return turns;
        },
      });
      yield* Effect.flatMap(ThreadFork.ThreadFork, (service) =>
        service.fork({
          threadId: sourceId,
          targetThreadId: targetId,
          messageId: MessageId.make(selected === "primary" ? "user1" : "steering"),
        }),
      ).pipe(Effect.provide(h.layer));
      expect(
        h
          .model()
          .threads.find((thread) => thread.id === targetId)
          ?.messages.map((message) => message.text),
      ).toEqual(expectedTexts);
      expect(h.model().threads.find((thread) => thread.id === sourceId)).toEqual(h.original);
      expect(h.forkCalls()).toBe(1);
    }),
);

it.effect("rejects a stored membership that contradicts the persisted primary prompt", () =>
  Effect.gen(function* () {
    const original = source();
    const h = harness({
      source: {
        ...original,
        messages: original.messages.map((message) =>
          message.id === "user1" ? { ...message, turnId: TurnId.make("turn2") } : message,
        ),
      },
    });
    yield* forkUser.pipe(Effect.provide(h.layer), Effect.flip);
    expect(h.forkCalls()).toBe(0);
    expect(h.model().threads).toEqual([h.original]);
  }),
);

it.effect.each([
  "duplicate-users",
  "duplicate-turns",
  "no-match",
  "pending-turn",
  "conflicting-turn-id",
] as const)("rejects unsafe user-turn associations before any child or native fork: %s", (reason) =>
  Effect.gen(function* () {
    const interrupted = interruptedSource();
    const original = {
      ...interrupted,
      messages: interrupted.messages.map((message) =>
        message.role === "user" ? { ...message, turnId: null } : message,
      ),
    };
    const h = harness({
      source:
        reason === "duplicate-users"
          ? {
              ...original,
              messages: [
                original.messages[0]!,
                { ...original.messages[0]!, id: MessageId.make("other-user") },
                original.messages[1]!,
              ],
            }
          : reason === "conflicting-turn-id"
            ? {
                ...original,
                messages: [
                  { ...original.messages[0]!, turnId: TurnId.make("different-turn") },
                  original.messages[1]!,
                ],
              }
            : original,
      prepareTurns: (turns) => {
        const turn = {
          ...turns[0]!,
          state: "interrupted" as const,
          requestedAt: now,
          pendingMessageId: null,
        };
        if (reason === "duplicate-turns")
          return [turn, { ...turn, turnId: TurnId.make("other-turn"), checkpointTurnCount: 2 }];
        if (reason === "pending-turn")
          return [
            turn,
            {
              ...turn,
              turnId: null,
              state: "pending",
              completedAt: null,
              checkpointTurnCount: null,
            },
          ];
        return [{ ...turn, requestedAt: reason === "no-match" ? "2026-10-09T01:00:01.000Z" : now }];
      },
    });
    yield* forkUser.pipe(Effect.provide(h.layer), Effect.flip);
    expect(h.forkCalls()).toBe(0);
    expect(h.stopCalls()).toBe(0);
    expect(h.model().threads).toEqual([h.original]);
  }),
);

it.effect.each(["unindexed", "misordered"] as const)(
  "rejects %s persisted history before creating a child or invoking the provider",
  (historyIssue) =>
    Effect.gen(function* () {
      const h = harness({ historyIssue });
      const result = yield* fork.pipe(Effect.provide(h.layer), Effect.flip);
      expect(result.detail).toContain("Complete a new turn");
      expect(h.forkCalls()).toBe(0);
      expect(h.stopCalls()).toBe(0);
      expect(h.model().threads).toEqual([h.original]);
    }),
);

it.effect(
  "forks a completed non-Git turn, preserves attachments and the source, and retains the inherited prefix after editing the child",
  () =>
    Effect.gen(function* () {
      const h = harness();
      yield* fork.pipe(Effect.provide(h.layer));
      const child = h.model().threads.find((t) => t.id === targetId)!;
      expect(child.messages.map((m) => m.text)).toEqual(["Remember ALPHA", "ALPHA saved"]);
      expect(child.messages[0]?.attachments).toEqual(h.original.messages[0]?.attachments);
      expect(child.checkpoints).toEqual([]);
      expect(h.model().threads.find((t) => t.id === sourceId)).toEqual(h.original);
      yield* h.dispatch({
        type: "thread.message.user.append",
        commandId: CommandId.make("child-user"),
        threadId: targetId,
        message: { messageId: MessageId.make("child-user"), text: "Own turn", attachments: [] },
        createdAt: now,
      });
      yield* h.dispatch({
        type: "thread.message.assistant.delta",
        commandId: CommandId.make("child-assistant"),
        threadId: targetId,
        messageId: MessageId.make("child-assistant"),
        delta: "Own response",
        turnId: TurnId.make("child-turn"),
        createdAt: now,
      });
      yield* h.dispatch({
        type: "thread.revert.complete",
        commandId: CommandId.make("child-revert"),
        threadId: targetId,
        turnCount: 0,
        createdAt: now,
      });
      expect(
        h
          .model()
          .threads.find((t) => t.id === targetId)
          ?.messages.map((m) => m.text),
      ).toEqual(["Remember ALPHA", "ALPHA saved"]);
    }),
);

it.effect("rejects a busy source without touching the provider or publishing a child", () =>
  Effect.gen(function* () {
    const h = harness({ busy: true });
    const error = yield* fork.pipe(Effect.provide(h.layer), Effect.flip);
    expect(error.message).toContain("finish");
    expect(h.forkCalls()).toBe(0);
    expect(h.model().threads).toHaveLength(1);
  }),
);

it.effect("removes the incomplete child when the native fork fails", () =>
  Effect.gen(function* () {
    const h = harness({ failNative: true });
    yield* fork.pipe(Effect.provide(h.layer), Effect.flip);
    expect(h.model().threads.filter((thread) => !thread.deletedAt)).toHaveLength(1);
    expect(h.model().threads[0]).toEqual(h.original);
  }),
);

it.effect("cleans up a native child when history persistence fails", () =>
  Effect.gen(function* () {
    const h = harness({ failImport: true });
    yield* fork.pipe(Effect.provide(h.layer), Effect.exit);
    expect(h.stopCalls()).toBe(1);
    expect(h.model().threads.find((t) => t.id === targetId)?.deletedAt).not.toBeNull();
    expect(h.model().threads.find((t) => t.id === sourceId)).toEqual(h.original);
  }),
);
