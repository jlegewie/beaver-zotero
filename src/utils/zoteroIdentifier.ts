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

export function isLibrarySynced(libraryID: number): boolean {
    try {
        // Check if sync is enabled globally first
        if (!Zotero.Sync.Runner.enabled) {
            return false;
        }
        
        // Get the library object
        const library = Zotero.Libraries.get(libraryID);
        if (!library) {
            return false;
        }
        
        // Check if library type supports syncing (excludes feed libraries)
        if (!library.syncable) {
            return false;
        }
        
        // Check if this specific library is skipped from sync
        if (isLibrarySkipped(library)) {
            return false;
        }
        
        // Check if library has actually been synced before
        // This indicates it's connected to Zotero sync infrastructure
        if (!library.lastSync) {
            return false;
        }
        
        // Check if library has a version (indicates modern sync setup)
        if (!library.libraryVersion || library.libraryVersion === 0) {
            return false;
        }
        
        return true;

    } catch (e) {
        Zotero.logError(e as Error);
        return false;
    }
}

function isLibrarySkipped(library: Zotero.Library): boolean {
    try {
        const pref = 'sync.librariesToSkip';
        const librariesToSkip = (Zotero.Prefs.get(pref) || []) as string[];
        
        // Check based on library type
        if (library.libraryType === 'group') {
            // @ts-ignore Zotero.Library.groupID is defined
            return librariesToSkip.includes("G" + library.groupID);
        } else {
            return librariesToSkip.includes("L" + library.libraryID);
        }
    } catch (e) {
        Zotero.logError(e as Error);
        return false;
    }
}