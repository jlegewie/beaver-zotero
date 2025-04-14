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
        const { totalPages } = await Zotero.PDFWorker.getFullText(item.id, null);
        return totalPages;
    } catch (e) {
        Zotero.debug('Error getting PDF page count: ' + e);
        return null;
    }
}