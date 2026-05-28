import { BoundingBox, CoordOrigin, PageLocation, convertBoundingBoxToBottomLeft, toZoteroRectFromBBox } from '../types/citations';
import { getCurrentReader, getCurrentReaderAndWaitForView } from './readerUtils';
import { ZoteroReader } from './annotationUtils';
import { logger } from '../../src/utils/logger';
import { getPageViewportInfo, isPDFDocumentAvailable, waitForPDFDocument, applyRotationToBoundingBox } from './pdfUtils';
import { isLibraryEditable } from '../../src/utils/zoteroUtils';
import { BEAVER_ANNOTATION_AUTHOR } from '../../src/constants/annotations';
import { AnnotationProposedAction, isHighlightAnnotationAction, isNoteAnnotationAction, AnnotationResultData } from '../types/agentActions/base';


const HIGHLIGHT_COLORS: Record<string, string> = {
    red: '#ff6666',
    orange: '#ff9f43',
    yellow: '#ffd400',
    green: '#90ee90',
    blue: '#5ac8fa',
    purple: '#d4a5ff',
    magenta: '#eb52f7',
    gray: '#838383',
    pink: '#ff66c4',
    brown: '#e6a86e',
    cyan: '#7fdbff',
    lime: '#b4ff69',
    mint: '#b2f7d3',
    coral: '#ff9999',
    navy: '#6495ed',
    olive: '#e6e68a',
    teal: '#7fffd4',
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

function isReaderForAttachmentKey(reader: ZoteroReader | null, attachmentKey: string): boolean {
    if (!reader) return false;
    if (!attachmentKey) return false;
    return (reader as any)._item === undefined || (reader as any)._item?.key === attachmentKey;
}

async function convertLocationToRects(
    reader: ZoteroReader,
    location: PageLocation
): Promise<{ rects: number[][]; viewBox: number[] }> {
    // Get viewport info directly from PDF document (no need for rendered page)
    const { viewBox, height, width, rotation } = await getPageViewportInfo(reader, location.page_idx);
    const viewBoxLL: [number, number] = [viewBox[0], viewBox[1]];

    if (!location.boxes) {
        throw new Error('Location boxes missing');
    }

    // Only apply rotation transformation if page is actually rotated
    const rects = rotation !== 0
        ? location.boxes
            .map((box) => convertBoundingBoxToBottomLeft(box, height))
            .map((box) => {
                logger(`Applying rotation ${rotation}° to box: l=${box.l}, b=${box.b}, r=${box.r}, t=${box.t}, rotated dims: w=${width}, h=${height}`, 2);
                const rotated = applyRotationToBoundingBox(box, rotation, width, height);
                logger(`Result: l=${rotated.l}, b=${rotated.b}, r=${rotated.r}, t=${rotated.t}`, 2);
                return rotated;
            })
            .map((box) => toZoteroRectFromBBox(box, viewBoxLL))
            .filter((rect) => Array.isArray(rect) && rect.length === 4)
        : location.boxes
            .map((box) => convertBoundingBoxToBottomLeft(box, height))
            .map((box) => toZoteroRectFromBBox(box, viewBoxLL))
            .filter((rect) => Array.isArray(rect) && rect.length === 4);

    return { rects, viewBox };
}

/**
 * Build a Zotero PDF sort-index string in canonical `page|offset|top` format.
 *
 * Legacy single-action path: no backend reading-order index is available
 * here, so the offset field falls back to display-top. Matches Zotero's
 * reader formula (Math.floor(viewBox[3] - rect[3])) at
 * /reader/src/pdf/selection.js:399.
 *
 * The bulk path in src/services/annotations/createAnnotation.ts uses the
 * backend-supplied reading_order_index as the offset and is preferred for
 * any new code; this helper exists backward compatibility.
 */
function generateSortIndex(pageIndex: number, rect: number[], viewBox: number[]): string {
    const clamp = (v: unknown, max: number): number => {
        if (typeof v !== 'number' || !Number.isFinite(v)) return 0;
        const floored = Math.floor(v);
        if (floored <= 0) return 0;
        return floored > max ? max : floored;
    };
    const viewBoxTop = viewBox?.[3];
    const rectTop = rect?.[3];
    const displayTopRaw =
        typeof viewBoxTop === 'number' && Number.isFinite(viewBoxTop)
        && typeof rectTop === 'number' && Number.isFinite(rectTop)
            ? Math.floor(viewBoxTop - rectTop)
            : 0;
    const page = clamp(pageIndex, 99999).toString().padStart(5, '0');
    const offset = clamp(displayTopRaw, 999999).toString().padStart(6, '0');
    const top = clamp(displayTopRaw, 99999).toString().padStart(5, '0');
    return `${page}|${offset}|${top}`;
}

async function createHighlightAnnotation(
    reader: ZoteroReader,
    annotation: AnnotationProposedAction
): Promise<string> {
    if (
        !annotation.proposed_data.highlight_locations ||
        annotation.proposed_data.highlight_locations.length === 0
    ) {
        throw new Error('Highlight annotation missing geometry');
    }

    const primaryLocation = annotation.proposed_data.highlight_locations[0];
    const allSamePage = annotation.proposed_data.highlight_locations.every(
        (loc: PageLocation) => loc.page_idx === primaryLocation.page_idx
    );

    if (!allSamePage) {
        logger('Highlight annotation spans multiple pages; applying first page only for now', 2);
    }

    const conversions = allSamePage
        ? await Promise.all(
            annotation.proposed_data.highlight_locations.map((loc: PageLocation) =>
                convertLocationToRects(reader, loc)
            )
        )
        : [await convertLocationToRects(reader, primaryLocation)];
    const rects = conversions.flatMap((c) => c.rects);
    if (rects.length === 0) {
        throw new Error('Highlight annotation failed to compute rectangles');
    }
    const primaryViewBox = conversions[0].viewBox;

    const now = (new Date()).toISOString();
    const sortIndex = generateSortIndex(primaryLocation.page_idx, rects[0], primaryViewBox);
    const data = {
        type: 'highlight',
        color: resolveHighlightColor(annotation.proposed_data.color),
        comment: annotation.proposed_data.comment || annotation.proposed_data.title || '',
        // comment: annotation.title || '',
        pageLabel: primaryLocation.page_idx + 1,
        sortIndex,
        position: {
            pageIndex: primaryLocation.page_idx,
            rects,
        },
        text: annotation.proposed_data.text || '',
        tags: [],
        temporary: false,
        dateCreated: now,
        dateModified: now,
        authorName: BEAVER_ANNOTATION_AUTHOR,
        annotationAuthorName: BEAVER_ANNOTATION_AUTHOR
    };

    const iframeWindow = (reader as any)?._internalReader?._primaryView?._iframeWindow;
    if (!iframeWindow) {
        throw new Error('Unable to access reader iframe window');
    }

    const annotationResult = await (reader as any)._internalReader._annotationManager.addAnnotation(
        Components.utils.cloneInto(data, iframeWindow)
    );

    if (!annotationResult || !annotationResult.id) {
        throw new Error('Failed to create annotation - annotation manager returned null');
    }

    return annotationResult.id;
}

async function convertNotePositionToRect(
    reader: ZoteroReader,
    annotation: AnnotationProposedAction
): Promise<{ pageIndex: number; rect: number[]; viewBox: number[] }> {
    if (!annotation.proposed_data.note_position) {
        throw new Error('Note annotation missing position');
    }

    const { page_index, side, y, coord_origin } = annotation.proposed_data.note_position;
    
    // Get viewport info directly from PDF document (no need for rendered page)
    const { viewBox, height, width, rotation } = await getPageViewportInfo(reader, page_index);
    const viewBoxLL: [number, number] = [viewBox[0], viewBox[1]];
    
    // Calculate x position based on side
    // Note: Use absolute page coordinates (viewBox[0] is the left edge, viewBox[0] + width is the right edge)
    let x: number;
    if (side === 'right') {
        // Position at right edge of page, accounting for margin and note size
        x = width - NOTE_RECT_SIZE - 12;
    } else {
        // Position at left edge of page with small margin
        x = 12;
    }

    const yCenter = coord_origin === CoordOrigin.BOTTOMLEFT
        ? y
        : height - y;
    const yBottom = yCenter - NOTE_RECT_SIZE / 2;

    let converted: BoundingBox = convertBoundingBoxToBottomLeft(
        {
            l: x,
            b: yBottom,
            r: x + NOTE_RECT_SIZE,
            t: yBottom + NOTE_RECT_SIZE,
            coord_origin: CoordOrigin.BOTTOMLEFT,
        },
        height
    );
    
    // Apply rotation transformation only if page is rotated
    if (rotation !== 0) {
        logger(`Applying rotation ${rotation}° to note position`, 2);
        converted = applyRotationToBoundingBox(converted, rotation, width, height);
    }

    return {
        pageIndex: page_index,
        rect: toZoteroRectFromBBox(converted, viewBoxLL),
        viewBox,
    };
}

async function createNoteAnnotation(
    reader: ZoteroReader,
    annotation: AnnotationProposedAction
): Promise<string> {
    const { pageIndex, rect, viewBox } = await convertNotePositionToRect(reader, annotation);
    const sortIndex = generateSortIndex(pageIndex, rect, viewBox);

    const now = (new Date()).toISOString();
    const data = {
        type: 'note',
        comment: annotation.proposed_data.comment || annotation.proposed_data.title || '',
        color: resolveHighlightColor(annotation.proposed_data.color),
        pageLabel: pageIndex + 1,
        sortIndex,
        position: {
            pageIndex,
            rects: [rect],
        },
        tags: [],
        temporary: false,
        notePosition: annotation.proposed_data.note_position,
        dateCreated: now,
        dateModified: now,
        authorName: BEAVER_ANNOTATION_AUTHOR,
        annotationAuthorName: BEAVER_ANNOTATION_AUTHOR
    };

    const iframeWindow = (reader as any)?._internalReader?._primaryView?._iframeWindow;
    if (!iframeWindow) {
        throw new Error('Unable to access reader iframe window');
    }

    const annotationResult = await (reader as any)._internalReader._annotationManager.addAnnotation(
        Components.utils.cloneInto(data, iframeWindow)
    );

    if (!annotationResult || !annotationResult.id) {
        throw new Error('Failed to create annotation - annotation manager returned null');
    }

    return annotationResult.id;
}

async function createAnnotation(
    reader: ZoteroReader,
    annotation: AnnotationProposedAction
): Promise<string> {
    if (isNoteAnnotationAction(annotation)) {
        return createNoteAnnotation(reader, annotation);
    } else if (isHighlightAnnotationAction(annotation)) {
        return createHighlightAnnotation(reader, annotation);
    } else {
        throw new Error('Invalid annotation type');
    }
}

/**
 * Applies an annotation to a given PDF reader instance.
 *
 * This function assumes the provided reader is open and corresponds to the
 * correct attachment for the annotation.
 *
 * @param reader - The active ZoteroReader instance.
 * @param annotation - The annotation to apply.
 * @returns An object indicating success ('applied') or failure ('error').
 */
export async function applyAnnotation(
    annotation: AnnotationProposedAction,
    reader?: ZoteroReader
): Promise<AnnotationResultData> {
    // Get the current reader if not provided, and wait for PDF document to be loaded
    reader = reader ?? (await getCurrentReaderAndWaitForView(undefined, true) as ZoteroReader | undefined);
    if (!reader || !annotation.proposed_data?.attachment_key) {
        throw new Error('Invalid reader or attachment key');
    }
    
    try {
        // Check if the library is editable before attempting to create annotations
        if (!isLibraryEditable(annotation.proposed_data.library_id)) {
            throw new Error('Cannot create annotations in a read-only library');
        }

        // Check if the reader is still correct
        if (!isReaderForAttachmentKey(reader, annotation.proposed_data.attachment_key)) {
            throw new Error('Reader changed to another attachment');
        }
        
        // Final check: ensure PDF document is available
        // (in case reader was provided directly without going through getCurrentReaderAndWaitForView)
        if (!isPDFDocumentAvailable(reader)) {
            logger(`applyAnnotation: PDF document not available, attempting to wait...`, 2);
            const pdfAvailable = await waitForPDFDocument(reader, 3000);
            if (!pdfAvailable) {
                throw new Error('PDF document not available - reader may be closed or PDF failed to load');
            }
        }
        
        // Create the annotation
        const annotationKey = await createAnnotation(reader, annotation);
        return {
            zotero_key: annotationKey,
            library_id: annotation.proposed_data.library_id,
            attachment_key: annotation.proposed_data.attachment_key,
        };
    } catch (error: any) {
        logger(`applyAnnotation error: ${error?.message || error?.toString()}`, 1);
        const errorMessage = error?.message || 'Failed to create annotation';
        throw new Error(errorMessage);
    }
}

export async function deleteAnnotationFromReader(
    annotation: AnnotationProposedAction
): Promise<void> {
    if (!annotation.result_data?.zotero_key) {
        throw new Error('Annotation key missing for deletion');
    }

    const reader = getCurrentReader() as ZoteroReader | null;
    const attachmentItem = await getAttachmentItem(
        annotation.result_data.library_id,
        annotation.result_data.attachment_key
    );
    if (reader && attachmentItem && isReaderForAttachment(reader, attachmentItem)) {
        const iframeWindow = (reader as any)?._internalReader?._iframeWindow;
        if (iframeWindow) {
            await (reader as any)._internalReader.unsetAnnotations(
                Components.utils.cloneInto([annotation.result_data.zotero_key], iframeWindow)
            );
        }
    }

    const annotationItem = await Zotero.Items.getByLibraryAndKeyAsync(
        annotation.result_data.library_id,
        annotation.result_data.zotero_key
    );
    if (annotationItem) {
        await annotationItem.eraseTx();
    }
}
