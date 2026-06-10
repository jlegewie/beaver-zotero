import type { DomDocument } from "../dom/schema";
import type { ZoteroDocumentErrorCode } from "../../agentProtocol";

export const EPUB_CONTENT_KIND = "epub" as const;
export const EPUB_SCHEMA_VERSION = "1" as const;

export type EpubContentKind = typeof EPUB_CONTENT_KIND;

export interface EpubDocument extends DomDocument {
    content_kind: typeof EPUB_CONTENT_KIND;
    schemaVersion: typeof EPUB_SCHEMA_VERSION;
}

export type ExtractEpubResult =
    | { kind: "ok"; document: EpubDocument }
    | { kind: "response_error"; code: ZoteroDocumentErrorCode; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === "object" && !Array.isArray(value);
}

function assertEpubDocument(condition: unknown, message: string): asserts condition {
    if (!condition) {
        throw new Error(`Invalid EPUB document cache payload: ${message}`);
    }
}

/** Validate a parsed cached EPUB payload before returning it to callers. */
export function validateEpubDocument(parsed: unknown): EpubDocument {
    assertEpubDocument(isRecord(parsed), "payload must be an object");
    assertEpubDocument(parsed.content_kind === EPUB_CONTENT_KIND, "content_kind must be epub");
    assertEpubDocument(parsed.schemaVersion === EPUB_SCHEMA_VERSION, "schemaVersion mismatch");
    assertEpubDocument(Array.isArray(parsed.sections), "sections must be an array");
    assertEpubDocument(
        typeof parsed.sectionCount === "number" && parsed.sectionCount === parsed.sections.length,
        "sectionCount must match sections length",
    );
    assertEpubDocument(isRecord(parsed.citationIndex), "citationIndex must be an object");
    assertEpubDocument(isRecord(parsed.diagnostics), "diagnostics must be an object");

    const diagnostics = parsed.diagnostics;
    assertEpubDocument(
        typeof diagnostics.extractedTextChars === "number",
        "diagnostics.extractedTextChars must be numeric",
    );
    assertEpubDocument(
        typeof diagnostics.sourceTextChars === "number",
        "diagnostics.sourceTextChars must be numeric",
    );
    assertEpubDocument(
        typeof diagnostics.textCoverage === "number" || diagnostics.textCoverage === null,
        "diagnostics.textCoverage must be numeric or null",
    );

    for (const section of parsed.sections) {
        assertEpubDocument(isRecord(section), "section must be an object");
        assertEpubDocument(typeof section.index === "number", "section.index must be numeric");
        assertEpubDocument(typeof section.rawHref === "string", "section.rawHref must be a string");
        assertEpubDocument(Array.isArray(section.items), "section.items must be an array");
    }

    return parsed as unknown as EpubDocument;
}
