import { logger } from "../../src/utils/logger";

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
        let pdfBuffer;

        // Robustly get the underlying ArrayBuffer, avoiding cross-context 'instanceof' issues.
        const dataType = Object.prototype.toString.call(pdfData);

        if (dataType === '[object Uint8Array]') {
            // @ts-ignore buffer exists
            pdfBuffer = pdfData.buffer;
        } else if (dataType === '[object ArrayBuffer]') {
            pdfBuffer = pdfData;
        } else {
            throw new Error(`Input data must be an ArrayBuffer or Uint8Array, but was ${dataType}`);
        }

        // Zotero.PDFWorker._query is the internal method that sends data to the
        // worker process. The 'buf' property must be an ArrayBuffer, and it
        // must also be in the transfer list (third argument).
        const result = await Zotero.PDFWorker._query(
            'getFulltext',
            {
                buf: pdfBuffer,
                maxPages: 1 // We only need metadata, not the full text.
            },
            [pdfBuffer] // The ArrayBuffer to be transferred
        );

        return result.totalPages;
    } catch (e) {
        try {
            logger('getPDFPageCountFromData: Using naive PDF page count: ' + e);
            return naivePdfPageCount(pdfData as Uint8Array);
        } catch (e) {
            logger('getPDFPageCountFromData: Error getting PDF page count from data: ' + e);
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