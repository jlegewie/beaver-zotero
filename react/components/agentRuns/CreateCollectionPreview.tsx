import React, { useEffect, useState } from 'react';
import { CSSIcon, Icon, PlusSignIcon } from '../icons/icons';

type ActionStatus = 'pending' | 'applied' | 'rejected' | 'undone' | 'error' | 'awaiting';

interface CreateCollectionPreviewProps {
    /** Name of the collection to create */
    name: string;
    /** Library name (from current_value) */
    libraryName?: string;
    /** Parent collection key (optional, for subcollections) */
    parentKey?: string | null;
    /** Number of items to add (from current_value or item_ids length) */
    itemCount?: number;
    /** Current status of the action */
    status?: ActionStatus;
    /** Result data (when status is 'applied') */
    resultData?: {
        collection_key?: string;
        collection_id?: number;
        items_added?: number;
    };
}

/**
 * Preview component for create_collection actions.
 * Shows details about the collection that will be created.
 */
export const CreateCollectionPreview: React.FC<CreateCollectionPreviewProps> = ({
    name,
    libraryName,
    parentKey,
    itemCount = 0,
    status = 'pending',
    resultData,
}) => {
    const [parentName, setParentName] = useState<string | null>(null);

    useEffect(() => {
        if (!parentKey || typeof Zotero === 'undefined') return;

        try {
            const libraries = Zotero.Libraries.getAll();
            let library = libraries.find(l => l.name === libraryName);
            
            // Fallback to user library if not found by name (or if name not provided)
            if (!library && (!libraryName || libraryName === 'My Library')) {
                library = Zotero.Libraries.userLibrary;
            }

            if (library) {
                const parent = Zotero.Collections.getByLibraryAndKey(library.libraryID, parentKey);
                if (parent) {
                    setParentName(parent.name);
                }
            }
        } catch (e) {
            console.warn('Failed to resolve parent collection name:', e);
        }
    }, [parentKey, libraryName]);

    const isApplied = status === 'applied';
    const isError = status === 'error';
    const isRejectedOrUndone = status === 'rejected' || status === 'undone';

    const getNewItemStyles = () => {
        if (isApplied) return 'bg-transparent';
        if (isRejectedOrUndone) return 'opacity-60';
        if (isError) return 'bg-red-50/10 border-red-200/20';
        // Pending state - highlight as new
        return 'bg-green-500/10 border border-green-500/20';
    };

    return (
        <div className={`create-collection-preview overflow-hidden ${isRejectedOrUndone ? 'opacity-60' : ''}`}>
            <div className="flex flex-col px-3 py-1 gap-2">
                
                <div className="flex flex-col gap-0.5">
                    <div className="text-sm font-color-primary font-medium py-1">
                        New Collection
                    </div>
                    {/* Parent Collection (if exists) */}
                    {parentKey && (
                        <div className="display-flex flex-row items-center gap-2 py-1 opacity-60">
                            <span className="scale-75 display-flex">
                                <CSSIcon name="collection" className="icon-16" />
                            </span>
                            <span className="text-sm font-color-primary truncate">
                                {parentName || 'Parent Collection'}
                            </span>
                        </div>
                    )}

                    {/* New Collection */}
                    <div className={`display-flex flex-row items-center gap-2 px-2 py-1.5 rounded ${parentKey ? 'ml-8' : ''} ${getNewItemStyles()}`}>
                        <span className="scale-75 display-flex">
                            <CSSIcon name="collection" className="icon-16" />
                        </span>
                        <span className="text-sm font-color-primary font-medium truncate flex-1">
                            {name}
                        </span>
                        {status === 'pending' && (
                            <span className="text-xs px-1.5 py-0.5 rounded bg-green-500/10 text-green-700 border border-green-500/20 whitespace-nowrap ml-2">
                                New
                            </span>
                        )}
                    </div>
                </div>


                {/* Footer Info */}
                {itemCount > 0 && (
                    <div className="display-flex flex-col gap-1 items-start mt-3 text-sm font-color-secondary">
                        <div className="display-flex flex-row items-center gap-05">
                            <Icon icon={PlusSignIcon} className="scale-90" />
                            <span>
                                {isApplied && resultData?.items_added !== undefined && (
                                    <span className="ml-1">
                                        Added {resultData.items_added} item{resultData.items_added !== 1 ? 's' : ''}
                                    </span>
                                )}
                                {!isApplied && itemCount && itemCount > 0 && (
                                    <span className="ml-1">
                                        Adding {itemCount} item{itemCount !== 1 ? 's' : ''}
                                    </span>
                                )}
                            </span>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
};

export default CreateCollectionPreview;
