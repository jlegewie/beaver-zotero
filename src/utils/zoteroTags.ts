/**
 * Delete a tag from a single library.
 *
 * Tag IDs are global, so a name can resolve to a tagID while no item in
 * `libraryID` carries it (the tag lives in another library or is orphaned).
 * Zotero.Tags.removeFromLibrary throws a raw SQL error for that case, so it is
 * only called when the library has tagged items. An item-less tag can still
 * show in the tag selector through its color assignment; that is cleared
 * instead.
 *
 * @returns true if the tag was removed from at least one item.
 */
export async function removeTagFromLibrary(libraryID: number, tagID: number, name: string): Promise<boolean> {
    const itemIDs = await Zotero.Tags.getTagItems(libraryID, tagID);
    if (itemIDs.length > 0) {
        // onProgress and types are optional at runtime (see Zotero.Tags.removeFromLibrary
        // JSDoc in tags.js); the .d.ts in zotero-types marks them required.
        await (Zotero.Tags.removeFromLibrary as any)(libraryID, [tagID]);
        return true;
    }
    if (Zotero.Tags.getColor(libraryID, name)) {
        // A falsy color unsets the assignment; zotero-types types `color` as string.
        await (Zotero.Tags.setColor as any)(libraryID, name, false);
    }
    return false;
}

/**
 * Look up a tag by name within one library.
 *
 * Tag IDs are global, so a name can resolve while no item in `libraryID`
 * carries it. The tag is in the library when an item there carries it or the
 * library assigns it a color (which keeps it in the tag selector).
 *
 * @returns whether the tag is in the library, and the IDs of its items there.
 */
export async function findLibraryTag(
    libraryID: number,
    name: string,
): Promise<{ inLibrary: boolean; itemIDs: number[] }> {
    const tagID = Zotero.Tags.getID(name);
    const itemIDs = tagID ? await Zotero.Tags.getTagItems(libraryID, tagID) : [];
    return { inLibrary: itemIDs.length > 0 || !!Zotero.Tags.getColor(libraryID, name), itemIDs };
}
