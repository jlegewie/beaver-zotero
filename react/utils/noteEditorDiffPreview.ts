/**
 * Note Editor Diff Preview — Pure preview module
 *
 * Shows edit_note diffs directly in the Zotero note editor by temporarily
 * injecting styled HTML (red/strikethrough for deletions, green for additions)
 * without persisting the changes to the note.
 *
 * This module is purely about editor manipulation — it has no knowledge of
 * approvals, atoms, or React. Coordination with the approval system is handled
 * by diffPreviewCoordinator.ts.
 *
 * Safety:
 * - Uses EditorInstance._disableSaving to block all save paths
 * - Sets contentEditable=false to prevent user edits during preview
 * - Injects CSS to dim toolbar and signal preview mode
 * - Restores original HTML and state on dismiss
 * - Banner Apply re-renders instead of applying when the note's stored
 *   content changed since the preview rendered (revision guard). Best-effort:
 *   the check and the eventual execution are not atomic, and the guard fails
 *   open on read errors — execute's fail-closed re-resolution remains the
 *   hard backstop.
 */

import { logger } from '../../src/utils/logger';
import type { EditNoteOperation } from '../types/agentActions/editNote';
import {
    getOrSimplify,
    normalizeNoteHtml,
} from '../../src/utils/noteHtmlSimplifier';
import {
    expandToRawHtml,
    preloadPageLabelsForNewCitations,
    preloadNotePageLabels,
    type ExternalRefContext,
} from '../../src/utils/noteCitationExpand';
import type { PageLabelsByAttachmentId } from '../atoms/citations';
import { getLatestNoteHtml } from '../../src/utils/noteEditorIO';
import {
    stripDataCitationItems,
    extractDataCitationItems,
    rebuildDataCitationItems,
} from '../../src/utils/noteWrapper';
import {
    decodeHtmlEntities,
    encodeTextEntities,
    ENTITY_FORMS,
} from '../../src/utils/noteHtmlEntities';
import { getBeaverFooterAppendPoint } from '../../src/utils/noteEditFooter';
import { containsPreviewMarkers } from '../../src/utils/notePreviewGuard';
import { findTargetRawMatchPosition } from '../../src/utils/editNoteRawPosition';
import { store } from '../store';
import {
    externalReferenceMappingAtom,
    externalReferenceItemMappingAtom,
} from '../atoms/externalReferences';

/**
 * Snapshot the thread's external-reference state from the Jotai store so
 * `expandToRawHtml('new', ...)` can resolve `<citation external_id="..."/>`
 * to either an in-library Zotero item or an inline `<a>` link.
 */
function getExternalRefContext(): ExternalRefContext {
    return {
        externalRefs: store.get(externalReferenceMappingAtom),
        externalItemMapping: store.get(externalReferenceItemMappingAtom),
    };
}

// =============================================================================
// Constants
// =============================================================================

const DEL_RGB = '210,40,40';
const ADD_RGB = '16,150,72';
/** Browser-normalized rgba strings (spaces after commas) for DOM queries */
const DEL_RGB_SPACED = '210, 40, 40';
const ADD_RGB_SPACED = '16, 150, 72';
const DEL_STYLE = `background-color:rgba(${DEL_RGB},0.28);text-decoration:line-through;border-radius:2px;padding:0 1px`;
const ADD_STYLE = `background-color:rgba(${ADD_RGB},0.28);border-radius:2px;padding:0 1px`;
const PREVIEW_STYLE_ID = 'beaver-diff-preview-style';
const PREVIEW_BANNER_ID = 'beaver-preview-banner';
/** Property set on iframe window by banner button clicks, polled by the timer. */
const ACTION_PROP = '__beaverPreviewAction';

const PREVIEW_CSS = `
.ProseMirror { cursor: default !important; caret-color: transparent !important; user-select: none !important; }
.toolbar { opacity: 0.35; pointer-events: none; }
.beaver-preview-banner {
    position: sticky; top: 0; z-index: 100; display: flex; align-items: center; gap: 8px;
    background: rgba(16,150,72,0.32); border-bottom: 1px solid rgba(16,150,72,0.45);
    padding: 8px 11px; min-height: 40px; box-sizing: border-box; font-size: 13px; color: #1a7f37; font-weight: 500; letter-spacing: 0.01em;
}
.beaver-preview-banner .banner-title { flex: 1; text-align: left; font-size: 15px; }
.beaver-preview-banner button {
    border: none; border-radius: 4px; padding: 3px 10px; font-size: 12px;
    font-weight: 500; cursor: pointer; line-height: 1.4;
}
.beaver-preview-banner .btn-close { background: transparent; color: #1a7f37; font-size: 16px; padding: 2px 6px; line-height: 1; }
.beaver-preview-banner .btn-close:hover { background: rgba(0,0,0,0.06); }
.beaver-preview-banner .btn-reject { background: rgba(210,40,40,0.10); color: #cf222e; }
.beaver-preview-banner .btn-reject:hover { background: rgba(210,40,40,0.18); }
.beaver-preview-banner .btn-approve { background: rgba(16,150,72,0.15); color: #1a7f37; }
.beaver-preview-banner .btn-approve:hover { background: rgba(16,150,72,0.25); }
@media (prefers-color-scheme: dark) {
    .beaver-preview-banner { background: rgba(16,150,72,0.18); color: #3fb950; border-bottom-color: rgba(16,150,72,0.6); }
    .beaver-preview-banner .btn-close { color: #3fb950; }
    .beaver-preview-banner .btn-close:hover { background: rgba(255,255,255,0.08); }
    .beaver-preview-banner .btn-reject { background: rgba(248,81,73,0.12); color: #f85149; }
    .beaver-preview-banner .btn-reject:hover { background: rgba(248,81,73,0.22); }
    .beaver-preview-banner .btn-approve { background: rgba(16,150,72,0.18); color: #3fb950; }
    .beaver-preview-banner .btn-approve:hover { background: rgba(16,150,72,0.28); }
}
`;

// =============================================================================
// Types & Singleton State
// =============================================================================

export interface EditOperation {
    oldString: string;
    newString: string;
    operation?: EditNoteOperation;
    /** Validation-captured raw context anchoring a repeated oldString target. */
    targetBeforeContext?: string;
    targetAfterContext?: string;
}

export interface DiffPreviewOptions {
    /**
     * Per-preview action handler. When set, banner Approve/Reject buttons
     * call this instead of the global onBannerAction (coordinator).
     * Used by the edit-note views (via useEditNoteActions) for post-run
     * previews — note edits never render through the generic
     * AgentActionView, so cleanup hooks for these previews belong in the
     * edit-note components only.
     */
    onAction?: (action: 'approve' | 'reject') => void;
}

interface DiffPreviewState {
    itemId: number;
    libraryId: number;
    zoteroKey: string;
    editorInstance: any;
    wasSavingDisabled: boolean;
    pollTimer: ReturnType<typeof setInterval> | null;
    editsHash: string;
    onAction: ((action: 'approve' | 'reject') => void) | null;
    /**
     * Hash of the note HTML the preview was rendered from. Best-effort
     * revision guard: if the stored note changes between render and the
     * banner's Apply click (sync, another window), the preview re-renders
     * instead of applying, keeping the authorization aligned with what the
     * user saw. Not atomic with execution — see the approveAll guard in the
     * poll timer.
     */
    contentHash: string;
    /** Inputs kept for re-rendering the preview after a drift bounce. */
    edits: EditOperation[];
    showOptions?: DiffPreviewOptions;
}

let activePreview: DiffPreviewState | null = null;

/**
 * The most recent dismissal's still-running editor-restore work.
 * `dismissDiffPreview()` clears `activePreview` synchronously, but the
 * restore can take up to 1.5 s — any dismissal call landing in that window
 * (e.g. an execute handler canceling a pending re-render before mutating
 * the note) must wait for it, or the in-flight restore could overwrite the
 * newly written editor state with older HTML.
 */
let activeTeardown: Promise<void> | null = null;

/**
 * Marker for a showDiffPreview call whose async setup is still running (the
 * preview is not yet active). Lets callers abort an in-flight show.
 */
let pendingShow: { key: string } | null = null;

/**
 * Generation counter: incremented on every show/dismiss to abort stale async calls.
 */
let generation = 0;

/**
 * Callback invoked when a banner button is clicked (close/approveAll/rejectAll).
 * Set by the coordinator via setOnBannerAction.
 */
let onBannerAction: ((action: string) => void) | null = null;

/**
 * Callback invoked whenever the preview is dismissed (for any reason: banner close,
 * editor unavailable, explicit dismissDiffPreview call, etc.).
 * Set by the coordinator via setOnDismiss to clear diffPreviewNoteKeyAtom.
 */
let onDismiss: (() => void) | null = null;

// =============================================================================
// Zotero Internal API Checks
// =============================================================================

function areEditorApisAvailable(): boolean {
    try {
        return Array.isArray((Zotero as any).Notes?._editorInstances);
    } catch { return false; }
}

function isEditorInstanceUsable(inst: any): boolean {
    try {
        if (!inst?._iframeWindow) return false;
        if (typeof inst.applyIncrementalUpdate !== 'function') return false;
        const wrappedJS = inst._iframeWindow.wrappedJSObject;
        return !!wrappedJS?._currentEditorInstance?._editorCore?.view?.dom;
    } catch { return false; }
}

/**
 * Runtime capability gate for the in-editor diff preview.
 *
 * The preview relies on `Zotero.Notes.open()` to open notes as tabs, which
 * was introduced in Zotero 8.0. On Zotero 7 this method is absent and the
 * feature cannot work — callers should hide any UI that exposes it and
 * avoid triggering the coordinator's automatic preview. The per-instance
 * `EditorInstance.applyIncrementalUpdate()` requirement is checked later by
 * `isEditorInstanceUsable()` when an editor instance actually exists.
 *
 * This is a feature detection rather than a version check, and it is
 * independent from the user-facing `showDiffPreviewInNoteEditor` pref
 * checked by `isDiffPreviewLive()` in diffPreviewCoordinator.ts. The
 * preview is considered live only when BOTH are true.
 */
export function isDiffPreviewSupported(): boolean {
    try {
        // Zotero 8.0+ gate: note-as-tab API.
        if (typeof (Zotero as any).Notes?.open !== 'function') return false;
        // Defensive structural check: ensure the internal editor-instance
        // registry we read from later is the expected shape.
        if (!Array.isArray((Zotero as any).Notes?._editorInstances)) return false;
        return true;
    } catch { return false; }
}

// =============================================================================
// Public API
// =============================================================================

export function isNoteOpenInEditor(libraryId: number, zoteroKey: string): boolean {
    if (!areEditorApisAvailable()) return false;
    const itemId = Zotero.Items.getIDFromLibraryAndKey(libraryId, zoteroKey);
    if (!itemId) return false;
    return findEditorInstance(itemId) !== null;
}

/**
 * Returns true only if the note is open in an editor AND its tab is the
 * currently selected tab.  Use this when you want to gate on visibility
 * (e.g. the automatic diff-preview), as opposed to mere existence of an
 * editor instance.
 */
export function isNoteInSelectedTab(libraryId: number, zoteroKey: string): boolean {
    if (!areEditorApisAvailable()) return false;
    const itemId = Zotero.Items.getIDFromLibraryAndKey(libraryId, zoteroKey);
    if (!itemId) return false;
    const inst = findEditorInstance(itemId);
    if (!inst) return false;
    const win = Zotero.getMainWindow();
    const selectedTabId = win?.Zotero_Tabs?.selectedID;
    if (!selectedTabId) return false;
    return inst.tabID === selectedTabId;
}

/**
 * Register a callback for banner button actions ('close', 'approveAll', 'rejectAll').
 * Called by the coordinator to wire banner buttons to approval logic.
 */
export function setOnBannerAction(handler: ((action: string) => void) | null): void {
    onBannerAction = handler;
}

/**
 * Register a callback invoked whenever the preview is dismissed.
 * Called by the coordinator to clear diffPreviewNoteKeyAtom when the preview
 * is auto-dismissed (e.g., editor tab closed, sidebar closed).
 */
export function setOnDismiss(handler: (() => void) | null): void {
    onDismiss = handler;
}

/**
 * Show diff preview in the note editor for one or more edits.
 * Returns true if preview was shown, false if fallback to sidebar is needed.
 */
export async function showDiffPreview(
    libraryId: number,
    zoteroKey: string,
    edits: EditOperation[],
    options?: DiffPreviewOptions,
): Promise<boolean> {
    const noteKey = `${libraryId}-${zoteroKey}`;
    let myPendingShow: { key: string } | null = null;
    try {
        if (edits.length === 0) {
            logger(`showDiffPreview: aborting for ${noteKey}, edits array is empty`, 1);
            return false;
        }

        if (!isDiffPreviewSupported()) {
            logger(`showDiffPreview: aborting for ${noteKey}, required Zotero APIs unavailable (Zotero 7 or older)`, 1);
            return false;
        }

        const hash = computeEditsHash(edits);

        // Dedup: if already showing the same preview, just scroll to
        // the first diff so it's visible (the user may have scrolled away)
        if (activePreview
            && activePreview.libraryId === libraryId
            && activePreview.zoteroKey === zoteroKey
            && activePreview.editsHash === hash
        ) {
            logger(`showDiffPreview: dedup hit for ${noteKey}, scrolling to existing preview`, 1);
            scrollToDiff(activePreview.editorInstance);
            return true;
        }

        // Mark this show as in flight so callers can abort it (see
        // pendingShow). Cleared in the finally block below.
        myPendingShow = { key: noteKey };
        pendingShow = myPendingShow;

        // Dismiss any existing preview
        const dismissal = dismissDiffPreview();
        const genAfterOwnDismiss = generation;
        await dismissal;
        if (generation !== genAfterOwnDismiss) {
            logger(`showDiffPreview: aborting for ${noteKey}, dismissed while awaiting prior teardown`, 1);
            return false;
        }
        const myGeneration = ++generation;

        if (!areEditorApisAvailable()) {
            logger(`showDiffPreview: aborting for ${noteKey}, Zotero.Notes._editorInstances not available`, 1);
            return false;
        }

        const itemId = Zotero.Items.getIDFromLibraryAndKey(libraryId, zoteroKey);
        if (!itemId) {
            logger(`showDiffPreview: aborting for ${noteKey}, no itemId for libraryId=${libraryId} zoteroKey=${zoteroKey}`, 1);
            return false;
        }

        const inst = findEditorInstance(itemId);
        if (!inst) {
            logger(
                `showDiffPreview: aborting for ${noteKey}, no usable editor instance for itemId=${itemId} `
                + `(findEditorInstance returned null — note may not be open, or editor not yet initialized)`,
                1,
            );
            return false;
        }

        const item = await Zotero.Items.getAsync(itemId);
        if (myGeneration !== generation) {
            logger(`showDiffPreview: aborting for ${noteKey}, generation changed after Items.getAsync`, 1);
            return false;
        }
        if (!item) {
            logger(`showDiffPreview: aborting for ${noteKey}, Items.getAsync returned null for itemId=${itemId}`, 1);
            return false;
        }
        await item.loadDataType('note');
        if (myGeneration !== generation) {
            logger(`showDiffPreview: aborting for ${noteKey}, generation changed after loadDataType('note')`, 1);
            return false;
        }

        const rawHtml = getLatestNoteHtml(item);
        // Revision-guard baseline, captured NOW — before the awaited
        // page-label/expansion work — so a change landing during those awaits
        // reads as drift on the first Apply (hashing at activePreview
        // creation instead would stamp the NEWER content onto a preview
        // rendered from the OLDER snapshot, silently defeating the guard).
        //
        // Basis: the content everyone EXCEPT this preview editor sees —
        // stored content, or another editor's unsaved snapshot when one
        // exists. That mirrors the approve-time read (the frozen preview
        // editor is skipped via _disableSaving there) AND what execute's
        // flushLiveEditorToDB will promote to the DB before matching, so
        // another window's edits count as drift while this editor's own
        // unsaved state never does.
        const contentBaselineHash = hashPreviewContent(
            getLatestNoteHtml(item, { excludeInstance: inst }),
        );
        // Normalize through ProseMirror to match what simplifyNoteHtml exposes
        // to the model. Without this, entity encoding differences (e.g. the
        // note has `&#x27;` but the model wrote `'`) cause constructMultiDiffHtml's
        // indexOf to miss. Mirrors the match strategy in
        // src/services/agentDataProvider/actions/editNote.ts (lines 309, 914).
        const normalizedHtml = normalizeNoteHtml(rawHtml);
        const noteId = `${libraryId}-${zoteroKey}`;
        const pageLabelsByItemId = await preloadNotePageLabels(rawHtml, libraryId);
        const { metadata } = getOrSimplify(noteId, rawHtml, libraryId, pageLabelsByItemId);
        const externalRefContext = getExternalRefContext();

        // Resolve page labels for new-citation translation across every edit
        // up-front so the synchronous expansion below can translate 1-based
        // page numbers to display labels.
        const pageLabels: PageLabelsByAttachmentId = {};
        for (const edit of edits) {
            if (edit.newString) {
                Object.assign(pageLabels, await preloadPageLabelsForNewCitations(edit.newString));
            }
        }

        // Expand all edits
        const expandedEdits: PreviewExpandedEdit[] = [];
        for (const edit of edits) {
            const op = edit.operation ?? 'str_replace';
            try {
                if (op === 'rewrite' || op === 'append') {
                    const expandedNew = edit.newString ? expandToRawHtml(edit.newString, metadata, 'new', externalRefContext, pageLabels) : '';
                    expandedEdits.push({
                        expandedOld: '',
                        expandedNew,
                        operation: op,
                        targetBeforeContext: edit.targetBeforeContext,
                        targetAfterContext: edit.targetAfterContext,
                    });
                } else {
                    const expandedOld = edit.oldString ? expandToRawHtml(edit.oldString, metadata, 'old') : '';
                    // For insert_after / insert_before, new_string is already
                    // normalized by validation to merge old_string with
                    // new_string (via normalized_action_data):
                    //   - insert_after:  new_string = old_string + new_string
                    //   - insert_before: new_string = new_string + old_string
                    // so computeHtmlDiff will naturally show the anchor as
                    // context and the insertion as addition.
                    const expandedNew = edit.newString ? expandToRawHtml(edit.newString, metadata, 'new', externalRefContext, pageLabels) : '';
                    if (expandedOld) {
                        expandedEdits.push({
                            expandedOld,
                            expandedNew,
                            operation: op,
                            targetBeforeContext: edit.targetBeforeContext,
                            targetAfterContext: edit.targetAfterContext,
                        });
                    } else {
                        logger(
                            `showDiffPreview: dropping edit for ${noteKey} — expandedOld is empty `
                            + `(op=${op}, oldStringLen=${edit.oldString?.length ?? 0}, `
                            + `newStringLen=${edit.newString?.length ?? 0}) — `
                            + `expandToRawHtml could not locate old_string in the current note`,
                            1,
                        );
                    }
                }
            } catch (e: any) {
                logger(`showDiffPreview: expansion failed for one edit in ${noteKey}: ${e.message}`, 1);
            }
        }
        if (expandedEdits.length === 0) {
            logger(
                `showDiffPreview: aborting for ${noteKey}, no edits survived expansion `
                + `(attempted ${edits.length}) — check that old_string still matches current note content`,
                1,
            );
            return false;
        }
        if (myGeneration !== generation) {
            logger(`showDiffPreview: aborting for ${noteKey}, generation changed after expansion`, 1);
            return false;
        }

        const diffHtml = constructMultiDiffHtml(normalizedHtml, expandedEdits);
        if (!diffHtml) {
            logger(
                `showDiffPreview: aborting for ${noteKey}, constructMultiDiffHtml returned null — `
                + `expanded old_string not found via indexOf in the raw note HTML `
                + `(${expandedEdits.length} expanded edit(s) attempted)`,
                1,
            );
            return false;
        }

        // Disable saving
        const wasSavingDisabled = !!inst._disableSaving;
        inst._disableSaving = true;

        try {
            inst.applyIncrementalUpdate({ html: diffHtml }, false);
        } catch (e: any) {
            logger(`showDiffPreview: applyIncrementalUpdate threw for ${noteKey}: ${e.message}\n${e.stack ?? ''}`, 1);
            inst._disableSaving = wasSavingDisabled;
            return false;
        }

        // Freeze editor
        try {
            const view = getEditorView(inst);
            if (view?.dom) view.dom.contentEditable = 'false';
        } catch { /* best effort */ }
        injectPreviewStyles(inst._iframeWindow);
        injectPreviewBanner(inst._iframeWindow, edits.length > 1);
        clearIframeAction(inst._iframeWindow);

        activePreview = {
            itemId, libraryId, zoteroKey,
            editorInstance: inst, wasSavingDisabled,
            pollTimer: null, editsHash: hash,
            onAction: options?.onAction ?? null,
            // Stored-content baseline captured alongside the render snapshot
            // (see above), NOT rawHtml: rawHtml may be an unsaved live-editor
            // snapshot, and the approve-time comparison reads stored content.
            contentHash: contentBaselineHash,
            edits,
            showOptions: options,
        };

        // Poll for banner button clicks + editor liveness
        activePreview.pollTimer = setInterval(() => {
            if (!activePreview) return;
            const action = readIframeAction(activePreview.editorInstance._iframeWindow);
            if (action) {
                clearIframeAction(activePreview.editorInstance._iframeWindow);
                // Revision guard (best-effort): if the note's stored content
                // changed since the preview rendered (sync, another window —
                // the previewed editor itself is frozen), re-render the
                // preview against the current content instead of applying,
                // so the banner authorization stays aligned with what the
                // user saw. This check is NOT atomic with execution; the
                // hard backstop is execute's fail-closed re-resolution.
                // Reject/close stay unguarded: declining is always safe.
                if (action === 'approveAll' && noteContentDriftedFromPreview(
                    activePreview.itemId, activePreview.contentHash,
                )) {
                    logger('showDiffPreview: note content changed since the preview rendered; re-rendering instead of applying', 1);
                    const { libraryId: lib, zoteroKey: key, edits: stateEdits, showOptions } = activePreview;
                    // The re-render is deferred behind the dismissal. Register
                    // it as a pending show IMMEDIATELY and guard it with the
                    // generation token, so approval-resolution paths (the
                    // coordinator and the execute handlers gate on
                    // isDiffPreviewPendingFor → dismissDiffPreview, whose
                    // generation bump cancels us) can stop the continuation —
                    // otherwise it could resurrect a preview, with a stale
                    // action callback, after the approval was applied or
                    // rejected elsewhere.
                    const myBounce = { key: `${lib}-${key}` };
                    const dismissal = dismissDiffPreview();
                    pendingShow = myBounce;
                    const genAfterDismiss = generation;
                    dismissal.then(() => {
                        if (generation !== genAfterDismiss || pendingShow !== myBounce) {
                            if (pendingShow === myBounce) pendingShow = null;
                            return;
                        }
                        pendingShow = null;
                        void showDiffPreview(lib, key, stateEdits, showOptions);
                    });
                    return;
                }
                if (action === 'close') {
                    dismissDiffPreview();
                } else if (activePreview.onAction) {
                    // Local handler (e.g., post-run single-edit preview)
                    // Must await dismiss so the editor fully restores original
                    // content and re-enables saving before the handler applies
                    // the edit — otherwise the in-flight restore overwrites it.
                    const handler = activePreview.onAction;
                    const mappedAction: 'approve' | 'reject' = action === 'approveAll' ? 'approve' : 'reject';
                    dismissDiffPreview().then(() => handler(mappedAction));
                } else {
                    // Delegate to coordinator (approveAll, rejectAll)
                    onBannerAction?.(action);
                }
                return;
            }
            if (!isEditorInstanceUsable(activePreview.editorInstance)) {
                logger('showDiffPreview: editor became unavailable, auto-dismissing', 1);
                dismissDiffPreview();
            }
        }, 200);

        scrollToDiff(inst);
        logger(`showDiffPreview: preview active for ${noteId} (${expandedEdits.length} edit(s))`, 1);
        return true;
    } catch (e: any) {
        logger(`showDiffPreview: error for ${noteKey}: ${e.message}\n${e.stack ?? ''}`, 1);
        return false;
    } finally {
        if (pendingShow === myPendingShow) pendingShow = null;
    }
}

/**
 * True while a showDiffPreview call for this note is still in its async
 * setup phase (not yet active).
 */
export function isDiffPreviewPendingFor(libraryId: number, zoteroKey: string): boolean {
    return pendingShow?.key === `${libraryId}-${zoteroKey}`;
}

/**
 * True while ANY preview setup or deferred re-render is pending (not yet an
 * active preview). Resolution paths that dismiss "the active preview" must
 * treat a pending one the same way — calling dismissDiffPreview() bumps the
 * generation token, which cancels the pending work.
 */
export function isDiffPreviewPending(): boolean {
    return pendingShow !== null;
}

/**
 * Dismiss the preview: remove banner/styles, re-enable editing, and restore
 * the editor content from the item's current database state. No-op if no
 * preview active.
 *
 * Uses applyIncrementalUpdate (not reinit) so ProseMirror preserves the
 * scroll position.  reinit() would tear down and rebuild the entire editor,
 * which resets scroll to top, loses _tabID, and risks saving diff HTML via
 * uninit() → saveSync().
 *
 * NOTE: src/ui/ui.ts → removeChatPanel() duplicates this cleanup for the
 * case where the webpack bundle is unloaded before dismiss runs.  If the
 * cleanup steps change, update both locations.
 */
/**
 * Dismiss the preview and return a Promise that resolves once the editor's
 * `_disableSaving` flag has been restored (i.e., the editor is fully usable
 * again). Callers that need to edit the same note immediately after should
 * `await` this to avoid racing with the iframe restore.
 *
 * For callers that don't need to wait (fire-and-forget), the returned
 * promise can simply be ignored — the function still works synchronously
 * for cleanup purposes.
 */
export function dismissDiffPreview(): Promise<void> {
    generation++;
    // No active preview: still hand back any outstanding teardown so callers
    // that proceed to edit the note serialize behind the in-flight restore.
    if (!activePreview) return activeTeardown ?? Promise.resolve();

    const { editorInstance: inst, wasSavingDisabled, pollTimer, itemId } = activePreview;
    activePreview = null;

    if (pollTimer) clearInterval(pollTimer);

    // Notify coordinator so it can clear diffPreviewNoteKeyAtom
    onDismiss?.();

    try {
        if (!isEditorInstanceUsable(inst)) {
            try { inst._disableSaving = wasSavingDisabled; } catch { /* ignore */ }
            return Promise.resolve();
        }
        removePreviewBanner(inst._iframeWindow);
        removePreviewStyles(inst._iframeWindow);
        clearIframeAction(inst._iframeWindow);
        try {
            const view = getEditorView(inst);
            if (view?.dom) view.dom.contentEditable = 'true';
        } catch { /* best effort */ }

        // Restore content from the item's current database state via an
        // incremental update.  This preserves scroll position and avoids
        // the side-effects of reinit() (tabID loss, saveSync of diff HTML).
        //
        // Keep _disableSaving true until the iframe processes the update.
        // While _disableSaving is true, getLatestNoteHtml() skips this
        // instance and falls back to item.getNote(), ensuring the server
        // reads the correct DB content (not stale diff HTML) when
        // executing an approved edit.
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
        activeTeardown = teardown;
        teardown.then(() => {
            if (activeTeardown === teardown) activeTeardown = null;
        });
        return teardown;
    } catch (e: any) {
        logger(`dismissDiffPreview: error: ${e.message}`, 1);
        restoreSavingGuarded(inst, wasSavingDisabled);
        return Promise.resolve();
    }
}

/**
 * Read the current ProseMirror document HTML from an editor instance's
 * iframe, or null if it cannot be read.
 *
 * Must pass onlyChanged=false: getDataSync(true) returns null whenever the
 * editor's docChanged flag is unset, and applyExternalChanges clears that
 * flag — so after a preview apply or restore the true-variant reports
 * nothing and a marker check against it would silently pass.
 */
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

export function isDiffPreviewActive(libraryId?: number, zoteroKey?: string): boolean {
    if (!activePreview) return false;
    if (libraryId != null && zoteroKey) {
        return activePreview.libraryId === libraryId && activePreview.zoteroKey === zoteroKey;
    }
    return true;
}

/**
 * Return the libraryId-zoteroKey of the note currently being previewed, or null.
 */
export function getPreviewNoteKey(): { libraryId: number; zoteroKey: string } | null {
    if (!activePreview) return null;
    return { libraryId: activePreview.libraryId, zoteroKey: activePreview.zoteroKey };
}


// =============================================================================
// Internal Helpers
// =============================================================================

function getEditorView(inst: any): any | null {
    try {
        return inst._iframeWindow?.wrappedJSObject?._currentEditorInstance?._editorCore?.view ?? null;
    } catch { return null; }
}

function findEditorInstance(itemId: number): any | null {
    try {
        const instances: any[] = (Zotero as any).Notes?._editorInstances;
        if (!instances) return null;
        const matching = instances.filter((e: any) => e.itemID === itemId || e._item?.id === itemId);
        if (matching.length === 0) return null;
        const inst = matching.find((e: any) => e._viewMode === 'tab') || matching[0];
        return isEditorInstanceUsable(inst) ? inst : null;
    } catch { return null; }
}

/**
 * Cheap content fingerprint (djb2) for the preview revision guard. Not
 * cryptographic — it only needs to distinguish "same note bytes" from
 * "note changed since the preview rendered".
 */
export function hashPreviewContent(html: string): string {
    let h = 5381;
    for (let i = 0; i < html.length; i++) {
        h = ((h << 5) + h + html.charCodeAt(i)) | 0;
    }
    return `${html.length}:${(h >>> 0).toString(36)}`;
}

/**
 * True when the content execute would act on no longer matches the baseline
 * captured when the preview rendered. Both sides read "the content everyone
 * except the preview editor sees": here `getLatestNoteHtml` skips the frozen
 * preview editor via `_disableSaving` and includes other editors' unsaved
 * snapshots — the same content execute's `flushLiveEditorToDB` promotes to
 * the DB before matching. The preview editor's own unsaved state never
 * counts as drift (it is excluded from the baseline too). Read failures
 * return false: the guard is best-effort UI safety, and execute still
 * re-resolves fail-closed.
 */
export function noteContentDriftedFromPreview(itemId: number, contentHash: string): boolean {
    try {
        const item = Zotero.Items.get(itemId);
        if (!item) return false;
        return hashPreviewContent(getLatestNoteHtml(item)) !== contentHash;
    } catch {
        return false;
    }
}

function computeEditsHash(edits: EditOperation[]): string {
    return edits.map(e =>
        `${e.oldString.length}:${e.newString.length}:${e.operation ?? 'str_replace'}:${e.oldString}`
        + `:${e.targetBeforeContext ?? ''}:${e.targetAfterContext ?? ''}`,
    ).join('|');
}

// =============================================================================
// Iframe Action Property
// =============================================================================

function readIframeAction(iframeWindow: any): string | null {
    try {
        const val = iframeWindow?.wrappedJSObject?.[ACTION_PROP];
        return typeof val === 'string' ? val : null;
    } catch { return null; }
}

function clearIframeAction(iframeWindow: any): void {
    try { if (iframeWindow?.wrappedJSObject) iframeWindow.wrappedJSObject[ACTION_PROP] = null; }
    catch { /* ignore */ }
}

// =============================================================================
// Style & Banner
// =============================================================================

function injectPreviewStyles(iframeWindow: any): void {
    try {
        const doc = iframeWindow?.wrappedJSObject?.document ?? iframeWindow?.document;
        if (!doc?.head) return;
        doc.getElementById(PREVIEW_STYLE_ID)?.remove();
        const style = doc.createElement('style');
        style.id = PREVIEW_STYLE_ID;
        style.textContent = PREVIEW_CSS;
        doc.head.appendChild(style);
    } catch { /* best effort */ }
}

function removePreviewStyles(iframeWindow: any): void {
    try { (iframeWindow?.wrappedJSObject?.document ?? iframeWindow?.document)?.getElementById(PREVIEW_STYLE_ID)?.remove(); }
    catch { /* ignore */ }
}

function injectPreviewBanner(iframeWindow: any, multipleEdits: boolean): void {
    try {
        const doc = iframeWindow?.wrappedJSObject?.document ?? iframeWindow?.document;
        if (!doc) return;
        const container = doc.getElementById('editor-container');
        if (!container) return;
        doc.getElementById(PREVIEW_BANNER_ID)?.remove();

        const banner = doc.createElement('div');
        banner.id = PREVIEW_BANNER_ID;
        banner.className = 'beaver-preview-banner';

        const closeBtn = doc.createElement('button');
        closeBtn.className = 'btn-close';
        closeBtn.textContent = '\u00D7';
        closeBtn.title = 'Close preview';
        closeBtn.setAttribute('onclick', `window.${ACTION_PROP} = 'close'`);

        const title = doc.createElement('span');
        title.className = 'banner-title';
        title.textContent = 'Preview of Note Edits';

        const suffix = multipleEdits ? ' All' : '';

        const rejectBtn = doc.createElement('button');
        rejectBtn.className = 'btn-reject';
        rejectBtn.textContent = `Reject${suffix}`;
        rejectBtn.setAttribute('onclick', `window.${ACTION_PROP} = 'rejectAll'`);

        const approveBtn = doc.createElement('button');
        approveBtn.className = 'btn-approve';
        approveBtn.textContent = `Apply${suffix}`;
        approveBtn.setAttribute('onclick', `window.${ACTION_PROP} = 'approveAll'`);

        banner.appendChild(title);
        banner.appendChild(rejectBtn);
        banner.appendChild(approveBtn);
        banner.appendChild(closeBtn);
        container.insertBefore(banner, container.firstChild);
    } catch { /* best effort */ }
}

function removePreviewBanner(iframeWindow: any): void {
    try { (iframeWindow?.wrappedJSObject?.document ?? iframeWindow?.document)?.getElementById(PREVIEW_BANNER_ID)?.remove(); }
    catch { /* ignore */ }
}

// =============================================================================
// Scroll
// =============================================================================

function scrollToDiff(inst: any): void {
    setTimeout(() => {
        try {
            const view = getEditorView(inst);
            if (!view?.dom) return;
            // Browsers normalize rgba() with spaces after commas, so query
            // for the spaced format (the non-spaced originals never appear
            // in the live DOM).
            const diffSpan = view.dom.querySelector(`span[style*="rgba(${ADD_RGB_SPACED}"]`)
                || view.dom.querySelector(`span[style*="rgba(${DEL_RGB_SPACED}"]`);
            if (!diffSpan) return;
            const container = findScrollContainer(view.dom as Element);
            if (!container) return;
            const spanRect = diffSpan.getBoundingClientRect();
            const containerRect = container.getBoundingClientRect();
            container.scrollTop = Math.max(0,
                container.scrollTop + spanRect.top - containerRect.top - container.clientHeight / 3,
            );
        } catch { /* best effort */ }
    }, 200);
}

function findScrollContainer(element: Element): Element | null {
    let el: Element | null = element;
    while (el != null) {
        try {
            const htmlEl = el as HTMLElement;
            const overflow = htmlEl.style?.overflowY
                || String((htmlEl.ownerDocument.defaultView as any)?.getComputedStyle(htmlEl)?.overflowY ?? '');
            if (overflow === 'auto' || overflow === 'scroll') return htmlEl;
        } catch { return null; }
        el = el.parentElement;
    }
    return null;
}

// =============================================================================
// Diff Construction
// =============================================================================

interface PreviewExpandedEdit {
    expandedOld: string;
    expandedNew: string;
    operation: EditNoteOperation;
    targetBeforeContext?: string;
    targetAfterContext?: string;
}

/**
 * Try to locate edit.expandedOld in `stripped`, falling back through entity
 * decode/encode variants the way the validation/execution paths do (see
 * src/services/agentDataProvider/actions/editNote.ts).
 *
 * Returns a possibly-rewritten edit whose expandedOld appears verbatim in
 * `stripped`, or null if no variant matches.
 *
 * Order mirrors editNote.ts:
 *   1. Primary: expandedOld as-is
 *   2. Decode: note is PM-normalized (literal chars), model wrote entities
 *   3. Encode: note is pre-PM (entity-encoded), model wrote literal chars —
 *      try hex, decimal, and named forms
 */
function resolveExpandedOldForMatch(
    stripped: string,
    edit: PreviewExpandedEdit,
): PreviewExpandedEdit | null {
    if (stripped.indexOf(edit.expandedOld) !== -1) return edit;

    const decodedOld = decodeHtmlEntities(edit.expandedOld);
    if (decodedOld !== edit.expandedOld && stripped.indexOf(decodedOld) !== -1) {
        return {
            expandedOld: decodedOld,
            expandedNew: decodeHtmlEntities(edit.expandedNew),
            operation: edit.operation,
            targetBeforeContext: edit.targetBeforeContext !== undefined
                ? decodeHtmlEntities(edit.targetBeforeContext)
                : undefined,
            targetAfterContext: edit.targetAfterContext !== undefined
                ? decodeHtmlEntities(edit.targetAfterContext)
                : undefined,
        };
    }

    for (const form of ENTITY_FORMS) {
        const encodedOld = encodeTextEntities(edit.expandedOld, form);
        if (encodedOld !== edit.expandedOld && stripped.indexOf(encodedOld) !== -1) {
            return {
                expandedOld: encodedOld,
                expandedNew: encodeTextEntities(edit.expandedNew, form),
                operation: edit.operation,
                targetBeforeContext: edit.targetBeforeContext !== undefined
                    ? encodeTextEntities(edit.targetBeforeContext, form)
                    : undefined,
                targetAfterContext: edit.targetAfterContext !== undefined
                    ? encodeTextEntities(edit.targetAfterContext, form)
                    : undefined,
            };
        }
    }

    return null;
}

/**
 * Diagnostic: when stripped.indexOf(expandedOld) returns -1, log enough context
 * to identify where the two strings diverge. Uses binary search to find the
 * longest prefix of expandedOld that still exists in stripped, then prints a
 * snippet from both sides around that divergence point.
 *
 * Only invoked on a miss, so the O(log n · indexOf) cost is acceptable.
 */
function logExpandedOldMismatch(
    stripped: string,
    edit: { expandedOld: string; expandedNew: string; operation: EditNoteOperation },
): void {
    const expandedOld = edit.expandedOld;
    // Binary search: largest k such that expandedOld.slice(0, k) is found in stripped.
    let lo = 0;
    let hi = expandedOld.length;
    while (lo < hi) {
        const mid = Math.floor((lo + hi + 1) / 2);
        if (stripped.indexOf(expandedOld.slice(0, mid)) !== -1) {
            lo = mid;
        } else {
            hi = mid - 1;
        }
    }
    const matchedPrefixLen = lo;

    logger(
        `constructMultiDiffHtml: expandedOld NOT FOUND in stripped `
        + `(op=${edit.operation ?? 'str_replace'}, strippedLen=${stripped.length}, `
        + `expandedOldLen=${expandedOld.length}, longestMatchingPrefix=${matchedPrefixLen}/${expandedOld.length})`,
        1,
    );

    const headSnippet = expandedOld.length <= 400
        ? expandedOld
        : expandedOld.slice(0, 400) + '…';
    logger(
        `constructMultiDiffHtml: expandedOld head: ${JSON.stringify(headSnippet)}`,
        1,
    );

    if (matchedPrefixLen === 0) {
        // Nothing matches at all — not a partial drift, likely a completely
        // different encoding (e.g., entity escaping, tag rewriting)
        logger(
            `constructMultiDiffHtml: zero prefix match — expandedOld does not share even its first `
            + `character with any position in stripped. Likely an encoding/normalization difference `
            + `rather than a content drift.`,
            1,
        );
        return;
    }

    if (matchedPrefixLen === expandedOld.length) {
        // Shouldn't happen (indexOf would have succeeded), but guard anyway
        return;
    }

    // Locate the prefix in stripped to align the two contexts
    const prefixInStripped = stripped.indexOf(expandedOld.slice(0, matchedPrefixLen));
    if (prefixInStripped === -1) return;

    const CTX_BEFORE = 40;
    const CTX_AFTER = 80;
    const expandedContext = expandedOld.slice(
        Math.max(0, matchedPrefixLen - CTX_BEFORE),
        Math.min(expandedOld.length, matchedPrefixLen + CTX_AFTER),
    );
    const strippedContext = stripped.slice(
        Math.max(0, prefixInStripped + matchedPrefixLen - CTX_BEFORE),
        Math.min(stripped.length, prefixInStripped + matchedPrefixLen + CTX_AFTER),
    );

    logger(
        `constructMultiDiffHtml: divergence at expandedOld[${matchedPrefixLen}] — `
        + `expandedOld has: ${JSON.stringify(expandedContext)}`,
        1,
    );
    logger(
        `constructMultiDiffHtml: divergence at stripped[${prefixInStripped + matchedPrefixLen}] — `
        + `stripped has:    ${JSON.stringify(strippedContext)}`,
        1,
    );
}

export function constructMultiDiffHtml(
    fullHtml: string,
    edits: PreviewExpandedEdit[],
): string | null {
    const existingCitationCache = extractDataCitationItems(fullHtml);
    const stripped = stripDataCitationItems(fullHtml);

    // Handle rewrite: replace entire body with deletion-styled old + addition-styled new
    const rewriteEdit = edits.find(e => e.operation === 'rewrite');
    if (rewriteEdit) {
        // Extract wrapper div and body content
        const trimmed = stripped.trim();
        let wrapperOpen = '';
        let wrapperClose = '';
        let bodyContent = trimmed;
        if (trimmed.startsWith('<div') && trimmed.endsWith('</div>')) {
            const closeAngle = trimmed.indexOf('>');
            wrapperOpen = trimmed.substring(0, closeAngle + 1);
            wrapperClose = '</div>';
            bodyContent = trimmed.substring(closeAngle + 1, trimmed.length - 6);
        }

        const styledOld = bodyContent ? wrapTextNodesWithStyle(bodyContent, DEL_STYLE) : '';
        const styledNew = rewriteEdit.expandedNew ? wrapTextNodesWithStyle(rewriteEdit.expandedNew, ADD_STYLE) : '';
        return rebuildDataCitationItems(wrapperOpen + styledOld + styledNew + wrapperClose, existingCitationCache);
    }

    const ops: Array<{ pos: number; oldLen: number; replacement: string }> = [];

    const appendEdits = edits.filter(e => e.operation === 'append' && e.expandedNew);
    if (appendEdits.length > 0) {
        const pos = getBeaverFooterAppendPoint(stripped);
        const replacement = appendEdits
            .map(e => wrapTextNodesWithStyle(e.expandedNew, ADD_STYLE))
            .join('');
        ops.push({ pos, oldLen: 0, replacement });
    }

    for (const origEdit of edits) {
        if (!origEdit.expandedOld) continue;

        // Match strategy mirrors src/services/agentDataProvider/actions/editNote.ts:
        // primary match, then entity-decode fallback (model used &#x27; but note
        // has '), then entity-encode fallbacks (model used ' but note has entity).
        const edit = resolveExpandedOldForMatch(stripped, origEdit);
        if (!edit) {
            logExpandedOldMismatch(stripped, origEdit);
            continue;
        }

        const hasTargetAnchors = edit.targetBeforeContext !== undefined
            || edit.targetAfterContext !== undefined;
        if (edit.operation !== 'str_replace_all' && hasTargetAnchors) {
            let targetPosition = findTargetRawMatchPosition(
                stripped,
                edit.expandedOld,
                edit.targetBeforeContext,
                edit.targetAfterContext,
            );
            // Anchors go stale whenever the note changes after validation
            // (apply → undo round-trips re-serialize the HTML; users edit the
            // note). Falling back to a UNIQUE occurrence mirrors what execute
            // will actually do: both the batch core (resolveSingleTarget) and
            // v1 execute short-circuit on matchCount === 1 without consulting
            // anchors, so a sole surviving occurrence IS the apply target —
            // even when it is not the occurrence validation originally
            // anchored. Previewing it keeps the preview faithful to the
            // apply outcome; suppressing it would make the user approve
            // blind. With zero or multiple occurrences execute would fail or
            // need the anchors, so never guess: omit the edit instead.
            if (targetPosition === null) {
                const first = stripped.indexOf(edit.expandedOld);
                // Advance by the needle length, mirroring the executor's
                // countOccurrences semantics: a self-overlapping needle
                // ("aa" in "aaa") is ONE occurrence there, so it must count
                // as unique here too or the preview would suppress an edit
                // the executor happily applies.
                const second = first === -1 ? -1 : stripped.indexOf(edit.expandedOld, first + edit.expandedOld.length);
                if (first !== -1 && second === -1) {
                    logger(
                        'constructMultiDiffHtml: target anchors stale but expanded '
                        + 'old_string is unique; previewing its only occurrence',
                        1,
                    );
                    targetPosition = first;
                } else {
                    logger(
                        'constructMultiDiffHtml: target anchors did not resolve uniquely; '
                        + 'skipping the edit instead of previewing the first occurrence',
                        1,
                    );
                    continue;
                }
            }
            const { prefix, oldMiddle, newMiddle, suffix } = computeHtmlDiff(
                edit.expandedOld,
                edit.expandedNew,
            );
            const styledOld = oldMiddle ? wrapTextNodesWithStyle(oldMiddle, DEL_STYLE) : '';
            const styledNew = newMiddle ? wrapTextNodesWithStyle(newMiddle, ADD_STYLE) : '';
            ops.push({
                pos: targetPosition,
                oldLen: edit.expandedOld.length,
                replacement: prefix + styledOld + styledNew + suffix,
            });
            continue;
        }

        let searchFrom = 0;
        while (true) {
            const idx = stripped.indexOf(edit.expandedOld, searchFrom);
            if (idx === -1) break;
            const { prefix, oldMiddle, newMiddle, suffix } = computeHtmlDiff(edit.expandedOld, edit.expandedNew);
            const styledOld = oldMiddle ? wrapTextNodesWithStyle(oldMiddle, DEL_STYLE) : '';
            const styledNew = newMiddle ? wrapTextNodesWithStyle(newMiddle, ADD_STYLE) : '';
            ops.push({ pos: idx, oldLen: edit.expandedOld.length, replacement: prefix + styledOld + styledNew + suffix });
            if (edit.operation !== 'str_replace_all') break;
            searchFrom = idx + edit.expandedOld.length;
        }
    }
    if (ops.length === 0) return null;

    ops.sort((a, b) => b.pos - a.pos);
    const filtered: typeof ops = [];
    for (const op of ops) {
        if (!filtered.some(ex => op.pos < ex.pos + ex.oldLen && op.pos + op.oldLen > ex.pos))
            filtered.push(op);
    }

    let result = stripped;
    for (const op of filtered) {
        result = result.substring(0, op.pos) + op.replacement + result.substring(op.pos + op.oldLen);
    }
    return rebuildDataCitationItems(result, existingCitationCache);
}

function computeHtmlDiff(oldHtml: string, newHtml: string) {
    let prefixLen = 0;
    while (prefixLen < oldHtml.length && prefixLen < newHtml.length && oldHtml[prefixLen] === newHtml[prefixLen]) prefixLen++;
    prefixLen = snapPrefixToTagBoundary(oldHtml, prefixLen);
    let suffixLen = 0;
    while (suffixLen < oldHtml.length - prefixLen && suffixLen < newHtml.length - prefixLen
        && oldHtml[oldHtml.length - 1 - suffixLen] === newHtml[newHtml.length - 1 - suffixLen]) suffixLen++;
    suffixLen = snapSuffixToTagBoundary(oldHtml, suffixLen);
    return {
        prefix: oldHtml.substring(0, prefixLen),
        oldMiddle: oldHtml.substring(prefixLen, oldHtml.length - suffixLen),
        newMiddle: newHtml.substring(prefixLen, newHtml.length - suffixLen),
        suffix: oldHtml.substring(oldHtml.length - suffixLen),
    };
}

function snapPrefixToTagBoundary(html: string, pos: number): number {
    for (let i = pos - 1; i >= 0; i--) { if (html[i] === '>') break; if (html[i] === '<') return i; }
    return pos;
}

function snapSuffixToTagBoundary(html: string, suffixLen: number): number {
    if (suffixLen === 0) return 0;
    for (let i = html.length - suffixLen; i < html.length; i++) {
        if (html[i] === '<') return suffixLen;
        if (html[i] === '>') return Math.max(0, html.length - i - 1);
    }
    return suffixLen;
}

function wrapTextNodesWithStyle(html: string, style: string): string {
    return html.split(/(<[^>]+>)/).map(p => p.startsWith('<') || !p ? p : `<span style="${style}">${p}</span>`).join('');
}
