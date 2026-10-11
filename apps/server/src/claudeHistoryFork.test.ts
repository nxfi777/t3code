import {
  forkSession,
  getSessionMessages,
  type SessionStoreEntry,
} from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vite-plus/test";
import { prepareClaudeHistoryFork } from "./claudeHistoryFork.ts";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const sessionId = id(100);
const first = id(1),
  second = id(3),
  third = id(11);
function fixture(): SessionStoreEntry[] {
  const row = (n: number, type: string, parent: number | null, content: unknown, extra = {}) => ({
    type,
    uuid: id(n),
    parentUuid: parent === null ? null : id(parent),
    sessionId,
    timestamp: `2026-01-01T00:00:${String(n).padStart(2, "0")}.000Z`,
    message: { role: type, content },
    ...extra,
  });
  return [
    row(1, "user", null, "First primary"),
    row(2, "assistant", 1, [{ type: "text", text: "First reply" }]),
    row(3, "user", 2, "Second primary"),
    row(4, "assistant", 3, [{ type: "thinking", thinking: "Retained reasoning" }]),
    row(5, "assistant", 4, [
      { type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "README.md" } },
    ]),
    row(6, "user", 5, [
      { type: "tool_result", tool_use_id: "tool-1", content: "Retained tool output" },
    ]),
    row(7, "assistant", 6, [{ type: "text", text: "Second reply" }]),
    {
      type: "system",
      subtype: "compact_boundary",
      uuid: id(8),
      parentUuid: null,
      sessionId,
      compactMetadata: {
        preservedMessages: {
          anchorUuid: id(9),
          uuids: [id(4), id(5), id(6), id(7)],
          allUuids: [id(4), id(5), id(6), id(7)],
        },
        preservedSegment: { anchorUuid: id(9), headUuid: id(4), tailUuid: id(7) },
      },
    },
    row(9, "user", 8, "Compacted summary", { isCompactSummary: true }),
    row(11, "user", 9, "Third primary after compaction"),
    row(12, "assistant", 11, [{ type: "text", text: "Third reply" }]),
  ];
}
const read = (session: string, entries: SessionStoreEntry[]) =>
  getSessionMessages(session, {
    sessionStore: {
      load: async () => entries,
      append: async () => {
        throw new Error("Unexpected write");
      },
    },
  });

describe("Claude native history forks", () => {
  it("repairs real SDK compaction references and maps retained boundaries hidden from visible history", async () => {
    const entries = fixture();
    const sourceBefore = structuredClone(entries);
    const visible = await read(sessionId, entries);
    expect(visible.map((m) => m.uuid)).not.toContain(first);
    expect(visible.map((m) => m.uuid)).not.toContain(second);
    const result = await prepareClaudeHistoryFork(sessionId, entries, {
      retainedTurnStartMessageIds: [first, second],
      firstRemovedTurnStartMessageId: third,
    });
    const forkVisible = await read(result.sessionId, result.entries);
    const expected = await read(
      sessionId,
      entries.slice(
        0,
        entries.findIndex((e) => e.uuid === third),
      ),
    );
    expect(forkVisible.map((m) => m.message)).toEqual(expected.map((m) => m.message));
    expect(forkVisible).toHaveLength(5);
    const map = new Map(
      result.entries.map((entry) => [
        ((entry.forkedFrom ?? {}) as { messageUuid?: string }).messageUuid,
        entry.uuid,
      ]),
    );
    expect(result.turnStartMessageIds).toEqual([map.get(first), map.get(second)]);
    expect(result.entries.find((entry) => entry.type === "system")?.compactMetadata).toEqual({
      preservedMessages: {
        anchorUuid: map.get(id(9)),
        uuids: [4, 5, 6, 7].map((n) => map.get(id(n))),
        allUuids: [4, 5, 6, 7].map((n) => map.get(id(n))),
      },
      preservedSegment: {
        anchorUuid: map.get(id(9)),
        headUuid: map.get(id(4)),
        tailUuid: map.get(id(7)),
      },
    });
    expect(entries).toEqual(sourceBefore);
  });

  it("cuts before an older compacted turn without retaining the later summary or turns", async () => {
    const result = await prepareClaudeHistoryFork(sessionId, fixture(), {
      retainedTurnStartMessageIds: [first],
      firstRemovedTurnStartMessageId: second,
    });
    expect((await read(result.sessionId, result.entries)).map((m) => m.message)).toEqual(
      (await read(sessionId, fixture().slice(0, 2))).map((m) => m.message),
    );
    expect(result.entries.some((entry) => entry.compactMetadata !== undefined)).toBe(false);
    expect(result.turnStartMessageIds).toHaveLength(1);
  });

  it("preserves exact assistant boundaries recorded for synthetic background turns", async () => {
    const result = await prepareClaudeHistoryFork(sessionId, fixture(), {
      retainedTurnStartMessageIds: [first, second, id(4)],
      firstRemovedTurnStartMessageId: third,
    });
    expect(result.turnStartMessageIds).toHaveLength(3);
    expect(result.entries.find((entry) => entry.uuid === result.turnStartMessageIds[2])?.type).toBe(
      "assistant",
    );
  });

  it("forks a whole compacted history and retains exact raw native boundaries", async () => {
    const entries = fixture();
    const result = await prepareClaudeHistoryFork(sessionId, entries, {
      retainedTurnStartMessageIds: [first, second, third],
    });
    expect((await read(result.sessionId, result.entries)).map((m) => m.message)).toEqual(
      (await read(sessionId, entries)).map((m) => m.message),
    );
    expect(result.turnStartMessageIds).toHaveLength(3);
  });

  it.each(["missing", "duplicate", "wrong-role", "system", "tool-result", "out-of-order"])(
    "rejects an unproved raw boundary: %s",
    async (scenario) => {
      const entries = fixture();
      if (scenario === "duplicate") entries.push(entries[0]!);
      if (scenario === "wrong-role") entries[0] = { ...entries[0]!, type: "assistant" };
      if (scenario === "system") entries[0] = { ...entries[0]!, type: "system" };
      if (scenario === "tool-result")
        entries[0] = {
          ...entries[0]!,
          message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "tool-1", content: "Output" }],
          },
        };
      const boundaries =
        scenario === "missing"
          ? [id(999)]
          : scenario === "out-of-order"
            ? [second, first]
            : [first, second];
      await expect(
        prepareClaudeHistoryFork(sessionId, entries, {
          retainedTurnStartMessageIds: boundaries,
          firstRemovedTurnStartMessageId: third,
        }),
      ).rejects.toThrow(/boundary|boundaries/);
    },
  );

  it.each(["dropped-user", "changed-assistant", "extra-steer"])(
    "rejects changed native fork content: %s",
    async (scenario) => {
      const corrupt: typeof forkSession = async (source, options) => {
        const result = await forkSession(source, options);
        const copied = await options!.sessionStore!.load({
          sessionId: result.sessionId,
          projectKey: "unused",
        });
        if (!copied) throw new Error("Missing fixture fork");
        if (scenario === "dropped-user")
          copied.splice(
            copied.findIndex(
              (entry) => (entry.forkedFrom as { messageUuid?: string })?.messageUuid === first,
            ),
            1,
          );
        if (scenario === "changed-assistant") {
          const i = copied.findIndex((entry) => entry.type === "assistant");
          copied[i] = {
            ...copied[i]!,
            message: { role: "assistant", content: [{ type: "text", text: "Changed reply" }] },
          };
        }
        if (scenario === "extra-steer")
          copied.push({
            type: "user",
            uuid: id(555),
            parentUuid: copied.findLast((entry) => entry.type === "assistant")?.uuid,
            sessionId: result.sessionId,
            message: { role: "user", content: "Unexpected steering prompt" },
          });
        return result;
      };
      await expect(
        prepareClaudeHistoryFork(
          sessionId,
          fixture(),
          { retainedTurnStartMessageIds: [first], firstRemovedTurnStartMessageId: second },
          corrupt,
        ),
      ).rejects.toThrow(/preserve/);
    },
  );
});
