import { logger } from '@beaver/agent-core/platform/logger';
import { containsPreviewMarkers } from '../utils/notePreviewGuard';
import { getSystemTimers } from '../utils/systemTimers';

export function restorePreviewEditor(inst: any, wasSavingDisabled: boolean, itemId: number): Promise<void> {
    const { setTimeout, clearTimeout } = getSystemTimers();
    try {
        const item = Zotero.Items.get(itemId);
        if (item) {
            inst.applyIncrementalUpdate({ html: item.getNote() }, false);
        }

        // Wait for the iframe to confirm it processed the restore.
        // applyExternalChanges marks the ProseMirror transaction with
        // system=true, which posts an 'update' message back.  Listening
        // for that message guarantees ProseMirror holds the clean HTML
        // before saving resumes — unlike a fixed timeout.
        const teardown = new Promise<void>((resolve) => {
            let settled = false;
            let quietTimer: ReturnType<typeof setTimeout> | null = null;
            let fallbackTimer: ReturnType<typeof setTimeout> | null = null;
            const QUIET_DURATION_MS = 50;
            const cleanup = () => {
                if (quietTimer) clearTimeout(quietTimer);
                if (fallbackTimer) clearTimeout(fallbackTimer);
                try { inst._iframeWindow?.removeEventListener('message', onIframeMsg); } catch { /* ignore */ }
            };
            const restoreSaving = () => {
                if (settled) return;
                settled = true;
                cleanup();
                restoreSavingGuarded(inst, wasSavingDisabled);
                resolve();
            };
            // The iframe could not apply the restore, so its document still
            // holds the diff HTML
            const deferToEditorReinit = () => {
                if (settled) return;
                settled = true;
                cleanup();
                logger('dismissDiffPreview: incremental restore failed; deferring to the editor reinit', 1);
                const tabID = inst.tabID;
                setTimeout(() => {
                    try {
                        // Zotero's reinit drops the tab association; restore
                        // it so tab-based preview gating keeps working.
                        if (tabID && !inst._tabID) inst._tabID = tabID;
                        if (inst._disableSaving && isEditorInstanceUsable(inst)) {
                            const html = readLiveEditorHtml(inst);
                            if (html !== null && !containsPreviewMarkers(html)) {
                                inst._disableSaving = wasSavingDisabled;
                            }
                        }
                    } catch { /* ignore */ }
                }, 3000);
                resolve();
            };
            const scheduleQuietRestore = () => {
                if (quietTimer) clearTimeout(quietTimer);
                quietTimer = setTimeout(restoreSaving, QUIET_DURATION_MS);
            };
            const onIframeMsg = (e: any) => {
                try {
                    if (e.data?.instanceID !== inst.instanceID) return;
                    const action = e.data?.message?.action;
                    if (action === 'update' && e.data?.message?.system) {
                        scheduleQuietRestore();
                    } else if (action === 'incrementalUpdateFailed') {
                        deferToEditorReinit();
                    }
                } catch { /* ignore */ }
            };
            try { inst._iframeWindow.addEventListener('message', onIframeMsg); } catch { /* ignore */ }
            // Fallback: run the guarded restore after 1.5s even if no
            // 'update' arrives (e.g., iframe destroyed or update silently
            // dropped).
            fallbackTimer = setTimeout(restoreSaving, 1500);
        });
        return teardown;
    } catch { restoreSavingGuarded(inst, wasSavingDisabled); return Promise.resolve(); }
}

function readLiveEditorHtml(inst: any): string | null {
    try {
        const noteData = inst._iframeWindow?.wrappedJSObject?.getDataSync(false);
        return typeof noteData?.html === 'string' ? noteData.html : null;
    } catch { return null; }
}

/**
 * Re-enable an editor instance's save path after a preview teardown, but
 * only if its document no longer shows the diff markup. If the diff is
 * still present (the restore never landed), re-enabling saves would let the
 * editor's next autosave persist the presentation-only markup into the note
 * — permanent corruption, since the preview guard then refuses every
 * subsequent save. Instead, reinitialize the editor from the item's saved
 * note: reinit() resets _disableSaving itself, and saveSync() inside
 * uninit() is a no-op while saving is still disabled.
 */
function restoreSavingGuarded(inst: any, wasSavingDisabled: boolean): void {
    const liveHtml = readLiveEditorHtml(inst);
    if (liveHtml !== null && containsPreviewMarkers(liveHtml)) {
        logger('dismissDiffPreview: editor still shows diff markup; reinitializing editor from saved note', 1);
        reinitEditorInstance(inst);
        return;
    }
    try { inst._disableSaving = wasSavingDisabled; } catch { /* ignore */ }
}

/**
 * Reinitialize an editor instance, preserving its tab association.
 * Zotero's reinit() rebuilds init options without tabID, so a plain reinit
 * permanently breaks tab-based gating (isNoteInSelectedTab and therefore
 * the automatic preview) for that editor until the tab is reopened.
 */
function reinitEditorInstance(inst: any): void {
    const tabID = inst.tabID;
    const restoreTabId = () => {
        try { if (tabID && !inst._tabID) inst._tabID = tabID; } catch { /* ignore */ }
    };
    try {
        const p = inst.reinit();
        if (p?.then) {
            p.then(restoreTabId, (e: any) => {
                restoreTabId();
                logger(`dismissDiffPreview: reinit failed: ${e?.message}`, 1);
            });
        } else {
            restoreTabId();
        }
    } catch (e: any) {
        // Leave saving disabled — a stuck editor (recovered by reopening
        // the note) is preferable to persisting the diff markup.
        logger(`dismissDiffPreview: reinit threw: ${e?.message}`, 1);
    }
}

function isEditorInstanceUsable(inst: any): boolean {
    try {
        if (!inst?._iframeWindow) return false;
        if (typeof inst.applyIncrementalUpdate !== 'function') return false;
        const wrappedJS = inst._iframeWindow.wrappedJSObject;
        return !!wrappedJS?._currentEditorInstance?._editorCore?.view?.dom;
    } catch { return false; }
}
