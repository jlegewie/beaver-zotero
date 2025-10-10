import {
    ToolAnnotationHighlightLocation,
    ToolAnnotation,
    ToolAnnotationType,
} from '../types/chat/toolAnnotations';
import { BoundingBox, CoordOrigin, toZoteroRectFromBBox } from '../types/citations';
import { getCurrentReader, getCurrentReaderAndWaitForView } from './readerUtils';
import { ZoteroReader } from './annotationUtils';
import { logger } from '../../src/utils/logger';
import { getPageViewportInfo } from './pdfUtils';


export type ApplyAnnotationResult = {
    updated: boolean;
    error?: string;
    annotation: ToolAnnotation;
}

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
    location: ToolAnnotationHighlightLocation
): Promise<number[][]> {
    // Get viewport info directly from PDF document (no need for rendered page)
    const { viewBox, height } = await getPageViewportInfo(reader, location.pageIndex);
    const viewBoxLL: [number, number] = [viewBox[0], viewBox[1]];

    // Create viewport object for coordinate conversion
    const viewport = { height };

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
    annotation: ToolAnnotation
): Promise<string> {
    if (
        !annotation.highlight_locations ||
        annotation.highlight_locations.length === 0
    ) {
        throw new Error('Highlight annotation missing geometry');
    }

    const primaryLocation = annotation.highlight_locations[0];
    const allSamePage = annotation.highlight_locations.every(
        (loc) => loc.pageIndex === primaryLocation.pageIndex
    );

    if (!allSamePage) {
        logger('Highlight annotation spans multiple pages; applying first page only for now', 2);
    }

    const rects = allSamePage
        ? (await Promise.all(
            annotation.highlight_locations.map(loc =>
            convertLocationToRects(reader, loc)
            )
        )).flat()
        : await convertLocationToRects(reader, primaryLocation);
    if (rects.length === 0) {
        throw new Error('Highlight annotation failed to compute rectangles');
    }

    const now = (new Date()).toISOString();
    const sortIndex = generateSortIndex(primaryLocation.pageIndex, rects[0]);
    const data = {
        type: 'highlight',
        color: resolveHighlightColor(annotation.color),
        comment: annotation.comment || annotation.title || '',
        // comment: annotation.title || '',
        pageLabel: primaryLocation.pageIndex + 1,
        sortIndex,
        position: {
            pageIndex: primaryLocation.pageIndex,
            rects,
        },
        text: annotation.text || '',
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

    return annotationResult.id;
}

async function convertNotePositionToRect(
    reader: ZoteroReader,
    annotation: ToolAnnotation
): Promise<{ pageIndex: number; rect: number[] }> {
    if (!annotation.note_position) {
        throw new Error('Note annotation missing position');
    }

    const { pageIndex, side, y } = annotation.note_position;
    
    // Get viewport info directly from PDF document (no need for rendered page)
    const { viewBox, height } = await getPageViewportInfo(reader, pageIndex);
    const viewBoxLL: [number, number] = [viewBox[0], viewBox[1]];
    
    // Calculate x position based on side
    let x: number;
    if (side === 'right') {
        // Use xMax from viewBox directly, minus margin and note size
        x = viewBox[2] - NOTE_RECT_SIZE - 15;
    } else {
        // Use xMin from viewBox plus margin
        x = viewBox[0] + 10;
    }

    // Create viewport object for coordinate conversion
    const viewport = { height };

    const converted: BoundingBox = convertBoundingBoxToBottomLeft(
        {
            l: x,
            b: y,
            r: x + NOTE_RECT_SIZE,
            t: y + NOTE_RECT_SIZE,
            coord_origin: CoordOrigin.BOTTOMLEFT,
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
    annotation: ToolAnnotation
): Promise<string> {
    const { pageIndex, rect } = await convertNotePositionToRect(reader, annotation);
    const sortIndex = generateSortIndex(pageIndex, rect);

    const now = (new Date()).toISOString();
    const data = {
        type: 'note',
        comment: annotation.comment || annotation.title || '',
        color: resolveHighlightColor(annotation.color),
        pageLabel: pageIndex + 1,
        sortIndex,
        position: {
            pageIndex,
            rects: [rect],
        },
        tags: [],
        temporary: false,
        notePosition: annotation.note_position,
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

    return annotationResult.id;
}

async function createAnnotation(
    reader: ZoteroReader,
    annotation: ToolAnnotation
): Promise<string> {
    switch (annotation.annotation_type as ToolAnnotationType) {
        case 'note':
            return createNoteAnnotation(reader, annotation);
        case 'highlight':
        default:
            return createHighlightAnnotation(reader, annotation);
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
    annotation: ToolAnnotation,
    reader?: ZoteroReader
): Promise<ApplyAnnotationResult> {
    // Get the current reader if not provided
    reader = reader ?? (await getCurrentReaderAndWaitForView() as ZoteroReader | undefined);
    if (!reader) {
        return {
            updated: false,
            error: 'No reader found',
            annotation
        };
    }
    
    try {
        // Check if the reader is still correct
        if (!isReaderForAttachmentKey(reader, annotation.attachment_key)) {
            throw new Error('Reader changed to another attachment');
        }
        
        // Create the annotation
        const annotationKey = await createAnnotation(reader, annotation);
        return {
            updated: true,
            annotation: {
                ...annotation,
                status: 'applied',
                zotero_key: annotationKey,
                error_message: null,
                modified_at: new Date().toISOString(),
            },
        };
    } catch (error: any) {
        logger(`applyAnnotation error: ${error?.message || error?.toString()}`, 1);
        const errorMessage = error?.message || 'Failed to create annotation';
        return {
            updated: true,
            error: errorMessage,
            annotation: {
                ...annotation,
                status: 'error',
                error_message: errorMessage,
                modified_at: new Date().toISOString(),
            },
        };
    }
}

export async function deleteAnnotationFromReader(
    annotation: ToolAnnotation
): Promise<void> {
    if (!annotation.zotero_key) {
        throw new Error('Annotation key missing for deletion');
    }

    const reader = getCurrentReader() as ZoteroReader | null;
    const attachmentItem = await getAttachmentItem(
        annotation.library_id,
        annotation.attachment_key
    );
    if (reader && attachmentItem && isReaderForAttachment(reader, attachmentItem)) {
        const iframeWindow = (reader as any)?._internalReader?._iframeWindow;
        if (iframeWindow) {
            await (reader as any)._internalReader.unsetAnnotations(
                Components.utils.cloneInto([annotation.zotero_key], iframeWindow)
            );
        }
    }

    const annotationItem = await Zotero.Items.getByLibraryAndKeyAsync(
        annotation.library_id,
        annotation.zotero_key
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
    annotation: ToolAnnotation
): Promise<{ key: string | null; markAsDeleted: boolean }> {
    // If annotation is marked as applied with a zotero_key, verify it still exists
    if (annotation.status === 'applied' && annotation.zotero_key) {
        try {
            const annotationItem = await Zotero.Items.getByLibraryAndKeyAsync(
                annotation.library_id,
                annotation.zotero_key
            );
            
            if (annotationItem && annotationItem.isAnnotation()) {
                return { key: annotation.zotero_key, markAsDeleted: false };
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
