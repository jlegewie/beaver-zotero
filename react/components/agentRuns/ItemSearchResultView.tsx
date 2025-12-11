import React from 'react';
import { ItemSearchViewData } from '../../agents/toolResultTypes';
import ZoteroItemsList from '../ui/ZoteroItemsList';

interface ItemSearchResultViewProps {
    /** Normalized item search data with ZoteroItemReference[] */
    data: ItemSearchViewData;
}

/**
 * Renders the result of an item search tool (search_references_by_topic, search_references_by_metadata).
 * Uses ZoteroItemsList to display the items with clickable links to reveal in Zotero.
 */
export const ItemSearchResultView: React.FC<ItemSearchResultViewProps> = ({ data }) => {
    if (data.items.length === 0) {
        return (
            <div className="p-3 text-sm font-color-tertiary">
                No items found
            </div>
        );
    }

    return (
        <div className="display-flex flex-col">
            <ZoteroItemsList messageAttachments={data.items} />
        </div>
    );
};

export default ItemSearchResultView;

