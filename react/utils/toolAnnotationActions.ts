import {
    ToolAnnotationHighlightLocation,
    ToolAnnotationResult,
    ToolAnnotationType,
} from '../types/chat/toolAnnotations';
import { BoundingBox, CoordOrigin, toZoteroRectFromBBox } from '../types/citations';
import { getCurrentReader } from './readerUtils';
import { ZoteroReader } from './annotationUtils';
import { logger } from '../../src/utils/logger';

interface ApplyAnnotationSuccess {
    status: 'applied';
    zoteroAnnotationKey: string;
}

interface ApplyAnnotationPending {
    status: 'pending';
    reason: 'reader_unavailable' | 'attachment_closed';
}

interface ApplyAnnotationError {
    status: 'error';
    reason: string;
}

export type ApplyAnnotationResult =
    | ApplyAnnotationSuccess
    | ApplyAnnotationPending
    | ApplyAnnotationError;

const HIGHLIGHT_COLORS: Record<string, string> = {
    red: '#ff6666',
    orange: '#ff9f43',
    yellow: '#ffd400',
    green: '#4cd964',
    blue: '#5ac8fa',
    purple: '#af52de',
};

const NOTE_RECT_SIZE = 18;

function resolveHighlightColor(color?: string | null): string {
    if (!color) return '#ffd400';
    return HIGHLIGHT_COLORS[color] || '#ffd400';
}

async function getAttachmentItem(
    libraryId: number,
    attachmentKey: string
): Promise<Zotero.Item | null> {
    return (await Zotero.Items.getByLibraryAndKeyAsync(libraryId, attachmentKey)) || null;
}

function isReaderForAttachment(reader: ZoteroReader | null, attachment: Zotero.Item): boolean {
    if (!reader) return false;
    if (!attachment.id) return false;
    return (reader as any).itemID === attachment.id;
}

async function ensureReaderInitialized(reader: ZoteroReader): Promise<void> {
    try {
        if (reader && (reader as any)._initPromise) {
            await (reader as any)._initPromise;
        }
    } catch (error) {
        logger(`ensureReaderInitialized failed: ${error}`, 1);
    }
}

function convertBoundingBoxToBottomLeft(
    bbox: BoundingBox,
    viewport: any
): BoundingBox {
    if (bbox.coord_origin === CoordOrigin.BOTTOMLEFT) {
        return bbox;
    }

    const height = viewport?.height ?? 0;
    const converted: BoundingBox = {
        l: bbox.l,
        r: bbox.r,
        coord_origin: CoordOrigin.BOTTOMLEFT,
        b: height - bbox.t,
        t: height - bbox.b,
    };
    return converted;
}

function convertLocationToRects(
    reader: ZoteroReader,
    location: ToolAnnotationHighlightLocation
): number[][] {
    const iframeWindow = (reader as any)?._internalReader?._primaryView?._iframeWindow;
    const pdfViewer = iframeWindow?.PDFViewerApplication?.pdfViewer;
    const pages = pdfViewer?._pages;
    if (!pages) {
        throw new Error('PDF pages unavailable');
    }

    const pageView = pages[location.pageIndex];
    if (!pageView) {
        throw new Error(`Page index ${location.pageIndex} not available`);
    }

    const viewport = pageView.viewport;
    const viewBoxLL: [number, number] = [viewport.viewBox[0], viewport.viewBox[1]];

    const rects = location.boxes
        .map((box) => convertBoundingBoxToBottomLeft(box, viewport))
        .map((box) => toZoteroRectFromBBox(box, viewBoxLL))
        .filter((rect) => Array.isArray(rect) && rect.length === 4);

    return rects;
}

function generateSortIndex(pageIndex: number, rect: number[]): string {
    const yPos = Math.round(rect?.[1] ?? 0);
    const xPos = Math.round(rect?.[0] ?? 0);
    return `${pageIndex.toString().padStart(5, '0')}|${yPos.toString().padStart(6, '0')}|${xPos
        .toString()
        .padStart(5, '0')}`;
}

async function createHighlightAnnotation(
    reader: ZoteroReader,
    annotation: ToolAnnotationResult
): Promise<string> {
    if (!annotation.highlightLocations || annotation.highlightLocations.length === 0) {
        throw new Error('Highlight annotation missing geometry');
    }

    const primaryLocation = annotation.highlightLocations[0];
    const allSamePage = annotation.highlightLocations.every(
        (loc) => loc.pageIndex === primaryLocation.pageIndex
    );

    if (!allSamePage) {
        logger('Highlight annotation spans multiple pages; applying first page only for now', 2);
    }

    const rects = allSamePage
        ? annotation.highlightLocations.flatMap((loc) => convertLocationToRects(reader, loc))
        : convertLocationToRects(reader, primaryLocation);
    if (rects.length === 0) {
        throw new Error('Highlight annotation failed to compute rectangles');
    }

    const sortIndex = generateSortIndex(primaryLocation.pageIndex, rects[0]);
    const data = {
        type: 'highlight',
        color: resolveHighlightColor(annotation.color),
        comment: annotation.comment || '',
        sortIndex,
        position: {
            pageIndex: primaryLocation.pageIndex,
            rects,
        },
        text: annotation.title || '',
        tags: [],
        temporary: false,
    };

    const iframeWindow = (reader as any)?._internalReader?._iframeWindow;
    if (!iframeWindow) {
        throw new Error('Unable to access reader iframe window');
    }

    const annotationResult = await (reader as any)._internalReader._annotationManager.addAnnotation(
        Components.utils.cloneInto(data, iframeWindow)
    );

    return annotationResult.id;
}

function convertNotePositionToRect(
    reader: ZoteroReader,
    annotation: ToolAnnotationResult
): { pageIndex: number; rect: number[] } {
    if (!annotation.notePosition) {
        throw new Error('Note annotation missing position');
    }

    const { pageIndex, x, y } = annotation.notePosition;
    const iframeWindow = (reader as any)?._internalReader?._primaryView?._iframeWindow;
    const pdfViewer = iframeWindow?.PDFViewerApplication?.pdfViewer;
    const pageView = pdfViewer?._pages?.[pageIndex];
    if (!pageView) {
        throw new Error(`Page index ${pageIndex} not available for note annotation`);
    }

    const viewport = pageView.viewport;
    const viewBoxLL: [number, number] = [viewport.viewBox[0], viewport.viewBox[1]];

    const converted: BoundingBox = convertBoundingBoxToBottomLeft(
        {
            l: x,
            b: y,
            r: x + NOTE_RECT_SIZE,
            t: y + NOTE_RECT_SIZE,
            coord_origin: CoordOrigin.TOPLEFT,
        },
        viewport
    );

    return {
        pageIndex,
        rect: toZoteroRectFromBBox(converted, viewBoxLL),
    };
}

async function createNoteAnnotation(
    reader: ZoteroReader,
    annotation: ToolAnnotationResult
): Promise<string> {
    const { pageIndex, rect } = convertNotePositionToRect(reader, annotation);
    const sortIndex = generateSortIndex(pageIndex, rect);

    const data = {
        type: 'note',
        comment: annotation.comment || annotation.title || '',
        color: resolveHighlightColor(annotation.color),
        sortIndex,
        position: {
            pageIndex,
            rects: [rect],
        },
        tags: [],
        temporary: false,
        notePosition: annotation.notePosition,
    };

    const iframeWindow = (reader as any)?._internalReader?._iframeWindow;
    if (!iframeWindow) {
        throw new Error('Unable to access reader iframe window');
    }

    const annotationResult = await (reader as any)._internalReader._annotationManager.addAnnotation(
        Components.utils.cloneInto(data, iframeWindow)
    );

    return annotationResult.id;
}

async function createAnnotation(
    reader: ZoteroReader,
    annotation: ToolAnnotationResult
): Promise<string> {
    switch (annotation.annotationType as ToolAnnotationType) {
        case 'note':
            return createNoteAnnotation(reader, annotation);
        case 'highlight':
        default:
            return createHighlightAnnotation(reader, annotation);
    }
}

export async function applyAnnotation(
    annotation: ToolAnnotationResult
): Promise<ApplyAnnotationResult> {
    const attachmentItem = await getAttachmentItem(annotation.libraryId, annotation.attachmentKey);
    if (!attachmentItem) {
        return {
            status: 'error',
            reason: 'Attachment not found',
        };
    }

    const reader = getCurrentReader() as ZoteroReader | null;
    if (!isReaderForAttachment(reader, attachmentItem)) {
        return {
            status: 'pending',
            reason: 'attachment_closed',
        };
    }

    await ensureReaderInitialized(reader as ZoteroReader);

    try {
        const annotationId = await createAnnotation(reader as ZoteroReader, annotation);
        return {
            status: 'applied',
            zoteroAnnotationKey: annotationId,
        };
    } catch (error: any) {
        logger(`applyAnnotation error: ${error?.stack || error}`, 1);
        return {
            status: 'error',
            reason: error?.message || 'Failed to create annotation',
        };
    }
}

export async function deleteAnnotationFromReader(
    annotation: ToolAnnotationResult
): Promise<void> {
    if (!annotation.zoteroAnnotationKey) {
        throw new Error('Annotation key missing for deletion');
    }

    const reader = getCurrentReader() as ZoteroReader | null;
    const attachmentItem = await getAttachmentItem(annotation.libraryId, annotation.attachmentKey);
    if (reader && attachmentItem && isReaderForAttachment(reader, attachmentItem)) {
        const iframeWindow = (reader as any)?._internalReader?._iframeWindow;
        if (iframeWindow) {
            await (reader as any)._internalReader.unsetAnnotations(
                Components.utils.cloneInto([annotation.zoteroAnnotationKey], iframeWindow)
            );
        }
    }

    const annotationItem = await Zotero.Items.getByLibraryAndKeyAsync(
        annotation.libraryId,
        annotation.zoteroAnnotationKey
    );
    if (annotationItem) {
        await annotationItem.eraseTx();
    }
}

export async function openAttachmentForAnnotation(
    annotation: ToolAnnotationResult,
    pageIndex?: number
): Promise<ZoteroReader | null> {
    const attachmentItem = await getAttachmentItem(annotation.libraryId, annotation.attachmentKey);
    if (!attachmentItem) {
        return null;
    }

    const desiredPageIndex = pageIndex ?? annotation.highlightLocations?.[0]?.pageIndex ?? annotation.notePosition?.pageIndex ?? 0;

    const reader = (await Zotero.Reader.open(attachmentItem.id, {
        pageIndex: Math.max(0, desiredPageIndex),
    })) as unknown as ZoteroReader | null;

    if (reader) {
        await ensureReaderInitialized(reader);
    }

    return reader;
}

export async function navigateToAnnotation(
    annotationKey: string
): Promise<void> {
    const reader = getCurrentReader();
    if (!reader) return;

    try {
        await (reader as any)._internalReader.navigate({ annotationId: annotationKey });
    } catch (error) {
        logger(`navigateToAnnotation failed: ${error}`, 1);
    }
}

export async function resolveExistingAnnotationKey(
    annotation: ToolAnnotationResult
): Promise<string | null> {
    const attachmentItem = await getAttachmentItem(annotation.libraryId, annotation.attachmentKey);
    if (!attachmentItem || !attachmentItem.isAttachment()) {
        return null;
    }

    const annotations = attachmentItem.getAnnotations?.();
    if (!annotations || !Array.isArray(annotations)) {
        return null;
    }

    const targetColor = annotation.color ? resolveHighlightColor(annotation.color) : undefined;

    for (const item of annotations) {
        if (!item || typeof item.isAnnotation !== 'function') continue;
        if (!item.isAnnotation()) continue;
        if (item.annotationType !== annotation.annotationType) continue;

        if (annotation.comment) {
            const existingComment = item.annotationComment?.trim?.() || '';
            if (existingComment !== annotation.comment.trim()) continue;
        }

        if (annotation.annotationType === 'highlight' && annotation.title) {
            const existingText = item.annotationText?.trim?.() || '';
            if (existingText && existingText !== annotation.title.trim()) continue;
        }

        if (targetColor && item.annotationColor && item.annotationColor.toLowerCase() !== targetColor.toLowerCase()) {
            continue;
        }

        return item.key;
    }

    return null;
}
