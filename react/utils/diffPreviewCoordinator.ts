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
 * store.ts is imported eagerly but is safe in tests (it guards on
 * `typeof Zotero`).
 */

import { atom } from 'jotai';
import {
    showDiffPreview,
    dismissDiffPreview,
    isDiffPreviewActive,
    isDiffPreviewSupported,
    isNoteInSelectedTab,
    getPreviewNoteKey,
    setOnBannerAction,
    setOnDismiss,
    type EditOperation,
} from './noteEditorDiffPreview';
import { makeNoteKey } from '../atoms/editNoteAutoApprove';
import { logger } from '../../src/utils/logger';
import { store } from '../store';
import { pendingApprovalsAtom } from '../agents/agentActions';
import { sendApprovalResponseAtom } from '../atoms/agentRunAtoms';

/**
 * Global kill switch for the diff preview feature.
 * Set to `false` to disable all in-editor diff previews regardless of
 * runtime capability. This is intentionally a compile-time constant so the
 * feature can be toggled off quickly without a settings round-trip.
 *
 * For runtime feature detection (e.g. Zotero 7 vs 8) use
 * `isDiffPreviewSupported()` from `noteEditorDiffPreview.ts`. The preview is
 * considered live only when BOTH flags are true; see `isDiffPreviewLive()`.
 */
export const DIFF_PREVIEW_ENABLED = true;

/**
 * Convenience gate that combines the kill switch and the runtime capability
 * check. Use this from UI components to decide whether to render
 * preview-related controls.
 */
export function isDiffPreviewLive(): boolean {
    return DIFF_PREVIEW_ENABLED && isDiffPreviewSupported();
}

// Accessor for the Jotai store. The store is imported eagerly above
// (store.ts is safe in tests because it guards on `typeof Zotero`).
// This wrapper keeps call-sites consistent and easy to grep.
function getStore(): any {
    return store;
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
    if (!isDiffPreviewLive()) return;
    const store = getStore();
    const noteKey = makeNoteKey(libraryId, zoteroKey);
    const allApprovals: Map<string, any> = store.get(pendingApprovalsAtom);

    const edits: EditOperation[] = [];
    for (const [, pa] of allApprovals) {
        if (pa.actionType !== 'edit_note') continue;
        const paLib = pa.actionData?.library_id;
        const paKey = pa.actionData?.zotero_key;
        if (paLib == null || !paKey || makeNoteKey(paLib, paKey) !== noteKey) continue;
        const oldStr = pa.actionData?.old_string ?? '';
        const op = pa.actionData?.operation ?? 'str_replace';
        if (oldStr || op === 'rewrite') {
            edits.push({
                oldString: oldStr,
                newString: pa.actionData?.new_string ?? '',
                operation: op,
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

    if (!isNoteInSelectedTab(libraryId, zoteroKey)) return;

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

    // Capture the previewed note key BEFORE dismissing (dismiss clears activePreview)
    const previewKey = getPreviewNoteKey();

    // Dismiss the preview immediately
    dismissDiffPreview();
    store.set(diffPreviewNoteKeyAtom, null);

    // Collect matching edit_note action IDs, send responses, then batch-remove
    // from the map in one update.  Using removePendingApprovalAtom per item
    // would trigger updateDiffPreviewForNote on each removal, which re-shows
    // the preview for the remaining (already-handled) edits.
    const allApprovals: Map<string, any> = store.get(pendingApprovalsAtom);
    const editNoteIds: string[] = [];
    for (const [, pa] of allApprovals) {
        if (pa.actionType !== 'edit_note') continue;
        // Only act on approvals for the previewed note
        if (previewKey) {
            const paLib = pa.actionData?.library_id;
            const paKey = pa.actionData?.zotero_key;
            if (paLib !== previewKey.libraryId || paKey !== previewKey.zoteroKey) continue;
        }
        store.set(sendApprovalResponseAtom, { actionId: pa.actionId, approved });
        editNoteIds.push(pa.actionId);
    }
    if (editNoteIds.length > 0) {
        store.set(pendingApprovalsAtom, (prev: Map<string, any>) => {
            const next = new Map(prev);
            for (const id of editNoteIds) next.delete(id);
            return next;
        });
    }
    logger(`diffPreviewCoordinator: banner ${action} — ${editNoteIds.length} edit(s)`, 1);
}

// Register the banner handler at module load
setOnBannerAction(handleBannerAction);

// Register dismiss handler so the atom is cleared when the preview is
// auto-dismissed (e.g., editor tab closed, sidebar closed).
setOnDismiss(() => {
    getStore().set(diffPreviewNoteKeyAtom, null);
});
