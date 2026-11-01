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
