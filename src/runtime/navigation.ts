type MainWindow = ReturnType<typeof Zotero.getMainWindow>;

export class WindowUnavailableError extends Error {
    readonly code = 'window_unavailable';
    constructor() { super('The destination Zotero window is unavailable'); }
}

export function isMainWindow(win: Window | null | undefined): win is MainWindow {
    return !!win && !win.closed && !!(win as MainWindow).ZoteroPane
        && !!(win as MainWindow).Zotero_Tabs;
}

/** Resolve borrowed UI hosts without confusing reader windows with chat runtimes. */
export function contextMainWindow(origin?: Window | null): MainWindow | null {
    if (!origin || origin.closed) return null;
    const runtime = origin.__beaverRuntime;
    if (runtime?.status === 'closing') return null;
    if (runtime && isMainWindow(runtime.contextWindow)) return runtime.contextWindow;
    if (isMainWindow(origin)) return origin;
    const owner = origin.__beaverOwnerWindowRef?.deref();
    return owner && owner !== origin ? contextMainWindow(owner) : null;
}

/** Originless user commands choose once; local commands never fall through to another chat. */
export async function resolveNavigationWindow(origin?: Window | null): Promise<MainWindow> {
    if (origin) {
        const target = contextMainWindow(origin);
        if (target) return target;
        throw new WindowUnavailableError();
    }
    let target = Zotero.getMainWindow();
    if (!isMainWindow(target)) target = (Zotero as any).openMainWindow();
    const deadline = Date.now() + 15000;
    while (target && !target.closed && (!isMainWindow(target) || !(target.ZoteroPane as any).itemsView)) {
        if (Date.now() >= deadline) throw new WindowUnavailableError();
        await Zotero.Promise.delay(50);
    }
    if (!isMainWindow(target)) throw new WindowUnavailableError();
    return target;
}

/** Main origins stay local; standalone reader/note commands choose a live chat. */
export async function resolveChatWindow(origin?: Window | null): Promise<MainWindow> {
    if (origin?.closed) throw new WindowUnavailableError();
    const hasLocalOwner = origin && (isMainWindow(origin) || origin.__beaverRuntime || origin.__beaverOwnerWindowRef);
    const win = await resolveNavigationWindow(hasLocalOwner ? origin : undefined);
    const deadline = Date.now() + 15000;
    while (!win.closed && win.__beaverRuntime?.status !== 'ready') {
        if (win.__beaverRuntime?.status === 'closing' || Date.now() >= deadline) throw new WindowUnavailableError();
        await Zotero.Promise.delay(50);
    }
    if (win.closed || win.__beaverRuntime?.status === 'closing' || !win.__beaverEventBus) {
        throw new WindowUnavailableError();
    }
    return win;
}

/** Tagged notifications are filtered; legacy notifications require reading local tab state. */
export function acceptsTabEvent(win: MainWindow, ids: readonly (string | number)[], extraData: any): boolean {
    const tabs = win?.Zotero_Tabs as any;
    if (!tabs || win.closed) return false;
    return ids.some(id => {
        if (typeof tabs.isOwnTabEvent === 'function') return tabs.isOwnTabEvent(extraData, id);
        const windowID = extraData?.[id]?.windowID;
        return windowID == null || tabs.windowID == null || windowID === tabs.windowID;
    });
}

/** Untagged events are hints: always read the receiving window's actual selection. */
export function selectedTabIfAccepted(win: MainWindow, ids: readonly (string | number)[], extraData: any) {
    if (!acceptsTabEvent(win, ids, extraData)) return undefined;
    return win.Zotero_Tabs._tabs.find(tab => tab.id === win.Zotero_Tabs.selectedID);
}
