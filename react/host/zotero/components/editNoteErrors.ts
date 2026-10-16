import type { AgentAction } from '@beaver/agent-core/agents/agentActionTypes';

/**
 * Note-edit failures that a Retry cannot fix.
 *
 * Applying an edit re-locates its target text in the note as it stands now.
 * When that text is gone, ambiguous, or the edits now overlap, the note no
 * longer looks the way it did when the edit was proposed, and every retry
 * fails the same way; only a new edit against the current note helps.
 * Known failures are matched by code, with the message as a fallback for
 * records saved without one.
 */

const STALE_TARGET_CODES = new Set([
    'old_string_not_found',
    'ambiguous_match',
    'overlapping_edits',
    'note_changed',
]);

const STALE_TARGET_MESSAGE =
    /no longer resolve against the current note|now target overlapping regions of the note|string to replace was not found in the note|The note changed after/i;

export const STALE_NOTE_EDIT_MESSAGE =
    'The note changed after this edit was proposed, so it can no longer be applied. Ask Beaver to make the edit again.';

/** True when an edit_note / edit_note_batch apply failed because the note no longer matches it. */
export function isStaleNoteEdit(action: AgentAction): boolean {
    if (action.action_type !== 'edit_note' && action.action_type !== 'edit_note_batch') return false;
    // A retained result means the edit landed and its undo failed; that retry
    // targets the undo and stays available.
    if (action.status !== 'error' || action.result_data != null) return false;
    const code = (action.error_details as Record<string, unknown> | undefined)?.error_code;
    if (typeof code === 'string' && STALE_TARGET_CODES.has(code)) return true;
    return STALE_TARGET_MESSAGE.test(action.error_message ?? '');
}
