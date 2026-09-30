import React, { useEffect, useRef, useState } from 'react';
import type { ZoteroItemReference } from '@beaver/agent-core/types/zotero';
import ContextMenu, { type MenuItem, type MenuPosition } from '../primitives/ContextMenu';
import { getHost } from '../host';
import { logger } from '@beaver/agent-core/platform/logger';
import { beginMenuRequest, type PendingMenuRequest } from './pendingMenuRequest';
import { LibraryIcon } from '../icons';

export interface ItemContextMenu {
    /**
     * Right-click handler for a row that stands for `ref`. Suppresses the native
     * menu only when the host offers item menus; the entries are resolved by the
     * host and the menu opens at the cursor once they arrive.
     */
    openItemMenu(ref: ZoteroItemReference, event: React.MouseEvent): void;
    /**
     * Right-click handler for a collection row; `ref.zotero_key` is the
     * collection key. Offers "Show in Library" when the host can reveal
     * collections.
     */
    openCollectionMenu(ref: ZoteroItemReference, event: React.MouseEvent): void;
    /** Render once next to the rows; null while closed. */
    itemMenu: React.ReactNode;
}

/** The collection menu's entries; collections have nothing to open or show on disk. */
export function collectionMenuItems(ref: ZoteroItemReference): MenuItem[] {
    const navigation = getHost().navigation;
    if (!navigation) return [];
    return [{ label: 'Show in Library', icon: LibraryIcon, onClick: () => navigation.revealCollection(ref) }];
}

/**
 * Right-click menu for library rows: items, with entries supplied by
 * `getHost().navigation.itemMenuItems` ("Show in Library", open, show file, …),
 * and collections. One hook serves a whole list: only one row's menu is open
 * at a time.
 */
export function useItemContextMenu(): ItemContextMenu {
    const [menu, setMenu] = useState<{ items: MenuItem[]; position: MenuPosition } | null>(null);
    // Entries resolve asynchronously; a dismissed or superseded request never opens.
    const pendingRef = useRef<PendingMenuRequest | null>(null);
    useEffect(() => () => pendingRef.current?.cancel(), []);

    const openItemMenu = (ref: ZoteroItemReference, event: React.MouseEvent) => {
        const resolve = getHost().navigation?.itemMenuItems;
        if (!resolve) return;
        event.preventDefault();
        event.stopPropagation();
        pendingRef.current?.cancel();
        const request = beginMenuRequest(event.currentTarget.ownerDocument);
        pendingRef.current = request;
        const position = { x: event.clientX, y: event.clientY };
        setMenu(null);
        void resolve(ref)
            .then((items) => {
                if (request.isCurrent() && items.length > 0) setMenu({ items, position });
            })
            .catch((error) => logger(`useItemContextMenu: failed to build menu: ${error}`, 2))
            .finally(() => request.settle());
    };

    const openCollectionMenu = (ref: ZoteroItemReference, event: React.MouseEvent) => {
        const items = collectionMenuItems(ref);
        if (items.length === 0) return;
        event.preventDefault();
        event.stopPropagation();
        pendingRef.current?.cancel();
        pendingRef.current = null;
        setMenu({ items, position: { x: event.clientX, y: event.clientY } });
    };

    const itemMenu = menu && (
        <ContextMenu
            menuItems={menu.items}
            isOpen={true}
            onClose={() => setMenu(null)}
            position={menu.position}
            useFixedPosition={true}
            itemLabelClassName="text-sm font-color-secondary truncate"
            itemIconClassName="font-color-secondary flex-shrink-0 scale-95"
        />
    );

    return { openItemMenu, openCollectionMenu, itemMenu };
}

export default useItemContextMenu;
