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
 * to the personal library). When it can't (a group not on this computer, a
 * malformed URI), the note's library is used. Returns null when the URI has no
 * item key.
 */
export function citationItemRefFromUri(
    uri: string,
    noteLibraryID: number,
): { libraryID: number; key: string } | null {
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
