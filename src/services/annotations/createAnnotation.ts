import {
    BoundingBox,
    CoordOrigin,
    convertBoundingBoxToBottomLeft,
    toZoteroRectFromBBox,
} from "../../../react/types/citations";
import { applyRotationToBoundingBox } from "../../../react/utils/pdfUtils";
import { ZoteroItemReference } from "../../../react/types/zotero";
import { NotePosition } from "../../../react/types/agentActions/annotations";
import { PageGeometry } from "../../beaver-extract/types";
import { logger } from "../../utils/logger";
import { getAttachmentFileStatus } from "../agentDataProvider/utils";
import { isRemoteFilePath } from "../documentFileIdentity";
import { BEAVER_ANNOTATION_AUTHOR } from "../../constants/annotations";

const HIGHLIGHT_COLORS: Record<string, string> = {
    red: "#ff6666",
    orange: "#ff9f43",
    yellow: "#ffd400",
    green: "#90ee90",
    blue: "#5ac8fa",
    purple: "#d4a5ff",
    magenta: "#eb52f7",
    gray: "#838383",
    pink: "#ff66c4",
    brown: "#e6a86e",
    cyan: "#7fdbff",
    lime: "#b4ff69",
    mint: "#b2f7d3",
    coral: "#ff9999",
    navy: "#6495ed",
    olive: "#e6e68a",
    teal: "#7fffd4",
};
const NOTE_RECT_SIZE = 18;
const NOTE_SIDE_MARGIN = 12;
const DEFAULT_HIGHLIGHT_COLOR = "#ffd400";

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
}

export interface CreateNoteInput {
    notePosition: NotePosition;
    comment: string;
    color?: string | null;
    pageLabel?: string | null;
}

function resolveHighlightColor(color?: string | null): string {
    if (!color) return DEFAULT_HIGHLIGHT_COLOR;
    return HIGHLIGHT_COLORS[color] ?? DEFAULT_HIGHLIGHT_COLOR;
}

function buildSortIndex(pageIndex: number, rect: number[]): string {
    const yPos = Math.round(rect?.[1] ?? 0);
    const xPos = Math.round(rect?.[0] ?? 0);
    return `${pageIndex.toString().padStart(5, "0")}|${yPos
        .toString()
        .padStart(6, "0")}|${xPos.toString().padStart(5, "0")}`;
}

function isUsableRect(rect: number[]): boolean {
    return (
        Array.isArray(rect) &&
        rect.length === 4 &&
        !rect.some((value) => !Number.isFinite(value))
    );
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
 */
export function convertHighlightBoxesToRects(
    boxes: BoundingBox[],
    geometry: PageGeometry,
): number[][] {
    const viewBoxLL: [number, number] = [
        geometry.viewBox[0],
        geometry.viewBox[1],
    ];

    return boxes
        .map((box) => convertBoundingBoxToBottomLeft(box, geometry.height))
        .map((box) => {
            if (geometry.rotation === 0) return box;
            logger(
                `Applying rotation ${geometry.rotation}° to box: l=${box.l}, b=${box.b}, r=${box.r}, t=${box.t}, rotated dims: w=${geometry.width}, h=${geometry.height}`,
                2,
            );
            // geometry.width/height are viewBox-derived (unrotated); the helper's parameter names say
            // "rotatedWidth/rotatedHeight" but it re-swaps internally, so re-derive the math before changing this.
            const rotated = applyRotationToBoundingBox(
                box,
                geometry.rotation,
                geometry.width,
                geometry.height,
            );
            logger(`Result: l=${rotated.l}, b=${rotated.b}, r=${rotated.r}, t=${rotated.t}`, 2);
            return rotated;
        })
        .map((box) => toZoteroRectFromBBox(box, viewBoxLL))
        .filter(isUsableRect);
}

/**
 * Compute the Zotero position rectangle for a PDF note annotation.
 */
export function computeNoteRect(
    notePosition: NotePosition,
    geometry: PageGeometry,
): number[] {
    const x = notePosition.side === "right"
        ? geometry.width - NOTE_RECT_SIZE - NOTE_SIDE_MARGIN
        : NOTE_SIDE_MARGIN;
    const yCenter = notePosition.coord_origin === CoordOrigin.BOTTOMLEFT
        ? notePosition.y
        : geometry.height - notePosition.y;
    const yBottom = yCenter - NOTE_RECT_SIZE / 2;

    let converted = convertBoundingBoxToBottomLeft(
        {
            l: x,
            b: yBottom,
            r: x + NOTE_RECT_SIZE,
            t: yBottom + NOTE_RECT_SIZE,
            coord_origin: CoordOrigin.BOTTOMLEFT,
        },
        geometry.height,
    );

    if (geometry.rotation !== 0) {
        logger(`Applying rotation ${geometry.rotation}° to note position`, 2);
        converted = applyRotationToBoundingBox(
            converted,
            geometry.rotation,
            geometry.width,
            geometry.height,
        );
    }

    return toZoteroRectFromBBox(converted, [
        geometry.viewBox[0],
        geometry.viewBox[1],
    ]);
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
    if (cachedGeometry) return cachedGeometry;

    await getAttachmentFileStatus(attachment, false);

    const refreshed = await cache?.getMetadata(ref, filePath);
    const refreshedGeometry = getCachedPageGeometry(refreshed, pageIndex);
    if (refreshedGeometry) return refreshedGeometry;

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

    const sortIndex = buildSortIndex(input.pageIndex, rects[0]);
    const item = new Zotero.Item("annotation");
    item.libraryID = attachment.libraryID;
    item.parentID = attachment.id;
    item.annotationType = "highlight";
    item.annotationText = input.text ?? "";
    item.annotationComment = input.comment ?? "";
    item.annotationColor = resolveHighlightColor(input.color);
    item.annotationPageLabel = input.pageLabel ?? String(input.pageIndex + 1);
    const sortIndexField: Pick<ZoteroAnnotationItem, "annotationSortIndex"> = {
        annotationSortIndex: sortIndex,
    };
    Object.assign(item, sortIndexField);
    item.annotationPosition = JSON.stringify({
        pageIndex: input.pageIndex,
        rects,
    });
    item.annotationAuthorName = BEAVER_ANNOTATION_AUTHOR;
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
    const sortIndex = buildSortIndex(pageIndex, rect);

    const item = new Zotero.Item("annotation");
    item.libraryID = attachment.libraryID;
    item.parentID = attachment.id;
    item.annotationType = "note";
    item.annotationComment = input.comment;
    item.annotationColor = resolveHighlightColor(input.color);
    item.annotationPageLabel = input.pageLabel ?? String(pageIndex + 1);
    const sortIndexField: Pick<ZoteroAnnotationItem, "annotationSortIndex"> = {
        annotationSortIndex: sortIndex,
    };
    Object.assign(item, sortIndexField);
    item.annotationPosition = JSON.stringify({ pageIndex, rects: [rect] });
    item.annotationAuthorName = BEAVER_ANNOTATION_AUTHOR;
    await item.saveTx();

    return { library_id: attachment.libraryID, zotero_key: item.key };
}
