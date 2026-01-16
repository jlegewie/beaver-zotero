import React from 'react';
import { CollectionInfo } from '../../agents/toolResultTypes';

interface ListCollectionsResultViewProps {
    collections: CollectionInfo[];
    totalCount: number;
    libraryName?: string | null;
}

/**
 * Renders the result of a list_collections tool.
 * Shows collections with item counts and subcollection counts.
 */
export const ListCollectionsResultView: React.FC<ListCollectionsResultViewProps> = ({
    collections,
    totalCount,
    libraryName
}) => {
    if (collections.length === 0) {
        return (
            <div className="p-3 text-sm font-color-tertiary">
                No collections found
            </div>
        );
    }

    return (
        <div className="display-flex flex-col">
            {libraryName && (
                <div className="px-15 py-1 text-xs font-color-tertiary border-b border-primary">
                    {libraryName}
                </div>
            )}
            {collections.map((collection, index) => (
                <div
                    key={collection.collection_key}
                    className={`display-flex flex-row gap-2 items-center px-15 py-15 ${
                        index < collections.length - 1 ? 'border-b border-primary' : ''
                    }`}
                >
                    <span className="text-sm" style={{ marginRight: '4px' }}>📁</span>
                    <div className="display-flex flex-col flex-1 min-w-0">
                        <div className="display-flex flex-row gap-2 items-center">
                            <span className="text-sm font-color-primary truncate">
                                {collection.name}
                            </span>
                            <span className="text-xs font-color-tertiary whitespace-nowrap">
                                {collection.item_count} item{collection.item_count !== 1 ? 's' : ''}
                                {collection.subcollection_count > 0 && (
                                    <>, {collection.subcollection_count} subcollection{collection.subcollection_count !== 1 ? 's' : ''}</>
                                )}
                            </span>
                        </div>
                        {collection.parent_name && (
                            <span className="text-xs font-color-tertiary truncate">
                                in {collection.parent_name}
                            </span>
                        )}
                    </div>
                </div>
            ))}
            {totalCount > collections.length && (
                <div className="px-15 py-2 text-xs font-color-tertiary border-t border-primary">
                    Showing {collections.length} of {totalCount} collections
                </div>
            )}
        </div>
    );
};

export default ListCollectionsResultView;
