export function createOpenPDFURL(item: Zotero.Item, page: number | null = null) {
    
    // Determine the base URL based on the item type
    let baseURL;
    if (item.isFileAttachment()) {
        baseURL = "zotero://open-pdf/";
    } else if (item.isNote()) {
        baseURL = "zotero://open-note/";
    } else {
        baseURL = "zotero://select/";
    }
    let url;
    
    // Check if item is in a group library
    const library = Zotero.Libraries.get(item.libraryID);
    if (library && library.isGroup) {
        const groupID = Zotero.Groups.getGroupIDFromLibraryID(item.libraryID);
        url = `${baseURL}groups/${groupID}/items/${item.key}`;
    }
    // Regular user library
    else {
        url = `${baseURL}library/items/${item.key}`;
    }
    
    // Add page parameter if specified
    if (page !== null) {
        url += "?page=" + page;
    }
    
    return url;
}