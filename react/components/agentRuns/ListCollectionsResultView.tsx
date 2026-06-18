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
                        className={`display-flex flex-row items-start gap-25 p-2 min-w-0 cursor-pointer transition-colors ${
                            isHovered ? 'bg-quinary' : ''
                        }`}
                        onClick={() => handleCollectionClick(collection)}
                        onMouseEnter={() => setHoveredKey(compositeKey)}
                        onMouseLeave={() => setHoveredKey(null)}
                        title="Click to reveal in Zotero"
                    >
                        <div className="display-flex items-center justify-center flex-shrink-0 rounded-md ml-05 mt-010">
                            <CSSIcon name="collection" className="icon-16 scale-90" />
                        </div>
                        <div className="display-flex flex-col flex-1 min-w-0 font-color-primary">
                            <div className="truncate font-color-primary" style={{ fontSize: '0.925rem' }}>
                                {collection.name}
                            </div>
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
