import { ZoteroItemReference } from "../types/zotero";
import { renderToHTML, RenderContextData } from "./citationRenderers";

export interface SaveStreamingNoteOptions {
    markdownContent: string;
    title: string;
    parentReference?: ZoteroItemReference;
    targetLibraryId?: number;
    contextData?: RenderContextData;
}

export interface SavedNoteReference {

    zotero_key: string;
    parent_key?: string;
    library_id: number;
}

export async function saveStreamingNote(options: SaveStreamingNoteOptions): Promise<SavedNoteReference> {
    const { markdownContent, parentReference, targetLibraryId, contextData } = options;
    const htmlContent = renderToHTML(markdownContent.trim(), "markdown", contextData);

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
