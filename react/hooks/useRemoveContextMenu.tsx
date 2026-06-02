import React, { useState } from 'react';
import ContextMenu, { MenuItem, MenuPosition } from '../components/ui/menu/ContextMenu';
import { CancelIcon, DeleteIcon } from '../components/icons/icons';

interface UseRemoveContextMenuOptions {
    /** Remove just this context item. */
    onRemove: () => void;
    /**
     * Remove every editable context item at once. When provided, the right-click
     * menu shows an additional "Remove all" entry. Callers pass this only when
     * more than one removable context item is present.
     */
    onRemoveAll?: () => void;
    /** Whether the item is editable (removable). Defaults to true. */
    canEdit?: boolean;
    /** Whether the button is disabled. Defaults to false. */
    disabled?: boolean;
    /**
     * Called right before the menu opens, e.g. to cancel hover preview timers so
     * a preview doesn't pop up while the menu is shown.
     */
    onMenuOpen?: () => void;
    /** Optional width override for the menu. */
    menuWidth?: string;
}

interface UseRemoveContextMenuResult {
    /** True while the menu is open (keep the remove "x" visible). */
    isRemoveMenuOpen: boolean;
    /** Props to spread on the button: right-click opens the remove menu. */
    contextMenuHandlers: {
        onContextMenu: (e: React.MouseEvent) => void;
    };
    /** Props to spread on the remove "x" span: left-click removes just this item. */
    removeHandlers: {
        onClick: (e: React.MouseEvent<HTMLSpanElement>) => void;
    };
    /** The menu element to render alongside the button (or null). */
    removeMenu: React.ReactNode;
}

/**
 * Shared right-click "remove" menu for context item buttons (attached items,
 * collections, library/collection/tag filters, reader text selection).
 *
 * A left-click on the remove "x" removes just that item. Right-clicking anywhere
 * on the button (including the "x") opens a small menu: it always offers
 * "Remove", and additionally "Remove all" when {@link onRemoveAll} is provided.
 * The menu renders inline with fixed positioning (no portal) so it inherits the
 * popup styling and stays clickable.
 */
export function useRemoveContextMenu({
    onRemove,
    onRemoveAll,
    canEdit = true,
    disabled = false,
    onMenuOpen,
    menuWidth = '110px',
}: UseRemoveContextMenuOptions): UseRemoveContextMenuResult {
    // The menu is available whenever the item is editable, regardless of whether
    // "Remove all" applies, so the interaction is consistent across buttons.
    const canShowRemoveMenu = canEdit && !disabled;

    const [isRemoveMenuOpen, setIsRemoveMenuOpen] = useState(false);
    const [menuPosition, setMenuPosition] = useState<MenuPosition>({ x: 0, y: 0 });

    const handleContextMenu = (e: React.MouseEvent) => {
        if (!canShowRemoveMenu) return;
        // Suppress the native context menu and open ours at the cursor.
        e.preventDefault();
        e.stopPropagation();
        onMenuOpen?.();
        setMenuPosition({ x: e.clientX, y: e.clientY });
        setIsRemoveMenuOpen(true);
    };

    const handleRemoveClick = (e: React.MouseEvent<HTMLSpanElement>) => {
        e.stopPropagation();
        onRemove();
    };

    const menuItems: MenuItem[] = [
        {
            label: 'Remove',
            icon: CancelIcon,
            onClick: () => onRemove(),
        },
        ...(onRemoveAll
            ? [{
                label: 'Remove all',
                icon: DeleteIcon,
                onClick: () => onRemoveAll(),
            }]
            : []),
    ];

    const removeMenu = canShowRemoveMenu ? (
        <ContextMenu
            menuItems={menuItems}
            isOpen={isRemoveMenuOpen}
            onClose={() => setIsRemoveMenuOpen(false)}
            position={menuPosition}
            useFixedPosition={true}
            width={menuWidth}
        />
    ) : null;

    return {
        isRemoveMenuOpen,
        contextMenuHandlers: { onContextMenu: handleContextMenu },
        removeHandlers: { onClick: handleRemoveClick },
        removeMenu,
    };
}
