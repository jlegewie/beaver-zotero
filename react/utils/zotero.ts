/**
 * Get recently added or modified items in a library
 * @param {Integer} libraryID - The library to get items from
*
 * @param {Object} [options]
 * @param {String} [options.sortBy='dateModified'] - Field to sort by: 'dateAdded' or 'dateModified'
 * @param {Integer} [options.limit=10] - Maximum number of items to return
 * @param {Boolean} [options.includeTrashed=false] - Whether to include items in the trash
 * @param {Boolean} [options.asIDs=false] - If true, return only item IDs instead of item objects
 * @return {Promise<Array<Zotero.Item|Integer>>}
 */
export const getRecentAsync = async function (
    libraryID: number,
    options: {
        sortBy?: string,
        limit?: number,
        includeTrashed?: boolean,
        asIDs?: boolean
    } = {}
): Promise<Zotero.Item[] | number[]> {
    const { 
        sortBy = 'dateModified', 
        limit = 10, 
        includeTrashed = false,
        asIDs = false
    } = options;
    
    if (!['dateAdded', 'dateModified'].includes(sortBy)) {
        throw new Error("sortBy must be 'dateAdded' or 'dateModified'");
    }
    
    let sql = 'SELECT itemID FROM items';
    
    if (!includeTrashed) {
        sql += ' WHERE itemID NOT IN (SELECT itemID FROM deletedItems)';
    } else {
        sql += ' WHERE 1=1';
    }
    
    // Only return items from the requested library
    sql += ' AND libraryID=?';
    
    // Order by the requested date field
    sql += ` ORDER BY ${sortBy} DESC LIMIT ?`;
    
    const params = [libraryID, limit];
    const ids = await Zotero.DB.columnQueryAsync(sql, params) as number[];
    
    if (asIDs) {
        return ids;
    }
    
    return Zotero.Items.getAsync(ids);
};