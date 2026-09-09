import { logger } from '@beaver/agent-core/platform/logger';
import { resolveNavigationWindow, WindowUnavailableError } from '../../src/runtime/navigation';
import { getContextWindow } from './windowRuntime';

/** Legacy APIs cannot accept a target; never silently open in a different window. */
function focusLegacyTarget(win: ReturnType<typeof Zotero.getMainWindow>): void {
    win.focus();
    if (Zotero.getMainWindow() !== win) throw new WindowUnavailableError();
}

/** Pin a real main window before any reader initialization awaits. */
export async function openReader(
    itemID: number, location?: any, options: Record<string, any> = {},
    origin: Window = getContextWindow(),
): Promise<any> {
    const win = await resolveNavigationWindow(origin);
    // Older Zotero releases ignore the window option and use the focused main window.
    // Focus immediately before invoking the native method (no intervening await).
    const legacy = typeof (win.Zotero_Tabs as any).isOwnTabEvent !== 'function';
    if (legacy && !options.openInWindow && !options.allowDuplicate) {
        const tab = win.Zotero_Tabs._tabs?.find((tab: any) => tab.data?.itemID === itemID);
        const existing: any = tab && Zotero.Reader.getByTabID(tab.id);
        if (existing && tab) {
            win.Zotero_Tabs.select(tab.id);
            if (location) await existing.navigate(location);
            return existing;
        }
        // Legacy duplicate detection is global. A new tab must not select a
        // different window's instance of the same attachment.
        options = { ...options, allowDuplicate: true };
    }
    if (legacy) focusLegacyTarget(win);
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
            const existing = (Zotero as any).Notes._editorInstances?.find((editor: any) =>
                editor.itemID === itemID && editor.tabID
                && win.Zotero_Tabs._tabs?.some((tab: any) => tab.id === editor.tabID));
            if (existing) {
                win.Zotero_Tabs.select(existing.tabID);
                return existing;
            }
            focusLegacyTarget(win);
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
        if (typeof (win.Zotero_Tabs as any).isOwnTabEvent !== 'function') focusLegacyTarget(win);
        await win.ZoteroPane.viewAttachment(itemID);
    } catch (error) {
        logger(`viewAttachment: ${error}`, 2);
    }
}
