import React, { useEffect, useState } from 'react';
import { CSSIcon } from '../icons/icons';
import type { TagChanges, CollectionChanges, OrganizeItemsResultData } from '../../types/agentActions/base';
import { MessageItemButton } from '../input/MessageItemButton';
import { usePreviewHover } from '../../hooks/usePreviewHover';

type ActionStatus = 'pending' | 'applied' | 'rejected' | 'undone' | 'error' | 'awaiting';

const MAX_ITEMS_DISPLAY = 2;

interface OrganizeItemsPreviewProps {
    /** List of item IDs being organized */
    itemIds: string[];
    /** Tags to add/remove */
    tags?: TagChanges | null;
    /** Collections to add/remove */
    collections?: CollectionChanges | null;
    /** Current status of the action */
    status?: ActionStatus;
    /** Result data (when status is 'applied') */
    resultData?: OrganizeItemsResultData;
}

/**
 * Preview component for organize_items actions.
 * Shows the tags and collections that will be added/removed from items.
 */
export const OrganizeItemsPreview: React.FC<OrganizeItemsPreviewProps> = ({
    itemIds,
    tags,
    collections,
    status = 'pending',
    resultData,
}) => {
    const [collectionNames, setCollectionNames] = useState<Record<string, string>>({});
    const [resolvedItems, setResolvedItems] = useState<Zotero.Item[]>([]);

    // Resolve items from item IDs
    useEffect(() => {
        const fetchItems = async () => {
            if (typeof Zotero === 'undefined' || itemIds.length === 0) return;

            const items: Zotero.Item[] = [];
            for (const itemId of itemIds) {
                try {
                    const parts = itemId.split('-');
                    const libraryId = parseInt(parts[0], 10);
                    const zoteroKey = parts.slice(1).join('-');
                    const item = await Zotero.Items.getByLibraryAndKeyAsync(libraryId, zoteroKey);
                    if (item) {
                        items.push(item);
                    }
                } catch (e) {
                    console.warn(`Failed to resolve item ${itemId}:`, e);
                }
            }
            setResolvedItems(items);
        };

        fetchItems();
    }, [itemIds]);

    // Resolve collection names
    useEffect(() => {
        const fetchCollectionNames = async () => {
            if (!collections || typeof Zotero === 'undefined') return;

            const keys = [...(collections.add || []), ...(collections.remove || [])];
            if (keys.length === 0) return;

            const names: Record<string, string> = {};
            
            // Get library ID from first item
            if (itemIds.length > 0) {
                const parts = itemIds[0].split('-');
                const libraryId = parseInt(parts[0], 10);

                for (const key of keys) {
                    try {
                        const collection = await Zotero.Collections.getByLibraryAndKeyAsync(libraryId, key);
                        if (collection) {
                            names[key] = collection.name;
                        }
                    } catch (e) {
                        console.warn(`Failed to resolve collection name for ${key}:`, e);
                    }
                }
            }

            setCollectionNames(names);
        };

        fetchCollectionNames();
    }, [collections, itemIds]);

    // Items to display and overflow
    const displayedItems = resolvedItems.slice(0, MAX_ITEMS_DISPLAY);
    const overflowItems = resolvedItems.slice(MAX_ITEMS_DISPLAY);
    const overflowCount = overflowItems.length;

    // Hover preview for overflow items
    const { hoverEventHandlers: overflowHoverHandlers } = usePreviewHover(
        overflowCount > 0 ? { type: 'itemsSummary', content: overflowItems } : null,
        { isEnabled: overflowCount > 0 }
    );

    const isApplied = status === 'applied';
    const isRejectedOrUndone = status === 'rejected' || status === 'undone';

    const tagsToAdd = tags?.add || [];
    const tagsToRemove = tags?.remove || [];
    const collectionsToAdd = collections?.add || [];
    const collectionsToRemove = collections?.remove || [];

    const hasTagChanges = tagsToAdd.length > 0 || tagsToRemove.length > 0;
    const hasCollectionChanges = collectionsToAdd.length > 0 || collectionsToRemove.length > 0;

    const itemCount = itemIds.length;

    return (
        <div className={`organize-items-preview overflow-hidden ${isRejectedOrUndone ? 'opacity-60' : ''}`}>
            <div className="display-flex flex-col px-3 py-1 gap-5">
                
                {/* Item display - always shown regardless of status */}
                <div className="display-flex flex-wrap gap-col-3 gap-row-2 mt-1">
                    {displayedItems.map((item) => (
                        <MessageItemButton
                            key={item.key}
                            item={item}
                            disabled={false}
                            canEdit={false}
                            showInvalid={false}
                            revealInCollectionKey={collectionsToAdd[0]}
                        />
                    ))}
                    {overflowCount > 0 && (
                        <button
                            type="button"
                            className="variant-outline source-button"
                            style={{ height: '22px' }}
                            title={`${overflowCount} more item${overflowCount === 1 ? '' : 's'}`}
                            {...overflowHoverHandlers}
                        >
                            +{overflowCount}
                        </button>
                    )}
                    {resolvedItems.length === 0 && itemCount > 0 && (
                        <span className="text-sm font-color-secondary">Loading {itemCount} item{itemCount !== 1 ? 's' : ''}...</span>
                    )}
                </div>

                {/* Tag changes */}
                {hasTagChanges && tagsToAdd.length > 0 && (
                    <div className="display-flex flex-col gap-3">
                        <div className="text-sm font-color-primary font-medium uppercase display-flex flex-row items-center gap-2">
                            <div>Adding Tags</div>
                        </div>
                        
                        {/* Tags to add */}
                        <div className="display-flex flex-row flex-wrap gap-1 ml-1">
                            {tagsToAdd.map((tag, index) => (
                                <span
                                    key={`add-${index}`}
                                    className="inline-flex items-center gap-1 text-xs px-2 py-05 rounded-md bg-quaternary font-color-secondary border-quinary"
                                >
                                    {tag}
                                </span>
                            ))}
                        </div>
                    </div>
                )}

                {hasTagChanges && tagsToRemove.length > 0 && (
                    <div className="display-flex flex-col gap-2">
                        <div className="text-sm font-color-primary font-medium uppercase display-flex flex-row items-center gap-2">
                            <div>Removing Tags</div>
                        </div>
                        
                        {/* Tags to remove */}
                        <div className="display-flex flex-row flex-wrap gap-1 ml-1">
                            {tagsToRemove.map((tag, index) => (
                                <span
                                    key={`remove-${index}`}
                                    className="inline-flex items-center gap-1 text-xs px-2 py-05 rounded-md bg-quaternary font-color-secondary border-quinary"
                                >
                                    {tag}
                                </span>
                            ))}
                        </div>
                    </div>
                )}

                {/* Collection changes */}
                {hasCollectionChanges && collectionsToAdd.length > 0 && (
                    <div className="display-flex flex-col gap-2">
                        <div className="text-sm font-color-primary font-medium uppercase display-flex flex-row items-center gap-2">
                            <div>Adding to Collections</div>
                        </div>

                        {/* Collections to add */}
                        <div className="display-flex flex-col gap-1 ml-1">
                            {collectionsToAdd.map((collKey, index) => (
                                <div
                                    key={`add-coll-${index}`}
                                    className="inline-flex items-center gap-1 text-sm font-color-primary"
                                >
                                    <span className="scale-75 display-flex">
                                        <CSSIcon name="collection" className="icon-16" />
                                    </span>
                                    <span>{collectionNames[collKey] || collKey}</span>
                                </div>
                            ))}
                        </div>
                    </div>
                )}

                {hasCollectionChanges && collectionsToRemove.length > 0 && (
                    <div className="display-flex flex-col gap-2">
                        <div className="text-sm font-color-primary font-medium uppercase display-flex flex-row items-center gap-2">
                            <div>Removing from Collections</div>
                        </div>

                        {/* Collections to remove */}
                        <div className="display-flex flex-col gap-1 ml-1">
                            {collectionsToRemove.map((collKey, index) => (
                                <div
                                    key={`remove-coll-${index}`}
                                    className="inline-flex items-center gap-1 text-sm font-color-primary"
                                >
                                    <span className="scale-75 display-flex">
                                        <CSSIcon name="collection" className="icon-16" />
                                    </span>
                                    <span>{collectionNames[collKey] || collKey}</span>
                                </div>
                            ))}
                        </div>
                    </div>
                )}

                {/* Error info for failed items */}
                {isApplied && resultData?.failed_items && Object.keys(resultData.failed_items).length > 0 && (
                    <div className="text-sm text-red-600 mt-1">
                        Failed: {Object.keys(resultData.failed_items).length} item{Object.keys(resultData.failed_items).length !== 1 ? 's' : ''}
                    </div>
                )}
            </div>
        </div>
    );
};

export default OrganizeItemsPreview;
