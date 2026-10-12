import {
  isImportedAgentSessionMessageId,
  type ComposerContextId,
  type ComposerContextKind,
  type ComposerContextRecord,
  type MessageId,
  type PreviewAnnotationPayload,
  type ThreadId,
} from "@t3tools/contracts";
import {
  collectComposerContextReferences,
  formatComposerContextReference,
  replaceComposerContextReferences,
} from "@t3tools/shared/composerContextReferences";
import {
  asKnownContextRecord,
  isSameComposerContextPayload,
  previewAnnotationContextRecord,
  previewAnnotationFromRecord,
  reviewCommentContextRecord,
  reviewCommentFromRecord,
  terminalContextDraftFromRecord,
  terminalContextRecord,
} from "../../lib/composerContextRecords";
import { toKindScopedComposerContextId } from "../../lib/composerContextReferences";
import { elementContextToPreviewAnnotation } from "../../lib/elementContext";
import type { TerminalContextDraft } from "../../lib/terminalContext";
import type { ReviewCommentContext } from "../../reviewCommentContext";
import type { ComposerFileAttachment, ComposerImageAttachment } from "../../composerDraftStore";
import type { ChatAttachment, ChatMessage } from "../../types";

/** Native rewind operates on turns, so a follow-up must retain earlier prompts. */
export function historyEditMessages(
  messages: ReadonlyArray<ChatMessage>,
  selectedId: MessageId,
  options: { hasOlderTurns?: boolean } = {},
): ReadonlyArray<ChatMessage> {
  const selectedIndex = messages.findIndex((message) => message.id === selectedId);
  const selected = messages[selectedIndex];
  if (!selected || selected.role !== "user" || isImportedAgentSessionMessageId(selected.id))
    return [];
  if (selected.turnId === null) return [selected];
  const firstIndex = messages.findIndex(
    (message) => message.role === "user" && message.turnId === selected.turnId,
  );
  const previousUser = messages.slice(0, firstIndex).findLast((message) => message.role === "user");
  if (
    options.hasOlderTurns &&
    messages.find(
      (message) => message.turnId !== null && !isImportedAgentSessionMessageId(message.id),
    )?.turnId === selected.turnId
  ) {
    throw new Error(
      "Load earlier turns before editing this message so its full prompt can be restored.",
    );
  }
  if (
    (previousUser?.turnId === null && !isImportedAgentSessionMessageId(previousUser.id)) ||
    messages
      .slice(firstIndex, selectedIndex)
      .some(
        (message) =>
          message.role === "user" &&
          message.turnId === null &&
          !isImportedAgentSessionMessageId(message.id),
      )
  ) {
    throw new Error(
      "T3 is missing saved turn information for an earlier message. Reload this chat and try again. Your conversation has not changed.",
    );
  }
  return messages
    .slice(0, selectedIndex + 1)
    .filter(
      (message) =>
        message.role === "user" &&
        message.turnId === selected.turnId &&
        !isImportedAgentSessionMessageId(message.id),
    );
}

export function historyEditPrompt(messages: ReadonlyArray<ChatMessage>): string {
  return messages
    .map((message) => message.text)
    .filter(Boolean)
    .join("\n\n");
}

export function restoreHistoryEditAttachment(
  original: ChatAttachment,
  file: File,
  id: string,
  createPreviewUrl: (file: File) => string,
): ComposerImageAttachment | ComposerFileAttachment {
  const attachment = { id, name: file.name, mimeType: file.type, sizeBytes: file.size, file };
  if (original.type === "image") {
    return {
      ...attachment,
      type: "image",
      previewUrl: createPreviewUrl(file),
      ...("source" in original && original.source ? { source: original.source } : {}),
    };
  }
  if (original.type === "file") {
    return {
      ...attachment,
      type: "file",
      ...("source" in original && original.source ? { source: original.source } : {}),
    };
  }
  throw new Error("This message has an attachment that cannot be restored.");
}

/** Prepare everything before native rewind: a missing payload must never become a lost prompt. */
export function prepareHistoryEdit(input: {
  messages: ReadonlyArray<ChatMessage>;
  threadId: ThreadId;
  terminalContexts: ReadonlyArray<TerminalContextDraft>;
  createId: () => string;
}) {
  const terminalContexts: TerminalContextDraft[] = [];
  const previewAnnotations: PreviewAnnotationPayload[] = [];
  const reviewComments: ReviewCommentContext[] = [];
  const attachmentIds: string[] = [];
  const prompts: ChatMessage[] = [];
  const fail = (detail: string): never => {
    throw new Error(
      `Cannot restore this message's ${detail}. Copy the original context into a new message instead.`,
    );
  };
  for (const message of input.messages) {
    const attachments = (message.attachments ?? []).map((attachment) => {
      const id = input.createId();
      attachmentIds.push(id);
      return { attachment, id };
    });
    const rewritten = new Map<
      string,
      { kind: ComposerContextKind; contextId: ComposerContextId }
    >();
    const records = message.context?.records ?? [];
    const recordsById = new Map<string, ComposerContextRecord>(
      records.map((record) => [record.contextId, record]),
    );
    if (recordsById.size !== records.length) fail("ambiguous context");
    for (const occurrence of collectComposerContextReferences(message.text)) {
      if (recordsById.get(occurrence.contextId)?.kind !== occurrence.kind) fail("missing context");
    }
    const attachmentId = (contextId: string): string => {
      const record = asKnownContextRecord(recordsById.get(contextId));
      if (!record || (record.kind !== "file" && record.kind !== "image"))
        return fail("attachment context");
      const matches = attachments.filter(({ attachment }) => attachment.id === record.attachmentId);
      const match = matches[0];
      if (
        matches.length !== 1 ||
        !match ||
        match.attachment.type !== record.kind ||
        match.attachment.name !== record.name ||
        match.attachment.mimeType !== record.mimeType ||
        match.attachment.sizeBytes !== record.sizeBytes
      )
        return fail("attachment context");
      return match.id;
    };
    for (const candidate of records) {
      const record = asKnownContextRecord(candidate) ?? fail("unsupported context");
      let id: string;
      let kind = record.kind;
      switch (record.kind) {
        case "terminal": {
          const imported = terminalContextDraftFromRecord(record, input.threadId);
          if (
            record.lineStart < 1 ||
            imported.text.length === 0 ||
            !isSameComposerContextPayload(record, terminalContextRecord(imported))
          ) {
            fail("terminal excerpt");
          }
          const existing = [...input.terminalContexts, ...terminalContexts].find(
            (context) =>
              context.terminalId === imported.terminalId &&
              context.lineStart === imported.lineStart &&
              context.lineEnd === imported.lineEnd,
          );
          if (existing && !isSameComposerContextPayload(record, terminalContextRecord(existing))) {
            fail(
              "terminal excerpt because the composer already has different text for those lines",
            );
          }
          id = existing?.id ?? input.createId();
          if (!existing) terminalContexts.push({ ...imported, id });
          break;
        }
        case "review-comment": {
          const imported = reviewCommentFromRecord(record);
          if (!isSameComposerContextPayload(record, reviewCommentContextRecord(imported)))
            fail("review comment");
          id = input.createId();
          reviewComments.push({ ...imported, id });
          break;
        }
        case "element": {
          id = input.createId();
          kind = "preview-annotation";
          previewAnnotations.push(
            elementContextToPreviewAnnotation(record, id, new Date().toISOString()),
          );
          break;
        }
        case "preview-annotation": {
          id = record.screenshotContextId
            ? attachmentId(record.screenshotContextId)
            : input.createId();
          if (previewAnnotations.some((annotation) => annotation.id === id))
            fail("shared preview screenshot");
          const annotation = { ...previewAnnotationFromRecord(record), id };
          const restored = previewAnnotationContextRecord(annotation);
          // Geometry is absent from saved records. All saved agent-facing fields must survive.
          if (
            !isSameComposerContextPayload(record, {
              ...restored,
              annotationId: record.annotationId,
              ...(record.screenshotContextId
                ? { screenshotContextId: record.screenshotContextId }
                : {}),
            })
          )
            fail("preview context");
          previewAnnotations.push(annotation);
          break;
        }
        case "image":
        case "file":
          id = attachmentId(record.contextId);
          break;
        default:
          return fail(`${record.kind} context`);
      }
      rewritten.set(record.contextId, { kind, contextId: toKindScopedComposerContextId(kind, id) });
    }
    prompts.push({
      ...message,
      text: replaceComposerContextReferences(message.text, (occurrence) => {
        const reference = rewritten.get(occurrence.contextId);
        if (!reference) return fail("missing context");
        return formatComposerContextReference({ ...reference, label: occurrence.label });
      }),
    });
  }
  return {
    prompt: historyEditPrompt(prompts),
    attachmentIds,
    terminalContexts,
    previewAnnotations,
    reviewComments,
  };
}
