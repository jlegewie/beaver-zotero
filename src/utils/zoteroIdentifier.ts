export function getZoteroUserIdentifier(): { userID: string | undefined, localUserKey: string } {
    // First try to get the Zotero account user ID
    const userID = Zotero.Users.getCurrentUserID();
    
    // Fallback to local user key
    const localUserKey = Zotero.Users.getLocalUserKey();

    return {
        userID: userID ? `${userID}` : undefined,
        localUserKey: `${localUserKey}`
    }
}

export function isLibrarySynced(libraryID: number) {
    try {
        // Check if user has sync set up at all
        if (!Zotero.Users.getCurrentUserID()) {
            return false;
        }
        
        // Get the library object
        const library = Zotero.Libraries.get(libraryID);
        if (!library) {
            return false;
        }
        
        // Check if library type supports syncing
        if (!library.syncable) {
            return false; // Feed libraries can't sync
        }
        
        // Check if library has been synced at least once
        if (!library.lastSync) {
            return false;
        }
        
        // Check if library has a version (indicates modern sync setup)
        if (!library.libraryVersion || library.libraryVersion === 0) {
            return false;
        }
        
        // Library appears to be synced
        return true;
        
    } catch (e) {
        Zotero.logError(e as Error);
        return false;
    }
}