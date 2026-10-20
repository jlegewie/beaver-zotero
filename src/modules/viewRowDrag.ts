/**
 * Lets the collections-tree rows for built-in views (Unfiled Items, My
 * Publications, Retracted Items) be dragged into Beaver.
 *
 * Zotero puts drag data only on collection and saved-search rows, and Gecko
 * starts no drag without data, so these rows cannot be dragged at all. A
 * capture-phase listener on the tree adds a Beaver-only data type before
 * Zotero's row handler runs; Zotero's own drop targets ignore types they do not
 * know, so the drag lands nowhere else.
 */

import { logger } from '@beaver/agent-core/platform/logger';
import { VIEW_ROW_DRAG_TYPE } from '../utils/zoteroSelection';

/** View rows Beaver can attach; saved searches already carry `zotero/search`. */
const DRAGGABLE_VIEW_TYPES = new Set(['unfiled', 'publications', 'retracted']);

const handlers = new WeakMap<Window, (event: DragEvent) => void>();

/** The tree row a drag started on, read from the row element's `<treeId>-row-<index>` id. */
function draggedRow(win: Window, event: DragEvent): any {
    const element = (event.target as Element | null)?.closest?.('.row');
    const match = element?.id?.match(/-row-(\d+)$/);
    if (!match) return null;
    const tree = (win as any).ZoteroPane?.collectionsView;
    return tree?.getRow?.(Number(match[1])) ?? null;
}

export function attachViewRowDrag(win: Window): void {
    detachViewRowDrag(win);
    const tree = win.document?.getElementById('zotero-collections-tree');
    if (!tree) return;

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
    tree.addEventListener('dragstart', handler as EventListener, true);
    handlers.set(win, handler);
}

export function detachViewRowDrag(win: Window): void {
    const handler = handlers.get(win);
    if (!handler) return;
    win.document?.getElementById('zotero-collections-tree')
        ?.removeEventListener('dragstart', handler as EventListener, true);
    handlers.delete(win);
}
