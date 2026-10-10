import { CommandId, MessageId, type OrchestrationRpcSchemas } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { compareDateTimeStrings } from "@t3tools/shared/dateTime";
import * as OrchestrationEngine from "./Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "./Services/ProjectionSnapshotQuery.ts";
import * as ProviderService from "../provider/Services/ProviderService.ts";
import { ProjectionTurnRepository } from "../persistence/Services/ProjectionTurns.ts";
import { ProjectionTurnRepositoryLive } from "../persistence/Layers/ProjectionTurns.ts";

type ForkInput = typeof OrchestrationRpcSchemas.forkThread.input.Type;

export class ThreadForkError extends Schema.TaggedError<ThreadForkError>()("ThreadForkError", {
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message() {
    return this.detail;
  }
}

export class ThreadFork extends Context.Service<
  ThreadFork,
  {
    readonly fork: (input: ForkInput) => Effect.Effect<void, ThreadForkError>;
  }
>()("t3/orchestration/ThreadFork") {}

const isThreadForkError = Schema.is(ThreadForkError);

export const make = Effect.gen(function* () {
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const providers = yield* ProviderService.ProviderService;
  const projectionTurns = yield* ProjectionTurnRepository;
  const fork = Effect.fn("ThreadFork.fork")(
    function* (input: ForkInput) {
      const source = yield* snapshots.getThreadDetailById(input.threadId);
      if (Option.isNone(source))
        return yield* new ThreadForkError({ detail: "Source thread is unavailable." });
      const thread = source.value;
      if (
        thread.session?.status === "running" ||
        thread.session?.status === "starting" ||
        thread.session?.activeTurnId
      ) {
        return yield* new ThreadForkError({
          detail: "Wait for the current turn to finish before forking.",
        });
      }
      if (Option.isSome(yield* snapshots.getThreadDetailById(input.targetThreadId))) {
        return yield* new ThreadForkError({ detail: "The fork destination already exists." });
      }
      const selectedIndex = thread.messages.findIndex((message) => message.id === input.messageId);
      const selectedMessage = thread.messages[selectedIndex];
      if (
        !selectedMessage ||
        selectedMessage.streaming ||
        (selectedMessage.role !== "assistant" && selectedMessage.role !== "user")
      )
        return yield* new ThreadForkError({
          detail: "Choose a message from a finished turn with a saved conversation boundary.",
        });
      const persistedTurns = yield* projectionTurns.listByThreadId({ threadId: thread.id });
      const turns = persistedTurns
        .filter((turn) => turn.turnId !== null)
        .toSorted(
          (left, right) =>
            compareDateTimeStrings(left.requestedAt, right.requestedAt) ||
            compareDateTimeStrings(
              left.startedAt ?? left.requestedAt,
              right.startedAt ?? right.requestedAt,
            ) ||
            (left.checkpointTurnCount ?? 0) - (right.checkpointTurnCount ?? 0),
        );
      const userMessages = thread.messages.filter((message) => message.role === "user");
      const turnForUserMessage = (message: (typeof userMessages)[number]) => {
        const byMessageId = turns.filter((turn) => turn.pendingMessageId === message.id);
        if (byMessageId.length > 0) return byMessageId.length === 1 ? byMessageId[0] : undefined;
        // Older projections did not retain pendingMessageId. Only an exact,
        // unique request timestamp is safe; a nearby message may be steering
        // or a queued prompt belonging to a later native turn.
        if (userMessages.filter((entry) => entry.createdAt === message.createdAt).length !== 1)
          return undefined;
        const byRequestedAt = turns.filter(
          (turn) => turn.pendingMessageId === null && turn.requestedAt === message.createdAt,
        );
        return byRequestedAt.length === 1 ? byRequestedAt[0] : undefined;
      };
      const selectedUserTurn =
        selectedMessage.role === "user" ? turnForUserMessage(selectedMessage) : undefined;
      const boundary = thread.checkpoints.find((checkpoint) =>
        selectedMessage.role === "user"
          ? checkpoint.turnId === selectedUserTurn?.turnId
          : checkpoint.assistantMessageId === selectedMessage.id,
      );
      if (
        !boundary ||
        (selectedMessage.role === "user" &&
          selectedMessage.turnId !== null &&
          selectedMessage.turnId !== selectedUserTurn?.turnId)
      )
        return yield* new ThreadForkError({
          detail:
            "The exact finished turn for this message is unavailable. Choose a response with a saved conversation boundary.",
        });
      if (
        turns.find((turn) => turn.turnId === boundary.turnId)?.checkpointTurnCount !==
          boundary.checkpointTurnCount ||
        persistedTurns.some((turn) => turn.turnId === null) ||
        turns.some(
          (turn, index) =>
            turn.checkpointTurnCount !== index + 1 ||
            turn.state === "running" ||
            turn.state === "pending" ||
            turn.completedAt === null,
        )
      )
        return yield* new ThreadForkError({
          detail:
            "Conversation history has unindexed or ambiguous turns. Complete a new turn to repair its boundaries before forking.",
        });
      // A user-row fork means AFTER its whole finished turn, including any
      // replies. A stopped turn can have only reasoning and no assistant text.
      const end =
        selectedMessage.role === "user"
          ? thread.messages.reduce(
              (last, message, index) =>
                message.turnId === boundary.turnId ? Math.max(last, index) : last,
              selectedIndex,
            )
          : selectedIndex;
      const laterTurnIds = new Set(
        turns.slice(boundary.checkpointTurnCount).map((turn) => turn.turnId),
      );
      const laterUserMessageIds = new Set(
        userMessages.flatMap((message) => {
          const turn = turnForUserMessage(message);
          return turn && laterTurnIds.has(turn.turnId) ? [message.id] : [];
        }),
      );
      const messages = thread.messages
        .slice(0, end + 1)
        .filter(
          (message) =>
            (message.role === "user" || message.role === "assistant") &&
            !laterTurnIds.has(message.turnId) &&
            !laterUserMessageIds.has(message.id),
        );
      const createdAt = DateTime.formatIso(yield* DateTime.now);
      const commandId = (step: string) => CommandId.make(`fork:${input.targetThreadId}:${step}`);
      let created = false;
      yield* Effect.gen(function* () {
        yield* engine.dispatch({
          type: "thread.create",
          commandId: commandId("create"),
          threadId: input.targetThreadId,
          projectId: thread.projectId,
          title: `${thread.title} (fork)`,
          modelSelection: thread.modelSelection,
          runtimeMode: thread.runtimeMode,
          interactionMode: thread.interactionMode,
          branch: thread.branch,
          worktreePath: thread.worktreePath,
          createdAt,
          historyImport: true,
        });
        created = true;
        // Import ids preserve the inherited prefix when a later child turn is rewound.
        // No source checkpoints are copied: the child's own turns start at one.
        yield* engine.dispatch({
          type: "thread.history.import",
          commandId: commandId("history"),
          threadId: input.targetThreadId,
          messages: messages.map((message, index) => ({
            messageId: MessageId.make(`import:fork:${input.targetThreadId}:${index}`),
            role: message.role as "user" | "assistant",
            text: message.text,
            createdAt: message.createdAt,
            ...(message.attachments ? { attachments: message.attachments } : {}),
            ...(message.context ? { context: message.context } : {}),
          })),
        });
        // Complete the import before adapters emit session events: history.import
        // requires an empty session, even when event ingestion is delayed.
        yield* engine.dispatch({
          type: "thread.session.set",
          commandId: commandId("starting"),
          threadId: input.targetThreadId,
          createdAt,
          session: {
            threadId: input.targetThreadId,
            providerName: thread.session?.providerName ?? null,
            providerInstanceId: thread.modelSelection.instanceId,
            runtimeMode: thread.runtimeMode,
            status: "starting",
            activeTurnId: null,
            lastError: null,
            updatedAt: createdAt,
          },
        });
        const session = yield* providers.forkThread({
          sourceThreadId: thread.id,
          targetThreadId: input.targetThreadId,
          sourceTurnId: boundary.turnId,
          retainedTurnCount: boundary.checkpointTurnCount,
        });
        yield* engine.dispatch({
          type: "thread.session.set",
          commandId: commandId("session"),
          threadId: input.targetThreadId,
          createdAt,
          session: {
            threadId: input.targetThreadId,
            providerName: session.provider,
            ...(session.providerInstanceId
              ? { providerInstanceId: session.providerInstanceId }
              : {}),
            runtimeMode: thread.runtimeMode,
            status: "ready",
            activeTurnId: null,
            lastError: null,
            updatedAt: createdAt,
          },
        });
      }).pipe(
        Effect.onError(() =>
          Effect.gen(function* () {
            yield* providers.stopSession({ threadId: input.targetThreadId }).pipe(Effect.ignore);
            if (created)
              yield* engine
                .dispatch({
                  type: "thread.delete",
                  commandId: commandId("cleanup"),
                  threadId: input.targetThreadId,
                })
                .pipe(Effect.ignore);
          }),
        ),
      );
    },
    Effect.mapError((cause) =>
      isThreadForkError(cause) ? cause : new ThreadForkError({ detail: cause.message, cause }),
    ),
  );
  return ThreadFork.of({ fork });
});

export const layer = Layer.effect(ThreadFork, make).pipe(
  Layer.provide(ProjectionTurnRepositoryLive),
);
