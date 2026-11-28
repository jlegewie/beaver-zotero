/**
 * Lets the collections-tree rows for built-in views (Unfiled Items, My
 * Publications, Retracted Items) be dragged into Beaver.
 *
 * Zotero puts drag data only on collection and saved-search rows, and Gecko
 * starts no drag without data, so these rows cannot be dragged at all. A
 * capture-phase listener adds a Beaver-only data type before Zotero's row
 * handler runs; Zotero's own drop targets ignore types they do not know, so the
 * drag lands nowhere else.
 *
 * The listener sits on the window's document rather than on a tree: Zotero 11
 * gives each library tab its own collections tree (with a suffixed id and a
 * `zotero-collections-tree` class), and creates and destroys them as tabs load
 * and unload.
 */

import { logger } from '@beaver/agent-core/platform/logger';
import { VIEW_ROW_DRAG_TYPE } from '../utils/zoteroSelection';

/** View rows Beaver can attach; saved searches already carry `zotero/search`. */
const DRAGGABLE_VIEW_TYPES = new Set(['unfiled', 'publications', 'retracted']);

const COLLECTIONS_TREE_SELECTOR = '#zotero-collections-tree, .zotero-collections-tree';

const handlers = new WeakMap<Window, (event: DragEvent) => void>();

/**
 * The collections-tree row a drag started on, read from the row element's
 * `<treeId>-row-<index>` id, or null for a drag that did not start on one.
 */
function draggedRow(win: Window, event: DragEvent): any {
    const target = event.target as Element | null;
    const tree = target?.closest?.(COLLECTIONS_TREE_SELECTOR);
    if (!tree) return null;
    const match = target!.closest('.row')?.id?.match(/-row-(\d+)$/);
    if (!match) return null;
    // Zotero 11: the library view that owns this tree. Earlier versions have
    // no <library-view>, and the window's only collections view.
    const view = tree.closest('library-view') as any;
    const collectionsView = view?.collectionsView ?? (win as any).ZoteroPane?.collectionsView;
    return collectionsView?.getRow?.(Number(match[1])) ?? null;
}

export function attachViewRowDrag(win: Window): void {
    detachViewRowDrag(win);
    const doc = win.document;
    if (!doc) return;

    const handler = (event: DragEvent) => {
        try {
            const row = draggedRow(win, event);
            if (!row || !DRAGGABLE_VIEW_TYPES.has(row.type) || !event.dataTransfer) return;
            const libraryID = row.ref?.libraryID;
            if (typeof libraryID !== 'number') return;
            event.dataTransfer.setData(VIEW_ROW_DRAG_TYPE, JSON.stringify({
                libraryID,
                type: row.type,
                name: row.getName?.() ?? '',
            }));
        } catch (error) {
            logger(`viewRowDrag: could not add drag data: ${error}`, 1);
        }
    };
    doc.addEventListener('dragstart', handler as EventListener, true);
    handlers.set(win, handler);
}

export function detachViewRowDrag(win: Window): void {
    const handler = handlers.get(win);
    if (!handler) return;
    win.document?.removeEventListener('dragstart', handler as EventListener, true);
    handlers.delete(win);
}
