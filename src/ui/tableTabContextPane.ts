/**
 * The item context pane on a Beaver table tab.
 *
 * Zotero shows that pane for reader and note tabs and leaves it untouched for
 * any other tab type, so on a Beaver tab it keeps whatever the previous tab
 * left: collapsed after the library, or the last reader's item. On a Beaver tab
 * the pane holds Beaver's chat and nothing else: open while the chat is open
 * (the chat hides the pane's own content), collapsed while it is closed.
 *
 * Only DOM state is changed, never the splitter's saved state, so reader tabs
 * keep the open or collapsed pane the user chose for them.
 *
 * Shared by both bundles: the tab code collapses the pane when a Beaver tab is
 * selected with the chat closed, and the sidebar opens or collapses it as the
 * chat is shown or hidden.
 */

/** The Zotero tab type of a Beaver table tab. */
export const TABLE_TAB_TYPE = 'beaver-table';

export function isTableTabSelected(win: Window): boolean {
    return (win as any).Zotero_Tabs?.selectedType === TABLE_TAB_TYPE;
}

/** The table item of the selected Beaver tab in `win`, or null when another tab is selected. */
export function selectedTableTabItemID(win: Window | null | undefined): number | null {
    const tabs = (win as any)?.Zotero_Tabs;
    const tab = tabs?._tabs?.find((t: any) => t.id === tabs.selectedID);
    return tab?.type === TABLE_TAB_TYPE && typeof tab.data?.itemID === 'number' ? tab.data.itemID : null;
}

function hideSidenav(win: Window): void {
    const sidenav = win.document.getElementById('zotero-context-pane-sidenav');
    if (sidenav) sidenav.hidden = true;
}

/**
 * Turns a boolean XUL attribute on. `"true"` is the one value that reads as on
 * in Zotero 7–10, which compare the string, and in Zotero 11, which only checks
 * presence; an empty value would read as off on the older versions.
 */
function setOn(el: Element | null, name: string): void {
    el?.setAttribute(name, 'true');
}

/** Collapses the pane so no reader item shows beside the table. */
export function collapseTableTabContextPane(win: Window): void {
    const doc = win.document;
    setOn(doc.getElementById('zotero-context-splitter'), 'hidden');
    setOn(doc.getElementById('zotero-context-splitter-stacked'), 'hidden');
    setOn(doc.getElementById('zotero-context-pane'), 'collapsed');
    hideSidenav(win);
}

/**
 * Opens the pane for Beaver's chat. The splitter and layout come from
 * Zotero's own update; the item sections' side nav stays hidden, since no item
 * belongs to a table tab.
 */
export function openTableTabContextPane(win: Window): void {
    const doc = win.document;
    doc.getElementById('zotero-context-pane')?.removeAttribute('collapsed');
    doc.getElementById('zotero-context-pane-inner')?.removeAttribute('collapsed');
    try {
        (win as any).ZoteroContextPane?.update?.();
    } catch {
        // Layout refresh is best effort; the pane is already open.
    }
    hideSidenav(win);
}

/** Whether Beaver's chat is open in this window (its toolbar toggle is on). */
export function isBeaverChatOpen(win: Window): boolean {
    return !!win.document.querySelector('#zotero-beaver-tb-chat-toggle')?.hasAttribute('selected');
}
