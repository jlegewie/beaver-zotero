/**
 * Note Editor Diff Preview
 *
 * Shows edit_note diffs directly in the Zotero note editor by injecting
 * styled HTML (red/strikethrough for deletions, green for additions)
 * without persisting the preview to the note.
 *
 * Uses EditorInstance._disableSaving + applyIncrementalUpdate() to prevent
 * the preview from being saved.
 */

import { logger } from '../../src/utils/logger';
import {
    getOrSimplify,
    expandToRawHtml,
    stripDataCitationItems,
    rebuildDataCitationItems,
    getLatestNoteHtml,
} from '../../src/utils/noteHtmlSimplifier';
import { openNoteById } from './sourceUtils';

// =============================================================================
// Types & Singleton State
// =============================================================================

const DEL_STYLE = 'background-color:rgba(255,100,100,0.3);text-decoration:line-through';
const ADD_STYLE = 'background-color:rgba(100,200,100,0.3)';
const PREVIEW_STYLE_ID = 'beaver-diff-preview-style';
const PREVIEW_CSS = `
/* Freeze editing visuals */
.ProseMirror {
    cursor: default !important;
    caret-color: transparent !important;
    user-select: none !important;
}
/* Dim toolbar to signal inactivity */
.toolbar {
    opacity: 0.35;
    pointer-events: none;
}
`;

interface DiffPreviewState {
    itemId: number;
    editorInstance: any;
    originalHtml: string;
    wasSavingDisabled: boolean;
}

let activePreview: DiffPreviewState | null = null;

// =============================================================================
// Public API
// =============================================================================

/**
 * Show diff preview in the note editor. Opens note if not already open.
 */
export async function showDiffPreview(
    libraryId: number,
    zoteroKey: string,
    oldString: string,
    newString: string,
    replaceAll?: boolean,
): Promise<boolean> {
    try {
        // Dismiss any existing preview
        dismissDiffPreview();

        // Resolve itemId
        const itemId = Zotero.Items.getIDFromLibraryAndKey(libraryId, zoteroKey);
        if (!itemId) {
            logger(`showDiffPreview: item not found for ${libraryId}-${zoteroKey}`, 1);
            return false;
        }

        // Find live editor instance, or open the note and poll until ready
        let inst = findEditorInstance(itemId);
        if (!inst) {
            await openNoteById(itemId);
            inst = await pollForEditorInstance(itemId, 3000);
        }
        if (!inst) {
            logger('showDiffPreview: no editor instance found after polling', 1);
            return false;
        }

        // Load item and get simplification metadata
        const item = await Zotero.Items.getAsync(itemId);
        if (!item) return false;
        await item.loadDataType('note');

        const rawHtml = getLatestNoteHtml(item);
        const noteId = `${libraryId}-${zoteroKey}`;
        const { metadata } = getOrSimplify(noteId, rawHtml, libraryId);

        // Expand simplified tags to raw HTML
        let expandedOld: string;
        let expandedNew: string;
        try {
            expandedOld = oldString ? expandToRawHtml(oldString, metadata, 'old') : '';
            expandedNew = newString ? expandToRawHtml(newString, metadata, 'new') : '';
        } catch (e: any) {
            logger(`showDiffPreview: expansion failed: ${e.message}`, 1);
            return false;
        }

        // Construct the diff HTML
        const diffHtml = constructDiffHtml(rawHtml, expandedOld, expandedNew, replaceAll);
        if (!diffHtml) {
            logger('showDiffPreview: could not construct diff HTML (no match found)', 1);
            return false;
        }

        // Disable saving and inject
        const wasSavingDisabled = !!inst._disableSaving;
        inst._disableSaving = true;

        try {
            inst.applyIncrementalUpdate({ html: diffHtml }, false);
        } catch (e: any) {
            inst._disableSaving = wasSavingDisabled;
            logger(`showDiffPreview: injection failed: ${e.message}`, 1);
            return false;
        }

        // Freeze editing — set contentEditable to false and inject preview-mode CSS
        try {
            const view = inst._iframeWindow.wrappedJSObject
                ._currentEditorInstance._editorCore.view;
            view.dom.contentEditable = 'false';
        } catch { /* best effort */ }
        injectPreviewStyles(inst._iframeWindow);

        // Store state
        activePreview = {
            itemId, editorInstance: inst, originalHtml: rawHtml, wasSavingDisabled,
        };

        // Scroll to the diff
        scrollToDiff(inst);

        logger(`showDiffPreview: preview active for ${noteId}`, 1);
        return true;
    } catch (e: any) {
        logger(`showDiffPreview: error: ${e.message}`, 1);
        return false;
    }
}

/**
 * Restore original HTML and re-enable saving. No-op if no preview active.
 */
export function dismissDiffPreview(): void {
    if (!activePreview) return;

    const { editorInstance: inst, originalHtml, wasSavingDisabled } = activePreview;
    activePreview = null;

    try {
        // Check if the editor is still alive
        const wrappedJS = inst._iframeWindow?.wrappedJSObject;
        if (!wrappedJS?._currentEditorInstance?._editorCore?.view) {
            logger('dismissDiffPreview: editor closed, skipping restore', 1);
            return;
        }
        // Restore editing before restoring content
        removePreviewStyles(inst._iframeWindow);
        wrappedJS._currentEditorInstance._editorCore.view.dom.contentEditable = 'true';
        inst.applyIncrementalUpdate({ html: originalHtml }, false);
        inst._disableSaving = wasSavingDisabled;
        logger('dismissDiffPreview: restored original HTML', 1);
    } catch (e: any) {
        logger(`dismissDiffPreview: restore error: ${e.message}`, 1);
        try { inst._disableSaving = wasSavingDisabled; } catch { /* ignore */ }
    }
}

/**
 * Check if a preview is currently active (optionally for a specific note).
 */
export function isDiffPreviewActive(libraryId?: number, zoteroKey?: string): boolean {
    if (!activePreview) return false;
    if (libraryId != null && zoteroKey) {
        const itemId = Zotero.Items.getIDFromLibraryAndKey(libraryId, zoteroKey);
        return activePreview.itemId === itemId;
    }
    return true;
}

// =============================================================================
// Internal Helpers
// =============================================================================

function waitMs(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Find a live editor instance for a given item ID.
 * Mirrors getNoteEditorView's matching logic: filter by itemID, prefer tab
 * mode, verify _iframeWindow and inner editor are initialized.
 */
function findEditorInstance(itemId: number): any | null {
    try {
        const instances: any[] = (Zotero as any).Notes?._editorInstances;
        if (!instances) return null;

        const matching = instances.filter(
            (e: any) => e.itemID === itemId || e._item?.id === itemId,
        );
        if (matching.length === 0) return null;

        // Prefer tab instance (openNoteById opens in a tab)
        const inst = matching.find((e: any) => e.viewMode === 'tab')
            || matching[0];

        if (!inst?._iframeWindow) return null;

        // Verify the inner editor is initialized (same check as getNoteEditorView)
        const wrappedJS = inst._iframeWindow.wrappedJSObject;
        if (!wrappedJS?._currentEditorInstance?._editorCore?.view) return null;

        return inst;
    } catch { /* ignore */ }
    return null;
}

/**
 * Poll for an editor instance to become available (up to maxWaitMs).
 * Mirrors the polling pattern in selectAndScrollInNoteEditor.
 */
async function pollForEditorInstance(itemId: number, maxWaitMs: number = 3000): Promise<any | null> {
    const pollIntervalMs = 100;
    const startTime = Date.now();
    while (Date.now() - startTime < maxWaitMs) {
        const inst = findEditorInstance(itemId);
        if (inst) return inst;
        await waitMs(pollIntervalMs);
    }
    return null;
}

/**
 * Scroll the editor to the first diff highlight after injection.
 */
/** Inject a <style> tag into the iframe to visually signal preview mode. */
function injectPreviewStyles(iframeWindow: any): void {
    try {
        const doc = iframeWindow?.document;
        if (!doc?.head) return;
        doc.getElementById(PREVIEW_STYLE_ID)?.remove();
        const style = doc.createElement('style');
        style.id = PREVIEW_STYLE_ID;
        style.textContent = PREVIEW_CSS;
        doc.head.appendChild(style);
    } catch { /* best effort */ }
}

/** Remove the preview-mode <style> tag from the iframe. */
function removePreviewStyles(iframeWindow: any): void {
    try {
        iframeWindow?.document?.getElementById(PREVIEW_STYLE_ID)?.remove();
    } catch { /* ignore */ }
}

function scrollToDiff(inst: any): void {
    setTimeout(() => {
        try {
            const view = inst._iframeWindow?.wrappedJSObject
                ?._currentEditorInstance?._editorCore?.view;
            if (!view?.dom) return;

            const diffSpan = view.dom.querySelector('span[style*="background-color:rgba"]');
            if (!diffSpan) return;

            // Find scroll container (same approach as selectAndScrollInNoteEditor)
            const container = findScrollContainer(view.dom as Element);
            if (!container) return;

            const spanRect = diffSpan.getBoundingClientRect();
            const containerRect = container.getBoundingClientRect();
            container.scrollTop = Math.max(0,
                container.scrollTop + spanRect.top - containerRect.top
                - container.clientHeight / 2,
            );
        } catch { /* best effort */ }
    }, 150);
}

function findScrollContainer(element: Element): Element | null {
    let el: Element | null = element;
    while (el) {
        try {
            // @ts-expect-error — TS doesn't narrow `el` across loop iterations
            const overflow = getComputedStyle(el).overflowY;
            if (overflow === 'auto' || overflow === 'scroll') return el;
        } catch { return null; }
        el = el.parentElement;
    }
    return null;
}

// =============================================================================
// Diff Construction
// =============================================================================

/**
 * Construct diff HTML: find expandedOld in the note, replace with
 * styled diff showing only the actual changes (common prefix/suffix unstyled).
 */
function constructDiffHtml(
    fullHtml: string,
    expandedOld: string,
    expandedNew: string,
    replaceAll?: boolean,
): string | null {
    if (!expandedOld) return null;

    const stripped = stripDataCitationItems(fullHtml);

    // Find all match positions
    const positions: number[] = [];
    let searchFrom = 0;
    while (true) {
        const idx = stripped.indexOf(expandedOld, searchFrom);
        if (idx === -1) break;
        positions.push(idx);
        if (!replaceAll) break;
        searchFrom = idx + expandedOld.length;
    }
    if (positions.length === 0) return null;

    // Compute common prefix/suffix between old and new to highlight only actual changes
    const { prefix, oldMiddle, newMiddle, suffix } = computeHtmlDiff(expandedOld, expandedNew);

    const styledOldMiddle = oldMiddle
        ? wrapTextNodesWithStyle(oldMiddle, DEL_STYLE)
        : '';
    const styledNewMiddle = newMiddle
        ? wrapTextNodesWithStyle(newMiddle, ADD_STYLE)
        : '';
    const replacement = prefix + styledOldMiddle + styledNewMiddle + suffix;

    // Build from last to first to preserve positions
    let result = stripped;
    for (let i = positions.length - 1; i >= 0; i--) {
        const pos = positions[i];
        result = result.substring(0, pos)
            + replacement
            + result.substring(pos + expandedOld.length);
    }

    return rebuildDataCitationItems(result);
}

/**
 * Compute the common prefix and suffix between two HTML strings,
 * extracting only the differing middles. Snaps boundaries to avoid
 * splitting HTML tags.
 */
function computeHtmlDiff(oldHtml: string, newHtml: string): {
    prefix: string; oldMiddle: string; newMiddle: string; suffix: string;
} {
    // Find common prefix (character by character)
    let prefixLen = 0;
    while (prefixLen < oldHtml.length && prefixLen < newHtml.length
        && oldHtml[prefixLen] === newHtml[prefixLen]) {
        prefixLen++;
    }
    // Snap back if we're inside an HTML tag
    prefixLen = snapPrefixToTagBoundary(oldHtml, prefixLen);

    // Find common suffix (not overlapping with prefix)
    let suffixLen = 0;
    while (suffixLen < oldHtml.length - prefixLen
        && suffixLen < newHtml.length - prefixLen
        && oldHtml[oldHtml.length - 1 - suffixLen] === newHtml[newHtml.length - 1 - suffixLen]) {
        suffixLen++;
    }
    // Snap forward if we're inside an HTML tag
    suffixLen = snapSuffixToTagBoundary(oldHtml, suffixLen);

    return {
        prefix: oldHtml.substring(0, prefixLen),
        oldMiddle: oldHtml.substring(prefixLen, oldHtml.length - suffixLen),
        newMiddle: newHtml.substring(prefixLen, newHtml.length - suffixLen),
        suffix: oldHtml.substring(oldHtml.length - suffixLen),
    };
}

/** If pos is inside an HTML tag, snap back to before the '<'. */
function snapPrefixToTagBoundary(html: string, pos: number): number {
    for (let i = pos - 1; i >= 0; i--) {
        if (html[i] === '>') break;  // After a closing bracket — safe
        if (html[i] === '<') return i; // Inside a tag — snap back
    }
    return pos;
}

/** If the suffix start falls inside an HTML tag, reduce suffixLen to exclude it. */
function snapSuffixToTagBoundary(html: string, suffixLen: number): number {
    if (suffixLen === 0) return 0;
    const startPos = html.length - suffixLen;
    for (let i = startPos; i < html.length; i++) {
        if (html[i] === '<') return suffixLen; // Hit tag start — not inside a tag
        if (html[i] === '>') {
            // Inside a tag — snap to after this '>'
            return Math.max(0, html.length - i - 1);
        }
    }
    return suffixLen;
}

/**
 * Wrap each text node (non-tag segment) with an inline style span.
 * Leaves HTML tags untouched.
 */
function wrapTextNodesWithStyle(html: string, style: string): string {
    const parts = html.split(/(<[^>]+>)/);
    return parts.map(part => {
        if (part.startsWith('<')) return part;
        if (!part.trim()) return part;
        return `<span style="${style}">${part}</span>`;
    }).join('');
}
