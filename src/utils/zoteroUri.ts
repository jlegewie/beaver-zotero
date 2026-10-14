/**
 * Whether a URI is a Zotero item URI, in the grammar `Zotero.URI` parses
 * (its prefix is always `http://zotero.org/`):
 * `http://zotero.org/users/<id>/items/<KEY>`, `…/users/local/<key>/items/<KEY>`,
 * `…/groups/<id>/items/<KEY>`, optionally with a `publications` or
 * `feeds/<id>` segment. A citation of a work that is not a library
 * item names it by another URI, which may also end in `/items/<KEY>` (a DOI
 * can), so the whole URI is checked, not its suffix.
 */
export function isZoteroItemUri(uri: string): boolean {
    return /^http:\/\/zotero\.org\/(?:users|groups)\/(?:local\/)?\w+(?:\/(?:publications|feeds\/\w+))?\/items\/\w+$/.test(uri);
}

/** Extract the item key from a Zotero item URI. */
export function extractItemKeyFromUri(uri: string): string | null {
    const match = uri.match(/\/items\/([A-Z0-9]+)$/i);
    return match ? match[1] : null;
}

/**
 * Resolve the library and key a citation item URI points at.
 *
 * A note can cite items from any library, and each `data-citation` URI names
 * the cited item's own library (`…/groups/<id>/items/<KEY>`). Zotero maps that
 * URI to a local library without loading the item (every `users/<id>` URI maps
 * to the personal library). When it can't (a group not on this computer), the
 * note's library is used. Returns null for a URI that is not a Zotero item
 * URI (a work cited without a library item).
 */
export function citationItemRefFromUri(
    uri: string,
    noteLibraryID: number,
): { libraryID: number; key: string } | null {
    if (!isZoteroItemUri(uri)) return null;
    const key = extractItemKeyFromUri(uri);
    if (!key) return null;
    try {
        const resolved = (Zotero.URI as any).getURIItemLibraryKey(uri);
        if (resolved && typeof resolved.libraryID === 'number') {
            return { libraryID: resolved.libraryID, key };
        }
    } catch {
        // Unparseable URI: fall back to the note's library.
    }
    return { libraryID: noteLibraryID, key };
}
