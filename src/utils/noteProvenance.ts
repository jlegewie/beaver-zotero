import { logger } from '@beaver/agent-core/platform/logger';
import { hasSchemaVersionWrapper } from './noteWrapper';
const NOTE_SCHEMA_VERSION = 9;
export function wrapWithSchemaVersion(html: string): string {
    if (hasSchemaVersionWrapper(html)) return html;
    return `<div data-schema-version="${NOTE_SCHEMA_VERSION}">${html}</div>`;
}
export function getBeaverNoteFooterHTML(threadId: string, runId?: string): string {
    const url = runId
        ? `zotero://beaver/thread/${threadId}/run/${runId}`
        : `zotero://beaver/thread/${threadId}`;
    const linkText = runId ? 'Open Message' : 'Open Chat';
    return `<p><span style="color: #aaa;"><strong>Created by Beaver</strong> \u00b7 <a href="${url}">${linkText}</a></span></p>`;
}

function escapeHtml(str: string): string { return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
export interface ProvenanceNoteOptions {
    reason?: string;
    threadId?: string;
    runId?: string;
}

export interface ProvenanceNoteParent {
    library_id: number;
    zotero_key: string;
    library_ref?: string;
}

/**
 * Build the inner HTML for an item provenance note.
 */
export function buildProvenanceNoteHTML(options: ProvenanceNoteOptions = {}): string {
    const now = new Date();
    const dateStr = now.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    const timeStr = now.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    const lines = [
        `<p><strong>Added by Beaver</strong> on ${dateStr} at ${timeStr}</p>`,
    ];

    if (options.reason) {
        lines.push(`<p><strong>Reason:</strong> ${escapeHtml(options.reason)}</p>`);
    }

    if (options.threadId) {
        lines.push(getBeaverNoteFooterHTML(options.threadId, options.runId));
    }

    return lines.join('');
}

/**
 * Create a child note that records why Beaver added an item.
 */
export async function createProvenanceNote(
    parent: ProvenanceNoteParent,
    options: ProvenanceNoteOptions = {},
): Promise<void> {
    try {
        const zoteroNote = new Zotero.Item('note');
        zoteroNote.libraryID = parent.library_id;
        zoteroNote.parentKey = parent.zotero_key;
        zoteroNote.setNote(wrapWithSchemaVersion(buildProvenanceNoteHTML(options)));
        await zoteroNote.saveTx();
    } catch (error) {
        logger(`createProvenanceNote: Failed to create provenance note: ${error}`, 1);
    }
}

