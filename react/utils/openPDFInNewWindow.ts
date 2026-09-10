/**
* Open a PDF attachment in a new window
* @param {Zotero.Item} item - The Zotero Item object (must be a PDF attachment or have a PDF attachment)
*/

import { openReader } from '../runtime/navigation';
export async function openPDFInNewWindow(item: Zotero.Item, page: number | null = null) {
    // If the item itself is not a PDF attachment, find the first available PDF attachment
    let pdfItem: Zotero.Item | null = item;
    if (!item.isPDFAttachment()) {
        // Get all attachments and find the first PDF
        pdfItem = await item.getBestAttachment() || null;
        if (!pdfItem) {
            // No PDF attachment found
            return false;
        }
    }
    
    // Open the PDF in a new window
    await openReader(
        pdfItem.id,     // The item ID
        // @ts-ignore null is a valid location
        page,           // Location (null to open at the first page)
        {
            openInWindow: true,     // open in a new window
            allowDuplicate: true    // allow opening multiple windows of the same PDF
        }
    );
    
    return true;
}