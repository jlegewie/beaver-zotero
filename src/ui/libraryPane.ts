/**
 * Where Beaver's sidebars live in a Zotero main window.
 *
 * Zotero 7–10 build one library view per window at startup, so its item pane
 * (`#zotero-item-pane`) exists for the window's whole life. Zotero 11 builds a
 * library view per library tab, lazily: a window restored on a reader tab has
 * no item pane until its library tab is first selected, a window can show
 * several library tabs, each with its own item pane, and a view is destroyed
 * when its tab closes or unloads. The library sidebar therefore lives in the
 * active view's item pane and moves with it.
 *
 * React-free and `addon`-free: both bundles import this module.
 */

export type SidebarLocation = 'library' | 'reader';

/** The element that holds a sidebar's React root, inside the Zotero pane. */
export function sidebarMountId(location: SidebarLocation): string {
    return `beaver-pane-${location}`;
}

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
 * Create a sidebar's mount point and the container its React root renders
 * into. The caller appends `mountPoint` to its pane.
 */
export function createSidebarMount(doc: Document, location: SidebarLocation) {
    const mountPoint = doc.createXULElement('vbox');
    mountPoint.setAttribute('id', sidebarMountId(location));
    // `beaver-root` is the scoping root for @beaver/agent-ui's shared
    // sheets: they select `.beaver-root .foo`, so the class has to sit
    // on exactly the elements that carry a `beaver-pane-*` id or the
    // utility layer stops matching inside this pane.
    mountPoint.setAttribute('class', 'beaver-root display-flex flex-1 h-full min-w-0');
    mountPoint.setAttribute('style', 'min-width: 0px; display: none;');

    const reactContainer = doc.createElement('div');
    reactContainer.setAttribute('id', `beaver-react-root-${location}`);
    reactContainer.setAttribute('data-location', location);
    reactContainer.setAttribute('class', 'display-flex flex-1 flex-col h-full min-w-0');
    mountPoint.appendChild(reactContainer);

    return { mountPoint, reactContainer };
}

/**
 * Move the library sidebar's mount point into the active library view's item
 * pane. The pane it leaves gets back the content Beaver hid there; showing
 * the sidebar in the new pane is the caller's job.
 *
 * @returns The pane now holding the mount, or null when the window has no
 *     library view. The mount then stays where it is, which may be detached
 *     along with a closed view, until a library view appears again.
 */
export function placeLibraryMount(win: Window, mount: Element): HTMLElement | null {
    const pane = activeItemPane(win);
    if (!pane) return null;
    const previous = mount.parentElement;
    if (previous !== pane) {
        if (previous) {
            for (const child of Array.from(previous.children)) {
                if (child !== mount) (child as HTMLElement).style?.removeProperty('display');
            }
        }
        pane.appendChild(mount);
    }
    return pane;
}
