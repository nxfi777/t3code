import {
  CodexSettings,
  CommandId,
  TurnId,
  isImportedAgentSessionMessageId,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  ProjectionTurn,
  ProjectionTurnRepository,
} from "../persistence/Services/ProjectionTurns.ts";
import {
  createTranscriptJsonReader,
  createTranscriptJsonSelector,
  TranscriptJsonLimitError,
} from "../project/AgentSessionJson.ts";
import { resolveCodexHomeLayout } from "../provider/Drivers/CodexHomeLayout.ts";
import { ProviderSessionDirectory } from "../provider/Services/ProviderSessionDirectory.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";

// Old steering sends lack an app turn id. Only native, explicit membership is
// evidence: chronological proximity to a turn is deliberately never consulted.
const NativeRecord = Schema.Struct({
  type: Schema.optional(Schema.String),
  payload: Schema.optional(
    Schema.Struct({
      id: Schema.optional(Schema.String),
      type: Schema.optional(Schema.String),
      role: Schema.optional(Schema.String),
      content: Schema.optional(
        Schema.Array(
          Schema.Struct({
            type: Schema.optional(Schema.String),
            text: Schema.optional(Schema.String),
          }),
        ),
      ),
      internal_chat_message_metadata_passthrough: Schema.optional(
        Schema.Struct({
          turn_id: Schema.optional(Schema.NullOr(Schema.String)),
        }),
      ),
    }),
  ),
});
const decodeRecord = Schema.decodeUnknownOption(NativeRecord);
const selectRecord = createTranscriptJsonSelector(NativeRecord);
const decodeCursor = Schema.decodeUnknownOption(Schema.Struct({ threadId: Schema.String }));
const decodeSettings = Schema.decodeUnknownOption(CodexSettings);
const turnEquals = Schema.toEquivalence(ProjectionTurn);
const MAX_FILE_BYTES = 128 * 1024 * 1024;
const MAX_STARTUP_BYTES = 256 * 1024 * 1024;

function sameFile(left: FileSystem.File.Info, right: FileSystem.File.Info) {
  return (
    left.size === right.size &&
    left.dev === right.dev &&
    Option.getOrNull(left.ino) === Option.getOrNull(right.ino) &&
    Option.getOrNull(Option.map(left.mtime, (date) => date.getTime())) ===
      Option.getOrNull(Option.map(right.mtime, (date) => date.getTime()))
  );
}

/** Stream the complete file, retaining only requested texts and their native ids. */
export const readCodexUserTurnProof = Effect.fn("readCodexUserTurnProof")(function* (input: {
  readonly filePath: string;
  readonly nativeThreadId: string;
  readonly texts: ReadonlySet<string>;
}) {
  const fs = yield* FileSystem.FileSystem;
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const file = yield* fs.open(input.filePath, { flag: "r" });
      const before = yield* file.stat;
      const size = Number(before.size);
      if (size > MAX_FILE_BYTES) return null;
      const matches = new Map<string, { count: number; turnId: string | null }>();
      let sessionIds = 0;
      let correctSession = true;
      let records = 0;
      let recordBytes = 0;
      const reserve = (bytes: number) => {
        recordBytes += bytes;
        if (recordBytes > 4 * 1024 * 1024)
          throw new TranscriptJsonLimitError("Native proof record exceeds memory budget");
      };
      let reader = createTranscriptJsonReader(reserve, selectRecord);
      let decoder = new TextDecoder();
      let recordStarted = false;
      const finishRecord = () => {
        reader.write(decoder.decode());
        if (++records > 100_000)
          throw new TranscriptJsonLimitError("Native proof exceeds record budget");
        const decoded = decodeRecord(reader.finish());
        if (Option.isNone(decoded))
          throw new TranscriptJsonLimitError("Invalid native proof record");
        const record = decoded.value;
        if (record.type === "session_meta") {
          sessionIds++;
          correctSession &&= record.payload?.id === input.nativeThreadId;
        }
        const payload = record.payload;
        if (
          record.type === "response_item" &&
          payload?.type === "message" &&
          payload.role === "user"
        ) {
          const content = payload.content ?? [];
          const text = content.map((part) => part.text ?? "").join("\n");
          if (input.texts.has(text)) {
            const previous = matches.get(text);
            matches.set(text, {
              count: (previous?.count ?? 0) + 1,
              turnId:
                content.length > 0 &&
                content.every((part) => part.type === "input_text" && part.text !== undefined)
                  ? (payload.internal_chat_message_metadata_passthrough?.turn_id ?? null)
                  : null,
            });
          }
        }
        recordBytes = 0;
        reader = createTranscriptJsonReader(reserve, selectRecord);
        decoder = new TextDecoder();
        recordStarted = false;
      };
      let bytesRead = 0;
      while (bytesRead < size) {
        const chunk = yield* file.readAlloc(Math.min(32 * 1024, size - bytesRead));
        if (Option.isNone(chunk)) return null;
        bytesRead += chunk.value.byteLength;
        yield* Effect.try(() => {
          let start = 0;
          while (start < chunk.value.byteLength) {
            const newline = chunk.value.indexOf(10, start);
            const end = newline === -1 ? chunk.value.byteLength : newline;
            recordStarted = true;
            reader.write(decoder.decode(chunk.value.subarray(start, end), { stream: true }));
            if (newline === -1) break;
            finishRecord();
            start = newline + 1;
          }
        });
      }
      if (recordStarted) yield* Effect.try(finishRecord);
      if (sessionIds !== 1 || !correctSession || !sameFile(before, yield* file.stat)) return null;
      return new Map(
        Array.from(matches).flatMap(([text, match]) =>
          match.count === 1 && match.turnId ? [[text, TurnId.make(match.turnId)] as const] : [],
        ),
      );
    }),
  );
});

function busy(thread: Pick<OrchestrationThreadShell, "session" | "latestTurn">) {
  return (
    thread.session?.status === "starting" ||
    thread.session?.status === "running" ||
    thread.session?.activeTurnId != null ||
    thread.latestTurn?.state === "running"
  );
}

/** The caller runs this inside the parked checkpoint worker, serially with completions. */
export const makeCodexUserMessageRepair = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const environment = yield* HostProcessEnvironment;
  const settingsService = yield* ServerSettingsService;
  const directory = yield* ProviderSessionDirectory;
  const snapshots = yield* ProjectionSnapshotQuery;
  const turnsRepository = yield* ProjectionTurnRepository;
  const engine = yield* OrchestrationEngineService;

  return Effect.gen(function* () {
    const bindings = (yield* directory.listBindings())
      .filter((binding) => binding.provider === "codex")
      .toSorted((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt));
    if (bindings.length === 0) return;
    const settings = yield* settingsService.getSettings;
    const shells = yield* snapshots.getShellSnapshot();
    const indexes = new Map<string, Map<string, string[]> | null>();
    let remainingBytes = MAX_STARTUP_BYTES;
    let remainingThreads = 64;
    const indexHome = Effect.fn("indexCodexRepairHome")(function* (home: string) {
      if (indexes.has(home)) return indexes.get(home)!;
      const index = new Map<string, string[]>();
      let operations = 256;
      let entriesLeft = 50_000;
      const pending = [
        { dir: path.join(home, "sessions"), depth: 0 },
        { dir: path.join(home, "archived_sessions"), depth: 3 },
      ];
      while (pending.length > 0) {
        if (--operations < 0) {
          indexes.set(home, null);
          return null;
        }
        const next = pending.pop()!;
        const entries = yield* fs
          .readDirectory(next.dir)
          .pipe(
            Effect.catch((error) =>
              error.reason._tag === "NotFound" ? Effect.succeed([]) : Effect.fail(error),
            ),
          );
        entriesLeft -= entries.length;
        if (entriesLeft < 0) {
          indexes.set(home, null);
          return null;
        }
        for (const name of entries) {
          const id =
            /-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(
              name,
            )?.[1];
          if (id) index.set(id, [...(index.get(id) ?? []), path.join(next.dir, name)]);
          else if (next.depth < 3 && /^\d{2,4}$/.test(name))
            pending.push({ dir: path.join(next.dir, name), depth: next.depth + 1 });
        }
      }
      indexes.set(home, index);
      return index;
    });
    for (const binding of bindings) {
      const shell = shells.threads.find((entry) => entry.id === binding.threadId);
      if (!shell || shell.archivedAt !== null || busy(shell)) continue;
      yield* Effect.gen(function* () {
        const cursor = decodeCursor(binding.resumeCursor);
        if (Option.isNone(cursor)) return;
        let turns = yield* turnsRepository.listByThreadId({ threadId: shell.id });
        if (
          turns.length === 0 ||
          turns.filter((turn) => turn.turnId === null).length > 1 ||
          turns.some(
            (turn) =>
              turn.turnId !== null &&
              (turn.state === "pending" || turn.state === "running" || turn.completedAt === null),
          )
        )
          return;
        const detail = yield* snapshots.getThreadDetailById(shell.id);
        if (Option.isNone(detail) || busy(detail.value)) return;
        const users = detail.value.messages.filter((message) => message.role === "user");
        const pendingMessageId = turns.find((turn) => turn.turnId === null)?.pendingMessageId;
        const candidates = users
          .filter(
            (message) =>
              message.turnId === null &&
              !message.streaming &&
              !isImportedAgentSessionMessageId(message.id) &&
              !message.attachments?.length &&
              !message.context?.records.length &&
              message.text.length > 0 &&
              message.text.length <= 16 * 1024 &&
              users.filter((other) => other.text === message.text).length === 1,
          )
          .toSorted(
            (left, right) =>
              Number(right.id === pendingMessageId) - Number(left.id === pendingMessageId),
          );
        if (candidates.length === 0 || candidates.length > 512 || --remainingThreads < 0) return;
        const instanceId = binding.providerInstanceId;
        if (!instanceId) return;
        const instance = settings.providerInstances[instanceId];
        if (instance && instance.driver !== "codex") return;
        if (!instance && instanceId !== "codex") return;
        const config = decodeSettings(instance?.config ?? settings.providers.codex);
        if (Option.isNone(config)) return;
        const environmentHome =
          instance?.environment?.findLast((variable) => variable.name === "CODEX_HOME")?.value ??
          environment.CODEX_HOME;
        const layout = yield* resolveCodexHomeLayout(
          config.value.homePath.trim() ||
            config.value.shadowHomePath.trim() ||
            !environmentHome?.trim()
            ? config.value
            : { ...config.value, homePath: environmentHome },
        );
        const index = yield* indexHome(layout.sharedHomePath);
        const paths = index?.get(cursor.value.threadId);
        if (paths?.length !== 1) return;
        const filePath = paths[0]!;
        const size = Number((yield* fs.stat(filePath)).size);
        if (size > MAX_FILE_BYTES || size > remainingBytes) return;
        remainingBytes -= size;
        const proof = yield* readCodexUserTurnProof({
          filePath,
          nativeThreadId: cursor.value.threadId,
          texts: new Set(candidates.map((message) => message.text)),
        });
        if (!proof) return;
        // An unaccepted/queued request must continue blocking history actions.
        // Resolve a pending placeholder only from this exact message's proof,
        // before attempting any other historical membership repair.
        if (
          pendingMessageId &&
          !candidates.some(
            (message) =>
              message.id === pendingMessageId &&
              turns.some((turn) => turn.turnId === proof.get(message.text)),
          )
        )
          return;
        for (const message of candidates) {
          const turnId = proof.get(message.text);
          if (!turnId || turns.filter((turn) => turn.turnId === turnId).length !== 1) continue;
          const fresh = yield* snapshots.getThreadShellById(shell.id);
          if (
            Option.isNone(fresh) ||
            fresh.value.archivedAt !== shell.archivedAt ||
            busy(fresh.value)
          )
            return;
          const freshTurns = yield* turnsRepository.listByThreadId({ threadId: shell.id });
          if (
            freshTurns.length !== turns.length ||
            freshTurns.some((turn, index) => !turnEquals(turn, turns[index]!))
          )
            return;
          yield* engine.dispatch({
            type: "thread.message.user.bind-turn",
            commandId: CommandId.make(`native-user-proof:${yield* crypto.randomUUIDv4}`),
            threadId: shell.id,
            messageId: message.id,
            turnId,
            verifiedHistory: { text: message.text },
          });
          if (message.id === pendingMessageId)
            turns = yield* turnsRepository.listByThreadId({ threadId: shell.id });
        }
      }).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterrupts(cause)
            ? Effect.interrupt
            : Effect.logWarning("Could not verify historical Codex user-turn membership", {
                threadId: shell.id,
                cause,
              }),
        ),
      );
    }
  }).pipe(Effect.provideService(FileSystem.FileSystem, fs), Effect.provideService(Path.Path, path));
});
