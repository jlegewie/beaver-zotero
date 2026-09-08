/**
 * Building `zotero://` URIs for a library item.
 *
 * Personal-library and group paths differ (`library` vs `groups/<groupID>`).
 * Deriving the scope needs Zotero but nothing else, so this module stays free
 * of React, the Jotai store, and `process` and can be reached from the esbuild
 * bundle — unlike `src/utils/zoteroUtils.ts`, which re-exports this surface
 * but cannot itself be imported from esbuild.
 */

/**
 * The `zotero://` path scope for a library — `library` for the personal
 * library, `groups/<groupID>` for a group — or null when this device has no
 * such library.
 *
 * Guarded, because callers run it per row while a document renders: a library
 * that cannot be resolved costs a link, never the render.
 */
export function getZoteroUriScope(libraryId: number): string | null {
    try {
        const library = Zotero.Libraries.get(libraryId);
        if (!library) return null;
        // @ts-ignore Zotero.Library.groupID is defined for group libraries
        return library.libraryType === 'group' ? `groups/${library.groupID}` : 'library';
    } catch {
        return null;
    }
}

/**
 * A `zotero://select` URI that opens Zotero and selects the given item.
 * Works without loading the full item — only needs libraryID and key.
 */
export function getZoteroSelectURI(libraryId: number, key: string): string | null {
    const scope = getZoteroUriScope(libraryId);
    return scope ? `zotero://select/${scope}/items/${key}` : null;
}

/** A `zotero://open` URI for a file attachment. */
export function getZoteroOpenURI(libraryId: number, key: string): string | null {
    const scope = getZoteroUriScope(libraryId);
    return scope ? `zotero://open/${scope}/items/${key}` : null;
}
