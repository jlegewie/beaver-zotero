import { ZoteroItemReference } from "@beaver/agent-core/types/zotero";
import { libraryRefForLibraryID } from "../../src/utils/libraryIdentity";
import { getBeaverNoteFooterHTML, wrapWithSchemaVersion } from '../../src/utils/noteProvenance';
import { currentThreadNameAtom } from "../atoms/threads";
import { captureWindowMutationOptions, runWindowOperation } from '../runtime/libraryMutation';
import { store } from "../store";
import { prepareCitationRenderContext } from "./citationRenderContext";
import { RenderContextData, renderToHTML } from "./citationRenderers";
export { buildProvenanceNoteHTML, createProvenanceNote, getBeaverNoteFooterHTML, wrapWithSchemaVersion, type ProvenanceNoteOptions, type ProvenanceNoteParent } from '../../src/utils/noteProvenance';

/**
    * Schema version used by the Zotero note editor for modern notes.
    * Version 9 is standard for notes without underline annotations.
    */
const NOTE_SCHEMA_VERSION = 9;

/**
    * Wrap note HTML in a `<div data-schema-version="N">` container if not already present.
    * This ensures Beaver-created notes have the same structure as notes created by the
    * Zotero note editor, which is required for edit_note to work correctly.
    */


export interface SaveStreamingNoteOptions {
    markdownContent: string;
    title: string;
    parentReference?: ZoteroItemReference;
    targetLibraryId?: number;
    contextData?: RenderContextData;
    threadId?: string;
    runId?: string;
}

/** Escape HTML special characters in plain text */
function escapeHtml(str: string): string {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
    * Generate an HTML title heading for a saved note.
    * For single responses: "Thread Name (Chat 2, Apr 1, 2026, 4:23 PM)"
    * Date/time is locale-aware (e.g. 24h clock in Europe).
    * @param responseIndex - 1-based index of the response in the thread (omit for full-thread saves)
    */
export function generateNoteTitle(responseIndex?: number): string {
    const threadName = store.get(currentThreadNameAtom) || 'Beaver Response';
    const now = new Date();
    const dateStr = now.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    const timeStr = now.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    const indexPart = responseIndex != null ? ` - Message ${responseIndex}` : '';
    return `<h1>${escapeHtml(threadName)}${indexPart} (${dateStr} at ${timeStr})</h1>`;
}



export interface SavedNoteReference {

    zotero_key: string;
    parent_key?: string;
    library_id: number;
    /** Device-portable library identity ("u" | "g<groupID>"). See `src/utils/libraryIdentity.ts`. */
    library_ref?: string;
}

export async function saveStreamingNote(options: SaveStreamingNoteOptions): Promise<SavedNoteReference> {
    const owner = captureWindowMutationOptions();
    const { markdownContent, parentReference, targetLibraryId, contextData, threadId, runId } = options;
    const renderContextData = await prepareCitationRenderContext(markdownContent, contextData);
    let htmlContent = renderToHTML(markdownContent.trim(), "markdown", renderContextData);

    if (threadId && runId) {
        htmlContent += getBeaverNoteFooterHTML(threadId, runId);
    }

    const zoteroNote = await runWindowOperation('savePreparedNote', [{
        libraryId: parentReference?.library_id ?? targetLibraryId ?? Zotero.Libraries.userLibraryID,
        parentKey: parentReference?.zotero_key,
        html: wrapWithSchemaVersion(htmlContent),
    }], owner);

    return {
        library_id: zoteroNote.libraryID,
        zotero_key: zoteroNote.key,
        library_ref: libraryRefForLibraryID(zoteroNote.libraryID) ?? undefined,
        ...(zoteroNote.parentKey ? { parent_key: zoteroNote.parentKey } : {})
    };
}
