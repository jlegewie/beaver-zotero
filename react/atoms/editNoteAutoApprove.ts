/**
 * Per-note-per-run auto-approve state for edit_note actions.
 *
 * After a user clicks "Apply all for this note", subsequent edit_note calls
 * targeting the same note within the same agent run are auto-approved without
 * showing the approval dialog.
 */

import { atom } from 'jotai';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Canonical key for a specific note: "{libraryId}-{zoteroKey}" */
export function makeNoteKey(libraryId: number, zoteroKey: string): string {
    return `${libraryId}-${zoteroKey}`;
}

// ---------------------------------------------------------------------------
// Auto-approve note keys (per-run)
// ---------------------------------------------------------------------------

/** Set of note keys ("libraryId-zoteroKey") auto-approved for the current run */
export const autoApproveNoteKeysAtom = atom<Set<string>>(new Set<string>());

/** Add a note key to the auto-approve set */
export const addAutoApproveNoteKeyAtom = atom(
    null,
    (_get, set, noteKey: string) => {
        set(autoApproveNoteKeysAtom, (prev: Set<string>) => {
            const next = new Set<string>(prev);
            next.add(noteKey);
            return next;
        });
    },
);

/** Clear all auto-approve note keys (called on run end / thread clear) */
export const clearAutoApproveNoteKeysAtom = atom(
    null,
    (_get, set) => {
        set(autoApproveNoteKeysAtom, new Set<string>());
    },
);

// ---------------------------------------------------------------------------
// Auto-approved action IDs (for UI labeling)
// ---------------------------------------------------------------------------

/** Set of action IDs that were auto-approved (so the UI can show "(auto)") */
export const autoApprovedActionIdsAtom = atom<Set<string>>(new Set<string>());

/** Record an action as auto-approved */
export const addAutoApprovedActionIdAtom = atom(
    null,
    (_get, set, actionId: string) => {
        set(autoApprovedActionIdsAtom, (prev: Set<string>) => {
            const next = new Set<string>(prev);
            next.add(actionId);
            return next;
        });
    },
);

/** Clear all auto-approved action IDs (called on thread clear) */
export const clearAutoApprovedActionIdsAtom = atom(
    null,
    (_get, set) => {
        set(autoApprovedActionIdsAtom, new Set<string>());
    },
);
