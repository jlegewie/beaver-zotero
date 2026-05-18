import React, { useState } from 'react';
import { CollectionReference, collectionReferenceKey } from '../../types/zotero';
import { CSSIcon } from '../icons/icons';
import { selectCollection } from '../../../src/utils/selectItem';

interface ListCollectionsResultViewProps {
    collections: CollectionReference[];
    totalCount: number;
}

/**
 * Renders the result of a list_collections tool.
 * Shows collections with icons, clicking reveals in Zotero library.
 */
export const ListCollectionsResultView: React.FC<ListCollectionsResultViewProps> = ({
    collections,
    totalCount,
}) => {
    const [hoveredKey, setHoveredKey] = useState<string | null>(null);

    if (collections.length === 0) {
        return (
            <div className="p-3 text-sm font-color-tertiary">
                No collections found
            </div>
        );
    }

    // Each CollectionReference carries its own resolved library scope, so reveal
    // uses the per-collection library_id (not a single result-level library).
    const handleCollectionClick = (collection: CollectionReference) => {
        const found = Zotero.Collections.getByLibraryAndKey(collection.library_id, collection.zotero_key);
        if (found) {
            selectCollection(found);
        }
    };

    return (
        <div className="display-flex flex-col">
            {collections.map((collection) => {
                const compositeKey = collectionReferenceKey(collection);
                const isHovered = hoveredKey === compositeKey;

                return (
                    <div
                        key={compositeKey}
                        className={`display-flex flex-row gap-1 items-start min-w-0 px-15 py-15 last:border-0 transition-colors duration-150 cursor-pointer ${
                            isHovered ? 'bg-quinary' : ''
                        }`}
                        onClick={() => handleCollectionClick(collection)}
                        onMouseEnter={() => setHoveredKey(compositeKey)}
                        onMouseLeave={() => setHoveredKey(null)}
                        title="Click to reveal in Zotero"
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
