import { BoundingBox, CoordOrigin, PageLocation, toZoteroRectFromBBox } from '../types/citations';
import { getCurrentReader, getCurrentReaderAndWaitForView } from './readerUtils';
import { ZoteroReader } from './annotationUtils';
import { logger } from '../../src/utils/logger';
import { getPageViewportInfo, isPDFDocumentAvailable, waitForPDFDocument, applyRotationToBoundingBox } from './pdfUtils';
import { isLibraryEditable } from '../../src/utils/zoteroUtils';
import { AnnotationProposedAction, isHighlightAnnotationAction, isNoteAnnotationAction, AnnotationResultData } from '../types/chat/proposedActions';


const HIGHLIGHT_COLORS: Record<string, string> = {
    red: '#ff6666',
    orange: '#ff9f43',
    yellow: '#ffd400',
    green: '#90ee90',
    blue: '#5ac8fa',
    purple: '#d4a5ff',
    gray: '#d3d3d3',
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

async function convertLocationToRects(
    reader: ZoteroReader,
    location: PageLocation
): Promise<number[][]> {
    // Get viewport info directly from PDF document (no need for rendered page)
    const { viewBox, height, width, rotation } = await getPageViewportInfo(reader, location.page_idx);
    const viewBoxLL: [number, number] = [viewBox[0], viewBox[1]];

    // Create viewport object for coordinate conversion
    const viewport = { height };

    if (!location.boxes) {
        throw new Error('Location boxes missing');
    }

    // Only apply rotation transformation if page is actually rotated
    const rects = rotation !== 0
        ? location.boxes
            .map((box) => convertBoundingBoxToBottomLeft(box, viewport))
            .map((box) => {
                logger(`Applying rotation ${rotation}° to box: l=${box.l}, b=${box.b}, r=${box.r}, t=${box.t}, rotated dims: w=${width}, h=${height}`, 2);
                const rotated = applyRotationToBoundingBox(box, rotation, width, height);
                logger(`Result: l=${rotated.l}, b=${rotated.b}, r=${rotated.r}, t=${rotated.t}`, 2);
                return rotated;
            })
            .map((box) => toZoteroRectFromBBox(box, viewBoxLL))
            .filter((rect) => Array.isArray(rect) && rect.length === 4)
        : location.boxes
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

    const rects = allSamePage
        ? (await Promise.all(
            annotation.proposed_data.highlight_locations.map((loc: PageLocation) =>
            convertLocationToRects(reader, loc)
            )
        )).flat()
        : await convertLocationToRects(reader, primaryLocation);
    if (rects.length === 0) {
        throw new Error('Highlight annotation failed to compute rectangles');
    }

    const now = (new Date()).toISOString();
    const sortIndex = generateSortIndex(primaryLocation.page_idx, rects[0]);
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
        authorName: 'Beaver',
        annotationAuthorName: 'Beaver'
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
): Promise<{ pageIndex: number; rect: number[] }> {
    if (!annotation.proposed_data.note_position) {
        throw new Error('Note annotation missing position');
    }

    const { pageIndex, side, y } = annotation.proposed_data.note_position;
    
    // Get viewport info directly from PDF document (no need for rendered page)
    const { viewBox, height, width, rotation } = await getPageViewportInfo(reader, pageIndex);
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

    // Create viewport object for coordinate conversion
    const viewport = { height };

    let converted: BoundingBox = convertBoundingBoxToBottomLeft(
        {
            l: x,
            b: y,
            r: x + NOTE_RECT_SIZE,
            t: y + NOTE_RECT_SIZE,
            coord_origin: CoordOrigin.BOTTOMLEFT,
        },
        viewport
    );
    
    // Apply rotation transformation only if page is rotated
    if (rotation !== 0) {
        logger(`Applying rotation ${rotation}° to note position`, 2);
        converted = applyRotationToBoundingBox(converted, rotation, width, height);
    }

    return {
        pageIndex,
        rect: toZoteroRectFromBBox(converted, viewBoxLL),
    };
}

async function createNoteAnnotation(
    reader: ZoteroReader,
    annotation: AnnotationProposedAction
): Promise<string> {
    const { pageIndex, rect } = await convertNotePositionToRect(reader, annotation);
    const sortIndex = generateSortIndex(pageIndex, rect);

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
        authorName: 'Beaver',
        annotationAuthorName: 'Beaver'
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

/**
 * Validates that an annotation marked as 'applied' still exists in Zotero.
 * For annotations with status 'applied', verifies the zotero_key still points to a valid annotation.
 * @param annotation - The annotation to validate
 * @returns Object with key (if exists) and whether annotation should be marked as deleted
 */
export async function validateAppliedAnnotation(
    annotation: AnnotationProposedAction
): Promise<{ key: string | null; markAsDeleted: boolean }> {
    // If annotation is marked as applied with a zotero_key, verify it still exists
    if (annotation.status === 'applied' && annotation.result_data?.zotero_key) {
        try {
            const annotationItem = await Zotero.Items.getByLibraryAndKeyAsync(
                annotation.result_data.library_id,
                annotation.result_data.zotero_key
            );
            
            if (annotationItem && annotationItem.isAnnotation()) {
                return { key: annotation.result_data.zotero_key, markAsDeleted: false };
            } else {
                // Annotation item doesn't exist - should be marked as deleted
                return { key: null, markAsDeleted: true };
            }
        } catch (error) {
            return { key: null, markAsDeleted: true };
        }
    }
    
    // For other statuses, no existing annotation and no need to mark as deleted
    return { key: null, markAsDeleted: false };
}
