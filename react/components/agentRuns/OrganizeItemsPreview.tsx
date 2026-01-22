import React, { useEffect, useState } from 'react';
import { CSSIcon, Icon, TagIcon } from '../icons/icons';
import type { TagChanges, CollectionChanges, OrganizeItemsResultData } from '../../types/agentActions/base';

type ActionStatus = 'pending' | 'applied' | 'rejected' | 'undone' | 'error' | 'awaiting';

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
                
                {/* Item count summary */}
                <div className="text-sm font-color-secondary">
                    {isApplied && resultData?.items_modified !== undefined ? (
                        <span>Modified {resultData.items_modified} item{resultData.items_modified !== 1 ? 's' : ''}</span>
                    ) : (
                        <span>Organizing {itemCount} item{itemCount !== 1 ? 's' : ''}</span>
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
