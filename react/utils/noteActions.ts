import { renderToHTML } from './citationRenderers';
import { ZoteroItemReference } from '../types/zotero';

export interface SaveStreamingNoteOptions {
    markdownContent: string;
    title?: string;
    parentReference?: ZoteroItemReference | null;
    targetLibraryId?: number;
}

export interface SavedNoteReference {
    library_id: number;
    zotero_key: string;
    parent_key?: string;
}

export async function saveStreamingNote(options: SaveStreamingNoteOptions): Promise<SavedNoteReference> {
    const { markdownContent, parentReference, targetLibraryId } = options;
    const htmlContent = renderToHTML(markdownContent.trim());

    const zoteroNote = new Zotero.Item('note');

    if (parentReference) {
        zoteroNote.libraryID = parentReference.library_id;
        zoteroNote.parentKey = parentReference.zotero_key;
    } else if (typeof targetLibraryId === 'number') {
        zoteroNote.libraryID = targetLibraryId;
    }

    zoteroNote.setNote(htmlContent);
    await zoteroNote.saveTx();

    return {
        library_id: zoteroNote.libraryID,
        zotero_key: zoteroNote.key,
        ...(zoteroNote.parentKey ? { parent_key: zoteroNote.parentKey } : {})
    };
}

