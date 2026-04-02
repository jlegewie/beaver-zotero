/**
 * Diff Preview Coordinator
 *
 * Bridges the approval system (Jotai atoms) and the editor preview module.
 * Called imperatively from atom setters — no React effects needed.
 *
 * Import graph (no cycles):
 *   agentActions.ts ──→ diffPreviewCoordinator.ts ──→ noteEditorDiffPreview.ts
 *   agentRunAtoms.ts ─→ (not imported directly)       ↓
 *                                                  noteHtmlSimplifier.ts
 *
 * Heavy dependencies (store, atoms) are lazy-loaded to avoid pulling Zotero
 * globals into unit tests that transitively import agentActions.
 */

import { atom } from 'jotai';
import {
    showDiffPreview,
    dismissDiffPreview,
    isDiffPreviewActive,
    isNoteOpenInEditor,
    setOnBannerAction,
    type EditOperation,
} from './noteEditorDiffPreview';
import { makeNoteKey } from '../atoms/editNoteAutoApprove';
import { logger } from '../../src/utils/logger';

// Lazy accessors — avoids pulling in store/atoms at module load time.
// This is critical: agentActions.ts imports this file, and test files
// import agentActions.ts. If we eagerly import store.ts here, its
// Zotero.getMainWindow() call runs during test setup and crashes.
function getStore(): any {
    return require('../store').store;
}

// =============================================================================
// React-readable atom
// =============================================================================

/**
 * Holds the note key (e.g. "1-ABCDE") of the note currently previewed in the
 * editor, or null. React components read this for the "Previewing in note
 * editor" indicator.
 */
export const diffPreviewNoteKeyAtom = atom<string | null>(null);

// =============================================================================
// Coordinator
// =============================================================================

/**
 * Gather all pending edit_note approvals for a note and show/update/dismiss
 * the in-editor diff preview accordingly. Fire-and-forget (async).
 *
 * Called from addPendingApprovalAtom and removePendingApprovalAtom.
 */
export function updateDiffPreviewForNote(libraryId: number, zoteroKey: string): void {
    const store = getStore();
    const { pendingApprovalsAtom } = require('../agents/agentActions');
    const noteKey = makeNoteKey(libraryId, zoteroKey);
    const allApprovals: Map<string, any> = store.get(pendingApprovalsAtom);

    const edits: EditOperation[] = [];
    for (const [, pa] of allApprovals) {
        if (pa.actionType !== 'edit_note') continue;
        const paLib = pa.actionData?.library_id;
        const paKey = pa.actionData?.zotero_key;
        if (paLib == null || !paKey || makeNoteKey(paLib, paKey) !== noteKey) continue;
        const oldStr = pa.actionData?.old_string ?? '';
        if (oldStr) {
            edits.push({
                oldString: oldStr,
                newString: pa.actionData?.new_string ?? '',
                replaceAll: pa.actionData?.replace_all ?? false,
            });
        }
    }

    if (edits.length === 0) {
        if (isDiffPreviewActive(libraryId, zoteroKey)) {
            dismissDiffPreview();
            store.set(diffPreviewNoteKeyAtom, null);
        }
        return;
    }

    if (!isNoteOpenInEditor(libraryId, zoteroKey)) return;

    showDiffPreview(libraryId, zoteroKey, edits)
        .then((shown) => {
            getStore().set(diffPreviewNoteKeyAtom, shown ? noteKey : null);
        })
        .catch(() => {
            getStore().set(diffPreviewNoteKeyAtom, null);
        });
}

// =============================================================================
// Banner action handler
// =============================================================================

function handleBannerAction(action: string): void {
    if (action !== 'approveAll' && action !== 'rejectAll') return;

    const approved = action === 'approveAll';
    const store = getStore();
    const { pendingApprovalsAtom, removePendingApprovalAtom } = require('../agents/agentActions');
    const { sendApprovalResponseAtom } = require('../atoms/agentRunAtoms');

    // Dismiss the preview immediately
    dismissDiffPreview();
    store.set(diffPreviewNoteKeyAtom, null);

    // Read current approvals (fresh) and approve/reject all edit_note ones
    const allApprovals: Map<string, any> = store.get(pendingApprovalsAtom);
    let count = 0;
    for (const [, pa] of allApprovals) {
        if (pa.actionType !== 'edit_note') continue;
        store.set(sendApprovalResponseAtom, { actionId: pa.actionId, approved });
        store.set(removePendingApprovalAtom, pa.actionId);
        count++;
    }
    logger(`diffPreviewCoordinator: banner ${action} — ${count} edit(s)`, 1);
}

// Register the banner handler at module load
setOnBannerAction(handleBannerAction);
