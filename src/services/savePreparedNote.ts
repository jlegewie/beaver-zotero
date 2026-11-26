import { checkLibraryExcluded } from './agentDataProvider/utils';
import { excludedLibraryUserMessage } from '../utils/libraryMessages';

export interface PreparedNote {
    libraryId: number;
    parentKey?: string;
    /** Collection to file a top-level note in; ignored for child notes. */
    collectionId?: number;
    html: string;
}

/** All rendering and target selection have completed before this plugin-owned save. */
export async function savePreparedNote(data: PreparedNote): Promise<Zotero.Item> {
    // Only user-initiated saves reach here, so the error is worded for the popup.
    if (checkLibraryExcluded(data.libraryId)) throw new Error(excludedLibraryUserMessage(data.libraryId));
    const note = new Zotero.Item('note');
    note.libraryID = data.libraryId;
    if (data.parentKey) {
        note.parentKey = data.parentKey;
    } else if (data.collectionId) {
        // Filed in the same save, so Zotero records the collection membership
        // and updates the collection's cached item list in one transaction.
        const collection = Zotero.Collections.get(data.collectionId);
        if (collection && collection.libraryID === data.libraryId) note.addToCollection(collection.id);
    }
    note.setNote(data.html);
    await note.saveTx();
    return note;
}
