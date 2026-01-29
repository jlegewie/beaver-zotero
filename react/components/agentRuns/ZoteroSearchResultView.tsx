import React, { useMemo } from 'react';
import { ZoteroSearchResultItem, ListItemsResultItem } from '../../agents/toolResultTypes';
import { ZoteroItemReference } from '../../types/zotero';
import ZoteroItemsList from '../ui/ZoteroItemsList';

/** Unified item type for display */
type DisplayItem = ZoteroSearchResultItem | ListItemsResultItem;

interface ZoteroSearchResultViewProps {
    items: DisplayItem[];
    totalCount: number;
}

/**
 * Parse item_id format '<library_id>-<zotero_key>' to ZoteroItemReference.
 */
function parseItemId(itemId: string): ZoteroItemReference | null {
    const [libraryIdStr, zoteroKey] = itemId.split('-');
    if (!libraryIdStr || !zoteroKey) return null;
    
    const libraryId = parseInt(libraryIdStr, 10);
    if (isNaN(libraryId)) return null;
    
    return { library_id: libraryId, zotero_key: zoteroKey };
}

/**
 * Renders the result of zotero_search or list_items tools.
 * Uses ZoteroItemsList to display items with clickable links to reveal in Zotero.
 */
export const ZoteroSearchResultView: React.FC<ZoteroSearchResultViewProps> = ({
    items,
    totalCount
}) => {
    const itemReferences = useMemo(() => {
        return items
            .map(item => parseItemId(item.item_id))
            .filter((ref): ref is ZoteroItemReference => ref !== null);
    }, [items]);

    if (itemReferences.length === 0) {
        return (
            <div className="p-3 text-sm font-color-tertiary">
                No items found
            </div>
        );
    }

    return (
        <div className="display-flex flex-col">
            <ZoteroItemsList messageAttachments={itemReferences} />
            {totalCount > items.length && (
                <div className="px-15 py-2 text-xs font-color-tertiary border-t border-primary">
                    Showing {items.length} of {totalCount} items
                </div>
            )}
        </div>
    );
};

export default ZoteroSearchResultView;
