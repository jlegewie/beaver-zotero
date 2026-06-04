import type { BeaverExtractResult } from "../../../beaver-extract/schema/schema";
import type { EpubDocument } from "../epub/schema";
import type { ReadableContentKind } from "../readableAttachments";

/**
 * All intended extractable content kinds. The union is broader than the
 * currently implemented result arms so later producers can add their arm
 * without changing protocol plumbing.
 */
export type ExtractContentKind = Exclude<ReadableContentKind, "image">;

export type PdfDocumentExtractResult = BeaverExtractResult & { content_kind: "pdf" };

export interface TextDocumentExtractResult {
    content_kind: "text";
    schemaVersion: string;
    sourceContentType: string;
    lineCount: number;
    text: string;
}

export type DocumentExtractResult =
    | PdfDocumentExtractResult
    | EpubDocument
    | TextDocumentExtractResult;
