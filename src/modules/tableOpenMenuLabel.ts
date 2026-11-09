/**
 * Names Beaver tables in Zotero's own "Open Snapshot in New Tab/Window"
 * entries of the item context menu, and opens the window entry's tables in
 * Beaver's table window.
 *
 * A table is stored as an HTML snapshot, so Zotero labels its open entries for
 * a snapshot. When every selected item is a table, those entries take Beaver's
 * label ("Open Beaver Table in New Tab"). The tab entry still runs Zotero's
 * open, whose reader tab Beaver replaces before it paints. The window entry
 * opens each table in its own window directly: Zotero's would first show a
 * reader window for Beaver to close. That part applies in every language.
 *
 * Fallbacks, each leaving Zotero's label in place:
 * - Zotero renames the entries' Fluent id or arguments: nothing matches.
 * - The interface language is one Beaver has no strings for: Zotero's
 *   translated label beats Beaver's English one. Beaver ships English only
 *   (the build copies `en-US` into every Zotero locale).
 * - The entry would open the file in an external viewer: it does not open
 *   the table.
 *
 * The relabel runs from a `popupshowing` listener on Zotero's item popup,
 * attached per main window. A MenuManager `onShowing` hook would not do: when
 * the item menu is too tall, Zotero moves plugin entries into an overflow
 * submenu and runs their hooks only when that submenu opens.
 */

import { isTableItem, type TableRef } from '../services/artifacts/tableItemIdentity';

/** Zotero's l10n id for its "Open <type> in New Tab/Window" item menu entries. */
const ZOTERO_VIEW_ATTACHMENT_L10N_ID = 'item-menu-viewAttachment';
const TABLE_VIEW_L10N_ID = 'beaver-item-menu-view-table';
/** Zotero's item context menu in the library pane. */
const ITEM_MENU_POPUP_ID = 'zotero-itemmenu';
/** Marks the window entry Beaver opens itself, for the open of the menu it is in. */
const TABLE_WINDOW_ENTRY_ATTR = 'data-beaver-table-window';

/** Opens a table in its own window (`openTable` with `openIn: 'window'`); never throws. */
export type TableWindowOpen = (ref: TableRef) => Promise<{ error: string } | { ok: true }>;

/** Interface languages Beaver has translated strings for. */
const BEAVER_UI_LANGUAGES = ['en'];

interface ViewAttachmentArgs {
    attachmentType?: unknown;
    openIn?: unknown;
}

function uiLanguageSupported(): boolean {
    const locale = typeof Zotero.locale === 'string' ? Zotero.locale : '';
    const language = locale.split(/[-_]/)[0].toLowerCase();
    return BEAVER_UI_LANGUAGES.includes(language);
}

function parseArgs(raw: string | null): ViewAttachmentArgs | null {
    if (!raw) return null;
    try {
        const args = JSON.parse(raw);
        return args && typeof args === 'object' ? args : null;
    } catch {
        return null;
    }
}

function isTable(item: Zotero.Item): boolean {
    try {
        return isTableItem(item);
    } catch {
        return false;
    }
}

/** Zotero's open entries in `popup` that open snapshots in Zotero, with where they open. */
function snapshotOpenEntries(popup: Element): Array<{ entry: Element; openIn: 'tab' | 'window' }> {
    const selector = `:scope > menuitem[data-l10n-id="${ZOTERO_VIEW_ATTACHMENT_L10N_ID}"]`;
    const found: Array<{ entry: Element; openIn: 'tab' | 'window' }> = [];
    for (const entry of Array.from(popup.querySelectorAll(selector)) as Element[]) {
        const args = parseArgs(entry.getAttribute('data-l10n-args'));
        if (args?.attachmentType !== 'snapshot') continue;
        if (args.openIn !== 'tab' && args.openIn !== 'window') continue;
        found.push({ entry, openIn: args.openIn });
    }
    return found;
}

/**
 * Relabels Zotero's open entries in the item context menu `popup` when every
 * selected item is a Beaver table. Call while the popup is showing: Zotero
 * builds those entries before it opens the menu, and rebuilds them each time.
 */
export function labelTableOpenEntries(
    popup: Element | null | undefined,
    items: readonly Zotero.Item[] | null | undefined,
): void {
    if (!popup || !items?.length || !uiLanguageSupported()) return;
    if (!items.every(isTable)) return;
    const l10n = popup.ownerDocument?.l10n;
    if (!l10n) return;
    for (const { entry, openIn } of snapshotOpenEntries(popup)) {
        l10n.setAttributes(entry, TABLE_VIEW_L10N_ID, { count: items.length, openIn });
    }
}

/**
 * Marks the entry that opens the selection in new windows when every selected
 * item is a table, so choosing it opens Beaver's table windows. Returns
 * whether one was marked.
 */
export function markTableWindowEntry(
    popup: Element | null | undefined,
    items: readonly Zotero.Item[] | null | undefined,
): boolean {
    if (!popup || !items?.length || !items.every(isTable)) return false;
    let marked = false;
    for (const { entry, openIn } of snapshotOpenEntries(popup)) {
        if (openIn !== 'window') continue;
        entry.setAttribute(TABLE_WINDOW_ENTRY_ATTR, 'true');
        marked = true;
    }
    return marked;
}

/**
 * Opens the selected tables in table windows when the marked entry is chosen,
 * in place of Zotero's open. Returns whether it took the command; with no
 * opener or no table selected, Zotero's own open runs.
 */
export function openMarkedTableWindows(
    target: EventTarget | null,
    items: readonly Zotero.Item[] | null | undefined,
    open: TableWindowOpen | null,
    win: Window,
): boolean {
    const entry = target as Element | null;
    if (!open || !entry?.hasAttribute?.(TABLE_WINDOW_ENTRY_ATTR)) return false;
    const tables = (items ?? []).filter(isTable);
    if (!tables.length) return false;
    for (const item of tables) {
        void open({ libraryID: item.libraryID, key: item.key }).then(
            (outcome) => {
                if ('error' in outcome && !win.closed) Zotero.alert(win as any, 'Beaver', outcome.error);
            },
            (error) => logMenuError(`could not open table ${item.key} in a window: ${error}`),
        );
    }
    return true;
}

function logMenuError(message: string): void {
    try {
        ztoolkit.log(`tableOpenMenuLabel: ${message}`);
    } catch { /* logging must not break Zotero's menu */ }
}

/** The item popup and listeners attached to each main window. */
const attached = new Map<Window, { popup: Element; listener: (event: Event) => void; onCommand: (event: Event) => void }>();

/**
 * Relabels the open entries each time the item context menu of `win` opens,
 * and with `openWindow`, opens a selection of tables in table windows from
 * the window entry. Zotero builds the menu, open entries included, before
 * opening it, so they exist when `popupshowing` fires. Re-attaching replaces
 * the old listeners.
 */
export function attachTableOpenLabels(win: Window, openWindow: TableWindowOpen | null = null): void {
    detachTableOpenLabels(win);
    const popup = win.document?.getElementById(ITEM_MENU_POPUP_ID);
    if (!popup) return;
    const selection = () => (win as any).ZoteroPane?.getSelectedItems?.() as Zotero.Item[] | undefined;
    const listener = (event: Event) => {
        // Submenus' popupshowing events bubble up to the item popup.
        if (event.target !== popup) return;
        try {
            const items = selection();
            if (openWindow) markTableWindowEntry(popup, items);
            labelTableOpenEntries(popup, items);
        } catch (e) {
            logMenuError(`could not label table open entries: ${e}`);
        }
    };
    // Capturing, so it runs before the listener Zotero put on the entry.
    const onCommand = (event: Event) => {
        try {
            if (!openMarkedTableWindows(event.target, selection(), openWindow, win)) return;
        } catch (e) {
            logMenuError(`could not open table windows: ${e}`);
            return;
        }
        event.stopPropagation();
        event.preventDefault();
    };
    popup.addEventListener('popupshowing', listener);
    popup.addEventListener('command', onCommand, true);
    attached.set(win, { popup, listener, onCommand });
}

/** Removes the listener `attachTableOpenLabels` added to `win`. */
export function detachTableOpenLabels(win: Window): void {
    const entry = attached.get(win);
    if (!entry) return;
    attached.delete(win);
    try {
        entry.popup.removeEventListener('popupshowing', entry.listener);
        entry.popup.removeEventListener('command', entry.onCommand, true);
    } catch { /* the window is already gone */ }
}

/** Removes the listener from every main window, for plugin shutdown. */
export function detachAllTableOpenLabels(): void {
    for (const win of Array.from(attached.keys())) detachTableOpenLabels(win);
}
