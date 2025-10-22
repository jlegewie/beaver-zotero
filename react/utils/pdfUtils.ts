import { logger } from "../../src/utils/logger";
import { ZoteroReader } from "./annotationUtils";
import { BoundingBox } from "../types/citations";

/**
 * Get the total number of pages for a PDF attachment
 * @param {Zotero.Item} item - The PDF attachment item
 * @returns {Promise<Number|null>} - A promise that resolves with the page count or null if unavailable
 */
export async function getPDFPageCount(item: Zotero.Item): Promise<number | null> {
    if (!item.isPDFAttachment()) {
        return null;
    }

    // First check if we already have the page count from indexing
    // @ts-ignore Fulltext exists
    const pagesInfo = await Zotero.Fulltext.getPages(item.id);
    if (pagesInfo && pagesInfo.total) {
        return pagesInfo.total;
    }

    // If not indexed, use PDFWorker to get the page count
    try {
        // Second parameter (maxPages) as null means get all pages
        const { totalPages } = await Zotero.PDFWorker.getFullText(item.id, 1);
        return totalPages;
    } catch (e) {
        Zotero.debug('Error getting PDF page count: ' + e);
        return null;
    }
}

/**
 * Transform bounding box coordinates to account for page rotation.
 * PDF processing (PyMuPDF) uses remove_rotation(), so coordinates are in unrotated space.
 * Zotero's PDF.js viewer respects original rotation, so we need to transform coordinates.
 * 
 * @param bbox - Bounding box in unrotated coordinate system (bottom-left origin)
 * @param rotation - Page rotation in degrees (0, 90, 180, 270)
 * @param width - Page width in unrotated coordinate system
 * @param height - Page height in unrotated coordinate system
 * @returns Transformed bounding box
 */
export function applyRotationToBoundingBox(
    bbox: BoundingBox,
    rotation: number,
    width: number,
    height: number
): BoundingBox {
    // Normalize rotation to 0-360 range
    rotation = ((rotation % 360) + 360) % 360;
    
    if (rotation === 0) {
        return bbox;
    }
    
    // Apply rotation transformation
    // Coordinates are in bottom-left origin system
    let l: number, b: number, r: number, t: number;
    
    switch (rotation) {
        case 90:
            // 90° clockwise: (x, y) -> (y, width - x)
            l = bbox.b;
            b = width - bbox.r;
            r = bbox.t;
            t = width - bbox.l;
            break;
        case 180:
            // 180°: (x, y) -> (width - x, height - y)
            l = width - bbox.r;
            b = height - bbox.t;
            r = width - bbox.l;
            t = height - bbox.b;
            break;
        case 270:
            // 270° clockwise: (x, y) -> (height - y, x)
            l = height - bbox.t;
            b = bbox.l;
            r = height - bbox.b;
            t = bbox.r;
            break;
        default:
            return bbox;
    }
    
    return {
        l,
        b,
        r,
        t,
        coord_origin: bbox.coord_origin
    };
}

/**
 * Get page viewport information directly from PDF document
 * This works even if the page hasn't been rendered in the viewer yet
 */
export async function getPageViewportInfo(
    reader: ZoteroReader,
    pageIndex: number
): Promise<{ viewBox: number[]; height: number; width: number; rotation: number }> {
    const iframeWindow = (reader as any)?._internalReader?._primaryView?._iframeWindow;
    const pdfDocument = iframeWindow?.PDFViewerApplication?.pdfDocument;
    
    if (!pdfDocument) {
        throw new Error('PDF document not available - reader may be closed or PDF not loaded');
    }
    
    // Get page directly from document (1-based index)
    const page = await pdfDocument.getPage(pageIndex + 1);
    
    // Extract viewport info from _pageInfo
    const view = page._pageInfo.view;
    const viewBox = [view[0], view[1], view[2], view[3]];
    
    // Calculate dimensions from viewBox
    const width = view[2] - view[0];
    const height = view[3] - view[1];
    
    // Get rotation (0, 90, 180, or 270 degrees)
    const rotation = page._pageInfo.rotate || 0;
    
    return { viewBox, height, width, rotation };
}

/**
 * Check if PDF document is available in reader
 */
export function isPDFDocumentAvailable(reader: ZoteroReader): boolean {
    try {
        const iframeWindow = (reader as any)?._internalReader?._primaryView?._iframeWindow;
        const pdfDocument = iframeWindow?.PDFViewerApplication?.pdfDocument;
        return Boolean(pdfDocument);
    } catch (e) {
        return false;
    }
}

/**
 * Wait for PDF document to become available in reader
 * @param reader The reader to check
 * @param timeoutMs Maximum time to wait in milliseconds (default 5000ms)
 * @returns Promise that resolves to true if PDF becomes available, false if timeout
 */
export async function waitForPDFDocument(reader: ZoteroReader, timeoutMs: number = 5000): Promise<boolean> {
    const startTime = Date.now();
    const checkInterval = 100; // Check every 100ms
    
    while (Date.now() - startTime < timeoutMs) {
        if (isPDFDocumentAvailable(reader)) {
            return true;
        }
        // Wait before checking again
        await new Promise(resolve => setTimeout(resolve, checkInterval));
    }
    
    return false;
}


/**
 * Get the number of pages from a PDF's binary data.
 * This function handles data that is either an ArrayBuffer (from local files) or a
 * Uint8Array (from network requests).
 *
 * @param {ArrayBuffer|Uint8Array} pdfData - The binary content of the PDF file.
 * @returns {Promise<number|null>} A promise that resolves with the total number
 *   of pages, or null if the page count could not be determined.
 */
export function naivePdfPageCount(bytes: Uint8Array): number | null {
    // Fallback: count '/Type /Page' markers (works for most PDFs)
    const text = new TextDecoder('latin1').decode(bytes);
    const re = /\/Type\s*\/Page\b/g;
    let n = 0; while (re.exec(text)) n++;
    return n || null;
}

/**
 * Gets the number of pages from a PDF's binary data.
 * This function handles data that is either an ArrayBuffer (from local files) or a
 * Uint8Array (from network requests).
 *
 * @param {ArrayBuffer|Uint8Array} pdfData - The binary content of the PDF file.
 * @returns {Promise<number|null>} A promise that resolves with the total number
 *   of pages, or null if the page count could not be determined.
 */
export async function getPDFPageCountFromData(pdfData: Uint8Array | ArrayBuffer): Promise<number | null> {
    try {
        const view = pdfData instanceof Uint8Array ? pdfData : new Uint8Array(pdfData);
        
        // Clone the exact subrange into a fresh ArrayBuffer
        const buf = view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);

        // Use _enqueue to ensure proper initialization, then call _query with buffer
        const result = await Zotero.PDFWorker._enqueue(async () => {
            return await Zotero.PDFWorker._query("getFulltext", { buf, maxPages: 1 }, [buf]);
        });
        
        return result?.totalPages ?? null;
    } catch (e) {
        try {
            logger("getPDFPageCountFromData: Using naive PDF page count: " + e);
            const view = pdfData instanceof Uint8Array ? pdfData : new Uint8Array(pdfData);
            return naivePdfPageCount(view);
        } catch (e2) {
            logger("getPDFPageCountFromData: Error getting PDF page count from data: " + e2);
            return null;
        }
    }
}

/**
 * Get the total number of pages for a PDF attachment
 * @param {Zotero.Item} item - The PDF attachment item
 * @returns {Promise<Number|null>} - A promise that resolves with the page count or null if unavailable
 */
export async function getPDFPageCountFromFulltext(item: Zotero.Item): Promise<number | null> {
    if (!item.isPDFAttachment()) {
        return null;
    }

    // @ts-ignore Fulltext exists
    const pagesInfo = await Zotero.Fulltext.getPages(item.id);
    if (pagesInfo && pagesInfo.total) {
        return pagesInfo.total;
    }

    return null;

}

/**
 * Get the total number of pages for a PDF attachment
 * @param {Zotero.Item} item - The PDF attachment item
 * @returns {Promise<Number|null>} - A promise that resolves with the page count or null if unavailable
 */
export async function getPDFPageCountFromWorker(item: Zotero.Item): Promise<number | null> {
    if (!item.isPDFAttachment()) {
        return null;
    }
    try {
        const { totalPages } = await Zotero.PDFWorker.getFullText(item.id, 1);
        return totalPages;
    } catch (e) {
        Zotero.debug('Error getting PDF page count: ' + e);
        return null;
    }
}