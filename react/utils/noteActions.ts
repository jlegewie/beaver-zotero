import { ZoteroItemReference } from "../types/zotero";
import { renderToHTML, RenderContextData } from "./citationRenderers";
import { preloadPageLabelsForContent } from "./pageLabels";
import { hasSchemaVersionWrapper } from "../../src/utils/noteWrapper";
import { store } from "../store";
import { currentThreadNameAtom } from "../atoms/threads";

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
export function wrapWithSchemaVersion(html: string): string {
    if (hasSchemaVersionWrapper(html)) return html;
    return `<div data-schema-version="${NOTE_SCHEMA_VERSION}">${html}</div>`;
}

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

export function getBeaverNoteFooterHTML(threadId: string, runId?: string): string {
    const url = runId
        ? `zotero://beaver/thread/${threadId}/run/${runId}`
        : `zotero://beaver/thread/${threadId}`;
    const linkText = runId ? 'Open Message' : 'Open Chat';
    return `<p><span style="color: #aaa;"><strong>Created by Beaver</strong> \u00b7 <a href="${url}">${linkText}</a></span></p>`;
}

export interface SavedNoteReference {

    zotero_key: string;
    parent_key?: string;
    library_id: number;
}

export async function saveStreamingNote(options: SaveStreamingNoteOptions): Promise<SavedNoteReference> {
    const { markdownContent, parentReference, targetLibraryId, contextData, threadId, runId } = options;
    await preloadPageLabelsForContent(markdownContent);
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

    zoteroNote.setNote(wrapWithSchemaVersion(htmlContent));
    await zoteroNote.saveTx();

    return {
        library_id: zoteroNote.libraryID,
        zotero_key: zoteroNote.key,
        ...(zoteroNote.parentKey ? { parent_key: zoteroNote.parentKey } : {})
    };
}
