import React from 'react';
import { ZoteroSearchResultItem, ListItemsResultItem } from '../../agents/toolResultTypes';
import { CSSItemTypeIcon } from '../icons/icons';

/** Unified item type for display */
type DisplayItem = ZoteroSearchResultItem | ListItemsResultItem;

interface ZoteroSearchResultViewProps {
    items: DisplayItem[];
    totalCount: number;
    libraryName?: string | null;
    collectionName?: string | null;
}

/**
 * Renders the result of zotero_search or list_items tools.
 * Shows items with type icon, title, creators, and year.
 */
export const ZoteroSearchResultView: React.FC<ZoteroSearchResultViewProps> = ({
    items,
    totalCount,
    libraryName,
    collectionName
}) => {
    if (items.length === 0) {
        return (
            <div className="p-3 text-sm font-color-tertiary">
                No items found
            </div>
        );
    }

    const headerText = [libraryName, collectionName].filter(Boolean).join(' / ');

    return (
        <div className="display-flex flex-col">
            {headerText && (
                <div className="px-15 py-1 text-xs font-color-tertiary border-b border-primary">
                    {headerText}
                </div>
            )}
            {items.map((item, index) => (
                <div
                    key={item.item_id}
                    className={`display-flex flex-row gap-1 items-start px-15 py-15 ${
                        index < items.length - 1 ? 'border-b border-primary' : ''
                    }`}
                >
                    <span className="scale-75" style={{ marginTop: '-2px' }}>
                        <CSSItemTypeIcon itemType={item.item_type} />
                    </span>
                    <div className="display-flex flex-col flex-1 min-w-0">
                        <div className="display-flex flex-row gap-1 min-w-0">
                            <span className="text-sm font-color-primary truncate flex-1">
                                {item.creators || 'Unknown'}
                            </span>
                            {item.year && (
                                <span className="text-sm font-color-tertiary whitespace-nowrap">
                                    ({item.year})
                                </span>
                            )}
                        </div>
                        <span className="text-sm font-color-secondary truncate">
                            {item.title || 'Untitled'}
                        </span>
                    </div>
                </div>
            ))}
            {totalCount > items.length && (
                <div className="px-15 py-2 text-xs font-color-tertiary border-t border-primary">
                    Showing {items.length} of {totalCount} items
                </div>
            )}
        </div>
    );
};

export default ZoteroSearchResultView;
