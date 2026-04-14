/**
 * Live-editor I/O for Zotero notes.
 *
 * These helpers all touch Zotero's in-memory note editor instances:
 *   - `getLatestNoteHtml`          read the latest (possibly unsaved) HTML
 *   - `isNoteInEditor`             is a note currently open?
 *   - `flushLiveEditorToDB`        promote unsaved editor state into the DB
 *   - `waitForNoteSaveStabilization` wait for PM's save-back to settle
 *   - `waitForPMNormalization`     wait + refresh undo data after PM normalizes
 *
 * Split out of `noteHtmlSimplifier.ts` so pure HTML/string utilities can be
 * tested without stubbing live-editor globals.
 */

import { logger } from './logger';
import { stripDataCitationItems } from './noteWrapper';
import { decodeHtmlEntities } from './noteHtmlEntities';
import { findRangeByContexts } from './editNoteRawPosition';

// =============================================================================
// Reading the note
// =============================================================================

/**
 * Get the latest note HTML, reading from any open editor to capture
 * unsaved changes. Falls back to item.getNote() if the note is not
 * open or if reading from the editor fails.
 */
export function getLatestNoteHtml(item: any): string {
    const savedHtml = item.getNote();
    try {
        const instances = (Zotero as any).Notes._editorInstances;
        if (!Array.isArray(instances)) return savedHtml;

        const candidates: Array<{
            instance: any;
            html: string;
            source: string;
        }> = [];

        for (const instance of instances) {
            if (!instance._item || instance._item.id !== item.id) continue;
            // Skip instances where saving is disabled (e.g., during diff
            // preview) — their content is not authoritative.
            if (instance._disableSaving) continue;
            try {
                const frameElement = instance._iframeWindow?.frameElement;
                if (frameElement?.isConnected !== true) continue;
                let noteData = instance._iframeWindow.wrappedJSObject.getDataSync(true);
                if (noteData) {
                    // Clone out of XPCOM sandbox wrapper
                    noteData = JSON.parse(JSON.stringify(noteData));
                }
                if (typeof noteData?.html === 'string') {
                    candidates.push({
                        instance,
                        html: noteData.html,
                        source: instance.tabID
                            ? `tab:${instance.tabID}`
                            : (instance.viewMode ?? 'unknown'),
                    });
                }
            } catch {
                continue;
            }
        }

        if (candidates.length === 0) return savedHtml;
        if (candidates.length === 1) return candidates[0].html;

        const selectedTabId = Zotero.getMainWindow?.()?.Zotero_Tabs?.selectedID;
        const preferred = candidates.find((candidate) => (
            selectedTabId
            && candidate.instance.tabID
            && candidate.instance.tabID === selectedTabId
        )) ?? candidates.find((candidate) => candidate.instance.viewMode === 'tab')
            ?? candidates.find((candidate) => candidate.html === savedHtml)
            ?? candidates[0];

        const distinctSnapshots = new Set(candidates.map((candidate) => candidate.html)).size;
        if (distinctSnapshots > 1) {
            logger(
                `getLatestNoteHtml: found ${candidates.length} live editor instances for item ${item.id} `
                + `with ${distinctSnapshots} distinct HTML snapshots; preferring ${preferred.source}`,
                1,
            );
        }

        return preferred.html;
    } catch {
        // Fall through
    }
    return savedHtml;
}

/**
 * Check if a note is currently open in the Zotero editor.
 *
 * Zotero's `_editorInstances` array can contain stale entries: when a note tab
 * is closed, `disconnectedCallback` → `destroy()` runs but never calls
 * `EditorInstance.uninit()`, so the instance stays in the array. We guard
 * against this by also checking that the editor's iframe is still connected
 * to the DOM.
 */
export function isNoteInEditor(itemId: number): boolean {
    try {
        return (Zotero as any).Notes._editorInstances.some(
            (instance: any) => {
                if (!instance._item || instance._item.id !== itemId) return false;
                // Verify the editor is still alive (iframe attached to the DOM)
                try {
                    const frameElement = instance._iframeWindow?.frameElement;
                    return frameElement?.isConnected === true;
                } catch {
                    return false;
                }
            }
        );
    } catch {
        return false;
    }
}

// =============================================================================
// ProseMirror Normalization Refresh
// =============================================================================

const PM_REFRESH_INTERVAL_MS = 150;
const PM_REFRESH_MAX_WAIT_MS = 2000;
// After this many polls with no change, assume PM produced identical output and stop.
// 3 polls × 150ms = 450ms — enough headroom for editors to process Notifier events.
const PM_REFRESH_EARLY_EXIT_POLLS = 3;
const PM_UNDO_CONTEXT_LENGTH = 200;

/**
 * Wait for ProseMirror to normalize the note and update undo data in-place.
 *
 * When a note is open in the editor (or in a loaded tab), ProseMirror
 * re-normalizes the HTML after `item.saveTx()` via a Notifier event. This
 * makes the stored `undo_new_html` stale. This function polls `item.getNote()`
 * until the HTML changes (PM processed it) or a timeout elapses, then extracts
 * the actual PM-normalized fragment using context anchors and updates the
 * undoData object in-place before it is returned to the caller.
 *
 * @param preEditStrippedHtml - The stripped HTML before the edit was applied.
 *   When provided, polls where PM still shows this pre-edit state are treated
 *   as "PM hasn't processed the save yet" and do NOT count toward the
 *   early-exit threshold. This prevents a subsequent serialized edit from
 *   reading stale HTML from PM's editor state.
 */
export async function waitForPMNormalization(
    item: any,
    savedStrippedHtml: string,
    undoData: { undo_new_html?: string; undo_before_context?: string; undo_after_context?: string },
    preEditStrippedHtml?: string,
): Promise<void> {
    // Skip only when undo_new_html is truly absent (undefined/null).
    // Empty string ("") is valid — it means a deletion, and we still need
    // to refresh the before/after context anchors after PM normalization.
    if (undoData.undo_new_html == null) return;

    // Only refresh edits that have context anchors.
    // Note: empty string ("") is a valid context (edit at start/end of note),
    // so we check for undefined, not falsy.
    const beforeCtx = undoData.undo_before_context;
    const afterCtx = undoData.undo_after_context;
    if (beforeCtx === undefined && afterCtx === undefined) return;

    let unchangedPolls = 0;

    // Poll until PM changes the HTML or we time out
    for (let elapsed = 0; elapsed < PM_REFRESH_MAX_WAIT_MS; elapsed += PM_REFRESH_INTERVAL_MS) {
        await new Promise(resolve => setTimeout(resolve, PM_REFRESH_INTERVAL_MS));

        try {
            const currentHtml = getLatestNoteHtml(item);
            const currentStripped = stripDataCitationItems(currentHtml);

            // If PM still shows the pre-edit HTML, it hasn't processed the
            // save yet.  Keep waiting — do NOT count toward early-exit.
            if (preEditStrippedHtml && currentStripped === preEditStrippedHtml) {
                continue;
            }

            // If HTML still matches what we saved, PM either hasn't processed
            // yet or produced identical output (common for plain-text edits).
            if (currentStripped === savedStrippedHtml) {
                unchangedPolls++;
                if (unchangedPolls >= PM_REFRESH_EARLY_EXIT_POLLS) return;
                continue;
            }

            // HTML changed — PM has normalized. Extract the actual fragment.
            // PM may decode HTML entities (e.g. &#x27; → '), so if anchors
            // don't match, retry with entity-decoded anchors.
            //
            // Pass expectedLength so that when beforeCtx matches non-uniquely
            // (e.g. repeating citation-span suffixes in a list), we pick the
            // (beforeCtx, afterCtx) pair whose range is closest to the original
            // fragment length, rather than always picking the first match which
            // can span many unrelated elements.
            const originalLength = undoData.undo_new_html.length;
            let range = findRangeByContexts(currentStripped, beforeCtx, afterCtx, originalLength);
            if (!range) {
                const decodedBefore = beforeCtx != null ? decodeHtmlEntities(beforeCtx) : undefined;
                const decodedAfter = afterCtx != null ? decodeHtmlEntities(afterCtx) : undefined;
                range = findRangeByContexts(currentStripped, decodedBefore, decodedAfter, originalLength);
            }
            if (!range) {
                logger('waitForPMNormalization: context anchors not found in PM-normalized HTML, skipping refresh', 1);
                return;
            }

            const actualFragment = currentStripped.substring(range.start, range.end);

            // Refresh contexts from the PM-normalized HTML
            const newBeforeCtx = currentStripped.substring(
                Math.max(0, range.start - PM_UNDO_CONTEXT_LENGTH), range.start
            );
            const newAfterCtx = currentStripped.substring(
                range.end, range.end + PM_UNDO_CONTEXT_LENGTH
            );

            // Skip update if nothing actually changed (fragment AND contexts)
            if (
                actualFragment === undoData.undo_new_html
                && newBeforeCtx === undoData.undo_before_context
                && newAfterCtx === undoData.undo_after_context
            ) {
                return;
            }

            // Sanity check: PM normalization changes markup slightly (entities,
            // whitespace, wrappers) but never dramatically alters fragment size.
            // If the refreshed range is much larger than the original, the
            // context anchors were still ambiguous despite the expectedLength
            // hint — bail out and keep the original undo data rather than risk
            // overwriting it with a huge chunk that would cause undo to delete
            // unrelated content.
            const actualLength = actualFragment.length;
            const lengthDelta = actualLength - originalLength;
            if (lengthDelta > 200 && actualLength > originalLength * 2) {
                logger(
                    `waitForPMNormalization: refreshed fragment (${actualLength} chars) much larger `
                    + `than original (${originalLength} chars); keeping original undo data`,
                    1,
                );
                return;
            }

            // Update in-place with PM-normalized data
            undoData.undo_new_html = actualFragment;
            undoData.undo_before_context = newBeforeCtx;
            undoData.undo_after_context = newAfterCtx;

            logger('waitForPMNormalization: updated undo data after PM normalization', 1);
            return;
        } catch (e: any) {
            logger(`waitForPMNormalization: error during poll: ${e?.message || e}`, 1);
            return;
        }
    }
    // Timeout — PM didn't change anything, keep original undo data
}

// =============================================================================
// Post-save stabilization
// =============================================================================

/** Polling interval for stabilization check (ms). */
const STABILIZE_POLL_MS = 50;
/** Number of consecutive unchanged polls before we consider the note stable. */
const STABILIZE_THRESHOLD = 3;
/** Maximum time to wait for stabilization (ms). */
const STABILIZE_MAX_WAIT_MS = 1500;

/**
 * Wait for `item.getNote()` to stop changing after a `saveTx()`.
 *
 * When a note is open in Zotero's editor, `saveTx()` fires a Notifier event.
 * ProseMirror receives it, normalizes the HTML (entity decoding, structural
 * cleanup), and asynchronously saves back the normalized version via
 * `item.setNote()` + `item.saveTx()`.  If another edit saves before this
 * save-back completes, PM's save-back overwrites the second edit.
 *
 * This function polls `item.getNote()` until the value hasn't changed for
 * `STABILIZE_THRESHOLD` consecutive polls (~150 ms of stability), ensuring
 * PM's save-back is complete before the next edit reads the note.
 */
export async function waitForNoteSaveStabilization(
    item: any,
    savedHtml: string,
): Promise<void> {
    let lastHtml = savedHtml;
    let stableCount = 0;

    for (let elapsed = 0; elapsed < STABILIZE_MAX_WAIT_MS; elapsed += STABILIZE_POLL_MS) {
        await new Promise(resolve => setTimeout(resolve, STABILIZE_POLL_MS));

        const currentHtml: string = item.getNote();
        if (currentHtml === lastHtml) {
            stableCount++;
            if (stableCount >= STABILIZE_THRESHOLD) {
                if (currentHtml !== savedHtml) {
                    logger(`waitForNoteSaveStabilization: note was rewritten by editor `
                        + `(saved len=${savedHtml.length}, stabilized len=${currentHtml.length})`, 1);
                }
                return;
            }
        } else {
            logger(`waitForNoteSaveStabilization: note changed at ${elapsed}ms `
                + `(len ${lastHtml.length} → ${currentHtml.length})`, 1);
            lastHtml = currentHtml;
            stableCount = 0;
        }
    }
    logger(`waitForNoteSaveStabilization: timeout after ${STABILIZE_MAX_WAIT_MS}ms, proceeding`, 1);
}

// =============================================================================
// Pre-read flush
// =============================================================================

/**
 * Promote unsaved content from an open note editor into the DB so that
 * subsequent `item.getNote()` reads see the same HTML the user is looking at.
 *
 * Without this, validation (which reads via `getLatestNoteHtml` and therefore
 * captures unsaved manual typing) and execution (which reads `item.getNote()`)
 * can operate on different HTML. In rewrite mode that asymmetry silently
 * discards the user's in-flight edits; in str_replace mode it causes
 * `no_match` failures and stale simplifier metadata.
 *
 * Returns true when a flush actually ran.
 */
export async function flushLiveEditorToDB(item: any): Promise<boolean> {
    let latest: string;
    try {
        latest = getLatestNoteHtml(item);
    } catch (e: any) {
        logger(`flushLiveEditorToDB: getLatestNoteHtml threw: ${e?.message || e}`, 1);
        return false;
    }

    const saved: string = item.getNote();
    if (latest === saved) return false;

    try {
        item.setNote(latest);
        await item.saveTx();
    } catch (e: any) {
        logger(`flushLiveEditorToDB: save failed: ${e?.message || e}`, 1);
        return false;
    }

    await waitForNoteSaveStabilization(item, latest);
    return true;
}
