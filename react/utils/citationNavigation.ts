import { sourceBboxesToZoteroRects } from '../../src/services/annotations/annotationGeometry';
import { logger } from '../../src/utils/logger';
import type { BoundingBox } from '../types/citations';
import type { ZoteroItemReference } from '../types/zotero';
import {
    BeaverTemporaryAnnotations,
    installTemporaryAnnotationDismissOnNextClick,
    type ZoteroReader,
} from './annotationUtils';
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
 * Present already-created temporary annotations in a reader: track them for
 * cleanup, dismiss them on the next pointer interaction, and navigate to the
 * first one. Shared by the PDF bounding-box and EPUB range citation paths —
 * navigation by annotationID works for both reader types (the EPUB reader
 * mounts the target section itself). Returns true when navigation was issued.
 */
export function presentTemporaryAnnotations(
    reader: ZoteroReader,
    annotationReferences: ZoteroItemReference[],
    options: {
        ownerDocument?: Document;
        logContext?: string;
        ignoredClickRoot?: Element | null;
        /** Reader location to navigate to. */
        navigateLocation?: Record<string, any>;
    } = {},
): boolean {
    if (!reader || annotationReferences.length === 0) return false;

    BeaverTemporaryAnnotations.addToTracking(annotationReferences);
    installTemporaryAnnotationDismissOnNextClick(reader, {
        ownerDocument: options.ownerDocument,
        ignoredClickRoot: options.ignoredClickRoot,
        logContext: options.logContext ?? 'presentTemporaryAnnotations',
    });

    const location = options.navigateLocation
        ?? { annotationID: annotationReferences[0].zotero_key };
    // Brief delay so the reader registers the injected annotations before navigating.
    setTimeout(() => {
        (reader as any).navigate(location);
    }, 100);
    return true;
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
    // Aggregate rects per page across every location. A single citation can
    // span multiple parts (e.g. a sentence range like s28-s30), each arriving
    // as its own HighlightLocation; merging by page ensures all cited boxes
    // flash, not just the first part's.
    const rectsByPage = new Map<number, number[][]>();
    for (const location of locations) {
        try {
            const position = await buildPdfNavPosition(reader, location);
            if (!position || position.rects.length === 0) continue;
            const existing = rectsByPage.get(position.pageIndex);
            if (existing) {
                existing.push(...position.rects);
            } else {
                rectsByPage.set(position.pageIndex, [...position.rects]);
            }
        } catch (error) {
            logger('flashHighlightBoundingBoxes: failed to build position: ' + error);
        }
    }

    if (rectsByPage.size === 0) return false;
    // Zotero's temporary position flash supports the target page plus the
    // immediately following page. Merge all cited parts for each supported
    // page so sentence ranges flash as a single passage.
    const targetPage = rectsByPage.keys().next().value as number;
    const position: PdfNavPosition = {
        pageIndex: targetPage,
        rects: rectsByPage.get(targetPage)!,
    };
    const nextPageRects = rectsByPage.get(targetPage + 1);
    if (nextPageRects) {
        position.nextPageRects = nextPageRects;
    }

    try {
        (reader as any).navigate({ position });
        return true;
    } catch (error) {
        logger('flashHighlightBoundingBoxes: failed to navigate position: ' + error);
        return false;
    }
}
