// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import {
  forkSession,
  getSessionMessages,
  type SessionStore,
  type SessionStoreEntry,
} from "@anthropic-ai/claude-agent-sdk";
import * as Schema from "effect/Schema";

export interface ClaudeHistoryForkOptions {
  readonly dir?: string;
  readonly retainedTurnStartMessageIds: ReadonlyArray<string>;
  readonly firstRemovedTurnStartMessageId?: string;
}
export interface ClaudeHistoryForkResult {
  readonly sessionId: string;
  readonly turnStartMessageIds: ReadonlyArray<string>;
}
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TRANSCRIPT_BYTES = 128 * 1024 * 1024;
const decodeRow = Schema.decodeSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);
const encodeRow = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const object = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const human = (entry: SessionStoreEntry): boolean => {
  if (entry.type !== "user" || entry.isMeta || entry.isSidechain) return false;
  const content = object(entry.message)?.content;
  return (
    typeof content === "string" ||
    (Array.isArray(content) &&
      content.some((part) => {
        const type = object(part)?.type;
        return typeof type === "string" && type !== "tool_result";
      }))
  );
};
// The adapter also records exact assistant UUIDs for synthetic turns started by
// background responses between user prompts. These remain real native cuts.
const boundary = (entry: SessionStoreEntry): boolean =>
  human(entry) ||
  (entry.type === "assistant" &&
    !entry.isMeta &&
    !entry.isSidechain &&
    object(entry.message)?.role === "assistant");
const invalid = (detail: string): never => {
  throw new Error(`Cannot safely fork Claude history: ${detail}`);
};

// Use the SDK's actual fork and history readers, rather than approximating its
// compaction/parallel-tool chain. Nothing reaches disk until both agree.
export async function prepareClaudeHistoryFork(
  sessionId: string,
  entries: SessionStoreEntry[],
  options: ClaudeHistoryForkOptions,
  createFork: typeof forkSession = forkSession,
): Promise<ClaudeHistoryForkResult & { readonly entries: SessionStoreEntry[] }> {
  if (!uuidPattern.test(sessionId)) invalid("invalid source session id.");
  const locateBoundary = (id: string) => {
    if (!uuidPattern.test(id)) return invalid("invalid native turn boundary.");
    const indices = entries.flatMap((entry, index) => (entry.uuid === id ? [index] : []));
    if (indices.length !== 1 || !boundary(entries[indices[0]!]!))
      return invalid("the exact native conversation boundary is unavailable.");
    return indices[0]!;
  };
  const cut =
    options.firstRemovedTurnStartMessageId === undefined
      ? entries.length
      : locateBoundary(options.firstRemovedTurnStartMessageId);
  const retainedIndices = options.retainedTurnStartMessageIds.map(locateBoundary);
  if (
    retainedIndices.length === 0 ||
    retainedIndices.some((index, i) => index >= cut || (i > 0 && index <= retainedIndices[i - 1]!))
  )
    invalid("retained native boundaries are not an ordered prefix.");
  const source = entries.slice(0, cut);
  const sessions = new Map<string, SessionStoreEntry[]>([[sessionId, source]]);
  const store: SessionStore = {
    load: async (key) => sessions.get(key.sessionId) ?? null,
    append: async (key, batch) => {
      if (key.sessionId === sessionId) invalid("the SDK attempted to overwrite the source.");
      sessions.set(key.sessionId, [...(sessions.get(key.sessionId) ?? []), ...batch]);
    },
  };
  const sdkOptions = {
    sessionStore: store,
    ...(options.dir !== undefined ? { dir: options.dir } : {}),
  };
  const fork = await createFork(sessionId, sdkOptions);
  if (fork.sessionId === sessionId || !uuidPattern.test(fork.sessionId))
    invalid("the SDK did not return an independent session.");
  const forkEntries = sessions.get(fork.sessionId) ?? invalid("the SDK did not write the fork.");
  const mapping = new Map<string, SessionStoreEntry>();
  for (const entry of forkEntries) {
    const from = object(entry.forkedFrom);
    if (
      from?.sessionId !== sessionId ||
      typeof from.messageUuid !== "string" ||
      typeof entry.uuid !== "string"
    )
      continue;
    const previous = mapping.get(from.messageUuid);
    if (previous && previous.uuid !== entry.uuid) invalid("ambiguous native fork provenance.");
    mapping.set(from.messageUuid, entry);
  }
  const turnStartMessageIds = retainedIndices.map((index) => {
    const original = entries[index]!;
    const copied = mapping.get(original.uuid!);
    if (
      !copied ||
      !boundary(copied) ||
      copied.type !== original.type ||
      !NodeUtil.isDeepStrictEqual(copied.message, original.message)
    )
      return invalid("the fork did not preserve a retained native boundary.");
    return copied.uuid!;
  });
  // SDK 0.3.276 remaps message/parent UUIDs but leaves these compaction
  // references pointing into the source session. Restore the same graph using
  // its own exact forkedFrom mapping; never synthesize a missing message.
  const remap = (value: unknown): unknown =>
    typeof value === "string" ? (mapping.get(value)?.uuid ?? value) : value;
  const repaired = forkEntries.map((entry) => {
    const metadata = object(entry.compactMetadata);
    if (entry.type !== "system" || entry.subtype !== "compact_boundary" || !metadata) return entry;
    const preserved = object(metadata.preservedMessages);
    const segment = object(metadata.preservedSegment);
    return {
      ...entry,
      compactMetadata: {
        ...metadata,
        ...(preserved
          ? {
              preservedMessages: {
                ...preserved,
                anchorUuid: remap(preserved.anchorUuid),
                ...(Array.isArray(preserved.uuids) ? { uuids: preserved.uuids.map(remap) } : {}),
                ...(Array.isArray(preserved.allUuids)
                  ? { allUuids: preserved.allUuids.map(remap) }
                  : {}),
              },
            }
          : {}),
        ...(segment
          ? {
              preservedSegment: {
                ...segment,
                headUuid: remap(segment.headUuid),
                tailUuid: remap(segment.tailUuid),
                anchorUuid: remap(segment.anchorUuid),
              },
            }
          : {}),
      },
    };
  });
  sessions.set(fork.sessionId, repaired);
  const conversation = (messages: Awaited<ReturnType<typeof getSessionMessages>>) =>
    messages.filter((message) => message.type === "user" || message.type === "assistant");
  const expected = conversation(await getSessionMessages(sessionId, sdkOptions));
  const actual = conversation(await getSessionMessages(fork.sessionId, sdkOptions));
  if (
    expected.length === 0 ||
    expected.length !== actual.length ||
    expected.some(
      (message, index) =>
        message.type !== actual[index]?.type ||
        !NodeUtil.isDeepStrictEqual(message.message, actual[index]?.message),
    )
  )
    invalid("the fork did not preserve the selected conversation.");
  return { sessionId: fork.sessionId, turnStartMessageIds, entries: repaired };
}

async function locateTranscript(sessionId: string, dir?: string): Promise<string> {
  if (!uuidPattern.test(sessionId)) return invalid("invalid source session id.");
  const projects = NodePath.join(
    process.env.CLAUDE_CONFIG_DIR || NodePath.join(NodeOS.homedir(), ".claude"),
    "projects",
  );
  const isFile = async (file: string) => {
    try {
      return (await NodeFSP.lstat(file)).isFile();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  };
  if (dir) {
    const cwd = await NodeFSP.realpath(dir).catch(() => NodePath.resolve(dir));
    const candidate = NodePath.join(
      projects,
      cwd.replace(/[^a-zA-Z0-9]/g, "-"),
      `${sessionId}.jsonl`,
    );
    if (await isFile(candidate)) return candidate;
  }
  // Long hashed project names and worktree locations are SDK implementation
  // details. Resolve the exact UUID in this provider's home, without guessing
  // their encoding or searching transcript contents.
  const directories = await NodeFSP.readdir(projects, { withFileTypes: true });
  if (directories.length > 4096)
    return invalid("the provider home exceeds the bounded transcript lookup.");
  let found: string | undefined;
  for (const directory of directories) {
    if (!directory.isDirectory()) continue;
    const candidate = NodePath.join(projects, directory.name, `${sessionId}.jsonl`);
    if (!(await isFile(candidate))) continue;
    if (found) return invalid("the source session exists in multiple project directories.");
    found = candidate;
  }
  return found ?? invalid("the source transcript is unavailable.");
}

export async function forkClaudeHistory(
  sessionId: string,
  options: ClaudeHistoryForkOptions,
): Promise<ClaudeHistoryForkResult> {
  const sourcePath = await locateTranscript(sessionId, options.dir);
  const before = await NodeFSP.stat(sourcePath);
  if (before.size > MAX_TRANSCRIPT_BYTES)
    return invalid("the source exceeds the bounded transcript size.");
  const contents = await NodeFSP.readFile(sourcePath, "utf8");
  const entries: SessionStoreEntry[] = [];
  for (const line of contents.split("\n")) {
    if (!line.trim()) continue;
    const row = decodeRow(line);
    if (typeof row.type !== "string" || (row.uuid !== undefined && typeof row.uuid !== "string"))
      return invalid("invalid transcript record.");
    entries.push(row as SessionStoreEntry);
  }
  const fork = await prepareClaudeHistoryFork(sessionId, entries, options);
  const after = await NodeFSP.stat(sourcePath);
  if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs)
    return invalid("the source changed during verification.");
  const target = NodePath.join(NodePath.dirname(sourcePath), `${fork.sessionId}.jsonl`);
  const temporary = `${target}.t3-tmp`;
  const handle = await NodeFSP.open(temporary, "wx", 0o600);
  try {
    for (const entry of fork.entries) await handle.writeFile(`${encodeRow(entry)}\n`);
    await handle.sync();
    await handle.close();
    // link is atomic and refuses to overwrite an existing session. Publish only
    // the completely validated transcript, then remove its private staging link.
    await NodeFSP.link(temporary, target);
  } finally {
    await handle.close();
    await NodeFSP.unlink(temporary);
  }
  return { sessionId: fork.sessionId, turnStartMessageIds: fork.turnStartMessageIds };
}
