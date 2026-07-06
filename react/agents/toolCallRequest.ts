/**
 * Pure, client-agnostic helpers derived from a tool-call's request side
 * (`ToolCallPart.args`) — no Zotero loads, no `getHost()`. Split out of
 * `toolLabels.ts` (which is Zotero-coupled via `getToolCallLabel`) so the shared
 * render layer (e.g. the generic agent-action fallback) can reuse the base
 * labels and arg-derived references without pulling Zotero into guarded code.
 */

import { ToolCallPart } from './types';
import { ZoteroItemReference } from '../types/zotero';
import { libraryRefForLibraryID } from '../../src/utils/libraryIdentity';

/**
 * Parse args from a {@link ToolCallPart} — handles both string and object formats.
 */
export function parseArgs(part: ToolCallPart): Record<string, unknown> {
    if (!part.args) return {};
    if (typeof part.args === 'string') {
        try {
            return JSON.parse(part.args);
        } catch {
            return {};
        }
    }
    return part.args as Record<string, unknown>;
}

function zoteroReferenceFromCompoundId(id: string): ZoteroItemReference | null {
    const [libraryIdStr, ...keyParts] = id.split('-');
    const zoteroKey = keyParts.join('-');
    if (!libraryIdStr || !zoteroKey) return null;
    const libraryId = parseInt(libraryIdStr, 10);
    if (isNaN(libraryId)) return null;
    return {
        library_id: libraryId,
        zotero_key: zoteroKey,
        library_ref: libraryRefForLibraryID(libraryId) ?? undefined,
    };
}

/**
 * Extract Zotero item references from a tool call part.
 * Looks for attachment_id parameters in tool call arguments.
 * Returns an array of ZoteroItemReference, or empty array if none found.
 */
export function extractZoteroReferencesFromToolCall(part: ToolCallPart): ZoteroItemReference[] {
    const args = parseArgs(part);
    const references: ZoteroItemReference[] = [];

    // Extract attachment_id if present (used by read_pages, add_highlight_annotations,
    // add_note_annotations, search_in_attachment, view_pages, view_page_images, etc.)
    const attachmentId = args.attachment_id as string | undefined;
    if (attachmentId) {
        const ref = zoteroReferenceFromCompoundId(attachmentId);
        if (ref) references.push(ref);
    }

    // Extract file id if present (used by read). Zotero attachment ids use
    // '<library_id>-<zotero_key>'; external file ids ('ext-1') carry no Zotero reference.
    const file = args.file as string | undefined;
    if (file && /^\d+-/.test(file)) {
        const ref = zoteroReferenceFromCompoundId(file);
        if (ref) references.push(ref);
    }

    // Extract note_id if present (used by read_note, edit_note)
    const noteId = args.note_id as string | undefined;
    if (noteId) {
        const ref = zoteroReferenceFromCompoundId(noteId);
        if (ref) references.push(ref);
    }

    // Extract attachment_ids array if present (for tools that accept multiple attachments)
    const attachmentIds = args.attachment_ids as string[] | undefined;
    if (Array.isArray(attachmentIds)) {
        for (const id of attachmentIds) {
            const ref = zoteroReferenceFromCompoundId(id);
            if (ref) references.push(ref);
        }
    }

    return references;
}

/**
 * Base labels for tool calls (display names).
 * Maps tool_name to a human-readable base label.
 */
export const TOOL_BASE_LABELS: Record<string, string> = {
    // Search tools
    item_search: 'Item search',
    item_search_by_topic: 'Item search',
    item_search_by_metadata: 'Item search',
    fulltext_search: 'Fulltext search',
    fulltext_search_keywords: 'Keyword search',

    // List tools
    list_items: 'List items',
    list_collections: 'List collections',
    list_tags: 'List tags',
    list_libraries: 'List libraries',
    zotero_search: 'Zotero search',

    // Metadata tools
    get_metadata: 'Get metadata',
    edit_metadata: 'Edit metadata',

    // Annotation tools
    get_annotations: 'Get annotations',
    find_annotations: 'Find annotations',

    // Note tools
    read_note: 'Reading note',
    edit_note: 'Edit note',
    create_note: 'Create note',

    // Organization tools
    organize_items: 'Organize items',
    create_collection: 'Create collection',

    // Tag tools
    manage_tags: 'Manage tags',
    manage_collections: 'Manage collections',

    // Reading tools
    read: 'Reading',
    read_pages: 'Reading',
    read_attachment: 'Reading',
    search_in_documents: 'Search in documents',
    search_in_attachment: 'Search in attachment',
    search_in_attachments: 'Search in attachments',
    find_in_attachments: 'Find in attachments',
    read_file: 'Retrieving data',
    load_tool_results: 'Loading tool results',
    view_pages: 'Viewing pages',
    view_page_images: 'Viewing pages',
    view: 'Viewing',

    // Extract tool
    extract: 'Extracting',

    // Annotations
    add_highlight_annotations: 'Highlight annotations',
    add_note_annotations: 'Note annotations',
    create_highlight_annotations: 'Creating highlight annotations',
    create_note_annotations: 'Creating sticky notes',

    // Suggestions
    return_suggestions: 'Suggestions',

    // User interaction
    ask_user_question: 'Asking a question',

    // External search
    search_external_references: 'Web search',
    create_zotero_item: 'Add item',
    external_search: 'Web search',
    lookup_work: 'Lookup work',

    // Framework tools
    load_capability: 'Loading skill',
    search_tools: 'Finding tools',
};
