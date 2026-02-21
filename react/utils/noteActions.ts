import { ZoteroItemReference } from "../types/zotero";
import { renderToHTML, RenderContextData } from "./citationRenderers";

export interface SaveStreamingNoteOptions {
    markdownContent: string;
    title: string;
    parentReference?: ZoteroItemReference;
    targetLibraryId?: number;
    contextData?: RenderContextData;
    threadId?: string;
    runId?: string;
}

export function getBeaverNoteFooterHTML(threadId: string, runId: string): string {
    const url = `zotero://beaver/thread/${threadId}/run/${runId}`;
    return `<p><span style="color: #aaa;"><a href="${url}">Open in Beaver</a></span></p>`;
}

export interface SavedNoteReference {

    zotero_key: string;
    parent_key?: string;
    library_id: number;
}

export async function saveStreamingNote(options: SaveStreamingNoteOptions): Promise<SavedNoteReference> {
    const { markdownContent, parentReference, targetLibraryId, contextData, threadId, runId } = options;
    let htmlContent = renderToHTML(markdownContent.trim(), "markdown", contextData);

    if (threadId && runId) {
        htmlContent += getBeaverNoteFooterHTML(threadId, runId);
    }

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
