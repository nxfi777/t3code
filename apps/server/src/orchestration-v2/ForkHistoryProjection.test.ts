import { assert, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Tracer from "effect/Tracer";
import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

const layer = Layer.mergeAll(ProjectionStore.layer, OrchestrationEventStore.layer).pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
);

it.effect.each(["captured", "legacy"] as const)(
  "keeps fork history at its event boundary across edits and nested forks (%s)",
  (mode) =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const events = yield* OrchestrationEventStore.OrchestrationEventStore;
      // Every event deliberately has the same timestamp; only event order is usable.
      const now = DateTime.makeUnsafe("2026-10-16T12:00:00.000Z");
      const instanceId = ProviderInstanceId.make("codex");
      const modelSelection = { instanceId, model: "gpt-5.4" };
      let nextEvent = 0;
      const apply = (event: Omit<OrchestrationV2DomainEvent, "id" | "occurredAt">) =>
        Effect.gen(function* () {
          const full = {
            ...event,
            id: EventId.make(`fork-history-event-${++nextEvent}`),
            occurredAt: now,
          } as OrchestrationV2DomainEvent;
          yield* events.appendAgentEvents({ events: [full] });
          yield* store.apply(full);
        });
      const thread = (
        id: string,
        forkedFrom: OrchestrationV2AppThread["forkedFrom"] = null,
      ): OrchestrationV2AppThread => ({
        id: ThreadId.make(id),
        projectId: ProjectId.make("fork-history-project"),
        title: id,
        createdBy: "user",
        creationSource: "web",
        providerInstanceId: instanceId,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        activeProviderThreadId: null,
        forkedFrom,
        lineage: {
          parentThreadId: forkedFrom?.type === "run" ? forkedFrom.threadId : null,
          relationshipToParent: forkedFrom === null ? null : "fork",
          rootThreadId: ThreadId.make("source"),
        },
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      });
      const create = (value: OrchestrationV2AppThread) =>
        apply({ type: "thread.created", threadId: value.id, payload: value });
      const addRun = (owner: OrchestrationV2AppThread, ordinal: number, text: string) =>
        Effect.gen(function* () {
          const run: OrchestrationV2Run = {
            id: RunId.make(`${owner.id}:run:${ordinal}`),
            threadId: owner.id,
            ordinal,
            providerInstanceId: instanceId,
            modelSelection,
            providerThreadId: null,
            userMessageId: MessageId.make(`${owner.id}:message:${ordinal}`),
            rootNodeId: NodeId.make(`${owner.id}:node:${ordinal}`),
            activeAttemptId: null,
            status: "completed",
            requestedAt: now,
            startedAt: now,
            completedAt: now,
            checkpointId: null,
            contextHandoffId: null,
          };
          yield* apply({ type: "run.created", threadId: owner.id, runId: run.id, payload: run });
          yield* apply({
            type: "turn-item.updated",
            threadId: owner.id,
            runId: run.id,
            payload: {
              id: TurnItemId.make(`${owner.id}:item:${ordinal}`),
              threadId: owner.id,
              runId: run.id,
              nodeId: run.rootNodeId,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal,
              status: "completed",
              title: null,
              startedAt: now,
              completedAt: now,
              updatedAt: now,
              type: "user_message",
              messageId: run.userMessageId,
              inputIntent: "turn_start",
              text,
              attachments: [],
              createdBy: "user",
              creationSource: "web",
            },
          });
          return run;
        });
      const fork = (
        id: string,
        source: OrchestrationV2AppThread,
        run: OrchestrationV2Run,
        excluded: ReadonlyArray<RunId>,
      ) =>
        thread(id, {
          type: "run",
          threadId: source.id,
          runId: run.id,
          ...(mode === "captured" ? { excludedRunIds: excluded } : {}),
        });
      const source = thread("source");
      yield* create(source);
      yield* addRun(source, 1, "retained");
      const removed = yield* addRun(source, 2, "removed before new fork");
      const oldFork = fork("old-fork", source, removed, []);
      yield* create(oldFork);
      yield* apply({
        type: "run.updated",
        threadId: source.id,
        runId: removed.id,
        payload: { ...removed, status: "rolled_back", completedAt: now },
      });
      const edited = yield* addRun(source, 3, "edited replacement");
      const newFork = fork("new-fork", source, edited, [removed.id]);
      yield* create(newFork);
      const childRun = yield* addRun(newFork, 1, "child continuation");
      const nested = fork("nested-fork", newFork, childRun, []);
      yield* create(nested);
      // A second rollback after both forks must not change either captured prefix.
      yield* apply({
        type: "run.updated",
        threadId: source.id,
        runId: edited.id,
        payload: { ...edited, status: "rolled_back", completedAt: now },
      });
      const expected = new Map([
        [oldFork.id, ["retained", "removed before new fork"]],
        [newFork.id, ["retained", "edited replacement", "child continuation"]],
        [nested.id, ["retained", "edited replacement", "child continuation"]],
      ]);
      const textOf = (
        rows: ReadonlyArray<{ readonly item: { readonly type: string; readonly text?: string } }>,
      ) => rows.filter((row) => row.item.type === "user_message").map((row) => row.item.text);
      const queries: string[] = [];
      const tracer = Tracer.make({
        span(options) {
          const span = new Tracer.NativeSpan(options);
          const end = span.end.bind(span);
          span.end = (endTime, exit) => {
            end(endTime, exit);
            const query = span.attributes.get("db.query.text");
            if (typeof query === "string") queries.push(query);
          };
          return span;
        },
      });
      const shell = yield* store.getShellSnapshot().pipe(Effect.withTracer(tracer));
      assert.equal(
        queries.filter((query) =>
          query.includes("FROM orchestration_events INDEXED BY idx_orch_events_stream_sequence"),
        ).length,
        mode === "legacy" ? 1 : 0,
      );
      for (const [id, texts] of expected) {
        const full = yield* store.getThreadProjection(id);
        assert.deepEqual(textOf(full.visibleTurnItems), texts);
        assert.equal(
          (yield* store.getThreadShell(id))?.visibleItemCount,
          full.visibleTurnItems.length,
        );
        assert.equal(
          shell.threads.find((t) => t.id === id)?.visibleItemCount,
          full.visibleTurnItems.length,
        );
        const page = yield* store.getTimelinePage(id, { view: "activity", limit: 100 });
        assert.deepEqual(page.items, full.visibleTurnItems);
        const bounded = yield* store.getThreadSnapshotWindow(id, {
          rowLimit: 100,
          userTurnLimit: 100,
        });
        assert.deepEqual(textOf(bounded.projection.visibleTurnItems), texts);
        const tail = yield* store.getThreadSnapshotWindow(id, { rowLimit: 1, userTurnLimit: 1 });
        assert.deepEqual(
          textOf(tail.projection.visibleTurnItems).filter((text) => !texts.includes(text!)),
          [],
        );
        assert.equal(textOf(tail.projection.visibleTurnItems).at(-1), texts.at(-1));
      }
      assert.deepEqual(textOf((yield* store.getThreadProjection(source.id)).visibleTurnItems), [
        "retained",
      ]);
    }).pipe(Effect.provide(layer)),
);

it("old protocol-2 fork metadata decoders accept and ignore captured exclusions", () => {
  const oldForkSchema = Schema.Struct({
    type: Schema.Literal("run"),
    threadId: ThreadId,
    runId: RunId,
  });
  const legacy = { type: "run", threadId: "source", runId: "source:run:3" };
  assert.deepEqual(
    Schema.decodeUnknownSync(oldForkSchema)({ ...legacy, excludedRunIds: ["source:run:2"] }),
    legacy,
  );
});
