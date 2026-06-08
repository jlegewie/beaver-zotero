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
    /**
     * Rects for the immediately following page (`pageIndex + 1`)
     */
    nextPageRects?: number[][];
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

    for (let i = 0; i < locations.length; i++) {
        try {
            const position = await buildPdfNavPosition(reader, locations[i]);
            if (!position) continue;

            // Merge the immediately following page (if cited) so a passage that
            // wraps across a page break flashes on both pages via nextPageRects.
            const nextLocation = locations
                .slice(i + 1)
                .find((loc) => loc.pageIndex === position.pageIndex + 1);
            if (nextLocation) {
                const nextPosition = await buildPdfNavPosition(reader, nextLocation);
                if (nextPosition) {
                    position.nextPageRects = nextPosition.rects;
                }
            }

            (reader as any).navigate({ position });
            return true;
        } catch (error) {
            logger('flashHighlightBoundingBoxes: failed to build/navigate position: ' + error);
        }
    }

    return false;
}
