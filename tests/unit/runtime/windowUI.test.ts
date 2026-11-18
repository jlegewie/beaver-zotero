import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BeaverInstance } from '../../../src/runtime/instance';
import { createSidebarMount } from '../../../src/ui/libraryPane';

const prefs = vi.hoisted(() => ({ values: {} as Record<string, unknown> }));
vi.mock('../../../src/utils/prefs', () => ({
    getPref: vi.fn((key: string) => prefs.values[key] ?? 'J'),
    setPref: vi.fn((key: string, value: unknown) => { prefs.values[key] = value; }),
}));
vi.mock('../../../src/utils/locale', () => ({ getString: vi.fn(() => 'Beaver'), getLocaleID: vi.fn() }));
vi.mock('../../../src/utils/keyboardManager', () => ({ KeyboardManager: vi.fn() }));

const doms: JSDOM[] = [];
function makeWindow() {
    const dom = new JSDOM(`<div id="zotero-item-pane" width="337" style="width: 337px"><div id="original-library"></div></div>
        <div id="zotero-context-pane" width="600" style="width: 600px"><div id="original-reader"></div></div>
        <button id="zotero-beaver-tb-chat-toggle"></button>`, { url: "https://example.test" });
    doms.push(dom);
    const win = dom.window as unknown as Window;
    (win as any).ZoteroPane = { itemPane: win.document.getElementById('zotero-item-pane') };
    (win as any).ZoteroContextPane = { collapsed: false, togglePane: vi.fn() };
    (win as any).Zotero_Tabs = { selectedType: 'library' };
    (win.document as any).createXULElement = (tag: string) => win.document.createElement(tag);
    return win;
}

/** Create the window's sidebar element the way the renderer does, and hand it to the UI manager. */
function addSidebar(win: Window, manager: { setSidebarMount(mount: HTMLElement): void }): HTMLElement {
    const { mountPoint } = createSidebarMount(win.document);
    manager.setSidebarMount(mountPoint);
    return mountPoint;
}

beforeEach(() => {
    vi.clearAllMocks();
    prefs.values = {};
    (Zotero as any).Reader = { onChangeSidebarWidth: null };
    (globalThis as any).ztoolkit = { log: vi.fn() };
});
afterEach(() => { for (const dom of doms.splice(0)) dom.window.close(); });

it('updates and cleans only the owning window even when another window has focus', async () => {
    const instance = new BeaverInstance();
    (Zotero as any).Beaver = { runtime: instance };
    const a = makeWindow(), b = makeWindow();
    async function load(win: Window) {
        vi.resetModules();
        const { initializeWindowRuntime } = await import('../../../react/runtime/windowRuntime');
        initializeWindowRuntime(instance.attachWindow(win));
        return (await import('../../../react/ui/UIManager')).uiManager;
    }
    const managerA = await load(a), managerB = await load(b);
    vi.mocked(Zotero.getMainWindow).mockReturnValue(b as any);
    const state = { isVisible: true, isLibraryTab: true };
    managerA.updateUI(state);
    expect(a.document.getElementById('zotero-beaver-tb-chat-toggle')?.hasAttribute('selected')).toBe(true);
    expect(b.document.getElementById('zotero-beaver-tb-chat-toggle')?.hasAttribute('selected')).toBe(false);
    managerB.updateUI(state);
    instance.markClosing(a);
    managerA.cleanup();
    instance.detachWindow(a);
    expect(b.document.getElementById('zotero-beaver-tb-chat-toggle')?.hasAttribute('selected')).toBe(true);
    managerB.cleanup();
    instance.disposeInstance();
});

it('hides the library sidebar when closing restores a collapsed item pane', async () => {
    vi.resetModules();
    const instance = new BeaverInstance();
    (Zotero as any).Beaver = { runtime: instance };
    const win = makeWindow();
    const { initializeWindowRuntime } = await import('../../../react/runtime/windowRuntime');
    const { uiManager } = await import('../../../react/ui/UIManager');
    initializeWindowRuntime(instance.attachWindow(win));
    const mount = addSidebar(win, uiManager);
    const pane = win.document.getElementById('zotero-item-pane') as any;
    pane.collapsed = true;
    uiManager.updateUI({ isVisible: true, isLibraryTab: true });
    expect(pane.collapsed).toBe(false);
    uiManager.updateUI({ isVisible: false, isLibraryTab: true });
    expect(pane.collapsed).toBe(true);
    expect(mount.style.display).toBe('none');
    expect(win.document.getElementById('original-library')!.style.display).toBe('');
    instance.markClosing(win);
    uiManager.cleanup();
    instance.disposeInstance();
});

it('ignores toggles before initialization and after closing without touching DOM or timers', async () => {
    vi.resetModules();
    const { initializeWindowRuntime } = await import('../../../react/runtime/windowRuntime');
    const { uiManager } = await import('../../../react/ui/UIManager');
    const state = { isVisible: true, isLibraryTab: true };
    expect(() => uiManager.updateUI(state)).not.toThrow();
    const instance = new BeaverInstance();
    (Zotero as any).Beaver = { runtime: instance };
    const win = makeWindow();
    initializeWindowRuntime(instance.attachWindow(win));
    uiManager.updateUI(state);
    instance.markClosing(win);
    uiManager.cleanup();
    const html = win.document.body.innerHTML;
    const timer = vi.spyOn(win, 'setTimeout');
    expect(() => uiManager.updateUI(state)).not.toThrow();
    instance.detachWindow(win);
    expect(() => uiManager.updateUI(state)).not.toThrow();
    expect(win.document.body.innerHTML).toBe(html);
    expect(timer).not.toHaveBeenCalled();
    instance.disposeInstance();
});

describe('mount teardown', () => {
    it('unmounts roots while their DOM is attached, then removes the renderer bridge', async () => {
        const { BeaverUIFactory } = await import('../../../src/ui/ui');
        const win = makeWindow();
        const mount = win.document.createElement('div');
        mount.id = 'beaver-pane-sidebar';
        win.document.getElementById('zotero-item-pane')!.appendChild(mount);
        const root = win.document.createElement('div');
        root.id = 'beaver-react-root-sidebar';
        mount.appendChild(root);
        const unmount = vi.fn(() => { expect(root.isConnected).toBe(true); return true; });
        const dispose = vi.fn(() => { expect(root.isConnected).toBe(true); });
        (win as any).BeaverReact = { unmountFromElement: unmount, disposeRuntime: dispose };
        BeaverUIFactory.removeChatPanel(win as any);
        expect(unmount).toHaveBeenCalledWith(root);
        expect(dispose).toHaveBeenCalledOnce();
        expect(root.isConnected).toBe(false);
        expect((win as any).BeaverReact).toBeUndefined();
        BeaverUIFactory.removeChatPanel(win as any);
        expect(dispose).toHaveBeenCalledOnce();
    });

    it('ignores a late bundle load after its window was detached', async () => {
        const { BeaverUIFactory } = await import('../../../src/ui/ui');
        const instance = new BeaverInstance();
        (Zotero as any).Beaver = { runtime: instance };
        const win = makeWindow();
        instance.attachWindow(win);
        BeaverUIFactory.registerChatPanel(win as any);
        const script = win.document.querySelector('script')!;
        instance.detachWindow(win);
        const initialize = vi.fn();
        (win as any).BeaverReact = { initializeRuntime: initialize };
        script.dispatchEvent(new win.Event('load'));
        expect(initialize).not.toHaveBeenCalled();
        expect(win.document.getElementById('beaver-global-initializer-root')).toBeNull();
    });
});

it('filters foreign native context-pane events and restores the native handler on cleanup', async () => {
    vi.resetModules();
    const { initializeWindowRuntime } = await import('../../../react/runtime/windowRuntime');
    const { uiManager } = await import('../../../react/ui/UIManager');
    const instance = new BeaverInstance();
    (Zotero as any).Beaver = { runtime: instance };
    const win = makeWindow();
    (win as any).Zotero_Tabs.selectedID = 'reader-a';
    const pane = win.document.createElement('div') as any;
    pane.id = 'zotero-context-pane-inner';
    win.document.body.appendChild(pane);
    const original = vi.fn(function(this: any) { expect(this).toBe(pane); return 'handled'; });
    pane._handleTabSelect = original;
    initializeWindowRuntime(instance.attachWindow(win));
    const state = { isVisible: false, isLibraryTab: false };
    uiManager.updateUI(state);
    const scoped = pane._handleTabSelect;
    uiManager.updateUI(state);
    expect(pane._handleTabSelect).toBe(scoped);
    pane._handleTabSelect('select', 'tab', ['zotero-pane'], {});
    pane._handleTabSelect('load', 'tab', ['reader-b'], {});
    expect(original).not.toHaveBeenCalled();
    expect(pane._handleTabSelect('select', 'tab', ['reader-a'], {})).toBe('handled');
    uiManager.cleanup();
    expect(pane._handleTabSelect).toBe(original);
    instance.disposeInstance();
});

describe('one sidebar for library and reader tabs', () => {
    async function setup() {
        vi.resetModules();
        const instance = new BeaverInstance();
        (Zotero as any).Beaver = { runtime: instance };
        const win = makeWindow();
        const { initializeWindowRuntime } = await import('../../../react/runtime/windowRuntime');
        const { uiManager } = await import('../../../react/ui/UIManager');
        initializeWindowRuntime(instance.attachWindow(win));
        const mount = addSidebar(win, uiManager);
        const itemPane = win.document.getElementById('zotero-item-pane')!;
        const contextPane = win.document.getElementById('zotero-context-pane')!;
        const done = () => { instance.markClosing(win); uiManager.cleanup(); instance.disposeInstance(); };
        return { win, uiManager, mount, itemPane, contextPane, done };
    }
    const settle = () => new Promise(resolve => setTimeout(resolve, 0));
    /** Drag a splitter: Gecko writes the size to the pane's attribute and inline width. */
    async function drag(win: Window, pane: HTMLElement, width: number) {
        const splitter = win.document.createElement('splitter');
        win.document.body.appendChild(splitter);
        splitter.dispatchEvent(new win.MouseEvent('mousedown', { bubbles: true }));
        pane.setAttribute('width', String(width));
        pane.style.width = `${width}px`;
        await settle();
        splitter.dispatchEvent(new win.MouseEvent('mouseup', { bubbles: true }));
        await settle();
        splitter.remove();
    }

    it('moves the same element between the item pane and the context pane, swapping which pane shows its own content', async () => {
        const { win, uiManager, mount, itemPane, contextPane, done } = await setup();
        const library = win.document.getElementById('original-library')!;
        const reader = win.document.getElementById('original-reader')!;

        uiManager.updateUI({ isVisible: true, isLibraryTab: true });
        expect(mount.parentElement).toBe(itemPane);
        expect(mount.style.display).toBe('');
        expect(library.style.display).toBe('none');

        uiManager.updateUI({ isVisible: true, isLibraryTab: false });
        expect(mount.parentElement).toBe(contextPane);
        expect(mount.style.display).toBe('');
        expect(library.style.display).toBe('');
        expect(reader.style.display).toBe('none');
        expect(uiManager.isShownIn(contextPane)).toBe(true);
        expect(uiManager.isShownIn(itemPane)).toBe(false);

        uiManager.updateUI({ isVisible: false, isLibraryTab: false });
        expect(mount.style.display).toBe('none');
        expect(reader.style.display).toBe('');
        done();
    });

    it("moves to another library view's item pane and uncovers what it hid in the previous one", async () => {
        const { win, uiManager, mount, itemPane, done } = await setup();
        uiManager.updateUI({ isVisible: true, isLibraryTab: true });
        const second = win.document.createElement('div');
        second.innerHTML = '<div id="second-content"></div>';
        win.document.body.appendChild(second);
        (win as any).ZoteroPane.itemPane = second;

        uiManager.updateUI({ isVisible: true, isLibraryTab: true });
        expect(mount.parentElement).toBe(second);
        expect(win.document.getElementById('original-library')!.style.display).toBe('');
        expect(win.document.getElementById('second-content')!.style.display).toBe('none');
        expect(itemPane.style.width).toBe('337px');
        done();
    });

    it('reports the sidebar shown only in the library view it moved to, while the one it left collapses again', async () => {
        const { win, uiManager, itemPane, done } = await setup();
        (itemPane as any).collapsed = true;
        uiManager.updateUI({ isVisible: true, isLibraryTab: true });
        expect((itemPane as any).collapsed).toBe(false);
        const second = win.document.createElement('div');
        win.document.body.appendChild(second);
        (win as any).ZoteroPane.itemPane = second;

        uiManager.updateUI({ isVisible: true, isLibraryTab: true });
        expect((itemPane as any).collapsed).toBe(true);
        expect(uiManager.isShownIn(itemPane)).toBe(false);
        expect(uiManager.isShownIn(second)).toBe(true);
        done();
    });

    it('places a sidebar that left the document with a closed library view again', async () => {
        const { win, uiManager, mount, itemPane, done } = await setup();
        uiManager.updateUI({ isVisible: true, isLibraryTab: true });
        itemPane.remove();
        expect(mount.isConnected).toBe(false);
        const next = win.document.createElement('div');
        win.document.body.appendChild(next);
        (win as any).ZoteroPane.itemPane = next;

        uiManager.updateUI({ isVisible: true, isLibraryTab: true });
        expect(mount.parentElement).toBe(next);
        expect(mount.isConnected).toBe(true);
        done();
    });

    it('keeps the scroll offsets inside the sidebar when it moves to the other pane', async () => {
        const { win, uiManager, mount, contextPane, done } = await setup();
        uiManager.updateUI({ isVisible: true, isLibraryTab: true });
        // Gecko resets the scroll offsets of a subtree that is moved.
        const thread = win.document.createElement('div');
        mount.firstElementChild!.appendChild(thread);
        let top = 0;
        Object.defineProperty(thread, 'scrollTop', { get: () => top, set: (value: number) => { top = value; }, configurable: true });
        const append = contextPane.appendChild.bind(contextPane);
        contextPane.appendChild = ((node: Node) => { top = 0; return append(node); }) as any;
        top = 480;

        uiManager.updateUI({ isVisible: true, isLibraryTab: false });
        expect(mount.parentElement).toBe(contextPane);
        expect(top).toBe(480);
        done();
    });

    it('reads the scroll offsets before the pane it leaves shows its own content again', async () => {
        const { win, uiManager, mount, done } = await setup();
        uiManager.updateUI({ isVisible: true, isLibraryTab: true });
        const thread = win.document.createElement('div');
        mount.firstElementChild!.appendChild(thread);
        let top = 480;
        Object.defineProperty(thread, 'scrollTop', { get: () => top, set: (value: number) => { top = value; }, configurable: true });
        // The item pane's own content narrows the sidebar as it comes back, and
        // the browser re-anchors the offset of the re-wrapped thread.
        const library = win.document.getElementById('original-library')!;
        const removeProperty = library.style.removeProperty.bind(library.style);
        library.style.removeProperty = ((name: string) => { top = 5104; return removeProperty(name); }) as any;

        uiManager.updateUI({ isVisible: true, isLibraryTab: false });
        expect(top).toBe(480);
        done();
    });

    it('opens the context pane a library tab collapsed before moving the sidebar into it', async () => {
        const { uiManager, mount, contextPane, done } = await setup();
        uiManager.updateUI({ isVisible: true, isLibraryTab: true });
        contextPane.setAttribute('collapsed', 'true');
        let collapsedOnArrival: boolean | null = null;
        const append = contextPane.appendChild.bind(contextPane);
        contextPane.appendChild = ((node: Node) => {
            collapsedOnArrival = contextPane.hasAttribute('collapsed');
            return append(node);
        }) as any;

        uiManager.updateUI({ isVisible: true, isLibraryTab: false });
        expect(mount.parentElement).toBe(contextPane);
        expect(collapsedOnArrival).toBe(false);
        done();
    });

    it('writes scroll offsets back once a pane that is still collapsed lays the sidebar out', async () => {
        const { win, uiManager, mount, contextPane, done } = await setup();
        uiManager.updateUI({ isVisible: true, isLibraryTab: true });
        const thread = win.document.createElement('div');
        mount.firstElementChild!.appendChild(thread);
        let top = 0;
        Object.defineProperty(thread, 'scrollTop', { get: () => top, set: (value: number) => { top = value; }, configurable: true });
        const append = contextPane.appendChild.bind(contextPane);
        contextPane.appendChild = ((node: Node) => { top = 0; return append(node); }) as any;
        top = 480;
        let laidOut = false;
        mount.getBoundingClientRect = () => ({ width: laidOut ? 357 : 0, height: laidOut ? 800 : 0 }) as DOMRect;
        let resized: (() => void) | undefined;
        (win as any).ResizeObserver = class {
            constructor(callback: () => void) { resized = callback; }
            observe() {}
            disconnect() {}
        };

        uiManager.updateUI({ isVisible: true, isLibraryTab: false });
        expect(top).toBe(0);
        laidOut = true;
        resized!();
        expect(top).toBe(480);
        done();
    });

    it('shows the sidebar at one width in both panes and gives each pane its own width back', async () => {
        prefs.values.sidebarWidth = 420;
        const { uiManager, itemPane, contextPane, done } = await setup();

        uiManager.updateUI({ isVisible: true, isLibraryTab: true });
        expect(itemPane.style.width).toBe('420px');
        expect(itemPane.getAttribute('width')).toBe('337');

        uiManager.updateUI({ isVisible: true, isLibraryTab: false });
        expect(itemPane.style.width).toBe('337px');
        expect(contextPane.style.width).toBe('420px');
        expect(contextPane.getAttribute('width')).toBe('600');

        uiManager.updateUI({ isVisible: false, isLibraryTab: false });
        expect(contextPane.style.width).toBe('600px');
        done();
    });

    it('takes a splitter drag as the new sidebar width without changing the width Zotero persists', async () => {
        prefs.values.sidebarWidth = 420;
        const { win, uiManager, itemPane, contextPane, done } = await setup();
        const { setPref } = await import('../../../src/utils/prefs');
        uiManager.updateUI({ isVisible: true, isLibraryTab: true });

        await drag(win, itemPane, 480);
        expect(itemPane.style.width).toBe('480px');
        expect(itemPane.getAttribute('width')).toBe('337');

        uiManager.updateUI({ isVisible: true, isLibraryTab: false });
        expect(contextPane.style.width).toBe('480px');
        await new Promise(resolve => setTimeout(resolve, 300));
        expect(setPref).toHaveBeenCalledWith('sidebarWidth', 480);
        done();
    });

    it('gives the other side of the splitter its width back when a dragged pane is released', async () => {
        prefs.values.sidebarWidth = 420;
        const { win, uiManager, contextPane, done } = await setup();
        const deck = win.document.createElement('div');
        deck.setAttribute('width', '970');
        deck.style.width = '970px';
        const splitter = win.document.createElement('splitter');
        contextPane.before(deck, splitter);
        uiManager.updateUI({ isVisible: true, isLibraryTab: false });

        // A drag resizes both sides of the splitter.
        splitter.dispatchEvent(new win.MouseEvent('mousedown', { bubbles: true }));
        deck.setAttribute('width', '930');
        deck.style.width = '930px';
        contextPane.setAttribute('width', '460');
        contextPane.style.width = '460px';
        await settle();
        splitter.dispatchEvent(new win.MouseEvent('mouseup', { bubbles: true }));
        await settle();
        expect(contextPane.style.width).toBe('460px');

        uiManager.updateUI({ isVisible: false, isLibraryTab: false });
        expect(contextPane.style.width).toBe('600px');
        expect(deck.style.width).toBe('970px');
        expect(deck.getAttribute('width')).toBe('970');
        done();
    });

    it('takes a splitter drag that ends on the width Zotero persists', async () => {
        prefs.values.sidebarWidth = 420;
        const { win, uiManager, itemPane, done } = await setup();
        uiManager.updateUI({ isVisible: true, isLibraryTab: true });
        await drag(win, itemPane, 337);
        expect(itemPane.style.width).toBe('337px');
        expect(itemPane.getAttribute('width')).toBe('337');
        uiManager.updateUI({ isVisible: false, isLibraryTab: true });
        expect(itemPane.style.width).toBe('337px');
        done();
    });

    it('keeps the sidebar width when Zotero restores its saved pane width, and gives the pane that width back', async () => {
        prefs.values.sidebarWidth = 480;
        const { uiManager, itemPane, done } = await setup();
        const { setPref } = await import('../../../src/utils/prefs');
        uiManager.updateUI({ isVisible: true, isLibraryTab: true });
        // Zotero 11 does this whenever a library tab is selected.
        itemPane.style.width = '350px';
        itemPane.setAttribute('width', '350');
        await settle();
        expect(itemPane.style.width).toBe('480px');
        expect(itemPane.getAttribute('width')).toBe('350');
        await new Promise(resolve => setTimeout(resolve, 300));
        expect(setPref).not.toHaveBeenCalledWith('sidebarWidth', 350);
        uiManager.updateUI({ isVisible: false, isLibraryTab: true });
        expect(itemPane.style.width).toBe('350px');
        done();
    });

    it('keeps a width Zotero gives a pane that had none, even when it equals the sidebar width', async () => {
        prefs.values.sidebarWidth = 337;
        const { uiManager, itemPane, done } = await setup();
        itemPane.removeAttribute('width');
        uiManager.updateUI({ isVisible: true, isLibraryTab: true });
        // Zotero raises an item pane without a width to its minimum.
        itemPane.setAttribute('width', '337');
        await settle();
        expect(itemPane.getAttribute('width')).toBe('337');
        done();
    });

    it('keeps the sidebar width when Zotero re-applies its own, and keeps Zotero\'s own attribute changes', async () => {
        prefs.values.sidebarWidth = 420;
        const { uiManager, contextPane, done } = await setup();
        uiManager.updateUI({ isVisible: true, isLibraryTab: false });

        // Zotero re-applies its persisted width when a reader tab is selected.
        contextPane.style.width = '600px';
        await settle();
        expect(contextPane.style.width).toBe('420px');

        // A width Zotero itself sets on the attribute is its own.
        contextPane.setAttribute('width', '650');
        await settle();
        expect(contextPane.getAttribute('width')).toBe('650');
        expect(contextPane.style.width).toBe('420px');

        uiManager.updateUI({ isVisible: false, isLibraryTab: false });
        expect(contextPane.style.width).toBe('600px');
        done();
    });

    it('keeps the width of the pane the sidebar first opens in, and saves it', async () => {
        const { uiManager, itemPane, done } = await setup();
        const { setPref } = await import('../../../src/utils/prefs');
        itemPane.getBoundingClientRect = () => ({ width: 357 }) as DOMRect;
        uiManager.updateUI({ isVisible: true, isLibraryTab: true });
        expect(itemPane.style.width).toBe('357px');
        await new Promise(resolve => setTimeout(resolve, 300));
        expect(setPref).toHaveBeenCalledWith('sidebarWidth', 357);
        done();
    });

    it('leaves pane widths to Zotero in the stacked layout', async () => {
        prefs.values.sidebarWidth = 420;
        vi.mocked(Zotero.Prefs.get).mockImplementation((pref: string) => (pref === 'layout' ? 'stacked' : undefined));
        const { uiManager, itemPane, done } = await setup();
        uiManager.updateUI({ isVisible: true, isLibraryTab: true });
        expect(itemPane.style.width).toBe('337px');
        vi.mocked(Zotero.Prefs.get).mockReturnValue(undefined);
        done();
    });
});
