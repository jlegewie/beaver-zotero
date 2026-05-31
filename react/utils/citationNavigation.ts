import { sourceBboxesToZoteroRects } from '../../src/services/annotations/annotationGeometry';
import { logger } from '../../src/utils/logger';
import type { BoundingBox } from '../types/citations';
import type { ZoteroReader } from './annotationUtils';
import { getPageViewportInfo } from './pdfUtils';

/** A page of extracted bounding boxes to highlight. `pageIndex` is 0-based. */
export interface HighlightLocation {
    pageIndex: number;
    boxes: BoundingBox[];
}

/** Zotero PDF navigation position: rects in unrotated PDF user space [l, bottom, r, top]. */
export interface PdfNavPosition {
    pageIndex: number;
    rects: number[][];
}

/**
 * Convert extracted bounding boxes for one page into a Zotero navigation
 * position. Citation boxes originate from structured extraction in PDF points;
 * sourceBboxesToZoteroRects handles bbox origin, CropBox offset, and rotation.
 */
export async function buildPdfNavPosition(
    reader: ZoteroReader,
    location: HighlightLocation,
): Promise<PdfNavPosition | null> {
    const { viewBox, rotation, width, height } = await getPageViewportInfo(reader, location.pageIndex);
    const geometry = {
        viewBox: [viewBox[0], viewBox[1], viewBox[2], viewBox[3]] as [number, number, number, number],
        width,
        height,
        rotation: (((rotation % 360) + 360) % 360) as 0 | 90 | 180 | 270,
    };
    const rects = sourceBboxesToZoteroRects(location.boxes, geometry);
    if (rects.length === 0) return null;
    return { pageIndex: location.pageIndex, rects };
}

/**
 * Scroll the reader to extracted bounding boxes and flash Zotero's native
 * temporary position highlight on the first page with usable rects. Returns
 * true when navigation was issued.
 */
export async function flashHighlightBoundingBoxes(
    reader: ZoteroReader,
    locations: HighlightLocation[],
): Promise<boolean> {
    if (!reader || !reader._internalReader) return false;

    for (const location of locations) {
        try {
            const position = await buildPdfNavPosition(reader, location);
            if (!position) continue;
            (reader as any).navigate({ position });
            return true;
        } catch (error) {
            logger('flashHighlightBoundingBoxes: failed to build/navigate position: ' + error);
        }
    }

    return false;
}
