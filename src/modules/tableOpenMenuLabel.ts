/**
 * Names Beaver tables in Zotero's own "Open Snapshot in New Tab/Window"
 * entries of the item context menu.
 *
 * A table is stored as an HTML snapshot, so Zotero labels its open entries for
 * a snapshot. When every selected item is a table, those entries take Beaver's
 * label ("Open Beaver Table in New Tab"); what they do is unchanged.
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

import { isTableItem } from '../services/artifacts/tableItemIdentity';

/** Zotero's l10n id for its "Open <type> in New Tab/Window" item menu entries. */
const ZOTERO_VIEW_ATTACHMENT_L10N_ID = 'item-menu-viewAttachment';
const TABLE_VIEW_L10N_ID = 'beaver-item-menu-view-table';
/** Zotero's item context menu in the library pane. */
const ITEM_MENU_POPUP_ID = 'zotero-itemmenu';

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

    const selector = `:scope > menuitem[data-l10n-id="${ZOTERO_VIEW_ATTACHMENT_L10N_ID}"]`;
    for (const entry of Array.from(popup.querySelectorAll(selector)) as Element[]) {
        const args = parseArgs(entry.getAttribute('data-l10n-args'));
        if (args?.attachmentType !== 'snapshot') continue;
        if (args.openIn !== 'tab' && args.openIn !== 'window') continue;
        l10n.setAttributes(entry, TABLE_VIEW_L10N_ID, { count: items.length, openIn: args.openIn });
    }
}

/** The item popup and listener attached to each main window. */
const attached = new Map<Window, { popup: Element; listener: (event: Event) => void }>();

/**
 * Relabels the open entries each time the item context menu of `win` opens.
 * Zotero builds the menu, open entries included, before opening it, so they
 * exist when `popupshowing` fires. Re-attaching replaces the old listener.
 */
export function attachTableOpenLabels(win: Window): void {
    detachTableOpenLabels(win);
    const popup = win.document?.getElementById(ITEM_MENU_POPUP_ID);
    if (!popup) return;
    const listener = (event: Event) => {
        // Submenus' popupshowing events bubble up to the item popup.
        if (event.target !== popup) return;
        try {
            labelTableOpenEntries(popup, (win as any).ZoteroPane?.getSelectedItems?.());
        } catch (e) {
            try {
                ztoolkit.log(`tableOpenMenuLabel: could not label table open entries: ${e}`);
            } catch { /* logging must not break Zotero's menu */ }
        }
    };
    popup.addEventListener('popupshowing', listener);
    attached.set(win, { popup, listener });
}

/** Removes the listener `attachTableOpenLabels` added to `win`. */
export function detachTableOpenLabels(win: Window): void {
    const entry = attached.get(win);
    if (!entry) return;
    attached.delete(win);
    try {
        entry.popup.removeEventListener('popupshowing', entry.listener);
    } catch { /* the window is already gone */ }
}

/** Removes the listener from every main window, for plugin shutdown. */
export function detachAllTableOpenLabels(): void {
    for (const win of Array.from(attached.keys())) detachTableOpenLabels(win);
}
