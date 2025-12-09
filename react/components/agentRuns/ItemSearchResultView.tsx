import React from 'react';
import { ItemSearchResult } from '../../agents/toolResultTypes';
import { createZoteroItemReference } from '../../types/zotero';
import ZoteroItemsList from '../ui/ZoteroItemsList';

interface ItemSearchResultViewProps {
    result: ItemSearchResult;
}

/**
 * Renders the result of an item search tool (search_references_by_topic, search_references_by_metadata).
 * Uses ZoteroItemsList to display the items with clickable links to reveal in Zotero.
 */
export const ItemSearchResultView: React.FC<ItemSearchResultViewProps> = ({ result }) => {
    if (result.items.length === 0) {
        return (
            <div className="p-3 text-sm font-color-tertiary">
                No items found
            </div>
        );
    }

    // Parse item_id format '<library_id>-<zotero_key>' to ZoteroItemReference[]
    const itemReferences = result.items
        .map(item => createZoteroItemReference(item.item_id))
        .filter((ref): ref is NonNullable<typeof ref> => ref !== null);

    return (
        <div className="display-flex flex-col">
            <ZoteroItemsList messageAttachments={itemReferences} />
        </div>
    );
};

export default ItemSearchResultView;

