import {
    appendSyntheticSectionMarkers,
    buildContentOffsetIndex,
    buildDomCitationIndex,
    buildDomDiagnostics,
    createDomCounters,
    emptyContentOffsetIndex,
    ensureSentencexLoaded,
    itemCharOffset,
    measureSectionSourceText,
    normalizeText,
    parseDomSection,
    stampSyntheticPageNumbers,
    type DomSection,
    type ItemPagePosition,
    type PageMarker,
} from "../dom";
import {
    SNAPSHOT_CONTENT_KIND,
    SNAPSHOT_SCHEMA_VERSION,
    type ExtractSnapshotResult,
    type SnapshotDocument,
} from "./schema";
import { getDeclaredCharset, isLikelyNonUtf8Charset, parseSnapshotHtml } from "./snapshotDom";
import { getReadableContentKind } from "../attachmentResolution";
import { effectiveMaxSnapshotFileSizeMB } from "../../attachmentLimits";
import { isRemoteAccessAvailable } from "../attachmentSource";
import { logger } from "../../../utils/logger";

// Coverage below this fraction means the walk dropped a meaningful share of the
// page's visible text (an unrecognized container/table structure) and warrants a
// warning so low-quality snapshot extractions are surfaced rather than silent.
const LOW_COVERAGE_WARN_THRESHOLD = 0.85;

// Synthetic page cadence (characters of content text). Snapshots carry no
// publisher page markers, so they always use synthetic pages — see dom/pagination.
const SYNTHETIC_PAGE_CHAR_INTERVAL = 1800;

export interface ExtractSnapshotDocumentOptions {
    maxFileSizeMB?: number | null;
    onFileNotSyncedLocally?: () => void;
}

type SnapshotResponseError = Extract<ExtractSnapshotResult, { kind: "response_error" }>;
export type SnapshotPreflightResult =
    | { kind: "ok"; filePath: string }
    | {
          kind: "response_error";
          code: SnapshotResponseError["code"];
          message: string;
      };

function responseError(
    code: SnapshotResponseError["code"],
    message: string,
): ExtractSnapshotResult {
    return { kind: "response_error", code, message };
}

function preflightResponseError(
    code: SnapshotResponseError["code"],
    message: string,
): SnapshotPreflightResult {
    return { kind: "response_error", code, message };
}

function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error ?? "Unknown error");
}

function formatMB(value: number): string {
    return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
    if (signal?.aborted) {
        throw new Error("Operation aborted");
    }
}

/** Filesystem basename of a path, tolerant of either separator. */
function pathBasename(filePath: string): string {
    try {
        const name = (globalThis as { PathUtils?: { filename?: (p: string) => string } })
            .PathUtils?.filename?.(filePath);
        if (name) return name;
    } catch {
        // Fall through to manual split.
    }
    const parts = filePath.split(/[\\/]/).filter(Boolean);
    return parts[parts.length - 1] || filePath;
}

/** True when the attachment is an HTML snapshot Beaver can extract. */
function isSnapshotAttachment(item: Zotero.Item): boolean {
    return getReadableContentKind(item) === "snapshot";
}

/**
 * Per-section display metadata for a snapshot item: `rawHref` is the source URL
 * when present, else the attachment filename (imported-file HTML has no `url`);
 * `fallbackLabel` is the attachment title then filename, used when the document
 * has no `<title>`. Best-effort — never throws.
 */
export async function resolveSnapshotSectionMeta(
    item: Zotero.Item,
): Promise<{ rawHref?: string; fallbackLabel?: string }> {
    try {
        await item.loadDataType?.("itemData");
    } catch {
        // Field reads degrade to undefined below.
    }
    let url: string | undefined;
    let title: string | undefined;
    try {
        url = item.getField?.("url") || undefined;
    } catch {
        url = undefined;
    }
    try {
        title = item.getField?.("title") || undefined;
    } catch {
        title = undefined;
    }
    const filename = item.attachmentFilename || undefined;
    return {
        rawHref: url || filename,
        fallbackLabel: title || filename,
    };
}

/** Extract a local Zotero HTML snapshot attachment into Beaver's section schema. */
export async function extractSnapshotDocument(item: Zotero.Item): Promise<SnapshotDocument> {
    if (!isSnapshotAttachment(item)) {
        throw new Error("Item is not an HTML snapshot attachment");
    }

    const filePath = await item.getFilePathAsync();
    if (!filePath) {
        throw new Error("Snapshot attachment has no local file");
    }

    const meta = await resolveSnapshotSectionMeta(item);
    return extractSnapshotDocumentFromFile(filePath, meta);
}

export interface ExtractSnapshotFromFileOptions {
    /** Section href: the source URL when known, else the filename. */
    rawHref?: string;
    /** Section label used when the document has no `<title>`. */
    fallbackLabel?: string;
    /** Language for sentence splitting; defaults to the document's `<html lang>`. */
    language?: string | null;
    /** Cooperative cancellation signal checked around DOM work. */
    abortSignal?: AbortSignal;
}

/**
 * Extract an HTML snapshot into Beaver's section-based schema directly from a
 * file path. Path-based core shared by the item-based extractor, the cache
 * wrapper, and dev tooling. Throws raw errors; callers that need request-safe
 * error shapes use {@link extractSnapshotDocumentSafe}.
 *
 * A snapshot is a single document, so this produces exactly one section. Pages
 * are synthetic (~character-interval); there is no publisher page label.
 */
export async function extractSnapshotDocumentFromFile(
    filePath: string,
    options?: ExtractSnapshotFromFileOptions,
): Promise<SnapshotDocument> {
    throwIfAborted(options?.abortSignal);
    const bytes = await IOUtils.read(filePath);
    throwIfAborted(options?.abortSignal);

    // Load the sentencex WASM once (best-effort; sentence splitting degrades to
    // a regex fallback if unavailable).
    await ensureSentencexLoaded();

    const doc = parseSnapshotHtml(bytes);

    // The reader decodes snapshots as UTF-8; warn when the page declares otherwise.
    const declaredCharset = getDeclaredCharset(doc);
    if (isLikelyNonUtf8Charset(declaredCharset)) {
        logger(
            `extractSnapshotDocument: declared charset "${declaredCharset}" is not UTF-8 for ${filePath} `
            + `— bytes are decoded as UTF-8 (matching the reader), so the extracted text may be garbled`,
            2,
        );
    }

    const body = doc.body ?? doc.querySelector("body");
    const language = options?.language ?? doc.documentElement?.getAttribute("lang") ?? null;

    const counters = createDomCounters();
    const syntheticMarkers: PageMarker[] = [];
    const itemPositions: ItemPagePosition[] = [];

    const offsets = body ? buildContentOffsetIndex(body) : emptyContentOffsetIndex();
    appendSyntheticSectionMarkers(offsets.contentNodes, 0, SYNTHETIC_PAGE_CHAR_INTERVAL, syntheticMarkers);

    const sourceTextChars = measureSectionSourceText(doc);
    const rawHref = options?.rawHref || pathBasename(filePath);

    const section: DomSection = parseDomSection({
        doc,
        sectionIndex: 0,
        rawHref,
        counters,
        language: language ?? undefined,
        onItem: (item, candidate) => {
            itemPositions.push({
                item,
                sectionIndex: 0,
                charOffset: itemCharOffset(candidate, offsets),
            });
        },
    });
    const label = normalizeText(doc.title || "") || options?.fallbackLabel;
    if (label) section.label = label;
    const sections = [section];

    throwIfAborted(options?.abortSignal);
    const pageCount = itemPositions.length === 0
        ? 0
        : stampSyntheticPageNumbers(itemPositions, syntheticMarkers);
    const diagnostics = buildDomDiagnostics(sections, sourceTextChars);
    if (diagnostics.textCoverage !== null && diagnostics.textCoverage < LOW_COVERAGE_WARN_THRESHOLD) {
        logger(
            `extractSnapshotDocument: low text coverage ${diagnostics.textCoverage} `
            + `(${diagnostics.extractedTextChars}/${diagnostics.sourceTextChars} chars) for ${filePath} `
            + `— body text may be in an unsupported structure (e.g. data tables)`,
            2,
        );
    }

    return {
        content_kind: SNAPSHOT_CONTENT_KIND,
        schemaVersion: SNAPSHOT_SCHEMA_VERSION,
        sectionCount: sections.length,
        pageCount,
        sections,
        citationIndex: buildDomCitationIndex(sections),
        diagnostics,
    };
}

/** Extract a snapshot attachment with request-safe preflight and error responses. */
export async function extractSnapshotDocumentSafe(
    item: Zotero.Item,
    options?: ExtractSnapshotDocumentOptions,
): Promise<ExtractSnapshotResult> {
    const preflight = await preflightSnapshotFile(item, options);
    if (preflight.kind === "response_error") {
        return responseError(preflight.code, preflight.message);
    }

    try {
        const meta = await resolveSnapshotSectionMeta(item);
        return {
            kind: "ok",
            document: await extractSnapshotDocumentFromFile(preflight.filePath, meta),
        };
    } catch (error) {
        return responseError("extraction_failed", `Failed to extract snapshot content: ${getErrorMessage(error)}`);
    }
}

/** Resolve and validate a local HTML snapshot attachment path before extraction. */
export async function preflightSnapshotFile(
    item: Zotero.Item,
    options?: ExtractSnapshotDocumentOptions,
): Promise<SnapshotPreflightResult> {
    let isSnapshot = false;
    try {
        isSnapshot = isSnapshotAttachment(item);
    } catch (error) {
        return preflightResponseError(
            "unsupported_type",
            `Unable to determine whether the attachment is a snapshot: ${getErrorMessage(error)}`,
        );
    }

    if (!isSnapshot) {
        return preflightResponseError("unsupported_type", "Attachment is not an HTML snapshot.");
    }

    let filePath: string | null = null;
    try {
        filePath = await item.getFilePathAsync() || null;
    } catch (error) {
        return preflightResponseError(
            "extraction_failed",
            `Failed to resolve the snapshot attachment file path: ${getErrorMessage(error)}`,
        );
    }

    if (!filePath) {
        let remoteAvailable = false;
        try {
            remoteAvailable = isRemoteAccessAvailable(item);
        } catch {
            remoteAvailable = false;
        }

        if (remoteAvailable) {
            try {
                options?.onFileNotSyncedLocally?.();
            } catch {
                // Notification callbacks must never change extraction results.
            }
            return preflightResponseError(
                "file_missing",
                "The snapshot file is available remotely but is not synced locally. Sync it in Zotero so Beaver can read it.",
            );
        }

        return preflightResponseError("file_missing", "The snapshot file is not available locally.");
    }

    const maxFileSizeMB = effectiveMaxSnapshotFileSizeMB(options?.maxFileSizeMB);
    try {
        const stat = await IOUtils.stat(filePath);
        const sizeMB = typeof stat.size === "number" ? stat.size / 1024 / 1024 : null;
        if (sizeMB != null && sizeMB > maxFileSizeMB) {
            return preflightResponseError(
                "file_too_large",
                `The snapshot file is ${formatMB(sizeMB)} MB, which exceeds the ${formatMB(maxFileSizeMB)} MB limit.`,
            );
        }
    } catch (error) {
        if ((error as { name?: string } | null)?.name === "NotFoundError") {
            return preflightResponseError("file_missing", "The snapshot file is no longer available locally.");
        }
        return preflightResponseError(
            "extraction_failed",
            `Failed to inspect the snapshot file: ${getErrorMessage(error)}`,
        );
    }

    return { kind: "ok", filePath };
}
