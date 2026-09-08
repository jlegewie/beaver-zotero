import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BeaverInstance } from '../../../src/runtime/instance';

vi.mock('../../../src/utils/prefs', () => ({ getPref: vi.fn(() => 'J') }));
vi.mock('../../../src/utils/locale', () => ({ getString: vi.fn(() => 'Beaver'), getLocaleID: vi.fn() }));
vi.mock('../../../src/utils/keyboardManager', () => ({ KeyboardManager: vi.fn() }));

const doms: JSDOM[] = [];
function makeWindow() {
    const dom = new JSDOM(`<div id="zotero-item-pane"><div id="original-library"></div>
        <div id="beaver-pane-library" style="display:none"></div></div>
        <div id="zotero-context-pane"><div id="beaver-pane-reader" style="display:none"></div></div>
        <button id="zotero-beaver-tb-chat-toggle"></button>`, { url: "https://example.test" });
    doms.push(dom);
    const win = dom.window as unknown as Window;
    (win as any).ZoteroPane = { itemPane: win.document.getElementById('zotero-item-pane') };
    (win as any).ZoteroContextPane = { collapsed: false, togglePane: vi.fn() };
    (win as any).Zotero_Tabs = { selectedType: 'library' };
    (win.document as any).createXULElement = (tag: string) => win.document.createElement(tag);
    return win;
}

beforeEach(() => {
    vi.clearAllMocks();
    (Zotero as any).Reader = { onChangeSidebarWidth: null, getSidebarWidth: () => 350 };
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
    const state = { isVisible: true, isLibraryTab: true, collapseState: { library: null, reader: null } };
    managerA.updateUI(state);
    expect(a.document.getElementById('zotero-beaver-tb-chat-toggle')?.hasAttribute('selected')).toBe(true);
    expect(b.document.getElementById('zotero-beaver-tb-chat-toggle')?.hasAttribute('selected')).toBe(false);
    managerB.updateUI(state);
    const wrapper = Zotero.Reader.onChangeSidebarWidth;
    instance.markClosing(a);
    managerA.cleanup();
    instance.detachWindow(a);
    expect(b.document.getElementById('zotero-beaver-tb-chat-toggle')?.hasAttribute('selected')).toBe(true);
    expect(Zotero.Reader.onChangeSidebarWidth).toBe(wrapper);
    managerB.cleanup();
    instance.disposeInstance();
});

it('ignores toggles before initialization and after closing without touching DOM or timers', async () => {
    vi.resetModules();
    const { initializeWindowRuntime } = await import('../../../react/runtime/windowRuntime');
    const { uiManager } = await import('../../../react/ui/UIManager');
    const state = { isVisible: true, isLibraryTab: true, collapseState: { library: null, reader: null } };
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
    const subscribe = vi.spyOn(instance, 'subscribeReaderWidth');
    expect(() => uiManager.updateUI(state)).not.toThrow();
    instance.detachWindow(win);
    expect(() => uiManager.updateUI(state)).not.toThrow();
    expect(win.document.body.innerHTML).toBe(html);
    expect(timer).not.toHaveBeenCalled();
    expect(subscribe).not.toHaveBeenCalled();
    instance.disposeInstance();
});

describe('mount teardown', () => {
    it('unmounts roots while their DOM is attached, then removes the renderer bridge', async () => {
        const { BeaverUIFactory } = await import('../../../src/ui/ui');
        const win = makeWindow();
        const root = win.document.createElement('div');
        root.id = 'beaver-react-root-library';
        win.document.getElementById('beaver-pane-library')!.appendChild(root);
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
