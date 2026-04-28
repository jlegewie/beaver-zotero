/**
 * Helpers for handling Zotero's "stacked" layout vs the default three-pane layout.
 *
 * In the stacked layout the reader's `#zotero-context-pane` spans the entire
 * reader area and the inner vbox renders a transparent `.stacked-context-placeholder`
 * above `#zotero-context-pane-inner` so the PDF can show through. Hiding all
 * children of `#zotero-context-pane` (the standard-layout strategy) therefore
 * hides the placeholder and lets the Beaver mount cover the PDF, which is
 * confusing. In stacked layout we instead mount the Beaver pane inside the
 * inner vbox and only hide `#zotero-context-pane-inner`.
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
 * Stacked: mount lives inside the inner vbox so it occupies only the bottom
 *   strip (replacing `#zotero-context-pane-inner`), keeping the PDF visible
 *   above the splitter.
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
        const innerVbox = ctxInner?.parentElement ?? null;

        if (show) {
            if (innerVbox && beaver.parentElement !== innerVbox) {
                innerVbox.appendChild(beaver);
            }
            // Restore any prior `display:none` we may have placed on the
            // outer vbox during a previous standard-layout toggle.
            if (innerVbox) (innerVbox as HTMLElement).style.removeProperty('display');
            if (ctxInner) (ctxInner as HTMLElement).style.display = 'none';
            // The inner vbox sets pointer-events:none so the transparent
            // placeholder above doesn't swallow clicks meant for the reader's
            // PDF. Beaver inherits that, so re-enable pointer events here.
            (beaver as HTMLElement).style.pointerEvents = 'auto';
            (beaver as HTMLElement).style.removeProperty('display');
        } else {
            if (ctxInner) (ctxInner as HTMLElement).style.removeProperty('display');
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
        // Drop any pointer-events override left over from a prior stacked
        // toggle so we don't fight the standard-layout default.
        (beaver as HTMLElement).style.removeProperty('pointer-events');
        (beaver as HTMLElement).style.removeProperty('display');
    } else {
        siblings.forEach(el => (el as HTMLElement).style.removeProperty('display'));
        (beaver as HTMLElement).style.removeProperty('pointer-events');
        (beaver as HTMLElement).style.display = 'none';
    }
}
