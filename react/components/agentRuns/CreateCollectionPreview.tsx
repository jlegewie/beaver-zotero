import React from 'react';
import { Icon, LibraryIcon, FolderDetailIcon, BookmarkIcon } from '../icons/icons';

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
    const isApplied = status === 'applied';
    const isRejectedOrUndone = status === 'rejected' || status === 'undone';
    const isError = status === 'error';

    const getStatusStyles = () => {
        if (isApplied) return 'diff-addition-applied';
        if (isRejectedOrUndone) return 'diff-ghosted';
        if (isError) return 'diff-error';
        return 'diff-addition';
    };

    return (
        <div className="create-collection-preview">
            <div className="flex flex-col gap-3 px-3 py-2">
                {/* Collection name */}
                <div className="flex flex-col gap-1">
                    <div className="text-sm font-color-primary font-medium">
                        Collection Name
                    </div>
                    <div className={`diff-container`}>
                        <div className={`diff-line ${getStatusStyles()}`}>
                            <span className="diff-content display-flex items-center gap-2">
                                <Icon icon={LibraryIcon} className="scale-09" />
                                {name}
                            </span>
                        </div>
                    </div>
                </div>

                {/* Library */}
                {libraryName && (
                    <div className="flex flex-col gap-1">
                        <div className="text-sm font-color-secondary">
                            Library
                        </div>
                        <div className="text-sm font-color-primary px-2">
                            {libraryName}
                        </div>
                    </div>
                )}

                {/* Parent collection (if subcollection) */}
                {parentKey && (
                    <div className="flex flex-col gap-1">
                        <div className="text-sm font-color-secondary">
                            Parent Collection
                        </div>
                        <div className="text-sm font-color-primary px-2 display-flex items-center gap-2">
                            <Icon icon={FolderDetailIcon} className="scale-09" />
                            {parentKey}
                        </div>
                    </div>
                )}

                {/* Items to add */}
                {itemCount > 0 && (
                    <div className="flex flex-col gap-1">
                        <div className="text-sm font-color-secondary">
                            Items to Add
                        </div>
                        <div className="text-sm font-color-primary px-2 display-flex items-center gap-2">
                            <Icon icon={BookmarkIcon} className="scale-09" />
                            {itemCount} item{itemCount !== 1 ? 's' : ''}
                            {isApplied && resultData?.items_added !== undefined && (
                                <span className="font-color-secondary">
                                    ({resultData.items_added} added)
                                </span>
                            )}
                        </div>
                    </div>
                )}

                {/* Applied result info */}
                {isApplied && resultData?.collection_key && (
                    <div className="flex flex-col gap-1 mt-1">
                        <div className="text-sm font-color-secondary">
                            Collection Key
                        </div>
                        <div className="text-sm font-color-primary px-2 font-mono">
                            {resultData.collection_key}
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
};

export default CreateCollectionPreview;
