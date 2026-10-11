import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  MessageId,
  OrchestrationThread,
  OrchestrationThreadShell,
  ProviderDriverKind,
  ProviderInstanceId,
  TurnId,
  type OrchestrationCommand,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import {
  ProjectionTurnRepository,
  type ProjectionTurn,
} from "../persistence/Services/ProjectionTurns.ts";
import { ProviderSessionDirectory } from "../provider/Services/ProviderSessionDirectory.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";
import { makeCodexUserMessageRepair, readCodexUserTurnProof } from "./CodexUserMessageRepair.ts";

const nativeId = "01a11dfa-20a9-7c41-aa7b-fef6ddbed839";
const nativeTurn = "01a1250b-fd8f-7801-a77c-e674f5a6481c";
const now = "2026-10-10T09:00:00.000Z";
const text =
  "also when i press cmd shift 4 its supposed to use my screenshot tool and t3 is overriding it";
const meta = { type: "session_meta", payload: { id: nativeId } };
const user = (message = text, turnId: string | null = nativeTurn) => ({
  type: "response_item",
  payload: {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: message }],
    internal_chat_message_metadata_passthrough: { turn_id: turnId },
  },
});

const fixture = (records: unknown[]) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-native-user-proof-" });
    const dir = path.join(home, "sessions", "2026", "10", "09");
    yield* fs.makeDirectory(dir, { recursive: true });
    const filePath = path.join(dir, `rollout-2026-10-09T01-04-54-${nativeId}.jsonl`);
    yield* fs.writeFileString(
      filePath,
      records.map((record) => JSON.stringify(record)).join("\n") + "\n",
    );
    return { home, filePath };
  });

it.layer(NodeServices.layer)("Codex historical user-turn proof", (it) => {
  it.effect("reads exact explicit native membership while streaming large unrelated output", () =>
    Effect.gen(function* () {
      const { filePath } = yield* fixture([
        meta,
        {
          type: "response_item",
          payload: { type: "function_call_output", output: "x".repeat(5 * 1024 * 1024) },
        },
        user(),
      ]);
      const proof = yield* readCodexUserTurnProof({
        filePath,
        nativeThreadId: nativeId,
        texts: new Set([text]),
      });
      expect(proof?.get(text)).toBe(nativeTurn);
    }),
  );

  it.effect.each(["duplicate", "missing-turn", "different-session", "image"] as const)(
    "rejects ambiguous or incomplete native evidence: %s",
    (reason) =>
      Effect.gen(function* () {
        const prompt = user(text, reason === "missing-turn" ? null : nativeTurn);
        const records = [
          reason === "different-session" ? { ...meta, payload: { id: "other" } } : meta,
          reason === "image"
            ? {
                ...prompt,
                payload: {
                  ...prompt.payload,
                  content: [...prompt.payload.content, { type: "input_image" }],
                },
              }
            : prompt,
          ...(reason === "duplicate" ? [user()] : []),
        ];
        const { filePath } = yield* fixture(records);
        const proof = yield* readCodexUserTurnProof({
          filePath,
          nativeThreadId: nativeId,
          texts: new Set([text]),
        });
        expect(proof?.has(text) ?? false).toBe(false);
      }),
  );

  it.effect.each([
    "repair",
    "active",
    "duplicate-local",
    "imported",
    "turn-race",
    "busy-between",
    "pending",
    "unproved-pending",
  ] as const)("repairs only verified idle local history: %s", (scenario) =>
    Effect.gen(function* () {
      const secondText = "A second accepted follow-up";
      const { home } = yield* fixture([meta, user(), user(secondText)]);
      let thread = yield* Schema.decodeUnknownEffect(OrchestrationThread)({
        id: "thread",
        projectId: "project",
        title: "Source",
        modelSelection: { instanceId: "codex", model: "gpt-5" },
        runtimeMode: "full-access",
        branch: null,
        worktreePath: null,
        latestTurn: null,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
        activities: [],
        checkpoints: [],
        session: null,
        messages: [
          {
            id: "primary",
            role: "user",
            text: "Primary",
            turnId: nativeTurn,
            streaming: false,
            createdAt: now,
            updatedAt: now,
          },
          {
            id: scenario === "imported" ? "import:codex:old" : "steering",
            role: "user",
            text,
            turnId: null,
            streaming: false,
            createdAt: now,
            updatedAt: now,
          },
          ...(scenario === "duplicate-local"
            ? [
                {
                  id: "duplicate",
                  role: "user",
                  text,
                  turnId: null,
                  streaming: false,
                  createdAt: now,
                  updatedAt: now,
                },
              ]
            : []),
          ...(scenario === "busy-between" || scenario === "pending"
            ? [
                {
                  id: "second",
                  role: "user",
                  text: secondText,
                  turnId: null,
                  streaming: false,
                  createdAt: now,
                  updatedAt: now,
                },
              ]
            : []),
        ],
      });
      let shell = yield* Schema.decodeEffect(OrchestrationThreadShell)({
        ...thread,
        latestUserMessageAt: now,
        hasPendingApprovals: false,
        hasPendingUserInput: false,
        hasActionableProposedPlan: false,
        session:
          scenario === "active"
            ? {
                threadId: thread.id,
                status: "running",
                providerName: "codex",
                runtimeMode: "full-access",
                activeTurnId: nativeTurn,
                lastError: null,
                updatedAt: now,
              }
            : null,
      });
      let turns: ProjectionTurn[] = [
        {
          threadId: thread.id,
          turnId: TurnId.make(nativeTurn),
          pendingMessageId: MessageId.make("primary"),
          sourceProposedPlanThreadId: null,
          sourceProposedPlanId: null,
          assistantMessageId: null,
          state: "completed",
          requestedAt: now,
          startedAt: now,
          completedAt: now,
          checkpointTurnCount: 1,
          checkpointRef: null,
          checkpointStatus: "missing",
          checkpointFiles: [],
        },
      ];
      if (scenario === "pending" || scenario === "unproved-pending")
        turns = [
          ...turns,
          {
            ...turns[0]!,
            turnId: null,
            pendingMessageId: MessageId.make(scenario === "pending" ? "steering" : "unaccepted"),
            state: "pending",
            startedAt: null,
            completedAt: null,
            checkpointTurnCount: null,
            checkpointStatus: null,
          },
        ];
      const before = thread;
      const commands: OrchestrationCommand[] = [];
      let turnReads = 0;
      const dependencies = Layer.mergeAll(
        Layer.mock(ServerSettingsService)({
          getSettings: Effect.succeed({
            ...DEFAULT_SERVER_SETTINGS,
            providerInstances: {},
            providers: {
              ...DEFAULT_SERVER_SETTINGS.providers,
              codex: { ...DEFAULT_SERVER_SETTINGS.providers.codex, homePath: home },
            },
          }),
        }),
        Layer.mock(ProviderSessionDirectory)({
          listBindings: () =>
            Effect.succeed([
              {
                threadId: thread.id,
                provider: ProviderDriverKind.make("codex"),
                providerInstanceId: ProviderInstanceId.make("codex"),
                resumeCursor: { threadId: nativeId },
                lastSeenAt: now,
              },
            ]),
        }),
        Layer.mock(ProjectionSnapshotQuery)({
          getShellSnapshot: () =>
            Effect.succeed({ snapshotSequence: 1, projects: [], threads: [shell], updatedAt: now }),
          getThreadShellById: () => Effect.sync(() => Option.some(shell)),
          getThreadDetailById: () => Effect.sync(() => Option.some(thread)),
        }),
        Layer.mock(ProjectionTurnRepository)({
          listByThreadId: () =>
            Effect.sync(() => {
              turnReads++;
              return scenario === "turn-race" && turnReads > 1
                ? [...turns, { ...turns[0]!, turnId: null, state: "pending" as const }]
                : turns;
            }),
        }),
        Layer.mock(OrchestrationEngineService)({
          dispatch: (command) =>
            Effect.sync(() => {
              commands.push(command);
              if (command.type === "thread.message.user.bind-turn") {
                thread = {
                  ...thread,
                  messages: thread.messages.map((message) =>
                    message.id === command.messageId
                      ? { ...message, turnId: command.turnId }
                      : message,
                  ),
                };
                turns = turns.filter(
                  (turn) => turn.turnId !== null || turn.pendingMessageId !== command.messageId,
                );
              }
              if (scenario === "busy-between")
                shell = {
                  ...shell,
                  latestTurn: {
                    turnId: TurnId.make("new"),
                    state: "running",
                    requestedAt: now,
                    startedAt: now,
                    completedAt: null,
                    assistantMessageId: null,
                  },
                };
              return { sequence: commands.length };
            }),
        }),
      );
      const repair = yield* makeCodexUserMessageRepair.pipe(Effect.provide(dependencies));
      yield* repair;
      expect(commands).toHaveLength(
        scenario === "pending" ? 2 : scenario === "repair" || scenario === "busy-between" ? 1 : 0,
      );
      expect(turns[0]?.pendingMessageId).toBe("primary");
      expect(thread.updatedAt).toBe(before.updatedAt);
      expect(thread.messages.map(({ turnId: _, ...message }) => message)).toEqual(
        before.messages.map(({ turnId: _, ...message }) => message),
      );
      if (scenario === "repair") {
        expect(thread.messages[1]?.turnId).toBe(nativeTurn);
        yield* repair;
        expect(commands).toHaveLength(1);
      }
      if (scenario === "pending") {
        expect(turns).toHaveLength(1);
        expect(thread.messages.every((message) => message.turnId === nativeTurn)).toBe(true);
        yield* repair;
        expect(commands).toHaveLength(2);
      }
    }),
  );
});
