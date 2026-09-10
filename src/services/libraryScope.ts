/**
 * The instance account service publishes this fail-closed access boundary before
 * notifying any renderer. Background work reads the same authority as chat data handlers.
 */

/**
 * True once the instance holds a resolved scope that can back allow/deny
 * decisions. Callers that would otherwise deny should usually retry later
 * instead of failing a job permanently, because this is also the startup state.
 */
export function isLibraryScopeKnown(): boolean {
    return Zotero.Beaver?.libraryScopeInitialized === true
        && Array.isArray(Zotero.Beaver?.searchableLibraryIds);
}

/** True when `libraryId` is known to be inside the searchable set. */
export function isLibraryInScope(libraryId: number): boolean {
    if (Zotero.Beaver?.libraryScopeInitialized !== true) return false;
    const searchableLibraryIds = Zotero.Beaver?.searchableLibraryIds;
    return Array.isArray(searchableLibraryIds)
        && searchableLibraryIds.includes(libraryId);
}
