import React, { useState } from 'react';
import { CollectionInfo } from '../../agents/toolResultTypes';
import { CSSIcon } from '../icons/icons';
import { selectCollection } from '../../../src/utils/selectItem';

interface ListCollectionsResultViewProps {
    collections: CollectionInfo[];
    totalCount: number;
    libraryId?: number | null;
}

/**
 * Renders the result of a list_collections tool.
 * Shows collections with icons, clicking reveals in Zotero library.
 */
export const ListCollectionsResultView: React.FC<ListCollectionsResultViewProps> = ({
    collections,
    totalCount,
    libraryId
}) => {
    const [hoveredKey, setHoveredKey] = useState<string | null>(null);

    if (collections.length === 0) {
        return (
            <div className="p-3 text-sm font-color-tertiary">
                No collections found
            </div>
        );
    }

    const handleCollectionClick = (collectionKey: string) => {
        if (libraryId == null) return;
        
        const collection = Zotero.Collections.getByLibraryAndKey(libraryId, collectionKey);
        if (collection) {
            selectCollection(collection);
        }
    };

    return (
        <div className="display-flex flex-col">
            {collections.map((collection) => {
                const isHovered = hoveredKey === collection.collection_key;
                const isClickable = libraryId != null;
                
                return (
                    <div
                        key={collection.collection_key}
                        className={`display-flex flex-row gap-1 items-start min-w-0 px-15 py-15 last:border-0 transition-colors duration-150 ${
                            isClickable ? 'cursor-pointer' : ''
                        } ${isHovered ? 'bg-quinary' : ''}`}
                        onClick={() => handleCollectionClick(collection.collection_key)}
                        onMouseEnter={() => setHoveredKey(collection.collection_key)}
                        onMouseLeave={() => setHoveredKey(null)}
                        title={isClickable ? 'Click to reveal in Zotero' : undefined}
                    >
                        <span className="scale-75" style={{ marginTop: '-2px' }}>
                            <CSSIcon name="collection" className="icon-16" />
                        </span>
                        <div className="display-flex flex-col flex-1 min-w-0">
                            <span className="text-sm font-color-primary truncate">
                                {collection.name}
                            </span>
                        </div>
                    </div>
                );
            })}
            {totalCount > collections.length && (
                <div className="px-15 py-2 text-xs font-color-tertiary border-t border-primary">
                    Showing {collections.length} of {totalCount} collections
                </div>
            )}
        </div>
    );
};

export default ListCollectionsResultView;
