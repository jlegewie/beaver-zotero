/**
 * Where Beaver's sidebar lives in a Zotero main window.
 *
 * A main window renders one sidebar, and moves it to the pane of the selected
 * tab: the item pane on a library tab, the context pane on any other. Moving
 * the element rather than rendering a second sidebar keeps the React tree,
 * and everything only a component holds, across tab switches.
 *
 * Zotero 7–10 build one library view per window at startup, so its item pane
 * (`#zotero-item-pane`) exists for the window's whole life. Zotero 11 builds a
 * library view per library tab, lazily: a window restored on a reader tab has
 * no item pane until its library tab is first selected, a window can show
 * several library tabs, each with its own item pane, and a view is destroyed
 * when its tab closes or unloads. On a library tab the sidebar therefore lives
 * in the active view's item pane.
 *
 * React-free and `addon`-free: both bundles import this module.
 */

export type SidebarLocation = 'library' | 'reader';

/** The element that holds the sidebar's React root, inside a Zotero pane. */
export const SIDEBAR_MOUNT_ID = 'beaver-pane-sidebar';

/** The container the sidebar's React root renders into. */
export const SIDEBAR_ROOT_ID = 'beaver-react-root-sidebar';

/**
 * Whether a Zotero tab type is a library tab. Zotero 11 suffixes a lazily
 * loaded tab's type with its state (`library-unloaded`, `library-loading`).
 */
export function isLibraryTabType(type: string | null | undefined): boolean {
    return typeof type === 'string' && type.split('-')[0] === 'library';
}

/** Whether a main window's selected tab is a library tab, including one still loading. */
export function isLibraryTabSelected(win: Window | null | undefined): boolean {
    const tabs = (win as any)?.Zotero_Tabs;
    if (!tabs) return false;
    if (typeof tabs.selectedIsLibrary === 'boolean') return tabs.selectedIsLibrary;
    return isLibraryTabType(tabs.selectedType);
}

/**
 * Select the window's active library tab, so a selection made through
 * `ZoteroPane` is on screen. Zotero 11 assigns library tabs generated ids and a
 * window need not have a `zotero-pane` tab, so selecting that id would throw;
 * Zotero 7–10 have exactly one library tab, `zotero-pane`.
 */
export function selectLibraryTab(win: Window): void {
    const tabs = (win as any).Zotero_Tabs;
    if (typeof tabs?.selectLibraryTab === 'function') {
        tabs.selectLibraryTab();
    } else {
        tabs?.select('zotero-pane');
    }
}

/**
 * The item pane of the window's active library view, or null while the window
 * has none (Zotero 11 only). On Zotero 11 `ZoteroPane.itemPane` resolves to
 * the active view's pane; on earlier versions it is the window's only one.
 */
export function activeItemPane(win: Window | null | undefined): HTMLElement | null {
    if (!win || win.closed || !win.document) return null;
    const pane = (win as any).ZoteroPane?.itemPane as HTMLElement | null | undefined;
    if (pane && pane.isConnected) return pane;
    // Zotero 7–10 before `ZoteroPane.init()` has run.
    return win.document.getElementById('zotero-item-pane');
}

/**
 * Create the sidebar's mount point and the container its React root renders
 * into. The caller places `mountPoint` in a pane.
 */
export function createSidebarMount(doc: Document) {
    // A XUL box: it styles and lays out like an HTML element.
    const mountPoint = doc.createXULElement('vbox') as unknown as HTMLElement;
    mountPoint.setAttribute('id', SIDEBAR_MOUNT_ID);
    // `beaver-root` is the scoping root for @beaver/agent-ui's shared
    // sheets: they select `.beaver-root .foo`, so the class has to sit
    // on exactly the elements that carry a `beaver-pane-*` id or the
    // utility layer stops matching inside this pane.
    mountPoint.setAttribute('class', 'beaver-root display-flex flex-1 h-full min-w-0');
    mountPoint.setAttribute('style', 'min-width: 0px; display: none;');

    const reactContainer = doc.createElement('div');
    reactContainer.setAttribute('id', SIDEBAR_ROOT_ID);
    reactContainer.setAttribute('class', 'display-flex flex-1 flex-col h-full min-w-0');
    mountPoint.appendChild(reactContainer);

    return { mountPoint, reactContainer };
}
