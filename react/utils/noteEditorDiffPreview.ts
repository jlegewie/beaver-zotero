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
import {
    getOrSimplify,
    expandToRawHtml,
    stripDataCitationItems,
    rebuildDataCitationItems,
    getLatestNoteHtml,
} from '../../src/utils/noteHtmlSimplifier';

// =============================================================================
// Constants
// =============================================================================

const DEL_STYLE = 'background-color:rgba(210,40,40,0.28);text-decoration:line-through;border-radius:2px;padding:0 1px';
const ADD_STYLE = 'background-color:rgba(16,150,72,0.28);border-radius:2px;padding:0 1px';
const PREVIEW_STYLE_ID = 'beaver-diff-preview-style';
const PREVIEW_BANNER_ID = 'beaver-preview-banner';
/** Property set on iframe window by banner button clicks, polled by the timer. */
const ACTION_PROP = '__beaverPreviewAction';

const PREVIEW_CSS = `
.ProseMirror { cursor: default !important; caret-color: transparent !important; user-select: none !important; }
.toolbar { opacity: 0.35; pointer-events: none; }
.beaver-preview-banner {
    position: sticky; top: 0; z-index: 100; display: flex; align-items: center; gap: 8px;
    background: rgba(16,150,72,0.10); border-bottom: 1px solid rgba(16,150,72,0.25);
    padding: 6px 10px; font-size: 13px; color: #1a7f37; font-weight: 500; letter-spacing: 0.01em;
}
.beaver-preview-banner .banner-title { flex: 1; text-align: center; }
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
    .beaver-preview-banner { background: rgba(16,150,72,0.12); color: #3fb950; border-bottom-color: rgba(16,150,72,0.2); }
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
    replaceAll?: boolean;
}

interface DiffPreviewState {
    itemId: number;
    libraryId: number;
    zoteroKey: string;
    editorInstance: any;
    wasSavingDisabled: boolean;
    pollTimer: ReturnType<typeof setInterval> | null;
    editsHash: string;
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
 * Register a callback for banner button actions ('close', 'approveAll', 'rejectAll').
 * Called by the coordinator to wire banner buttons to approval logic.
 */
export function setOnBannerAction(handler: ((action: string) => void) | null): void {
    onBannerAction = handler;
}

/**
 * Show diff preview in the note editor for one or more edits.
 * Returns true if preview was shown, false if fallback to sidebar is needed.
 */
export async function showDiffPreview(
    libraryId: number,
    zoteroKey: string,
    edits: EditOperation[],
): Promise<boolean> {
    try {
        if (edits.length === 0) return false;

        const hash = computeEditsHash(edits);

        // Dedup: if already showing the same preview, skip
        if (activePreview
            && activePreview.libraryId === libraryId
            && activePreview.zoteroKey === zoteroKey
            && activePreview.editsHash === hash
        ) {
            return true;
        }

        // Dismiss existing and claim this generation
        dismissDiffPreview();
        const myGeneration = ++generation;

        if (!areEditorApisAvailable()) return false;

        const itemId = Zotero.Items.getIDFromLibraryAndKey(libraryId, zoteroKey);
        if (!itemId) return false;

        const inst = findEditorInstance(itemId);
        if (!inst) return false;

        const item = await Zotero.Items.getAsync(itemId);
        if (myGeneration !== generation) return false;
        if (!item) return false;
        await item.loadDataType('note');
        if (myGeneration !== generation) return false;

        const rawHtml = getLatestNoteHtml(item);
        const noteId = `${libraryId}-${zoteroKey}`;
        const { metadata } = getOrSimplify(noteId, rawHtml, libraryId);

        // Expand all edits
        const expandedEdits: Array<{ expandedOld: string; expandedNew: string; replaceAll: boolean }> = [];
        for (const edit of edits) {
            try {
                const expandedOld = edit.oldString ? expandToRawHtml(edit.oldString, metadata, 'old') : '';
                const expandedNew = edit.newString ? expandToRawHtml(edit.newString, metadata, 'new') : '';
                if (expandedOld) expandedEdits.push({ expandedOld, expandedNew, replaceAll: edit.replaceAll ?? false });
            } catch (e: any) {
                logger(`showDiffPreview: expansion failed for one edit: ${e.message}`, 1);
            }
        }
        if (expandedEdits.length === 0) return false;
        if (myGeneration !== generation) return false;

        const diffHtml = constructMultiDiffHtml(rawHtml, expandedEdits);
        if (!diffHtml) return false;

        // Disable saving
        const wasSavingDisabled = !!inst._disableSaving;
        inst._disableSaving = true;

        try {
            inst.applyIncrementalUpdate({ html: diffHtml }, false);
        } catch (e: any) {
            inst._disableSaving = wasSavingDisabled;
            return false;
        }

        // Freeze editor
        try {
            const view = getEditorView(inst);
            if (view?.dom) view.dom.contentEditable = 'false';
        } catch { /* best effort */ }
        injectPreviewStyles(inst._iframeWindow);
        injectPreviewBanner(inst._iframeWindow);
        clearIframeAction(inst._iframeWindow);

        activePreview = {
            itemId, libraryId, zoteroKey,
            editorInstance: inst, wasSavingDisabled,
            pollTimer: null, editsHash: hash,
        };

        // Poll for banner button clicks + editor liveness
        activePreview.pollTimer = setInterval(() => {
            if (!activePreview) return;
            const action = readIframeAction(activePreview.editorInstance._iframeWindow);
            if (action) {
                clearIframeAction(activePreview.editorInstance._iframeWindow);
                if (action === 'close') {
                    dismissDiffPreview();
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
        logger(`showDiffPreview: error: ${e.message}`, 1);
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
 */
export function dismissDiffPreview(): void {
    generation++;
    if (!activePreview) return;

    const { editorInstance: inst, wasSavingDisabled, pollTimer, itemId } = activePreview;
    activePreview = null;

    if (pollTimer) clearInterval(pollTimer);

    try {
        if (!isEditorInstanceUsable(inst)) {
            try { inst._disableSaving = wasSavingDisabled; } catch { /* ignore */ }
            return;
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
        setTimeout(() => {
            try { inst._disableSaving = wasSavingDisabled; } catch { /* ignore */ }
        }, 150);
        logger('dismissDiffPreview: restored via incremental update', 1);
    } catch (e: any) {
        logger(`dismissDiffPreview: error: ${e.message}`, 1);
        try { inst._disableSaving = wasSavingDisabled; } catch { /* ignore */ }
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
        `${e.oldString.length}:${e.newString.length}:${e.replaceAll ? '1' : '0'}:${e.oldString.slice(0, 50)}`,
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

function injectPreviewBanner(iframeWindow: any): void {
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

        const rejectBtn = doc.createElement('button');
        rejectBtn.className = 'btn-reject';
        rejectBtn.textContent = 'Reject All';
        rejectBtn.setAttribute('onclick', `window.${ACTION_PROP} = 'rejectAll'`);

        const approveBtn = doc.createElement('button');
        approveBtn.className = 'btn-approve';
        approveBtn.textContent = 'Approve All';
        approveBtn.setAttribute('onclick', `window.${ACTION_PROP} = 'approveAll'`);

        banner.appendChild(closeBtn);
        banner.appendChild(title);
        banner.appendChild(rejectBtn);
        banner.appendChild(approveBtn);
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
            const diffSpan = view.dom.querySelector(`span[style*="background-color"]`);
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

function constructMultiDiffHtml(
    fullHtml: string,
    edits: Array<{ expandedOld: string; expandedNew: string; replaceAll: boolean }>,
): string | null {
    const stripped = stripDataCitationItems(fullHtml);
    const ops: Array<{ pos: number; oldLen: number; replacement: string }> = [];

    for (const edit of edits) {
        if (!edit.expandedOld) continue;
        let searchFrom = 0;
        while (true) {
            const idx = stripped.indexOf(edit.expandedOld, searchFrom);
            if (idx === -1) break;
            const { prefix, oldMiddle, newMiddle, suffix } = computeHtmlDiff(edit.expandedOld, edit.expandedNew);
            const styledOld = oldMiddle ? wrapTextNodesWithStyle(oldMiddle, DEL_STYLE) : '';
            const styledNew = newMiddle ? wrapTextNodesWithStyle(newMiddle, ADD_STYLE) : '';
            ops.push({ pos: idx, oldLen: edit.expandedOld.length, replacement: prefix + styledOld + styledNew + suffix });
            if (!edit.replaceAll) break;
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
