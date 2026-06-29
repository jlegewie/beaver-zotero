import {
    BoundingBox,
    CoordOrigin,
} from "../../../react/types/citations";
import { ZoteroItemReference } from "../../../react/types/zotero";
import { NotePosition } from "../../../react/types/agentActions/annotations";
import { PageGeometry } from "../../beaver-extract/types";
import { getAttachmentFileStatus } from "../agentDataProvider/utils";
import { isRemoteFilePath } from "../documentFileIdentity";
import {
    BEAVER_ANNOTATION_AUTHOR,
    resolveBeaverAnnotationColor,
} from "../../constants/annotations";
import {
    displayBoxToZoteroRect,
    sourceBboxesToZoteroRects,
} from "./annotationGeometry";
import { getReadableContentKind } from "../documentExtraction/attachmentResolution";
import {
    resolveEpubAnnotationTarget,
    type EpubAnnotationLocator,
} from "./epub/epubAnnotationResolver";
import {
    buildAnnotationFromDocument,
    loadSnapshotDocument,
    resolveSnapshotAnnotationTarget,
    type ResolvedSnapshotAnnotation,
    type SnapshotAnnotationLocator,
    type SnapshotAnnotationResolveError,
} from "./snapshot/snapshotAnnotationResolver";

const NOTE_RECT_SIZE = 18;
const NOTE_SIDE_MARGIN = 12;

export type MissingPageGeometryReason = "unavailable" | "extraction_failed";

export class MissingPageGeometryError extends Error {
    readonly code = "missing_page_geometry" as const;
    readonly reason: MissingPageGeometryReason;
    readonly libraryId: number;
    readonly zoteroKey: string;
    readonly pageIndex: number;

    constructor(opts: {
        reason: MissingPageGeometryReason;
        libraryId: number;
        zoteroKey: string;
        pageIndex: number;
        message?: string;
    }) {
        super(
            opts.message ??
            `Missing page geometry (${opts.reason}) for ${opts.libraryId}-${opts.zoteroKey} p${opts.pageIndex}`,
        );
        this.name = "MissingPageGeometryError";
        this.reason = opts.reason;
        this.libraryId = opts.libraryId;
        this.zoteroKey = opts.zoteroKey;
        this.pageIndex = opts.pageIndex;
    }
}

export interface CreateHighlightInput {
    pageIndex: number;
    boxes: BoundingBox[];
    text: string;
    color?: string | null;
    comment?: string | null;
    pageLabel?: string | null;
    /** Backend-supplied per-page cumulative character offset in reading order. */
    readingOrderOffset?: number | null;
    /** Tags applied to the created annotation. */
    tags?: string[];
}

export interface CreateNoteInput {
    notePosition: NotePosition;
    comment: string;
    color?: string | null;
    pageLabel?: string | null;
    /** See CreateHighlightInput.readingOrderOffset. */
    readingOrderOffset?: number | null;
    /** Tags applied to the created annotation. */
    tags?: string[];
}

/**
 * Return the first candidate label that is present and non-blank (after
 * trimming), else null. A whitespace-only `/PageLabels` entry is treated as
 * "no label" so the caller falls back to the physical page number.
 */
function firstNonBlankPageLabel(...candidates: (string | null | undefined)[]): string | null {
    for (const candidate of candidates) {
        if (typeof candidate === "string" && candidate.trim() !== "") {
            return candidate;
        }
    }
    return null;
}

/** Coerce `value` to a non-negative integer ≤ `max`. NaN/Infinity/null/negatives become 0. */
function clampNonNegativeInt(value: unknown, max: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
    const floored = Math.floor(value);
    if (floored <= 0) return 0;
    return floored > max ? max : floored;
}

export interface BuildSortIndexInput {
    pageIndex: number;
    /** PDF user-space viewBox of the page (PageGeometry.viewBox). */
    viewBox: [number, number, number, number] | readonly number[];
    /** Zotero rect [left, bottom, right, top] in unrotated PDF user space. */
    rect: number[];
    /** Backend-supplied per-page cumulative character offset in reading order. */
    readingOrderOffset?: number | null;
}

/**
 * Build a Zotero PDF annotation sort index in the canonical `page|offset|top`
 * format (Zotero's PDF format is enforced by chrome/content/zotero/xpcom/data/
 * item.js as `^\d{5}\|\d{6}\|\d{5}$`).
 *
 * - `offset` uses the backend's per-page reading-order character offset when
 *   supplied. That offset lives on the same character scale as Zotero's native
 *   sortIndex offset (the closest-glyph index from the reader's getSortIndex),
 *   so Beaver annotations interleave with manually created ones instead of
 *   clustering. Falls back to display-top so the y-direction is still correct.
 * - `top` is `Math.floor(viewBox[3] - rect[3])`, matching Zotero's reader at
 *   /reader/src/pdf/selection.js:399. Using `viewBox[3]` directly
 *   (not `viewBox[3]-viewBox[1]`) avoids a cropbox-offset discrepancy in the
 *   Beaver rect conversion (see annotationGeometry.ts).
 */
export function buildSortIndex(input: BuildSortIndexInput): string {
    const rect = Array.isArray(input.rect) ? input.rect : [];
    const viewBox = Array.isArray(input.viewBox) ? input.viewBox : [];
    const rectTop = rect[3];
    const viewBoxTop = viewBox[3];
    const displayTopRaw =
        typeof viewBoxTop === 'number'
        && Number.isFinite(viewBoxTop)
        && typeof rectTop === 'number'
        && Number.isFinite(rectTop)
            ? Math.floor(viewBoxTop - rectTop)
            : 0;
    const displayTop = clampNonNegativeInt(displayTopRaw, 99999);

    const rawIndex = input.readingOrderOffset;
    const hasIndex = typeof rawIndex === 'number' && Number.isFinite(rawIndex);
    const offset = hasIndex
        ? clampNonNegativeInt(rawIndex, 999999)
        : clampNonNegativeInt(displayTopRaw, 999999);

    const page = clampNonNegativeInt(input.pageIndex, 99999);

    return [
        page.toString().padStart(5, '0'),
        offset.toString().padStart(6, '0'),
        displayTop.toString().padStart(5, '0'),
    ].join('|');
}

function geometryError(
    attachment: Zotero.Item,
    pageIndex: number,
    reason: MissingPageGeometryReason,
    message: string,
): MissingPageGeometryError {
    return new MissingPageGeometryError({
        reason,
        libraryId: attachment.libraryID,
        zoteroKey: attachment.key,
        pageIndex,
        message,
    });
}

/**
 * Convert extraction bounding boxes into Zotero PDF annotation rectangles.
 *
 * Extraction bboxes use Beaver Extract's public page frame. Zotero stores
 * `position.rects` in unrotated PDF user space, so conversion goes through
 * the shared extraction-frame-to-annotation-frame helper.
 */
export function convertHighlightBoxesToRects(
    boxes: BoundingBox[],
    geometry: PageGeometry,
): number[][] {
    return sourceBboxesToZoteroRects(boxes, geometry);
}

/**
 * Compute the Zotero position rectangle for a PDF note annotation.
 *
 * `notePosition` is expressed in the **display** frame — `side` /
 * `y` describe where on the visible (post-`/Rotate`) page the note
 * should anchor. We build the bbox in that display frame then route
 * through `displayBoxToZoteroRect` to land in unrotated PDF user-space
 * (the frame Zotero stores `position.rects` in). PDF.js re-applies the
 * `/Rotate` transform when rendering.
 */
export function computeNoteRect(
    notePosition: NotePosition,
    geometry: PageGeometry,
): number[] {
    const isQuarterTurn = geometry.rotation === 90 || geometry.rotation === 270;
    const displayWidth = isQuarterTurn ? geometry.height : geometry.width;
    const displayHeight = isQuarterTurn ? geometry.width : geometry.height;

    const x = notePosition.side === "right"
        ? displayWidth - NOTE_RECT_SIZE - NOTE_SIDE_MARGIN
        : NOTE_SIDE_MARGIN;
    const yTop = notePosition.coord_origin === CoordOrigin.TOPLEFT
        ? notePosition.y - NOTE_RECT_SIZE / 2
        : displayHeight - notePosition.y - NOTE_RECT_SIZE / 2;

    return displayBoxToZoteroRect(
        {
            l: x,
            t: yTop,
            r: x + NOTE_RECT_SIZE,
            b: yTop + NOTE_RECT_SIZE,
        },
        geometry,
    );
}

function getCachedPageGeometry(
    cached: { pages?: (PageGeometry | null)[] | null } | null | undefined,
    pageIndex: number,
): PageGeometry | null {
    return cached?.pages?.[pageIndex] ?? null;
}

/**
 * Resolve a page's cached geometry, refreshing document metadata on cache miss.
 */
export async function getPageGeometryForAttachment(
    attachment: Zotero.Item,
    pageIndex: number,
): Promise<PageGeometry> {
    if (!attachment.isPDFAttachment()) {
        throw new Error("getPageGeometryForAttachment: attachment is not a PDF");
    }
    if (!Number.isInteger(pageIndex) || pageIndex < 0) {
        throw new Error("getPageGeometryForAttachment: pageIndex must be a non-negative integer");
    }

    const filePath = await attachment.getFilePathAsync();
    if (!filePath) {
        throw geometryError(
            attachment,
            pageIndex,
            "unavailable",
            "attachment file path is null",
        );
    }
    if (isRemoteFilePath(filePath)) {
        throw geometryError(
            attachment,
            pageIndex,
            "unavailable",
            "remote attachment not supported in v1",
        );
    }

    const ref = { libraryId: attachment.libraryID, zoteroKey: attachment.key };
    const cache = Zotero.Beaver?.documentCache;
    const cached = await cache?.getMetadata(ref, filePath);
    const cachedGeometry = getCachedPageGeometry(cached, pageIndex);
    if (cachedGeometry) {
        return cachedGeometry;
    }

    await getAttachmentFileStatus(attachment, false);

    const refreshed = await cache?.getMetadata(ref, filePath);
    const refreshedGeometry = getCachedPageGeometry(refreshed, pageIndex);
    if (refreshedGeometry) {
        return refreshedGeometry;
    }

    if (!refreshed) {
        throw geometryError(
            attachment,
            pageIndex,
            "unavailable",
            "cache empty after refresh",
        );
    }
    if (refreshed.errorCode) {
        throw geometryError(
            attachment,
            pageIndex,
            "extraction_failed",
            `cache errorCode ${refreshed.errorCode}`,
        );
    }
    if (!refreshed.pages) {
        throw geometryError(
            attachment,
            pageIndex,
            "unavailable",
            "pages field missing after refresh",
        );
    }
    if (pageIndex >= refreshed.pages.length) {
        throw geometryError(
            attachment,
            pageIndex,
            "unavailable",
            `page_index ${pageIndex} >= pages.length ${refreshed.pages.length}`,
        );
    }

    throw geometryError(
        attachment,
        pageIndex,
        "unavailable",
        `geometry null for page ${pageIndex}`,
    );
}

/**
 * Create a headless Zotero PDF highlight annotation from cached geometry.
 */
export async function createHighlightAnnotation(
    attachment: Zotero.Item,
    input: CreateHighlightInput,
): Promise<ZoteroItemReference> {
    if (!attachment.isPDFAttachment()) {
        throw new Error("createHighlightAnnotation: attachment is not a PDF");
    }

    const geometry = await getPageGeometryForAttachment(
        attachment,
        input.pageIndex,
    );
    const rects = convertHighlightBoxesToRects(input.boxes, geometry);
    if (rects.length === 0) {
        throw new Error("Highlight annotation produced no rects");
    }

    const sortIndex = buildSortIndex({
        pageIndex: input.pageIndex,
        viewBox: geometry.viewBox,
        rect: rects[0],
        readingOrderOffset: input.readingOrderOffset,
    });
    const item = new Zotero.Item("annotation");
    item.libraryID = attachment.libraryID;
    item.parentID = attachment.id;
    item.annotationType = "highlight";
    item.annotationText = input.text ?? "";
    item.annotationComment = input.comment ?? "";
    item.annotationColor = resolveBeaverAnnotationColor(input.color);
    item.annotationPageLabel =
        firstNonBlankPageLabel(input.pageLabel) ?? String(input.pageIndex + 1);
    const sortIndexField: Pick<ZoteroAnnotationItem, "annotationSortIndex"> = {
        annotationSortIndex: sortIndex,
    };
    Object.assign(item, sortIndexField);
    item.annotationPosition = JSON.stringify({
        pageIndex: input.pageIndex,
        rects,
    });
    item.annotationAuthorName = BEAVER_ANNOTATION_AUTHOR;
    // addTag calls setTags internally, so tags persist in the same saveTx write.
    if (input.tags?.length) {
        for (const tag of input.tags) item.addTag(tag);
    }
    await item.saveTx();

    return { library_id: attachment.libraryID, zotero_key: item.key };
}

/**
 * Create a headless Zotero PDF note annotation from cached geometry.
 */
export async function createNoteAnnotation(
    attachment: Zotero.Item,
    input: CreateNoteInput,
): Promise<ZoteroItemReference> {
    if (!attachment.isPDFAttachment()) {
        throw new Error("createNoteAnnotation: attachment is not a PDF");
    }

    const pageIndex = input.notePosition.page_index;
    const geometry = await getPageGeometryForAttachment(attachment, pageIndex);
    const rect = computeNoteRect(input.notePosition, geometry);
    const sortIndex = buildSortIndex({
        pageIndex,
        viewBox: geometry.viewBox,
        rect,
        readingOrderOffset: input.readingOrderOffset,
    });

    const item = new Zotero.Item("annotation");
    item.libraryID = attachment.libraryID;
    item.parentID = attachment.id;
    item.annotationType = "note";
    item.annotationComment = input.comment;
    item.annotationColor = resolveBeaverAnnotationColor(input.color);
    item.annotationPageLabel =
        firstNonBlankPageLabel(input.pageLabel) ?? String(pageIndex + 1);
    const sortIndexField: Pick<ZoteroAnnotationItem, "annotationSortIndex"> = {
        annotationSortIndex: sortIndex,
    };
    Object.assign(item, sortIndexField);
    item.annotationPosition = JSON.stringify({ pageIndex, rects: [rect] });
    item.annotationAuthorName = BEAVER_ANNOTATION_AUTHOR;
    // addTag calls setTags internally, so tags persist in the same saveTx write.
    if (input.tags?.length) {
        for (const tag of input.tags) item.addTag(tag);
    }
    await item.saveTx();

    return { library_id: attachment.libraryID, zotero_key: item.key };
}

// ---------------------------------------------------------------------------
// EPUB annotations (headless epubcfi — no reader instance)
// ---------------------------------------------------------------------------

/** Failure creating an EPUB annotation; `code` maps to a per-item error code. */
export class EpubAnnotationError extends Error {
    readonly code: string;

    constructor(code: string, message?: string) {
        super(message ?? code);
        this.name = "EpubAnnotationError";
        this.code = code;
    }
}

interface EpubLocatorInput {
    /** Section href within the EPUB (matched by basename). */
    sectionHref?: string;
    /** 1-based extractor (compacted) section ordinal; href fallback. */
    sectionOrdinal?: number;
    /** DOM id of the cited element inside the section. */
    anchorId?: string;
    /** Cited passage text used to anchor the range. */
    text?: string;
    color?: string | null;
    pageLabel?: string | null;
    /** Tags applied to the created annotation. */
    tags?: string[];
}

export interface CreateEpubHighlightInput extends EpubLocatorInput {
    /** Cited passage to locate and highlight. */
    text: string;
    comment?: string | null;
}

export interface CreateEpubNoteInput extends EpubLocatorInput {
    comment: string;
}

function assertEpubAttachment(attachment: Zotero.Item): void {
    if (getReadableContentKind(attachment) !== "epub") {
        throw new EpubAnnotationError("invalid_attachment", "attachment is not an EPUB");
    }
}

async function getEpubFilePath(attachment: Zotero.Item): Promise<string> {
    const filePath = await attachment.getFilePathAsync();
    if (!filePath) {
        throw new EpubAnnotationError("attachment_file_unavailable", "attachment file path is null");
    }
    if (isRemoteFilePath(filePath)) {
        throw new EpubAnnotationError("attachment_file_unavailable", "remote attachment not supported");
    }
    return filePath;
}

async function resolveEpubAnnotationOrThrow(
    attachment: Zotero.Item,
    locator: EpubAnnotationLocator,
) {
    assertEpubAttachment(attachment);
    const filePath = await getEpubFilePath(attachment);
    const resolved = await resolveEpubAnnotationTarget(filePath, locator);
    if ("error" in resolved) {
        throw new EpubAnnotationError(resolved.error, resolved.message);
    }
    return resolved;
}

/**
 * Create a headless Zotero EPUB highlight annotation. The epubcfi `position`
 * and `sortIndex` are computed from the EPUB's own XHTML (no open reader);
 * the reader renders the saved item via the notifier if the book is open.
 */
export async function createEpubHighlightAnnotation(
    attachment: Zotero.Item,
    input: CreateEpubHighlightInput,
): Promise<ZoteroItemReference> {
    const resolved = await resolveEpubAnnotationOrThrow(attachment, {
        sectionHref: input.sectionHref,
        sectionOrdinal: input.sectionOrdinal,
        anchorId: input.anchorId,
        text: input.text,
    });

    const item = new Zotero.Item("annotation");
    item.libraryID = attachment.libraryID;
    item.parentID = attachment.id;
    item.annotationType = "highlight";
    item.annotationText = resolved.text;
    item.annotationComment = input.comment ?? "";
    item.annotationColor = resolveBeaverAnnotationColor(input.color);
    item.annotationPageLabel = firstNonBlankPageLabel(input.pageLabel) ?? "";
    const sortIndexField: Pick<ZoteroAnnotationItem, "annotationSortIndex"> = {
        annotationSortIndex: resolved.sortIndex,
    };
    Object.assign(item, sortIndexField);
    item.annotationPosition = JSON.stringify(resolved.position);
    item.annotationAuthorName = BEAVER_ANNOTATION_AUTHOR;
    if (input.tags?.length) {
        for (const tag of input.tags) item.addTag(tag);
    }
    await item.saveTx();

    return { library_id: attachment.libraryID, zotero_key: item.key };
}

/**
 * Create a headless Zotero EPUB note annotation: a comment-icon annotation whose
 * CFI spans the cited passage's containing block, so the reader renders the icon
 * in the margin beside the block (matching a note added in the reader itself)
 * rather than inline over the text.
 */
export async function createEpubNoteAnnotation(
    attachment: Zotero.Item,
    input: CreateEpubNoteInput,
): Promise<ZoteroItemReference> {
    const resolved = await resolveEpubAnnotationOrThrow(attachment, {
        sectionHref: input.sectionHref,
        sectionOrdinal: input.sectionOrdinal,
        anchorId: input.anchorId,
        text: input.text,
        anchorToBlock: true,
    });

    const item = new Zotero.Item("annotation");
    item.libraryID = attachment.libraryID;
    item.parentID = attachment.id;
    item.annotationType = "note";
    item.annotationComment = input.comment;
    item.annotationColor = resolveBeaverAnnotationColor(input.color);
    item.annotationPageLabel = firstNonBlankPageLabel(input.pageLabel) ?? "";
    const sortIndexField: Pick<ZoteroAnnotationItem, "annotationSortIndex"> = {
        annotationSortIndex: resolved.sortIndex,
    };
    Object.assign(item, sortIndexField);
    item.annotationPosition = JSON.stringify(resolved.position);
    item.annotationAuthorName = BEAVER_ANNOTATION_AUTHOR;
    if (input.tags?.length) {
        for (const tag of input.tags) item.addTag(tag);
    }
    await item.saveTx();

    return { library_id: attachment.libraryID, zotero_key: item.key };
}

// ---------------------------------------------------------------------------
// Snapshot annotations (headless CSS selectors — no reader instance)
// ---------------------------------------------------------------------------

/** Failure creating a snapshot annotation; `code` maps to a per-item error code. */
export class SnapshotAnnotationError extends Error {
    readonly code: string;

    constructor(code: string, message?: string) {
        super(message ?? code);
        this.name = "SnapshotAnnotationError";
        this.code = code;
    }
}

interface SnapshotLocatorInput {
    /** DOM id of the cited element, when known. */
    anchorId?: string;
    /** Cited passage text used to anchor the range. */
    text?: string;
    color?: string | null;
    /** Tags applied to the created annotation. */
    tags?: string[];
}

export interface CreateSnapshotHighlightInput extends SnapshotLocatorInput {
    /** Cited passage to locate and highlight. */
    text: string;
    comment?: string | null;
}

export interface CreateSnapshotNoteInput extends SnapshotLocatorInput {
    comment: string;
}

function assertSnapshotAttachment(attachment: Zotero.Item): void {
    if (getReadableContentKind(attachment) !== "snapshot") {
        throw new SnapshotAnnotationError("invalid_attachment", "attachment is not an HTML snapshot");
    }
}

async function getSnapshotFilePath(attachment: Zotero.Item): Promise<string> {
    const filePath = await attachment.getFilePathAsync();
    if (!filePath) {
        throw new SnapshotAnnotationError("attachment_file_unavailable", "attachment file path is null");
    }
    if (isRemoteFilePath(filePath)) {
        throw new SnapshotAnnotationError("attachment_file_unavailable", "remote attachment not supported");
    }
    return filePath;
}

async function resolveSnapshotAnnotationOrThrow(
    attachment: Zotero.Item,
    locator: SnapshotAnnotationLocator,
    preparedDoc?: Document,
) {
    assertSnapshotAttachment(attachment);
    // A batch on one snapshot parses the file once (preparedDoc) and resolves each
    // locator synchronously; a lone call falls back to read + parse here.
    let resolved: ResolvedSnapshotAnnotation | SnapshotAnnotationResolveError;
    if (preparedDoc) {
        resolved = buildAnnotationFromDocument(preparedDoc, locator);
    } else {
        const filePath = await getSnapshotFilePath(attachment);
        resolved = await resolveSnapshotAnnotationTarget(filePath, locator);
    }
    if ("error" in resolved) {
        throw new SnapshotAnnotationError(resolved.error, resolved.message);
    }
    return resolved;
}

/**
 * Read + parse a snapshot attachment's HTML once for a batch. Pass the returned
 * Document to each {@link createSnapshotHighlightAnnotation} /
 * {@link createSnapshotNoteAnnotation} call so the batch shares a single read +
 * parse instead of re-reading and re-parsing identical bytes per item. Throws
 * SnapshotAnnotationError when the file is unavailable or cannot be parsed.
 */
export async function prepareSnapshotAnnotationDocument(
    attachment: Zotero.Item,
): Promise<Document> {
    assertSnapshotAttachment(attachment);
    const filePath = await getSnapshotFilePath(attachment);
    const doc = await loadSnapshotDocument(filePath);
    if ("error" in doc) {
        throw new SnapshotAnnotationError(doc.error, doc.message);
    }
    return doc;
}

/**
 * Create a headless Zotero snapshot highlight annotation. The CSS-selector
 * `position` and `sortIndex` are computed from the snapshot's own HTML (no open
 * reader); the reader renders the saved item via the notifier if the page is open.
 */
export async function createSnapshotHighlightAnnotation(
    attachment: Zotero.Item,
    input: CreateSnapshotHighlightInput,
    preparedDoc?: Document,
): Promise<ZoteroItemReference> {
    const resolved = await resolveSnapshotAnnotationOrThrow(attachment, {
        anchorId: input.anchorId,
        text: input.text,
    }, preparedDoc);

    const item = new Zotero.Item("annotation");
    item.libraryID = attachment.libraryID;
    item.parentID = attachment.id;
    item.annotationType = "highlight";
    item.annotationText = resolved.text;
    item.annotationComment = input.comment ?? "";
    item.annotationColor = resolveBeaverAnnotationColor(input.color);
    // Snapshots have no printed pages; the reader stores an empty page label.
    item.annotationPageLabel = "";
    const highlightSortIndex: Pick<ZoteroAnnotationItem, "annotationSortIndex"> = {
        annotationSortIndex: resolved.sortIndex,
    };
    Object.assign(item, highlightSortIndex);
    item.annotationPosition = JSON.stringify(resolved.position);
    item.annotationAuthorName = BEAVER_ANNOTATION_AUTHOR;
    if (input.tags?.length) {
        for (const tag of input.tags) item.addTag(tag);
    }
    await item.saveTx();

    return { library_id: attachment.libraryID, zotero_key: item.key };
}

/**
 * Create a headless Zotero snapshot note annotation: a comment-icon annotation
 * whose selector spans the cited passage's containing block, so the reader renders
 * the icon in the margin beside the block rather than inline over the text.
 */
export async function createSnapshotNoteAnnotation(
    attachment: Zotero.Item,
    input: CreateSnapshotNoteInput,
    preparedDoc?: Document,
): Promise<ZoteroItemReference> {
    const resolved = await resolveSnapshotAnnotationOrThrow(attachment, {
        anchorId: input.anchorId,
        text: input.text,
        anchorToBlock: true,
    }, preparedDoc);

    const item = new Zotero.Item("annotation");
    item.libraryID = attachment.libraryID;
    item.parentID = attachment.id;
    item.annotationType = "note";
    item.annotationComment = input.comment;
    item.annotationColor = resolveBeaverAnnotationColor(input.color);
    item.annotationPageLabel = "";
    const noteSortIndex: Pick<ZoteroAnnotationItem, "annotationSortIndex"> = {
        annotationSortIndex: resolved.sortIndex,
    };
    Object.assign(item, noteSortIndex);
    item.annotationPosition = JSON.stringify(resolved.position);
    item.annotationAuthorName = BEAVER_ANNOTATION_AUTHOR;
    if (input.tags?.length) {
        for (const tag of input.tags) item.addTag(tag);
    }
    await item.saveTx();

    return { library_id: attachment.libraryID, zotero_key: item.key };
}
