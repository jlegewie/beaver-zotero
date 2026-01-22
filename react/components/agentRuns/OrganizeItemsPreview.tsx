import React, { useEffect, useState } from 'react';
import { CSSIcon, Icon, TagIcon, PlusSignIcon, CancelIcon } from '../icons/icons';
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
            <div className="flex flex-col px-3 py-1 gap-3">
                
                {/* Item count summary */}
                <div className="text-sm font-color-secondary">
                    {isApplied && resultData?.items_modified !== undefined ? (
                        <span>Modified {resultData.items_modified} item{resultData.items_modified !== 1 ? 's' : ''}</span>
                    ) : (
                        <span>Organizing {itemCount} item{itemCount !== 1 ? 's' : ''}</span>
                    )}
                </div>

                {/* Tag changes */}
                {hasTagChanges && (
                    <div className="flex flex-col gap-1.5">
                        <div className="text-sm font-color-primary font-medium flex items-center gap-1.5">
                            <Icon icon={TagIcon} className="scale-90" />
                            <span>Tags</span>
                        </div>
                        
                        {/* Tags to add */}
                        {tagsToAdd.length > 0 && (
                            <div className="flex flex-row flex-wrap gap-1 ml-5">
                                {tagsToAdd.map((tag, index) => (
                                    <span
                                        key={`add-${index}`}
                                        className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded bg-green-500/10 text-green-700 border border-green-500/20"
                                    >
                                        <Icon icon={PlusSignIcon} className="scale-75" />
                                        {tag}
                                    </span>
                                ))}
                            </div>
                        )}

                        {/* Tags to remove */}
                        {tagsToRemove.length > 0 && (
                            <div className="flex flex-row flex-wrap gap-1 ml-5">
                                {tagsToRemove.map((tag, index) => (
                                    <span
                                        key={`remove-${index}`}
                                        className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded bg-red-500/10 text-red-700 border border-red-500/20"
                                    >
                                        <Icon icon={CancelIcon} className="scale-75" />
                                        {tag}
                                    </span>
                                ))}
                            </div>
                        )}
                    </div>
                )}

                {/* Collection changes */}
                {hasCollectionChanges && (
                    <div className="flex flex-col gap-1.5">
                        <div className="text-sm font-color-primary font-medium flex items-center gap-1.5">
                            <span className="scale-75 display-flex">
                                <CSSIcon name="collection" className="icon-16" />
                            </span>
                            <span>Collections</span>
                        </div>

                        {/* Collections to add */}
                        {collectionsToAdd.length > 0 && (
                            <div className="flex flex-col gap-0.5 ml-5">
                                {collectionsToAdd.map((collKey, index) => (
                                    <div
                                        key={`add-coll-${index}`}
                                        className="inline-flex items-center gap-1.5 text-sm font-color-primary"
                                    >
                                        <span className="text-green-600">
                                            <Icon icon={PlusSignIcon} className="scale-75" />
                                        </span>
                                        <span className="scale-75 display-flex">
                                            <CSSIcon name="collection" className="icon-16" />
                                        </span>
                                        <span>{collectionNames[collKey] || collKey}</span>
                                    </div>
                                ))}
                            </div>
                        )}

                        {/* Collections to remove */}
                        {collectionsToRemove.length > 0 && (
                            <div className="flex flex-col gap-0.5 ml-5">
                                {collectionsToRemove.map((collKey, index) => (
                                    <div
                                        key={`remove-coll-${index}`}
                                        className="inline-flex items-center gap-1.5 text-sm font-color-primary"
                                    >
                                        <span className="text-red-600">
                                            <Icon icon={CancelIcon} className="scale-75" />
                                        </span>
                                        <span className="scale-75 display-flex">
                                            <CSSIcon name="collection" className="icon-16" />
                                        </span>
                                        <span>{collectionNames[collKey] || collKey}</span>
                                    </div>
                                ))}
                            </div>
                        )}
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
