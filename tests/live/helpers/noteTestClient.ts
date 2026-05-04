/**
 * HTTP client helpers for edit_note live tests.
 *
 * Talks to the `/beaver/test/note-*` and `/beaver/agent-action/*` endpoints
 * registered in `react/hooks/useHttpEndpoints.ts`. Only used by live tests.
 */

import { post } from '../../helpers/zoteroHttpClient';

// ---------------------------------------------------------------------------
// Note seeding / teardown / inspection
// ---------------------------------------------------------------------------

export interface CreateNoteResult {
    library_id: number;
    zotero_key: string;
    item_id: number;
    error?: string;
}

export interface ReadNoteResult {
    library_id: number;
    zotero_key: string;
    item_id: number;
    saved_html: string;
    live_html: string | null;
    in_editor: boolean;
    error?: string;
}

export async function createNote(opts: {
    library_id?: number;
    html: string;
    title?: string;
    parent_key?: string;
    wrap_schema?: boolean;
}): Promise<CreateNoteResult> {
    return post<CreateNoteResult>('/beaver/test/note-create', opts);
}

export async function deleteNote(libraryId: number, zoteroKey: string): Promise<void> {
    const res = await post<{ ok?: boolean; error?: string }>(
        '/beaver/test/note-delete',
        { library_id: libraryId, zotero_key: zoteroKey },
    );
    if (res.error) throw new Error(res.error);
}

export async function readNote(libraryId: number, zoteroKey: string): Promise<ReadNoteResult> {
    return post<ReadNoteResult>('/beaver/test/note-read', {
        library_id: libraryId,
        zotero_key: zoteroKey,
    });
}

export async function openNoteEditor(
    libraryId: number,
    zoteroKey: string,
    openInWindow = true,
): Promise<{ ok: boolean; in_editor: boolean; error?: string }> {
    return post('/beaver/test/note-open-editor', {
        library_id: libraryId,
        zotero_key: zoteroKey,
        open_in_window: openInWindow,
    });
}

export async function closeNoteEditor(
    libraryId: number,
    zoteroKey: string,
): Promise<{ ok: boolean; closed: number; error?: string }> {
    return post('/beaver/test/note-close-editor', {
        library_id: libraryId,
        zotero_key: zoteroKey,
    });
}

export async function undoEditNote(action: {
    proposed_data: Record<string, any>;
    result_data?: Record<string, any>;
    [k: string]: any;
}): Promise<{ ok: boolean; error?: string }> {
    return post('/beaver/test/note-undo', { action });
}

// ---------------------------------------------------------------------------
// Agent-action HTTP wrappers (typed for edit_note)
// ---------------------------------------------------------------------------

export type EditNoteOperation =
    | 'str_replace'
    | 'str_replace_all'
    | 'insert_after'
    | 'insert_before'
    | 'rewrite';

export interface EditNoteActionData {
    library_id: number;
    zotero_key: string;
    operation?: EditNoteOperation;
    old_string?: string;
    new_string: string;
    target_before_context?: string;
    target_after_context?: string;
}

export interface ErrorCandidate {
    snippet: string;
    truncated: boolean;
    via: 'whitespace_relaxed' | 'word_overlap' | 'inline_tag_drift' | 'structural_anchor';
    score: number;
}

export interface ValidateResponse {
    valid: boolean;
    error?: string | null;
    error_code?: string | null;
    error_candidates?: ErrorCandidate[];
    current_value?: any;
    normalized_action_data?: Record<string, any>;
    preference?: string;
}

export interface ExecuteResponse {
    success: boolean;
    error?: string | null;
    error_code?: string | null;
    error_candidates?: ErrorCandidate[];
    result_data?: {
        library_id: number;
        zotero_key: string;
        occurrences_replaced: number;
        warnings?: string[];
        undo_old_html?: string;
        undo_new_html?: string;
        undo_before_context?: string;
        undo_after_context?: string;
        undo_occurrence_contexts?: Array<{ before: string; after: string }>;
        undo_full_html?: string;
    };
}

export async function validateEditNote(
    actionData: EditNoteActionData,
): Promise<ValidateResponse> {
    return post<ValidateResponse>('/beaver/agent-action/validate', {
        action_type: 'edit_note',
        action_data: actionData,
    });
}

export async function executeEditNote(
    actionData: EditNoteActionData,
    opts?: { timeout?: number; timeoutSeconds?: number },
): Promise<ExecuteResponse> {
    return post<ExecuteResponse>(
        '/beaver/agent-action/execute',
        {
            action_type: 'edit_note',
            action_data: actionData,
            timeout_seconds: opts?.timeoutSeconds,
        },
        { timeout: opts?.timeout },
    );
}

/**
 * Build an `AgentAction`-shaped payload for `/beaver/test/note-undo` from the
 * action_data used to apply the edit and the execute response's result_data.
 */
export function buildUndoAction(
    actionData: EditNoteActionData,
    executeResponse: ExecuteResponse,
): { proposed_data: Record<string, any>; result_data?: Record<string, any> } {
    return {
        proposed_data: actionData as Record<string, any>,
        result_data: executeResponse.result_data,
    };
}
