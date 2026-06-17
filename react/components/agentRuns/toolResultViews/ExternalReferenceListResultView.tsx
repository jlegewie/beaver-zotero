import React, { useState } from 'react';
import { ExternalReferenceListView } from '../../../types/toolResultViews';
import ExternalReferenceListItem from '../../externalReferences/ExternalReferenceListItem';

/**
 * Shared renderer for the {@link ExternalReferenceListView} view model
 * (external_search / search_external_references / lookup_work).
 *
 * The lookup_work-only extras
 * (`not_found_queries`, `unavailable_queries`, `message`) render below the
 * matched references.
 */
export const ExternalReferenceListResultView: React.FC<{ view: ExternalReferenceListView }> = ({
    view,
}) => {
    const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);

    const references = view.references;
    const notFoundQueries = view.not_found_queries ?? [];
    const unavailableQueries = view.unavailable_queries ?? [];
    const isLookupWork = view.tool_name === 'lookup_work';

    if (references.length === 0 && notFoundQueries.length === 0 && unavailableQueries.length === 0) {
        const emptyText = view.message || (isLookupWork ? 'No works found' : 'No external references found');
        return (
            <div className="p-3 text-sm font-color-tertiary">
                {emptyText}
            </div>
        );
    }

    return (
        <div className="display-flex flex-col">
            {references.map((item, index) => (
                <ExternalReferenceListItem
                    key={item.source_id ?? `ref-${index}`}
                    item={item}
                    isHovered={hoveredIndex === index}
                    onMouseEnter={() => setHoveredIndex(index)}
                    onMouseLeave={() => setHoveredIndex(null)}
                />
            ))}

            {notFoundQueries.map((query, index) => (
                <div
                    key={`not-found-${index}`}
                    className="px-3 py-2 text-sm font-color-tertiary border-t border-color-quinary"
                >
                    <span className="font-color-secondary">{query}</span>
                    <span> — not found</span>
                </div>
            ))}

            {unavailableQueries.map((query, index) => (
                <div
                    key={`unchecked-${index}`}
                    className="px-3 py-2 text-sm font-color-tertiary border-t border-color-quinary"
                >
                    <span className="font-color-secondary">{query}</span>
                    <span> — lookup unavailable</span>
                </div>
            ))}
        </div>
    );
};

export default ExternalReferenceListResultView;
