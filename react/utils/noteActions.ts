import { currentThreadNameAtom } from "../atoms/threads";
import { store } from "../store";
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
