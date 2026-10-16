import { logger } from '@beaver/agent-core/platform/logger';
import { resolveNavigationWindow, WindowUnavailableError } from '../../src/runtime/navigation';
import { getContextWindow } from './windowRuntime';
import { runWindowOperation } from './libraryMutation';
import { canonicalContentTypeCorrection } from '../../src/utils/attachmentFiles';

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

/**
 * The attachment's file is not on this computer and could not be downloaded.
 * The user has already been shown Zotero's attachment-not-found dialog or sync error.
 */
export class AttachmentFileUnavailableError extends Error {
    readonly code = 'attachment_file_unavailable';
    constructor(itemID: number) { super(`The file for attachment ${itemID} is not available`); }
}

/**
 * Make sure a file attachment exists locally before the reader opens it, mirroring
 * `ZoteroPane.viewAttachment`: files Zotero has queued for download are fetched from
 * the file server first. `Zotero.Reader.open` never downloads, and opening a missing
 * file produces a blank reader tab.
 */
async function ensureAttachmentFileForReader(itemID: number, win: ReturnType<typeof Zotero.getMainWindow>): Promise<void> {
    const item = await Zotero.Items.getAsync(itemID);
    if (!item?.isFileAttachment()) return;
    const pane = win.ZoteroPane as any;
    const noLocate = !pane.collectionsView?.editable;
    const isLinkedFile = !item.isStoredFileAttachment();
    const path = item.getFilePath();
    if (!path) {
        pane.showAttachmentNotFoundDialog(item, path, { noLocate: true, notOnServer: true, linkedFile: isLinkedFile });
        throw new AttachmentFileUnavailableError(itemID);
    }
    let fileExists = false;
    try {
        fileExists = await IOUtils.exists(path);
    } catch (error) {
        Zotero.logError(error as Error);
    }
    const syncingEnabled = Zotero.Sync.Storage.Local.getEnabledForLibrary(item.libraryID);
    // A file queued for download was replaced on the server; open the new version.
    const queued = [
        Zotero.Sync.Storage.Local.SYNC_STATE_TO_DOWNLOAD,
        Zotero.Sync.Storage.Local.SYNC_STATE_FORCE_DOWNLOAD,
    ].includes(item.attachmentSyncState);
    if (fileExists && !(queued && syncingEnabled && !isLinkedFile)) return;
    if (!fileExists && (isLinkedFile || !syncingEnabled)) {
        pane.showAttachmentNotFoundDialog(item, path, { noLocate, notOnServer: false, linkedFile: isLinkedFile });
        throw new AttachmentFileUnavailableError(itemID);
    }
    try {
        await Zotero.Sync.Runner.downloadFile(item);
    } catch (error) {
        Zotero.logError(error as Error);
        // A failed refresh of an existing file still opens the local copy.
        if (fileExists) return;
        (Zotero.Sync.Runner as any).alert(error);
        throw new AttachmentFileUnavailableError(itemID);
    }
    if (!(await item.getFilePathAsync())) {
        if (fileExists) return;
        pane.showAttachmentNotFoundDialog(item, path, { noLocate, notOnServer: true });
        throw new AttachmentFileUnavailableError(itemID);
    }
    Zotero.Notifier.trigger('redraw', 'item', []);
}

/**
 * Give a mislabelled PDF/EPUB the content type Zotero's reader requires, as
 * `ZoteroPane.viewAttachment` does when the user opens the file. Without it
 * the reader cannot open an attachment stored as, e.g., `application/octet-stream`.
 * Applies in libraries excluded from Beaver too: opening is user-initiated.
 */
async function ensureContentTypeForReader(itemID: number): Promise<void> {
    const item = await Zotero.Items.getAsync(itemID);
    if (!item || !canonicalContentTypeCorrection(item)) return;
    try {
        await runWindowOperation('ensureReaderContentType', [itemID]);
    } catch (error) {
        logger(`openReader: could not correct content type for ${itemID}: ${error}`, 2);
    }
}

/** Pin a real main window before any reader initialization awaits. */
export async function openReader(
    itemID: number, location?: any, options: Record<string, any> = {},
    origin: Window = getContextWindow(),
): Promise<any> {
    const win = await resolveNavigationWindow(origin);
    await ensureAttachmentFileForReader(itemID, win);
    await ensureContentTypeForReader(itemID);
    if (win.closed || win.__beaverRuntime?.status === 'closing') throw new WindowUnavailableError();
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

/**
 * Preserve Zotero's external-file preferences while targeting the originating pane.
 * `forceAlternateWindowBehavior` inverts the "open reader in new window" preference,
 * like a shift-click in the items tree.
 */
export async function viewAttachment(
    itemID: number, origin?: Window, options: { forceAlternateWindowBehavior?: boolean } = {},
): Promise<void> {
    try {
        const win = await resolveNavigationWindow(origin ?? getContextWindow());
        if (typeof (win.Zotero_Tabs as any).isOwnTabEvent !== 'function') {
            await focusLegacyTarget(win);
            assertLegacyTarget(win);
        }
        await (win.ZoteroPane as any).viewAttachment(itemID, null, false, options);
    } catch (error) {
        logger(`viewAttachment: ${error}`, 2);
    }
}

/** Open a note in its own window; releases without note tabs only have note windows. */
export async function openNoteWindow(itemID: number, origin?: Window): Promise<void> {
    try {
        const win = await resolveNavigationWindow(origin ?? getContextWindow());
        if (typeof (Zotero as any).Notes?.open === 'function') {
            await (win.ZoteroPane as any).openNote(itemID, { openInWindow: true });
        } else {
            await win.ZoteroPane.openNoteWindow(itemID);
        }
    } catch (error) {
        logger(`openNoteWindow: ${error}`, 2);
    }
}

/**
 * Reveal an attachment's file in the OS file manager, or show Zotero's
 * missing-file dialog. Revealing an existing file needs no Zotero window, so
 * only the dialog may bring one up (from the standalone Beaver window or
 * Settings when no main window is open).
 */
export async function showAttachmentInFilesystem(itemID: number, origin?: Window): Promise<void> {
    try {
        if (await revealExistingAttachmentFile(itemID)) return;
        const win = await resolveNavigationWindow(origin ?? getContextWindow());
        await (win.ZoteroPane as any).showAttachmentInFilesystem(itemID);
    } catch (error) {
        logger(`showAttachmentInFilesystem: ${error}`, 2);
    }
}

/** Reveal a file attachment whose file exists, as `ZoteroPane` does; `false` otherwise. */
async function revealExistingAttachmentFile(itemID: number): Promise<boolean> {
    const attachment = await Zotero.Items.getAsync(itemID);
    if (!attachment?.isFileAttachment()) return false;
    const path = await attachment.getFilePathAsync();
    if (!path) return false;
    const file = Zotero.File.pathToFile(path);
    try {
        file.reveal();
    } catch {
        // Platforms without nsIFile.reveal() (e.g. Linux) open the parent folder.
        Zotero.launchFile(file.parent!.path);
    }
    // Zotero's own reveal notification; the typings omit the 'reveal' event.
    void Zotero.Notifier.trigger('reveal' as _ZoteroTypes.Notifier.Event, 'file', attachment.id);
    return true;
}
