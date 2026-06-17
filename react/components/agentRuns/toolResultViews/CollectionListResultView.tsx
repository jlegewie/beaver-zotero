import React, { useState } from 'react';
import { CollectionListView } from '../../../types/toolResultViews';
import { CSSIcon } from '../../icons/icons';
import { getHost } from '../../../host';

/**
 * Shared renderer for the {@link CollectionListView} view model (list_collections).
 *
 * Collection clicks reveal the collection through the navigation host.
 */
export const CollectionListResultView: React.FC<{ view: CollectionListView }> = ({ view }) => {
    const [hoveredKey, setHoveredKey] = useState<string | null>(null);

    const collections = view.collections;
    if (collections.length === 0) {
        return (
            <div className="p-3 text-sm font-color-tertiary">
                No collections found
            </div>
        );
    }

    const revealCollection = (libraryId: number, collectionKey: string) => {
        getHost().navigation?.revealCollection({ library_id: libraryId, zotero_key: collectionKey });
    };

    return (
        <div className="display-flex flex-col">
            {collections.map((collection) => {
                const compositeKey = `${collection.library_id}-${collection.collection_key}`;
                const isHovered = hoveredKey === compositeKey;

                return (
                    <div
                        key={compositeKey}
                        className={`display-flex flex-row gap-1 items-start min-w-0 px-15 py-15 last:border-0 transition-colors duration-150 cursor-pointer ${
                            isHovered ? 'bg-quinary' : ''
                        }`}
                        onClick={() => revealCollection(collection.library_id, collection.collection_key)}
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
            {view.total_count > collections.length && (
                <div className="px-15 py-2 text-xs font-color-tertiary border-t border-primary">
                    Showing {collections.length} of {view.total_count} collections
                </div>
            )}
        </div>
    );
};

export default CollectionListResultView;
