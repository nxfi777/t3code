// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";

import {
  VcsProcessTimeoutError,
  VcsProcessSpawnError,
  ProviderDriverKind,
  ProviderRuntimeEvent,
  ProviderSession,
  ProviderInstanceId,
} from "@t3tools/contracts";
import {
  CommandId,
  CheckpointRef,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { it as effectIt } from "@effect/vitest";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import * as CheckpointStore from "../../checkpointing/CheckpointStore.ts";
import * as VcsDriverRegistry from "../../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import { VcsStatusBroadcaster } from "../../vcs/VcsStatusBroadcaster.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import { CheckpointReactorLive } from "./CheckpointReactor.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../ThreadPlanProgress.ts";
import { RuntimeReceiptBusTest } from "./RuntimeReceiptBus.ts";
import * as RuntimeReceiptBus from "../Services/RuntimeReceiptBus.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";
import { CheckpointReactor } from "../Services/CheckpointReactor.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  ProviderService,
  type ProviderServiceShape,
} from "../../provider/Services/ProviderService.ts";
import { checkpointRefForThreadTurn } from "../../checkpointing/Utils.ts";
import { ProviderValidationError } from "../../provider/Errors.ts";
import { ServerConfig } from "../../config.ts";
import * as WorkspaceEntries from "../../workspace/WorkspaceEntries.ts";
import * as WorkspacePaths from "../../workspace/WorkspacePaths.ts";
import { PullRequestService } from "../../pullRequest/PullRequestService.ts";
import { ServerActivation } from "../../serverActivation.ts";

const asProjectId = (value: string): ProjectId => ProjectId.make(value);
const asTurnId = (value: string): TurnId => TurnId.make(value);

type LegacyProviderRuntimeEvent = {
  readonly type: string;
  readonly eventId: EventId;
  readonly provider: ProviderDriverKind;
  readonly createdAt: string;
  readonly threadId: ThreadId;
  readonly turnId?: string | undefined;
  readonly itemId?: string | undefined;
  readonly requestId?: string | undefined;
  readonly payload?: unknown | undefined;
  readonly [key: string]: unknown;
};

function createProviderServiceHarness(
  cwd: string,
  hasSession = true,
  sessionCwd = cwd,
  providerName: ProviderSession["provider"] = ProviderDriverKind.make("codex"),
) {
  const now = "2026-01-01T00:00:00.000Z";
  const runtimeEventPubSub = Effect.runSync(PubSub.unbounded<ProviderRuntimeEvent>());
  const rollbackConversation = vi.fn(
    (_input: { readonly threadId: ThreadId; readonly numTurns: number }) => Effect.void,
  );
  const assertConversationRollbackSupported = vi.fn<
    ProviderServiceShape["assertConversationRollbackSupported"]
  >(() => Effect.void);

  const unsupported = <A>() =>
    Effect.die(new Error("Unsupported provider call in test")) as Effect.Effect<A, never>;
  const listSessions = () =>
    hasSession
      ? Effect.succeed([
          {
            provider: providerName,
            status: "ready",
            runtimeMode: "full-access",
            threadId: ThreadId.make("thread-1"),
            cwd: sessionCwd,
            createdAt: now,
            updatedAt: now,
          },
        ] satisfies ReadonlyArray<ProviderSession>)
      : Effect.succeed([] as ReadonlyArray<ProviderSession>);
  const service: ProviderServiceShape = {
    forkThread: () => Effect.die("Unexpected fork in this test"),
    startSession: () => unsupported(),
    sendTurn: () => unsupported(),
    compactThread: () => unsupported(),
    interruptTurn: () => unsupported(),
    respondToRequest: () => unsupported(),
    respondToUserInput: () => unsupported(),
    stopSession: () => unsupported(),
    listSessions,
    getCapabilities: () => Effect.succeed({ sessionModelSwitch: "in-session" }),
    assertConversationRollbackSupported,
    getInstanceInfo: (instanceId) =>
      Effect.succeed({
        instanceId,
        driverKind: ProviderDriverKind.make(providerName),
        displayName: undefined,
        enabled: true,
        continuationIdentity: {
          driverKind: ProviderDriverKind.make(providerName),
          continuationKey: `${providerName}:instance:${instanceId}`,
        },
      }),
    rollbackConversation,
    uploadFeedback: () => unsupported(),
    get streamEvents() {
      return Stream.fromPubSub(runtimeEventPubSub);
    },
  };

  const emit = (event: LegacyProviderRuntimeEvent): void => {
    Effect.runSync(PubSub.publish(runtimeEventPubSub, event as unknown as ProviderRuntimeEvent));
  };

  return {
    service,
    assertConversationRollbackSupported,
    rollbackConversation,
    emit,
  };
}

async function waitForThread(
  readModel: () => Promise<{
    readonly threads: ReadonlyArray<{
      readonly id: ThreadId;
      readonly latestTurn: { readonly turnId: string } | null;
      readonly checkpoints: ReadonlyArray<{ readonly checkpointTurnCount: number }>;
      readonly activities: ReadonlyArray<{ readonly kind: string }>;
    }>;
  }>,
  predicate: (thread: {
    latestTurn: { turnId: string } | null;
    checkpoints: ReadonlyArray<{ checkpointTurnCount: number }>;
    activities: ReadonlyArray<{ kind: string }>;
  }) => boolean,
  timeoutMs = 15_000,
) {
  const deadline = (await Effect.runPromise(Clock.currentTimeMillis)) + timeoutMs;
  const poll = async (): Promise<{
    latestTurn: { turnId: string } | null;
    checkpoints: ReadonlyArray<{ checkpointTurnCount: number }>;
    activities: ReadonlyArray<{ kind: string }>;
  }> => {
    const snapshot = await readModel();
    const thread = snapshot.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    if (thread && predicate(thread)) {
      return thread;
    }
    if ((await Effect.runPromise(Clock.currentTimeMillis)) >= deadline) {
      throw new Error("Timed out waiting for thread state.");
    }
    await Effect.runPromise(Effect.sleep("10 millis"));
    return poll();
  };
  return poll();
}

async function waitForEvent(
  engine: OrchestrationEngineShape,
  predicate: (event: { type: string }) => boolean,
  timeoutMs = 15_000,
) {
  const deadline = (await Effect.runPromise(Clock.currentTimeMillis)) + timeoutMs;
  const poll = async () => {
    const events = await Effect.runPromise(
      Stream.runCollect(engine.readEvents(0)).pipe(Effect.map((chunk) => Array.from(chunk))),
    );
    if (events.some(predicate)) {
      return events;
    }
    if ((await Effect.runPromise(Clock.currentTimeMillis)) >= deadline) {
      throw new Error("Timed out waiting for orchestration event.");
    }
    await Effect.runPromise(Effect.sleep("10 millis"));
    return poll();
  };
  return poll();
}

function runGit(cwd: string, args: ReadonlyArray<string>) {
  return NodeChildProcess.execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
}

function createGitRepository() {
  const cwd = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-checkpoint-handler-"));
  runGit(cwd, ["init", "--initial-branch=main"]);
  runGit(cwd, ["config", "user.email", "test@example.com"]);
  runGit(cwd, ["config", "user.name", "Test User"]);
  NodeFS.writeFileSync(NodePath.join(cwd, "README.md"), "v1\n", "utf8");
  runGit(cwd, ["add", "."]);
  runGit(cwd, ["commit", "-m", "Initial"]);
  return cwd;
}

function gitRefExists(cwd: string, ref: string): boolean {
  try {
    runGit(cwd, ["show-ref", "--verify", "--quiet", ref]);
    return true;
  } catch {
    return false;
  }
}

function gitShowFileAtRef(cwd: string, ref: string, filePath: string): string {
  return runGit(cwd, ["show", `${ref}:${filePath}`]);
}

async function waitForGitRefExists(cwd: string, ref: string, timeoutMs = 15_000) {
  const deadline = (await Effect.runPromise(Clock.currentTimeMillis)) + timeoutMs;
  const poll = async (): Promise<void> => {
    if (gitRefExists(cwd, ref)) {
      return;
    }
    if ((await Effect.runPromise(Clock.currentTimeMillis)) >= deadline) {
      throw new Error(`Timed out waiting for git ref '${ref}'.`);
    }
    await Effect.runPromise(Effect.sleep("10 millis"));
    return poll();
  };
  return poll();
}

describe("CheckpointReactor", () => {
  let runtime: ManagedRuntime.ManagedRuntime<
    | OrchestrationEngineService
    | CheckpointReactor
    | CheckpointStore.CheckpointStore
    | ProjectionSnapshotQuery
    | RuntimeReceiptBus.RuntimeReceiptBus,
    unknown
  > | null = null;
  let scope: Scope.Closeable | null = null;
  const tempDirs: string[] = [];

  afterEach(async () => {
    if (scope) {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }
    scope = null;
    if (runtime) {
      await runtime.dispose();
    }
    runtime = null;
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        NodeFS.rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  async function createHarness(options?: {
    readonly startReactor?: boolean;
    readonly checkpointLookupFailure?: (
      cwd: string,
    ) => VcsProcessTimeoutError | VcsProcessSpawnError | undefined;
    readonly workspaceRefresh?: (cwd: string) => Effect.Effect<void>;
    readonly hasSession?: boolean;
    readonly seedFilesystemCheckpoints?: boolean;
    readonly initializeGit?: boolean;
    readonly projectWorkspaceRoot?: string;
    readonly threadWorktreePath?: string | null;
    readonly threadBranch?: string | null;
    readonly secondThreadSharingWorktree?: boolean;
    readonly secondThreadWorktreePath?: (cwd: string) => string;
    readonly localStatusRefName?: string | null;
    readonly providerSessionCwd?: string;
    readonly providerName?: ProviderDriverKind;
    readonly gitStatusRefreshCalls?: Array<string>;
    readonly pullRequestRefreshCalls?: Array<string>;
    readonly pullRequestRefresh?: Effect.Effect<void>;
  }) {
    const cwd = createGitRepository();
    if (options?.initializeGit === false) {
      NodeFS.rmSync(NodePath.join(cwd, ".git"), { recursive: true });
    }
    tempDirs.push(cwd);
    const provider = createProviderServiceHarness(
      cwd,
      options?.hasSession ?? true,
      options?.providerSessionCwd ?? cwd,
      options?.providerName ?? ProviderDriverKind.make("codex"),
    );
    const orchestrationLayer = OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(ThreadBackgroundLiveness.layer),
      Layer.provide(ThreadPlanProgress.layer),
      Layer.provide(OrchestrationProjectionPipelineLive),
      Layer.provide(OrchestrationEventStoreLive),
      Layer.provide(OrchestrationCommandReceiptRepositoryLive),
      Layer.provide(RepositoryIdentityResolver.layer),
      Layer.provide(SqlitePersistenceMemory),
    );
    const projectionSnapshotLayer = OrchestrationProjectionSnapshotQueryLive.pipe(
      Layer.provide(ThreadBackgroundLiveness.layer),
      Layer.provide(ThreadPlanProgress.layer),
      Layer.provide(RepositoryIdentityResolver.layer),
      Layer.provide(SqlitePersistenceMemory),
    );

    const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
      prefix: "t3-checkpoint-reactor-test-",
    });
    const pullRequestRefreshes: number[] = [];
    const refreshAfterTurn = () => Effect.sync(() => void pullRequestRefreshes.push(1));
    const vcsStatusBroadcasterLayer = Layer.succeed(VcsStatusBroadcaster, {
      getStatus: () => Effect.die("getStatus should not be called in this test"),
      refreshLocalStatus: (cwd: string) =>
        Effect.sync(() => {
          options?.gitStatusRefreshCalls?.push(cwd);
        }).pipe(
          Effect.as({
            isRepo: true,
            hasPrimaryRemote: false,
            isDefaultRef:
              options?.localStatusRefName === undefined || options.localStatusRefName === "main",
            refName:
              options?.localStatusRefName !== undefined ? options.localStatusRefName : "main",
            hasWorkingTreeChanges: false,
            workingTree: { files: [], insertions: 0, deletions: 0 },
          }),
        ),
      refreshStatus: () => Effect.die("refreshStatus should not be called in this test"),
      refreshPullRequestStatus: (cwd: string) =>
        Effect.sync(() => {
          options?.pullRequestRefreshCalls?.push(cwd);
        }).pipe(Effect.andThen(options?.pullRequestRefresh ?? Effect.void), Effect.as(null)),
      streamStatus: () => Stream.empty,
    });

    const layer = CheckpointReactorLive.pipe(
      Layer.provideMerge(orchestrationLayer),
      Layer.provideMerge(projectionSnapshotLayer),
      Layer.provideMerge(RuntimeReceiptBusTest),
      Layer.provideMerge(Layer.succeed(ProviderService, provider.service)),
      Layer.provideMerge(Layer.mock(PullRequestService)({ refreshAfterTurn })),
      Layer.provideMerge(vcsStatusBroadcasterLayer),
      Layer.provideMerge(
        Layer.effect(
          CheckpointStore.CheckpointStore,
          CheckpointStore.make.pipe(
            Effect.map((store) => ({
              ...store,
              hasCheckpointRef: (input) => {
                const failure = options?.checkpointLookupFailure?.(input.cwd);
                return failure ? Effect.fail(failure) : store.hasCheckpointRef(input);
              },
            })),
          ),
        ).pipe(Layer.provide(VcsDriverRegistry.layer)),
      ),
      Layer.provideMerge(
        (options?.workspaceRefresh
          ? Layer.mock(WorkspaceEntries.WorkspaceEntries)({ refresh: options.workspaceRefresh })
          : WorkspaceEntries.layer
        ).pipe(Layer.provide(WorkspacePaths.layer), Layer.provideMerge(VcsDriverRegistry.layer)),
      ),
      Layer.provideMerge(WorkspacePaths.layer),
      Layer.provideMerge(VcsProcess.layer),
      Layer.provideMerge(ServerConfigLayer),
      Layer.provideMerge(NodeServices.layer),
      Layer.provideMerge(SqlitePersistenceMemory),
    );

    runtime = ManagedRuntime.make(layer);
    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    const snapshotQuery = await runtime.runPromise(Effect.service(ProjectionSnapshotQuery));
    const reactor = await runtime.runPromise(Effect.service(CheckpointReactor));
    const checkpointStore = await runtime.runPromise(
      Effect.service(CheckpointStore.CheckpointStore),
    );
    const receiptBus = await runtime.runPromise(
      Effect.service(RuntimeReceiptBus.RuntimeReceiptBus),
    );
    const testScope = await Effect.runPromise(Scope.make("sequential"));
    scope = testScope;
    const receipts = await Effect.runPromise(
      Effect.gen(function* () {
        const receipts = yield* Queue.unbounded<RuntimeReceiptBus.OrchestrationRuntimeReceipt>();
        yield* Stream.runForEach(receiptBus.streamEventsForTest, (receipt) =>
          Queue.offer(receipts, receipt),
        ).pipe(Effect.forkIn(testScope, { startImmediately: true }));
        if (options?.startReactor !== false) yield* reactor.start().pipe(Scope.provide(testScope));
        return receipts;
      }),
    );
    const drain = () => Effect.runPromise(reactor.drain);

    const createdAt = "2026-01-01T00:00:00.000Z";
    await Effect.runPromise(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-create"),
        projectId: asProjectId("project-1"),
        title: "Test Project",
        workspaceRoot: options?.projectWorkspaceRoot ?? cwd,
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );
    await Effect.runPromise(
      engine
        .dispatch({
          type: "thread.create",
          commandId: CommandId.make("cmd-thread-create"),
          threadId: ThreadId.make("thread-1"),
          projectId: asProjectId("project-1"),
          title: "Thread",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: options?.threadBranch ?? null,
          worktreePath:
            options?.threadWorktreePath !== undefined ? options.threadWorktreePath : cwd,
          createdAt,
        })
        .pipe(
          options?.secondThreadSharingWorktree
            ? Effect.andThen(
                engine.dispatch({
                  type: "thread.create",
                  commandId: CommandId.make("cmd-thread-create-2"),
                  threadId: ThreadId.make("thread-2"),
                  projectId: asProjectId("project-1"),
                  title: "Thread 2",
                  modelSelection: {
                    instanceId: ProviderInstanceId.make("codex"),
                    model: "gpt-5-codex",
                  },
                  interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
                  runtimeMode: "approval-required",
                  branch: null,
                  worktreePath:
                    options?.secondThreadWorktreePath?.(cwd) ?? options?.threadWorktreePath ?? cwd,
                  createdAt,
                }),
              )
            : Effect.asVoid,
        ),
    );

    if (options?.seedFilesystemCheckpoints ?? true) {
      await runtime.runPromise(
        checkpointStore.captureCheckpoint({
          cwd,
          checkpointRef: checkpointRefForThreadTurn(ThreadId.make("thread-1"), 0),
        }),
      );
      NodeFS.writeFileSync(NodePath.join(cwd, "README.md"), "v2\n", "utf8");
      await runtime.runPromise(
        checkpointStore.captureCheckpoint({
          cwd,
          checkpointRef: checkpointRefForThreadTurn(ThreadId.make("thread-1"), 1),
        }),
      );
      NodeFS.writeFileSync(NodePath.join(cwd, "README.md"), "v3\n", "utf8");
      await runtime.runPromise(
        checkpointStore.captureCheckpoint({
          cwd,
          checkpointRef: checkpointRefForThreadTurn(ThreadId.make("thread-1"), 2),
        }),
      );
    }

    return {
      engine,
      readModel: () => Effect.runPromise(snapshotQuery.getSnapshot()),
      provider,
      cwd,
      drain,
      startReactor: (activation?: Effect.Effect<void>) =>
        Effect.runPromise(
          reactor
            .start()
            .pipe(Scope.provide(testScope), Effect.provideService(ServerActivation, activation)),
        ),
      nextReceipt: Queue.take(receipts),
      pullRequestRefreshes,
    };
  }

  effectIt.effect.each([
    "active",
    "archived",
    "alias",
    "nested",
    "ancestor",
    "project-root",
    "conversation",
  ] as const)("preserves sibling files when reverting a shared workspace, owner=%s", (owner) =>
    Effect.gen(function* () {
      const harness = yield* Effect.promise(() =>
        createHarness({
          secondThreadSharingWorktree: true,
          ...(owner === "alias" || owner === "nested" || owner === "ancestor"
            ? {
                secondThreadWorktreePath: (cwd: string) => {
                  if (owner === "ancestor") return NodePath.dirname(cwd);
                  if (owner === "nested") {
                    const nested = NodePath.join(cwd, "nested-owner");
                    NodeFS.mkdirSync(nested);
                    return nested;
                  }
                  const alias = `${cwd}-alias`;
                  NodeFS.symlinkSync(cwd, alias, "junction");
                  tempDirs.push(alias);
                  return alias;
                },
              }
            : {}),
        }),
      );
      const createdAt = "2026-01-01T00:00:02.000Z";
      if (owner === "archived")
        yield* harness.engine.dispatch({
          type: "thread.archive",
          commandId: CommandId.make("cmd-archive-owner"),
          threadId: ThreadId.make("thread-2"),
        });
      if (owner === "project-root")
        yield* harness.engine.dispatch({
          type: "thread.meta.update",
          commandId: CommandId.make("cmd-root-owner"),
          threadId: ThreadId.make("thread-2"),
          worktreePath: null,
        });
      const siblingFile = NodePath.join(
        harness.cwd,
        ...(owner === "nested" ? ["nested-owner"] : []),
        "sibling-work.txt",
      );
      NodeFS.writeFileSync(siblingFile, "sibling work\n");
      yield* harness.engine.dispatch({
        type: owner === "conversation" ? "thread.conversation.revert" : "thread.checkpoint.revert",
        commandId: CommandId.make("cmd-shared-revert"),
        threadId: ThreadId.make("thread-1"),
        turnCount: 0,
        createdAt,
      });
      yield* Effect.promise(harness.drain);
      expect(NodeFS.readFileSync(siblingFile, "utf8")).toBe("sibling work\n");
      expect(NodeFS.readFileSync(NodePath.join(harness.cwd, "README.md"), "utf8")).toBe("v3\n");
      const model = yield* Effect.promise(harness.readModel);
      const failure = model.threads
        .find((t) => t.id === "thread-1")
        ?.activities.find((a) => a.kind === "checkpoint.revert.failed");
      if (owner === "conversation") expect(failure).toBeUndefined();
      else {
        expect(failure?.payload).toMatchObject({
          detail: expect.stringContaining("isolated worktree"),
        });
        expect(harness.provider.rollbackConversation).not.toHaveBeenCalled();
      }
    }),
  );

  effectIt.effect.each(["timeout", "spawn"] as const)(
    "captures and finalizes a turn when previous checkpoint lookup fails (%s)",
    (failureKind) =>
      Effect.gen(function* () {
        let failLookup = false;
        const harness = yield* Effect.promise(() =>
          createHarness({
            seedFilesystemCheckpoints: false,
            checkpointLookupFailure: (cwd) =>
              !failLookup
                ? undefined
                : failureKind === "timeout"
                  ? new VcsProcessTimeoutError({
                      operation: "test.refLookup",
                      command: "git",
                      cwd,
                      timeoutMs: 30000,
                    })
                  : new VcsProcessSpawnError({
                      operation: "test.refLookup",
                      command: "git",
                      cwd,
                      cause: new Error("transient lookup spawn failure"),
                    }),
          }),
        );
        const threadId = ThreadId.make("thread-1");
        const turnId = asTurnId("turn-ref-timeout");
        harness.provider.emit({
          type: "turn.started",
          eventId: EventId.make("evt-ref-start"),
          provider: ProviderDriverKind.make("codex"),
          createdAt: "2026-01-01T00:00:00.000Z",
          threadId,
          turnId,
        });
        expect(yield* harness.nextReceipt).toMatchObject({ type: "checkpoint.baseline.captured" });
        NodeFS.writeFileSync(NodePath.join(harness.cwd, "README.md"), "new snapshot\n");
        failLookup = true;
        harness.provider.emit({
          type: "turn.completed",
          eventId: EventId.make("evt-ref-complete"),
          provider: ProviderDriverKind.make("codex"),
          createdAt: "2026-01-01T00:00:01.000Z",
          threadId,
          turnId,
          payload: { state: "completed" },
        });
        yield* Effect.promise(harness.drain);
        const ref = checkpointRefForThreadTurn(threadId, 1);
        expect(gitShowFileAtRef(harness.cwd, ref, "README.md")).toBe("new snapshot\n");
        expect(yield* harness.nextReceipt).toMatchObject({
          type: "checkpoint.diff.finalized",
          turnId,
        });
        expect(yield* harness.nextReceipt).toMatchObject({
          type: "turn.processing.quiesced",
          turnId,
        });
        const model = yield* Effect.promise(harness.readModel);
        expect(model.threads[0]?.checkpoints[0]).toMatchObject({
          checkpointRef: ref,
          status: "ready",
          files: [],
        });
        expect(
          model.threads[0]?.activities.some((a) => a.kind === "checkpoint.capture.failed"),
        ).toBe(false);
      }),
  );

  effectIt.effect(
    "finalizes checkpoints in both workspaces while entry refresh is blocked and coalesces later scans",
    () =>
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const refreshCalls: string[] = [];
        let secondCwd = "";
        const harness = yield* Effect.promise(() =>
          createHarness({
            seedFilesystemCheckpoints: false,
            secondThreadSharingWorktree: true,
            secondThreadWorktreePath: () => {
              secondCwd = createGitRepository();
              tempDirs.push(secondCwd);
              return secondCwd;
            },
            workspaceRefresh: (cwd) =>
              Effect.gen(function* () {
                refreshCalls.push(cwd);
                if (refreshCalls.length === 1) {
                  yield* Deferred.succeed(entered, undefined);
                  yield* Deferred.await(release);
                }
              }),
          }),
        );
        for (const [index, threadId] of [
          "thread-1",
          "thread-2",
          "thread-1",
          "thread-1",
          "thread-1",
        ].entries()) {
          const turnId = asTurnId(`turn-refresh-${index}`);
          const id = ThreadId.make(threadId);
          harness.provider.emit({
            type: "turn.started",
            eventId: EventId.make(`evt-refresh-start-${index}`),
            provider: ProviderDriverKind.make("codex"),
            createdAt: "2026-01-01T00:00:00.000Z",
            threadId: id,
            turnId,
          });
          if (index < 2)
            expect(yield* harness.nextReceipt).toMatchObject({
              type: "checkpoint.baseline.captured",
              threadId: id,
            });
          const cwd = threadId === "thread-1" ? harness.cwd : secondCwd;
          NodeFS.writeFileSync(NodePath.join(cwd, "README.md"), `snapshot ${index}\n`);
          harness.provider.emit({
            type: "turn.completed",
            eventId: EventId.make(`evt-refresh-complete-${index}`),
            provider: ProviderDriverKind.make("codex"),
            createdAt: "2026-01-01T00:00:01.000Z",
            threadId: id,
            turnId,
            payload: { state: "completed" },
          });
          expect(yield* harness.nextReceipt).toMatchObject({
            type: "checkpoint.diff.finalized",
            threadId: id,
            turnId,
          });
          expect(yield* harness.nextReceipt).toMatchObject({
            type: "turn.processing.quiesced",
            threadId: id,
            turnId,
          });
          if (index === 0) yield* Deferred.await(entered);
        }
        expect(refreshCalls).toEqual([harness.cwd]);
        expect(
          gitShowFileAtRef(
            harness.cwd,
            checkpointRefForThreadTurn(ThreadId.make("thread-1"), 4),
            "README.md",
          ),
        ).toBe("snapshot 4\n");
        expect(
          gitShowFileAtRef(
            secondCwd,
            checkpointRefForThreadTurn(ThreadId.make("thread-2"), 1),
            "README.md",
          ),
        ).toBe("snapshot 1\n");
        yield* Deferred.succeed(release, undefined);
        yield* Effect.promise(harness.drain);
        expect(refreshCalls).toEqual([harness.cwd, secondCwd, harness.cwd]);
      }),
  );

  effectIt.effect("captures baseline and large turn summaries before completion receipts", () =>
    Effect.gen(function* () {
      const harness = yield* Effect.promise(() =>
        createHarness({ seedFilesystemCheckpoints: false }),
      );
      const createdAt = "2026-01-01T00:00:00.000Z";

      yield* harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-capture"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      });

      harness.provider.emit({
        type: "turn.started",
        eventId: EventId.make("evt-turn-started-1"),
        provider: ProviderDriverKind.make("codex"),

        createdAt: "2026-01-01T00:00:00.000Z",
        threadId: ThreadId.make("thread-1"),
        turnId: asTurnId("turn-1"),
      });
      expect(yield* harness.nextReceipt).toMatchObject({
        type: "checkpoint.baseline.captured",
        checkpointTurnCount: 0,
      });

      NodeFS.writeFileSync(NodePath.join(harness.cwd, "README.md"), "v2\n", "utf8");
      const largeFileLineCount = 25_000;
      NodeFS.writeFileSync(
        NodePath.join(harness.cwd, "large.txt"),
        `${"payload".repeat(64)}\n`.repeat(largeFileLineCount),
        "utf8",
      );
      harness.provider.emit({
        type: "turn.completed",
        eventId: EventId.make("evt-turn-completed-1"),
        provider: ProviderDriverKind.make("codex"),

        createdAt: "2026-01-01T00:00:00.000Z",
        threadId: ThreadId.make("thread-1"),
        turnId: asTurnId("turn-1"),
        payload: { state: "completed" },
      });

      expect(yield* harness.nextReceipt).toMatchObject({
        type: "checkpoint.diff.finalized",
        turnId: "turn-1",
        checkpointTurnCount: 1,
      });
      const thread = (yield* Effect.promise(harness.readModel)).threads.find(
        (entry) => entry.id === "thread-1",
      );
      expect(thread?.checkpoints[0]).toMatchObject({
        checkpointTurnCount: 1,
        files: [
          { path: "large.txt", kind: "modified", additions: largeFileLineCount, deletions: 0 },
          { path: "README.md", kind: "modified", additions: 1, deletions: 1 },
        ],
      });
      expect(yield* harness.nextReceipt).toMatchObject({
        type: "turn.processing.quiesced",
        turnId: "turn-1",
        checkpointTurnCount: 1,
      });
      yield* Effect.promise(harness.drain);
      expect(
        gitRefExists(harness.cwd, checkpointRefForThreadTurn(ThreadId.make("thread-1"), 0)),
      ).toBe(true);
      expect(
        gitRefExists(harness.cwd, checkpointRefForThreadTurn(ThreadId.make("thread-1"), 1)),
      ).toBe(true);
      expect(
        gitShowFileAtRef(
          harness.cwd,
          checkpointRefForThreadTurn(ThreadId.make("thread-1"), 0),
          "README.md",
        ),
      ).toBe("v1\n");
      expect(
        gitShowFileAtRef(
          harness.cwd,
          checkpointRefForThreadTurn(ThreadId.make("thread-1"), 1),
          "README.md",
        ),
      ).toBe("v2\n");
    }),
  );

  effectIt.effect("captures and reverts checkpoints from a nested Git workspace", () =>
    Effect.gen(function* () {
      const repositoryRoot = createGitRepository();
      tempDirs.push(repositoryRoot);
      const workspaceRoot = NodePath.join(repositoryRoot, "apps", "server");
      NodeFS.mkdirSync(workspaceRoot, { recursive: true });
      const filePath = NodePath.join(workspaceRoot, "index.ts");
      NodeFS.writeFileSync(filePath, "export const value = 1;\n");
      runGit(repositoryRoot, ["add", "."]);
      runGit(repositoryRoot, ["commit", "-m", "Add nested workspace"]);
      const harness = yield* Effect.promise(() =>
        createHarness({
          seedFilesystemCheckpoints: false,
          projectWorkspaceRoot: workspaceRoot,
          threadWorktreePath: workspaceRoot,
          providerSessionCwd: workspaceRoot,
        }),
      );
      const threadId = ThreadId.make("thread-1");
      const turnId = asTurnId("turn-nested");
      const createdAt = "2026-01-01T00:00:00.000Z";
      harness.provider.emit({
        type: "turn.started",
        eventId: EventId.make("evt-nested-start"),
        provider: ProviderDriverKind.make("codex"),
        createdAt,
        threadId,
        turnId,
      });
      yield* Effect.promise(harness.drain);
      expect(gitRefExists(repositoryRoot, checkpointRefForThreadTurn(threadId, 0))).toBe(true);
      expect(yield* harness.nextReceipt).toMatchObject({
        type: "checkpoint.baseline.captured",
      });

      NodeFS.writeFileSync(filePath, "export const value = 2;\n");
      harness.provider.emit({
        type: "turn.completed",
        eventId: EventId.make("evt-nested-complete"),
        provider: ProviderDriverKind.make("codex"),
        createdAt,
        threadId,
        turnId,
        payload: { state: "completed" },
      });
      yield* Effect.promise(harness.drain);
      const thread = (yield* Effect.promise(harness.readModel)).threads.find(
        (entry) => entry.id === threadId,
      );
      expect(thread?.checkpoints[0]).toMatchObject({
        status: "ready",
        files: [{ path: "apps/server/index.ts", additions: 1, deletions: 1 }],
      });
      expect(yield* harness.nextReceipt).toMatchObject({
        type: "checkpoint.diff.finalized",
        turnId,
      });
      expect(yield* harness.nextReceipt).toMatchObject({ type: "turn.processing.quiesced" });

      yield* harness.engine.dispatch({
        type: "thread.checkpoint.revert",
        commandId: CommandId.make("cmd-nested-revert"),
        threadId,
        turnCount: 0,
        createdAt,
      });
      yield* Effect.promise(harness.drain);
      expect(NodeFS.readFileSync(filePath, "utf8")).toBe("export const value = 1;\n");
      expect(harness.provider.rollbackConversation).toHaveBeenCalledWith({ threadId, numTurns: 1 });
      expect(gitRefExists(repositoryRoot, checkpointRefForThreadTurn(threadId, 1))).toBe(false);
      const reverted = (yield* Effect.promise(harness.readModel)).threads.find(
        (entry) => entry.id === threadId,
      );
      expect(reverted?.checkpoints).toEqual([]);
    }),
  );

  effectIt.effect.each([false, true])(
    "finalizes non-Git conversation boundaries and reuses provider placeholders=%s",
    (withPlaceholder) =>
      Effect.gen(function* () {
        const harness = yield* Effect.promise(() =>
          createHarness({
            initializeGit: false,
            seedFilesystemCheckpoints: false,
            threadWorktreePath: null,
          }),
        );
        const threadId = ThreadId.make("thread-1");
        const createdAt = "2026-01-01T00:00:00.000Z";
        const firstTurnId = asTurnId("conversation-turn-1");
        const firstMessageId = MessageId.make("assistant:first-item");
        const emitCompleted = (turnId: TurnId, suffix: string) =>
          harness.provider.emit({
            type: "turn.completed",
            eventId: EventId.make(`evt-conversation-${suffix}`),
            provider: ProviderDriverKind.make("codex"),
            threadId,
            turnId,
            createdAt,
            payload: { state: "completed" },
          });
        const completeMessage = (turnId: TurnId, messageId: MessageId) =>
          harness.engine
            .dispatch({
              type: "thread.message.assistant.delta",
              commandId: CommandId.make(`delta:${messageId}`),
              threadId,
              turnId,
              messageId,
              delta: "Completed response",
              createdAt,
            })
            .pipe(
              Effect.andThen(
                harness.engine.dispatch({
                  type: "thread.message.assistant.complete",
                  commandId: CommandId.make(`complete:${messageId}`),
                  threadId,
                  turnId,
                  messageId,
                  createdAt,
                }),
              ),
            );

        // No seeded checkpoint: this is the real completion path that previously
        // returned early. Assistant ingestion may finish after checkpointing.
        emitCompleted(firstTurnId, "first");
        expect(yield* harness.nextReceipt).toMatchObject({
          type: "checkpoint.diff.finalized",
          turnId: firstTurnId,
          checkpointTurnCount: 1,
          status: "missing",
        });
        expect(yield* harness.nextReceipt).toMatchObject({
          type: "turn.processing.quiesced",
          turnId: firstTurnId,
          checkpointTurnCount: 1,
        });
        yield* completeMessage(firstTurnId, firstMessageId);
        yield* Effect.promise(harness.drain);
        const first = (yield* Effect.promise(harness.readModel)).threads[0]!.checkpoints;
        expect(first).toHaveLength(1);
        expect(first[0]).toMatchObject({
          turnId: firstTurnId,
          checkpointTurnCount: 1,
          checkpointRef: checkpointRefForThreadTurn(threadId, 1),
          assistantMessageId: firstMessageId,
          status: "missing",
          files: [],
        });
        emitCompleted(firstTurnId, "repeated-first");
        yield* Effect.promise(harness.drain);
        expect((yield* Effect.promise(harness.readModel)).threads[0]!.checkpoints).toEqual(first);

        const secondTurnId = asTurnId("conversation-turn-2");
        const secondMessageId = MessageId.make("assistant:second-item");
        yield* completeMessage(secondTurnId, secondMessageId);
        if (withPlaceholder)
          yield* harness.engine.dispatch({
            type: "thread.turn.diff.complete",
            commandId: CommandId.make("provider-placeholder"),
            threadId,
            turnId: secondTurnId,
            completedAt: createdAt,
            checkpointRef: CheckpointRef.make("provider-diff:second"),
            assistantMessageId: MessageId.make("assistant:provisional"),
            status: "missing",
            files: [],
            checkpointTurnCount: 2,
            createdAt,
          });
        emitCompleted(secondTurnId, "second");
        // A repeated completion must not have left duplicate finalization receipts.
        expect(yield* harness.nextReceipt).toMatchObject({
          type: "checkpoint.diff.finalized",
          turnId: secondTurnId,
          checkpointTurnCount: 2,
          status: "missing",
        });
        expect(yield* harness.nextReceipt).toMatchObject({
          type: "turn.processing.quiesced",
          turnId: secondTurnId,
          checkpointTurnCount: 2,
        });
        yield* Effect.promise(harness.drain);
        const completed = (yield* Effect.promise(harness.readModel)).threads[0]!.checkpoints;
        expect(completed.map((checkpoint) => checkpoint.checkpointTurnCount)).toEqual([1, 2]);
        expect(completed[1]).toMatchObject({
          checkpointRef: checkpointRefForThreadTurn(threadId, 2),
          assistantMessageId: secondMessageId,
          status: "missing",
        });
        emitCompleted(secondTurnId, "repeated-second");
        yield* Effect.promise(harness.drain);
        expect((yield* Effect.promise(harness.readModel)).threads[0]!.checkpoints).toEqual(
          completed,
        );
        expect(NodeFS.existsSync(NodePath.join(harness.cwd, ".git"))).toBe(false);
      }),
  );

  effectIt.effect.each(["unindexed", "placeholder", "ready", "ambiguous"] as const)(
    "repairs legacy non-Git history conservatively, prior boundary=%s",
    (priorBoundary) =>
      Effect.gen(function* () {
        const harness = yield* Effect.promise(() =>
          createHarness({ initializeGit: false, seedFilesystemCheckpoints: false }),
        );
        const threadId = ThreadId.make("thread-1");
        for (const index of [1, 2, 3]) {
          const createdAt = `2026-01-01T00:00:0${priorBoundary === "ambiguous" && index === 2 ? 1 : index}.000Z`;
          yield* harness.engine.dispatch({
            type: "thread.message.assistant.delta",
            commandId: CommandId.make(`legacy-delta-${index}`),
            threadId,
            turnId: asTurnId(`legacy-${index}`),
            messageId: MessageId.make(`assistant:legacy-${index}`),
            delta: `Response ${index}`,
            createdAt,
          });
          yield* harness.engine.dispatch({
            type: "thread.message.assistant.complete",
            commandId: CommandId.make(`legacy-complete-${index}`),
            threadId,
            turnId: asTurnId(`legacy-${index}`),
            messageId: MessageId.make(`assistant:legacy-${index}`),
            createdAt,
          });
        }
        const createdAt = "2026-01-01T00:00:04.000Z";
        if (priorBoundary === "placeholder" || priorBoundary === "ready")
          yield* harness.engine.dispatch({
            type: "thread.turn.diff.complete",
            commandId: CommandId.make("legacy-placeholder"),
            threadId,
            turnId: asTurnId("legacy-2"),
            checkpointTurnCount: 1,
            checkpointRef: CheckpointRef.make("refs/t3/legacy/keep-this-ref"),
            status: priorBoundary === "ready" ? "ready" : "missing",
            files: [],
            assistantMessageId: MessageId.make("assistant:legacy-2"),
            completedAt: "2026-01-01T00:00:02.000Z",
            createdAt,
          });
        harness.provider.emit({
          type: "turn.completed",
          eventId: EventId.make("legacy-new-completion"),
          provider: ProviderDriverKind.make("codex"),
          threadId,
          turnId: asTurnId("legacy-3"),
          payload: { state: "completed" },
          createdAt,
        });
        yield* Effect.promise(harness.drain);
        const after = (yield* Effect.promise(harness.readModel)).threads[0]!;
        const refused = priorBoundary === "ready" || priorBoundary === "ambiguous";
        if (refused) {
          expect(
            after.activities.some((activity) => activity.kind === "checkpoint.capture.failed"),
          ).toBe(true);
          expect(after.checkpoints).toHaveLength(priorBoundary === "ready" ? 1 : 0);
          if (priorBoundary === "ready")
            expect(after.checkpoints[0]).toMatchObject({
              checkpointTurnCount: 1,
              checkpointRef: "refs/t3/legacy/keep-this-ref",
              status: "ready",
            });
        } else {
          expect(
            after.checkpoints.map((checkpoint) => [
              checkpoint.turnId,
              checkpoint.checkpointTurnCount,
            ]),
          ).toEqual([
            ["legacy-1", 1],
            ["legacy-2", 2],
            ["legacy-3", 3],
          ]);
        }
        // Initializing Git later must not bypass the conversation history guard.
        if (priorBoundary === "ready") runGit(harness.cwd, ["init", "--initial-branch=main"]);
        yield* harness.engine.dispatch({
          type: "thread.conversation.revert",
          commandId: CommandId.make("legacy-revert"),
          threadId,
          turnCount: refused ? 0 : 2,
          createdAt,
        });
        yield* Effect.promise(harness.drain);
        const reverted = (yield* Effect.promise(harness.readModel)).threads[0]!;
        if (refused) {
          expect(harness.provider.rollbackConversation).not.toHaveBeenCalled();
          expect(reverted.messages).toEqual(after.messages);
          expect(
            reverted.activities.some((activity) => activity.kind === "checkpoint.revert.failed"),
          ).toBe(true);
        } else {
          expect(
            reverted.activities.filter((activity) => activity.kind === "checkpoint.revert.failed"),
          ).toEqual([]);
          expect(harness.provider.rollbackConversation).toHaveBeenCalledWith({
            threadId,
            numTurns: 1,
          });
          expect(reverted.messages.map((message) => message.text)).toEqual([
            "Response 1",
            "Response 2",
          ]);
        }
      }),
  );

  const seedLegacyConversation = (
    engine: OrchestrationEngineShape,
    count: number,
    options?: { readonly ambiguous?: boolean; readonly incomplete?: boolean },
  ) =>
    Effect.gen(function* () {
      for (let index = 1; index <= count; index++) {
        const createdAt = `2026-01-01T00:00:0${options?.ambiguous ? 1 : index}.000Z`;
        const completedAt = createdAt.replace(".000Z", ".900Z");
        yield* engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make(`startup-legacy-running-${index}`),
          threadId: ThreadId.make("thread-1"),
          session: {
            threadId: ThreadId.make("thread-1"),
            status: "running",
            providerName: "codex",
            runtimeMode: "approval-required",
            activeTurnId: asTurnId(`persisted-turn-${index}`),
            lastError: null,
            updatedAt: createdAt,
          },
          createdAt,
        });
        yield* engine.dispatch({
          type: "thread.message.assistant.delta",
          commandId: CommandId.make(`startup-legacy-delta-${index}`),
          threadId: ThreadId.make("thread-1"),
          turnId: asTurnId(`persisted-turn-${index}`),
          messageId: MessageId.make(`persisted-response-${index}`),
          delta: `Persisted response ${index}`,
          createdAt,
        });
        if (!(options?.incomplete && index === count)) {
          yield* engine.dispatch({
            type: "thread.message.assistant.complete",
            commandId: CommandId.make(`startup-legacy-complete-${index}`),
            threadId: ThreadId.make("thread-1"),
            turnId: asTurnId(`persisted-turn-${index}`),
            messageId: MessageId.make(`persisted-response-${index}`),
            createdAt: completedAt,
          });
          yield* engine.dispatch({
            type: "thread.session.set",
            commandId: CommandId.make(`startup-legacy-ready-${index}`),
            threadId: ThreadId.make("thread-1"),
            session: {
              threadId: ThreadId.make("thread-1"),
              status: "ready",
              providerName: "codex",
              runtimeMode: "approval-required",
              activeTurnId: null,
              lastError: null,
              updatedAt: completedAt,
            },
            createdAt: completedAt,
          });
        }
      }
    });

  effectIt.effect.each(["single", "now-git"] as const)(
    "repairs persisted conversation boundaries at startup without a new turn: %s",
    (scenario) =>
      Effect.gen(function* () {
        const harness = yield* Effect.promise(() =>
          createHarness({
            startReactor: false,
            initializeGit: scenario === "now-git",
            seedFilesystemCheckpoints: false,
          }),
        );
        const count = scenario === "single" ? 1 : 3;
        yield* seedLegacyConversation(harness.engine, count);
        const before = yield* Effect.promise(harness.readModel);
        yield* Effect.promise(() => harness.startReactor());
        yield* Effect.promise(harness.drain);
        const after = yield* Effect.promise(harness.readModel);
        expect(after.threads[0]!.messages).toEqual(before.threads[0]!.messages);
        expect(before.threads[0]!.latestTurn?.turnId).toBe(`persisted-turn-${count}`);
        expect(after.threads[0]!.latestTurn).toEqual(before.threads[0]!.latestTurn);
        expect(after.threads[0]!.updatedAt).toBe(before.threads[0]!.updatedAt);
        expect(after.threads[0]!.checkpoints).toHaveLength(count);
        for (let index = 1; index <= count; index++)
          expect(after.threads[0]!.checkpoints[index - 1]).toMatchObject({
            turnId: `persisted-turn-${index}`,
            assistantMessageId: `persisted-response-${index}`,
            checkpointTurnCount: index,
            checkpointRef: checkpointRefForThreadTurn(ThreadId.make("thread-1"), index),
            completedAt: `2026-01-01T00:00:0${index}.900Z`,
            status: "missing",
            files: [],
          });
        expect(harness.provider.rollbackConversation).not.toHaveBeenCalled();
        // Repeating startup produces no events and leaves original message
        // timestamps and checkpoint refs intact.
        yield* Effect.promise(() => harness.startReactor());
        yield* Effect.promise(harness.drain);
        expect(yield* Effect.promise(harness.readModel)).toEqual(after);
      }),
  );

  effectIt.effect("waits for server activation before repairing persisted boundaries", () =>
    Effect.gen(function* () {
      const harness = yield* Effect.promise(() =>
        createHarness({
          startReactor: false,
          initializeGit: false,
          seedFilesystemCheckpoints: false,
        }),
      );
      yield* seedLegacyConversation(harness.engine, 1);
      const before = yield* Effect.promise(harness.readModel);
      const activation = yield* Deferred.make<void>();
      yield* Effect.promise(() => harness.startReactor(Deferred.await(activation)));
      expect(yield* Effect.promise(harness.readModel)).toEqual(before);
      yield* Deferred.succeed(activation, undefined);
      yield* Effect.promise(harness.drain);
      expect((yield* Effect.promise(harness.readModel)).threads[0]!.checkpoints).toHaveLength(1);
    }),
  );

  effectIt.effect.each([
    "archived",
    "starting",
    "running",
    "active-id",
    "pending",
    "incomplete",
    "ambiguous",
    "ready",
    "error",
  ] as const)("leaves unsafe legacy history untouched at startup: %s", (reason) =>
    Effect.gen(function* () {
      const harness = yield* Effect.promise(() =>
        createHarness({
          startReactor: false,
          initializeGit: false,
          seedFilesystemCheckpoints: false,
        }),
      );
      const threadId = ThreadId.make("thread-1");
      yield* seedLegacyConversation(harness.engine, 2, {
        ambiguous: reason === "ambiguous",
        incomplete: reason === "incomplete",
      });
      const createdAt = "2026-01-01T00:00:04.000Z";
      if (reason === "archived")
        yield* harness.engine.dispatch({
          type: "thread.archive",
          commandId: CommandId.make("startup-archive"),
          threadId,
        });
      if (reason === "starting" || reason === "running" || reason === "active-id")
        yield* harness.engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make("startup-busy-session"),
          threadId,
          session: {
            threadId,
            status: reason === "active-id" ? "ready" : reason,
            providerName: "codex",
            runtimeMode: "approval-required",
            activeTurnId: reason === "active-id" ? asTurnId("live-turn") : null,
            lastError: null,
            updatedAt: createdAt,
          },
          createdAt,
        });
      if (reason === "pending")
        yield* harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("startup-pending"),
          threadId,
          message: {
            messageId: MessageId.make("pending-user"),
            role: "user",
            text: "Pending",
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt,
        });
      if (reason === "ready" || reason === "error")
        yield* harness.engine.dispatch({
          type: "thread.turn.diff.complete",
          commandId: CommandId.make("startup-real-checkpoint"),
          threadId,
          turnId: asTurnId("persisted-turn-2"),
          assistantMessageId: MessageId.make("persisted-response-2"),
          checkpointTurnCount: 1,
          checkpointRef: CheckpointRef.make("refs/t3/preserved/real-checkpoint"),
          status: reason,
          files: [],
          completedAt: "2026-01-01T00:00:02.000Z",
          createdAt,
        });
      const before = yield* Effect.promise(harness.readModel);
      yield* Effect.promise(() => harness.startReactor());
      yield* Effect.promise(harness.drain);
      expect(yield* Effect.promise(harness.readModel)).toEqual(before);
      expect(harness.provider.rollbackConversation).not.toHaveBeenCalled();
    }),
  );

  effectIt.effect("preserves correctly indexed real checkpoints while repairing later gaps", () =>
    Effect.gen(function* () {
      const harness = yield* Effect.promise(() =>
        createHarness({
          startReactor: false,
          initializeGit: false,
          seedFilesystemCheckpoints: false,
        }),
      );
      yield* seedLegacyConversation(harness.engine, 3);
      yield* harness.engine.dispatch({
        type: "thread.turn.diff.complete",
        commandId: CommandId.make("startup-preserve-ref"),
        threadId: ThreadId.make("thread-1"),
        turnId: asTurnId("persisted-turn-1"),
        assistantMessageId: MessageId.make("persisted-response-1"),
        checkpointTurnCount: 1,
        checkpointRef: CheckpointRef.make("refs/t3/preserved/original"),
        status: "ready",
        files: [{ path: "README.md", kind: "modified", additions: 1, deletions: 0 }],
        completedAt: "2026-01-01T00:00:01.000Z",
        createdAt: "2026-01-01T00:00:04.000Z",
      });
      const before = (yield* Effect.promise(harness.readModel)).threads[0]!;
      yield* Effect.promise(() => harness.startReactor());
      yield* Effect.promise(harness.drain);
      const after = (yield* Effect.promise(harness.readModel)).threads[0]!;
      expect(after.messages).toEqual(before.messages);
      expect(after.latestTurn).toEqual(before.latestTurn);
      expect(after.updatedAt).toBe(before.updatedAt);
      expect(after.checkpoints).toHaveLength(3);
      expect(after.checkpoints[0]).toEqual(before.checkpoints[0]);
    }),
  );

  effectIt.effect("stops startup repair when a new turn is queued between repair commands", () =>
    Effect.gen(function* () {
      const harness = yield* Effect.promise(() =>
        createHarness({
          startReactor: false,
          initializeGit: false,
          seedFilesystemCheckpoints: false,
        }),
      );
      yield* seedLegacyConversation(harness.engine, 3);
      const before = (yield* Effect.promise(harness.readModel)).threads[0]!;
      const dispatch = harness.engine.dispatch;
      let started = false;
      vi.spyOn(harness.engine, "dispatch").mockImplementation((command, options) => {
        if (started || command.type !== "thread.turn.diff.complete")
          return dispatch(command, options);
        started = true;
        // A newer lifecycle event wins the command queue after the reactor's
        // guard read but before its historical checkpoint command is decided.
        return dispatch({
          type: "thread.session.set",
          commandId: CommandId.make("startup-racing-session-update"),
          threadId: ThreadId.make("thread-1"),
          session: {
            threadId: ThreadId.make("thread-1"),
            status: "ready",
            providerName: "codex",
            runtimeMode: "approval-required",
            activeTurnId: null,
            lastError: null,
            updatedAt: "2026-01-01T00:00:04.000Z",
          },
          createdAt: "2026-01-01T00:00:04.000Z",
        }).pipe(
          Effect.andThen(dispatch(command, options)),
          Effect.tap(() =>
            dispatch({
              type: "thread.turn.start",
              commandId: CommandId.make("startup-racing-turn"),
              threadId: ThreadId.make("thread-1"),
              message: {
                messageId: MessageId.make("racing-user"),
                role: "user",
                text: "New work",
                attachments: [],
              },
              interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
              runtimeMode: "approval-required",
              createdAt: "2026-01-01T00:00:05.000Z",
            }),
          ),
        );
      });
      yield* Effect.promise(() => harness.startReactor());
      yield* Effect.promise(harness.drain);
      const after = (yield* Effect.promise(harness.readModel)).threads[0]!;
      expect(started).toBe(true);
      expect(after.checkpoints).toHaveLength(1);
      expect(after.checkpoints[0]).toMatchObject({
        turnId: "persisted-turn-3",
        checkpointTurnCount: 3,
      });
      expect(after.messages.filter((message) => message.role === "assistant")).toHaveLength(3);
      expect(after.messages.at(-1)?.text).toBe("New work");
      expect(after.latestTurn).toEqual(before.latestTurn);
      expect(after.updatedAt).toBe("2026-01-01T00:00:05.000Z");
      const events = Array.from(yield* Stream.runCollect(harness.engine.readEvents(0)));
      const repairEvent = events.find((event) =>
        event.commandId?.startsWith("server:conversation-history-backfill:"),
      );
      expect(repairEvent?.occurredAt).toBe("2026-01-01T00:00:04.000Z");
    }),
  );

  effectIt.effect.each(["turn.completed", "turn.aborted"] as const)(
    "captures every edit after a mid-turn diff update on %s",
    (terminalEventType) =>
      Effect.gen(function* () {
        const harness = yield* Effect.promise(() =>
          createHarness({ seedFilesystemCheckpoints: false }),
        );
        const threadId = ThreadId.make("thread-1");
        const turnId = asTurnId("turn-1");
        const assistantMessageId = MessageId.make("assistant:mid-turn");
        const createdAt = "2026-01-01T00:00:00.000Z";
        yield* harness.engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make("cmd-mid-turn-running"),
          threadId,
          session: {
            threadId,
            status: "running",
            providerName: "codex",
            runtimeMode: "approval-required",
            activeTurnId: turnId,
            lastError: null,
            updatedAt: createdAt,
          },
          createdAt,
        });
        harness.provider.emit({
          type: "turn.started",
          eventId: EventId.make("evt-mid-turn-start"),
          provider: ProviderDriverKind.make("codex"),
          createdAt,
          threadId,
          turnId,
        });
        expect(yield* harness.nextReceipt).toMatchObject({
          type: "checkpoint.baseline.captured",
        });

        NodeFS.writeFileSync(NodePath.join(harness.cwd, "early.ts"), "export const early = 1;\n");
        yield* harness.engine.dispatch({
          type: "thread.turn.diff.complete",
          commandId: CommandId.make("cmd-mid-turn-diff"),
          threadId,
          turnId,
          completedAt: createdAt,
          checkpointRef: CheckpointRef.make("provider-diff:mid-turn"),
          assistantMessageId,
          status: "missing",
          files: [],
          checkpointTurnCount: 1,
          createdAt,
        });
        yield* Effect.promise(harness.drain);

        NodeFS.writeFileSync(NodePath.join(harness.cwd, "late.ts"), "export const late = 2;\n");
        yield* harness.engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make("cmd-mid-turn-settled"),
          threadId,
          session: {
            threadId,
            status: terminalEventType === "turn.aborted" ? "interrupted" : "ready",
            providerName: "codex",
            runtimeMode: "approval-required",
            activeTurnId: null,
            lastError: null,
            updatedAt: createdAt,
          },
          createdAt,
        });
        harness.provider.emit({
          eventId: EventId.make("evt-mid-turn-complete"),
          provider: ProviderDriverKind.make("codex"),
          createdAt,
          threadId,
          turnId,
          ...(terminalEventType === "turn.completed"
            ? { type: "turn.completed", payload: { state: "completed" } }
            : { type: "turn.aborted", payload: { reason: "Interrupted by user." } }),
        });
        yield* Effect.promise(harness.drain);
        expect(gitRefExists(harness.cwd, checkpointRefForThreadTurn(threadId, 1))).toBe(true);
        expect(yield* harness.nextReceipt).toMatchObject({
          type: "checkpoint.diff.finalized",
          turnId,
          checkpointTurnCount: 1,
        });
        expect(yield* harness.nextReceipt).toMatchObject({
          type: "turn.processing.quiesced",
          turnId,
        });
        yield* Effect.promise(harness.drain);
        const thread = (yield* Effect.promise(harness.readModel)).threads.find(
          (entry) => entry.id === threadId,
        );
        expect(thread?.checkpoints).toHaveLength(1);
        expect(thread?.checkpoints[0]?.status).toBe("ready");
        expect(thread?.latestTurn?.state).toBe(
          terminalEventType === "turn.aborted" ? "interrupted" : "completed",
        );
        expect(thread?.checkpoints[0]?.assistantMessageId).toBe(assistantMessageId);
        expect(thread?.checkpoints[0]?.files.map((file) => file.path)).toEqual([
          "early.ts",
          "late.ts",
        ]);
        expect(
          gitShowFileAtRef(harness.cwd, checkpointRefForThreadTurn(threadId, 1), "late.ts"),
        ).toBe("export const late = 2;\n");

        const followUpTurnId = asTurnId("turn-2");
        harness.provider.emit({
          type: "turn.started",
          eventId: EventId.make("evt-follow-up-start"),
          provider: ProviderDriverKind.make("codex"),
          createdAt,
          threadId,
          turnId: followUpTurnId,
        });
        harness.provider.emit({
          type: "turn.completed",
          eventId: EventId.make("evt-follow-up-complete"),
          provider: ProviderDriverKind.make("codex"),
          createdAt,
          threadId,
          turnId: followUpTurnId,
          payload: { state: "completed" },
        });
        expect(yield* harness.nextReceipt).toMatchObject({
          type: "checkpoint.diff.finalized",
          turnId: followUpTurnId,
          checkpointTurnCount: 2,
        });
        const followUp = (yield* Effect.promise(harness.readModel)).threads.find(
          (entry) => entry.id === threadId,
        );
        expect(
          followUp?.checkpoints.find((checkpoint) => checkpoint.turnId === followUpTurnId),
        ).toMatchObject({ checkpointTurnCount: 2, files: [] });
      }),
  );

  it("does not capture an aborted turn without a matching start or active session", async () => {
    const harness = await createHarness({ seedFilesystemCheckpoints: false });
    harness.provider.emit({
      type: "turn.aborted",
      eventId: EventId.make("evt-untracked-abort"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-untracked"),
      payload: { reason: "Interrupted before the turn started." },
    });
    await harness.drain();

    const thread = (await harness.readModel()).threads.find((entry) => entry.id === "thread-1");
    expect(thread?.checkpoints).toEqual([]);
    expect(
      gitRefExists(harness.cwd, checkpointRefForThreadTurn(ThreadId.make("thread-1"), 1)),
    ).toBe(false);
  });

  it("refreshes local git status state on turn completion using the session cwd", async () => {
    const gitStatusRefreshCalls: string[] = [];
    const harness = await createHarness({
      seedFilesystemCheckpoints: false,
      gitStatusRefreshCalls,
    });

    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.make("evt-turn-completed-refresh-local-status"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-refresh-local-status"),
      payload: { state: "completed" },
    });

    await harness.drain();

    expect(gitStatusRefreshCalls).toEqual([harness.cwd]);
  });

  it("re-asks for the pull request at turn end when the thread branch is checked out", async () => {
    const pullRequestRefreshCalls: string[] = [];
    const harness = await createHarness({
      seedFilesystemCheckpoints: false,
      threadBranch: "t3code/feature",
      localStatusRefName: "t3code/feature",
      pullRequestRefreshCalls,
    });

    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.make("evt-turn-completed-refresh-pr"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-refresh-pr"),
      payload: { state: "completed" },
    });

    await harness.drain();

    expect(pullRequestRefreshCalls).toEqual([harness.cwd]);
  });

  effectIt.effect("captures files while the pull request lookup is still pending", () =>
    Effect.gen(function* () {
      const lookupStarted = yield* Deferred.make<void>();
      const finishLookup = yield* Deferred.make<void>();
      const harness = yield* Effect.promise(() =>
        createHarness({
          seedFilesystemCheckpoints: false,
          threadBranch: "t3code/feature",
          localStatusRefName: "t3code/feature",
          pullRequestRefresh: Deferred.succeed(lookupStarted, undefined).pipe(
            Effect.andThen(Deferred.await(finishLookup)),
          ),
        }),
      );
      NodeFS.writeFileSync(NodePath.join(harness.cwd, "README.md"), "completed turn\n");
      harness.provider.emit({
        type: "turn.completed",
        eventId: EventId.make("evt-turn-completed-slow-pr"),
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:00.000Z",
        threadId: ThreadId.make("thread-1"),
        turnId: asTurnId("turn-slow-pr"),
        payload: { state: "completed" },
      });

      yield* Deferred.await(lookupStarted);
      yield* Effect.gen(function* () {
        expect(yield* harness.nextReceipt).toMatchObject({
          type: "checkpoint.diff.finalized",
          turnId: "turn-slow-pr",
        });
        expect(
          gitShowFileAtRef(
            harness.cwd,
            checkpointRefForThreadTurn(ThreadId.make("thread-1"), 1),
            "README.md",
          ),
        ).toBe("completed turn\n");
      }).pipe(Effect.ensuring(Deferred.succeed(finishLookup, undefined)));
      yield* Effect.promise(harness.drain);
    }),
  );

  it("re-asks for the pull request after adopting a drifted checkout", async () => {
    const pullRequestRefreshCalls: string[] = [];
    const harness = await createHarness({
      seedFilesystemCheckpoints: false,
      threadBranch: "t3code/original-branch",
      localStatusRefName: "t3code/renamed-by-agent",
      pullRequestRefreshCalls,
    });

    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.make("evt-turn-completed-drift-pr"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-drift-pr"),
      payload: { state: "completed" },
    });

    await harness.drain();

    expect(pullRequestRefreshCalls).toEqual([harness.cwd]);
  });

  it("does not re-ask for the pull request at turn end on the default branch", async () => {
    const pullRequestRefreshCalls: string[] = [];
    const harness = await createHarness({
      seedFilesystemCheckpoints: false,
      threadBranch: "main",
      localStatusRefName: "main",
      pullRequestRefreshCalls,
    });

    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.make("evt-turn-completed-no-pr-refresh"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-no-pr-refresh"),
      payload: { state: "completed" },
    });

    await harness.drain();

    expect(pullRequestRefreshCalls).toEqual([]);
  });

  it("adopts a drifted checkout as the thread branch on a dedicated worktree", async () => {
    const harness = await createHarness({
      seedFilesystemCheckpoints: false,
      threadBranch: "t3code/original-branch",
      localStatusRefName: "t3code/renamed-by-agent",
    });

    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.make("evt-turn-completed-branch-drift"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-branch-drift"),
      payload: { state: "completed" },
    });

    await harness.drain();
    await waitForEvent(
      harness.engine,
      (event) =>
        event.type === "thread.meta-updated" &&
        (event as unknown as { payload: { branch?: string } }).payload.branch ===
          "t3code/renamed-by-agent",
    );

    const snapshot = await harness.readModel();
    const thread = snapshot.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.branch).toBe("t3code/renamed-by-agent");
  });

  it("follows a checkout from a saved placeholder branch and refreshes its pull request", async () => {
    const pullRequestRefreshCalls: string[] = [];
    const harness = await createHarness({
      seedFilesystemCheckpoints: false,
      threadBranch: "t3code/fd9cbe0e",
      localStatusRefName: "fix/mobile-tool-detail-expansion",
      pullRequestRefreshCalls,
    });

    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.make("evt-turn-completed-placeholder-drift"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-placeholder-drift"),
      payload: { state: "completed" },
    });

    await harness.drain();

    const snapshot = await harness.readModel();
    const thread = snapshot.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.branch).toBe("fix/mobile-tool-detail-expansion");
    expect(thread?.worktreePath).toBe(harness.cwd);
    expect(pullRequestRefreshCalls).toEqual([harness.cwd]);
  });

  it.each(["t3code/original-branch", "t3code/fd9cbe0e"])(
    "does not adopt a drifted checkout from %s when the worktree is shared by another thread",
    async (threadBranch) => {
      const pullRequestRefreshCalls: string[] = [];
      const harness = await createHarness({
        seedFilesystemCheckpoints: false,
        threadBranch,
        localStatusRefName: "t3code/renamed-by-agent",
        secondThreadSharingWorktree: true,
        pullRequestRefreshCalls,
      });

      harness.provider.emit({
        type: "turn.completed",
        eventId: EventId.make("evt-turn-completed-branch-drift-shared"),
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:00.000Z",
        threadId: ThreadId.make("thread-1"),
        turnId: asTurnId("turn-branch-drift-shared"),
        payload: { state: "completed" },
      });

      await harness.drain();

      const snapshot = await harness.readModel();
      const thread = snapshot.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
      expect(thread?.branch).toBe(threadBranch);
      expect(pullRequestRefreshCalls).toEqual([]);
    },
  );

  it("does not adopt a temporary placeholder checkout as the thread branch", async () => {
    const harness = await createHarness({
      seedFilesystemCheckpoints: false,
      threadBranch: "t3code/original-branch",
      localStatusRefName: "t3code/0a1b2c3d",
    });

    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.make("evt-turn-completed-branch-drift-temp"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-branch-drift-temp"),
      payload: { state: "completed" },
    });

    await harness.drain();

    const snapshot = await harness.readModel();
    const thread = snapshot.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.branch).toBe("t3code/original-branch");
  });

  it("ignores auxiliary thread turn completion while primary turn is active", async () => {
    const pullRequestRefreshCalls: string[] = [];
    const harness = await createHarness({
      seedFilesystemCheckpoints: false,
      threadBranch: "t3code/feature",
      localStatusRefName: "t3code/feature",
      pullRequestRefreshCalls,
    });
    const createdAt = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-primary-running"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("turn-main"),
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );

    harness.provider.emit({
      type: "turn.started",
      eventId: EventId.make("evt-turn-started-main"),
      provider: ProviderDriverKind.make("codex"),

      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-main"),
    });
    await waitForGitRefExists(
      harness.cwd,
      checkpointRefForThreadTurn(ThreadId.make("thread-1"), 0),
    );

    NodeFS.writeFileSync(NodePath.join(harness.cwd, "README.md"), "v2\n", "utf8");

    harness.provider.emit({
      type: "turn.started",
      eventId: EventId.make("evt-turn-started-aux"),
      provider: ProviderDriverKind.make("codex"),
      createdAt,
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-aux"),
    });
    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.make("evt-turn-completed-aux"),
      provider: ProviderDriverKind.make("codex"),

      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-aux"),
      payload: { state: "completed" },
    });

    await harness.drain();
    const midReadModel = await harness.readModel();
    const midThread = midReadModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(midThread?.checkpoints).toHaveLength(0);
    expect(pullRequestRefreshCalls).toEqual([]);
    expect(harness.pullRequestRefreshes).toEqual([]);

    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.make("evt-turn-completed-main"),
      provider: ProviderDriverKind.make("codex"),

      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-main"),
      payload: { state: "completed" },
    });

    const thread = await waitForThread(
      harness.readModel,
      (entry) => entry.latestTurn?.turnId === "turn-main" && entry.checkpoints.length === 1,
    );
    expect(thread.checkpoints[0]?.checkpointTurnCount).toBe(1);
    await harness.drain();
    expect(pullRequestRefreshCalls).toEqual([harness.cwd]);
    expect(harness.pullRequestRefreshes).toEqual([1]);
  });

  it("captures pre-turn and completion checkpoints for claude runtime events", async () => {
    const harness = await createHarness({
      seedFilesystemCheckpoints: false,
      providerName: ProviderDriverKind.make("claudeAgent"),
    });
    const createdAt = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-capture-claude"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: "claudeAgent",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );

    harness.provider.emit({
      type: "turn.started",
      eventId: EventId.make("evt-turn-started-claude-1"),
      provider: ProviderDriverKind.make("claudeAgent"),
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-claude-1"),
    });
    await waitForGitRefExists(
      harness.cwd,
      checkpointRefForThreadTurn(ThreadId.make("thread-1"), 0),
    );

    NodeFS.writeFileSync(NodePath.join(harness.cwd, "README.md"), "v2\n", "utf8");
    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.make("evt-turn-completed-claude-1"),
      provider: ProviderDriverKind.make("claudeAgent"),
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-claude-1"),
      payload: { state: "completed" },
    });

    await waitForEvent(harness.engine, (event) => event.type === "thread.turn-diff-completed");
    const thread = await waitForThread(
      harness.readModel,
      (entry) => entry.latestTurn?.turnId === "turn-claude-1" && entry.checkpoints.length === 1,
    );

    expect(thread.checkpoints[0]?.checkpointTurnCount).toBe(1);
    expect(
      gitRefExists(harness.cwd, checkpointRefForThreadTurn(ThreadId.make("thread-1"), 1)),
    ).toBe(true);
  });

  effectIt.effect("captures a checkpoint without a summary when the baseline is missing", () =>
    Effect.gen(function* () {
      const harness = yield* Effect.promise(() =>
        createHarness({ seedFilesystemCheckpoints: false }),
      );
      harness.provider.emit({
        type: "turn.completed",
        eventId: EventId.make("evt-turn-completed-missing-baseline"),
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:00.000Z",
        threadId: ThreadId.make("thread-1"),
        turnId: asTurnId("turn-missing-baseline"),
        payload: { state: "completed" },
      });
      expect(yield* harness.nextReceipt).toMatchObject({
        type: "checkpoint.diff.finalized",
        checkpointTurnCount: 1,
      });
      yield* Effect.promise(harness.drain);
      const thread = (yield* Effect.promise(harness.readModel)).threads[0];
      expect(thread?.checkpoints[0]).toMatchObject({
        status: "ready",
        checkpointTurnCount: 1,
        files: [],
      });
      expect(
        gitRefExists(harness.cwd, checkpointRefForThreadTurn(ThreadId.make("thread-1"), 1)),
      ).toBe(true);
      expect(
        thread?.activities.some((activity) => activity.kind === "checkpoint.capture.failed"),
      ).toBe(false);
    }),
  );

  effectIt.effect.each([
    { timing: "between turns", commit: false },
    { timing: "between turns", commit: true },
    { timing: "during a turn", commit: false },
    { timing: "during a turn", commit: true },
  ])("resumes checkpointing after git init $timing (commit: $commit)", ({ timing, commit }) =>
    Effect.gen(function* () {
      const harness = yield* Effect.promise(() =>
        createHarness({ initializeGit: false, seedFilesystemCheckpoints: false }),
      );
      const threadId = ThreadId.make("thread-1");
      const createdAt = "2026-01-01T00:00:00.000Z";
      const emit = (type: "turn.started" | "turn.completed", turn: number) =>
        harness.provider.emit({
          type,
          eventId: EventId.make(`${type}-${turn}`),
          provider: ProviderDriverKind.make("codex"),
          createdAt,
          threadId,
          turnId: asTurnId(`turn-${turn}`),
          ...(type === "turn.completed" ? { payload: { state: "completed" } } : {}),
        });
      emit("turn.started", 1);
      yield* Effect.promise(harness.drain);
      NodeFS.writeFileSync(NodePath.join(harness.cwd, "README.md"), "before git\n");
      emit("turn.completed", 1);
      yield* Effect.promise(harness.drain);
      expect((yield* Effect.promise(harness.readModel)).threads[0]?.checkpoints).toMatchObject([
        { checkpointTurnCount: 1, status: "missing" },
      ]);
      expect(yield* harness.nextReceipt).toMatchObject({
        type: "checkpoint.diff.finalized",
        checkpointTurnCount: 1,
      });
      expect(yield* harness.nextReceipt).toMatchObject({ type: "turn.processing.quiesced" });

      if (timing === "during a turn") {
        emit("turn.started", 2);
        yield* Effect.promise(harness.drain);
      }
      runGit(harness.cwd, ["init", "--initial-branch=main"]);
      if (commit) {
        runGit(harness.cwd, ["add", "."]);
        runGit(harness.cwd, [
          "-c",
          "user.name=Test",
          "-c",
          "user.email=test@example.com",
          "commit",
          "-m",
          "Initial",
        ]);
      }
      if (timing === "between turns") {
        // Exercise the domain entry point as well as the provider turn-start event.
        yield* harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-after-git-init"),
          threadId,
          message: {
            messageId: MessageId.make("message-after-git-init"),
            role: "user",
            text: "continue",
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt,
        });
        expect(yield* harness.nextReceipt).toMatchObject({
          type: "checkpoint.baseline.captured",
          checkpointTurnCount: 1,
        });
        emit("turn.started", 2);
        yield* Effect.promise(harness.drain);
      }
      NodeFS.writeFileSync(NodePath.join(harness.cwd, "README.md"), "after git\n");
      emit("turn.completed", 2);
      expect(yield* harness.nextReceipt).toMatchObject({
        type: "checkpoint.diff.finalized",
        checkpointTurnCount: 2,
      });
      expect(yield* harness.nextReceipt).toMatchObject({ type: "turn.processing.quiesced" });
      yield* Effect.promise(harness.drain);
      const firstCheckpoint = (yield* Effect.promise(harness.readModel)).threads[0]?.checkpoints[1];
      expect(firstCheckpoint?.files).toEqual(
        timing === "between turns"
          ? [{ path: "README.md", kind: "modified", additions: 1, deletions: 1 }]
          : [],
      );
      expect(
        gitShowFileAtRef(harness.cwd, checkpointRefForThreadTurn(threadId, 2), "README.md"),
      ).toBe("after git\n");
      expect(gitRefExists(harness.cwd, checkpointRefForThreadTurn(threadId, 1))).toBe(
        timing === "between turns",
      );

      emit("turn.started", 3);
      yield* Effect.promise(harness.drain);
      NodeFS.writeFileSync(NodePath.join(harness.cwd, "README.md"), "next turn\n");
      emit("turn.completed", 3);
      expect(yield* harness.nextReceipt).toMatchObject({
        type: "checkpoint.diff.finalized",
        checkpointTurnCount: 3,
      });
      yield* Effect.promise(harness.drain);
      const thread = (yield* Effect.promise(harness.readModel)).threads[0];
      expect(thread?.checkpoints[2]?.files).toEqual([
        { path: "README.md", kind: "modified", additions: 1, deletions: 1 },
      ]);
      expect(
        thread?.activities.some((activity) => activity.kind === "checkpoint.capture.failed"),
      ).toBe(false);
    }),
  );

  it("captures pre-turn baseline from project workspace root when thread worktree is unset", async () => {
    const harness = await createHarness({
      hasSession: false,
      seedFilesystemCheckpoints: false,
      threadWorktreePath: null,
    });

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-for-baseline"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: MessageId.make("message-user-1"),
          role: "user",
          text: "start turn",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );

    await waitForGitRefExists(
      harness.cwd,
      checkpointRefForThreadTurn(ThreadId.make("thread-1"), 0),
    );
    expect(
      gitShowFileAtRef(
        harness.cwd,
        checkpointRefForThreadTurn(ThreadId.make("thread-1"), 0),
        "README.md",
      ),
    ).toBe("v1\n");
  });

  it("does not create checkpoints while importing historical user messages", async () => {
    const harness = await createHarness({
      hasSession: false,
      seedFilesystemCheckpoints: false,
      threadWorktreePath: null,
    });
    if (runtime === null) throw new Error("Checkpoint test runtime was not initialized.");

    await runtime.runPromise(
      harness.engine.dispatch({
        type: "thread.history.import",
        commandId: CommandId.make("cmd-import-history-without-checkpoint"),
        threadId: ThreadId.make("thread-1"),
        messages: [
          {
            messageId: MessageId.make("imported-user-message"),
            role: "user",
            text: "A message from an existing agent session",
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      }),
    );
    await harness.drain();

    expect(
      gitRefExists(harness.cwd, checkpointRefForThreadTurn(ThreadId.make("thread-1"), 0)),
    ).toBe(false);
  });

  it("captures turn completion checkpoint from project workspace root when provider session cwd is unavailable", async () => {
    const harness = await createHarness({
      hasSession: false,
      seedFilesystemCheckpoints: false,
      threadWorktreePath: null,
    });
    const createdAt = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-missing-provider-cwd"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("turn-missing-cwd"),
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );

    NodeFS.writeFileSync(NodePath.join(harness.cwd, "README.md"), "v2\n", "utf8");
    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.make("evt-turn-completed-missing-provider-cwd"),
      provider: ProviderDriverKind.make("codex"),

      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-missing-cwd"),
      payload: { state: "completed" },
    });

    await waitForEvent(harness.engine, (event) => event.type === "thread.turn-diff-completed");
    expect(
      gitRefExists(harness.cwd, checkpointRefForThreadTurn(ThreadId.make("thread-1"), 1)),
    ).toBe(true);
    expect(
      gitShowFileAtRef(
        harness.cwd,
        checkpointRefForThreadTurn(ThreadId.make("thread-1"), 1),
        "README.md",
      ),
    ).toBe("v2\n");
  });

  it("ignores non-v2 checkpoint.captured runtime events", async () => {
    const harness = await createHarness();
    const createdAt = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-checkpoint-captured"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );

    harness.provider.emit({
      type: "checkpoint.captured",
      eventId: EventId.make("evt-checkpoint-captured-3"),
      provider: ProviderDriverKind.make("codex"),

      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-3"),
      turnCount: 3,
      status: "completed",
    });

    await harness.drain();
    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.checkpoints.some((checkpoint) => checkpoint.checkpointTurnCount === 3)).toBe(
      false,
    );
  });

  it("continues processing runtime events after a conversation-only completion", async () => {
    const nonRepositorySessionCwd = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3-checkpoint-runtime-non-repo-"),
    );
    tempDirs.push(nonRepositorySessionCwd);

    const harness = await createHarness({
      seedFilesystemCheckpoints: false,
      providerSessionCwd: nonRepositorySessionCwd,
    });
    const createdAt = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-non-repo-runtime"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );

    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.make("evt-runtime-capture-failure"),
      provider: ProviderDriverKind.make("codex"),

      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-runtime-failure"),
      payload: { state: "completed" },
    });

    harness.provider.emit({
      type: "turn.started",
      eventId: EventId.make("evt-turn-started-after-runtime-failure"),
      provider: ProviderDriverKind.make("codex"),

      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-after-runtime-failure"),
    });

    await waitForGitRefExists(
      harness.cwd,
      checkpointRefForThreadTurn(ThreadId.make("thread-1"), 1),
    );
    expect(
      gitRefExists(harness.cwd, checkpointRefForThreadTurn(ThreadId.make("thread-1"), 1)),
    ).toBe(true);
  });

  effectIt.effect("rejects unsupported rewind before changing files, checkpoints, or history", () =>
    Effect.gen(function* () {
      const harness = yield* Effect.promise(() =>
        createHarness({ providerName: ProviderDriverKind.make("antigravity") }),
      );
      const threadId = ThreadId.make("thread-1");
      const createdAt = "2026-01-01T00:00:00.000Z";
      const checked = yield* Deferred.make<void>();
      harness.provider.assertConversationRollbackSupported.mockImplementation(() =>
        Deferred.succeed(checked, undefined).pipe(
          Effect.andThen(
            Effect.fail(
              new ProviderValidationError({
                operation: "ProviderService.assertConversationRollbackSupported",
                issue: "Provider 'antigravity' does not support conversation rewind.",
              }),
            ),
          ),
        ),
      );

      for (const turnCount of [1, 2]) {
        yield* harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make(`cmd-unsupported-rewind-message-${turnCount}`),
          threadId,
          message: {
            messageId: MessageId.make(`message-unsupported-rewind-${turnCount}`),
            role: "user",
            text: `Keep message ${turnCount}`,
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt,
        });
        yield* harness.engine.dispatch({
          type: "thread.turn.diff.complete",
          commandId: CommandId.make(`cmd-unsupported-rewind-diff-${turnCount}`),
          threadId,
          turnId: asTurnId(`turn-unsupported-rewind-${turnCount}`),
          completedAt: createdAt,
          checkpointRef: checkpointRefForThreadTurn(threadId, turnCount),
          status: "ready",
          files: [],
          checkpointTurnCount: turnCount,
          createdAt,
        });
      }
      const before = (yield* Effect.promise(() => harness.readModel())).threads.find(
        (thread) => thread.id === threadId,
      );

      yield* harness.engine.dispatch({
        type: "thread.checkpoint.revert",
        commandId: CommandId.make("cmd-unsupported-rewind"),
        threadId,
        turnCount: 1,
        createdAt,
      });
      yield* Deferred.await(checked);
      yield* Effect.promise(() => harness.drain());

      const after = (yield* Effect.promise(() => harness.readModel())).threads.find(
        (thread) => thread.id === threadId,
      );
      expect(after?.checkpoints).toEqual(before?.checkpoints);
      expect(after?.messages).toEqual(before?.messages);
      expect(after?.latestTurn).toEqual(before?.latestTurn);
      expect(after?.activities).toContainEqual(
        expect.objectContaining({
          kind: "checkpoint.revert.failed",
          payload: expect.objectContaining({
            detail: expect.stringContaining("does not support conversation rewind"),
          }),
        }),
      );
      expect(harness.provider.rollbackConversation).not.toHaveBeenCalled();
      expect(NodeFS.readFileSync(NodePath.join(harness.cwd, "README.md"), "utf8")).toBe("v3\n");
      expect(gitRefExists(harness.cwd, checkpointRefForThreadTurn(threadId, 2))).toBe(true);
    }),
  );

  effectIt.effect("rejects Grok file restoration before changing files or provider history", () =>
    Effect.gen(function* () {
      const harness = yield* Effect.promise(() =>
        createHarness({ providerName: ProviderDriverKind.make("grok") }),
      );
      const threadId = ThreadId.make("thread-1");
      const createdAt = "2026-01-01T00:00:00.000Z";
      yield* harness.engine.dispatch({
        type: "thread.turn.diff.complete",
        commandId: CommandId.make("grok-file-revert-checkpoint"),
        threadId,
        turnId: asTurnId("grok-turn"),
        completedAt: createdAt,
        checkpointRef: checkpointRefForThreadTurn(threadId, 1),
        status: "ready",
        files: [],
        checkpointTurnCount: 1,
        createdAt,
      });
      yield* harness.engine.dispatch({
        type: "thread.checkpoint.revert",
        commandId: CommandId.make("grok-file-revert"),
        threadId,
        turnCount: 0,
        createdAt,
      });
      yield* Effect.promise(() => harness.drain());
      expect(harness.provider.rollbackConversation).not.toHaveBeenCalled();
      expect(NodeFS.readFileSync(NodePath.join(harness.cwd, "README.md"), "utf8")).toBe("v3\n");
      const model = yield* Effect.promise(() => harness.readModel());
      expect(model.threads[0]?.activities).toContainEqual(
        expect.objectContaining({
          kind: "checkpoint.revert.failed",
          payload: expect.objectContaining({
            detail: expect.stringContaining("conversation-only"),
          }),
        }),
      );
    }),
  );

  it.each([
    { commandType: "thread.checkpoint.revert", initializeGit: true },
    { commandType: "thread.conversation.revert", initializeGit: true },
    { commandType: "thread.conversation.revert", initializeGit: false },
  ] as const)(
    "$commandType rewinds history with the requested filesystem behavior (git: $initializeGit)",
    async ({ commandType, initializeGit }) => {
      const harness = await createHarness({
        initializeGit,
        seedFilesystemCheckpoints: initializeGit,
      });
      const createdAt = "2026-01-01T00:00:00.000Z";

      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make("cmd-session-set"),
          threadId: ThreadId.make("thread-1"),
          session: {
            threadId: ThreadId.make("thread-1"),
            status: "ready",
            providerName: "codex",
            runtimeMode: "approval-required",
            activeTurnId: null,
            lastError: null,
            updatedAt: createdAt,
          },
          createdAt,
        }),
      );

      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.turn.diff.complete",
          commandId: CommandId.make("cmd-diff-1"),
          threadId: ThreadId.make("thread-1"),
          turnId: asTurnId("turn-1"),
          completedAt: createdAt,
          checkpointRef: initializeGit
            ? checkpointRefForThreadTurn(ThreadId.make("thread-1"), 1)
            : CheckpointRef.make("provider-diff:thread-1:turn-1"),
          status: initializeGit ? "ready" : "missing",
          files: [],
          checkpointTurnCount: 1,
          createdAt,
        }),
      );
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.turn.diff.complete",
          commandId: CommandId.make("cmd-diff-2"),
          threadId: ThreadId.make("thread-1"),
          turnId: asTurnId("turn-2"),
          completedAt: createdAt,
          checkpointRef: initializeGit
            ? checkpointRefForThreadTurn(ThreadId.make("thread-1"), 2)
            : CheckpointRef.make("provider-diff:thread-1:turn-2"),
          status: initializeGit ? "ready" : "missing",
          files: [],
          checkpointTurnCount: 2,
          createdAt,
        }),
      );

      NodeFS.writeFileSync(NodePath.join(harness.cwd, "README.md"), "staged edit\n");
      if (initializeGit) {
        NodeChildProcess.execFileSync("git", ["add", "README.md"], { cwd: harness.cwd });
      }
      NodeFS.writeFileSync(NodePath.join(harness.cwd, "README.md"), "unstaged edit\n");
      NodeFS.writeFileSync(NodePath.join(harness.cwd, "scratch.txt"), "untracked edit\n");
      const indexBefore = initializeGit
        ? NodeChildProcess.execFileSync("git", ["ls-files", "--stage"], {
            cwd: harness.cwd,
            encoding: "utf8",
          })
        : undefined;

      await Effect.runPromise(
        harness.engine.dispatch({
          type: commandType,
          commandId: CommandId.make("cmd-revert-request"),
          threadId: ThreadId.make("thread-1"),
          turnCount: 1,
          createdAt,
        }),
      );

      await waitForEvent(harness.engine, (event) => event.type === "thread.reverted");
      const thread = await waitForThread(
        harness.readModel,
        (entry) => entry.checkpoints.length === 1,
      );

      expect(thread.latestTurn?.turnId).toBe("turn-1");
      expect(thread.checkpoints).toHaveLength(1);
      expect(thread.checkpoints[0]?.checkpointTurnCount).toBe(1);
      expect(harness.provider.rollbackConversation).toHaveBeenCalledTimes(1);
      expect(harness.provider.rollbackConversation).toHaveBeenCalledWith({
        threadId: ThreadId.make("thread-1"),
        numTurns: 1,
      });
      expect(NodeFS.readFileSync(NodePath.join(harness.cwd, "README.md"), "utf8")).toBe(
        commandType === "thread.conversation.revert" ? "unstaged edit\n" : "v2\n",
      );
      if (commandType === "thread.conversation.revert") {
        expect(NodeFS.readFileSync(NodePath.join(harness.cwd, "scratch.txt"), "utf8")).toBe(
          "untracked edit\n",
        );
        if (initializeGit) {
          expect(
            NodeChildProcess.execFileSync("git", ["ls-files", "--stage"], {
              cwd: harness.cwd,
              encoding: "utf8",
            }),
          ).toBe(indexBefore);
        }
      }
      if (initializeGit) {
        expect(
          gitRefExists(harness.cwd, checkpointRefForThreadTurn(ThreadId.make("thread-1"), 2)),
        ).toBe(false);
      } else {
        expect(NodeFS.existsSync(NodePath.join(harness.cwd, ".git"))).toBe(false);
      }
    },
  );

  it("executes provider revert and emits thread.reverted for claude sessions", async () => {
    const harness = await createHarness({ providerName: ProviderDriverKind.make("claudeAgent") });
    const createdAt = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-claude"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: "claudeAgent",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.diff.complete",
        commandId: CommandId.make("cmd-diff-claude-1"),
        threadId: ThreadId.make("thread-1"),
        turnId: asTurnId("turn-claude-1"),
        completedAt: createdAt,
        checkpointRef: checkpointRefForThreadTurn(ThreadId.make("thread-1"), 1),
        status: "ready",
        files: [],
        checkpointTurnCount: 1,
        createdAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.diff.complete",
        commandId: CommandId.make("cmd-diff-claude-2"),
        threadId: ThreadId.make("thread-1"),
        turnId: asTurnId("turn-claude-2"),
        completedAt: createdAt,
        checkpointRef: checkpointRefForThreadTurn(ThreadId.make("thread-1"), 2),
        status: "ready",
        files: [],
        checkpointTurnCount: 2,
        createdAt,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.checkpoint.revert",
        commandId: CommandId.make("cmd-revert-request-claude"),
        threadId: ThreadId.make("thread-1"),
        turnCount: 1,
        createdAt,
      }),
    );

    await waitForEvent(harness.engine, (event) => event.type === "thread.reverted");
    expect(harness.provider.rollbackConversation).toHaveBeenCalledTimes(1);
    expect(harness.provider.rollbackConversation).toHaveBeenCalledWith({
      threadId: ThreadId.make("thread-1"),
      numTurns: 1,
    });
  });

  it("processes consecutive revert requests with deterministic rollback sequencing", async () => {
    const harness = await createHarness();
    const createdAt = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-inline-revert"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.diff.complete",
        commandId: CommandId.make("cmd-inline-revert-diff-1"),
        threadId: ThreadId.make("thread-1"),
        turnId: asTurnId("turn-1"),
        completedAt: createdAt,
        checkpointRef: checkpointRefForThreadTurn(ThreadId.make("thread-1"), 1),
        status: "ready",
        files: [],
        checkpointTurnCount: 1,
        createdAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.diff.complete",
        commandId: CommandId.make("cmd-inline-revert-diff-2"),
        threadId: ThreadId.make("thread-1"),
        turnId: asTurnId("turn-2"),
        completedAt: createdAt,
        checkpointRef: checkpointRefForThreadTurn(ThreadId.make("thread-1"), 2),
        status: "ready",
        files: [],
        checkpointTurnCount: 2,
        createdAt,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.checkpoint.revert",
        commandId: CommandId.make("cmd-sequenced-revert-request-1"),
        threadId: ThreadId.make("thread-1"),
        turnCount: 1,
        createdAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.checkpoint.revert",
        commandId: CommandId.make("cmd-sequenced-revert-request-0"),
        threadId: ThreadId.make("thread-1"),
        turnCount: 0,
        createdAt,
      }),
    );

    await harness.drain();

    expect(harness.provider.rollbackConversation).toHaveBeenCalledTimes(2);
    expect(harness.provider.rollbackConversation.mock.calls[0]?.[0]).toEqual({
      threadId: ThreadId.make("thread-1"),
      numTurns: 1,
    });
    expect(harness.provider.rollbackConversation.mock.calls[1]?.[0]).toEqual({
      threadId: ThreadId.make("thread-1"),
      numTurns: 1,
    });
  });

  effectIt.effect.each([false, true])(
    "restores files only in an isolated worktree without an active session, project cwd=%s",
    (useProjectCwd) =>
      Effect.gen(function* () {
        const harness = yield* Effect.promise(() =>
          createHarness({
            hasSession: false,
            ...(useProjectCwd ? { threadWorktreePath: null } : {}),
          }),
        );
        const createdAt = "2026-01-01T00:00:00.000Z";

        yield* harness.engine.dispatch({
          type: "thread.turn.diff.complete",
          commandId: CommandId.make("cmd-diff-before-session-recovery"),
          threadId: ThreadId.make("thread-1"),
          turnId: asTurnId("turn-1"),
          completedAt: createdAt,
          checkpointRef: checkpointRefForThreadTurn(ThreadId.make("thread-1"), 1),
          status: "ready",
          files: [],
          checkpointTurnCount: 1,
          createdAt,
        });
        yield* harness.engine.dispatch({
          type: "thread.checkpoint.revert",
          commandId: CommandId.make("cmd-revert-no-session"),
          threadId: ThreadId.make("thread-1"),
          turnCount: 0,
          createdAt,
        });

        yield* Effect.promise(harness.drain);
        if (useProjectCwd) {
          expect(harness.provider.rollbackConversation).not.toHaveBeenCalled();
          expect(NodeFS.readFileSync(NodePath.join(harness.cwd, "README.md"), "utf8")).toBe("v3\n");
          const model = yield* Effect.promise(harness.readModel);
          expect(model.threads[0]?.activities).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                kind: "checkpoint.revert.failed",
                payload: expect.objectContaining({
                  detail: expect.stringContaining("isolated worktree"),
                }),
              }),
            ]),
          );
        } else {
          expect(harness.provider.rollbackConversation).toHaveBeenCalledWith({
            threadId: ThreadId.make("thread-1"),
            numTurns: 1,
          });
          expect(NodeFS.readFileSync(NodePath.join(harness.cwd, "README.md"), "utf8")).toBe("v1\n");
        }
      }),
  );
});
