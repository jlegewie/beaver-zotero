/**
 * ZoteroURIResult interface defining the structure of the returned object
 */
interface ZoteroURIResult {
    libraryID: number | null;
    groupID: number | null;
    itemKey: string | null;
    page: string | null;
}

/**
 * QueryParams interface for query parameters
 */
interface QueryParams {
    [key: string]: string | undefined;
    page?: string;
}

/**
 * RouterParams interface for router parameters
 */
interface RouterParams {
    [key: string]: string | number | undefined;
    itemKey?: string;
    libraryID?: number;
    groupID?: number;
    collectionKey?: string;
}

/**
 * Parse a Zotero URI to extract relevant parameters
 * @param {string} uri - Zotero URI (e.g. "zotero://select/library/items/ABCDEF12")
 * @returns {ZoteroURIResult} Object containing libraryID, groupID, itemKey, and page
 */
export function parseZoteroURI(uri: string): ZoteroURIResult {
    // Results object
    const result: ZoteroURIResult = {
        libraryID: null,
        groupID: null,
        itemKey: null,
        page: null
    };
    
    if (!uri || !uri.startsWith('zotero://')) {
        return result;
    }
    
    try {
        // Remove protocol part and get the path
        let path = uri.replace(/^zotero:\/\/[^/]+\//, '');
        
        // Extract page parameter if it exists
        const queryParams: QueryParams = {};
        if (path.includes('?')) {
            const [pathPart, queryPart] = path.split('?');
            path = pathPart;
            
            queryPart.split('&').forEach(param => {
                const [key, value] = param.split('=');
                queryParams[key] = decodeURIComponent(value);
            });
            
            if (queryParams.page) {
                result.page = queryParams.page;
            }
        }
        
        // Set up router to parse the path
        const params: RouterParams = {};
        // @ts-ignore - Zotero.Router is defined in the Zotero environment
        const router = new Zotero.Router(params);
        
        // Add routes for different patterns
        router.add('library/items/:itemKey', function() {
            params.libraryID = Zotero.Libraries.userLibraryID;
        });
        router.add('groups/:groupID/items/:itemKey');
        
        // Add routes for collections if needed
        router.add('library/collections/:collectionKey/items/:itemKey', function() {
            params.libraryID = Zotero.Libraries.userLibraryID;
        });
        router.add('groups/:groupID/collections/:collectionKey/items/:itemKey');
        
        // Run the router
        const parsed = router.run(path);
        
        if (parsed) {
            // Set the itemKey
            if (params.itemKey) {
                result.itemKey = params.itemKey;
            }
            
            // Set groupID and resolve libraryID
            if (params.groupID) {
                result.groupID = Number(params.groupID);
                const libraryID = Zotero.Groups.getLibraryIDFromGroupID(params.groupID);
                if (libraryID !== false) {
                    result.libraryID = libraryID;
                }
            } else if (params.libraryID) {
                result.libraryID = params.libraryID;
            }
        }
    } catch (e) {
        Zotero.debug("Error parsing Zotero URI: " + e, 1);
    }
    
    return result;
}

/**
 * Create a Zotero URI for a given item and page
 * @param {Zotero.Item} item - The Zotero item to create a URI for
 * @param {number | null} page - The page number to add to the URI
 * @returns {string} The Zotero URI
 */
export function createZoteroURI(item: Zotero.Item, page: number | null = null) {
    
    // Determine the base URL based on the item type
    let baseURL;
    if (item.isFileAttachment()) {
        baseURL = "zotero://open-pdf/";
    } else if (item.isNote()) {
        baseURL = "zotero://select/";
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