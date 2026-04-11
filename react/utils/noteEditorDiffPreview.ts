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
 */

import { logger } from '../../src/utils/logger';
import type { EditNoteOperation } from '../types/agentActions/editNote';
import {
    getOrSimplify,
    expandToRawHtml,
    stripDataCitationItems,
    rebuildDataCitationItems,
    getLatestNoteHtml,
    normalizeNoteHtml,
    decodeHtmlEntities,
    encodeTextEntities,
    ENTITY_FORMS,
} from '../../src/utils/noteHtmlSimplifier';

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
}

export interface DiffPreviewOptions {
    /**
     * Per-preview action handler. When set, banner Approve/Reject buttons
     * call this instead of the global onBannerAction (coordinator).
     * Used by AgentActionView for post-run single-edit previews.
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
}

let activePreview: DiffPreviewState | null = null;

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
    try {
        if (edits.length === 0) {
            logger(`showDiffPreview: aborting for ${noteKey}, edits array is empty`, 1);
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

        // Dismiss existing and claim this generation
        dismissDiffPreview();
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
        // Normalize through ProseMirror to match what simplifyNoteHtml exposes
        // to the model. Without this, entity encoding differences (e.g. the
        // note has `&#x27;` but the model wrote `'`) cause constructMultiDiffHtml's
        // indexOf to miss. Mirrors the match strategy in
        // src/services/agentDataProvider/actions/editNote.ts (lines 309, 914).
        const normalizedHtml = normalizeNoteHtml(rawHtml);
        const noteId = `${libraryId}-${zoteroKey}`;
        const { metadata } = getOrSimplify(noteId, rawHtml, libraryId);

        // Expand all edits
        const expandedEdits: Array<{ expandedOld: string; expandedNew: string; operation: EditNoteOperation }> = [];
        for (const edit of edits) {
            const op = edit.operation ?? 'str_replace';
            try {
                if (op === 'rewrite') {
                    const expandedNew = edit.newString ? expandToRawHtml(edit.newString, metadata, 'new') : '';
                    expandedEdits.push({ expandedOld: '', expandedNew, operation: op });
                } else {
                    const expandedOld = edit.oldString ? expandToRawHtml(edit.oldString, metadata, 'old') : '';
                    // For insert_after / insert_before, new_string is already
                    // normalized by validation to merge old_string with
                    // new_string (via normalized_action_data):
                    //   - insert_after:  new_string = old_string + new_string
                    //   - insert_before: new_string = new_string + old_string
                    // so computeHtmlDiff will naturally show the anchor as
                    // context and the insertion as addition.
                    const expandedNew = edit.newString ? expandToRawHtml(edit.newString, metadata, 'new') : '';
                    if (expandedOld) {
                        expandedEdits.push({ expandedOld, expandedNew, operation: op });
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
        };

        // Poll for banner button clicks + editor liveness
        activePreview.pollTimer = setInterval(() => {
            if (!activePreview) return;
            const action = readIframeAction(activePreview.editorInstance._iframeWindow);
            if (action) {
                clearIframeAction(activePreview.editorInstance._iframeWindow);
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
    }
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
    if (!activePreview) return Promise.resolve();

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
        return new Promise<void>((resolve) => {
            let savingRestored = false;
            const restoreSaving = () => {
                if (savingRestored) return;
                savingRestored = true;
                try { inst._iframeWindow?.removeEventListener('message', onIframeMsg); } catch { /* ignore */ }
                try { inst._disableSaving = wasSavingDisabled; } catch { /* ignore */ }
                resolve();
            };
            const onIframeMsg = (e: any) => {
                try {
                    if (e.data?.instanceID !== inst.instanceID) return;
                    const action = e.data?.message?.action;
                    if ((action === 'update' && e.data?.message?.system) || action === 'incrementalUpdateFailed') {
                        restoreSaving();
                    }
                } catch { /* ignore */ }
            };
            try { inst._iframeWindow.addEventListener('message', onIframeMsg); } catch { /* ignore */ }
            // Fallback: restore after 1.5s if the message never arrives
            // (e.g., iframe destroyed or update silently dropped).
            setTimeout(restoreSaving, 1500);
        });
    } catch (e: any) {
        logger(`dismissDiffPreview: error: ${e.message}`, 1);
        try { inst._disableSaving = wasSavingDisabled; } catch { /* ignore */ }
        return Promise.resolve();
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

function computeEditsHash(edits: EditOperation[]): string {
    return edits.map(e =>
        `${e.oldString.length}:${e.newString.length}:${e.operation ?? 'str_replace'}:${e.oldString}`,
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
    edit: { expandedOld: string; expandedNew: string; operation: EditNoteOperation },
): { expandedOld: string; expandedNew: string; operation: EditNoteOperation } | null {
    if (stripped.indexOf(edit.expandedOld) !== -1) return edit;

    const decodedOld = decodeHtmlEntities(edit.expandedOld);
    if (decodedOld !== edit.expandedOld && stripped.indexOf(decodedOld) !== -1) {
        return {
            expandedOld: decodedOld,
            expandedNew: decodeHtmlEntities(edit.expandedNew),
            operation: edit.operation,
        };
    }

    for (const form of ENTITY_FORMS) {
        const encodedOld = encodeTextEntities(edit.expandedOld, form);
        if (encodedOld !== edit.expandedOld && stripped.indexOf(encodedOld) !== -1) {
            return {
                expandedOld: encodedOld,
                expandedNew: encodeTextEntities(edit.expandedNew, form),
                operation: edit.operation,
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

function constructMultiDiffHtml(
    fullHtml: string,
    edits: Array<{ expandedOld: string; expandedNew: string; operation: EditNoteOperation }>,
): string | null {
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
        return rebuildDataCitationItems(wrapperOpen + styledOld + styledNew + wrapperClose);
    }

    const ops: Array<{ pos: number; oldLen: number; replacement: string }> = [];

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
    return rebuildDataCitationItems(result);
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
