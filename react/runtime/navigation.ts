import { logger } from '@beaver/agent-core/platform/logger';
import { resolveNavigationWindow, WindowUnavailableError } from '../../src/runtime/navigation';
import { getContextWindow } from './windowRuntime';

/** Legacy APIs read the active main window synchronously when opening a tab. */
function assertLegacyTarget(win: ReturnType<typeof Zotero.getMainWindow>): void {
    if (!win.closed && win.__beaverRuntime?.status !== 'closing' && Zotero.getMainWindow() === win) return;
    void import(/* webpackMode: 'eager' */ '../utils/navigationNotice').then(({ notifyNavigationUnavailable }) => {
        notifyNavigationUnavailable(win);
    }).catch(error => logger(`Navigation notice: ${error}`, 2));
    throw new WindowUnavailableError();
}

async function focusLegacyTarget(win: ReturnType<typeof Zotero.getMainWindow>): Promise<void> {
    win.focus();
    // Native activation can update the window mediator after focus() returns.
    for (let attempt = 0; attempt < 40 && !win.closed
        && win.__beaverRuntime?.status !== 'closing' && Zotero.getMainWindow() !== win; attempt++) {
        await Zotero.Promise.delay(25);
    }
    assertLegacyTarget(win);
}

/** Pin a real main window before any reader initialization awaits. */
export async function openReader(
    itemID: number, location?: any, options: Record<string, any> = {},
    origin: Window = getContextWindow(),
): Promise<any> {
    const win = await resolveNavigationWindow(origin);
    // Older Zotero releases ignore the window option and use the focused main window.
    // Recheck activation immediately before each native call that uses global focus.
    const legacy = typeof (win.Zotero_Tabs as any).isOwnTabEvent !== 'function';
    if (legacy && !options.openInWindow && !options.allowDuplicate) {
        const tab = win.Zotero_Tabs._tabs?.find((tab: any) => tab.data?.itemID === itemID);
        const existing: any = tab && Zotero.Reader.getByTabID(tab.id);
        if (existing && tab) {
            win.Zotero_Tabs.select(tab.id);
            if (location) {
                await existing._initPromise;
                if (win.closed || !win.Zotero_Tabs._tabs.some(candidate => candidate.id === tab.id)
                    || Zotero.Reader.getByTabID(tab.id) !== existing || existing._window !== win) {
                    throw new WindowUnavailableError();
                }
                await existing.navigate(location);
            }
            return existing;
        }
        if (tab) {
            // Selecting an unloaded local tab invokes Zotero's restore hook.
            // That hook uses the active main window on legacy releases.
            const restoring = tab.type === 'reader-unloaded';
            await focusLegacyTarget(win);
            assertLegacyTarget(win);
            win.Zotero_Tabs.select(tab.id, false, { location });
            const deadline = Date.now() + 15000;
            let restored: any;
            while (!(restored = Zotero.Reader.getByTabID(tab.id))) {
                if (win.closed || !win.Zotero_Tabs._tabs.some(candidate => candidate.id === tab.id)
                    || Date.now() >= deadline) throw new WindowUnavailableError();
                await Zotero.Promise.delay(50);
            }
            if (win.closed || restored._window !== win) throw new WindowUnavailableError();
            // A fresh restore consumes location in the native load hook.
            // An already-loading tab needs it after initialization instead.
            if (location && !restoring) {
                await restored._initPromise;
                if (win.closed || !win.Zotero_Tabs._tabs.some(candidate => candidate.id === tab.id)
                    || Zotero.Reader.getByTabID(tab.id) !== restored || restored._window !== win) {
                    throw new WindowUnavailableError();
                }
                await restored.navigate(location);
            }
            return restored;
        }
        // Legacy duplicate detection is global. A new tab must not select a
        // different window's instance of the same attachment.
        options = { ...options, allowDuplicate: true };
    }
    if (legacy) {
        await focusLegacyTarget(win);
        assertLegacyTarget(win);
    }
    const opened = await Zotero.Reader.open(itemID, location, { ...options, window: win } as any);
    if (win.closed) throw new WindowUnavailableError();
    const reader = opened ?? Zotero.Reader.getByTabID(win.Zotero_Tabs.selectedID);
    if (reader && !options.openInWindow && reader._window && reader._window !== win) {
        throw new WindowUnavailableError();
    }
    return reader;
}

export async function openNote(itemID: number, origin: Window = getContextWindow()): Promise<any> {
    const win = await resolveNavigationWindow(origin);
    if (typeof (Zotero as any).Notes?.open === 'function') {
        const legacy = typeof (win.Zotero_Tabs as any).isOwnTabEvent !== 'function';
        if (legacy) {
            const readyLocalEditor = async (editor: any) => {
                await editor._initPromise;
                if (win.closed || !win.Zotero_Tabs._tabs.some(tab => tab.id === editor.tabID)
                    || !(Zotero as any).Notes._editorInstances.includes(editor)) {
                    throw new WindowUnavailableError();
                }
                return editor;
            };
            const existing = (Zotero as any).Notes._editorInstances?.find((editor: any) =>
                editor.itemID === itemID && editor.tabID
                && win.Zotero_Tabs._tabs?.some((tab: any) => tab.id === editor.tabID));
            if (existing) {
                win.Zotero_Tabs.select(existing.tabID);
                return readyLocalEditor(existing);
            }
            const tab = win.Zotero_Tabs._tabs?.find(candidate => candidate.data?.itemID === itemID);
            await focusLegacyTarget(win);
            assertLegacyTarget(win);
            if (tab) {
                // Restore the destination's unloaded note through its native tab hook.
                win.Zotero_Tabs.select(tab.id);
                const deadline = Date.now() + 15000;
                for (;;) {
                    if (win.closed || !win.Zotero_Tabs._tabs.some(candidate => candidate.id === tab.id)) {
                        throw new WindowUnavailableError();
                    }
                    const restored = (Zotero as any).Notes._editorInstances?.find((editor: any) =>
                        editor.itemID === itemID && editor.tabID === tab.id);
                    if (restored) return readyLocalEditor(restored);
                    if (Date.now() >= deadline) throw new WindowUnavailableError();
                    await Zotero.Promise.delay(50);
                }
            }
        }
        const editor = await (Zotero as any).Notes.open(itemID, undefined, { window: win, ...(legacy ? { allowDuplicate: true } : {}) });
        if (win.closed) throw new WindowUnavailableError();
        if (editor?.tabID && !win.Zotero_Tabs._tabs?.some((tab: any) => tab.id === editor.tabID)) throw new WindowUnavailableError();
        return editor;
    } else {
        await win.ZoteroPane.openNoteWindow(itemID);
    }
}

/** Preserve Zotero's external-file preferences while targeting the originating pane. */
export async function viewAttachment(itemID: number, origin?: Window): Promise<void> {
    try {
        const win = await resolveNavigationWindow(origin ?? getContextWindow());
        if (typeof (win.Zotero_Tabs as any).isOwnTabEvent !== 'function') {
            await focusLegacyTarget(win);
            assertLegacyTarget(win);
        }
        await win.ZoteroPane.viewAttachment(itemID);
    } catch (error) {
        logger(`viewAttachment: ${error}`, 2);
    }
}
