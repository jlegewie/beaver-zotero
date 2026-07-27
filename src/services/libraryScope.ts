/**
 * Esbuild-readable view of the searchable-library boundary.
 *
 * The authoritative scope is `searchableLibraryIdsAtom` (local libraries minus
 * the profile's excluded libraries), which lives in the webpack bundle.
 * Background code in the esbuild bundle — the queue dispatcher and the OCR
 * enqueue gate — cannot import Jotai atoms, so `useLibraryScopeMirror`
 * publishes the resolved scope onto `Zotero.Beaver` and these helpers read it
 * back.
 *
 * Both helpers are fail-closed: an unpublished mirror (plugin startup, logged
 * out, profile still loading) reads as "no library is in scope" rather than
 * "every library is in scope".
 */

/**
 * True once the mirror holds a resolved scope that can back allow/deny
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
