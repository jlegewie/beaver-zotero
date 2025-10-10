import { logger } from "../../src/utils/logger";
import { ZoteroReader } from "./annotationUtils";

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
 * Get page viewport information directly from PDF document
 * This works even if the page hasn't been rendered in the viewer yet
 */
export async function getPageViewportInfo(
    reader: ZoteroReader,
    pageIndex: number
): Promise<{ viewBox: number[]; height: number; width: number }> {
    const iframeWindow = (reader as any)?._internalReader?._primaryView?._iframeWindow;
    const pdfDocument = iframeWindow?.PDFViewerApplication?.pdfDocument;
    
    if (!pdfDocument) {
        throw new Error('PDF document not available');
    }
    
    // Get page directly from document (1-based index)
    const page = await pdfDocument.getPage(pageIndex + 1);
    
    // Extract viewport info from _pageInfo
    const view = page._pageInfo.view;
    const viewBox = [view[0], view[1], view[2], view[3]];
    
    // Calculate dimensions from viewBox
    const width = view[2] - view[0];
    const height = view[3] - view[1];
    
    return { viewBox, height, width };
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