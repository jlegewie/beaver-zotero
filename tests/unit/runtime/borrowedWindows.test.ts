import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { beforeEach, expect, it, vi } from 'vitest';
import { BeaverUIFactory } from '../../../src/ui/ui';

vi.mock('../../../src/utils/prefs', () => ({ getPref: vi.fn() }));
vi.mock('../../../src/utils/locale', () => ({ getString: vi.fn(), getLocaleID: vi.fn() }));
vi.mock('../../../src/utils/keyboardManager', () => ({ KeyboardManager: vi.fn() }));

function main() {
    return { closed: false, ZoteroPane: {}, Zotero_Tabs: {}, openDialog: vi.fn(), BeaverReact: {
        renderWindowSidebar: vi.fn(), renderPreferencesWindow: vi.fn(), unmountFromElement: vi.fn(),
    } } as any;
}
let a: any, b: any;
beforeEach(() => {
    vi.restoreAllMocks();
    a = main(); b = main();
    vi.stubGlobal('Zotero', { getMainWindow: vi.fn(() => b), debug: vi.fn() });
    vi.spyOn(BeaverUIFactory, 'findBeaverWindow').mockReturnValue(undefined);
    vi.spyOn(BeaverUIFactory, 'findPreferencesWindow').mockReturnValue(undefined);
});

it.each(['chat', 'preferences'])('pins the %s owner at creation and closes it with that owner', kind => {
    const borrowed: any = { closed: false, close: vi.fn() };
    a.openDialog.mockReturnValue(borrowed);
    if (kind === 'chat') BeaverUIFactory.openBeaverWindow(undefined, a);
    else BeaverUIFactory.openPreferencesWindow('actions', '', 'action', a);
    expect(a.openDialog).toHaveBeenCalledOnce();
    expect(b.openDialog).not.toHaveBeenCalled();
    const args = a.openDialog.mock.calls[0][3];
    expect(args.ownerWindowRef.deref()).toBe(a);
    expect(borrowed.__beaverOwnerWindowRef.deref()).toBe(a);
    vi.mocked(kind === 'chat' ? BeaverUIFactory.findBeaverWindow : BeaverUIFactory.findPreferencesWindow).mockReturnValue(borrowed);
    BeaverUIFactory.closeWindowsRenderedBy(b);
    expect(borrowed.close).not.toHaveBeenCalled();
    BeaverUIFactory.closeWindowsRenderedBy(a);
    expect(borrowed.close).toHaveBeenCalledOnce();
});

it.each(['chat', 'preferences'])('focusing an existing %s retains its original renderer', kind => {
    const borrowed: any = { closed: false, focus: vi.fn(), __beaverOwnerWindowRef: new WeakRef(a) };
    vi.mocked(kind === 'chat' ? BeaverUIFactory.findBeaverWindow : BeaverUIFactory.findPreferencesWindow).mockReturnValue(borrowed);
    if (kind === 'chat') BeaverUIFactory.openBeaverWindow(undefined, b);
    else BeaverUIFactory.openPreferencesWindow('billing', undefined, undefined, b);
    expect(borrowed.focus).toHaveBeenCalledOnce();
    expect(borrowed.__beaverOwnerWindowRef.deref()).toBe(a);
    expect(b.openDialog).not.toHaveBeenCalled();
});

for (const name of ['beaverWindow', 'beaverPreferences']) {
    function chromePage(ownerRef?: WeakRef<any>, opener = a, initialization = Promise.resolve()) {
        const container = {};
        const win: any = { closed: false, opener, arguments: [{ ownerWindowRef: ownerRef }], addEventListener: vi.fn() };
        win.close = vi.fn(() => { win.closed = true; });
        const context: any = { window: win, document: { getElementById: () => container }, WeakRef,
            ChromeUtils: { importESModule: () => ({ Zotero: { ...Zotero, initializationPromise: initialization,
                uiReadyPromise: Promise.resolve(), UIProperties: { registerRoot: vi.fn() } } }) } };
        runInNewContext(readFileSync(`addon/content/${name}.js`, 'utf8'), context);
        return { win, context, container };
    }
    it(`${name} renders and unmounts from its explicit owner despite foreign focus and opener`, async () => {
        const { win, context, container } = chromePage(new WeakRef(a), b);
        await context.onLoad();
        expect(win.__beaverOwnerWindowRef.deref()).toBe(a);
        const render = name === 'beaverWindow' ? 'renderWindowSidebar' : 'renderPreferencesWindow';
        expect(a.BeaverReact[render]).toHaveBeenCalled();
        expect(b.BeaverReact[render]).not.toHaveBeenCalled();
        context.onUnload();
        expect(a.BeaverReact.unmountFromElement).toHaveBeenCalledWith(container);
        expect(Zotero.getMainWindow).not.toHaveBeenCalled();
    });
    it(`${name} accepts a validated opener when no owner argument is supplied`, async () => {
        const { win, context } = chromePage();
        await context.onLoad();
        expect(win.__beaverOwnerWindowRef.deref()).toBe(a);
    });
    it.each(['owner', 'surface'])(`${name} does not mount after its %s closes during initialization`, async kind => {
        let ready!: () => void;
        const { win, context } = chromePage(new WeakRef(a), a, new Promise<void>(resolve => { ready = resolve; }));
        const loading = context.onLoad();
        expect(win.__beaverOwnerWindowRef.deref()).toBe(a);
        if (kind === 'owner') a.closed = true;
        else win.close();
        ready();
        await loading;
        expect(a.BeaverReact.renderWindowSidebar).not.toHaveBeenCalled();
        expect(a.BeaverReact.renderPreferencesWindow).not.toHaveBeenCalled();
        expect(win.closed).toBe(true);
    });
    it(`${name} never falls back from a closed explicit owner to a live opener`, async () => {
        a.closed = true;
        const { win, context } = chromePage(new WeakRef(a), b);
        await context.onLoad();
        expect(win.closed).toBe(true);
        expect(b.BeaverReact.renderWindowSidebar).not.toHaveBeenCalled();
        expect(b.BeaverReact.renderPreferencesWindow).not.toHaveBeenCalled();
    });
}
