import { checkLibraryExcluded } from './agentDataProvider/utils';

export interface PreparedNote {
    libraryId: number;
    parentKey?: string;
    collectionId?: number;
    html: string;
}

/** All rendering and target selection have completed before this plugin-owned save. */
export async function savePreparedNote(data: PreparedNote): Promise<Zotero.Item> {
    const exclusion = checkLibraryExcluded(data.libraryId);
    if (exclusion) throw new Error(exclusion.message);
    const note = new Zotero.Item('note');
    note.libraryID = data.libraryId;
    if (data.parentKey) note.parentKey = data.parentKey;
    note.setNote(data.html);
    await note.saveTx();
    if (data.collectionId) {
        await Zotero.DB.executeTransaction(async () => {
            const collection = Zotero.Collections.get(data.collectionId!);
            if (collection && collection.libraryID === data.libraryId) collection.addItem(note.id);
        });
    }
    return note;
}
