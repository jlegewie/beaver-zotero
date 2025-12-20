import React from 'react';
import { ZoteroItemReference } from '../../types/zotero';
import ZoteroItemsList from '../ui/ZoteroItemsList';

interface ItemSearchResultViewProps {
    items: ZoteroItemReference[];
}

/**
 * Renders the result of an item search tool (search_references_by_topic, search_references_by_metadata).
 * Uses ZoteroItemsList to display the items with clickable links to reveal in Zotero.
 */
export const ItemSearchResultView: React.FC<ItemSearchResultViewProps> = ({ items }) => {
    if (items.length === 0) {
        return (
            <div className="p-3 text-sm font-color-tertiary">
                No items found
            </div>
        );
    }

    return (
        <div className="display-flex flex-col">
            <ZoteroItemsList messageAttachments={items} />
        </div>
    );
};

export default ItemSearchResultView;

