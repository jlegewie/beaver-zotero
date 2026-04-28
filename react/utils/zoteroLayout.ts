/**
 * Helpers for handling Zotero's "stacked" layout vs the default three-pane layout.
 *
 * In the stacked layout the reader's `#zotero-context-pane` spans the entire
 * reader area and uses `position: fixed`. Its inner vbox contains a
 * transparent `.stacked-context-placeholder` (which lets the PDF show
 * through) above `#zotero-context-pane-inner` (the bottom strip showing
 * item info / notes). Zotero offsets `#zotero-context-pane.style.left` by
 * the reader sidebar width so the placeholder + bottom strip don't overlap
 * the reader sidebar.
 *
 * To preserve that offset and the inner pane's persisted height (which is
 * driven by `#zotero-context-splitter-stacked`), we mount the Beaver pane
 * INSIDE `#zotero-context-pane-inner` and hide its other children. Beaver
 * then inherits the inner's height naturally and lives within Zotero's
 * existing layout — no inline style overrides or observers needed.
 */

export function isStackedLayout(): boolean {
    try {
        return Zotero?.Prefs?.get?.("layout") === "stacked";
    } catch (e) {
        return false;
    }
}

/**
 * Place the Beaver reader mount in the right parent for the current layout
 * and toggle visibility of the surrounding Zotero panels accordingly.
 *
 * Stacked: mount lives inside `#zotero-context-pane-inner`, replacing its
 *   deck + sidenav children visually. Beaver inherits the inner's
 *   persisted height (controlled by the stacked splitter), and Zotero's
 *   own `updateLayout` keeps `#zotero-context-pane` correctly offset by
 *   the per-tab reader sidebar width.
 * Standard: mount lives at `#zotero-context-pane` level and hides every
 *   sibling, mirroring the previous behavior.
 */
export function applyReaderPaneVisibility(win: Window, show: boolean): void {
    const ctxPane = win.document.getElementById("zotero-context-pane");
    const beaver = win.document.getElementById("beaver-pane-reader");
    if (!ctxPane || !beaver) return;

    const stacked = isStackedLayout();

    if (stacked) {
        const ctxInner = win.document.getElementById("zotero-context-pane-inner");
        if (!ctxInner) return;

        if (show) {
            if (beaver.parentElement !== ctxInner) {
                ctxInner.appendChild(beaver);
            }
            // Hide deck + sidenav (the inner pane's normal children) so only
            // Beaver is visible inside the bottom strip.
            for (const child of Array.from(ctxInner.children)) {
                if (child.id !== "beaver-pane-reader") {
                    (child as HTMLElement).style.display = 'none';
                }
            }
            // Beaver might inherit `pointer-events:none` from the parent
            // vbox (which prevents the placeholder from swallowing PDF
            // clicks). Re-enable for Beaver itself.
            (beaver as HTMLElement).style.pointerEvents = 'auto';
            (beaver as HTMLElement).style.removeProperty('display');
        } else {
            // Restore inner's children
            for (const child of Array.from(ctxInner.children)) {
                if (child.id !== "beaver-pane-reader") {
                    (child as HTMLElement).style.removeProperty('display');
                }
            }
            (beaver as HTMLElement).style.removeProperty('pointer-events');
            (beaver as HTMLElement).style.display = 'none';
        }
        return;
    }

    // Standard layout: mount sits as a sibling of the context-pane content.
    if (show && beaver.parentElement !== ctxPane) {
        ctxPane.appendChild(beaver);
    }
    const siblings = ctxPane.querySelectorAll(":scope > *:not(#beaver-pane-reader)");
    if (show) {
        siblings.forEach(el => ((el as HTMLElement).style.display = 'none'));
        (beaver as HTMLElement).style.removeProperty('pointer-events');
        (beaver as HTMLElement).style.removeProperty('display');
    } else {
        siblings.forEach(el => (el as HTMLElement).style.removeProperty('display'));
        (beaver as HTMLElement).style.removeProperty('pointer-events');
        (beaver as HTMLElement).style.display = 'none';
    }
}
