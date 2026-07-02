import type { DomDocument } from "../dom/schema";
import type { ZoteroDocumentErrorCode } from "../../agentProtocol";

export const SNAPSHOT_CONTENT_KIND = "snapshot" as const;
// Bump when persisted snapshot extraction payloads need to be regenerated.
export const SNAPSHOT_SCHEMA_VERSION = "1" as const;

export type SnapshotContentKind = typeof SNAPSHOT_CONTENT_KIND;

/**
 * Beaver's extraction model for a saved HTML page.
 *
 * Despite the name, this models ANY imported HTML attachment (Beaver content-kind
 * `snapshot`: `text/html` or `application/xhtml+xml`) — both true web-page
 * snapshots (Zotero `imported_url`, which carry a source `url`) and plain imported
 * HTML files (`imported_file`, which have no `url`). The name tracks the existing
 * `content_kind` wire value shared with the backend.
 *
 * A snapshot is a single HTML document, so it has exactly one section. Pages are
 * synthetic (a fixed character cadence over the body text); snapshots carry no
 * publisher page markers and the reader is a continuous scroll view, so there is
 * no physical/printed page label.
 */
export interface SnapshotDocument extends DomDocument {
    content_kind: typeof SNAPSHOT_CONTENT_KIND;
    schemaVersion: typeof SNAPSHOT_SCHEMA_VERSION;
    /** Total synthetic page count (max stamped `pageNumber`); absent on malformed payloads. */
    pageCount?: number;
}

export type ExtractSnapshotResult =
    | { kind: "ok"; document: SnapshotDocument }
    | { kind: "response_error"; code: ZoteroDocumentErrorCode; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === "object" && !Array.isArray(value);
}

function assertSnapshotDocument(condition: unknown, message: string): asserts condition {
    if (!condition) {
        throw new Error(`Invalid snapshot document cache payload: ${message}`);
    }
}

/** Validate a parsed cached snapshot payload before returning it to callers. */
export function validateSnapshotDocument(parsed: unknown): SnapshotDocument {
    assertSnapshotDocument(isRecord(parsed), "payload must be an object");
    assertSnapshotDocument(parsed.content_kind === SNAPSHOT_CONTENT_KIND, "content_kind must be snapshot");
    assertSnapshotDocument(parsed.schemaVersion === SNAPSHOT_SCHEMA_VERSION, "schemaVersion mismatch");
    assertSnapshotDocument(Array.isArray(parsed.sections), "sections must be an array");
    assertSnapshotDocument(
        typeof parsed.sectionCount === "number" && parsed.sectionCount === parsed.sections.length,
        "sectionCount must match sections length",
    );
    assertSnapshotDocument(isRecord(parsed.citationIndex), "citationIndex must be an object");
    assertSnapshotDocument(isRecord(parsed.diagnostics), "diagnostics must be an object");

    const diagnostics = parsed.diagnostics;
    assertSnapshotDocument(
        typeof diagnostics.extractedTextChars === "number",
        "diagnostics.extractedTextChars must be numeric",
    );
    assertSnapshotDocument(
        typeof diagnostics.sourceTextChars === "number",
        "diagnostics.sourceTextChars must be numeric",
    );
    assertSnapshotDocument(
        typeof diagnostics.textCoverage === "number" || diagnostics.textCoverage === null,
        "diagnostics.textCoverage must be numeric or null",
    );

    for (const section of parsed.sections) {
        assertSnapshotDocument(isRecord(section), "section must be an object");
        assertSnapshotDocument(typeof section.index === "number", "section.index must be numeric");
        assertSnapshotDocument(typeof section.rawHref === "string", "section.rawHref must be a string");
        assertSnapshotDocument(Array.isArray(section.items), "section.items must be an array");
    }

    return parsed as unknown as SnapshotDocument;
}
