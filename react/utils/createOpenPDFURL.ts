export function createOpenPDFURL(item: Zotero.Item, page: number | null = null) {
    
    const baseURL = "zotero://open-pdf/";
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