import { SIDEBAR_MOUNT_ID } from '../../src/ui/libraryPane';

/**
 * Helpers for handling Zotero's "stacked" layout vs the default three-pane layout.
 *
 * In the stacked layout the reader's `#zotero-context-pane` spans the entire
 * reader area and uses `position: fixed`. The bottom strip (`#zotero-context-pane-inner`)
 * holds the deck + sidenav and has its height persisted by the stacked
 * splitter. Mounting Beaver inside the inner lets Beaver inherit that
 * height naturally and keeps Zotero's `updateLayout` offset for the reader
 * sidebar working unchanged.
 */

export function isStackedLayout(): boolean {
    try {
        return Zotero?.Prefs?.get?.("layout") === "stacked";
    } catch (e) {
        return false;
    }
}

/**
 * The element the sidebar is placed in on a non-library tab, or null when the
 * window has no context pane.
 *
 * Stacked: `#zotero-context-pane-inner`, where the sidebar replaces the deck
 *   and side nav.
 * Standard: `#zotero-context-pane`, where it replaces every child.
 */
export function readerMountParent(win: Window): HTMLElement | null {
    const ctxPane = win.document.getElementById("zotero-context-pane");
    if (!ctxPane) return null;
    if (!isStackedLayout()) return ctxPane;
    return win.document.getElementById("zotero-context-pane-inner");
}

/**
 * Show the context pane's own content again: every child the sidebar hid in
 * either layout's parent. A layout change can leave content hidden in the
 * parent the sidebar has since left, so both are restored.
 */
export function restoreReaderSiblings(win: Window): void {
    const parents = [
        win.document.getElementById("zotero-context-pane"),
        win.document.getElementById("zotero-context-pane-inner"),
    ];
    for (const parent of parents) {
        if (!parent) continue;
        for (const child of Array.from(parent.children)) {
            if (child.id !== SIDEBAR_MOUNT_ID) {
                (child as HTMLElement).style.removeProperty('display');
            }
        }
    }
}

/**
 * An element's `width` attribute, or null when it has none. Zotero 7's Gecko
 * returns "" from `getAttribute` for a missing XUL attribute, and putting that
 * "" back would create an attribute Zotero then persists.
 */
export function widthAttribute(element: Element): string | null {
    return element.hasAttribute('width') ? element.getAttribute('width') : null;
}
