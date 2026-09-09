/** Runtime mock for older single-window fixtures; multi-window tests use explicit runtimes. */
export function singleWindowRuntimeMock() {
    return {
        getHostWindow: () => (globalThis as any).Zotero.getMainWindow(),
        getContextWindow: () => {
            const zotero = (globalThis as any).Zotero;
            const win = zotero.getMainWindow?.() ?? {};
            if (zotero.getActiveZoteroPane) win.ZoteroPane = zotero.getActiveZoteroPane();
            return win;
        },
    };
}
