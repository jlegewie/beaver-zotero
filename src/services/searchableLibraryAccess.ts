/**
 * Cross-bundle access to the current searchable-library boundary.
 *
 * `searchableLibraryIdsAtom` is instantiated by the webpack/React bundle, so
 * esbuild-side services must not import it directly (that would create a
 * second atom identity). The React bundle registers this accessor at startup.
 * Absence or failure is treated as no access: background work must never read
 * library content when the privacy boundary cannot be established.
 */
export function isLibrarySearchableForBackgroundWork(libraryId: number): boolean {
    try {
        return Zotero.__beaverGetSearchableLibraryIds?.().includes(libraryId) === true;
    } catch {
        return false;
    }
}
