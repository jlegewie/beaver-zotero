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

// Re-asserts our `left:0; right:0` override when Zotero re-runs
// contextPane.updateLayout (splitter drag, sidebar resize, etc.) and
// clobbers the inline style. One observer per element.
let ctxPaneStyleObserver: MutationObserver | null = null;

function startCtxPaneStyleGuard(win: Window, ctxPaneEl: HTMLElement): void {
    stopCtxPaneStyleGuard();
    let reasserting = false;
    const ObserverCtor = (win as any).MutationObserver as typeof MutationObserver;
    ctxPaneStyleObserver = new ObserverCtor(() => {
        // Self-disconnect if the user switched away from stacked layout while
        // Beaver was shown — applyReaderPaneVisibility isn't re-invoked on
        // layout-pref changes, so this is the only place we can detect it.
        if (!isStackedLayout()) {
            stopCtxPaneStyleGuard();
            return;
        }
        if (reasserting) return;
        if (ctxPaneEl.style.left === '0px' && ctxPaneEl.style.right === '0px') return;
        reasserting = true;
        ctxPaneEl.style.left = '0px';
        ctxPaneEl.style.right = '0px';
        // The mutation triggered by our own assignment will fire synchronously
        // before the flag is cleared on the next tick.
        win.setTimeout(() => { reasserting = false; }, 0);
    });
    ctxPaneStyleObserver.observe(ctxPaneEl, {
        attributes: true,
        attributeFilter: ['style']
    });
}

function stopCtxPaneStyleGuard(): void {
    if (ctxPaneStyleObserver) {
        ctxPaneStyleObserver.disconnect();
        ctxPaneStyleObserver = null;
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
        const ctxPaneEl = ctxPane as HTMLElement;

        if (show) {
            if (innerVbox && beaver.parentElement !== innerVbox) {
                innerVbox.appendChild(beaver);
            }
            // Restore any prior `display:none` we may have placed on the
            // outer vbox during a previous standard-layout toggle.
            if (innerVbox) (innerVbox as HTMLElement).style.removeProperty('display');
            if (ctxInner) (ctxInner as HTMLElement).style.display = 'none';
            // Zotero offsets `#zotero-context-pane` by the per-tab reader
            // sidebar width (e.g. 240px on note tabs, where the sidebar is
            // open by default), leaving an empty strip alongside Beaver.
            // Force the pane to span the full reader area while Beaver is
            // shown — both LTR and RTL.
            ctxPaneEl.style.left = '0px';
            ctxPaneEl.style.right = '0px';
            // Defend against in-session resets: Zotero's updateLayout runs on
            // splitter drag / sidebar resize / tab switch and rewrites
            // style.left to the per-tab sidebar width. Re-assert our override
            // whenever the inline style changes.
            startCtxPaneStyleGuard(win, ctxPaneEl);
            // The inner vbox sets pointer-events:none so the transparent
            // placeholder above doesn't swallow clicks meant for the reader's
            // PDF. Beaver inherits that, so re-enable pointer events here.
            (beaver as HTMLElement).style.pointerEvents = 'auto';
            (beaver as HTMLElement).style.removeProperty('display');
        } else {
            stopCtxPaneStyleGuard();
            if (ctxInner) (ctxInner as HTMLElement).style.removeProperty('display');
            (beaver as HTMLElement).style.removeProperty('pointer-events');
            (beaver as HTMLElement).style.display = 'none';
            // Drop our overrides and let Zotero recompute the natural offset
            // for the current tab (sidebar reservation, RTL, etc.). This is
            // robust to tab switches that happened while Beaver was shown,
            // since Zotero's updateLayout reads the current tab's
            // sidebar state directly.
            ctxPaneEl.style.removeProperty('left');
            ctxPaneEl.style.removeProperty('right');
            try {
                const ctxPaneObj = (win as any).ZoteroContextPane;
                if (ctxPaneObj?.updateLayout) {
                    ctxPaneObj.updateLayout();
                }
            } catch (e) {
                // Best effort — older Zotero builds may not expose updateLayout.
            }
        }
        return;
    }

    // Standard layout: mount sits as a sibling of the context-pane content.
    // Tear down any stacked-layout observer left over from a layout switch.
    stopCtxPaneStyleGuard();
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
