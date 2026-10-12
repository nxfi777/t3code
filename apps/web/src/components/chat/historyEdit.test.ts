import { describe, expect, it } from "vite-plus/test";
import {
  ComposerContextId,
  MessageId,
  ThreadId,
  TurnId,
  type ComposerContextRecord,
  type PreviewAnnotationPayload,
} from "@t3tools/contracts";
import {
  collectComposerContextReferences,
  formatComposerContextReference,
  projectComposerContextForProvider,
} from "@t3tools/shared/composerContextReferences";
import {
  attachmentContextRecord,
  buildMessageContext,
  previewAnnotationContextRecord,
  reviewCommentContextRecord,
  terminalContextRecord,
} from "../../lib/composerContextRecords";
import type { TerminalContextDraft } from "../../lib/terminalContext";
import { buildPlanImplementationPrompt } from "../../proposedPlan";
import type { ChatMessage } from "../../types";
import {
  historyEditMessages,
  historyEditPrompt,
  prepareHistoryEdit,
  restoreHistoryEditAttachment,
} from "./historyEdit";

const threadId = ThreadId.make("thread");
const terminal: TerminalContextDraft = {
  id: "existing",
  threadId,
  terminalId: "terminal-1",
  terminalLabel: "Terminal 1",
  lineStart: 1,
  lineEnd: 2,
  text: "npm test\nfailed",
  createdAt: "2026-10-11T00:00:00.000Z",
};

function prepare(
  messages: ReadonlyArray<ChatMessage>,
  terminalContexts: TerminalContextDraft[] = [],
) {
  let id = 0;
  return prepareHistoryEdit({
    messages,
    threadId,
    terminalContexts,
    createId: () => `restored-${++id}`,
  });
}

function contextMessage(id: string, records: ComposerContextRecord[]): ChatMessage {
  return {
    ...message(id, "turn"),
    text: `${id} ${records.map(formatComposerContextReference).join(" ")}`,
    context: { version: 1, records },
  };
}

function message(id: string, turn: string | null, role: ChatMessage["role"] = "user"): ChatMessage {
  return {
    id: MessageId.make(id),
    role,
    text: id,
    turnId: turn === null ? null : TurnId.make(turn),
    streaming: false,
    createdAt: "2026-10-10T09:02:12.645Z",
    updatedAt: "2026-10-10T09:02:12.645Z",
  };
}

describe("whole-turn history editing", () => {
  it("retains the original prompt and earlier follow-ups, excluding later prompts and other turns", () => {
    const original = { ...message("original", "turn"), attachments: [] };
    const followup = message("selected follow-up", "turn");
    const messages = [
      message("previous", "previous"),
      original,
      message("interim reply", "turn", "assistant"),
      message("first follow-up", "turn"),
      message("queued next turn", "next"),
      followup,
      message("later follow-up", "turn"),
    ];
    const restored = historyEditMessages(messages, followup.id);
    expect(restored).toEqual([original, messages[3], followup]);
    expect(restored[0]).toBe(original);
    expect(historyEditPrompt(restored)).toBe("original\n\nfirst follow-up\n\nselected follow-up");
    expect(historyEditMessages(messages, original.id)).toEqual([original]);
  });

  it("refuses a paginated edge or a missing primary association before collecting a suffix", () => {
    const selected = message("follow-up", "turn");
    expect(() => historyEditMessages([selected], selected.id, { hasOlderTurns: true })).toThrow(
      "Load earlier turns",
    );
    expect(
      historyEditMessages([message("previous", "previous"), selected], selected.id, {
        hasOlderTurns: true,
      }),
    ).toEqual([selected]);
    expect(() =>
      historyEditMessages([message("unlinked primary", null), selected], selected.id),
    ).toThrow("missing saved turn information");
    expect(() =>
      historyEditMessages(
        [message("original", "turn"), message("unlinked answer", null), selected],
        selected.id,
      ),
    ).toThrow("missing saved turn information");
  });

  it("preserves the entire plan and legacy context for both primary and follow-up edits", () => {
    const text = `${buildPlanImplementationPrompt("1. Keep migrations reversible.\n2. Add SQLite.")}\n\n<terminal_context>\n- Terminal 1 line 1:\n  1 | failure details\n</terminal_context>\n\n<review_comment filePath="src/db.ts">Keep the transaction.</review_comment>`;
    const original = { ...message("original", "turn"), text };
    const followup = message("use WAL mode", "turn");
    expect(prepare([original]).prompt).toBe(text);
    expect(prepare(historyEditMessages([original, followup], followup.id)).prompt).toBe(
      `${text}\n\nuse WAL mode`,
    );
  });

  it("restores terminal and review backing records without changing their provider payload", () => {
    const comment = reviewCommentContextRecord({
      id: "comment",
      sectionId: "section",
      sectionTitle: "Review",
      filePath: "src/db.ts",
      startIndex: 1,
      endIndex: 2,
      rangeLabel: "L2-3",
      text: "Keep the transaction",
      diff: "- old\n+ new",
      fenceLanguage: "diff",
    });
    const original = contextMessage("fix", [terminalContextRecord(terminal), comment]);
    const restored = prepare([original]);
    expect(restored.terminalContexts).toHaveLength(1);
    expect(restored.reviewComments).toHaveLength(1);
    const context = buildMessageContext(restored)!;
    const references = collectComposerContextReferences(restored.prompt);
    expect(references.map((reference) => reference.contextId)).toEqual(
      context.records.map((record) => record.contextId),
    );
    const provider = projectComposerContextForProvider({
      text: restored.prompt,
      records: context.records,
    });
    expect(provider).toContain("1 | npm test\n2 | failed");
    expect(provider).toContain("Keep the transaction");
    expect(provider).toContain("- old\n  + new");
    expect(provider).not.toContain('unavailable="true"');
  });

  it("reuses identical terminal excerpts and rejects same-range excerpts with different text", () => {
    const original = contextMessage("first", [terminalContextRecord(terminal)]);
    const followup = contextMessage("second", [
      terminalContextRecord({ ...terminal, id: "different" }),
    ]);
    const restored = prepare([original, followup], [terminal]);
    expect(restored.terminalContexts).toEqual([]);
    expect(
      collectComposerContextReferences(restored.prompt).map((reference) => reference.contextId),
    ).toEqual(["terminal_existing", "terminal_existing"]);
    expect(prepare([original, followup]).terminalContexts).toHaveLength(1);
    expect(() => prepare([original], [{ ...terminal, text: "different output" }])).toThrow(
      "different text for those lines",
    );
    expect(() =>
      prepare([
        original,
        contextMessage("changed", [terminalContextRecord({ ...terminal, text: "new output" })]),
      ]),
    ).toThrow("different text for those lines");
  });

  it("remaps attachment references and preview screenshots together, preserving each message's bindings", () => {
    const annotation: PreviewAnnotationPayload = {
      id: "annotation",
      pageUrl: "http://localhost/",
      pageTitle: "Page",
      comment: "Move this left",
      elements: [],
      regions: [{ id: "region", rect: { x: 1, y: 1, width: 1, height: 1 } }],
      strokes: [],
      styleChanges: [],
      screenshot: null,
      createdAt: terminal.createdAt,
    };
    const image = {
      type: "image" as const,
      id: "uploaded",
      name: "page.png",
      mimeType: "image/png",
      sizeBytes: 4,
    };
    const imageRecord = attachmentContextRecord({
      attachment: {
        ...image,
        id: annotation.id,
        previewUrl: "blob:old",
        file: new File(["data"], image.name, { type: image.mimeType }),
      },
      attachmentId: image.id,
    });
    const original = {
      ...contextMessage("change", [
        previewAnnotationContextRecord(annotation, { screenshotContextId: annotation.id }),
        imageRecord,
      ]),
      attachments: [image],
    };
    const restored = prepare([original, { ...original, id: MessageId.make("followup") }]);
    expect(new Set(restored.attachmentIds).size).toBe(2);
    expect(restored.previewAnnotations.map((entry) => entry.id)).toEqual(restored.attachmentIds);
    const attachments = restored.attachmentIds.map((id) => ({
      attachment: {
        ...image,
        id,
        previewUrl: "blob:new",
        file: new File(["data"], image.name, { type: image.mimeType }),
      },
      attachmentId: `new-${id}`,
    }));
    const context = buildMessageContext({ ...restored, attachments })!;
    const recordsById = new Map(context.records.map((record) => [record.contextId, record]));
    for (const reference of collectComposerContextReferences(restored.prompt))
      expect(recordsById.has(reference.contextId)).toBe(true);
    expect(context.records.filter((record) => record.kind === "preview-annotation")).toMatchObject(
      restored.attachmentIds.map((id) => ({
        targetSummary: "1 marked region",
        screenshotContextId: `image_${id}`,
        comment: "Move this left",
      })),
    );
  });

  it("refuses incomplete, unsupported, or lossy context before rewind", () => {
    const original = contextMessage("fix", [terminalContextRecord(terminal)]);
    expect(() =>
      prepare([contextMessage("expired", [terminalContextRecord({ ...terminal, text: "" })])]),
    ).toThrow("terminal excerpt");
    expect(() => prepare([{ ...original, context: { version: 1, records: [] } }])).toThrow(
      "missing context",
    );
    const { context: _context, ...missingContext } = original;
    expect(() => prepare([missingContext])).toThrow("missing context");
    expect(() =>
      prepare([
        contextMessage("future", [
          {
            version: 1,
            kind: "future",
            contextId: ComposerContextId.make("future"),
            label: "Future",
            payload: { important: true },
          },
        ]),
      ]),
    ).toThrow("unsupported context");
    expect(() =>
      prepare([
        contextMessage("missing image", [
          {
            version: 1,
            kind: "image",
            contextId: ComposerContextId.make("image_missing"),
            label: "Image",
            attachmentId: "missing",
            name: "image.png",
            mimeType: "image/png",
            sizeBytes: 1,
          },
        ]),
      ]),
    ).toThrow("attachment context");
    expect(() =>
      prepare([
        contextMessage("old annotation", [
          {
            version: 1,
            kind: "preview-annotation",
            contextId: ComposerContextId.make("preview_old"),
            label: "Selection",
            annotationId: "old",
            pageUrl: "http://localhost",
            pageTitle: null,
            comment: "Move left",
            targetSummary: "2 marked regions",
            styleChanges: [],
          },
        ]),
      ]),
    ).toThrow("preview context");
  });

  it("keeps pasted-text handling and screenshot provenance when rebuilding remapped draft attachments", () => {
    const textFile = new File(["saved text"], "pasted.txt", { type: "text/plain" });
    const file = {
      type: "file" as const,
      id: "uploaded-file",
      name: textFile.name,
      mimeType: textFile.type,
      sizeBytes: textFile.size,
      source: { _tag: "pasted-text" as const },
    };
    const imageFile = new File(["png"], "capture.png", { type: "image/png" });
    const image = {
      type: "image" as const,
      id: "uploaded-image",
      name: imageFile.name,
      mimeType: imageFile.type,
      sizeBytes: imageFile.size,
      source: {
        kind: "snap-shot" as const,
        capturedAt: terminal.createdAt,
        appName: "Editor",
        windowTitle: "Workspace",
        accessibleText: "Selected code",
      },
    };
    const restored = prepare([{ ...message("attachments", "turn"), attachments: [file, image] }]);
    const restoredFile = restoreHistoryEditAttachment(
      file,
      textFile,
      restored.attachmentIds[0]!,
      () => {
        throw new Error("Text files need no preview");
      },
    );
    const restoredImage = restoreHistoryEditAttachment(
      image,
      imageFile,
      restored.attachmentIds[1]!,
      () => "blob:restored-image",
    );
    expect(restoredFile).toEqual({ ...file, id: restored.attachmentIds[0], file: textFile });
    expect(restoredImage).toEqual({
      ...image,
      id: restored.attachmentIds[1],
      file: imageFile,
      previewUrl: "blob:restored-image",
    });
  });

  it("never gathers unrelated unassociated messages or imported prefixes", () => {
    const selected = message("selected", null);
    expect(historyEditMessages([message("other", null), selected], selected.id)).toEqual([
      selected,
    ]);
    const inherited = message("import:fork:source", "turn");
    expect(historyEditMessages([inherited], inherited.id)).toEqual([]);
    expect(
      historyEditMessages([message("assistant", "turn", "assistant")], MessageId.make("assistant")),
    ).toEqual([]);
  });
});
