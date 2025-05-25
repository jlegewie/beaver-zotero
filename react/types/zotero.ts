
/**
 * ZoteroItemReference is a reference to a Zotero item.
 */
export interface ZoteroItemReference {
    zotero_key: string;
    library_id: number;
}

export function createZoteroItemReference(id: string): ZoteroItemReference | null {
    const [libraryId, zoteroKey] = id.split('-');
    if (!libraryId || !zoteroKey) {
        return null;
    }
    return {
        zotero_key: zoteroKey,
        library_id: parseInt(libraryId)
    };
}