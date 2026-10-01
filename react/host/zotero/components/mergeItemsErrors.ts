import type { AgentAction } from '@beaver/agent-core/agents/agentActionTypes';
import { formatFieldName } from '../../../utils/fieldLabels';
import { isUnconfirmedAction } from './reviewChangeRows';

/**
 * User-facing wording for merge_items failures.
 *
 * The saved error is the message thrown by the merge service (or the backend's
 * wording for an apply it could not confirm). These helpers turn it into one
 * short line for the card and decide whether Retry can succeed. Known errors
 * are matched by code, with the message as a fallback: an apply that ran
 * through the backend's approval path keeps only the message.
 */

function errorCode(action: AgentAction): string | undefined {
    const code = (action.error_details as Record<string, unknown> | undefined)?.error_code;
    return typeof code === 'string' ? code : undefined;
}

/** A failed undo leaves the merge in place: the action still carries its result. */
export function isFailedMergeUndo(action: AgentAction): boolean {
    return action.status === 'error' && action.result_data != null;
}

/**
 * The records changed after the proposal was reviewed. The merge compares
 * against the proposal's snapshot, so retrying fails the same way every time;
 * only a new proposal helps.
 */
export function isStaleMergeProposal(action: AgentAction): boolean {
    if (action.action_type !== 'merge_items' || action.status !== 'error' || action.result_data != null)
        return false;
    const code = errorCode(action);
    return (
        code === 'stale_snapshot' ||
        code === 'snapshot_required' ||
        /changed since this merge was proposed|no reviewed snapshot/i.test(action.error_message ?? '')
    );
}

/** What changed, for item JSON keys that undo can report but that are not metadata fields. */
const CHANGE_PHRASES: Record<string, string> = {
    relations: 'Related items changed',
    deleted: 'A record was moved into or out of the Trash',
    parentItem: 'A note or attachment was moved',
    collections: 'Collections changed',
    tags: 'Tags changed',
};

function isUndoError(action: AgentAction): boolean {
    return errorCode(action) === 'undo_conflict' || /\bundo|undone\b/i.test(action.error_message ?? '');
}

function mergeErrorReason(message: string, code: string | undefined): string {
    const text = message.replace(/\s*Undo was not applied\.?\s*$/i, '').trim();
    const field = text.match(/^An affected (\S+) changed after the merge/);
    if (field) {
        const change = CHANGE_PHRASES[field[1]] ?? `${formatFieldName(field[1])} changed`;
        return `${change} after the merge, and undo would overwrite that change.`;
    }
    // The service reuses the exclusion message written for the model; the card
    // needs its own wording.
    if (code === 'library_excluded' || /is excluded from Beaver/i.test(text))
        return 'This library is excluded from Beaver. Re-enable it in Beaver Preferences, then retry.';
    if (code === 'stale_snapshot' || code === 'snapshot_required' || /changed since this merge was proposed/i.test(text))
        return 'The records changed after this merge was proposed. Ask Beaver to propose it again.';
    if (code === 'item_unavailable' || /is unavailable or trashed/i.test(text))
        return 'A record in this merge is in the Trash or no longer exists.';
    if (/permanently deleted/i.test(text))
        return 'An item from this merge was permanently deleted, so the merge cannot be undone.';
    return /[.!?]$/.test(text) ? text : `${text}.`;
}

/**
 * One line explaining why the merge or its undo did not go through, or null
 * when the action has no error to report.
 */
export function mergeErrorLine(action: AgentAction | undefined): string | null {
    if (!action || action.status !== 'error' || !action.error_message) return null;
    // The backend's own wording already says what is known and what to check.
    if (isUnconfirmedAction(action)) return action.error_message;
    // A retained result proves the merge landed, not which operation failed: a
    // merge whose acknowledgement failed looks the same as a failed undo. Only
    // errors raised by the undo itself are reported as one.
    const lead = !isFailedMergeUndo(action)
        ? 'Not merged'
        : isUndoError(action)
          ? 'Undo not applied'
          : 'Merged, but an error occurred';
    return `${lead}. ${mergeErrorReason(action.error_message, errorCode(action))}`;
}
