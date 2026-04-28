/**
 * Helpers for handling Zotero's "stacked" layout vs the default three-pane layout.
 *
 * In the stacked layout the reader's `#zotero-context-pane` spans the entire
 * reader area and uses `position: fixed`. The bottom strip (`#zotero-context-pane-inner`)
 * holds the deck + sidenav and has its height persisted by the stacked
 * splitter. Mounting Beaver inside the inner lets Beaver inherit that
 * height naturally and keeps Zotero's `updateLayout` offset for the reader
 * sidebar working unchanged.
 *
 * `applyReaderPaneVisibility` normalises `#beaver-pane-reader`'s parent on
 * every call so the DOM never gets stuck under the wrong parent across a
 * layout-pref change.
 */

export function isStackedLayout(): boolean {
    try {
        return Zotero?.Prefs?.get?.("layout") === "stacked";
    } catch (e) {
        return false;
    }
}

function restoreReaderSiblings(ctxPane: HTMLElement, ctxInner: HTMLElement | null): void {
    const parents = new Set<HTMLElement>([ctxPane]);
    if (ctxInner) {
        parents.add(ctxInner);
    }

    for (const parent of parents) {
        for (const child of Array.from(parent.children)) {
            if (child.id !== "beaver-pane-reader") {
                (child as HTMLElement).style.removeProperty('display');
            }
        }
    }
}

/**
 * Place the Beaver reader mount in the right parent for the current layout
 * and toggle visibility of the surrounding Zotero panels accordingly.
 *
 * Stacked: mount lives inside `#zotero-context-pane-inner`, replacing its
 *   deck + sidenav children visually.
 * Standard: mount lives at `#zotero-context-pane` level and hides every
 *   sibling, mirroring the previous behavior.
 *
 * Parent normalisation runs on both show and hide so a layout-pref flip
 * while Beaver is hidden doesn't leave the mount orphaned under the
 * previous layout's parent.
 */
export function applyReaderPaneVisibility(win: Window, show: boolean): void {
    const ctxPane = win.document.getElementById("zotero-context-pane");
    if (!ctxPane) return;

    const ctxInner = win.document.getElementById("zotero-context-pane-inner");
    const beaver = win.document.getElementById("beaver-pane-reader");

    if (!beaver) {
        if (!show) {
            restoreReaderSiblings(ctxPane as HTMLElement, ctxInner as HTMLElement | null);
        }
        return;
    }

    const stacked = isStackedLayout();
    if (stacked && !ctxInner) {
        if (!show) {
            restoreReaderSiblings(ctxPane as HTMLElement, null);
            (beaver as HTMLElement).style.display = 'none';
        }
        return;
    }

    const targetParent = (stacked ? ctxInner : ctxPane) as HTMLElement;

    // If Beaver is currently parented to the *other* layout's parent, restore
    // that parent's children's `display` before moving Beaver out, so we
    // don't leave hidden siblings behind (e.g. ctxInner's deck stuck at
    // display:none after a stacked→standard pref change).
    const previousParent = beaver.parentElement;
    if (previousParent && previousParent !== targetParent &&
        (previousParent === ctxPane || previousParent === ctxInner)) {
        for (const child of Array.from(previousParent.children)) {
            if (child.id !== "beaver-pane-reader") {
                (child as HTMLElement).style.removeProperty('display');
            }
        }
    }

    if (beaver.parentElement !== targetParent) {
        targetParent.appendChild(beaver);
    }

    const siblings = Array.from(targetParent.children).filter(
        c => c.id !== "beaver-pane-reader"
    );
    if (show) {
        siblings.forEach(el => ((el as HTMLElement).style.display = 'none'));
        (beaver as HTMLElement).style.removeProperty('pointer-events');
        (beaver as HTMLElement).style.removeProperty('display');
    } else {
        restoreReaderSiblings(ctxPane as HTMLElement, ctxInner as HTMLElement | null);
        (beaver as HTMLElement).style.removeProperty('pointer-events');
        (beaver as HTMLElement).style.display = 'none';
    }
}
